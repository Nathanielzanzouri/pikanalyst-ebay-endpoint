'use strict';

// Prompt sent to Gemini 3 Flash. Requires grounded web search for live prices
// (eBay sold avg / TCGPlayer / PriceCharting) and a strict-JSON response so we
// can parse it into the existing CARD_RESULT shape.
function buildGeminiPrompt() {
  return [
    'You are analyzing an image of a trading card game (TCG) card. The card is from one of:',
    'Pokemon, OnePiece, YuGiOh, MTG, or another TCG.',
    '',
    'STEP 1 — Identify the card from the image:',
    '- game (Pokemon | OnePiece | YuGiOh | MTG | Other)',
    '- card_name',
    '- set_name',
    '- card_number (e.g. "025/165")',
    '- language (EN, FR, JP, etc.)',
    '- rarity if visible',
    '',
    'STEP 2 — Look up current market prices using grounded web search.',
    'Do not guess prices from training data — use live search.',
    '- eBay sold price average over the last 90 days, single-card listings only, non-graded, no lots',
    '- TCGPlayer market price if listed',
    '- PriceCharting.com prices PER GRADE for this exact card. Visit the card\'s',
    '  PriceCharting page and read its grade ladder. Capture: ungraded (loose),',
    '  Grade 7, Grade 8, Grade 9, Grade 9.5, and PSA 10. Use null for any grade',
    '  with no data on the page. Also report pricecharting_price_eur as the',
    '  ungraded price (headline / single-number summary).',
    '',
    'All prices in EUR (convert with current FX from USD/other if needed).',
    '',
    'If you cannot identify the card with high confidence, return:',
    '  {"error": "unidentified"}',
    '',
    'Otherwise return STRICT JSON exactly matching:',
    '{',
    '  "game": "Pokemon",',
    '  "card_name": "...",',
    '  "set_name": "...",',
    '  "card_number": "...",',
    '  "language": "EN",',
    '  "rarity": "...",',
    '  "ebay_sold_avg_eur": number_or_null,',
    '  "tcgplayer_price_eur": number_or_null,',
    '  "pricecharting_price_eur": number_or_null,',
    '  "pricecharting_grades_eur": {',
    '    "ungraded":   number_or_null,',
    '    "psa_7":      number_or_null,',
    '    "psa_8":      number_or_null,',
    '    "psa_9":      number_or_null,',
    '    "psa_9_5":    number_or_null,',
    '    "psa_10":     number_or_null',
    '  },',
    '  "pricecharting_history_eur": [',
    '    /* Last ~12 monthly ungraded price points if available on the page,',
    '       ordered oldest -> newest. Use null array if not available. */',
    '    { "month": "YYYY-MM", "price": number }',
    '  ],',
    '  "source_urls": {',
    '    /* The EXACT URLs you actually visited during grounded search to get',
    '       each price, so the user can click through and verify. Use the direct',
    '       product page when possible (e.g. https://www.pricecharting.com/game/...',
    '       or a specific eBay sold-listings search URL), not a generic search.',
    '       Use null for any source you could not find. */',
    '    "ebay":          "https://...   or null",',
    '    "tcgplayer":     "https://...   or null",',
    '    "pricecharting": "https://...   or null"',
    '  },',
    '  "notes": "anything noteworthy, including sample size or source URLs"',
    '}',
    '',
    'No prose outside the JSON.',
  ].join('\n');
}

// Build the generateContent request body for Gemini 3 Flash with the image
// inlined as base64 and Google Search grounding enabled.
function buildGeminiRequest(imageBase64, mimeType) {
  if (!imageBase64) throw new TypeError('buildGeminiRequest: imageBase64 is required');
  return {
    contents: [{
      role: 'user',
      parts: [
        { text: buildGeminiPrompt() },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
      ],
    }],
    tools: [{ google_search: {} }],
  };
}

