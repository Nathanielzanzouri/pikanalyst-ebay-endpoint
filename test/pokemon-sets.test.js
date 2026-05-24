'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findSetInText, getSetCandidates, bucketListingsBySet, getNumberCandidates, hasJapaneseSignal, filterNumberCandidatesByLanguage } = require('../pokemon-sets');

// ─── findSetInText (existing helper, sanity-check it still works) ────────────
test('findSetInText: detects "Base Set 2" longer match over "Base"', () => {
  // Long-match-wins: "Base Set 2" should win over the shorter "Base" prefix.
  const out = findSetInText('Charizard 4/130 Base Set 2 Holo 2000');
  assert.ok(out);
  assert.strictEqual(out.name, 'Base Set 2');
});

test('findSetInText: detects Celebrations', () => {
  const out = findSetInText('Pokemon TCG Celebrations 25th Anniversary Charizard 4/102');
  assert.ok(out);
  assert.strictEqual(out.name, 'Celebrations');
});

test('findSetInText: no set keyword → null', () => {
  assert.strictEqual(findSetInText('Charizard 4/102 Holo Rare'), null);
});

// ─── getSetCandidates ────────────────────────────────────────────────────────
test('getSetCandidates: real Ronflex case — surfaces Jungle + Base Set 2', () => {
  const matches = [
    { title: 'Carte Pokémon anglaise Ronflex holo jungle - Collection' },
    { title: 'Ronflex - carte Pokémon 27/64 Jungle' },
    { title: 'Carte Pokémon Ronflex 11/64' },
    { title: 'CARTE POKEMON RONFLEX 27/64 FR RARE WIZARDS JUNGLE - TBE' },
    { title: 'Ronflex 27/64 [PREMIERE EDITION 1] - Jungle' },
    { title: 'SNORLAX - 11/64 - ensemble jungle - Holo' },
    { title: 'Snorlax de 1999' },
    { title: 'Ronflex (B2 30/130) - Base Set 2 | Cardex international' },
    { title: 'Prix de Snorlax [1st Edition] #11 | Pokemon Jungle' },
    { title: 'JCC Pokémon.tf - Pokédex >> #143 Ronflex' },
    { title: 'Snorlax - Base Set 2 #30 Pokemon Card' },
    { title: 'Ronflex 11/64 brillant - Collection' },
    { title: 'Ronflex 27/64 - Valeur & Prix de Rachat' },
    { title: 'Snorlax (XY Promo 179) - Bulbapedia' },
    { title: 'Snorlax Custom Metal Credit Card' },
  ];
  const cands = getSetCandidates(matches);
  // Jungle should be #1 (most-cited), Base Set 2 should be #2.
  assert.ok(cands.length >= 2, 'expected at least 2 candidates, got ' + cands.length);
  assert.strictEqual(cands[0].name, 'Jungle');
  assert.ok(cands[0].count >= 5, 'Jungle should have ≥5 mentions, got ' + cands[0].count);
  const bs2 = cands.find(c => c.name === 'Base Set 2');
  assert.ok(bs2, 'Base Set 2 should be in candidates');
});

test('getSetCandidates: needs ≥minMentions per set (default 2) — filters out one-offs', () => {
  const matches = [
    { title: 'Charizard 4/102 Base Set Shadowless 1999' },   // 1 mention of Base
    { title: 'Charizard 4/102 XY Promo' },                    // 1 mention of XY Promos
    { title: 'Charizard generic listing' },
  ];
  const cands = getSetCandidates(matches);
  assert.strictEqual(cands.length, 0, 'no set with ≥2 mentions → no candidates');
});

test('getSetCandidates: returns candidates sorted by count desc', () => {
  const matches = [
    { title: 'Celebrations 4/102 1' },
    { title: 'Celebrations Classic Collection 2' },
    { title: 'Celebrations 25th 3' },
    { title: 'Base Set 4/102 1' },
    { title: 'Base Set Shadowless 2' },
  ];
  const cands = getSetCandidates(matches);
  assert.strictEqual(cands[0].name, 'Celebrations');
  assert.strictEqual(cands[0].count, 3);
  assert.strictEqual(cands[1].name, 'Base');
});

test('getSetCandidates: empty/null input safe', () => {
  assert.deepStrictEqual(getSetCandidates([]), []);
  assert.deepStrictEqual(getSetCandidates(null), []);
});

