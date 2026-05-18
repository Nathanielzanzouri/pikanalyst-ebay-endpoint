'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  splitIntoClusters,
  labelCluster,
  clusterListings,
} = require('../variant-clusters');

// ─── splitIntoClusters ───────────────────────────────────────────────────────
test('splitIntoClusters: prices all within 5× → single cluster', () => {
  const listings = [{ price: 1 }, { price: 2 }, { price: 2.5 }, { price: 4 }];
  const c = splitIntoClusters(listings);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].length, 4);
});

test('splitIntoClusters: big gap → two clusters', () => {
  const listings = [{ price: 2 }, { price: 3 }, { price: 100 }, { price: 150 }];
  const c = splitIntoClusters(listings);
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[0].length, 2);
  assert.strictEqual(c[1].length, 2);
});

test('splitIntoClusters: real Luffy ST10-006 case (4 variants)', () => {
  // Base ~€1-5, Anniversary ~€4-10, Parallel ~€9, ONE PIECE DAY ~€140-340
  const listings = [
    { price: 1.52 },  { price: 4.59 }, { price: 4.59 }, { price: 5.47 },
    { price: 9.19 },
    { price: 143.30 }, { price: 240.12 }, { price: 243.80 }, { price: 259.43 }, { price: 340.32 },
  ];
  const c = splitIntoClusters(listings);
  // Expect 2 clusters: cheap (1-9) and expensive (143-340).
  // 5.47 → 9.19 = 1.68× (under threshold, same cluster)
  // 9.19 → 143.30 = 15.6× (over 3× threshold, split)
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[0].length, 5);
  assert.strictEqual(c[1].length, 5);
});

test('splitIntoClusters: empty input → empty', () => {
  assert.deepStrictEqual(splitIntoClusters([]),    []);
  assert.deepStrictEqual(splitIntoClusters(null),  []);
});

test('splitIntoClusters: ignores zero / null prices', () => {
  const listings = [{ price: 0 }, { price: null }, { price: 5 }, { price: 6 }];
  const c = splitIntoClusters(listings);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].length, 2);
});

// ─── labelCluster ────────────────────────────────────────────────────────────
test('labelCluster: majority of titles say Championship → "Championship"', () => {
  const cluster = [
    { title: 'Zoro OP05-067 CS 25-26 Championship Foil' },
    { title: 'Zoro Championship 25-26 Event Pack' },
    { title: 'Zoro Event Pack Vol 5' }, // doesn't match Championship
  ];
  assert.strictEqual(labelCluster(cluster), 'Championship');
});

test('labelCluster: "Finalist" wins over "Championship" (more specific)', () => {
  const cluster = [
    { title: 'Zoro OP05-067 Finalist Ver Championship' },
    { title: 'Zoro Finalist Championship Edition' },
  ];
  assert.strictEqual(labelCluster(cluster), 'Finalist');
});

test('labelCluster: Manga Rare not eaten by plain Rare', () => {
  const cluster = [
    { title: 'Yamato OP06-118 Manga Rare' },
    { title: 'Yamato Manga Rare panel' },
  ];
  assert.strictEqual(labelCluster(cluster), 'Manga Rare');
});

test('labelCluster: weak match (less than half cluster) → null', () => {
  const cluster = [
    { title: 'Luffy ST10-006 Promo' },
    { title: 'Luffy ST10-006 base' },
    { title: 'Luffy ST10-006 standard' },
    { title: 'Luffy ST10-006' },
  ];
  // Only 1/4 says "Promo" — under half, no label
  assert.strictEqual(labelCluster(cluster), null);
});

test('labelCluster: PSA grades labelable for graded-card clusters', () => {
  const cluster = [
    { title: 'Charizard Base Set PSA 10' },
    { title: 'Charizard 4/102 PSA 10 GEM MINT' },
  ];
  assert.strictEqual(labelCluster(cluster), 'PSA 10');
});

// ─── clusterListings (integration) ───────────────────────────────────────────
test('clusterListings: single tight cluster → returns [] (no picker)', () => {
  const listings = [
    { price: 4.59, title: 'Luffy base', imageUrl: 'a.jpg' },
    { price: 5.47, title: 'Luffy base NM', imageUrl: 'b.jpg' },
    { price: 6.21, title: 'Luffy', imageUrl: 'c.jpg' },
  ];
  assert.deepStrictEqual(clusterListings(listings), []);
});

test('clusterListings: Luffy ST10-006 split into Base + Promo', () => {
  const listings = [
    { price: 1.52, title: 'Luffy ST10-006 Super Rare Three Captains', imageUrl: 'b1.jpg' },
    { price: 4.59, title: 'Luffy ST10-006 3rd Anniversary Treasure Campaign', imageUrl: 'b2.jpg' },
    { price: 4.59, title: 'Luffy ST10-006 NM', imageUrl: 'b3.jpg' },
    { price: 5.47, title: 'Luffy ST10-006 Three Captains JP', imageUrl: 'b4.jpg' },
    { price: 143.30, title: 'Luffy ST10-006 SR Promo ONE PIECE DAY 24', imageUrl: 'p1.jpg' },
    { price: 240.12, title: 'Luffy ST10-006 One Piece Day Promo', imageUrl: 'p2.jpg' },
    { price: 243.80, title: 'Luffy ST10-006 ONE PIECE DAY 2024 Promo', imageUrl: 'p3.jpg' },
  ];
  const variants = clusterListings(listings);
  assert.strictEqual(variants.length, 2, 'expected 2 clusters');
  // Cheap cluster first
  assert.ok(variants[0].price < 10, 'first cluster should be cheap');
  assert.strictEqual(variants[0].count, 4);
  // Expensive cluster second
  assert.ok(variants[1].price > 100, 'second cluster should be expensive');
  assert.strictEqual(variants[1].count, 3);
  assert.strictEqual(variants[1].label, 'OP Day Promo');
});

test('clusterListings: single listing in a price tier → dropped (under minSize)', () => {
  const listings = [
    { price: 5, title: 'Luffy base' },  { price: 6, title: 'Luffy base' },
    { price: 100, title: 'Luffy alone' },  // single listing in its tier
  ];
  const variants = clusterListings(listings);
  // The singleton cluster (price 100) is dropped → only one valid cluster → no picker
  assert.deepStrictEqual(variants, []);
});

test('clusterListings: variants sorted ascending by price', () => {
  const listings = [
    { price: 200, title: 'A promo' }, { price: 210, title: 'B promo' },
    { price: 3, title: 'C base' },    { price: 4, title: 'D base' },
  ];
  const variants = clusterListings(listings);
  assert.strictEqual(variants[0].price < variants[1].price, true);
});

test('clusterListings: min/max/median fields present', () => {
  const listings = [
    { price: 2, title: 'X', imageUrl: 'x.jpg' },
    { price: 4, title: 'X', imageUrl: 'x.jpg' },
    { price: 100, title: 'Y promo', imageUrl: 'y.jpg' },
    { price: 110, title: 'Y promo', imageUrl: 'y.jpg' },
  ];
  const variants = clusterListings(listings);
  assert.strictEqual(variants[0].priceMin, 2);
  assert.strictEqual(variants[0].priceMax, 4);
  assert.strictEqual(variants[0].price, 3);  // median of [2, 4]
  assert.strictEqual(variants[0].imageUrl, 'x.jpg');
});
