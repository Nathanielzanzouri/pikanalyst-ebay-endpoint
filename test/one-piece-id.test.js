'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeCardNumber,
  extractCharacterFromTitle,
  extractRarityFromTitle,
  extractOnePieceFromMatches,
  buildOnePieceQuery,
  voteMajority,
} = require('../one-piece-id');

// ─── card number normalization ────────────────────────────────────────────────
test('normalizeCardNumber: standard OP01-001 stays canonical', () => {
  assert.strictEqual(normalizeCardNumber('OP01-001'), 'OP01-001');
});

test('normalizeCardNumber: compact OP01001 → OP01-001', () => {
  assert.strictEqual(normalizeCardNumber('OP01001'), 'OP01-001');
});

test('normalizeCardNumber: lowercase op01-001 → OP01-001 (uppercases prefix)', () => {
  assert.strictEqual(normalizeCardNumber('op01-001'), 'OP01-001');
});

test('normalizeCardNumber: starter deck ST01-001', () => {
  assert.strictEqual(normalizeCardNumber('ST01-001'), 'ST01-001');
});

test('normalizeCardNumber: extension booster EB01-014', () => {
  assert.strictEqual(normalizeCardNumber('EB01-014'), 'EB01-014');
});

test('normalizeCardNumber: promo card P-001', () => {
  assert.strictEqual(normalizeCardNumber('P-001'), 'P-001');
});

test('normalizeCardNumber: promo padded P-7 → P-007', () => {
  assert.strictEqual(normalizeCardNumber('P-7'), 'P-007');
});

test('normalizeCardNumber: vintage Carddass H18 (Hyper Battle) → H18', () => {
  assert.strictEqual(normalizeCardNumber('H18'), 'H18');
});

test('normalizeCardNumber: vintage Carddass S111 → S111', () => {
  assert.strictEqual(normalizeCardNumber('S111'), 'S111');
});

test('normalizeCardNumber: vintage Carddass with hyphen H-18 → H18', () => {
  assert.strictEqual(normalizeCardNumber('H-18'), 'H18');
});

test('normalizeCardNumber: garbage returns null', () => {
  assert.strictEqual(normalizeCardNumber('not a card number'), null);
  assert.strictEqual(normalizeCardNumber(null), null);
  assert.strictEqual(normalizeCardNumber(''), null);
});

// ─── rarity extraction ────────────────────────────────────────────────────────
test('extractRarityFromTitle: SEC takes priority over R (substring)', () => {
  assert.strictEqual(extractRarityFromTitle('Luffy OP01-001 SEC'), 'SEC');
});

test('extractRarityFromTitle: Manga Rare matches over plain Rare', () => {
  assert.strictEqual(extractRarityFromTitle('Yamato Manga Rare OP06-118'), 'Manga Rare');
});

test('extractRarityFromTitle: Alternate Art → AA', () => {
  assert.strictEqual(extractRarityFromTitle('Shanks Alternate Art OP01-120'), 'AA');
});

test('extractRarityFromTitle: bare AA matches', () => {
  assert.strictEqual(extractRarityFromTitle('Luffy AA OP01-001'), 'AA');
});

test('extractRarityFromTitle: SR matches', () => {
  assert.strictEqual(extractRarityFromTitle('Luffy OP01-025 SR'), 'SR');
});

test('extractRarityFromTitle: no rarity → null', () => {
  assert.strictEqual(extractRarityFromTitle('Luffy OP01-001'), null);
});

// ─── character extraction ─────────────────────────────────────────────────────
test('extractCharacterFromTitle: simple "Luffy" from Lens title', () => {
  const out = extractCharacterFromTitle('One Piece TCG Luffy OP01-001 SR', 'OP01-001');
  assert.ok(out && /luffy/i.test(out), 'should contain Luffy, got: ' + out);
});

test('extractCharacterFromTitle: multi-word "Monkey D. Luffy"', () => {
  const out = extractCharacterFromTitle('One Piece Card Monkey D. Luffy OP01-001', 'OP01-001');
  assert.ok(out && /Monkey D.*Luffy/i.test(out), 'should contain Monkey D. Luffy, got: ' + out);
});

