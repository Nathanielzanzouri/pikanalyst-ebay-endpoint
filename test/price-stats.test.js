'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  USD_TO_EUR, GBP_TO_EUR,
  toEur, percentileSimple, roundMaxBid, computeBidRange,
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
  assert.strictEqual(percentileSimple([42], 0.25), 42);
  assert.strictEqual(percentileSimple([42], 0.50), 42);
  assert.strictEqual(percentileSimple([42], 0.75), 42);
});

test('percentileSimple: odd-length matches existing median formula', () => {
  // 11 sorted: index for p=0.5 is floor(11*0.5) = 5
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  assert.strictEqual(percentileSimple(arr, 0.50), 6);
  assert.strictEqual(percentileSimple(arr, 0.25), 3); // floor(11*0.25)=2 → arr[2]=3
  assert.strictEqual(percentileSimple(arr, 0.75), 9); // floor(11*0.75)=8 → arr[8]=9
});

test('percentileSimple: even-length picks consistent index', () => {
  // 4 sorted: floor(4*0.5)=2 → arr[2]=3, NOT the conventional average of arr[1]+arr[2]
  // Deliberate choice — matches existing median formula in server.js.
  const arr = [1, 2, 3, 4];
  assert.strictEqual(percentileSimple(arr, 0.50), 3);
  assert.strictEqual(percentileSimple(arr, 0.25), 2);  // floor(4*0.25)=1 → arr[1]=2
});

test('percentileSimple: p=1 clamps to last element', () => {
  assert.strictEqual(percentileSimple([1, 2, 3], 1.0), 3);
});

test('percentileSimple: p=0 returns first element', () => {
  assert.strictEqual(percentileSimple([1, 2, 3], 0.0), 1);
});

// ─── roundMaxBid (since 2026-06-11: pure value rounding, no *1.15) ───────────
test('roundMaxBid: null in → null out', () => {
  assert.strictEqual(roundMaxBid(null), null);
});

test('roundMaxBid: value < 100 rounds to nearest 1€', () => {
  assert.strictEqual(roundMaxBid(57.4), 57);
  assert.strictEqual(roundMaxBid(57.6), 58);
  assert.strictEqual(roundMaxBid(80), 80);
  assert.strictEqual(roundMaxBid(99), 99);
  assert.strictEqual(roundMaxBid(99.4), 99);
});

test('roundMaxBid: value exactly 100 rounds to 5€ step', () => {
  assert.strictEqual(roundMaxBid(100), 100);
});

test('roundMaxBid: value 99.6 still under 100 → nearest 1€', () => {
  // Edge: target < 100 → step 1. Math.round(99.6) = 100 (note: yields 100 even though target was <100)
  assert.strictEqual(roundMaxBid(99.6), 100);
});

test('roundMaxBid: value 148 → nearest 5€ = 150', () => {
  assert.strictEqual(roundMaxBid(148), 150);
});

test('roundMaxBid: value 122 → nearest 5€ = 120', () => {
  // (122 = 5*24 + 2 → nearest 5 below)
  assert.strictEqual(roundMaxBid(122), 120);
});

test('roundMaxBid: value 122.5 → nearest 5€ = 125 (.5 rounds up in JS)', () => {
  assert.strictEqual(roundMaxBid(122.5), 125);
});

test('roundMaxBid: value 200 → 200', () => {
  assert.strictEqual(roundMaxBid(200), 200);
});

// ─── computeBidRange ─────────────────────────────────────────────────────────
test('computeBidRange: n=0 returns shape with nulls + confidence=low + p75 null', () => {
  const r = computeBidRange([], [], 30);
  assert.deepStrictEqual(r, {
    n: 0, p25: null, median: null, p75: null, max_bid: null,
    window_days: 30, markets: [], confidence: 'low',
  });
});

test('computeBidRange: n=1 returns single-value across percentiles (max_bid = p75 = value)', () => {
  const r = computeBidRange([42], [{ country: 'FR' }], 30);
  assert.strictEqual(r.n, 1);
  assert.strictEqual(r.p25, 42);
  assert.strictEqual(r.median, 42);
  assert.strictEqual(r.p75, 42);
  assert.strictEqual(r.max_bid, 42); // p75 = 42 → step 1 → 42
  assert.deepStrictEqual(r.markets, ['FR']);
  assert.strictEqual(r.confidence, 'low');
});

