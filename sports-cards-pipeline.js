'use strict';
// Sports-cards pipeline v1 — specialised eBay-sold path for sports_card scans.
//
// Why a separate module: sports cards (NBA, NFL, soccer, F1, MMA) are indexed
// on eBay with a strict convention {year} {brand} {set} {player} #{n}
// {parallel} {grade} — but the generic estimation path (Gemini band + Google
// Shopping active listings) can't exploit that. The value of a sports card
// depends on details that a rough identification misses: rookie status,
// parallel color, serial numbering, autograph/patch, grade. This module reads
// the structured sports_* fields Gemini fills (see ai-product-vision.js) and
// runs a targeted eBay sold query with strict graded/raw segregation.
//
// Isolation:
// - Feature-flagged USE_SPORTS_CARDS_PIPELINE. Default false → sports_card
//   scans fall through to the existing generic path (ESTIMATION_RESULT).
// - Only fires when vision.category === "sports_card" AND Gemini returned
//   the minimum viable identification (player + year OR player + set).
// - Max 2 SerpApi calls per scan: Q1 (year + set + player + parallel + grade)
//   and Q2 (year + set + player + grade) if Q1 < 5 valid sales.
// - Failure → returns null so the caller can fall back cleanly.
//
// Non-goals (deliberate):
// - No metal-value floor (not applicable).
// - No condition buckets (graded/raw is segregated AT THE QUERY LEVEL, so
//   the returned sales are homogeneous by grade — a single stat block).
// - No card_number in queries (kills recall — sellers often omit it).
// - No card_brand in queries either (redundant with set, which is stronger).

const { fetchEbaySerpApi } = require('./price-serpapi');
const { toEur } = require('./price-stats');

// ─── Feature flag ────────────────────────────────────────────────────────
function isSportsCardsPipelineEnabled() {
  return String(process.env.USE_SPORTS_CARDS_PIPELINE || '').toLowerCase() === 'true';
}

// ─── Fallback field extraction ───────────────────────────────────────────
// Gemini consistently identifies the card correctly at the level of
// product_name / variant / shopping_query but leaves the dedicated
// sports_* fields empty ("" default from the schema when unsure).
// Instead of hoping the prompt convinces it, we regex-extract the
// pivot fields from the free-text fields it DID fill. Only touches
// fields that are currently empty — a value Gemini set explicitly
// always wins. Reference: scan 23553af8 (id_confidence 0.98 but
// pipeline returned "no query buildable").
const KNOWN_SETS = [
  'prizm', 'select', 'mosaic', 'optic', 'chrome', 'donruss', 'immaculate',
  'contenders', 'national treasures', 'flawless', 'obsidian', 'origins',
  'hoops', 'score', 'bowman', 'topps chrome', 'stadium club', 'sp authentic',
  'young guns', 'upper deck', 'futera', 'match attax', 'megacracks',
  'panini foot', 'panini world cup', 'playoff', 'skybox', 'pinnacle',
];
const KNOWN_BRANDS = [
  'panini', 'topps', 'upper deck', 'bowman', 'futera', 'bandai', 'leaf',
  'fleer', 'donruss', 'score', 'playoff', 'skybox', 'pinnacle',
];
// Parallel / color / grade tokens — end a "player name" sequence.
const PLAYER_STOP_TOKENS = new Set([
  'silver', 'gold', 'blue', 'red', 'green', 'yellow', 'orange', 'purple',
  'pink', 'black', 'white', 'bronze', 'ruby', 'sapphire', 'emerald', 'diamond',
  'refractor', 'auto', 'autograph', 'patch', 'holo', 'base', 'sparkle',
  'wave', 'shimmer', 'hyper', 'mojo', 'lazer', 'ice', 'camo', 'concourse',
  'psa', 'bgs', 'sgc', 'cgc', 'tag', 'ags', 'ace',
]);
const PLAYER_GENERIC = new Set([
  'carte', 'card', 'cards', 'nba', 'nfl', 'mlb', 'nhl', 'ufc',
  'rookie', 'rc', 'football', 'basketball', 'soccer', 'foot', 'baseball',
  'hockey', 'wemby', 'the', 'and', 'de', 'du', 'des', 'la', 'le', 'les',
]);