// ─── bucketListingsBySet ─────────────────────────────────────────────────────
test('bucketListingsBySet: sorts listings into the right set bucket by title', () => {
  const candidates = [
    { code: 'base1', name: 'Base', series: 'Base' },
    { code: 'cel25c', name: 'Celebrations: Classic Collection', series: 'Sword & Shield' },
  ];
  const listings = [
    { title: 'Charizard 4/102 Base Set 1st Edition',                price: 5000, imageUrl: 'a.jpg' },
    { title: 'Charizard 4/102 Celebrations: Classic Collection',    price: 30,   imageUrl: 'b.jpg' },
    { title: 'Charizard 4/102 Base Set Shadowless',                 price: 1500, imageUrl: 'c.jpg' },
    { title: 'Charizard 4/102 Celebrations: Classic Collection PSA 9', price: 60, imageUrl: 'd.jpg' },
  ];
  const out = bucketListingsBySet(listings, candidates);
  assert.strictEqual(out.length, 2);
  const base = out.find(b => b.label === 'Base');
  const cel  = out.find(b => /Celebrations/.test(b.label));
  assert.strictEqual(base.count, 2);
  assert.strictEqual(cel.count, 2);
  assert.ok(base.price > cel.price, 'Base Set should be more expensive than Celebrations');
});

test('bucketListingsBySet: listings without a recognized set go to the top-voted bucket', () => {
  // Sellers often omit the set name when the card is the most-common print.
  // Those should land in the top-voted (first) bucket so they aren't lost.
  const candidates = [
    { code: 'base1', name: 'Base', series: 'Base', count: 5 },
    { code: 'cel25c', name: 'Celebrations: Classic Collection', series: 'Sword & Shield', count: 3 },
  ];
  const listings = [
    { title: 'Charizard 4/102 Holo Rare',                    price: 600 },    // ambiguous → goes to Base
    { title: 'Charizard 4/102 Celebrations',                 price: 25 },
    { title: 'Charizard 4/102 Base Set Shadowless',          price: 1500 },
  ];
  const out = bucketListingsBySet(listings, candidates);
  const base = out.find(b => b.label === 'Base');
  assert.strictEqual(base.count, 2, 'ambiguous listing should join Base (top-voted) bucket');
});

test('bucketListingsBySet: empty candidates → []', () => {
  assert.deepStrictEqual(bucketListingsBySet([{ title: 'x', price: 1 }], []), []);
  assert.deepStrictEqual(bucketListingsBySet([{ title: 'x', price: 1 }], null), []);
});

test('bucketListingsBySet: zero-listing bucket returns null price + count=0', () => {
  const candidates = [
    { code: 'base3', name: 'Fossil', series: 'Base', count: 2 },
  ];
  const out = bucketListingsBySet([], candidates);
  assert.strictEqual(out[0].count, 0);
  assert.strictEqual(out[0].price, null);
});

// ─── getNumberCandidates ─────────────────────────────────────────────────────
test('getNumberCandidates: real Nidoking case — surfaces 3 distinct numbers', () => {
  const matches = [
    { title: 'Carte Pokemon NIDOKING 11/102 Holo Set de Base Wizards FR' },
    { title: 'Nidoking No.034 Holo No rarity Expansion Pack Japanese' },
    { title: 'Pokémon - Carte à collection Nidoking (45/108) - XY' },
    { title: 'Nidoking 45/108 Evolutions Holo Rare Pokemon Card' },
    { title: 'Carte Pokémon - Set de Base - Nidoking - 11/102 - Gradée 8,5' },
    { title: 'Carte Pokémon Nidoking 11/102 Holographique Set de Base' },
    { title: 'NIDOKING NO. 034 - Set de base - Base Set - Carte Pokémon' },
    { title: 'NIDOKING - 11/102 - Coffret de base - Holo - Carte Pokémon' },
  ];
  const out = getNumberCandidates(matches);
  assert.strictEqual(out.length, 3, 'expected 3 number candidates, got ' + out.length);
  assert.strictEqual(out[0].number, '11/102');     // most-cited first
  assert.strictEqual(out[0].count, 4);
  assert.ok(out.some(c => c.number === 'No.034'),  'No.034 should be a candidate');
  assert.ok(out.some(c => c.number === '45/108'),  '45/108 should be a candidate');
});

