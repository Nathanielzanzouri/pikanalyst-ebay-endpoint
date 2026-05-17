'use strict';

// Prompt sent to Gemini 3 Flash. Requires grounded web search for live prices
// (eBay sold avg / TCGPlayer / PriceCharting) and a strict-JSON response so we
// can parse it into the existing CARD_RESULT shape.
function buildGeminiPrompt() {
  return [
    'You are analyzing an image of a trading card game (TCG) card. The card is from one of:',
    'Pokemon, OnePiece, YuGiOh, MTG, or another TCG.',
    '',
    'STEP 1 — Identify the card from the image. READ THE CARD ITSELF.',
    '',
    'CRITICAL — variant disambiguation (read this carefully):',
    'Modern Pokemon cards (especially Sword & Shield / Scarlet & Violet, and',
    'Japanese SM / SV sets) have MANY VARIANTS of the same Pokemon at very',
    'different prices. Examples:',
    '  - "Blastoise ex" SV2a 151:  009/165 (Double Rare, ~€2) vs 202/165 (Special',
    '    Art Rare, ~€30+). Same Pokemon, same set — wildly different price.',
    '  - "Gardevoir & Sylveon GX": 031/055 (RR) vs 061/055 (SR Special Art) vs',
    '    224/173 vs 260/173 (HR Rainbow). All the same Pokemon, vastly different',
    '    prices.',
    'Picking the wrong variant produces a wrong price by 5x–50x.',
    '',
    'To avoid this, READ what is actually printed on the card:',
    '  1) The card NUMBER is printed at the bottom (usually bottom-left or',
    '     bottom-right corner), in the format "031/055", "202/165", etc.',
    '     The number IS the variant identifier — use exactly what you read,',
    '     do not pick a popular default for that Pokemon.',
    '  2) The RARITY symbol/badge sits next to the card number',
    '     (•, ◆, ★, RR, SR, SAR, HR, UR).',
    '  3) Alt-art / Special-Art-Rare variants visually EXTEND BEYOND the',
    '     standard card border — the illustration covers the whole card with',
    '     no text/stat box around it.',
    '  4) If your name-based intuition contradicts what is printed on the card,',
    '     TRUST WHAT IS PRINTED. Quote the exact number you read.',
    '',
    'DECISION TREE WHEN THE PRINTED CARD NUMBER IS NOT READABLE',
    '(scan cropped the bottom of the card, glare, blur, hand obscuring it, etc.):',
    '  - Can you see a text/moves/HP box at the bottom half of the card?',
    '      YES (the artwork is FRAMED inside a card border) → pick the BASE',
    '          variant number (e.g. 031/055, NOT 061/055; 009/165, NOT 202/165).',
    '          This is the standard R / RR / Holo rarity.',
    '      NO  (the artwork BLEEDS to all card edges, no text box visible)',
    '          → pick the alt-variant number (SR / SAR / HR / Rainbow).',
    '  - NEVER default to the higher-rarity (more expensive) variant just',
    '    because you recognize the Pokemon. When in doubt, default to the BASE',
    '    variant and lower price_confidence to "low".',
    '',
    'Return these fields based on what you read from the image:',
    '- game (Pokemon | OnePiece | YuGiOh | MTG | Other)',
    '- card_name',
    '- set_name',
    '- card_number — exactly as printed on the card (format "031/055", "202/165")',
    '- language (EN, FR, JP, etc.) — read the language of the printed text',
    '- rarity — what is actually shown on the card (RR, SR, SAR, HR, etc.)',
    '',
    'IDENTIFICATION POLICY: If you can read the card at all (even partially),',
    'identify it as best you can and lower the price confidence to "low".',
    'Only return {"error":"unidentified"} when the image is genuinely unreadable',
    '(too blurry, no card visible, image is something other than a TCG card).',
    '',
    'STEP 2 — Look up current market prices using grounded web search.',
    'Use live search results, NOT prices from your training data.',
    '',
    'PRICING POLICY — important: do not be over-conservative. For card-game',
    'auctions a best-effort estimate is more useful to the user than null.',
    '  - If exact-match listings exist, use their average. confidence = "high".',
    '  - If only close variants exist (different language / similar set / similar',
    '    rarity), pick the most relevant comparable, note it in `notes`, and',
    '    report the estimate with confidence = "medium".',
    '  - If you have only loosely-related data, give your best educated estimate',
    '    based on the comparable Pokemon-card market and confidence = "low".',
    '  - Only return null when you genuinely have NOTHING to base an estimate on.',
    'Always include a per-price confidence in `price_confidence`.',
    '',
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
    '  "price_confidence": {',
    '    "ebay":          "high" | "medium" | "low" | null,',
    '    "tcgplayer":     "high" | "medium" | "low" | null,',
    '    "pricecharting": "high" | "medium" | "low" | null',
    '  },',
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
    price_confidence: p.price_confidence || null,
    listings:          [],
    ebay_sales_count:  isError ? null : 0,
    _engine:           'gemini',
    _geminiError:      p.error ?? null,
    _geminiNotes:      p.notes ?? null,
  };
}

module.exports = { buildGeminiPrompt, buildGeminiRequest, parseGeminiResponse, mapToCardResult };