// Parse Gemini's text reply into a JS object. Tolerates markdown code fences
// and prose surrounding the JSON (some grounded-search responses wrap the
// JSON in explanatory text). Returns { error: 'parse_failed' } on failure.
function parseGeminiResponse(rawText) {
  if (!rawText) return { error: 'parse_failed' };
  const cleaned = String(rawText).trim()
    .replace(/^```(?:json)?\s*/i, '')   // strip opening ```json or ```
    .replace(/\s*```$/, '')             // strip closing ```
    .trim();
  // Try direct parse first
  try { return JSON.parse(cleaned); } catch (_) { /* fall through */ }
  // Fall back: extract from the first '{' to the last '}'. Known limitation:
  // a bare '}' in trailing prose after the JSON block will mis-bound the slice
  // and the parse will fail (the function then returns parse_failed, never a
  // wrong object) — acceptable for our use case.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) { /* fall through */ }
  }
  return { error: 'parse_failed' };
}

// Map Gemini's parsed JSON into the shape the existing CARD_RESULT renderer
// expects. PriceCharting is placed in the cardmarket_price slot; the renderer
// relabels that slot to "PriceCharting" when _engine === 'gemini'.
//
// `market_price_usd` keeps its legacy name from the original Pokemon pipeline
// where the renderer reads it as the canonical market price; we populate it
// with the EUR value from Gemini so the existing UI keeps working. Renaming
// it would require touching every consumer — out of scope here.
// Click-through URLs for verification. We PREFER the exact URLs Gemini
// actually visited during grounded search (more accurate — direct product
// pages with the real prices). Fall back to constructed search URLs only
// when Gemini didn't provide one for a given source.
function buildSearchUrls(p) {
  const name = String(p.card_name || '').trim();
  const supplied = p.source_urls || {};
  const safe = (u) => {
    if (!u || typeof u !== 'string') return null;
    if (!/^https?:\/\//i.test(u)) return null; // reject relative / invalid
    return u;
  };
  // Fallback search queries when Gemini didn't supply a direct URL.
  // Keep the fallback intentionally simple — just card_name + number,
  // dropping set fragments that often duplicate the number (e.g. "208/SM-P"
  // combined with "SM-P Promotional cards") and confuse search engines.
  const q = encodeURIComponent([name, p.card_number].filter(Boolean).join(' ').trim());
  return {
    ebay_url:           safe(supplied.ebay)          || (name ? `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=183454&LH_Sold=1&LH_Complete=1` : null),
    tcg_url:            safe(supplied.tcgplayer)     || (name ? `https://www.tcgplayer.com/search/all/product?q=${q}` : null),
    pricecharting_url:  safe(supplied.pricecharting) || (name ? `https://www.pricecharting.com/search-products?q=${q}&type=prices` : null),
  };
}

function mapToCardResult(parsed) {
  const p = parsed || {};
  const isError = !!p.error;
  const ebayEur = p.ebay_sold_avg_eur ?? null;
  const tcgEur  = p.tcgplayer_price_eur ?? null;
  const pcEur   = p.pricecharting_price_eur ?? null;
  const urls = buildSearchUrls(p);
  return {
    card_name:         p.card_name ?? null,
    set_name:          p.set_name ?? null,
    card_number:       p.card_number ?? null,
    language:          p.language ?? null,
    card_game:         p.game ?? null,
    rarity:            p.rarity ?? null,
    // eBay sold — populate the canonical name AND `ebay_market_price`, which
    // is what the existing sidepanel.js renderer actually reads.
    market_price:      ebayEur,
    market_price_usd:  ebayEur,
    ebay_market_price: ebayEur,
    ebay_url:          urls.ebay_url,
    // TCGPlayer — same duality. Renderer reads `tcg_market_price` + `tcg_url`.
    tcg_player_price:  tcgEur,
    tcg_market_price:  tcgEur,
    tcg_url:           urls.tcg_url,
    // PriceCharting — placed in the Cardmarket slot; renderer relabels it and
    // unhides the slot when _engine === 'gemini'.
    cardmarket_price:  pcEur,
    pricecharting_price: pcEur,
    pricecharting_url:   urls.pricecharting_url,
    pricecharting_grades_eur: p.pricecharting_grades_eur || null,
    pricecharting_history_eur: Array.isArray(p.pricecharting_history_eur) ? p.pricecharting_history_eur : null,
    listings:          [],
    ebay_sales_count:  isError ? null : 0,
    _engine:           'gemini',
    _geminiError:      p.error ?? null,
    _geminiNotes:      p.notes ?? null,
  };
}

module.exports = { buildGeminiPrompt, buildGeminiRequest, parseGeminiResponse, mapToCardResult };
