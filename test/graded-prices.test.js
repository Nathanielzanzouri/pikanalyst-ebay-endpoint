'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildGradedCard, formatGradedResult } = require('../graded-prices');

// ─── buildGradedCard ────────────────────────────────────────────────────────
test('buildGradedCard: ebay_search combines name + number + grade', () => {
  const card = buildGradedCard('Dracaufeu', '223/197', 'PSA', '10');
  assert.strictEqual(card.ebay_search, 'Dracaufeu 223/197 PSA 10');
});

test('buildGradedCard: sets a strict _gradeFilter for the title filter', () => {
  const card = buildGradedCard('Pikachu', '58/102', 'PSA', '9');
  assert.deepStrictEqual(card._gradeFilter, { company: 'PSA', grade: '9', pokemonName: 'Pikachu' });
});

test('buildGradedCard: omits an empty card number cleanly (no double space)', () => {
  const card = buildGradedCard('Mewtwo', '', 'PSA', '10');
  assert.strictEqual(card.ebay_search, 'Mewtwo PSA 10');
});

// ─── formatGradedResult ─────────────────────────────────────────────────────
test('formatGradedResult: returns median + count when count >= threshold', () => {
  const r = formatGradedResult({ market_price_usd: 120, ebay_sales_count: 8 }, 2);
  assert.deepStrictEqual(r, { median: 120, count: 8, currency: 'EUR' });
});

test('formatGradedResult: nulls the median when count is below threshold', () => {
  const r = formatGradedResult({ market_price_usd: 120, ebay_sales_count: 1 }, 2);
  assert.deepStrictEqual(r, { median: null, count: 1, currency: 'EUR' });
});

test('formatGradedResult: handles a null browse result (no sales)', () => {
  const r = formatGradedResult(null, 2);
  assert.deepStrictEqual(r, { median: null, count: 0, currency: 'EUR' });
});