test('extractCharacterFromTitle: returns null on empty/noise', () => {
  assert.strictEqual(extractCharacterFromTitle('', 'OP01-001'), null);
});

// ─── vote consensus across Lens matches ──────────────────────────────────────
test('extractOnePieceFromMatches: 3 agreeing matches → confident extraction', () => {
  const matches = [
    { title: 'One Piece TCG Monkey D. Luffy OP01-001 SR Red Leader Romance Dawn' },
    { title: 'Carte One Piece Monkey D Luffy OP01-001 SR' },
    { title: 'OP01-001 Monkey D Luffy Leader SR Red Romance Dawn Booster' },
  ];
  const out = extractOnePieceFromMatches(matches);
  assert.strictEqual(out.card_number, 'OP01-001');
  assert.strictEqual(out.rarity, 'SR');
  assert.ok(out.character && /Luffy/i.test(out.character));
  assert.strictEqual(out.color, 'Red');
});

test('extractOnePieceFromMatches: only 1 vote → null (under threshold)', () => {
  const matches = [
    { title: 'OP01-001 Luffy SR' },
    { title: 'Pokemon Pikachu 25/100' }, // unrelated noise
    { title: 'Random sneaker listing' },
  ];
  const out = extractOnePieceFromMatches(matches);
  assert.strictEqual(out.card_number, null, '1 vote should not pass threshold');
});

test('extractOnePieceFromMatches: empty input → all null', () => {
  const out = extractOnePieceFromMatches([]);
  assert.deepStrictEqual(out, { card_number: null, card_number_votes: 0, character: null, rarity: null, color: null });
});

test('extractOnePieceFromMatches: handles non-array gracefully', () => {
  const out = extractOnePieceFromMatches(null);
  assert.strictEqual(out.card_number, null);
});

// ─── query building ──────────────────────────────────────────────────────────
test('buildOnePieceQuery: minimal — character + number', () => {
  const q = buildOnePieceQuery({ character: 'Luffy', card_number: 'OP01-001' });
  assert.strictEqual(q, 'Luffy OP01-001');
});

test('buildOnePieceQuery: AA variant appended (variant matters for price)', () => {
  const q = buildOnePieceQuery({ character: 'Shanks', card_number: 'OP01-120', rarity: 'AA' });
  assert.strictEqual(q, 'Shanks OP01-120 AA');
});

test('buildOnePieceQuery: SR rarity NOT appended (too generic, narrows too much)', () => {
  const q = buildOnePieceQuery({ character: 'Luffy', card_number: 'OP01-001', rarity: 'SR' });
  assert.strictEqual(q, 'Luffy OP01-001');
});

test('buildOnePieceQuery: Manga Rare IS appended (price-significant variant)', () => {
  const q = buildOnePieceQuery({ character: 'Yamato', card_number: 'OP06-118', rarity: 'Manga Rare' });
  assert.strictEqual(q, 'Yamato OP06-118 Manga Rare');
});

test('buildOnePieceQuery: empty identity → empty string', () => {
  assert.strictEqual(buildOnePieceQuery({}), '');
  assert.strictEqual(buildOnePieceQuery(null), '');
});

// ─── helper: voteMajority ────────────────────────────────────────────────────
test('voteMajority: ≥2 occurrences returns the value', () => {
  assert.strictEqual(voteMajority(['a', 'a', 'b'], 2), 'a');
});

test('voteMajority: tied votes — returns first-counted, both ≥ threshold', () => {
  // Both 'a' and 'b' have 2 votes; spec just says "most frequent"; either is fine
  const out = voteMajority(['a', 'b', 'a', 'b'], 2);
  assert.ok(out === 'a' || out === 'b');
});

test('voteMajority: under threshold returns null', () => {
  assert.strictEqual(voteMajority(['a', 'b', 'c'], 2), null);
});

test('voteMajority: null/empty input safe', () => {
  assert.strictEqual(voteMajority([], 2), null);
  assert.strictEqual(voteMajority([null, undefined, ''], 2), null);
});
