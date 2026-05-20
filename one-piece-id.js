'use strict';
// One Piece TCG identification — extracts character + card number + rarity
// from a Google Lens visualMatches result so we can build a clean eBay query.
//
// Mirrors the pattern used by pokemon-names.js / extractPokemonFromMatches.
// Same input shape (array of {title, ...}), same vote-based consensus, same
// "≥2 matches must agree" confidence threshold.
//
// Card-number formats recognized (One Piece Card Game / OPCG):
//   OP01-001 … OP13-xxx     standard booster sets
//   EB01-001 … EB02-xxx     extension boosters
//   ST01-001 … ST26-xxx     starter decks
//   P-001    … P-099        promo cards
// Sometimes printed compactly as "OP01001" or with extra slashes — regex
// tolerates both.

// Modern OPCG format: 2-digit set + 3-digit card. Loose matching ("OP01-1")
// was producing wrong set numbers via greedy backtracking ("OP01001" →
// setNum:10 instead of setNum:01). Require the 2+3 structure.
//
// Separators are tolerant — sellers write the same number many ways:
//   "OP05-119" "OP05 119" "OP05/119" "OP05119" "OP-05 119" "OP-05-119"
// So allow [space|dash] after the prefix and [space|dash|slash] between
// the set-num and card-num. Missing these forms silently dropped real
// votes (an "OP-05 119" / "OP05/119" Luffy lost the vote to OP09-119).
//
// Also matches vintage Carddass / Hyper Battle formats (Bandai 2001-2010):
//   H18, S111, PR-001 — short prefix + 1-3 digits, no set code.
const CARD_NUMBER_RE = /\b(OP|EB|ST|PRB)[\s-]*(\d{2})[\s\-/]*(\d{3})\b|\bP\s*-\s*(\d{1,3})\b|\b(H|S|PR|HB)\s*-?\s*(\d{1,3})\b/i;

// Rarities printed on OP cards. Order matters — more specific patterns first
// so "Manga Rare" doesn't get caught by the bare "R" match.
const RARITY_PATTERNS = [
  { re: /\bManga\s*Rare\b/i,            value: 'Manga Rare' },
  { re: /\bAlternat(?:e|ive)\s*Art\b/i, value: 'AA' },
  { re: /\bAA\s*(?:Art)?\b/i,           value: 'AA' },
  { re: /\bSecret\s*Rare\b|\bSEC\b/i,   value: 'SEC' },
  { re: /\bSuper\s*Rare\b|\bSR\b/i,     value: 'SR' },
  { re: /\bLeader\b/i,                  value: 'L' },   // L is too short to match safely on its own
  { re: /\bSpecial\s*Card\b|\bSP\b/i,   value: 'SP' },
  { re: /\bUncommon\b|\bUC\b/i,         value: 'UC' },
  { re: /\bRare\b|\bR\b/i,              value: 'R' },
  { re: /\bCommon\b|\bC\b/i,            value: 'C' },
];

const COLOR_RE = /\b(Red|Green|Blue|Purple|Yellow|Black)\b/i;

// Words/phrases to strip from titles before extracting the character name.
// Applied as a regex on the whole string (so multi-word phrases like "One Piece"
// or "Manga Rare" come out cleanly, not just individual tokens). Order matters
// — multi-word phrases come first so they don't get partially matched.
const NOISE_PATTERNS = [
  /\bOne\s*Piece\b/gi, /\bManga\s*Rare\b/gi, /\bAlternat(?:e|ive)\s*Art\b/gi,
  /\bRomance\s*Dawn\b/gi, /\bParamount\s*War\b/gi, /\bWano\b/gi,
  /\bCard\s*Game\b/gi, /\bNear\s*Mint\b/gi, /\bGem\s*Mint\b/gi,
  // Single words
  /\b(TCG|OPCG|Bandai|Card|Cards|Game|English|Japanese|Eng|JP|EN|FR|Carte|Pokemon|Pokémon)\b/gi,
  /\b(SEC|SR|UC|SP|AA|Leader|Rare|Common|Uncommon|Holographic|Holo|Foil|Mint|Booster|Pack|Set|Starter|Extension|Promo)\b/gi,
  /\b(PSA|CGC|BGS|SGC|ACE|PCA|Graded|Slab)\b/gi,
  /\b(Red|Green|Blue|Purple|Yellow|Black)\b/gi,
  /\b(NM|LP|MP|HP|DM)\b/g,  // condition codes
];