test('getNumberCandidates: captures JP vintage "No.034" / "No. 034" format', () => {
  const out = getNumberCandidates([
    { title: 'Charizard No.006 Holo Expansion Pack' },
    { title: 'Charizard No. 006 Japanese Base' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].number, 'No.006');
  assert.strictEqual(out[0].count, 2);
});

test('getNumberCandidates: same number across all → 1 candidate (caller needs ≥2 to trigger picker)', () => {
  // When every title shares one number (Charizard 4/102 Base vs Celebrations),
  // number-grouping returns just that one candidate. buildPokemonMultiSetPicker
  // requires length >= 2, so it falls through to set-name grouping instead.
  const out = getNumberCandidates([
    { title: 'Charizard 4/102 Base Set' },
    { title: 'Charizard 4/102 Celebrations' },
    { title: 'Charizard 4/102 Holo' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].number, '4/102');
});

test('getNumberCandidates: empty/null safe', () => {
  assert.deepStrictEqual(getNumberCandidates([]), []);
  assert.deepStrictEqual(getNumberCandidates(null), []);
});

test('getNumberCandidates: real Dracaufeu Radieux case — "020/159" and "20/159" group together (same printing, different padding)', () => {
  // Scan a7081c41: Lens returned both padded and unpadded forms of the same
  // card number, which was producing TWO bogus picker tiles for the SAME
  // printing. After normalization they collapse into one vote.
  const matches = [
    { title: 'Carte Pokémon Dracaufeu radieux 020/159 Zénith suprême ...' },
    { title: 'Carte Pokemon - Dracaufeu Radieux - 020/159 - Ultra-rare ...' },
    { title: 'Carte Pokémon – Dracaufeu Radieux 020/159 – E&B 12.5 – ultra ...' },
    { title: 'carte Pokémon Dracaufeu Radieux 020/159 #9 NEUF FR | eBay' },
    { title: 'Carte Pokémon Dracaufeu Radieux 020/159 Ultra Rare Zénith ...' },
    { title: 'Dracaufeu Radieux 20/159 - Myboost X Epée et Bouclier 12.5 ...' },
    { title: 'Carte Pokemon Dracaufeu Radieux 20/159 EB12.5 Zénith Suprême ...' },
  ];
  const out = getNumberCandidates(matches);
  assert.strictEqual(out.length, 1, 'expected the two paddings to merge into one candidate');
  assert.strictEqual(out[0].number, '20/159');
  assert.strictEqual(out[0].count, 7);
});

test('getNumberCandidates: different sets keep separate keys (does NOT over-merge)', () => {
  // Safety check that the leading-zero strip doesn't accidentally collapse
  // distinct cards. Charizard 4/102 (Base) and 4/108 (Evolutions) must stay
  // as two candidates.
  const matches = [
    { title: 'Charizard 4/102 Base Set' },
    { title: 'Charizard 4/102 Holo' },
    { title: 'Charizard 4/108 Evolutions' },
    { title: 'Charizard 4/108 XY' },
  ];
  const out = getNumberCandidates(matches);
  assert.strictEqual(out.length, 2);
  assert.ok(out.some(c => c.number === '4/102'));
  assert.ok(out.some(c => c.number === '4/108'));
});

// ─── hasJapaneseSignal ──────────────────────────────────────────────────────
test('hasJapaneseSignal: detects Hiragana/Katakana/Kanji directly', () => {
  assert.strictEqual(hasJapaneseSignal('カビゴン 145/165'), true);  // Katakana (Snorlax)
  assert.strictEqual(hasJapaneseSignal('ピカチュウ'), true);          // Katakana (Pikachu)
  assert.strictEqual(hasJapaneseSignal('ポケモン カード'), true);     // mixed CJK
  assert.strictEqual(hasJapaneseSignal('日本語'), true);              // Kanji
});

test('hasJapaneseSignal: detects explicit JP keywords in Latin script', () => {
  assert.strictEqual(hasJapaneseSignal('Charizard Japanese Holo'), true);
  assert.strictEqual(hasJapaneseSignal('Carte japonaise Eevee'), true);
  assert.strictEqual(hasJapaneseSignal('PSA10 Eevee AR Crimson Haze 2024 sv5a Pokemon Card Japanese'), true);
});

test('hasJapaneseSignal: pure FR/EN listings return false', () => {
  assert.strictEqual(hasJapaneseSignal('Pokemon - EVOLI FA 188/167 - PCA 9.5 - Collection'), false);
  assert.strictEqual(hasJapaneseSignal('Carte Pokémon Evoli 188/167 - Kinkai'), false);
  assert.strictEqual(hasJapaneseSignal('Charizard 4/102 Base Set Shadowless 1999'), false);
});

test('hasJapaneseSignal: null/empty safe', () => {
  assert.strictEqual(hasJapaneseSignal(null), false);
  assert.strictEqual(hasJapaneseSignal(''), false);
  assert.strictEqual(hasJapaneseSignal(undefined), false);
});

// ─── filterNumberCandidatesByLanguage ──────────────────────────────────────
test('filterNumberCandidatesByLanguage: real Évoli case — JP scan drops FR-only 188/167', () => {
  // Scan 7c11fb5c: card detected JP. Lens returned mixed matches including
  // a FR-only 188/167 candidate (different Évoli printing from EV6 — does
  // not exist in JP). Filter must drop it so the picker doesn't offer an
  // impossible choice to the user.
  const matches = [
    { title: 'Japanese Pokémon Card - Eevee AR 078/066 - SV5A Crimson Haze' },
    { title: 'PSA10 Eevee AR 078/066 Crimson Haze 2024 sv5a Pokemon Card Japanese' },
    { title: 'Évoli 078/066 AR SV5a イーブイ' },              // explicit JP chars
    { title: 'Eevee AR 078/066 Crimson Haze sv5a 2024 Japan' },
    { title: 'Pokemon - EVOLI FA 188/167 - PCA 9.5 - Collection' },     // FR
    { title: 'Carte Pokémon Evoli 188/167 - Kinkai' },                  // FR
    { title: 'FULL ART EVOLI 188/167 SFG GRADING' },                    // FR
  ];
  const candidates = getNumberCandidates(matches);
  assert.strictEqual(candidates.length, 2, 'sanity: raw candidates should be 2');
  const filtered = filterNumberCandidatesByLanguage(candidates, matches, 'JP');
  assert.strictEqual(filtered.length, 1, 'JP filter should drop 188/167');
  assert.strictEqual(filtered[0].number, '78/66');  // normalized form
});

test('filterNumberCandidatesByLanguage: FR scan with same-language candidates keeps both', () => {
  // Regression guard: Ronflex multi-set case, both Jungle and Base Set 2
  // are FR-language listings → both stay. Filter must not over-prune.
  const matches = [
    { title: 'Ronflex 27/64 Jungle Wizards FR' },
    { title: 'Carte Pokémon Ronflex 27/64 Jungle' },
    { title: 'Ronflex (B2 30/130) - Base Set 2 français' },
    { title: 'Snorlax - Base Set 2 #30 Pokemon Card français' },
  ];
  const candidates = getNumberCandidates(matches);
  const filtered = filterNumberCandidatesByLanguage(candidates, matches, 'FR');
  assert.strictEqual(filtered.length, candidates.length, 'both FR candidates must survive');
});

test('filterNumberCandidatesByLanguage: WORLD / null / undefined language → no filter applied', () => {
  // When language isn't decided, we have no basis to filter — return as-is.
  const matches = [
    { title: 'Eevee AR 078/066 Japanese sv5a' },
    { title: 'Eevee AR 078/066 Japanese sv5a 2' },
    { title: 'Pokemon EVOLI 188/167 français' },
    { title: 'Pokemon EVOLI 188/167 français 2' },
  ];
  const candidates = getNumberCandidates(matches);
  assert.strictEqual(filterNumberCandidatesByLanguage(candidates, matches, 'WORLD').length, 2);
  assert.strictEqual(filterNumberCandidatesByLanguage(candidates, matches, null).length,    2);
  assert.strictEqual(filterNumberCandidatesByLanguage(candidates, matches, undefined).length, 2);
});

test('filterNumberCandidatesByLanguage: EN/FR scan drops JP-only candidate', () => {
  // Inverse of the Évoli case: someone scans a FR card and Lens picks up a
  // JP-only printing variant. Filter must drop the JP-only candidate.
  const matches = [
    { title: 'Charizard 4/102 Base Set Shadowless français' },
    { title: 'Carte Charizard 4/102 Base Set' },
    { title: 'リザードン 003/032 Japanese promo' },          // JP-only candidate
    { title: 'Charizard 003/032 Japanese Promo card' },
  ];
  const candidates = getNumberCandidates(matches);
  const filtered = filterNumberCandidatesByLanguage(candidates, matches, 'FR');
  assert.ok(filtered.every(c => c.number !== '3/32'), 'JP-only candidate must be dropped');
  assert.ok(filtered.some(c => c.number === '4/102'), 'FR candidate must survive');
});

test('filterNumberCandidatesByLanguage: empty / null safe', () => {
  assert.deepStrictEqual(filterNumberCandidatesByLanguage([], [], 'JP'), []);
  assert.deepStrictEqual(filterNumberCandidatesByLanguage(null, [], 'JP'), []);
});
