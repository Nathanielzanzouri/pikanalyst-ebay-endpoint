'use strict';

// Graded-price comps: given a raw card identity, build the eBay query for a
// specific grade (e.g. PSA 10) and normalise a fetchEbayBrowse result into a
// small {median, count} shape. Pure functions — no network, no server import.

// Build a card object for a single strict grade query. Putting the grade in
// ebay_search makes buildBrowseQueries target it; _gradeFilter makes the title
// filter keep only that grade (strict mode). Both together = a clean grade
// median, never mixed with other grades or raw.
function buildGradedCard(cardName, cardNumber, company, grade) {
  const name = String(cardName || '').trim();
  const num  = String(cardNumber || '').trim();
  const ebay_search = [name, num, `${company} ${grade}`].filter(Boolean).join(' ');
  return {
    card_name: name,
    card_number: num,
    ebay_search,
    _gradeFilter: { company, grade: String(grade), pokemonName: name },
  };
}

// Normalise a fetchEbayBrowse result (or null) into {median, count, currency}.
// market_price_usd is already EUR-normalised in this codebase. Below the
// confidence threshold (default 2 sales) we null the median so the front shows
// "—" instead of a price backed by a single sale.
function formatGradedResult(browseResult, minCount = 2) {
  const count  = (browseResult && browseResult.ebay_sales_count) || 0;
  const median = browseResult && browseResult.market_price_usd != null
    ? browseResult.market_price_usd
    : null;
  if (median == null || count < minCount) {
    return { median: null, count, currency: 'EUR' };
  }
  return { median, count, currency: 'EUR' };
}

// v1 grades. Add CGC/BGS or other grades here later without touching callers.
const GRADES = [
  { key: 'psa10', company: 'PSA', grade: '10' },
  { key: 'psa9',  company: 'PSA', grade: '9'  },
];

// Fetch the median for each grade in parallel. Dependencies are INJECTED
// (getToken, browse) so this is unit-testable without network and so the
// module never imports server.js (no circular dependency). browse is expected
// to be the real fetchEbayBrowse(card, token, language) — which does NOT touch
// the sold-history cache, so the raw cote is never polluted (spec §5).
async function fetchGradedPrices({
  cardName, cardNumber, language = 'WORLD',
  getToken, browse, minCount = 2, grades = GRADES,
}) {
  let token = null;
  try { token = await getToken(); }
  catch (_) { token = null; }

  const entries = await Promise.all(grades.map(async (g) => {
    if (!token) return [g.key, { median: null, count: 0, currency: 'EUR' }];
    try {
      const card = buildGradedCard(cardName, cardNumber, g.company, g.grade);
      const result = await browse(card, token, language);
      return [g.key, formatGradedResult(result, minCount)];
    } catch (_) {
      // fetchEbayBrowse throws on 0 results — that's a valid "no data" outcome.
      return [g.key, { median: null, count: 0, currency: 'EUR' }];
    }
  }));
  return Object.fromEntries(entries);
}

module.exports = { GRADES, buildGradedCard, formatGradedResult, fetchGradedPrices };
