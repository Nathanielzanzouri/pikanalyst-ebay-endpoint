'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  USD_TO_EUR, GBP_TO_EUR, DEAL_THRESHOLD, OVER_THRESHOLD,
  toEur, percentileSimple, computeVerdict, computeBidRange,
} = require('../price-stats');

// ─── toEur ────────────────────────────────────────────────────────────────────
test('toEur: EUR passes through unchanged', () => {
  assert.strictEqual(toEur(42.5, 'EUR'), 42.5);
});

test('toEur: USD converts via USD_TO_EUR (rounded 2dp)', () => {
  assert.strictEqual(toEur(100, 'USD'), Math.round(100 * USD_TO_EUR * 100) / 100);
  assert.strictEqual(toEur(100, 'USD'), 92);
});

test('toEur: GBP converts via GBP_TO_EUR (proves the silent bug is gone)', () => {
  assert.strictEqual(toEur(100, 'GBP'), Math.round(100 * GBP_TO_EUR * 100) / 100);
  assert.strictEqual(toEur(100, 'GBP'), 117);
});

test('toEur: unknown currency returns null (excluded from stats)', () => {
  const origWarn = console.warn;
  let warnedWith = null;
  console.warn = (...args) => { warnedWith = args; };
  try {
    assert.strictEqual(toEur(100, 'CAD'), null);
    assert.ok(warnedWith && warnedWith.join(' ').includes('CAD'),
      'expected warning to mention currency code, got: ' + JSON.stringify(warnedWith));
  } finally {
    console.warn = origWarn;
  }
});

test('toEur: null / NaN inputs return null', () => {
  assert.strictEqual(toEur(null, 'EUR'), null);
  assert.strictEqual(toEur(NaN, 'EUR'), null);
});

// ─── percentileSimple ────────────────────────────────────────────────────────
test('percentileSimple: empty array returns null', () => {
  assert.strictEqual(percentileSimple([], 0.5), null);
});

test('percentileSimple: 1-element array returns that element', () => {
  assert.strictEqual(percentileSimple([42], 0.50), 42);
});

test('percentileSimple: matches existing median formula', () => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  assert.strictEqual(percentileSimple(arr, 0.50), 6);
});

test('percentileSimple: p=1 clamps to last element', () => {
  assert.strictEqual(percentileSimple([1, 2, 3], 1.0), 3);
});

// ─── computeVerdict (±15% symmetric, since 2026-06-11) ───────────────────────
test('computeVerdict: NO_DATA when median is missing/zero', () => {
  assert.strictEqual(computeVerdict(50, null), 'NO_DATA');
  assert.strictEqual(computeVerdict(50, 0), 'NO_DATA');
});

test('computeVerdict: NO_DATA when asking is missing/zero', () => {
  assert.strictEqual(computeVerdict(null, 100), 'NO_DATA');
  assert.strictEqual(computeVerdict(0, 100), 'NO_DATA');
});

test('computeVerdict: DEAL when asking < median * 0.85', () => {
  // median 100 → DEAL below 85
  assert.strictEqual(computeVerdict(84, 100), 'DEAL');
  assert.strictEqual(computeVerdict(50, 100), 'DEAL');
});

test('computeVerdict: FAIR at exactly the deal threshold (boundary inclusive)', () => {
  // ratio === DEAL_THRESHOLD → not strictly less, so FAIR
  assert.strictEqual(computeVerdict(85, 100), 'FAIR');
});

test('computeVerdict: FAIR within ±15% band', () => {
  assert.strictEqual(computeVerdict(100, 100), 'FAIR');
  assert.strictEqual(computeVerdict(90,  100), 'FAIR');
  assert.strictEqual(computeVerdict(110, 100), 'FAIR');
  assert.strictEqual(computeVerdict(115, 100), 'FAIR'); // exactly at OVER threshold → boundary inclusive
});

test('computeVerdict: OVER when asking > median * 1.15', () => {
  assert.strictEqual(computeVerdict(116, 100), 'OVER');
  assert.strictEqual(computeVerdict(200, 100), 'OVER');
});

test('computeVerdict: rejects NaN inputs as NO_DATA', () => {
  assert.strictEqual(computeVerdict(NaN, 100), 'NO_DATA');
  assert.strictEqual(computeVerdict(50, NaN), 'NO_DATA');
});

test('computeVerdict: thresholds match exported constants', () => {
  assert.strictEqual(DEAL_THRESHOLD, 0.85);
  assert.strictEqual(OVER_THRESHOLD, 1.15);
});

// ─── computeBidRange (new shape) ─────────────────────────────────────────────
test('computeBidRange: n=0 returns nulls + confidence=low', () => {
  const r = computeBidRange([], [], 30);
  assert.deepStrictEqual(r, {
    n: 0, median: null, deal_below: null, over_above: null,
    window_days: 30, markets: [], confidence: 'low',
  });
});

