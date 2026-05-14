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

module.exports = { findStyleCodes, extractStyleCode };
