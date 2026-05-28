'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  detectTrainerCard,
  findTrainerInText,
  findPossessiveTrainer,
  hasTrainerKeyword,
  EN_TO_FR,
} = require('../trainer-names');

// ─── findTrainerInText ──────────────────────────────────────────────────────
test('findTrainerInText: finds EN name "Misty" in title', () => {
  assert.strictEqual(
    findTrainerInText('Pokémon TCG: Misty\'s Spirit SR 108/081 M5 Abyss Eye'),
    'Misty'
  );
});

test('findTrainerInText: finds FR name "Ondine" → canonicalizes to "Misty"', () => {
  assert.strictEqual(
    findTrainerInText('Carte Ondine Pokémon Genétique 145'),
    'Misty'
  );
});

test('findTrainerInText: finds multi-word "Lt. Surge"', () => {
  assert.strictEqual(
    findTrainerInText('Lt. Surge\'s Strategy Holo Vintage'),
    'Lt. Surge'
  );
});

test('findTrainerInText: case-insensitive', () => {
  assert.strictEqual(findTrainerInText('ERIKA WELCOME PROMO 165'), 'Erika');
  assert.strictEqual(findTrainerInText('giovanni charisma'), 'Giovanni');
});

test('findTrainerInText: returns null on Pokémon-only title (no false positive)', () => {
  assert.strictEqual(findTrainerInText('Pikachu V 28/185 Vivid Voltage Holo'), null);
  assert.strictEqual(findTrainerInText('Charizard ex 199/197 Obsidian Flames'), null);
});

test('findTrainerInText: single-letter name "N" is NOT matched alone (too noisy)', () => {
  // "N" appearing as a standalone letter elsewhere should not trigger
  // (e.g. "PSA 9 N-Mint"). We rely on possessive pattern for N.
  assert.strictEqual(findTrainerInText('PSA 9 N-Mint Charizard Base'), null);
});

test('findTrainerInText: longest match wins (Lt. Surge over plain "Surge")', () => {
  assert.strictEqual(
    findTrainerInText('Lt. Surge\'s Battle 100/100'),
    'Lt. Surge'
  );
});

// ─── findPossessiveTrainer ──────────────────────────────────────────────────
test('findPossessiveTrainer: EN "Misty\'s Spirit" → Misty', () => {
  assert.strictEqual(findPossessiveTrainer("Misty's Spirit SR 108/081"), 'Misty');
});

test('findPossessiveTrainer: FR "d\'Ondine" → Misty (canonical EN)', () => {
  assert.strictEqual(findPossessiveTrainer("L'Esprit d'Ondine 108/081"), 'Misty');
});

test('findPossessiveTrainer: FR "de Cynthia" → Cynthia', () => {
  assert.strictEqual(findPossessiveTrainer('La Puissance de Cynthia 119/156'), 'Cynthia');
});

test('findPossessiveTrainer: returns null when no possessive pattern', () => {
  assert.strictEqual(findPossessiveTrainer('Misty solo on this title'), null);
});

// ─── hasTrainerKeyword ──────────────────────────────────────────────────────
test('hasTrainerKeyword: detects "Supporter" / "Trainer" / "Dresseur" / "Stade"', () => {
  assert.ok(hasTrainerKeyword('Misty Supporter Card'));
  assert.ok(hasTrainerKeyword('Trainer card holo'));
  assert.ok(hasTrainerKeyword('Carte Dresseur rare'));
  assert.ok(hasTrainerKeyword('Stadium card Sword & Shield'));
  assert.ok(hasTrainerKeyword('Stade Pokémon ancien'));
});

test('hasTrainerKeyword: false on Pokemon-only titles', () => {
  assert.strictEqual(hasTrainerKeyword('Pikachu ex Holo'), false);
});

