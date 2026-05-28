'use strict';

// ─── Pokémon Trainer / Supporter card detection ──────────────────────────────
// Many Pokémon TCG Supporter / Trainer cards feature named human characters
// (Gym Leaders, Champions, Team admins, Professors, Rivals). They're not
// Pokémon, so the existing extractPokemonFromMatches() vote ignores them
// completely → falls back to a noisy generic query like "mewtwo pokemon card"
// when it accidentally finds a Pokemon name in the Lens results.
//
// This module provides a whitelist of canonical Trainer names (EN + FR) plus
// a detectTrainerInTitle() helper that looks for the canonical name + the
// possessive pattern ("Misty's Spirit" / "L'Esprit d'Ondine" / "de Ondine").
//
// Wired into the Pokémon vote pipeline as a FALLBACK ONLY — fires when the
// regular Pokémon name vote returns no winner. Zero regression risk on
// scans that already identify a Pokémon correctly.
//
// Reference scan that triggered this: b45794c9 (Misty's Spirit SR 108/081
// Abyss Eye M5 misidentified as "mewtwo").

// Each entry: { en, fr, aliases? } — `aliases` is for alternate spellings
// or character names that diverge significantly between regions. Both `en`
// and `fr` are matched against the title (case-insensitive, word-boundary).
const TRAINER_CHARACTERS = [
  // ─── Kanto Gym Leaders ───
  { en: 'Brock',       fr: 'Pierre' },
  { en: 'Misty',       fr: 'Ondine' },
  { en: 'Lt. Surge',   fr: 'Major Bob',  aliases: ['Lt Surge', 'Surge'] },
  { en: 'Erika',       fr: 'Erika' },
  { en: 'Koga',        fr: 'Koga' },
  { en: 'Sabrina',     fr: 'Sabrina' },
  { en: 'Blaine',      fr: 'Auguste' },
  { en: 'Giovanni',    fr: 'Giovanni' },

  // ─── Johto Gym Leaders ───
  { en: 'Falkner',     fr: 'Albert' },
  { en: 'Bugsy',       fr: 'Hector' },
  { en: 'Whitney',     fr: 'Blanche' },
  { en: 'Morty',       fr: 'Mortimer' },
  { en: 'Chuck',       fr: 'Léo' },
  { en: 'Jasmine',     fr: 'Jasmine' },
  { en: 'Pryce',       fr: 'Frédo' },
  { en: 'Clair',       fr: 'Sandra' },

  // ─── Hoenn Gym Leaders ───
  { en: 'Roxanne',     fr: 'Roxanne' },
  { en: 'Brawly',      fr: 'Bastien' },
  { en: 'Wattson',     fr: 'Voltère' },
  { en: 'Flannery',    fr: 'Adriane' },
  { en: 'Norman',      fr: 'Norman' },
  { en: 'Winona',      fr: 'Alizée' },
  { en: 'Tate',        fr: 'Lévy' },
  { en: 'Liza',        fr: 'Tatia' },
  { en: 'Wallace',     fr: 'Marc' },
  { en: 'Juan',        fr: 'Juan' },

  // ─── Sinnoh Gym Leaders ───
  { en: 'Roark',       fr: 'Pierrick' },
  { en: 'Gardenia',    fr: 'Floria' },
  { en: 'Maylene',     fr: 'Mélina' },
  { en: 'Crasher Wake', fr: 'Mathis',   aliases: ['Wake'] },
  { en: 'Fantina',     fr: 'Kiméra' },
  { en: 'Byron',       fr: 'Charles' },
  { en: 'Candice',     fr: 'Gladys' },
  { en: 'Volkner',     fr: 'Tanguy' },

  // ─── Unova Gym Leaders ───
  { en: 'Cilan',       fr: 'Rachid' },
  { en: 'Chili',       fr: 'Armand' },
  { en: 'Cress',       fr: 'Noa' },
  { en: 'Lenora',      fr: 'Aloé' },
  { en: 'Burgh',       fr: 'Artie' },
  { en: 'Elesa',       fr: 'Inezia' },
  { en: 'Clay',        fr: 'Bardane' },
  { en: 'Skyla',       fr: 'Carolina' },
  { en: 'Brycen',      fr: 'Zhu' },
  { en: 'Drayden',     fr: 'Watson' },

  // ─── Kalos Gym Leaders ───
  { en: 'Viola',       fr: 'Violette' },
  { en: 'Grant',       fr: 'Tierno' },
  { en: 'Korrina',     fr: 'Cornélia' },
  { en: 'Ramos',       fr: 'Amaro' },
  { en: 'Clemont',     fr: 'Lem' },
  { en: 'Valerie',     fr: 'Valériane' },
  { en: 'Olympia',     fr: 'Astera' },
  { en: 'Wulfric',     fr: 'Urval' },

  // ─── Alola Trial Captains & Kahunas ───
  { en: 'Hala',        fr: 'Hala' },
  { en: 'Olivia',      fr: 'Olivia' },
  { en: 'Nanu',        fr: 'Nanu' },
  { en: 'Hapu',        fr: 'Pamenard' },
  { en: 'Ilima',       fr: 'Tili' },
  { en: 'Lana',        fr: 'Néphie' },
  { en: 'Mallow',      fr: 'Barbara' },
  { en: 'Sophocles',   fr: 'Chrys' },
  { en: 'Acerola',     fr: 'Margie' },
  { en: 'Kiawe',       fr: 'Kiawe' },
  { en: 'Mina',        fr: 'Maïna' },

  // ─── Galar Gym Leaders ───
  { en: 'Milo',        fr: 'Percy' },
  { en: 'Nessa',       fr: 'Lona' },
  { en: 'Kabu',        fr: 'Kabu' },
  { en: 'Bea',         fr: 'Judith' },
  { en: 'Allister',    fr: 'Alistair' },
  { en: 'Opal',        fr: 'Sally' },
  { en: 'Gordie',      fr: 'Lonzo' },
  { en: 'Melony',      fr: 'Eva' },
  { en: 'Piers',       fr: 'Travis' },
  { en: 'Raihan',      fr: 'Roy' },
  { en: 'Marnie',      fr: 'Rosemary' },

  // ─── Paldea Gym Leaders ───
  { en: 'Katy',        fr: 'Cathy' },
  { en: 'Brassius',    fr: 'Colza' },
  { en: 'Iono',        fr: 'Mashynn' },
  { en: 'Kofu',        fr: 'Kombu' },
  { en: 'Larry',       fr: 'Lassie' },
  { en: 'Ryme',        fr: 'Ryme' },
  { en: 'Tulip',       fr: 'Tully' },
  { en: 'Grusha',      fr: 'Grusha' },

  // ─── Champions & Elite Four (high TCG print rate) ───
  { en: 'Lance',       fr: 'Peter' },
  { en: 'Cynthia',     fr: 'Cynthia' },
  { en: 'Steven',      fr: 'Pierre Rochard', aliases: ['Steven Stone'] },
  { en: 'Diantha',     fr: 'Dianthéa' },
  { en: 'Iris',        fr: 'Iris' },
  { en: 'Alder',       fr: 'Goyah' },
  { en: 'Leon',        fr: 'Tarak' },
  { en: 'Geeta',       fr: 'Olim' },
  { en: 'Nemona',      fr: 'Mencia' },
  { en: 'Karen',       fr: 'Marion' },
  { en: 'Will',        fr: 'Aurélien' },
  { en: 'Bruno',       fr: 'Auguste' },
  { en: 'Sidney',      fr: 'Damien' },
  { en: 'Phoebe',      fr: 'Spectra' },
  { en: 'Glacia',      fr: 'Glacia' },
  { en: 'Drake',       fr: 'Drake' },
  { en: 'Lorelei',     fr: 'Olga' },
  { en: 'Agatha',      fr: 'Agatha' },
  { en: 'Aaron',       fr: 'Aaron' },
  { en: 'Bertha',      fr: 'Terry' },
  { en: 'Flint',       fr: 'Tanguy' },
  { en: 'Lucian',      fr: 'Lucio' },

  // ─── Team Bosses & Admins ───
  { en: 'Maxie',       fr: 'Max' },
  { en: 'Archie',      fr: 'Arthur' },
  { en: 'Cyrus',       fr: 'Hélio' },
  { en: 'Mars',        fr: 'Mars' },
  { en: 'Jupiter',     fr: 'Jupiter' },
  { en: 'Saturn',      fr: 'Saturne' },
  { en: 'Ghetsis',     fr: 'Ghestis' },
  { en: 'N',           fr: 'N' },
  { en: 'Colress',     fr: 'Lugantium' },
  { en: 'Lysandre',    fr: 'Lysandre' },
  { en: 'Guzma',       fr: 'Guzma' },
  { en: 'Plumeria',    fr: 'Plumeria' },
  { en: 'Lusamine',    fr: 'Lusamine' },
  { en: 'Faba',        fr: 'Léon' },
  { en: 'Wicke',       fr: 'Mona' },
  { en: 'Rose',        fr: 'Rose' },
  { en: 'Oleana',      fr: 'Yvette' },

  // ─── Professors ───
  { en: 'Oak',         fr: 'Chen',       aliases: ['Professor Oak', 'Prof. Oak'] },
  { en: 'Elm',         fr: 'Orme',       aliases: ['Professor Elm'] },
  { en: 'Birch',       fr: 'Seko',       aliases: ['Professor Birch'] },
  { en: 'Rowan',       fr: 'Sorbier',    aliases: ['Professor Rowan'] },
  { en: 'Juniper',     fr: 'Keteleeria', aliases: ['Professor Juniper'] },
  { en: 'Sycamore',    fr: 'Platane',    aliases: ['Professor Sycamore'] },
  { en: 'Kukui',       fr: 'Euphorbe',   aliases: ['Professor Kukui'] },
  { en: 'Burnet',      fr: 'Burnet' },
  { en: 'Magnolia',    fr: 'Magnolia' },
  { en: 'Sonia',       fr: 'Sonia' },
  { en: 'Sada',        fr: 'Sada' },
  { en: 'Turo',        fr: 'Tūro' },
  { en: 'Willow',      fr: 'Willow' },

  // ─── Rivals / Player Characters ───
  { en: 'Blue',        fr: 'Régis' },
  { en: 'Silver',      fr: 'Silver' },
  { en: 'May',         fr: 'Flora' },
  { en: 'Brendan',     fr: 'Brendan' },
  { en: 'Dawn',        fr: 'Aurore' },
  { en: 'Barry',       fr: 'Pearl' },
  { en: 'Bianca',      fr: 'Bianca' },
  { en: 'Cheren',      fr: 'Cheren' },
  { en: 'Hugh',        fr: 'Hugh' },
  { en: 'Hop',         fr: 'Nabil' },
  { en: 'Hau',         fr: 'Tili' },
  { en: 'Selene',      fr: 'Lulu' },
  { en: 'Penny',       fr: 'Penny' },
  { en: 'Arven',       fr: 'Arven' },
  { en: 'Florian',     fr: 'Florian' },
  { en: 'Juliana',     fr: 'Juliana' },
  { en: 'Rosa',        fr: 'Rosa' },
  { en: 'Nate',        fr: 'Nate' },

  // ─── Other recurring characters ───
  { en: 'Looker',      fr: 'Beladonis' },
  { en: 'Janine',      fr: 'Aniss' },
];

