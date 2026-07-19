'use strict';
// Coins pipeline v1 — specialised eBay-sold path for coins_money scans.
//
// Why a separate module: numismatics needs (1) real closed sales, not active
// listings, (2) segmentation by condition (raw / high grade / graded), (3) a
// metal-value floor to filter out "10 francs argent" listings priced at €2
// from bad extractions. None of that fits the generic v2 listings pipeline
// cleanly.
//
// Isolation:
// - Feature-flagged USE_COINS_PIPELINE. Default false → the coins_money
//   category falls back to the v2 listings behaviour (eBay Browse active
//   listings via fetchListingsForVision).
// - Only fires when vision.category === "coins_money" AND Gemini returned
//   valid coin_* fields.
// - Uses SerpApi eBay engine (same backend as the Pokemon pipeline). Max 2
//   SerpApi calls per scan: Q1 (specific), and Q3 (broader) only if Q1
//   returned fewer than 5 valid sales. Q2 (mintmark-dropped) is intentionally
//   skipped to cap cost.
// - Failure of any kind returns null so the caller can fall back.

const { fetchEbaySerpApi } = require('./price-serpapi');
const { toEur } = require('./price-stats');

// ─── Feature flag ────────────────────────────────────────────────────────
function isCoinsPipelineEnabled() {
  return String(process.env.USE_COINS_PIPELINE || '').toLowerCase() === 'true';
}

// ─── Metal spot prices ───────────────────────────────────────────────────
// EUR per gram of PURE metal (999/1000). Applied at compute time with the
// coin's fineness (e.g. 900/1000 silver → weight × 0.900 × price).
//
// Values below reflect market spot prices as of 2026-07-19. Rough order of
// magnitude only — a €10 melt-value calculation is fine to guide the 80%
// floor filter but shouldn't be treated as a live quote for actual trades.
//
// TODO: wire to a live metals API (Kitco / GoldAPI / metals.dev) so these
// stay accurate as spot moves. Until then, the config is stale after ~6
// months; a scheduled reminder to refresh would be the pragmatic guardrail.
const METAL_PRICES_EUR_PER_GRAM = {
  silver: 1.40,   // 2026-07-19 approx spot
  gold:   115,    // 2026-07-19 approx spot
};
const METAL_PRICES_UPDATED_AT = '2026-07-19';

function computeMeltValueEur(metal, weightGrams, fineness) {
  if (!metal || !(metal in METAL_PRICES_EUR_PER_GRAM)) return null;
  if (!weightGrams || weightGrams <= 0) return null;
  if (!fineness || fineness <= 0 || fineness > 1) return null;
  const spot = METAL_PRICES_EUR_PER_GRAM[metal];
  return Math.round(spot * weightGrams * fineness * 100) / 100;
}

// ─── Query cascade ───────────────────────────────────────────────────────
// Return 1 or 2 query strings max (spec: hard cap 2 SerpApi calls).
// Q2 (mintmark-dropped) is deliberately omitted — its lift over Q3 didn't
// justify a 3rd SerpApi call.
function buildQueryCascade(vision) {
  const denom = (vision.coin_denomination || '').trim();
  const type = (vision.coin_type || '').trim();
  if (!denom || !type) return [];        // Gemini didn't identify → skip pipeline
  const year = (vision.coin_year || '').trim();
  const mintmark = (vision.coin_mintmark || '').trim();
  const metal = (vision.coin_metal || '').trim().toLowerCase();

  // Q3 shape used both as fallback and as the sole query when year isn't
  // readable — kept separate so we only compute it once.
  const q3Parts = [denom, type];
  if (metal && metal !== 'base' && metal !== 'unknown') q3Parts.push(metal === 'silver' ? 'argent' : metal === 'gold' ? 'or' : metal);
  const q3 = q3Parts.filter(Boolean).join(' ').trim();

  if (!vision.coin_year_readable || !year) {
    return [{ q: q3, level: 3 }];
  }
  const q1Parts = [denom, type, year];
  if (vision.coin_mintmark_readable && mintmark) q1Parts.push(mintmark);
  const q1 = q1Parts.filter(Boolean).join(' ').trim();
  return [{ q: q1, level: 1 }, { q: q3, level: 3 }];
}

