'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findStyleCodes } = require('../sneaker-id');

test('findStyleCodes: Nike modern code', () => {
  assert.deepStrictEqual(findStyleCodes('Nike Air Pegasus 2K5 Pearl Pink IB8873-666'), ['IB8873-666']);
});

test('findStyleCodes: Nike legacy code', () => {
  assert.deepStrictEqual(findStyleCodes('Air Jordan 1 Chicago 555088-101'), ['555088-101']);
});

test('findStyleCodes: New Balance code', () => {
  assert.deepStrictEqual(findStyleCodes("New Balance 9060 'Blue Haze' U9060FNB"), ['U9060FNB']);
});

test('findStyleCodes: adidas code', () => {
  assert.deepStrictEqual(findStyleCodes('adidas Samba OG Maroon ID0477'), ['ID0477']);
});

test('findStyleCodes: does NOT mistake a Nike prefix for an adidas code', () => {
  // "IB8873" is the prefix of "IB8873-666" — must not also be returned as an adidas code
  assert.deepStrictEqual(findStyleCodes('IB8873-666'), ['IB8873-666']);
});

test('findStyleCodes: no code returns empty array', () => {
  assert.deepStrictEqual(findStyleCodes('Nike running shoes'), []);
});

test('findStyleCodes: handles null/undefined', () => {
  assert.deepStrictEqual(findStyleCodes(null), []);
  assert.deepStrictEqual(findStyleCodes(undefined), []);
});

const { extractStyleCode } = require('../sneaker-id');
const pegasus = require('./fixtures/pegasus.json');
const jordan = require('./fixtures/jordan-1-low.json');
const nb9060 = require('./fixtures/nb-9060.json');
const samba = require('./fixtures/samba-og.json');

test('extractStyleCode: Pegasus fixture → correct SKU', () => {
  assert.strictEqual(extractStyleCode(pegasus.visualMatches).styleCode, 'IB8873-666');
});

test('extractStyleCode: Jordan 1 Low fixture → correct SKU (position-weighting beats lookalikes)', () => {
  // Flat voting picks the wrong "DD9315" Golf colorway; position-weighting must pick IQ9381-100.
  assert.strictEqual(extractStyleCode(jordan.visualMatches).styleCode, 'IQ9381-100');
});

test('extractStyleCode: New Balance 9060 fixture → correct SKU', () => {
  assert.strictEqual(extractStyleCode(nb9060.visualMatches).styleCode, 'U9060FNB');
});

test('extractStyleCode: Samba OG fixture → correct SKU', () => {
  assert.strictEqual(extractStyleCode(samba.visualMatches).styleCode, 'ID0477');
});

test('extractStyleCode: empty input → null', () => {
  assert.deepStrictEqual(extractStyleCode([]), { styleCode: null, score: 0 });
});

const { extractBrand, buildIdentity } = require('../sneaker-id');

test('extractBrand: Pegasus → Nike', () => {
  assert.strictEqual(extractBrand(pegasus.visualMatches), 'Nike');
});

test('extractBrand: Jordan 1 Low → Jordan (beats Nike mentions)', () => {
  assert.strictEqual(extractBrand(jordan.visualMatches), 'Jordan');
});

test('extractBrand: New Balance 9060 → New Balance', () => {
  assert.strictEqual(extractBrand(nb9060.visualMatches), 'New Balance');
});

test('buildIdentity: all 4 fixtures are confident with correct style codes', () => {
  for (const fx of [pegasus, jordan, nb9060, samba]) {
    const id = buildIdentity(fx.visualMatches);
    assert.strictEqual(id.styleCode, fx.expectedSku, `${fx.slug} styleCode`);
    assert.strictEqual(id.confident, true, `${fx.slug} confident`);
    assert.ok(id.referenceTitle && id.referenceTitle.toUpperCase().includes(fx.expectedSku),
      `${fx.slug} referenceTitle contains the SKU`);
    assert.ok(id.brand, `${fx.slug} has a brand`);
  }
});

test('buildIdentity: no matches → not confident', () => {
  const id = buildIdentity([]);
  assert.strictEqual(id.confident, false);
  assert.strictEqual(id.styleCode, null);
});

test('buildIdentity: matches with no style code → not confident', () => {
  const id = buildIdentity([{ title: 'Nike running shoes', source: 'Nike' }]);
  assert.strictEqual(id.confident, false);
});

const { buildShoppingQuery, filterBySku, medianOf } = require('../sneaker-id');

test('buildShoppingQuery: flattens retailer chrome, keeps brand/model/sku', () => {
  const q = buildShoppingQuery({
    styleCode: 'IB8873-666',
    referenceTitle: 'Nike Air Pegasus 2K5 Pearl Pink | IB8873-666 | The Sole Supplier',
  });
  assert.ok(q.includes('Nike'));
  assert.ok(q.includes('Air Pegasus 2K5'));
  assert.ok(q.includes('IB8873-666'));
  assert.ok(!q.includes('|'));
});

test('buildShoppingQuery: appends style code if reference title lacks it', () => {
  const q = buildShoppingQuery({ styleCode: 'ID0477', referenceTitle: 'adidas Samba OG Maroon' });
  assert.ok(q.includes('ID0477'));
});

test('filterBySku: keeps only titles containing the code, dash/space/case-insensitive', () => {
  const cards = [
    { title: 'Nike Air Pegasus 2K5 IB8873-666', price: 130 },
    { title: 'nike air pegasus 2k5 ib8873 666', price: 120 },
    { title: 'Nike Structure 26', price: 145 },
  ];
  const out = filterBySku(cards, 'IB8873-666');
  assert.strictEqual(out.length, 2);
});