// ─── detectTrainerCard (main entry) ─────────────────────────────────────────
test('detectTrainerCard: REAL Misty\'s Spirit SR scan — extracts Misty + 108/081', () => {
  // Real lens_matches from scan b45794c9 — the misidentified-as-Mewtwo case.
  const matches = [
    { title: 'Pokemon Misty Card en vente | eBay' },
    { title: '👁️ ABYSS EYE : les premières cartes commencent à être ...' },
    { title: 'This is the official first look at Abyss Eye 👀🔥 The set ...' },
    { title: 'Pokémon Pocket : Les decks Eau boostés une nouvelle fois ...' },
    { title: 'Pokémon TCG: Misty\'s Spirit SR 108/081 M5 Pokemon Card Abyss ...' },
    { title: 'Pokémon Pocket - Cartodex - Extension Puissance Génétique ...' },
    { title: '[PKM] LE MEILLEUR DECK EAU SUR POKEMON TCG ...' },
    { title: 'Ondine (Puissance Génétique 220) — Poképédia' },
    { title: 'The Glory of Team Rocket new card🔥 Mewtwo ex SAR🥷🔥🔥 So ...' },
    { title: 'Nouveaux produits' },
    { title: 'PITCH BLACK ARE SO READY FOR YOU! This set is absolutely ...' },
    { title: 'Misty\'s Cheerfulness #75 Prices | Pokemon Japanese Abyss Eye ...' },
    { title: 'En Morikura | The Art of Pokémon' },
    { title: 'Nouveaux Leaks de Me03 😮‍💨😮‍💨😮‍💨 Qu\'est ce que vous en ...' },
    { title: 'More leaks from japanese Abyss Eye M5 : r/PokemonTCG' },
  ];
  const out = detectTrainerCard(matches);
  assert.ok(out, 'expected a trainer detection result');
  assert.strictEqual(out.character_en, 'Misty');
  assert.strictEqual(out.character_fr, 'Ondine');
  assert.strictEqual(out.card_number, '108/81');         // normalized (no leading zeros)
  assert.strictEqual(out.via, 'possessive');             // possessive pattern detected
});

test('detectTrainerCard: real Pokémon scan returns null (no trainer detected)', () => {
  // Regression guard: a typical Pikachu scan shouldn't trigger trainer fallback.
  const matches = [
    { title: 'Pikachu V 28/185 Vivid Voltage Holo' },
    { title: 'Pikachu V SWSH 28/185' },
    { title: 'Carte Pokémon Pikachu V Vivid Voltage' },
    { title: 'Pikachu V 28/185 Pokemon Sword & Shield' },
    { title: 'PSA 10 Pikachu V Vivid Voltage' },
  ];
  assert.strictEqual(detectTrainerCard(matches), null);
});

test('detectTrainerCard: Cynthia\'s Power FR scan — extracts via FR possessive', () => {
  const matches = [
    { title: 'La Puissance de Cynthia 119/156' },
    { title: 'Cynthia\'s Power Sword & Shield Ultra Prism Holo' },
    { title: 'Carte Cynthia rare 119/156' },
  ];
  const out = detectTrainerCard(matches);
  assert.ok(out);
  assert.strictEqual(out.character_en, 'Cynthia');
  assert.strictEqual(out.card_number, '119/156');
});

test('detectTrainerCard: requires confidence — single mention without possessive returns null', () => {
  // A single "Misty" mention without possessive structure isn't strong enough
  // — could be a tangentially-related listing in the Lens results. Don't fire.
  const matches = [
    { title: 'Pokemon Misty Card en vente | eBay' },     // generic mention
    { title: 'Pikachu V holo rare' },
    { title: 'Charizard EX' },
  ];
  assert.strictEqual(detectTrainerCard(matches), null);
});

test('detectTrainerCard: 2+ mentions of same trainer fires even without possessive', () => {
  const matches = [
    { title: 'Pokemon Erika Card listing' },
    { title: 'Erika Welcome 165/197 PSA 10' },
    { title: 'Carte Erika holo 2025' },
  ];
  const out = detectTrainerCard(matches);
  assert.ok(out);
  assert.strictEqual(out.character_en, 'Erika');
  assert.strictEqual(out.via, 'vote');
});

test('detectTrainerCard: empty input safe', () => {
  assert.strictEqual(detectTrainerCard([]), null);
  assert.strictEqual(detectTrainerCard(null), null);
});

// ─── EN_TO_FR map ───────────────────────────────────────────────────────────
test('EN_TO_FR: canonical FR names match expectations', () => {
  assert.strictEqual(EN_TO_FR.get('Misty'), 'Ondine');
  assert.strictEqual(EN_TO_FR.get('Brock'), 'Pierre');
  assert.strictEqual(EN_TO_FR.get('Giovanni'), 'Giovanni');
  assert.strictEqual(EN_TO_FR.get('Marnie'), 'Rosemary');
});