test('computeBidRange: n=1 — median = the single value, thresholds rounded', () => {
  const r = computeBidRange([80], [{ country: 'FR' }], 30);
  assert.strictEqual(r.n, 1);
  assert.strictEqual(r.median, 80);
  assert.strictEqual(r.deal_below, 68); // 80 * 0.85 = 68
  assert.strictEqual(r.over_above, 92); // 80 * 1.15 = 92
  assert.deepStrictEqual(r.markets, ['FR']);
  assert.strictEqual(r.confidence, 'low');
});

test('computeBidRange: n=5+ has confidence=ok', () => {
  const r = computeBidRange([1, 2, 3, 4, 5], [], 30);
  assert.strictEqual(r.confidence, 'ok');
});

test('computeBidRange: n=4 has confidence=low', () => {
  const r = computeBidRange([1, 2, 3, 4], [], 30);
  assert.strictEqual(r.confidence, 'low');
});

test('computeBidRange: markets deduped from listings', () => {
  const listings = [
    { country: 'FR' }, { country: 'FR' }, { country: 'GB' },
    { country: 'US' }, { country: null }, { country: 'GB' },
  ];
  const r = computeBidRange([10, 20, 30], listings, 90);
  assert.deepStrictEqual(new Set(r.markets), new Set(['FR', 'GB', 'US']));
});

test('computeBidRange: window_days passed through', () => {
  const r = computeBidRange([10], [], 90);
  assert.strictEqual(r.window_days, 90);
});

test('computeBidRange: thresholds match the verdict semantics on the same median', () => {
  // For median = 100, FAIR should span [85..115], DEAL < 85, OVER > 115.
  // Verify deal_below/over_above match those (integer-rounded for display).
  const r = computeBidRange([100], [], 30);
  assert.strictEqual(r.median, 100);
  assert.strictEqual(r.deal_below, Math.round(100 * DEAL_THRESHOLD)); // 85
  assert.strictEqual(r.over_above, Math.round(100 * OVER_THRESHOLD)); // 115
  // And verdict agrees on the edges
  assert.strictEqual(computeVerdict(r.deal_below, r.median), 'FAIR'); // boundary inclusive
  assert.strictEqual(computeVerdict(r.deal_below - 1, r.median), 'DEAL');
  assert.strictEqual(computeVerdict(r.over_above + 1, r.median), 'OVER');
});

test('computeBidRange: large median rounds cleanly (€500)', () => {
  const r = computeBidRange([500], [], 30);
  assert.strictEqual(r.deal_below, 425); // 500 * 0.85
  assert.strictEqual(r.over_above, 575); // 500 * 1.15
});

test('computeBidRange: tiny median rounds to integer (€5)', () => {
  const r = computeBidRange([5], [], 30);
  assert.strictEqual(r.median, 5);
  assert.strictEqual(r.deal_below, 4); // 5 * 0.85 = 4.25 → 4
  assert.strictEqual(r.over_above, 6); // 5 * 1.15 = 5.75 → 6
});

// ─── Regression fixtures ─────────────────────────────────────────────────────
test('regression: bid_range.median == Math.round(prices[floor(n/2)] * 100) / 100', () => {
  const cleanedPrices = [3.30, 4.01, 4.52, 5.12, 5.62, 5.72, 7.00, 17.51, 17.60];
  const expected = Math.round(cleanedPrices[Math.floor(cleanedPrices.length / 2)] * 100) / 100;
  const r = computeBidRange(cleanedPrices, [], 30);
  assert.strictEqual(r.median, expected);
});

test('regression: GBP comps produce the correct median', () => {
  const rawItems = [
    { price: '10.00', currency: 'EUR' },
    { price: '10.00', currency: 'EUR' },
    { price: '100.00', currency: 'GBP' },
    { price: '100.00', currency: 'GBP' },
    { price: '100.00', currency: 'GBP' },
  ];
  const converted = rawItems
    .map(i => toEur(parseFloat(i.price), i.currency))
    .filter(v => v != null)
    .sort((a, b) => a - b);
  // [10, 10, 117, 117, 117] → median = converted[2] = 117
  const r = computeBidRange(converted, [], 30);
  assert.strictEqual(r.median, 117);
  assert.strictEqual(r.deal_below, Math.round(117 * 0.85)); // 99
  assert.strictEqual(r.over_above, Math.round(117 * 1.15)); // 135
});

test('regression: unknown currency dropped from stats', () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const converted = [
      { price: '10', currency: 'EUR' },
      { price: '10', currency: 'EUR' },
      { price: '999', currency: 'CAD' },
    ]
      .map(i => toEur(parseFloat(i.price), i.currency))
      .filter(v => v != null);
    assert.strictEqual(converted.length, 2);
  } finally {
    console.warn = origWarn;
  }
});
