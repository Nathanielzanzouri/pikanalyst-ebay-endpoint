// Auto-generated from pokemontcg.io — 172 Pokemon TCG sets
// Format: [set_code, set_name, series_name]
const POKEMON_SETS = [["base1", "Base", "Base"], ["base2", "Jungle", "Base"], ["basep", "Wizards Black Star Promos", "Base"], ["base3", "Fossil", "Base"], ["base4", "Base Set 2", "Base"], ["base5", "Team Rocket", "Base"], ["gym1", "Gym Heroes", "Gym"], ["gym2", "Gym Challenge", "Gym"], ["neo1", "Neo Genesis", "Neo"], ["neo2", "Neo Discovery", "Neo"], ["si1", "Southern Islands", "Other"], ["neo3", "Neo Revelation", "Neo"], ["neo4", "Neo Destiny", "Neo"], ["base6", "Legendary Collection", "Other"], ["ecard1", "Expedition Base Set", "E-Card"], ["bp", "Best of Game", "Other"], ["ecard2", "Aquapolis", "E-Card"], ["ecard3", "Skyridge", "E-Card"], ["ex1", "Ruby & Sapphire", "EX"], ["ex2", "Sandstorm", "EX"], ["np", "Nintendo Black Star Promos", "NP"], ["ex3", "Dragon", "EX"], ["ex4", "Team Magma vs Team Aqua", "EX"], ["ex5", "Hidden Legends", "EX"], ["tk1b", "EX Trainer Kit Latios", "EX"], ["tk1a", "EX Trainer Kit Latias", "EX"], ["ex6", "FireRed & LeafGreen", "EX"], ["pop1", "POP Series 1", "POP"], ["ex7", "Team Rocket Returns", "EX"], ["ex8", "Deoxys", "EX"], ["ex9", "Emerald", "EX"], ["ex10", "Unseen Forces", "EX"], ["pop2", "POP Series 2", "POP"], ["ex11", "Delta Species", "EX"], ["ex12", "Legend Maker", "EX"], ["tk2b", "EX Trainer Kit 2 Minun", "EX"], ["tk2a", "EX Trainer Kit 2 Plusle", "EX"], ["pop3", "POP Series 3", "POP"], ["ex13", "Holon Phantoms", "EX"], ["ex14", "Crystal Guardians", "EX"], ["pop4", "POP Series 4", "POP"], ["ex15", "Dragon Frontiers", "EX"], ["ex16", "Power Keepers", "EX"], ["pop5", "POP Series 5", "POP"], ["dp1", "Diamond & Pearl", "Diamond & Pearl"], ["dpp", "DP Black Star Promos", "Diamond & Pearl"], ["dp2", "Mysterious Treasures", "Diamond & Pearl"], ["pop6", "POP Series 6", "POP"], ["dp3", "Secret Wonders", "Diamond & Pearl"], ["dp4", "Great Encounters", "Diamond & Pearl"], ["pop7", "POP Series 7", "POP"], ["dp5", "Majestic Dawn", "Diamond & Pearl"], ["dp6", "Legends Awakened", "Diamond & Pearl"], ["pop8", "POP Series 8", "POP"], ["dp7", "Stormfront", "Diamond & Pearl"], ["pl1", "Platinum", "Platinum"], ["pop9", "POP Series 9", "POP"], ["pl2", "Rising Rivals", "Platinum"], ["pl3", "Supreme Victors", "Platinum"], ["pl4", "Arceus", "Platinum"], ["ru1", "Pokémon Rumble", "Other"], ["hgss1", "HeartGold & SoulSilver", "HeartGold & SoulSilver"], ["hsp", "HGSS Black Star Promos", "HeartGold & SoulSilver"], ["hgss2", "HS—Unleashed", "HeartGold & SoulSilver"], ["hgss3", "HS—Undaunted", "HeartGold & SoulSilver"], ["hgss4", "HS—Triumphant", "HeartGold & SoulSilver"], ["col1", "Call of Legends", "HeartGold & SoulSilver"], ["bwp", "BW Black Star Promos", "Black & White"], ["bw1", "Black & White", "Black & White"], ["mcd11", "McDonald's Collection 2011", "Other"], ["bw2", "Emerging Powers", "Black & White"], ["bw3", "Noble Victories", "Black & White"], ["bw4", "Next Destinies", "Black & White"], ["bw5", "Dark Explorers", "Black & White"], ["mcd12", "McDonald's Collection 2012", "Other"], ["bw6", "Dragons Exalted", "Black & White"], ["dv1", "Dragon Vault", "Black & White"], ["bw7", "Boundaries Crossed", "Black & White"], ["bw8", "Plasma Storm", "Black & White"], ["bw9", "Plasma Freeze", "Black & White"], ["bw10", "Plasma Blast", "Black & White"], ["xyp", "XY Black Star Promos", "XY"], ["bw11", "Legendary Treasures", "Black & White"], ["xy0", "Kalos Starter Set", "XY"], ["xy1", "XY", "XY"], ["xy2", "Flashfire", "XY"], ["mcd14", "McDonald's Collection 2014", "Other"], ["xy3", "Furious Fists", "XY"], ["xy4", "Phantom Forces", "XY"], ["xy5", "Primal Clash", "XY"], ["dc1", "Double Crisis", "XY"], ["xy6", "Roaring Skies", "XY"], ["xy7", "Ancient Origins", "XY"], ["xy8", "BREAKthrough", "XY"], ["mcd15", "McDonald's Collection 2015", "Other"], ["xy9", "BREAKpoint", "XY"], ["g1", "Generations", "XY"], ["xy10", "Fates Collide", "XY"], ["xy11", "Steam Siege", "XY"], ["mcd16", "McDonald's Collection 2016", "Other"], ["xy12", "Evolutions", "XY"], ["sm1", "Sun & Moon", "Sun & Moon"], ["smp", "SM Black Star Promos", "Sun & Moon"], ["sm2", "Guardians Rising", "Sun & Moon"], ["sm3", "Burning Shadows", "Sun & Moon"], ["sm35", "Shining Legends", "Sun & Moon"], ["sm4", "Crimson Invasion", "Sun & Moon"], ["mcd17", "McDonald's Collection 2017", "Other"], ["sm5", "Ultra Prism", "Sun & Moon"], ["sm6", "Forbidden Light", "Sun & Moon"], ["sm7", "Celestial Storm", "Sun & Moon"], ["sm75", "Dragon Majesty", "Sun & Moon"], ["mcd18", "McDonald's Collection 2018", "Other"], ["sm8", "Lost Thunder", "Sun & Moon"], ["sm9", "Team Up", "Sun & Moon"], ["det1", "Detective Pikachu", "Sun & Moon"], ["sm10", "Unbroken Bonds", "Sun & Moon"], ["sm11", "Unified Minds", "Sun & Moon"], ["sma", "Hidden Fates Shiny Vault", "Sun & Moon"], ["sm115", "Hidden Fates", "Sun & Moon"], ["mcd19", "McDonald's Collection 2019", "Other"], ["sm12", "Cosmic Eclipse", "Sun & Moon"], ["swshp", "SWSH Black Star Promos", "Sword & Shield"], ["swsh1", "Sword & Shield", "Sword & Shield"], ["swsh2", "Rebel Clash", "Sword & Shield"], ["swsh3", "Darkness Ablaze", "Sword & Shield"], ["fut20", "Pokémon Futsal Collection", "Other"], ["swsh35", "Champion's Path", "Sword & Shield"], ["swsh4", "Vivid Voltage", "Sword & Shield"], ["mcd21", "McDonald's Collection 2021", "Other"], ["swsh45sv", "Shining Fates Shiny Vault", "Sword & Shield"], ["swsh45", "Shining Fates", "Sword & Shield"], ["swsh5", "Battle Styles", "Sword & Shield"], ["swsh6", "Chilling Reign", "Sword & Shield"], ["swsh7", "Evolving Skies", "Sword & Shield"], ["cel25c", "Celebrations: Classic Collection", "Sword & Shield"], ["cel25", "Celebrations", "Sword & Shield"], ["swsh8", "Fusion Strike", "Sword & Shield"], ["swsh9tg", "Brilliant Stars Trainer Gallery", "Sword & Shield"], ["swsh9", "Brilliant Stars", "Sword & Shield"], ["swsh10", "Astral Radiance", "Sword & Shield"], ["swsh10tg", "Astral Radiance Trainer Gallery", "Sword & Shield"], ["pgo", "Pokémon GO", "Sword & Shield"], ["mcd22", "McDonald's Collection 2022", "Other"], ["swsh11", "Lost Origin", "Sword & Shield"], ["swsh11tg", "Lost Origin Trainer Gallery", "Sword & Shield"], ["swsh12", "Silver Tempest", "Sword & Shield"], ["swsh12tg", "Silver Tempest Trainer Gallery", "Sword & Shield"], ["svp", "Scarlet & Violet Black Star Promos", "Scarlet & Violet"], ["swsh12pt5", "Crown Zenith", "Sword & Shield"], ["swsh12pt5gg", "Crown Zenith Galarian Gallery", "Sword & Shield"], ["sv1", "Scarlet & Violet", "Scarlet & Violet"], ["sve", "Scarlet & Violet Energies", "Scarlet & Violet"], ["sv2", "Paldea Evolved", "Scarlet & Violet"], ["sv3", "Obsidian Flames", "Scarlet & Violet"], ["sv3pt5", "151", "Scarlet & Violet"], ["sv4", "Paradox Rift", "Scarlet & Violet"], ["sv4pt5", "Paldean Fates", "Scarlet & Violet"], ["sv5", "Temporal Forces", "Scarlet & Violet"], ["sv6", "Twilight Masquerade", "Scarlet & Violet"], ["sv6pt5", "Shrouded Fable", "Scarlet & Violet"], ["sv7", "Stellar Crown", "Scarlet & Violet"], ["sv8", "Surging Sparks", "Scarlet & Violet"], ["sv8pt5", "Prismatic Evolutions", "Scarlet & Violet"], ["sv9", "Journey Together", "Scarlet & Violet"], ["sv10", "Destined Rivals", "Scarlet & Violet"], ["zsv10pt5", "Black Bolt", "Scarlet & Violet"], ["rsv10pt5", "White Flare", "Scarlet & Violet"], ["me1", "Mega Evolution", "Mega Evolution"], ["me2", "Phantasmal Flames", "Mega Evolution"], ["me2pt5", "Ascended Heroes", "Mega Evolution"], ["me3", "Perfect Order", "Mega Evolution"]];

