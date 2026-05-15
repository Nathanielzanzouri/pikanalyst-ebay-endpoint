'use strict';

// Style-code patterns. Each is tried independently; results are de-duped.
// The adidas pattern uses a negative lookahead so it does not match the
// "IB8873" prefix of a Nike modern code like "IB8873-666".
// Style codes appear in retailer titles with either a dash ("CQ9447-700") or a
// space ("CQ9447 700"), so the suffix separator is [\s-]. The adidas pattern's
// negative lookahead matches that same character class so it doesn't grab the
// "CQ9447" prefix of a Nike code that's space-separated.
const NIKE_MODERN = /\b[A-Z]{2}\d{4}[\s-]\d{3}\b/g;        // IB8873-666, CQ9447 700
const NIKE_LEGACY = /\b\d{6}[\s-]\d{3}\b/g;                // 555088-101, 555088 101
const NEW_BALANCE = /\b[MWUG][A-Z]?\d{3,4}[A-Z]{2,3}\d?\b/g; // U9060FNB, M2002RDA
const ADIDAS      = /\b[A-Z]{2}\d{4}(?![\s-]?\d)\b/g;      // ID0477, IE3438

function findStyleCodes(text) {
  if (!text) return [];
  const up = String(text).toUpperCase();
  const found = new Set();
  for (const re of [NIKE_MODERN, NIKE_LEGACY, NEW_BALANCE, ADIDAS]) {
    for (const m of up.matchAll(re)) found.add(m[0]);
  }
  return [...found];
}

// Vote for the most likely style code across the top Lens matches.
// Matches nearer the top of visual_matches are more trustworthy, so each
// match's vote is weighted by its position (top = highest weight). This is
// what stops a frequent-but-wrong lookalike code from winning.
function extractStyleCode(visualMatches, topN = 15) {
  const list = (visualMatches || []).slice(0, topN);
  const scores = {};
  list.forEach((m, i) => {
    const weight = topN - i; // position 0 → weight topN, last → weight 1
    for (const code of findStyleCodes(m && m.title)) {
      scores[code] = (scores[code] || 0) + weight;
    }
  });
  let styleCode = null;
  let score = 0;
  for (const [code, s] of Object.entries(scores)) {
    if (s > score) { styleCode = code; score = s; }
  }
  return { styleCode, score };
}

// Brand keyword → display label. "jordan" is listed before "nike" so a
// Jordan shoe (whose titles also say "Nike") resolves to "Jordan".
const BRAND_KEYWORDS = [
  ['new balance', 'New Balance'],
  ['jordan', 'Jordan'],
  ['nike', 'Nike'],
  ['adidas', 'adidas'],
  ['yeezy', 'adidas Yeezy'],
  ['asics', 'ASICS'],
  ['puma', 'Puma'],
  ['reebok', 'Reebok'],
  ['salomon', 'Salomon'],
  ['converse', 'Converse'],
  ['vans', 'Vans'],
];

// Minimum position-weighted score for a style code to count as a confident ID.
// Score = sum of (topN - position) across matches containing the code. Threshold
// of 5 admits one hit within the top 10, or any pattern of multiple hits.
// Precision is still guaranteed downstream by the SKU filter on Shopping results.
const STYLE_CODE_THRESHOLD = 5;

function extractBrand(visualMatches, topN = 15) {
  const list = (visualMatches || []).slice(0, topN);
  const scores = {};
  for (const m of list) {
    const hay = (((m && m.title) || '') + ' ' + ((m && m.source) || '')).toLowerCase();
    for (const [kw, label] of BRAND_KEYWORDS) {
      if (hay.includes(kw)) scores[label] = (scores[label] || 0) + 1;
    }
  }
  let brand = null;
  let best = 0;
  for (const [label, s] of Object.entries(scores)) {
    if (s > best) { brand = label; best = s; }
  }
  return brand;
}

// Marketplace listings (eBay/OfferUp/Mercari/...) carry junky titles loaded
// with sizes, locations, conditions, and seller chrome. Retailer/aggregator
// sources (StockX, GOAT, Laced, Footshop, SNS, Kith, ...) carry clean titles.
// We prefer the latter as the reference title used to build the Shopping query.
const MARKETPLACE_SOURCES = [
  'ebay', 'offerup', 'mercari', 'poshmark', 'depop', 'grailed',
  'amazon', 'vestiaire', 'vinted', 'kixify', 'wallapop', 'facebook',
];