// Build lookup tables for fast detection.
// We match case-insensitive on a normalized form (lowercase, ASCII-stripped
// for diacritics — Ondine/Mélina/Voltère need to match titles that drop
// accents).
function normalize(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    // Replace apostrophes with space so "Misty's" → "misty s" (preserves word
    // boundary). Otherwise we'd concatenate "mistys" and the word-boundary
    // regex below wouldn't find "misty" because next char is "s".
    .replace(/['']/g, ' ')
    .replace(/[^a-z0-9\s.&-]/g, '')                      // keep alnum + a few specials
    .replace(/\s+/g, ' ')                                // collapse repeated spaces
    .trim();
}

// All searchable name tokens → canonical EN name.
// Examples: 'misty' → 'Misty', 'ondine' → 'Misty', 'lt surge' → 'Lt. Surge'
const NAME_TO_CANONICAL = new Map();
for (const t of TRAINER_CHARACTERS) {
  NAME_TO_CANONICAL.set(normalize(t.en), t.en);
  if (t.fr) NAME_TO_CANONICAL.set(normalize(t.fr), t.en);
  if (t.aliases) for (const a of t.aliases) NAME_TO_CANONICAL.set(normalize(a), t.en);
}

// Lookup EN → FR for query localization downstream.
const EN_TO_FR = new Map();
for (const t of TRAINER_CHARACTERS) EN_TO_FR.set(t.en, t.fr);

