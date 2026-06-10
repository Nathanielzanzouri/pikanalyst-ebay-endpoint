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
//   median * 1.15, rounded:
//     >= 100€ → nearest 5€
//     <  100€ → nearest 1€
function roundMaxBid(median) {
  if (median == null) return null;
  // Clean FP noise before rounding (50 * 1.15 → 57.4999999… not 57.5 in IEEE 754).
  const target = Math.round(median * 1.15 * 100) / 100;
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
  const median    = medianRaw != null ? Math.round(medianRaw * 100) / 100 : null;
  const p25       = p25Raw    != null ? Math.round(p25Raw    * 100) / 100 : null;
  const max_bid   = roundMaxBid(median);
  const markets   = [...new Set((listings || []).map(l => l && l.country).filter(Boolean))];
  return {
    n,
    p25,
    median,
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