// ─── Sale cleaning ───────────────────────────────────────────────────────
// Hard exclusions on title. All case-insensitive on the normalized title.
const HARD_EXCLUDE_TERMS = [
  'copie', 'copy', 'copies', 'replique', 'réplique', 'replica',
  'restrike', 'refrappe',
  'reproduction',
  'lot de', 'lot of', 'set of',
];
// Multiplier patterns "x2", "x100", "×5", etc. — coin lots that pollute price.
const MULTIPLIER_RE = /\bx\s*(\d{1,3})\b|×\s*(\d{1,3})/i;
// "jeton" is a false positive for jeton/token coins — only exclude when Gemini
// didn't identify the item as a token itself.
function hardExcluded(title, vision) {
  const t = (title || '').toLowerCase();
  if (HARD_EXCLUDE_TERMS.some(term => t.includes(term))) return true;
  if (MULTIPLIER_RE.test(t)) return true;
  const isJetonScan = /jeton|token/i.test((vision.coin_type || '') + ' ' + (vision.coin_denomination || ''));
  if (!isJetonScan && /\bjeton\b/i.test(t)) return true;
  return false;
}

// Words we drop when extracting "distinguishing tokens" from the coin type —
// they're too generic to distinguish one commemorative 2€ from another
// (every 2€ commemorative from every country has "commemorative" in
// its Gemini type field).
const GENERIC_COIN_TOKENS = new Set([
  'commemorative', 'commémorative', 'commemo', 'commémo',
  'euro', 'euros', 'franc', 'francs', 'cents', 'centime', 'centimes',
  'piece', 'pièce', 'monnaie', 'coin',
  'ans', 'annees', 'années', 'annee', 'année', 'anniversaire',
  'nouvelle', 'nouveau', 'neuf', 'neuve', 'ancien', 'ancienne',
  'de', 'du', 'des', 'la', 'le', 'les', 'et', 'ou', 'a', 'à',
  'or', 'argent',   // metal words already used in query, redundant here
]);

