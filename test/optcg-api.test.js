'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  extractVariantDescriptor,
  normalizeApiRecord,
  descriptorMatchTerms,
  bucketListingsByVariant,
} = require('../optcg-api');

// ─── extractVariantDescriptor ────────────────────────────────────────────────
test('extractVariantDescriptor: base card → null', () => {
  assert.strictEqual(extractVariantDescriptor('Monkey.D.Luffy (118)'), null);
});

test('extractVariantDescriptor: Alternate Art', () => {
  assert.strictEqual(extractVariantDescriptor('Monkey.D.Luffy (118) (Alternate Art)'), 'Alternate Art');
});

test('extractVariantDescriptor: Manga', () => {
  assert.strictEqual(extractVariantDescriptor('Monkey.D.Luffy (118) (Manga)'), 'Manga');
});

test('extractVariantDescriptor: Parallel', () => {
  assert.strictEqual(extractVariantDescriptor('Roronoa Zoro (001) (Parallel)'), 'Parallel');
});

test('extractVariantDescriptor: empty/null safe', () => {
  assert.strictEqual(extractVariantDescriptor(null), null);
  assert.strictEqual(extractVariantDescriptor(''),    null);
});

// ─── normalizeApiRecord ──────────────────────────────────────────────────────
test('normalizeApiRecord: real API shape mapped correctly', () => {
  const raw = {
    inventory_price: 2.5,
    market_price: 4.73,
    card_name: 'Monkey.D.Luffy (118)',
    set_name: 'A Fist of Divine Speed',
    set_id: 'OP-11',
    rarity: 'SEC',
    card_set_id: 'OP11-118',
    card_color: 'Blue',
    card_type: 'Character',
    sub_types: 'Straw Hat Crew',
    card_image: 'https://optcgapi.com/media/static/Card_Images/OP11-118.jpg',
    date_scraped: '2026-05-18',
    card_image_id: 'OP11-118',
  };
  const out = normalizeApiRecord(raw);
  assert.strictEqual(out.card_name,           'Monkey.D.Luffy (118)');
  assert.strictEqual(out.rarity,              'SEC');
  assert.strictEqual(out.card_color,          'Blue');
  assert.strictEqual(out.market_price_usd,    4.73);
  assert.strictEqual(out.inventory_price_usd, 2.5);
  assert.strictEqual(out.card_image,          'https://optcgapi.com/media/static/Card_Images/OP11-118.jpg');
  assert.strictEqual(out.variant_descriptor,  null); // base
});

test('normalizeApiRecord: Alt Art variant gets descriptor', () => {
  const out = normalizeApiRecord({ card_name: 'Monkey.D.Luffy (118) (Alternate Art)', market_price: 19.28 });
  assert.strictEqual(out.variant_descriptor, 'Alternate Art');
  assert.strictEqual(out.market_price_usd,   19.28);
});

// ─── descriptorMatchTerms ────────────────────────────────────────────────────
test('descriptorMatchTerms: Alternate Art → matches "alt art" / "AA" patterns', () => {
  const terms = descriptorMatchTerms('Alternate Art');
  assert.ok(terms.includes('alt art'));
  assert.ok(terms.includes('alternate art'));
  assert.ok(terms.some(t => t.includes('aa')));
});

test('descriptorMatchTerms: Manga → matches comic too (sellers conflate)', () => {
  const terms = descriptorMatchTerms('Manga');
  assert.ok(terms.includes('manga'));
  assert.ok(terms.includes('comic'));
});

test('descriptorMatchTerms: null → empty (no matching, falls into base bucket)', () => {
  assert.deepStrictEqual(descriptorMatchTerms(null), []);
});

// ─── bucketListingsByVariant ─────────────────────────────────────────────────
test('bucketListingsByVariant: real Luffy 118 case', () => {
  const apiVariants = [
    { card_name: 'Monkey.D.Luffy (118)',                  variant_descriptor: null,             card_image: 'base.jpg',    market_price_usd: 4.73 },
    { card_name: 'Monkey.D.Luffy (118) (Alternate Art)',  variant_descriptor: 'Alternate Art',  card_image: 'aa.jpg',      market_price_usd: 19.28 },
    { card_name: 'Monkey.D.Luffy (118) (Manga)',          variant_descriptor: 'Manga',          card_image: 'manga.jpg',   market_price_usd: 1355.27 },
  ];
  const ebayListings = [
    { title: 'Monkey D Luffy OP11-118 SEC NM Japanese',                           price: 5.00 },
    { title: 'Monkey D Luffy OP11-118 SEC base card',                             price: 4.50 },
    { title: 'Monkey D Luffy OP11-118 SEC Alternate Art holo',                    price: 18.00 },
    { title: 'OP11-118 Luffy alt art Comic Parallel',                             price: 22.00 },  // alt-art via "alt art" keyword
    { title: 'Luffy OP11-118 Manga rare Comic version',                           price: 1400.00 }, // manga via "manga"
    { title: 'OP11-118 Comic Parallel SEC Luffy',                                 price: 1100.00 }, // catches via "comic" → manga or alt art? — first match wins
  ];
  const buckets = bucketListingsByVariant(ebayListings, apiVariants);
  assert.strictEqual(buckets.length, 3);
  // Base bucket should have the plain non-Alt-non-Manga listings
  assert.ok(buckets[0].count >= 2, 'expected base bucket to have plain listings, got ' + buckets[0].count);
  assert.strictEqual(buckets[0].label, 'Base');
  // Alt Art bucket should have at least 1 listing
  assert.ok(buckets[1].count >= 1, 'expected Alt Art bucket to have listings, got ' + buckets[1].count);
  assert.strictEqual(buckets[1].label, 'Alternate Art');
  // Manga bucket
  assert.strictEqual(buckets[2].label, 'Manga');
});

test('bucketListingsByVariant: no API variants → returns []', () => {
  assert.deepStrictEqual(bucketListingsByVariant([{ title: 'X', price: 5 }], []),   []);
  assert.deepStrictEqual(bucketListingsByVariant([{ title: 'X', price: 5 }], null), []);
});

test('bucketListingsByVariant: empty listings → buckets exist but all counts=0', () => {
  const apiVariants = [
    { card_name: 'X (001)', variant_descriptor: null, card_image: null, market_price_usd: 5 },
    { card_name: 'X (001) (Alt Art)', variant_descriptor: 'Alt Art', card_image: null, market_price_usd: 50 },
  ];
  const buckets = bucketListingsByVariant([], apiVariants);
  assert.strictEqual(buckets.length, 2);
  assert.strictEqual(buckets[0].count, 0);
  assert.strictEqual(buckets[1].count, 0);
  assert.strictEqual(buckets[0].price, null);
  assert.strictEqual(buckets[0].tcg_ref_usd, 5);   // TCG ref preserved when eBay empty
});

test('bucketListingsByVariant: imageUrl carries through from API', () => {
  const apiVariants = [
    { card_name: 'X', variant_descriptor: null, card_image: 'https://optcgapi.com/img/base.jpg', market_price_usd: 1 },
  ];
  const buckets = bucketListingsByVariant([], apiVariants);
  assert.strictEqual(buckets[0].imageUrl, 'https://optcgapi.com/img/base.jpg');
});