// Set names for matching (exclude short/ambiguous names)
const _setNameMap = new Map();
POKEMON_SETS.forEach(([code, name, series]) => {
  if (name.length >= 3) _setNameMap.set(name.toLowerCase(), { code, name, series });
});

// Short set names that are OK to match (with word boundary check)
const SHORT_OK = new Set(['151', 'xy', 'xY']);

function findSetInText(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  let best = null;
  for (const [setName, info] of _setNameMap) {
    // Skip very short names unless they're in the whitelist
    if (setName.length < 4 && !SHORT_OK.has(setName)) continue;
    // For short names, use word boundary check
    if (setName.length < 5) {
      const re = new RegExp('\\b' + setName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (!re.test(text)) continue;
    } else {
      if (!lower.includes(setName)) continue;
    }
    if (!best || setName.length > best.matchLen) {
      best = { ...info, matchLen: setName.length };
    }
  }
  return best ? { code: best.code, name: best.name, series: best.series } : null;
}

// ─── Multi-set picker support (vintage cards reprinted across sets) ──────────
// extractPokemonFromMatches already picks ONE winning set from Lens votes —
// good for non-ambiguous cards. For vintage cards reprinted across multiple
// sets (Charizard 4/102 in Base Set vs Celebrations, Snorlax in Jungle vs
// Base Set 2, etc.), we need the full candidate distribution so the
// sidepanel can show a picker. This is the Pokemon analog of OP's variant
// picker — same UI, different disambiguation dimension (set instead of variant).

// Vote across Lens top-N titles for set candidates. Returns ALL sets that
// appear at least `minMentions` times, sorted by mention count desc.
// Caller uses array length to decide whether to trigger the picker
// (length >= 2 = multi-set ambiguity).
function getSetCandidates(visualMatches, { topN = 15, minMentions = 2 } = {}) {
  const votes = new Map();
  for (const m of (visualMatches || []).slice(0, topN)) {
    const setInfo = findSetInText((m && m.title) || '');
    if (!setInfo) continue;
    if (!votes.has(setInfo.code)) votes.set(setInfo.code, { ...setInfo, count: 0 });
    votes.get(setInfo.code).count++;
  }
  return [...votes.values()]
    .filter(v => v.count >= minMentions)
    .sort((a, b) => b.count - a.count);
}

// Bucket eBay listings into the candidate sets by detecting the set name in
// each listing's title. Listings whose title doesn't mention any known set
// fall into the "ambiguous" bin and we attach them to the top-voted bucket
// (so they aren't lost — sellers often omit the set name in titles).
function bucketListingsBySet(listings, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const buckets = candidates.map(c => ({ ...c, _listings: [] }));
  const ambiguous = [];
  for (const l of (listings || [])) {
    const setInfo = findSetInText(((l && l.title) || ''));
    if (!setInfo) { ambiguous.push(l); continue; }
    // Match on code OR name-overlap. Pokemon's set catalog has cousin codes
    // ("cel25" Celebrations vs "cel25c" Celebrations: Classic Collection)
    // that refer to the same set family. eBay sellers rarely write the full
    // "Celebrations: Classic Collection" — they just say "Celebrations" —
    // so strict code match would lose those listings to the ambiguous bin.
    const sn = (setInfo.name || '').toLowerCase();
    const target = buckets.find(b => {
      if (b.code === setInfo.code) return true;
      const bn = (b.name || '').toLowerCase();
      return bn === sn || bn.startsWith(sn) || sn.startsWith(bn);
    });
    if (target) target._listings.push(l);
    else ambiguous.push(l);   // matched a set not in our candidate list
  }
  // Hand ambiguous listings to the top-voted bucket — they likely belong
  // there since sellers default to omitting set name on the most common print.
  if (ambiguous.length && buckets.length) buckets[0]._listings.push(...ambiguous);

  return buckets.map((b, i) => {
    const prices = b._listings.map(l => l.price).filter(p => typeof p === 'number' && p > 0).sort((a, c) => a - c);
    const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
    const firstImg = b._listings.find(l => l && l.imageUrl);
    return {
      id:        'set-' + b.code,
      label:     b.name,           // e.g. "Base Set", "Celebrations", "Jungle"
      sublabel:  b.series,         // e.g. "Base", "Sword & Shield"
      price:     median,
      priceMin:  prices[0] || null,
      priceMax:  prices[prices.length - 1] || null,
      count:     b._listings.length,
      imageUrl:  firstImg ? firstImg.imageUrl : null,   // eBay thumb — not authoritative, but recognizable
      sampleTitle: (b._listings[0] && b._listings[0].title) || b.name,
      tcg_ref_usd: null,           // could enrich from pokemontcg.io later
      listings:  b._listings,
    };
  });
}

// For a given candidate set, find the most-cited card_number that co-occurs
// with that set in Lens match titles. Used to build a per-set eBay query
// when the user taps a picker tile (Flow A — ask first, then query).
// Returns "27/64" / "4/102" / null. Picks the most-frequent number across
// Lens titles that mention the set's name, so "Snorlax + Jungle" resolves
// to "27/64" (the non-holo Rare) since that's the most common reprint.
function getNumberForSet(visualMatches, setName, { topN = 15 } = {}) {
  if (!setName) return null;
  const counts = new Map();
  const setLower = String(setName).toLowerCase();
  for (const m of (visualMatches || []).slice(0, topN)) {
    const title = ((m && m.title) || '').toLowerCase();
    if (!title.includes(setLower)) continue;
    const nums = title.match(/\b\d{1,3}\/\d{1,3}\b/g) || [];
    for (const n of nums) counts.set(n, (counts.get(n) || 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Find a representative thumbnail for a candidate set — first Lens match that
// mentions the set name AND has a thumbnail. Used to populate the picker
// tile image when we haven't yet fired an eBay query (so no listing images
// to draw from).
function getThumbForSet(visualMatches, setName, { topN = 15 } = {}) {
  if (!setName) return null;
  const setLower = String(setName).toLowerCase();
  for (const m of (visualMatches || []).slice(0, topN)) {
    const title = ((m && m.title) || '').toLowerCase();
    if (!title.includes(setLower)) continue;
    if (m && m.thumbnail) return m.thumbnail;
  }
  return null;
}

// JP era-suffix candidates — Japanese Pokemon promos disambiguate by ERA
// (SV-P / XY-P / BW-P / DP-P / PCG-P) more than by set name. Detective Pikachu
// 098/SV-P and Mega Tokyo's Pikachu 098/XY-P share the same number "098" but
// belong to different eras and trade at very different prices. The Western-set
// picker (getSetCandidates) can't disambiguate these — they don't carry Western
// set names. This detector groups Lens matches by era suffix instead.
function getJpEraCandidates(visualMatches, { topN = 15, minMentions = 2 } = {}) {
  const eraRe = /\b(\d{1,3})\s*\/\s*(SV|XY|BW|DP|HGSS|SM|PCG|HS)-?P\b/i;
  const groups = new Map();   // era → { era, count, sampleNumber, sample_title }
  for (const m of (visualMatches || []).slice(0, topN)) {
    const title = (m && m.title) || '';
    const match = title.match(eraRe);
    if (!match) continue;
    const era = match[2].toUpperCase() + '-P';
    const num = match[1].padStart(3, '0') + '/' + era;
    if (!groups.has(era)) groups.set(era, { era, count: 0, sampleNumber: num, sample_title: title });
    groups.get(era).count++;
  }
  return [...groups.values()]
    .filter(g => g.count >= minMentions)
    .sort((a, b) => b.count - a.count);
}

// Representative thumbnail for a JP era — first Lens match whose title mentions
// the era suffix AND carries a thumbnail. Mirrors getThumbForSet for Western
// sets so the picker tile UI works identically across both code paths.
function getThumbForJpEra(visualMatches, era, { topN = 15 } = {}) {
  if (!era) return null;
  const eraUpper = era.toUpperCase();
  for (const m of (visualMatches || []).slice(0, topN)) {
    const title = ((m && m.title) || '').toUpperCase();
    if (title.includes(eraUpper) && m && m.thumbnail) return m.thumbnail;
  }
  return null;
}

// Card-number candidates — the most robust multi-printing detector. Groups
// Lens match titles by the card number itself (X/Y like "11/102", or JP
// vintage "No.034"). Different printings of the same Pokemon almost always
// carry different numbers (Nidoking: 11/102 Base / No.034 Expansion Pack /
// 45/108 Evolutions), so number-grouping surfaces a picker even when set
// names aren't recognizable. The one case it can't split is same-number-
// different-set (Charizard 4/102 Base vs Celebrations) — set-name grouping
// handles that as the fallback.
function getNumberCandidates(visualMatches, { topN = 15, minMentions = 2 } = {}) {
  const groups = new Map();   // number → { number, count, sample_title }
  for (const m of (visualMatches || []).slice(0, topN)) {
    const title = (m && m.title) || '';
    let num = null;
    const xy = title.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/);   // "11/102"
    if (xy) {
      // Strip leading zeros so "020/159" and "20/159" — the same printing
      // written two ways — vote together instead of splitting into two
      // bogus picker tiles. The substring lookups in getThumbForNumber /
      // getSetNameForNumber already work against both written forms because
      // "020/159".includes("20/159") is true; we just needed to make the
      // group KEY match too.
      const a = String(parseInt(xy[1], 10));
      const b = String(parseInt(xy[2], 10));
      num = `${a}/${b}`;
    } else {
      // JP vintage "No.034" / "No. 034" / "N°034"
      const no = title.match(/\bN[o°]\.?\s*(\d{1,3})\b/i);
      if (no) num = `No.${no[1].padStart(3, '0')}`;
    }
    if (!num) continue;
    if (!groups.has(num)) groups.set(num, { number: num, count: 0, sample_title: title });
    groups.get(num).count++;
  }
  return [...groups.values()]
    .filter(g => g.count >= minMentions)
    .sort((a, b) => b.count - a.count);
}

// Representative thumbnail for a card number — first Lens match whose title
// contains that number AND carries a thumbnail.
function getThumbForNumber(visualMatches, number, { topN = 15 } = {}) {
  if (!number) return null;
  // Match the digits of the number loosely (ignore the "No." prefix / slashes)
  const digitsKey = String(number).replace(/[^0-9/]/g, '');
  for (const m of (visualMatches || []).slice(0, topN)) {
    const title = ((m && m.title) || '');
    if (title.replace(/\s/g, '').includes(digitsKey) && m && m.thumbnail) return m.thumbnail;
  }
  return null;
}

// Best-effort set name for a card number — runs findSetInText over the Lens
// titles that mention that number, returns the first hit. Used to give the
// picker tile a friendly label ("Base Set" instead of a bare "11/102").
function getSetNameForNumber(visualMatches, number, { topN = 15 } = {}) {
  if (!number) return null;
  const digitsKey = String(number).replace(/[^0-9/]/g, '');
  for (const m of (visualMatches || []).slice(0, topN)) {
    const title = ((m && m.title) || '');
    if (!title.replace(/\s/g, '').includes(digitsKey)) continue;
    const setInfo = findSetInText(title);
    if (setInfo) return setInfo.name;
  }
  return null;
}

// ─── Language signal helpers (for picker cross-language filtering) ───────────
// Why this exists: getNumberCandidates groups by raw card number, no awareness
// of the listing language. So a JP card scan (route lens-card-jp-vote-...)
// could surface a candidate that only exists in FR/EN listings as a separate
// picker tile, even though the user definitely doesn't have that printing in
// hand. The filter below uses the detected card language + the listing-title
// language signal to drop candidates that don't plausibly match the language
// the user is actually scanning.
//
// Reference scan: 7c11fb5c-06f5-4781-b1f3-3d91102eca10 (Évoli AR JP, where a
// FR-only 188/167 candidate was bogusly offered alongside the real 078/066).

// CJK characters (Hiragana U+3040-U+309F, Katakana U+30A0-U+30FF, Kanji /
// CJK Unified Ideographs U+4E00-U+9FAF) — any one is a strong JP signal.
// The range endpoints are written as literal CJK boundary chars in source —
// both forms match the same code points, this just reads more directly.
const JP_CHAR_RE = /[぀-ゟ゠-ヿ一-龯]/;
// Explicit Japanese keywords used in non-Japanese listings to describe a JP
// printing. Word-bounded to avoid matching substrings ("japon" only as a
// whole word — wouldn't want to false-positive on a misspelled token).
const JP_KEYWORD_RE = /\b(japanese|japonais|japonaise|japan|nihon|jpn|japonesa)\b/i;

function hasJapaneseSignal(text) {
  if (!text) return false;
  return JP_CHAR_RE.test(text) || JP_KEYWORD_RE.test(text);
}

// Filter picker candidates by detected card language. Drops candidates that
// don't plausibly match the language the user is scanning:
//   - language = 'JP'      → keep candidates with ≥1 JP-signal listing
//   - language = 'EN'/'FR' → keep candidates with ≥1 non-JP-signal listing
//                            (i.e. the card actually exists in a Western set)
//   - language = null/'WORLD' → no filter (caller hasn't decided yet)
// A candidate with zero matching titles is kept (we don't punish for absence
// of evidence — getThumbForNumber etc. already accept partial matches).
// Strip leading zeros from card-number tokens inside a title so substring
// searches match across padding variants — "078/066" ↔ "78/66". Same idea
// getNumberCandidates uses for grouping; we apply it here too so the filter's
// per-candidate title lookup actually finds the listings.
function stripLeadingZerosInNumbers(title) {
  return String(title).replace(/\b0*(\d{1,3})\s*\/\s*0*(\d{1,3})\b/g, '$1/$2');
}

function filterNumberCandidatesByLanguage(candidates, visualMatches, language, { topN = 15 } = {}) {
  if (!candidates || !candidates.length) return candidates || [];
  if (!language || language === 'WORLD') return candidates;
  const isJP = language === 'JP';
  const matches = (visualMatches || []).slice(0, topN);
  return candidates.filter(c => {
    const digitsKey = String(c.number).replace(/[^0-9/]/g, '');
    const titles = matches
      .map(m => (m && m.title) || '')
      .filter(t => stripLeadingZerosInNumbers(t).replace(/\s/g, '').includes(digitsKey));
    if (titles.length === 0) return true;     // no evidence → don't punish
    const jpHits = titles.filter(hasJapaneseSignal).length;
    return isJP
      ? jpHits >= 1                            // JP card needs ≥1 JP listing for this number
      : jpHits < titles.length;                // non-JP card needs ≥1 non-JP listing
  });
}

module.exports = { POKEMON_SETS, findSetInText, getSetCandidates, bucketListingsBySet, getNumberForSet, getThumbForSet, getJpEraCandidates, getThumbForJpEra, getNumberCandidates, getThumbForNumber, getSetNameForNumber, hasJapaneseSignal, filterNumberCandidatesByLanguage };