// Vote helper — given an array of strings, returns the most frequent one if it
// appeared ≥ minVotes times, else null. Ties broken by first occurrence.
function voteMajority(values, minVotes = 2) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return bestCount >= minVotes ? best : null;
}

// Same as voteMajority but returns { value, count }. Used when the caller
// needs to weigh confidence (e.g. "trust Lens over Gemini when ≥3 matches agree").
function voteMajorityWithCount(values, minVotes = 2) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  if (bestCount < minVotes) return { value: null, count: 0 };
  return { value: best, count: bestCount };
}

// Normalize an OP card number to canonical "OP01-001" / "ST01-001" / "P-001"
// form regardless of how the source wrote it ("OP01001", "op-1-001", etc.).
function normalizeCardNumber(rawMatch) {
  if (!rawMatch) return null;
  const m = String(rawMatch).match(CARD_NUMBER_RE);
  if (!m) return null;
  // Promo (modern): m[4] is the 1-3 digit promo number
  if (m[4]) return 'P-' + String(m[4]).padStart(3, '0');
  // Vintage Carddass: m[5]=H/S/PR/HB, m[6]=number. Don't pad — vintage
  // numbers are usually shown as printed ('H18' not 'H018').
  if (m[5]) return m[5].toUpperCase() + m[6];
  // Modern set card: m[1]=OP/EB/ST, m[2]=2-digit setnum, m[3]=3-digit cardnum
  return `${m[1].toUpperCase()}${m[2]}-${m[3]}`;
}

// Normalize a character name for vote consensus — strip middle-initial
// periods, collapse whitespace, lowercase. Means "Monkey D. Luffy" /
// "Monkey.D.Luffy" / "Monkey D Luffy" all vote for the same value.
// Returns the normalized form used for vote keys; pretty-cased version is
// reconstructed for display.
function normalizeCharacterName(name) {
  if (!name) return null;
  return String(name)
    .replace(/\./g, ' ')              // "Monkey.D.Luffy" → "Monkey D Luffy"
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim()
    .toLowerCase();
}

