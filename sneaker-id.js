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

// Resale/consignment + luxury-boutique sources. For a GENERAL-RELEASE sneaker
// these inflate the price wildly (a $115 Air Force 1 shows up at €283 on GOAT,
// €2774 on a luxury reseller). We prefer retail for those. BUT for a hyped /
// sold-out shoe, resale IS the market — so the tri only drops these when a
// healthy retail cluster exists, and keeps them otherwise (see
// filterByShoeIdentity's `priced` logic).
const RESALE_LUXURY_SOURCES = [
  'goat', 'stockx', 'flight club', 'flightclub', 'stadium goods', 'stadiumgoods',
  'farfetch', 'ssense', 'shein', 'editorialist', 'grailed', 'vestiaire',
  'poshmark', 'klekt', 'restocks',
];

function isResaleOrLuxury(source) {
  const s = String(source || '').toLowerCase();
  return RESALE_LUXURY_SOURCES.some((m) => s.includes(m));
}

// Google Shopping cards from handleGoogleShopping carry the merchant name in
// `retailer` (raw SerpApi results the standalone tests used call it `source`).
// Read either so the tri works on both shapes.
function sourceOf(c) {
  return (c && (c.source || c.retailer)) || '';
}

// A used/second-hand listing. Google Shopping flags these via
// second_hand_condition:"pre-owned", surfaced on the card as isSecondHand.
function isPreOwned(c) {
  if (!c) return false;
  if (c.isSecondHand === true) return true;
  const cond = String(c.condition || c.second_hand_condition || '').toLowerCase();
  return /pre.?owned|used|second.?hand|refurb|occasion|d.occasion/.test(cond);
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

// Blog / editorial / interrogative phrases that leak into Lens titles for hyped
// releases ("Date de sortie de la ...", "Que vaut la ... ?", "... ou pas ?").
// When a query is built from such a title, Google Shopping returns almost
// nothing — a real, in-stock shoe reads as NO_DATA. We strip these.
const QUERY_NOISE_RE = /\b(date de sortie(?: de la| du| des)?|release dates?|que vaut(?: la| le| les)?|pourquoi|avis|reviews?|combien|prix de|first look|on ?foot|vaut le coup|ou pas|acheter|buy|shop now)\b/gi;

// Build a clean Google Shopping query for a sneaker from its STRUCTURED
// identity (brand + model + colorway + style code) rather than a raw,
// possibly blog-flavoured title. Accepts Gemini identity ({brand,model,
// variant,sku,query}) or the legacy vote ({brand,styleCode}). Falls back to a
// noise-stripped identity.query only when we lack a model/sku signal.
function cleanSneakerQuery(identity) {
  if (!identity) return '';
  const sku = identity.sku || identity.styleCode || '';
  const assembled = [identity.brand, identity.model, identity.variant, sku]
    .filter(Boolean).join(' ');
  const base = (identity.model || sku) ? assembled : (identity.query || assembled || '');
  return String(base)
    .replace(QUERY_NOISE_RE, ' ')
    .replace(/[?!."']/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Minimal high-recall retry query when the primary one comes back empty:
// brand + style code (e.g. "Jordan JA1135-100"), else model + style code.
function fallbackSneakerQuery(identity) {
  if (!identity) return '';
  const sku = identity.sku || identity.styleCode || '';
  const q = [identity.brand, sku].filter(Boolean).join(' ')
    || [identity.model, sku].filter(Boolean).join(' ');
  return q.trim();
}

// Keep only Shopping results whose title contains the style code. Normalizing
// strips dashes/spaces/case so "IB8873-666", "ib8873 666", "Ib8873666" all match.
function filterBySku(cards, styleCode) {
  if (!styleCode) return [];
  const want = normalizeCode(styleCode);
  return (cards || []).filter((c) => normalizeCode(c && c.title).includes(want));
}

// Tokens that show up in basically every sneaker listing and don't help a
// Google Shopping query: sizing, gender, generic product category, commerce
// chrome, language particles, marketplace names. The remainder of the title
// is brand, model, colorway, year — exactly what we want to search on.
const PHRASE_STOPWORDS = new Set([
  // articles / prepositions / connectors
  'a','an','the','and','or','for','with','of','to','in','on','at','by','from','vs','et','en','de','la','le','les','du','un','une','des','sur','par','pour','aux',
  // sizing / metadata
  'size','sz','taille','eu','us','uk','cm',
  // gender / age
  'men','mens','women','womens','wmns','homme','femme','femmes','hommes','unisex','enfant','kid','kids','child','baby','toddler','grade','school','gs','ps','td','garcon','fille',
  // generic product nouns (any sneaker listing has these)
  'sneaker','sneakers','shoe','shoes','baskets','basses','basket','chaussures','chaussure','trainers','trainer','baskets',
  // commerce noise
  'price','prix','sale','release','date','sortie','buy','shop','achetez','new','used','preowned','box','brand','original','authentic','official','review','available','feet','foot','pair','paire','pairs','paires','style','model',
  // country/lang codes that bleed in
  'fr','com','net','org','www','meilleur','tunisie',
  // marketplaces (kept out of the phrase so the query targets retailers)
  'ebay','offerup','mercari','poshmark','depop','amazon','grailed','vestiaire','vinted','kixify','facebook',
]);

// Word-frequency vote across the top Lens-match titles to recover the
// shoe's "common name" the way retailer pages title it (brand + model + colorway
// + maybe year). Used to build a retailer-friendly Shopping query that surfaces
// links from Nike / Foot Locker / JD Sports / Zalando, not just eBay.
function extractCommonPhrase(visualMatches, topN = 15, maxTokens = 6) {
  const matches = (visualMatches || []).slice(0, topN);
  if (!matches.length) return '';
  const counts = {};
  for (const m of matches) {
    if (!m || !m.title) continue;
    const seen = new Set();
    const tokens = String(m.title).toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !PHRASE_STOPWORDS.has(t));
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  const minCount = Math.max(2, Math.ceil(matches.length * 0.25));
  return Object.entries(counts)
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTokens)
    .map(([t]) => t)
    .join(' ');
}

// ─── Tolerant identity tri (replaces filterBySku on Shopping results) ─────────
// filterBySku required the style code IN each result title, which retailers
// (GOAT, DICK's, Finish Line, ...) never include — so it discarded good
// listings and forced compensating extra Shopping calls. This tri instead
// gates on brand + core model tokens (which retailers DO title) and scores the
// colorway, so the right sneaker survives without a second/third call.

// Lowercase, strip accents, collapse anything non-alphanumeric to single spaces.
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Generic silhouette qualifiers dropped from the model gate: retailers omit or
// vary them ("Air Force 1" vs "Air Force 1 Low '07"), so requiring them would
// re-create the over-strict filter we are replacing.
const MODEL_QUALIFIER_STOP = new Set([
  'low', 'high', 'mid', '07', 'og', 'sp', 'se', 'gs', 'ps', 'td', 'lv8',
  'prm', 'premium', 'next', 'nature',
]);

function identityTokens(s, extraStop) {
  return normalizeText(s).split(' ').filter(
    (t) => t && !(extraStop && extraStop.has(t)) && !/^(19|20)\d{2}$/.test(t)
  );
}

// Generic color / filler words that are not distinctive enough to pin an exact
// colorway on their own. When the identified colorway carries a DISTINCTIVE
// token (e.g. "aquarius", "chicago", "bred") we gate display on it so the user
// only sees their exact colorway; when the colorway is all-generic
// ("white/black") we require a majority of those generic tokens instead.
const GENERIC_COLOR_TOKENS = new Set([
  'white', 'black', 'blue', 'red', 'grey', 'gray', 'green', 'pink', 'yellow',
  'orange', 'purple', 'brown', 'tan', 'cream', 'silver', 'gold', 'navy',
  'multi', 'metallic', 'volt',
  'blanc', 'noir', 'bleu', 'rouge', 'vert', 'rose', 'gris', 'beige', 'ciel', 'jaune',
]);

// Two-stage tri for sneaker Shopping results, precision-first.
//
// Stage 1 — MODEL gate (tolerant): keep listings carrying a strong majority of
// the brand+model tokens. Score-based, not all-tokens: retailers title the same
// shoe "Nike Air Force 1", "Air Force 1 '07" (no brand) or "Nike Force 1" (no
// "air"); an all-tokens gate would drop those. Drops "Dunk Low" lookalikes.
//
// Stage 2 — COLORWAY gate (precision): from the model-matched set, keep only
// the listings that also match the scanned colorway, so the user sees THEIR
// exact model+colorway rather than every AF1 ("Hyper Royal", "Racer Blue", a
// different SKU, ...). A distinctive colorway token (e.g. "aquarius") is
// required outright; an all-generic colorway ("white/black") requires a
// majority of its tokens. Falls back to the model-matched set when the colorway
// match is empty, so we never show nothing.
//
// Display is ranked so the most-exact listing is first: exact SKU in title,
// then higher colorway score, then lower price.
//
// Returns:
//   display — ranked listings to SHOW the user (colorway-gated when possible)
//   priced  — subset to take the median over (retail cluster of the display
//             set when healthy, else the display set; resale/luxury dropped
//             only when a retail cluster exists — hyped shoes price on resale)
//   kept    — model-matched (diagnostic)  |  colorGated — colorway-matched
//   retail  — priced minus marketplace/resale/luxury (diagnostic)
//   gated   — false when there was no usable model signal (caller keeps basket)
function filterByShoeIdentity(cards, identity, opts = {}) {
  const minScore = opts.minScore != null ? opts.minScore : 0.6;
  const minRetail = opts.minRetail != null ? opts.minRetail : 3;
  const list = Array.isArray(cards) ? cards : [];
  const brandTok = identityTokens(identity && identity.brand);
  const modelTok = identityTokens(identity && identity.model, MODEL_QUALIFIER_STOP);
  const idTok = [...new Set([...brandTok, ...modelTok])];
  const colorTok = identityTokens(identity && identity.variant);
  const distinctColor = colorTok.filter((t) => !GENERIC_COLOR_TOKENS.has(t));
  const skuNorm = normalizeCode(identity && identity.sku);

  // No model signal → we cannot gate safely; hand the basket back untouched.
  if (modelTok.length === 0) {
    return { display: list, priced: list, kept: list, colorGated: list, retail: list, gated: false };
  }

  const wordsOf = (c) => new Set(normalizeText(c && c.title).split(' '));

  // Stage 1 — model gate.
  const modelMatched = list.filter((c) => {
    const words = wordsOf(c);
    const matched = idTok.reduce((n, tok) => n + (words.has(tok) ? 1 : 0), 0);
    return matched / idTok.length >= minScore;
  });

  // Condition gate — the cote is the NEW retail price, so drop pre-owned /
  // second-hand listings (mostly eBay). Fall back to the full model set only
  // if there are no new listings at all, so a resale-only shoe still prices.
  const newOnly = opts.newOnly === false ? false : true;
  const modelNew = newOnly ? modelMatched.filter((c) => !isPreOwned(c)) : modelMatched;
  const kept = modelNew.length >= 1 ? modelNew : modelMatched;

  // Stage 2 — colorway gate.
  const colorGated = kept.filter((c) => {
    const words = wordsOf(c);
    if (distinctColor.length) return distinctColor.every((t) => words.has(t));
    if (colorTok.length) {
      const hit = colorTok.reduce((n, t) => n + (words.has(t) ? 1 : 0), 0);
      return hit >= Math.ceil(colorTok.length / 2);
    }
    return true; // no colorway info → cannot narrow further
  });

  // Prefer the colorway-matched set for display; fall back to model-matched
  // only when colorway matching found nothing.
  const display = colorGated.length >= 1 ? [...colorGated] : [...kept];

  // Rank: exact SKU first, then colorway score, then cheapest.
  const colorScore = (c) => {
    const words = wordsOf(c);
    return colorTok.reduce((n, t) => n + (words.has(t) ? 1 : 0), 0);
  };
  const hasSku = (c) => skuNorm && normalizeCode(c && c.title).includes(skuNorm);
  display.sort((a, b) => {
    const s = (hasSku(b) ? 1 : 0) - (hasSku(a) ? 1 : 0);
    if (s) return s;
    const cs = colorScore(b) - colorScore(a);
    if (cs) return cs;
    return (a.price || 0) - (b.price || 0);
  });

  // Price over the display set's retail cluster when healthy, else the display
  // set (hyped/sold-out shoe → resale is the market).
  const retail = display.filter(
    (c) => !isMarketplace(sourceOf(c)) && !isResaleOrLuxury(sourceOf(c))
  );
  const priced = retail.length >= minRetail ? retail : display;
  return { display, priced, kept, colorGated, retail, gated: true };
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
  buildShoppingQuery, filterBySku, filterByShoeIdentity, medianOf,
  isMarketplace, isResaleOrLuxury, isPreOwned, extractCommonPhrase, normalizeText,
  cleanSneakerQuery, fallbackSneakerQuery,
};
