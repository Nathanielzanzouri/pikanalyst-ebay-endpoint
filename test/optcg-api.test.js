'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  extractVariantDescriptor,
  extractCharacterName,
  formatCharacterForQuery,
  normalizeApiRecord,
  descriptorMatchTerms,
  bucketListingsByVariant,
} = require('../optcg-api');

// ─── extractCharacterName ────────────────────────────────────────────────────
test('extractCharacterName: strips all parens including card number', () => {
  assert.strictEqual(extractCharacterName('Monkey.D.Luffy (118) (Alternate Art)'), 'Monkey.D.Luffy');
});
test('extractCharacterName: name with no parens stays as-is', () => {
  assert.strictEqual(extractCharacterName('Monkey.D.Garp'), 'Monkey.D.Garp');
});
test('extractCharacterName: null-safe', () => {
  assert.strictEqual(extractCharacterName(null), null);
  assert.strictEqual(extractCharacterName(''),   null);
});

// ─── formatCharacterForQuery ────────────────────────────────────────────────
test('formatCharacterForQuery: dots → spaces for eBay-friendly search', () => {
  assert.strictEqual(formatCharacterForQuery('Monkey.D.Luffy (118)'), 'Monkey D Luffy');
});
test('formatCharacterForQuery: handles "D." → "D" middle initial', () => {
  assert.strictEqual(formatCharacterForQuery('Monkey.D.Garp (Alternate Art)'), 'Monkey D Garp');
});

// ─── extractVariantDescriptor ────────────────────────────────────────────────
test('extractVariantDescriptor: base card with number-in-parens → null', () => {
  assert.strictEqual(extractVariantDescriptor('Monkey.D.Luffy (118)'), null);
});

test('extractVariantDescriptor: bare name with no parens → null', () => {
  assert.strictEqual(extractVariantDescriptor('Monkey.D.Garp'), null);
});

test('extractVariantDescriptor: single-parens non-numeric IS a descriptor (real Garp case)', () => {
  // API returned this exact format for OP12-056 Garp — single parens with the
  // descriptor, no card number echo. Previously misclassified as base.
  assert.strictEqual(extractVariantDescriptor('Monkey.D.Garp (Alternate Art)'), 'Alternate Art');
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

// ─── splitPromoFromBase (synthetic 25th-Anniv / Promo variant) ───────────────
test('bucketListingsByVariant: splits 25th Anniv promos out of Base into a synthetic tile', () => {
  // Mirrors the real-world OP01-001 Zoro case: API only knows Base + Parallel,
  // but eBay has multiple 25th Anniversary Promo listings stamped with the
  // gameplay number. The synthetic split should rescue them into their own
  // picker tile so the user has something to tap that matches their card.
  const apiVariants = [
    { card_name: 'Roronoa Zoro (001)',            variant_descriptor: null,       card_image: 'base.jpg', market_price_usd: 3.44 },
    { card_name: 'Roronoa Zoro (001) (Parallel)', variant_descriptor: 'Parallel', card_image: 'par.jpg',  market_price_usd: 556.77 },
  ];
  const ebayListings = [
    { title: 'Carte One Piece OP01-001 L NM',                                                    price: 2.41, imageUrl: 'l1.jpg' },
    { title: 'Roronoa Zoro OP01-001 Leader Romance Dawn',                                        price: 3.10, imageUrl: 'l2.jpg' },
    { title: 'Roronoa Zoro OP01-001 (Promo) Leader 25th Anniversary Edition ONE PIECE Card NM', price: 21.38, imageUrl: 'l3.jpg' },
    { title: 'Carte One Piece Promo OP01-001 Zoro Manga 25th',                                   price: 19.00, imageUrl: 'l4.jpg' },
    { title: 'One Piece Card Game OP01-001 Promo Zoro',                                          price: 5.50, imageUrl: 'l5.jpg' },
    { title: 'Roronoa Zoro [PAR] Parallel OP01-001',                                             price: 149.95, imageUrl: 'l6.jpg' },
  ];
  const buckets = bucketListingsByVariant(ebayListings, apiVariants);
  // Expect 3 buckets now: Base, synthetic Promo, Parallel
  assert.strictEqual(buckets.length, 3, 'expected 3 buckets after promo split, got ' + buckets.length);
  const synth = buckets.find(b => b._synthetic);
  assert.ok(synth, 'expected a synthetic promo bucket');
  assert.ok(/Promo|Anniv/.test(synth.label), 'synthetic label should mention Promo/Anniv: ' + synth.label);
  assert.strictEqual(synth.label, 'Promo / 25th Anniv', 'should detect 25th Anniv specifically');
  assert.strictEqual(synth.count, 3, 'all 3 promo listings should be in the synthetic bucket');
  assert.strictEqual(synth.tcg_ref_usd, null, 'synthetic variant has no API TCG ref');
  assert.ok(synth.imageUrl, 'should use first promo listing imageUrl as thumb');
  // Base bucket should now only contain the 2 true-base listings
  const base = buckets.find(b => b.label === 'Base');
  assert.strictEqual(base.count, 2, 'Base should have shed its promos');
  // Parallel untouched
  const par = buckets.find(b => b.label === 'Parallel');
  assert.strictEqual(par.count, 1);
});

test('bucketListingsByVariant: does NOT split when only 1 promo listing exists (below threshold)', () => {
  const apiVariants = [
    { card_name: 'Zoro', variant_descriptor: null, card_image: 'base.jpg', market_price_usd: 3 },
  ];
  const buckets = bucketListingsByVariant([
    { title: 'Base Zoro OP01-001', price: 3 },
    { title: 'Base Zoro OP01-001 NM', price: 3.2 },
    { title: 'Zoro OP01-001 promo 25th anniversary', price: 20 },  // only 1 promo
  ], apiVariants);
  assert.strictEqual(buckets.length, 1, 'should not split with only 1 promo listing');
  assert.strictEqual(buckets[0].count, 3);
});

test('bucketListingsByVariant: does NOT split when ALL base listings are promos (would empty Base)', () => {
  // Edge case: if the only listings in Base are promo-labeled, trust the API's
  // base price rather than emptying Base into a synthetic tile.
  const apiVariants = [
    { card_name: 'Zoro', variant_descriptor: null, card_image: 'base.jpg', market_price_usd: 3 },
  ];
  const buckets = bucketListingsByVariant([
    { title: 'Promo Zoro OP01-001 25th anniversary', price: 20 },
    { title: 'Promo Zoro OP01-001 event pack',       price: 22 },
  ], apiVariants);
  assert.strictEqual(buckets.length, 1, 'should not split when remaining base would be empty');
  assert.strictEqual(buckets[0].count, 2);
});

test('splitPromoFromBase: label falls back to plain "Promo" when 25th-anniv keywords absent', () => {
  const { splitPromoFromBase } = require('../optcg-api');
  const buckets = [
    { label: 'Base', listings: [
      { title: 'Base Zoro OP01-001', price: 3 },
      { title: 'Base Zoro OP01-001 NM', price: 3.2 },
      { title: 'Zoro OP01-001 promo event pack', price: 15 },
      { title: 'Zoro OP01-001 one piece day promotion', price: 18 },
    ]},
  ];
  const out = splitPromoFromBase(buckets);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].label, 'Promo');
});
