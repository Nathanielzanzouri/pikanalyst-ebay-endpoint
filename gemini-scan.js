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

// ───────────────────────────────────────────────────────────────────────────
// Streaming pipeline (sub-6s perceived response).
// We split the omnibus call into 4 focused calls so each finishes faster and
// the extension can stream results to the side panel as each completes.
//   1. Identity call    — vision only, no grounded search (~2-3s)
//   2. eBay price       — single-source grounded search (~3-6s)
//   3. TCGPlayer price  — single-source grounded search (~3-5s)
//   4. PriceCharting    — single-source grounded search incl. grades (~4-7s)
// ───────────────────────────────────────────────────────────────────────────

// Identity-only prompt — no grounded search needed, just visual reading.
// Returns ONLY the card identity fields so this call completes in ~2-3s
// and the user sees the card name appear in the panel almost instantly.
function buildIdentityPrompt() {
  return [
    'You are analyzing an image of a trading card game (TCG) card.',
    'Pokemon, OnePiece, YuGiOh, MTG, or another TCG.',
    '',
    'IDENTIFY the card by READING what is printed on the card. Do not search the web.',
    '',
    'CRITICAL — variant disambiguation:',
    'Modern Pokemon cards have MANY VARIANTS of the same name with different prices.',
    'Examples: "Blastoise ex" 009/165 (Double Rare) vs 202/165 (Special Art Rare).',
    'Examples: "Gardevoir & Sylveon GX" 031/055 vs 061/055 vs 260/173.',
    '',
    'READ THE CARD NUMBER printed at the bottom (format "031/055", "202/165").',
    'The card number IS the variant identifier — use exactly what you read.',
    '',
    'If the card number is not visible:',
    '  - If you see a text/moves/HP box at the bottom → standard framed variant',
    '    (pick the BASE-numbered variant, e.g. 031/055 not 061/055).',
    '  - If the artwork bleeds to all edges with no text box → alt-art variant',
    '    (SR / SAR / HR / Rainbow).',
    '  - NEVER default to the higher-rarity (more expensive) variant.',
    '',
    'Return STRICT JSON, no markdown, no prose:',
    '{',
    '  "game": "Pokemon" | "OnePiece" | "YuGiOh" | "MTG" | "Other",',
    '  "card_name": "...",',
    '  "set_name": "...",',
    '  "card_number": "...",',
    '  "language": "EN" | "FR" | "JP" | etc.,',
    '  "rarity": "..."',
    '}',
    '',
    'If the image is unreadable, return {"error":"unidentified"}.',
  ].join('\n');
}

function buildIdentityRequest(imageBase64, mimeType) {
  if (!imageBase64) throw new TypeError('buildIdentityRequest: imageBase64 is required');
  return {
    contents: [{
      role: 'user',
      parts: [
        { text: buildIdentityPrompt() },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
      ],
    }],
    // No tools — visual ID only, no web search. Much faster.
  };
}

// Per-source price prompts. Each takes the confident identity as text and runs
// ONE focused grounded search. Smaller scope = faster completion.
function _identityLine(identity) {
  const i = identity || {};
  return [i.card_name, i.set_name && '(' + i.set_name + ')', i.card_number, i.language && '[' + i.language + ']', i.rarity].filter(Boolean).join(' ');
}

function buildEbayPricePrompt(identity) {
  return [
    'You are looking up the eBay sold-listings average price for this exact card:',
    '  ' + _identityLine(identity),
    '',
    'Use grounded web search. Look at eBay completed/sold listings over the last 90',
    'days, single-card listings only, non-graded, no lots. Compute an average.',
    '',
    'If you can only find loosely-comparable sales, return a best-effort estimate',
    'with confidence "low". Only return null if no comparable sales found.',
    '',
    'Return STRICT JSON, no markdown:',
    '{',
    '  "ebay_sold_avg_eur": number_or_null,',
    '  "ebay_url":          "https://... or null (direct sold-listings search URL you used)",',
    '  "confidence":        "high" | "medium" | "low" | null,',
    '  "notes":             "anything noteworthy in 1 line"',
    '}',
  ].join('\n');
}