// Returns the canonical EN name of any trainer found in the text, or null.
// Word-boundary matched (so "Bea" doesn't fire on "Beach", "N" doesn't fire
// on every word).
function findTrainerInText(text) {
  if (!text) return null;
  const norm = ' ' + normalize(text) + ' ';
  // Iterate longest-name-first so multi-word names ("Lt Surge", "Crasher Wake")
  // win over their substrings.
  const sortedKeys = [...NAME_TO_CANONICAL.keys()].sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    // Single-letter names like "N" are too noisy to match by substring alone —
    // require either a possessive ("N's") or a clear word boundary. Skip them
    // here; the possessive helper below handles them.
    if (key.length < 2) continue;
    const re = new RegExp('(?:^|[^a-z0-9])' + key.replace(/\./g, '\\.?').replace(/\s+/g, '\\s+') + '(?:[^a-z0-9]|$)');
    if (re.test(norm)) return NAME_TO_CANONICAL.get(key);
  }
  return null;
}

// Possessive pattern detection:
//   EN: "Misty's Spirit", "Erika's Welcome"
//   FR: "L'Esprit d'Ondine", "de Ondine", "d'Erika"
// Returns the canonical EN trainer name if a possessive structure is found,
// else null. Stronger signal than findTrainerInText alone because it implies
// a Supporter-card title structure.
function findPossessiveTrainer(text) {
  if (!text) return null;
  // EN: "<Name>'s "  (Misty's, Erika's, Lt Surge's, etc.)
  const enMatches = text.match(/\b([A-Z][a-zA-Zé.\s]{1,20}?)'s\s+/g);
  if (enMatches) {
    for (const m of enMatches) {
      const name = m.replace(/'s\s+$/, '').trim();
      const canonical = NAME_TO_CANONICAL.get(normalize(name));
      if (canonical) return canonical;
    }
  }
  // FR: "de <Name>" / "du <Name>" (with space) OR "d'<Name>" (no space —
  // elision in French). Both forms appear on Pokémon TCG French listings:
  // "La Puissance de Cynthia", "L'Esprit d'Ondine".
  const frMatches = text.match(/\b(?:de\s+|d['']\s*|du\s+)([A-ZÉÈÀÇ][a-zA-ZéèàçôûîïâäëöùÉÈÀÇ.\s]{1,20})/g);
  if (frMatches) {
    for (const m of frMatches) {
      const name = m.replace(/^(?:de\s+|d['']\s*|du\s+)/, '').trim();
      const canonical = NAME_TO_CANONICAL.get(normalize(name));
      if (canonical) return canonical;
    }
  }
  return null;
}

// Trainer-card keyword detection — confirms it's a Trainer/Supporter card,
// not a Pokémon. Used to suppress fallback when we're clearly NOT on a
// trainer card (e.g. "Mewtwo ex" titles).
const TRAINER_KEYWORDS_RE = /\b(supporter|trainer|carte\s+dresseur|dresseur|stadium|stade|outil(?:\s+pok[ée]mon)?|tool|item)\b/i;

function hasTrainerKeyword(text) {
  return !!text && TRAINER_KEYWORDS_RE.test(text);
}

// Main entry point — given a list of Lens visual matches, decide if this
// scan looks like a Trainer card and return the canonical character + the
// most-confident card number found alongside.
// Returns { character_en, character_fr, card_number } or null.
//
// Strategy:
//   1. Walk top-N matches, count trainer-name + possessive-pattern signals
//   2. If at least one match has a possessive trainer pattern OR multiple
//      matches independently mention the same trainer → it's a trainer card
//   3. Pick the card_number from any match that mentions the winning trainer
function detectTrainerCard(visualMatches, language = 'EN', { topN = 15 } = {}) {
  const matches = (visualMatches || []).slice(0, topN);
  if (matches.length === 0) return null;

  const trainerVotes = {};                  // canonical_en → count
  const trainerNumbers = {};                // canonical_en → first card_number found
  let possessiveHit = null;                 // canonical_en if any title has possessive structure

  const cardNumRe = /\b(\d{1,4}\s*\/\s*\d{1,4})\b/;

  for (const m of matches) {
    const title = (m && m.title) || '';
    if (!title) continue;

    // Trainer name detection
    const possessive = findPossessiveTrainer(title);
    const trainer = possessive || findTrainerInText(title);
    if (!trainer) continue;

    // If we found a possessive structure, that's a strong signal — record it.
    if (possessive && !possessiveHit) possessiveHit = possessive;

    trainerVotes[trainer] = (trainerVotes[trainer] || 0) + 1;

    // Extract card number from the same title
    if (!trainerNumbers[trainer]) {
      const numMatch = title.match(cardNumRe);
      if (numMatch) {
        const [a, b] = numMatch[1].split(/\s*\/\s*/);
        trainerNumbers[trainer] = `${parseInt(a, 10)}/${parseInt(b, 10)}`;
      }
    }
  }

  // Pick the most-voted trainer
  const entries = Object.entries(trainerVotes).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const [winner, votes] = entries[0];

  // Confidence gate:
  //   - Strong signal: possessive pattern present (1 hit is enough)
  //   - Weaker: ≥2 matches mention the same trainer name
  // Otherwise reject — too risky to flip Pokémon scans into trainer detection
  // off a single ambiguous mention.
  const isConfident = possessiveHit === winner || votes >= 2;
  if (!isConfident) return null;

  const character_fr = EN_TO_FR.get(winner) || winner;
  return {
    character_en: winner,
    character_fr,
    card_number: trainerNumbers[winner] || null,
    votes,
    via: possessiveHit === winner ? 'possessive' : 'vote',
  };
}

module.exports = {
  TRAINER_CHARACTERS,
  detectTrainerCard,
  findTrainerInText,
  findPossessiveTrainer,
  hasTrainerKeyword,
  EN_TO_FR,
};
