'use strict';
// Generic AI-driven product identity extractor.
//
// Replaces the per-category regex/vote logic (sneaker-id.js) with a single
// Gemini Flash Lite text-only call that reads a Lens visualMatches array and
// returns a structured identity + clean Google Shopping query.
//
// Why: hand-written regex + voting heuristics will always be a step behind
// reality and only work per-category. An LLM that reads 15 titles can:
//   • understand any product category (sneakers, bags, toys, watches, etc.)
//   • strip multilingual noise (FR "Baskets basses", DE "Schuhe", JP terms)
//   • recognize retailer-chrome suffixes ("- JD Sports France", "- ZALANDO.FR")
//   • pull out the SKU when present, fall back to brand+model+variant when not
//
// Cost ≈ €0.0001/scan (Flash Lite, text-only, ~15 titles in, small JSON out).
// Latency ≈ 300-500ms. Safe to fall back to legacy logic on any failure —
// caller passes our result straight through to Google Shopping; nothing else
// downstream depends on the shape.

const MODEL = process.env.GEMINI_PRODUCT_ID_MODEL || 'gemini-flash-lite-latest';
const FETCH_TIMEOUT_MS = 6000;
const TOP_N_TITLES = 15;            // matches what extractStyleCode uses

// In-memory cache keyed by hash of the top-N titles — same scan analyzed
// twice (or two near-identical scans in a row) reuses the AI call.
const CACHE = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;  // 30 minutes
const CACHE_MAX = 500;                // simple FIFO eviction

function hashTitles(titles) {
  // Cheap stable hash; titles are short enough and we only need uniqueness.
  let h = 0;
  for (const t of titles) {
    for (let i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
    h = (h * 31) | 0;
  }
  return String(h);
}

function buildPrompt(titles) {
  return [
    'You are extracting product identity from a list of Google Lens visual-match titles.',
    'The user scanned a single product. Multiple sellers/retailers show the same product with different title styles.',
    'Your job is to identify the product and return the single cleanest Google Shopping query that would find IT (and not lookalikes).',
    '',
    'Rules:',
    '- Output STRICT JSON matching the schema below. No prose, no markdown.',
    '- query: brand + model + the most distinguishing variant token (color/size/year). NO retailer names, NO generic shoe/bag/toy nouns, NO size or condition tokens.',
    '- sku: the product code (e.g. Nike "IB8873-666", adidas "H03474", Lego "75192", Louis Vuitton "M41526") if it appears in at least one title; else null.',
    '- category: one of "sneaker" | "bag" | "watch" | "toy" | "apparel" | "electronics" | "trading_card" | "other".',
    '- variant: the colorway/edition/size that distinguishes this from sibling products (e.g. "Beige", "Better Scarlet", "Monogram", "UCS"). Single short token or phrase. Null if not applicable.',
    '- If the titles describe several different products (no consensus), set confidence to "low" and base your query on the most-cited candidate.',
    '',
    'Schema:',
    '{"brand":string|null,"model":string|null,"variant":string|null,"sku":string|null,"category":string,"query":string,"confidence":"high"|"medium"|"low"}',
    '',
    'Lens match titles (top-' + TOP_N_TITLES + ', highest visual similarity first):',
    ...titles.map((t, i) => `${i + 1}. ${t}`),
  ].join('\n');
}

function buildRequest(titles) {
  return {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(titles) }] }],
    generationConfig: {
      thinkingConfig: { thinkingBudget: 0 },     // no reasoning needed; just pattern extraction
      responseMimeType: 'application/json',
      temperature: 0,
    },
  };
}

function validateIdentity(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const query = typeof obj.query === 'string' ? obj.query.trim() : '';
  if (!query) return null;   // query is the one field we absolutely need
  return {
    brand:      typeof obj.brand    === 'string' ? obj.brand.trim()    || null : null,
    model:      typeof obj.model    === 'string' ? obj.model.trim()    || null : null,
    variant:    typeof obj.variant  === 'string' ? obj.variant.trim()  || null : null,
    sku:        typeof obj.sku      === 'string' ? obj.sku.trim()      || null : null,
    category:   typeof obj.category === 'string' ? obj.category.trim() || 'other' : 'other',
    query,
    confidence: ['high','medium','low'].includes(obj.confidence) ? obj.confidence : 'medium',
    _source:    'ai',     // diagnostic marker — distinguishes from legacy regex path
  };
}

// Main entry. Given Lens visualMatches, returns a normalized identity object
// or null if the call failed / response was unusable. Caller decides whether
// to fall back to legacy logic.
async function extractProductIdentity(visualMatches) {
  if (!process.env.GEMINI_API_KEY) return null;
  const titles = (Array.isArray(visualMatches) ? visualMatches : [])
    .slice(0, TOP_N_TITLES)
    .map(m => (m && m.title) || '')
    .filter(t => t.length > 0);
  if (titles.length === 0) return null;

  // Cache check
  const key = hashTitles(titles);
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.identity;
  }

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify(buildRequest(titles)),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    if (!r.ok) {
      console.warn('[ai-product-id] HTTP', r.status, '— falling back to legacy');
      return null;
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.warn('[ai-product-id] empty response — falling back');
      return null;
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { console.warn('[ai-product-id] non-JSON response — falling back:', text.slice(0, 120)); return null; }

    const identity = validateIdentity(parsed);
    if (!identity) {
      console.warn('[ai-product-id] validation failed — falling back');
      return null;
    }
    // Cache + FIFO trim
    if (CACHE.size >= CACHE_MAX) {
      const firstKey = CACHE.keys().next().value;
      if (firstKey) CACHE.delete(firstKey);
    }
    CACHE.set(key, { identity, fetchedAt: Date.now() });
    console.log('[ai-product-id] query="' + identity.query + '" sku=' + identity.sku + ' cat=' + identity.category + ' conf=' + identity.confidence);
    return identity;
  } catch (err) {
    console.warn('[ai-product-id] threw:', err.message, '— falling back');
    return null;
  }
}

module.exports = {
  TOP_N_TITLES,
  buildPrompt,
  buildRequest,
  validateIdentity,
  extractProductIdentity,
  _cache: CACHE,   // exposed for tests
};
