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

// ─── fetchGradedPrices ──────────────────────────────────────────────────────
const { fetchGradedPrices, GRADES } = require('../graded-prices');

// A fake fetchEbayBrowse: returns a different sales count per grade, keyed off
// the grade string present in card.ebay_search. Records the queries it saw.
function makeFakeBrowse(byGrade, seen) {
  return async (card, _token, _lang) => {
    if (seen) seen.push(card.ebay_search);
    if (card.ebay_search.includes('PSA 10')) return byGrade.psa10;
    if (card.ebay_search.includes('PSA 9'))  return byGrade.psa9;
    return null;
  };
}
const okToken = async () => 'fake-token';

test('fetchGradedPrices: returns psa10 + psa9 medians from the browse fn', async () => {
  const browse = makeFakeBrowse({
    psa10: { market_price_usd: 120, ebay_sales_count: 8 },
    psa9:  { market_price_usd: 45,  ebay_sales_count: 12 },
  });
  const out = await fetchGradedPrices({
    cardName: 'Dracaufeu', cardNumber: '223/197', language: 'FR',
    getToken: okToken, browse,
  });
  assert.deepStrictEqual(out, {
    psa10: { median: 120, count: 8,  currency: 'EUR' },
    psa9:  { median: 45,  count: 12, currency: 'EUR' },
  });
});

test('fetchGradedPrices: runs one query per grade with the grade in the query', async () => {
  const seen = [];
  const browse = makeFakeBrowse({ psa10: null, psa9: null }, seen);
  await fetchGradedPrices({ cardName: 'Pikachu', cardNumber: '58/102', getToken: okToken, browse });
  assert.deepStrictEqual(seen.sort(), ['Pikachu 58/102 PSA 10', 'Pikachu 58/102 PSA 9']);
});

test('fetchGradedPrices: a browse throw for one grade nulls that grade only', async () => {
  const browse = async (card) => {
    if (card.ebay_search.includes('PSA 10')) throw new Error('Browse: 0 results');
    return { market_price_usd: 45, ebay_sales_count: 12 };
  };
  const out = await fetchGradedPrices({ cardName: 'Pikachu', cardNumber: '58/102', getToken: okToken, browse });
  assert.strictEqual(out.psa10.median, null);
  assert.strictEqual(out.psa9.median, 45);
});

test('fetchGradedPrices: a token failure nulls all grades without throwing', async () => {
  const browse = makeFakeBrowse({ psa10: { market_price_usd: 120, ebay_sales_count: 8 }, psa9: null });
  const out = await fetchGradedPrices({
    cardName: 'Pikachu', cardNumber: '58/102',
    getToken: async () => { throw new Error('oauth down'); }, browse,
  });
  assert.deepStrictEqual(out, {
    psa10: { median: null, count: 0, currency: 'EUR' },
    psa9:  { median: null, count: 0, currency: 'EUR' },
  });
});

test('GRADES: v1 targets PSA 10 and PSA 9', () => {
  assert.deepStrictEqual(GRADES, [
    { key: 'psa10', company: 'PSA', grade: '10' },
    { key: 'psa9',  company: 'PSA', grade: '9'  },
  ]);
});
