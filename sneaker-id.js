'use strict';

// Style-code patterns. Each is tried independently; results are de-duped.
// The adidas pattern uses a negative lookahead so it does not match the
// "IB8873" prefix of a Nike modern code like "IB8873-666".
const NIKE_MODERN = /\b[A-Z]{2}\d{4}-\d{3}\b/g;            // IB8873-666, IQ9381-100
const NIKE_LEGACY = /\b\d{6}-\d{3}\b/g;                    // 555088-101
const NEW_BALANCE = /\b[MWUG][A-Z]?\d{3,4}[A-Z]{2,3}\d?\b/g; // U9060FNB, M2002RDA
const ADIDAS      = /\b[A-Z]{2}\d{4}(?!-?\d)\b/g;          // ID0477, IE3438

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
const STYLE_CODE_THRESHOLD = 8;

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

// Build a confident identity from Lens visual matches.
// `referenceTitle` is the highest-ranked match whose title contains the
// winning style code — it carries the real "brand model colorway sku" text.
function buildIdentity(visualMatches) {
  const { styleCode, score } = extractStyleCode(visualMatches);
  const brand = extractBrand(visualMatches);
  let referenceTitle = null;
  if (styleCode) {
    const up = styleCode.toUpperCase();
    const hit = (visualMatches || []).find(
      (m) => m && m.title && m.title.toUpperCase().includes(up)
    );
    referenceTitle = hit ? hit.title : null;
  }
  const confident = !!styleCode && score >= STYLE_CODE_THRESHOLD && !!referenceTitle;
  return { brand, styleCode, referenceTitle, score, confident };
}

module.exports = { findStyleCodes, extractStyleCode, extractBrand, buildIdentity };