function enrichVisionFromText(vision) {
  const enriched = { ...vision };
  const bag = [vision.product_name, vision.variant, vision.shopping_query,
               vision.query_ebay, vision.display_title, vision.brand]
              .filter(Boolean).join(' ');
  const lowBag = bag.toLowerCase();

  // card_year — YYYY or YYYY-YY. Prefer 4-digit form matched with a
  // trailing "-YY" range so we don't grab a stray 2010 from a URL.
  if (!enriched.card_year) {
    const yearRange = bag.match(/\b(19|20)\d{2}\s*[-/]\s*\d{2}\b/);
    const yearSolo  = bag.match(/\b((?:19|20)\d{2})\b/);
    enriched.card_year = yearRange ? yearRange[0].replace(/\s+/g, '') :
                        (yearSolo  ? yearSolo[1] : '');
  }

  // card_brand — pick the first known brand present.
  if (!enriched.card_brand) {
    for (const b of KNOWN_BRANDS) {
      if (lowBag.includes(b)) { enriched.card_brand = b.charAt(0).toUpperCase() + b.slice(1); break; }
    }
  }

  // card_set — pick the first known set present. Match longest first
  // so "Topps Chrome" beats "Chrome" when both would qualify.
  if (!enriched.card_set) {
    const sorted = [...KNOWN_SETS].sort((a, b) => b.length - a.length);
    for (const s of sorted) {
      if (lowBag.includes(s)) {
        enriched.card_set = s.replace(/\b\w/g, c => c.toUpperCase());
        break;
      }
    }
  }

  // card_number — "#136", "N°136", "no 136", "number 136" style.
  if (!enriched.card_number) {
    const num = bag.match(/(?:#|n[°º]|no\.?|number)\s*(\d{1,4})\b/i);
    if (num) enriched.card_number = num[1];
  }

  // player — extract the longest run of consecutive capitalized tokens
  // that aren't brands, sets, colors, grades, years, or generic sport
  // words. Handles all three seller-title orderings we've seen:
  //   "Carte <PLAYER> Panini Prizm ..." (player before brand)
  //   "Panini Prizm <YEAR> <PLAYER> Silver ..." (player between year+parallel)
  //   "<YEAR> Fleer <PLAYER> Rookie #57" (player between brand+rookie)
  if (!enriched.player) {
    const rawSource = String(vision.product_name || vision.display_title || vision.shopping_query || '');
    const tokens = rawSource.split(/\s+/);
    const setTokens = new Set(KNOWN_SETS.flatMap(s => s.split(' ').map(t => t.toLowerCase())));
    const brandTokens = new Set(KNOWN_BRANDS.flatMap(b => b.split(' ').map(t => t.toLowerCase())));

    let best = [];
    let current = [];
    const flush = () => {
      if (current.length > best.length && current.length >= 1 && current.length <= 4) {
        best = current;
      }
      current = [];
    };
    for (const rawTok of tokens) {
      const t = rawTok.replace(/[.,;:]+$/, '');
      const l = t.toLowerCase();
      const isCap = /^[A-ZÀ-Ýà-ÿ]/.test(t);
      const isYear = /^\d{4}([-/]\d{2,4})?$/.test(t);
      const isNoise = /^[#\d/\\|]/.test(t) || t.length <= 1;
      const isBrand = brandTokens.has(l);
      const isSet = setTokens.has(l);
      const isStop = PLAYER_STOP_TOKENS.has(l);
      const isGeneric = PLAYER_GENERIC.has(l);
      const acceptable = isCap && !isYear && !isNoise && !isBrand
                       && !isSet && !isStop && !isGeneric;
      if (acceptable) {
        current.push(t);
      } else {
        flush();
      }
    }
    flush();
    if (best.length > 0) enriched.player = best.join(' ');
  }

  return enriched;
}

// ─── Query cascade ───────────────────────────────────────────────────────
// Q1: precise — year + set + player + parallel + grade suffix
// Q2: broad — year + set + player + grade suffix (drops parallel)
//
// card_year is used verbatim (2023, 2023-24 style OK — matches seller titles).
// grading_company + card_grade concatenated ("PSA 10") only if card_graded.
// Nothing else added — brand/card_number would over-restrict.
function buildQueryCascade(vision) {
  const player = (vision.player || '').trim();
  const year = (vision.card_year || '').trim();
  const set = (vision.card_set || '').trim();
  const parallel = (vision.parallel || '').trim();
  const gradingCompany = (vision.grading_company || '').trim().toUpperCase();
  const cardGrade = (vision.card_grade || '').trim();

  // Minimum viable identification: need at least player + (year OR set).
  // Bail early so the caller can fall through to estimation.
  if (!player) return [];
  if (!year && !set) return [];

  const gradeSuffix = (vision.card_graded && gradingCompany && cardGrade)
    ? `${gradingCompany} ${cardGrade}`
    : '';

  const q2Parts = [year, set, player, gradeSuffix].filter(Boolean);
  const q2 = q2Parts.join(' ').trim();

  if (!parallel) {
    // No parallel identified → Q1 == Q2, only run once.
    return [{ q: q2, level: 2 }];
  }

  const q1Parts = [year, set, player, parallel, gradeSuffix].filter(Boolean);
  const q1 = q1Parts.join(' ').trim();
  return [{ q: q1, level: 1 }, { q: q2, level: 2 }];
}

// ─── Sale cleaning ───────────────────────────────────────────────────────
// Hard exclusions on title. Case-insensitive on normalised title.
// These knock out lots, reprints, digital NFTs, break slots, checklists.
// "sticker" is intentionally NOT excluded — Panini sticker sets (World Cup)
// are legitimate hobby items with their own market.
const HARD_EXCLUDE_TERMS = [
  'reprint', 'custom card', 'custom base',
  'digital', 'topps digital', 'nft',
  'break slot', 'break spot', 'random team', 'random hit',
  'checklist',
];
// Lot patterns: "lot of 5", "lot de 3", "x2", "x100", "×5", "2-card lot".
const LOT_RE = /\blot\s*(of|de)?\s*\d+|\b\d+[- ]?card\s+lot\b|\bx\s*\d{1,3}\b|×\s*\d{1,3}/i;

function hardExcluded(title) {
  const t = (title || '').toLowerCase();
  if (HARD_EXCLUDE_TERMS.some(term => t.includes(term))) return true;
  if (LOT_RE.test(t)) return true;
  return false;
}

// Graded-context regex. Must catch:
//   - "PSA 10", "PSA10", "PSA-10"
//   - "BGS 9.5" (half-grade, dot decimal)
//   - "SGC 9", "CGC 9.5"
//   - "TAG 10", "TAG9"
//   - "AGS 9.5"
//   - "ACE 10"
//   - "gem mint 10", "gem-mint 10", "gem mint" (bare gem mint = graded flavour)
//   - "graded" alone / "GetGraded"
// FALSE-POSITIVE guards: half-grade requires a digit after the dot ("9.5",
// not "PSA 9. Mint"). Bare "9.5" without a company is NOT flagged (too
// many sellers write "9/10" or "9.5x11" dimensions).
// NB: use \d+(?:\.\d+)? to accept multi-digit grades like "10", not just \d,
// which drops the second digit and yields a word-boundary failure at "1".
const GRADED_TITLE_RE = new RegExp(
  [
    '\\b(psa|bgs|sgc|cgc|tag|ags|ace)\\s*-?\\s*\\d+(?:\\.\\d+)?\\b',
    '\\bgem\\s*-?\\s*mint(?:\\s*\\d+(?:\\.\\d+)?)?\\b',
    '\\bgraded\\b',
    '\\bget\\s*graded\\b',
  ].join('|'),
  'i',
);

function isGradedTitle(title) {
  return GRADED_TITLE_RE.test(title || '');
}

// Normalize a string for token matching: lowercase, strip accents, collapse
// non-alphanumeric to spaces. Player names in French/Spanish/German need this.
function normaliseForTokens(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // strip combining accents
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Q1/Q2 validation gates. Returns true → sale kept, false → discarded.
//
// Gate 1 (both levels) : player name tokens all present in title.
// Gate 2 (Q1 only)     : year OR set present in title.
// Gate 3 (Q1 only)     : parallel name present when parallel was set.
// Gate 4 (raw only)    : title must NOT contain a graded pattern.
// Gate 5 (graded only) : title MUST contain the target grade.
function passesQueryValidation(title, vision, queryLevel) {
  const rawTitle = title || '';
  const normTitle = normaliseForTokens(rawTitle);

  // Gate 1 — surname must appear (sellers routinely omit first names on
  // sports cards: "2023 Prizm Wembanyama Silver" beats "Victor Wembanyama"
  // in seller SEO). We require the LAST normalised token ≥ 3 chars of
  // the player name; the earlier tokens (first name, middle) are used
  // only as a soft signal in the future. Mono-name athletes (Pelé, Neymar)
  // still work because their single token is the "last" token.
  const player = normaliseForTokens(vision.player);
  if (!player) return false;
  const playerTokens = player.split(' ').filter(t => t.length >= 3);
  if (playerTokens.length === 0) return false;
  const surname = playerTokens[playerTokens.length - 1];
  if (!normTitle.includes(surname)) return false;

  if (queryLevel === 1) {
    // Gate 2 — year OR set present.
    const year = (vision.card_year || '').trim();
    const setNorm = normaliseForTokens(vision.card_set);
    const setTokens = setNorm.split(' ').filter(t => t.length >= 3);
    const hasYear = year && normTitle.includes(year);
    const hasSet = setTokens.length > 0 && setTokens.every(t => normTitle.includes(t));
    if (!hasYear && !hasSet) return false;

    // Gate 3 — parallel name present when set.
    const parallel = normaliseForTokens(vision.parallel);
    if (parallel) {
      const parallelTokens = parallel.split(' ').filter(t => t.length >= 3);
      // At least ONE parallel token must match. Multi-word parallels like
      // "cracked ice" often appear as either token in seller titles.
      if (parallelTokens.length > 0) {
        const hit = parallelTokens.some(tok => normTitle.includes(tok));
        if (!hit) return false;
      }
    }
  }

  // Gates 4 & 5 — graded/raw segregation.
  const scanIsGraded = !!vision.card_graded;
  const titleGraded = isGradedTitle(rawTitle);
  if (!scanIsGraded && titleGraded) return false;    // raw scan → reject graded sales
  if (scanIsGraded && !titleGraded) return false;    // graded scan → reject non-graded sales

  // For a graded scan, additionally require the specific company + grade.
  // Multi-digit grade support ("10") requires \d+ style boundaries, same
  // fix rationale as GRADED_TITLE_RE above.
  if (scanIsGraded) {
    const company = (vision.grading_company || '').trim().toLowerCase();
    const grade = (vision.card_grade || '').trim();
    if (company && grade) {
      const escapedGrade = grade.replace(/[.\\]/g, m => '\\' + m);
      const targetRe = new RegExp(
        `\\b${company}\\s*-?\\s*${escapedGrade}(?!\\d)\\b`,
        'i',
      );
      if (!targetRe.test(rawTitle)) return false;
    }
  }

  return true;
}

// ─── Sale mapping ────────────────────────────────────────────────────────
// Same shape as coins-pipeline / listings — camelCase to match the CARD_RESULT
// listings[] the front already knows how to render.
function mapSaleToListing(sale) {
  const priceEur = toEur(sale.price_orig, sale.currency_orig);
  if (priceEur == null) return null;
  return {
    title:        sale.title || '',
    price:        priceEur,
    currency:     'EUR',
    soldDate:     sale.sold_date_ts ? new Date(sale.sold_date_ts).toISOString() : null,
    itemUrl:      sale.item_url || null,
    imageUrl:     sale.image_url || null,
    country:      sale.seller_country || null,
    source:       'ebay_sold',
  };
}

// ─── Statistics ──────────────────────────────────────────────────────────
function percentile(sortedNums, p) {
  if (sortedNums.length === 0) return null;
  const idx = Math.min(Math.floor(sortedNums.length * p), sortedNums.length - 1);
  return sortedNums[idx];
}
function computeStats(prices) {
  if (!Array.isArray(prices) || prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const round = (n) => n == null ? null : Math.round(n * 100) / 100;
  return {
    median: round(percentile(sorted, 0.5)),
    p25:    round(percentile(sorted, 0.25)),
    p75:    round(percentile(sorted, 0.75)),
  };
}

// ─── Orchestrator ────────────────────────────────────────────────────────
// Returns { sports_card_data, listings, market_price_min, market_price_max,
//           serpapi_calls_used } or null.
async function analyzeSportsCardSales(vision) {
  if (!isSportsCardsPipelineEnabled()) return null;
  if (!vision || vision.category !== 'sports_card') return null;

  // Log what Gemini actually returned in the pivot fields — the pipeline's
  // early-exit rate is meaningless without knowing which fields were empty.
  console.log(
    '[Lakkot sports] gemini raw pivots:',
    JSON.stringify({
      player: vision.player, card_year: vision.card_year,
      card_brand: vision.card_brand, card_set: vision.card_set,
      card_number: vision.card_number, parallel: vision.parallel,
      card_graded: vision.card_graded, id_confidence: vision.id_confidence,
    }),
  );

  // Rescue pass: backfill empty pivots from product_name / variant /
  // shopping_query. Gemini frequently fills these free-text fields
  // correctly but leaves the dedicated pivot fields at "". Ref scan
  // 23553af8 — id_confidence 0.98 but pivots empty.
  const enriched = enrichVisionFromText(vision);
  const diff = ['player', 'card_year', 'card_brand', 'card_set', 'card_number']
    .filter(k => vision[k] !== enriched[k])
    .map(k => `${k}: "${vision[k]||''}" → "${enriched[k]||''}"`);
  if (diff.length > 0) {
    console.log('[Lakkot sports] enrichVisionFromText backfilled:', diff.join(' | '));
  }
  vision = enriched;

  const cascade = buildQueryCascade(vision);
  if (cascade.length === 0) {
    console.warn('[Lakkot sports] no query buildable — vision missing player + (year OR set) even after fallback');
    return null;
  }

  console.log(
    `[Lakkot sports] cascade queries: ${cascade.map(c => `[Q${c.level}] "${c.q}"`).join(' → ')}`
    + ` | graded=${!!vision.card_graded} conf=${vision.id_confidence ?? '?'}`,
  );

  let calls = 0;
  let usedQuery = null;
  let usedLevel = null;
  let validSales = [];

  for (const { q, level } of cascade) {
    let raw;
    try {
      raw = await fetchEbaySerpApi({ query: q, language: 'WORLD', limit: 100 });
      calls++;
    } catch (err) {
      console.warn(`[Lakkot sports] SerpApi Q${level} error: ${err.message}`);
      continue;
    }
    const kept = [];
    for (const sale of (raw || [])) {
      if (hardExcluded(sale.title)) continue;
      if (!passesQueryValidation(sale.title, vision, level)) continue;
      const mapped = mapSaleToListing(sale);
      if (mapped) kept.push(mapped);
    }
    console.log(`[Lakkot sports] Q${level} "${q}" — ${raw?.length || 0} raw → ${kept.length} valid`);
    if (kept.length >= 5) {
      validSales = kept;
      usedQuery = q;
      usedLevel = level;
      break;
    }
    // Keep the best fallback in case Q2 also fails to reach 5.
    if (kept.length > validSales.length) {
      validSales = kept;
      usedQuery = q;
      usedLevel = level;
    }
  }

  if (validSales.length < 3) {
    // < 3 sales even after cascade → not enough signal for a meaningful stat.
    // Caller falls back to Gemini estimation. Return null but include the
    // diagnostics on the log side via the caller-visible calls counter.
    console.log(`[Lakkot sports] insufficient sales (${validSales.length}) after ${calls} SerpApi call(s)`);
    return { coins_data: null, sports_card_data: null, serpapi_calls_used: calls };
  }

  const prices = validSales.map(s => s.price).sort((a, b) => a - b);
  const stats = computeStats(prices);

  // Scope semantics for the front:
  //   Q1 → parallel + (grade if graded)  → exact_parallel_(graded|raw)
  //   Q2 → set + (grade if graded)       → set_level_(graded|raw)
  const scope = (usedLevel === 1)
    ? (vision.card_graded ? 'exact_parallel_graded' : 'exact_parallel_raw')
    : (vision.card_graded ? 'set_level_graded'     : 'set_level_raw');

  // Recent-sales sample for the UI. Chronological desc if we have timestamps.
  const recent = [...validSales].sort((a, b) => {
    const ta = a.soldDate ? Date.parse(a.soldDate) : 0;
    const tb = b.soldDate ? Date.parse(b.soldDate) : 0;
    return tb - ta;
  }).slice(0, 5);

  const sports_card_data = {
    query_used:      usedQuery,
    query_level:     usedLevel,
    sales_count:     validSales.length,
    price:           stats,
    scope,
    recent_sales:    recent,
    id_confidence:   typeof vision.id_confidence === 'number' ? vision.id_confidence : null,
  };

  return {
    sports_card_data,
    listings:         validSales.slice(0, 10),
    market_price_min: stats?.p25 ?? null,
    market_price_max: stats?.p75 ?? null,
    serpapi_calls_used: calls,
  };
}

module.exports = {
  isSportsCardsPipelineEnabled,
  analyzeSportsCardSales,
  // Internal helpers exposed for tests only.
  _internals: {
    buildQueryCascade,
    hardExcluded,
    isGradedTitle,
    passesQueryValidation,
    normaliseForTokens,
    GRADED_TITLE_RE,
  },
};