// Pretty-case a normalized name back for display: title case each word.
function titleCaseName(name) {
  if (!name) return null;
  return name.split(' ').map(w => w.length <= 1 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Extract the most likely character name from a Lens title.
// Strategy: strip everything we KNOW isn't part of the name (card numbers,
// rarity words, game/publisher/lang/condition noise), then take the longest
// contiguous run of "name-like" tokens (capitalized words OR middle initials
// like "D" / "D."). Normalize middle-initial periods so "Monkey D. Luffy"
// votes the same as "Monkey D Luffy" — that's the most common cross-source
// variation and we don't want it to split votes.
function extractCharacterFromTitle(title /*, cardNumber */) {
  if (!title) return null;
  let cleaned = String(title);
  // 1. Strip card numbers (anywhere in the string)
  cleaned = cleaned.replace(CARD_NUMBER_RE, ' ');
  // 2. Strip game/publisher/rarity/color/condition noise
  for (const re of NOISE_PATTERNS) cleaned = cleaned.replace(re, ' ');
  // 3. Tokenize on non-letter/period/ampersand boundaries
  const tokens = cleaned.split(/[^\p{L}.&]+/u).filter(Boolean);
  // 4. Build runs of capitalized tokens + middle initials
  const runs = [];
  let current = [];
  for (const t of tokens) {
    const isCapitalized = /^[A-ZÀ-Ý]/.test(t);
    const isInitial     = /^[A-Z]\.?$/.test(t);  // "D" or "D."
    if (isCapitalized || isInitial || t === '&') {
      current.push(t);
    } else if (current.length) {
      runs.push(current); current = [];
    }
  }
  if (current.length) runs.push(current);
  if (!runs.length) return null;
  // 5. Pick longest run (token count, then char length)
  runs.sort((a, b) => b.length - a.length || b.join(' ').length - a.join(' ').length);
  // 6. Normalize trailing periods on initials so "D." == "D" for vote purposes
  const name = runs[0].map(t => t.replace(/\.$/, '')).join(' ').trim();
  if (name.length < 3) return null;
  return name;
}

// Extract rarity from a Lens title. Returns canonical token (SR / SEC / AA / L
// etc.) or null.
function extractRarityFromTitle(title) {
  if (!title) return null;
  for (const { re, value } of RARITY_PATTERNS) {
    if (re.test(title)) return value;
  }
  return null;
}

function extractColorFromTitle(title) {
  if (!title) return null;
  const m = (title || '').match(COLOR_RE);
  return m ? m[1] : null;
}

// Main: given Lens visualMatches, vote across the top N to extract a confident
// {card_number, character, rarity, color}. Anything with fewer than 2 agreeing
// matches stays null — caller decides whether to fall back or return NO_DATA.
function extractOnePieceFromMatches(visualMatches, topN = 15) {
  const matches = (Array.isArray(visualMatches) ? visualMatches : []).slice(0, topN);
  const numbers    = [];
  const characters = [];
  const rarities   = [];
  const colors     = [];
  for (const m of matches) {
    const title = (m && m.title) || '';
    const numMatch = title.match(CARD_NUMBER_RE);
    const cardNumber = normalizeCardNumber(numMatch ? numMatch[0] : null);
    if (cardNumber) numbers.push(cardNumber);
    const character = extractCharacterFromTitle(title, cardNumber);
    // Normalize for vote: 'Monkey.D.Luffy', 'Monkey D. Luffy', and
    // 'Monkey D Luffy' all become the same key, so votes don't split
    // across spelling variants.
    if (character) characters.push(normalizeCharacterName(character));
    const rarity = extractRarityFromTitle(title);
    if (rarity) rarities.push(rarity);
    const color = extractColorFromTitle(title);
    if (color) colors.push(color);
  }
  const winnerChar = voteMajority(characters, 2);
  const numberVote = voteMajorityWithCount(numbers, 2);
  return {
    card_number: numberVote.value,
    card_number_votes: numberVote.count,   // exposed so callers can weigh confidence (Gemini-vs-Lens tiebreaks)
    character:   winnerChar ? titleCaseName(winnerChar) : null,  // pretty-cased for display + query
    rarity:      voteMajority(rarities,   2),
    color:       voteMajority(colors,     2),
  };
}

// Build an eBay search query from the extracted identity. We deliberately keep
// it short: character + card number is the most reliable combo. Rarity helps
// for variant disambiguation (AA, SR, etc.) when available.
function buildOnePieceQuery(identity) {
  const i = identity || {};
  const parts = [];
  if (i.character)   parts.push(i.character);
  if (i.card_number) parts.push(i.card_number);
  if (i.rarity && (i.rarity === 'AA' || i.rarity === 'SEC' || i.rarity === 'Manga Rare')) {
    // Only append rarity when it's a high-stakes variant marker. Including
    // "SR" or "R" tends to narrow too aggressively without helping price.
    parts.push(i.rarity);
  }
  return parts.filter(Boolean).join(' ').trim();
}

module.exports = {
  CARD_NUMBER_RE,
  RARITY_PATTERNS,
  voteMajority,
  voteMajorityWithCount,
  normalizeCardNumber,
  normalizeCharacterName,
  titleCaseName,
  extractCharacterFromTitle,
  extractRarityFromTitle,
  extractColorFromTitle,
  extractOnePieceFromMatches,
  buildOnePieceQuery,
};