function isMarketplace(source) {
  const s = String(source || '').toLowerCase();
  return MARKETPLACE_SOURCES.some((m) => s.includes(m));
}

// Pick the cleanest available reference title: first non-marketplace match
// whose title contains the style code, falling back to any SKU-containing
// match if no clean source is available.
function pickReferenceTitle(visualMatches, styleCode) {
  if (!styleCode) return null;
  const up = styleCode.toUpperCase();
  const skuHits = (visualMatches || []).filter(
    (m) => m && m.title && m.title.toUpperCase().includes(up)
  );
  if (!skuHits.length) return null;
  const clean = skuHits.find((m) => !isMarketplace(m.source));
  return (clean || skuHits[0]).title;
}

// Build a confident identity from Lens visual matches.
function buildIdentity(visualMatches) {
  const { styleCode, score } = extractStyleCode(visualMatches);
  const brand = extractBrand(visualMatches);
  const referenceTitle = pickReferenceTitle(visualMatches, styleCode);
  const confident = !!styleCode && score >= STYLE_CODE_THRESHOLD && !!referenceTitle;
  return { brand, styleCode, referenceTitle, score, confident };
}

// Build the Google Shopping query from a confident identity. The reference
// title is the cleanest available, but even retailer titles can have noise
// (sizes, gender markers, condition words, trailing chrome). Strip all of
// that so Google Shopping isn't over-constrained.
function buildShoppingQuery({ styleCode, referenceTitle }) {
  let q = String(referenceTitle || '')
    .replace(/\s*\|\s*/g, ' ')                                                            // flatten "|" separators
    .replace(/["']/g, ' ')                                                                // drop quotes
    .replace(/\bfor\s+sale\s+in\s+[^,]+(?:,\s*[A-Z]{2})?/gi, ' ')                         // "for Sale in Crown Point, IN"
    .replace(/\b(?:size|sz|us|eu|uk|talla|pointure|taille)\s*\d+(?:[.,]\d+)?\s*[mwy]?\b/gi, ' ') // "Size 12", "SZ 14", "Size 10.5"
    .replace(/\b\d+(?:[.,]\d+)?\s*[MWY]\b/g, ' ')                                         // bare "12M", "5Y"
    .replace(/\b(?:men'?s?|women'?s?|wmns)\b/gi, ' ')                                     // gender markers
    .replace(/\b(?:pre[-\s]?owned|brand[-\s]?new|deadstock|ds|gs|td|ps|original\s+box|no\s+box)\b/gi, ' ') // condition / kids / box
    .replace(/\b(?:ebay|offerup|mercari|poshmark|depop|grailed|amazon\.com|amazon|vestiaire|vinted|kixify|stockx|goat|facebook)\b/gi, ' ') // marketplace/retailer names
    .replace(/\b(?:buy|shop|achetez|giày|купить|cheap|sale|release|info)\b/gi, ' ')      // retailer verbs
    .replace(/[()[\]]/g, ' ')                                                             // parens / brackets
    .replace(/\s+[-–—]\s+/g, ' ')                                                         // standalone dashes between words
    .replace(/\s+/g, ' ')
    .trim();
  if (styleCode && !q.toUpperCase().includes(styleCode.toUpperCase())) {
    q += ' ' + styleCode;
  }
  return q.trim();
}

function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Keep only Shopping results whose title contains the style code. Normalizing
// strips dashes/spaces/case so "IB8873-666", "ib8873 666", "Ib8873666" all match.
function filterBySku(cards, styleCode) {
  if (!styleCode) return [];
  const want = normalizeCode(styleCode);
  return (cards || []).filter((c) => normalizeCode(c && c.title).includes(want));
}

function medianOf(cards) {
  const prices = (cards || [])
    .map((c) => (c && typeof c.price === 'number' ? c.price : null))
    .filter((p) => p != null && p > 0)
    .sort((a, b) => a - b);
  if (!prices.length) return null;
  return prices[Math.floor(prices.length / 2)];
}

module.exports = {
  findStyleCodes, extractStyleCode, extractBrand, buildIdentity,
  buildShoppingQuery, filterBySku, medianOf,
};
