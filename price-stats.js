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

// Verdict thresholds (±15% symmetric since 2026-06-11). Used by both the
// extension and the web — single source of truth for DEAL/FAIR/OVER calls.
const DEAL_THRESHOLD = 0.85; // asking < median * 0.85 → DEAL
const OVER_THRESHOLD = 1.15; // asking > median * 1.15 → OVER

// Compute DEAL/FAIR/OVER verdict from an asking price and a median market
// price. Returns 'NO_DATA' if either is null/0/NaN.
function computeVerdict(asking, median) {
  if (!median || !asking || isNaN(asking) || isNaN(median)) return 'NO_DATA';
  const ratio = asking / median;
  if (ratio < DEAL_THRESHOLD) return 'DEAL';
  if (ratio > OVER_THRESHOLD) return 'OVER';
  return 'FAIR';
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
  const median    = medianRaw != null ? Math.round(medianRaw * 100) / 100 : null;
  // Display thresholds — integer-rounded for live-bidding cognitive ease.
  // The verdict logic itself compares the raw ratio (no rounding edge cases).
  const deal_below = median != null ? Math.round(median * DEAL_THRESHOLD) : null;
  const over_above = median != null ? Math.round(median * OVER_THRESHOLD) : null;
  const markets    = [...new Set((listings || []).map(l => l && l.country).filter(Boolean))];
  return {
    n,
    median,
    deal_below,
    over_above,
    window_days: windowDays,
    markets,
    confidence: n >= 5 ? 'ok' : 'low',
  };
}

module.exports = {
  USD_TO_EUR,
  GBP_TO_EUR,
  DEAL_THRESHOLD,
  OVER_THRESHOLD,
  toEur,
  percentileSimple,
  computeVerdict,
  computeBidRange,
};