test('filterBySku: null style code → empty array', () => {
  assert.deepStrictEqual(filterBySku([{ title: 'x', price: 1 }], null), []);
});

test('medianOf: returns the middle price, ignoring null/zero prices', () => {
  const cards = [{ price: 100 }, { price: 200 }, { price: 150 }, { price: null }, { price: 0 }];
  assert.strictEqual(medianOf(cards), 150);
});

test('medianOf: no valid prices → null', () => {
  assert.strictEqual(medianOf([{ price: null }, {}]), null);
});

// ─── Clean-reference + hardened query stripping ─────────────────────────────

test('buildIdentity: prefers non-marketplace source for referenceTitle', () => {
  const matches = [
    { title: 'Nike Air Pegasus 2K5 IB8873-666 Size 12 - Amazon.com', source: 'Amazon.com' },
    { title: 'Nike Air Pegasus 2K5 IB8873-666', source: 'Amazon.com' },
    { title: 'Nike Air Pegasus 2K5 IB8873-666 Mens', source: 'Amazon.com' },
    { title: 'Nike Air Pegasus 2K5 Pearl Pink IB8873-666 Laced', source: 'Laced' },
    { title: 'Pegasus 2K5 IB8873-666 ebay listing', source: 'eBay - seller42' },
  ];
  const id = buildIdentity(matches);
  assert.strictEqual(id.styleCode, 'IB8873-666');
  assert.ok(!/amazon|ebay/i.test(id.referenceTitle),
    `expected non-marketplace reference, got: ${id.referenceTitle}`);
});

test('buildIdentity: falls back to marketplace title when no clean source available', () => {
  const matches = Array(5).fill(null).map(() => ({
    title: 'Yeezy 700 V2 Static EF2829 - Size 12 - Amazon.com',
    source: 'Amazon.com',
  }));
  const id = buildIdentity(matches);
  assert.strictEqual(id.styleCode, 'EF2829');
  assert.ok(id.referenceTitle, 'should still pick a reference even from a marketplace');
});

test('buildShoppingQuery: strips size patterns', () => {
  const q = buildShoppingQuery({
    styleCode: 'EF2829',
    referenceTitle: 'adidas Mens Yeezy Boost 700 V2 EF2829 Static - Size 12 Road Running - Amazon.com',
  });
  assert.ok(!/\bsize\s*12\b/i.test(q), `Size 12 not stripped: ${q}`);
  assert.ok(!/\bmens\b/i.test(q),     `Mens not stripped: ${q}`);
  assert.ok(!/\bamazon/i.test(q),     `Amazon not stripped: ${q}`);
  assert.ok(q.includes('EF2829'));
  assert.ok(q.includes('Yeezy'));
});

test('buildShoppingQuery: strips "for Sale in <city>, <state>"', () => {
  const q = buildShoppingQuery({
    styleCode: 'CQ9447-700',
    referenceTitle: 'Nike Jordan 1 Low I Gold Toe CQ9447-700 Size 10.5 for Sale in Crown Point, IN - OfferUp',
  });
  assert.ok(!/for\s+sale\s+in/i.test(q), `"for sale in" not stripped: ${q}`);
  assert.ok(!/Crown Point/i.test(q),     `location not stripped: ${q}`);
  assert.ok(!/offerup/i.test(q),         `OfferUp not stripped: ${q}`);
  assert.ok(!/\bsize\s*10\.5\b/i.test(q), `Size 10.5 not stripped: ${q}`);
  assert.ok(q.includes('CQ9447-700'));
  assert.ok(q.includes('Gold Toe'));
});

test('buildShoppingQuery: strips GS / kids size markers', () => {
  const q = buildShoppingQuery({
    styleCode: 'CU1486-800',
    referenceTitle: 'Nike Zoom Freak 1 GS WHAT THE 5Y Basketball Shoes CU1486-800 eBay',
  });
  assert.ok(!/\bGS\b/.test(q),    `GS not stripped: ${q}`);
  assert.ok(!/\b5Y\b/i.test(q),   `5Y not stripped: ${q}`);
  assert.ok(!/\bebay\b/i.test(q), `eBay not stripped: ${q}`);
  assert.ok(q.includes('Zoom Freak 1'));
  assert.ok(q.includes('CU1486-800'));
});

test('findStyleCodes: captures full code when space-separated, not just the prefix', () => {
  // "CQ9447 700" with space (not dash) — must be captured as the full code,
  // not collapsed to "CQ9447" by the adidas pattern.
  const result = findStyleCodes('Air Jordan 1 Low Gold Toe CQ9447 700');
  assert.ok(result.includes('CQ9447 700'), `expected "CQ9447 700", got: ${result.join(',')}`);
  assert.ok(!result.includes('CQ9447'),    `should not also include the bare prefix`);
});

test('buildShoppingQuery: keeps year markers like 2021', () => {
  const q = buildShoppingQuery({
    styleCode: 'CT4838-011',
    referenceTitle: '2021 Nike Air Jordan 5 V Retro Oreo Moonlight Black White SZ 14 (CT4838-011) eBay',
  });
  assert.ok(q.includes('2021'),        `2021 should be kept: ${q}`);
  assert.ok(!/\bsz\s*14\b/i.test(q),  `SZ 14 not stripped: ${q}`);
  assert.ok(!/\bebay\b/i.test(q),     `eBay not stripped: ${q}`);
  assert.ok(q.includes('CT4838-011'));
});