test('computeBidRange: n=4 has confidence=low + p75 matches percentileSimple', () => {
  // floor(4*0.75) = 3 → arr[3] = 4
  const r = computeBidRange([1, 2, 3, 4], [], 30);
  assert.strictEqual(r.n, 4);
  assert.strictEqual(r.p75, 4);
  assert.strictEqual(r.confidence, 'low');
});

test('computeBidRange: n=5 has confidence=ok + p75 = arr[3] (floor(5*0.75))', () => {
  const r = computeBidRange([1, 2, 3, 4, 5], [], 30);
  assert.strictEqual(r.n, 5);
  assert.strictEqual(r.p75, 4);
  assert.strictEqual(r.confidence, 'ok');
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

test('computeBidRange: max_bid is p75 (rounded), NOT median*1.15', () => {
  // 8-element array — p75 index = floor(8*0.75) = 6 → arr[6] = 100
  // median index = floor(8/2) = 4 → arr[4] = 50
  const prices = [10, 20, 30, 40, 50, 60, 100, 200];
  const r = computeBidRange(prices, [], 30);
  assert.strictEqual(r.median, 50);
  assert.strictEqual(r.p75, 100);
  assert.strictEqual(r.max_bid, 100); // round(100 to nearest 5) = 100
});

// ─── Regression fixture: median computed in bid_range matches the historic
// formula used to set market_price_usd. Proves the new code path is byte-
// identical on the existing field for the same input. ─────────────────────────
test('regression: bid_range.median == Math.round(prices[floor(n/2)] * 100) / 100', () => {
  // Synthetic clean prices (post-outlier removal) — odd length covers median picker
  const cleanedPrices = [3.30, 4.01, 4.52, 5.12, 5.62, 5.72, 7.00, 17.51, 17.60];
  const expectedHistoricMedian =
    Math.round(cleanedPrices[Math.floor(cleanedPrices.length / 2)] * 100) / 100; // = 5.62
  const r = computeBidRange(cleanedPrices, [], 30);
  assert.strictEqual(r.median, expectedHistoricMedian);
});

// ─── Regression fixture: mixed-currency input proves GBP now contributes
// correct value to the median. Demonstrates before/after on the same comp set. ─
test('regression: GBP comps now produce the correct median (was: GBP silently treated as EUR)', () => {
  const rawItems = [
    { price: '10.00', currency: 'EUR' },   // 10
    { price: '10.00', currency: 'EUR' },   // 10
    { price: '100.00', currency: 'GBP' },  // before: 100 (wrong) | after: 117
    { price: '100.00', currency: 'GBP' },  // before: 100 (wrong) | after: 117
    { price: '100.00', currency: 'GBP' },  // before: 100 (wrong) | after: 117
  ];
  const converted = rawItems
    .map(i => toEur(parseFloat(i.price), i.currency))
    .filter(v => v != null)
    .sort((a, b) => a - b);
  // After: [10, 10, 117, 117, 117], median = converted[2] = 117
  assert.strictEqual(converted.length, 5);
  assert.strictEqual(converted[Math.floor(5 / 2)], 117);

  const r = computeBidRange(converted, [
    { country: 'FR' }, { country: 'FR' }, { country: 'GB' }, { country: 'GB' }, { country: 'GB' },
  ], 30);
  assert.strictEqual(r.median, 117);
  assert.strictEqual(r.n, 5);
  assert.strictEqual(r.confidence, 'ok');
});

test('regression: unknown currency is dropped from stats (does not skew median)', () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const rawItems = [
      { price: '10', currency: 'EUR' },
      { price: '10', currency: 'EUR' },
      { price: '999', currency: 'CAD' }, // dropped
    ];
    const converted = rawItems
      .map(i => toEur(parseFloat(i.price), i.currency))
      .filter(v => v != null);
    assert.strictEqual(converted.length, 2);
  } finally {
    console.warn = origWarn;
  }
});