// Q1 validation — 4 gates. Each is strict on its own but they combine to
// drop the noise types we've seen on the "France 2024 JO Paris" scan:
//   sale #1 "France 2023 JO Paris 2024" was slipping through the year
//     check because "2024" appears anyway (event year, not coin year).
//     Now blocked by the type-token gate — a bare France 2023 sale
//     doesn't contain "eiffel" or "tour".
//   sales #2/#3 (Luxembourg 2024, Grèce 2024) were passing on year+denom
//     alone. Now blocked by the country gate.
// Q3 validation — looser: denomination + type keyword. Year is intentionally
// dropped because Q3 fires when the year isn't reliably readable.
function passesQueryValidation(title, vision, queryLevel) {
  const t = (title || '').toLowerCase();
  const denom = (vision.coin_denomination || '').toLowerCase();
  const type = (vision.coin_type || '').toLowerCase();
  const year = (vision.coin_year || '').toLowerCase();
  const country = (vision.coin_country || '').toLowerCase();

  // Denomination check — split into tokens so "10 francs" matches "10 franc"
  // and "10-francs". Require each denom token > 1 char to be present.
  const denomTokens = denom.split(/\s+/).filter(x => x.length > 1);
  for (const tok of denomTokens) if (!t.includes(tok)) return false;

  if (queryLevel === 1) {
    // Q1 gates: year + country + at least one distinguishing type token.
    if (year.length !== 4 || !t.includes(year)) return false;
    // Country: any word ≥ 4 chars from the coin_country field must appear.
    // Skips the check when Gemini didn't identify a country (rare).
    if (country) {
      const countryTokens = country.split(/\s+/).filter(x => x.length >= 4);
      if (countryTokens.length > 0) {
        const hit = countryTokens.some(tok => t.includes(tok));
        if (!hit) return false;
      }
    }
    // Distinguishing type token: at least one non-generic word from the
    // type OR variant field must be in the title. Two combined because
    // Gemini sometimes puts the specific commemoration in coin_type
    // ("JO Paris Tour Eiffel") and sometimes in variant ("Laskarina
    // Bouboulina" for Greece 2025). We saw scan 0a27b331 return a
    // Mikis Theodorakis sale for a Laskarina Bouboulina scan because
    // the type field was empty. Also fall back to product_name if
    // both are effectively empty after generic filtering.
    const typeSource = [type, (vision.variant || '').toLowerCase(),
                        (vision.product_name || '').toLowerCase()]
                       .filter(Boolean).join(' ');
    const brandNorm = (vision.coin_country || '').toLowerCase();
    const typeTokens = typeSource
      .replace(/[^a-zA-ZÀ-ÿ\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3
                && !GENERIC_COIN_TOKENS.has(w)
                && !brandNorm.includes(w)     // country already filtered above
                && !denom.includes(w));       // denom already filtered above
    if (typeTokens.length > 0) {
      const hit = typeTokens.some(tok => t.includes(tok));
      if (!hit) return false;
    }
  } else {
    // Q3 — additionally require the first type keyword.
    if (type && !t.includes(type.toLowerCase().split(' ')[0])) return false;
  }
  return true;
}

// Bucket by condition — reads condition keywords in the TITLE, not the
// eBay "condition" field (which is often blank or wrong for numismatics).
const GRADED_RE = /\b(PCGS|NGC|GENI|ANACS|MS[- ]?\d{2}|PR[- ]?\d{2}|MS\d{2}|FDC|FLEUR de COIN|SPL|BE|BU|PROOF|BELLE ÉPREUVE)\b/i;
const HIGH_GRADE_RE = /\b(SUP\+?|SPL|TTB\+|XF|AU|EF|AUNC)\b/i;
function bucketOf(title) {
  const t = title || '';
  if (GRADED_RE.test(t)) return 'graded';
  if (HIGH_GRADE_RE.test(t)) return 'high_grade';
  return 'standard';
}

// ─── Sale mapping ────────────────────────────────────────────────────────
// SerpApi eBay engine returns listings with these fields (post-parseSerpListing):
// { title, item_url, image_url, price_orig, currency_orig, sold_date_ts,
//   seller_country, condition, seller_username, buying_format }
function mapSaleToListing(sale) {
  const priceEur = toEur(sale.price_orig, sale.currency_orig);
  if (priceEur == null) return null;
  return {
    title:      sale.title || '',
    price:      priceEur,
    currency:   'EUR',
    seller:     sale.seller_username || null,
    image_url:  sale.image_url || null,
    link:       sale.item_url || null,
    source:     'ebay_sold',
    sold_date_ts: sale.sold_date_ts || null,
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
    count:  sorted.length,
    median: round(percentile(sorted, 0.5)),
    p25:    round(percentile(sorted, 0.25)),
    p75:    round(percentile(sorted, 0.75)),
  };
}

// Fusion rule: buckets with < 3 sales fuse into the next lower bucket.
// graded < 3 → merged into high_grade; high_grade < 3 → merged into standard.
// standard keeps whatever it has (no lower bucket).
function bucketAndStats(mappedSales) {
  const groups = { standard: [], high_grade: [], graded: [] };
  for (const s of mappedSales) groups[bucketOf(s.title)].push(s);
  // Fusion pass
  if (groups.graded.length < 3) {
    groups.high_grade.push(...groups.graded);
    groups.graded = [];
  }
  if (groups.high_grade.length < 3) {
    groups.standard.push(...groups.high_grade);
    groups.high_grade = [];
  }
  const stats = {};
  for (const b of ['standard', 'high_grade', 'graded']) {
    if (groups[b].length >= 3) {
      stats[b] = computeStats(groups[b].map(x => x.price));
    }
  }
  return { groups, stats };
}

// ─── Orchestrator ────────────────────────────────────────────────────────
// Returns { coins_data, listings, market_price_min, market_price_max,
//           serpapi_calls_used } or null.
async function analyzeCoinSales(vision) {
  if (!isCoinsPipelineEnabled()) return null;
  if (!vision || vision.category !== 'coins_money') return null;

  const cascade = buildQueryCascade(vision);
  if (cascade.length === 0) {
    console.warn('[Lakkot coins] no query buildable — vision missing denom/type');
    return null;
  }

  const melt = computeMeltValueEur(vision.coin_metal, vision.coin_weight_grams, vision.coin_fineness);
  console.log(`[Lakkot coins] cascade queries: ${cascade.map(c => `[Q${c.level}] "${c.q}"`).join(' → ')} | melt=${melt}€`);

  let calls = 0;
  let usedQuery = null;
  let usedLevel = null;
  let validSales = [];

  for (const { q, level } of cascade) {
    let raw;
    try {
      raw = await fetchEbaySerpApi({ query: q, language: 'FR', limit: 100 });
      calls++;
    } catch (err) {
      console.warn(`[Lakkot coins] Q${level} SerpApi error:`, err.message);
      continue;
    }
    const listings = raw?.listings || [];

    // Clean pass
    const cleaned = [];
    for (const sale of listings) {
      if (hardExcluded(sale.title, vision)) continue;
      if (!passesQueryValidation(sale.title, vision, level)) continue;
      const listing = mapSaleToListing(sale);
      if (!listing) continue;
      // Metal floor at 80% of melt value — drops obvious mispricings
      if (melt != null && listing.price < melt * 0.80) continue;
      cleaned.push(listing);
    }
    console.log(`[Lakkot coins] Q${level} "${q}" → raw=${listings.length} kept=${cleaned.length}`);

    if (cleaned.length >= 5) {
      usedQuery = q;
      usedLevel = level;
      validSales = cleaned;
      break;
    }
    // Insufficient — try next level (Q3) if we're on Q1
    if (level !== 3) continue;
    // Q3 finished with < 5 valid — return what we have OR bail if < 3
    if (cleaned.length >= 3) {
      usedQuery = q;
      usedLevel = level;
      validSales = cleaned;
    }
    break;
  }

  if (validSales.length < 3) {
    console.log(`[Lakkot coins] insufficient sales (${validSales.length}) after ${calls} SerpApi call(s) — falling back to Gemini estimate`);
    return { coins_data: null, serpapi_calls_used: calls };
  }

  const { groups, stats } = bucketAndStats(validSales);
  const standardStats = stats.standard || stats.high_grade || stats.graded || null;

  // Recent sales: 3 most recent from the standard bucket (or whichever
  // survived fusion) — used as user-facing proof.
  const displayBucket = groups.standard.length ? groups.standard
                       : groups.high_grade.length ? groups.high_grade
                       : groups.graded;
  const recent = [...displayBucket]
    .sort((a, b) => (b.sold_date_ts || 0) - (a.sold_date_ts || 0))
    .slice(0, 3)
    .map(s => {
      const { sold_date_ts, ...rest } = s;   // drop internal field before shipping
      return rest;
    });

  return {
    coins_data: {
      query_used:  usedQuery,
      query_level: usedLevel,
      sales_count: validSales.length,
      price_by_condition: stats,
      melt_value_eur: melt,
      metal_prices_updated_at: METAL_PRICES_UPDATED_AT,
      recent_sales: recent,
    },
    // Top-level listings + market range for retro-compat with the current
    // ESTIMATION_RESULT UI (which reads market_price_min/max regardless of
    // whether Lovable has shipped a coins-specific block).
    listings:         recent,
    market_price_min: standardStats?.p25 ?? null,
    market_price_max: standardStats?.p75 ?? null,
    serpapi_calls_used: calls,
  };
}

module.exports = {
  analyzeCoinSales,
  isCoinsPipelineEnabled,
  buildQueryCascade,        // exposed for tests
  computeMeltValueEur,
  bucketOf,
  METAL_PRICES_EUR_PER_GRAM,
  METAL_PRICES_UPDATED_AT,
};
