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

module.exports = { buildGradedCard, formatGradedResult };
