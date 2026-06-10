'use strict';

// ─── Currency normalisation ──────────────────────────────────────────────────
// TODO: replace with daily-cached rates later (cron or warm-on-boot from
// api.exchangerate-api.com). Currently static for simplicity / zero deps.
const USD_TO_EUR = 0.92;
const GBP_TO_EUR = 1.17;

// Convert a price to EUR. Returns null and logs a warning for any currency
// outside {EUR, USD, GBP} — caller must drop nulls from the stats input so
// foreign-currency listings don't contaminate medians silently.
function toEur(price, currency) {
  if (price == null || isNaN(price)) return null;
  switch (currency) {
    case 'EUR': return price;
    case 'USD': return Math.round(price * USD_TO_EUR * 100) / 100;
    case 'GBP': return Math.round(price * GBP_TO_EUR * 100) / 100;
    default:
      console.warn('[Lakkot/price-stats] excluding unsupported currency:', currency);
      return null;
  }
}

// Percentile picker using the same "index = floor(n*p)" method as the existing
// median calc (server.js historic median = prices[Math.floor(n/2)]). Keeps
// bid_range.median byte-identical to market_price_usd on the same input.
function percentileSimple(sortedArray, p) {
  if (!sortedArray.length) return null;
  const idx = Math.min(Math.floor(sortedArray.length * p), sortedArray.length - 1);
  return sortedArray[idx];
}

// max_bid rounding rule:
//   value passed in (= p75 since 2026-06-11), rounded:
//     >= 100€ → nearest 5€
//     <  100€ → nearest 1€
// Was median * 1.15 before — replaced by p75 of cleaned comps (the price
// most successful bidders actually paid for the upper-quartile listings).
function roundMaxBid(value) {
  if (value == null) return null;
  // Clean FP noise before rounding.
  const target = Math.round(value * 100) / 100;
  const step = target >= 100 ? 5 : 1;
  return Math.round(target / step) * step;
}

// Build the bid_range object added to /scan CARD_RESULT responses.
// Inputs:
//   sortedPrices : array of EUR-normalised prices, ascending, post-outlier
//   listings     : array of listing objects (each may have a `country`)
//   windowDays   : the dateRange the caller actually used
// Output: always returns an object — never null, never throws.
function computeBidRange(sortedPrices, listings, windowDays) {
  const n = sortedPrices.length;
  const medianRaw = n > 0 ? sortedPrices[Math.floor(n / 2)] : null;
  const p25Raw    = percentileSimple(sortedPrices, 0.25);
  const p75Raw    = percentileSimple(sortedPrices, 0.75);
  const median    = medianRaw != null ? Math.round(medianRaw * 100) / 100 : null;
  const p25       = p25Raw    != null ? Math.round(p25Raw    * 100) / 100 : null;
  const p75       = p75Raw    != null ? Math.round(p75Raw    * 100) / 100 : null;
  const max_bid   = roundMaxBid(p75); // since 2026-06-11: p75 instead of median*1.15
  const markets   = [...new Set((listings || []).map(l => l && l.country).filter(Boolean))];
  return {
    n,
    p25,
    median,
    p75,
    max_bid,
    window_days: windowDays,
    markets,
    confidence: n >= 5 ? 'ok' : 'low',
  };
}

module.exports = {
  USD_TO_EUR,
  GBP_TO_EUR,
  toEur,
  percentileSimple,
  roundMaxBid,
  computeBidRange,
};