function buildTcgplayerPricePrompt(identity) {
  return [
    'You are looking up the TCGPlayer market price for this exact card:',
    '  ' + _identityLine(identity),
    '',
    'Use grounded web search on tcgplayer.com. Find the product page for this',
    'exact variant (card number matters — see prompt above). Return the market',
    'price in EUR.',
    '',
    'For Japanese-language cards, TCGPlayer often does not list a price — return',
    'null with confidence null. Do not guess.',
    '',
    'Return STRICT JSON, no markdown:',
    '{',
    '  "tcgplayer_price_eur": number_or_null,',
    '  "tcg_url":             "https://... or null (direct product page URL)",',
    '  "confidence":          "high" | "medium" | "low" | null',
    '}',
  ].join('\n');
}

function buildPriceChartingPrompt(identity) {
  return [
    'You are looking up the PriceCharting prices for this exact card:',
    '  ' + _identityLine(identity),
    '',
    'Use grounded web search on pricecharting.com. Find the card\'s product page.',
    'Read the grade ladder (ungraded, PSA 7-10). All prices in EUR.',
    '',
    'Return STRICT JSON, no markdown:',
    '{',
    '  "pricecharting_price_eur":   number_or_null,        /* ungraded headline */',
    '  "pricecharting_url":         "https://... or null", /* direct product page */',
    '  "pricecharting_grades_eur": {',
    '    "ungraded":   number_or_null,',
    '    "psa_7":      number_or_null,',
    '    "psa_8":      number_or_null,',
    '    "psa_9":      number_or_null,',
    '    "psa_9_5":    number_or_null,',
    '    "psa_10":     number_or_null',
    '  },',
    '  "confidence": "high" | "medium" | "low" | null',
    '}',
  ].join('\n');
}

function buildTextOnlyRequest(prompt, withGrounding) {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(withGrounding ? { tools: [{ google_search: {} }] } : {}),
  };
}

// Map a per-source price response into the field names the existing CARD_RESULT
// renderer expects, so partial price events flow straight into the side panel.
function mapEbayPriceToCardResult(p) {
  const v = p && typeof p.ebay_sold_avg_eur === 'number' ? p.ebay_sold_avg_eur : null;
  return { ebay_market_price: v, market_price: v, market_price_usd: v, ebay_url: (p && p.ebay_url) || null };
}
function mapTcgplayerPriceToCardResult(p) {
  const v = p && typeof p.tcgplayer_price_eur === 'number' ? p.tcgplayer_price_eur : null;
  return { tcg_market_price: v, tcg_player_price: v, tcg_url: (p && p.tcg_url) || null };
}
function mapPriceChartingToCardResult(p) {
  const v = p && typeof p.pricecharting_price_eur === 'number' ? p.pricecharting_price_eur : null;
  return {
    cardmarket_price: v,
    pricecharting_price: v,
    pricecharting_url: (p && p.pricecharting_url) || null,
    pricecharting_grades_eur: (p && p.pricecharting_grades_eur) || null,
  };
}
function mapIdentityToCardResult(p) {
  const i = p || {};
  return {
    card_name:   i.card_name ?? null,
    set_name:    i.set_name ?? null,
    card_number: i.card_number ?? null,
    language:    i.language ?? null,
    card_game:   i.game ?? null,
    rarity:      i.rarity ?? null,
    _engine:     'gemini',
    _geminiError: i.error ?? null,
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

module.exports = {
  buildGeminiPrompt, buildGeminiRequest, parseGeminiResponse, mapToCardResult,
  // Streaming pipeline:
  buildIdentityPrompt, buildIdentityRequest,
  buildEbayPricePrompt, buildTcgplayerPricePrompt, buildPriceChartingPrompt,
  buildTextOnlyRequest,
  mapIdentityToCardResult, mapEbayPriceToCardResult, mapTcgplayerPriceToCardResult, mapPriceChartingToCardResult,
};
