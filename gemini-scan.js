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
    '- PriceCharting.com loose / ungraded price',
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
function mapToCardResult(parsed) {
  const p = parsed || {};
  const ebay = p.ebay_sold_avg_eur ?? null;
  return {
    card_name:        p.card_name ?? null,
    set_name:         p.set_name ?? null,
    card_number:      p.card_number ?? null,
    language:         p.language ?? null,
    card_game:        p.game ?? null,
    rarity:           p.rarity ?? null,
    market_price:     ebay,                              // drives DEAL/FAIR/OVER verdict
    market_price_usd: ebay,                              // alias the renderer also reads
    tcg_player_price: p.tcgplayer_price_eur ?? null,
    cardmarket_price: p.pricecharting_price_eur ?? null, // slot relabeled in the renderer
    listings:         [],
    ebay_sales_count: 0,
    _engine:          'gemini',
    _geminiError:     p.error ?? null,
    _geminiNotes:     p.notes ?? null,
  };
}

module.exports = { buildGeminiPrompt, buildGeminiRequest, parseGeminiResponse, mapToCardResult };
