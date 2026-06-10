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

// ─── roundMaxBid ─────────────────────────────────────────────────────────────
test('roundMaxBid: null in → null out', () => {
  assert.strictEqual(roundMaxBid(null), null);
});

test('roundMaxBid: median < ~87 (target < 100€) rounds to nearest 1€', () => {
  // 50 * 1.15 = 57.5 → step 1 → 58 (Math.round half-up in JS)
  assert.strictEqual(roundMaxBid(50), 58);
});

test('roundMaxBid: median giving target exactly 100 rounds to 5€ step', () => {
  // floor case: 87 * 1.15 = 100.05 → step 5 → round(100.05/5)*5 = 20*5 = 100
  assert.strictEqual(roundMaxBid(87), 100);
});

test('roundMaxBid: median 86 keeps step 1€ (target 98.9 < 100)', () => {
  // 86 * 1.15 = 98.9 → step 1 → round(98.9) = 99
  assert.strictEqual(roundMaxBid(86), 99);
});

test('roundMaxBid: median 100 → 115 (already 5€ aligned)', () => {
  assert.strictEqual(roundMaxBid(100), 115);
});

test('roundMaxBid: median 200 → 230 (5€ aligned)', () => {
  assert.strictEqual(roundMaxBid(200), 230);
});

test('roundMaxBid: median 99 with target 113.85 → nearest 5 = 115', () => {
  // 99 * 1.15 = 113.85 → step 5 → round(113.85/5)*5 = round(22.77)*5 = 23*5 = 115
  assert.strictEqual(roundMaxBid(99), 115);
});

// ─── computeBidRange ─────────────────────────────────────────────────────────
test('computeBidRange: n=0 returns shape with nulls + confidence=low', () => {
  const r = computeBidRange([], [], 30);
  assert.deepStrictEqual(r, {
    n: 0, p25: null, median: null, max_bid: null,
    window_days: 30, markets: [], confidence: 'low',
  });
});

test('computeBidRange: n=1 returns single-value across percentiles', () => {
  const r = computeBidRange([42], [{ country: 'FR' }], 30);
  assert.strictEqual(r.n, 1);
  assert.strictEqual(r.p25, 42);
  assert.strictEqual(r.median, 42);
  assert.strictEqual(r.max_bid, 48); // 42*1.15 = 48.3 → step 1 → 48
  assert.deepStrictEqual(r.markets, ['FR']);
  assert.strictEqual(r.confidence, 'low');
});

test('computeBidRange: n=4 has confidence=low', () => {
  const r = computeBidRange([1, 2, 3, 4], [], 30);
  assert.strictEqual(r.n, 4);
  assert.strictEqual(r.confidence, 'low');
});

test('computeBidRange: n=5 has confidence=ok', () => {
  const r = computeBidRange([1, 2, 3, 4, 5], [], 30);
  assert.strictEqual(r.n, 5);
  assert.strictEqual(r.confidence, 'ok');
});

test('computeBidRange: markets deduped from listings', () => {
  const listings = [
    { country: 'FR' }, { country: 'FR' }, { country: 'GB' },
    { country: 'US' }, { country: null }, { country: 'GB' },
  ];
  const r = computeBidRange([10, 20, 30], listings, 90);
  // order depends on iteration; assert as Set
  assert.deepStrictEqual(new Set(r.markets), new Set(['FR', 'GB', 'US']));
});

test('computeBidRange: window_days passed through', () => {
  const r = computeBidRange([10], [], 90);
  assert.strictEqual(r.window_days, 90);
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
