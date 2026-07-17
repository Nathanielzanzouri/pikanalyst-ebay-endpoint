'use strict';
// Listings enrichment for the Gemini Vision estimation path.
//
// After Gemini identifies a product and gives a EUR price band, this module
// fetches 3-5 real listings (Google Shopping or eBay Browse, routed by
// category) as proof. Filters out counterfeits, size mismatches, and
// obviously-wrong products. If ≥3 listings survive, we recompute the price
// band from the actual market rather than trusting Gemini's estimate alone.
//
// The Gemini estimation path already ships without this module (v1 flag
// USE_GEMINI_PIPELINE). This module adds the "proof" layer behind the
// second flag USE_LISTINGS_V2 — either can be turned off in isolation, and
// v2's fallback when any step fails is "return whatever v1 would have
// returned", so there's no regression path.

const { toEur } = require('./price-stats');

// ─── Feature flag ────────────────────────────────────────────────────────
function isListingsV2Enabled() {
  return String(process.env.USE_LISTINGS_V2 || '').toLowerCase() === 'true';
}

// ─── Routing table: category → listings source ───────────────────────────
// Kept as a lookup constant (spec: not hardcoded in logic). Anything not
// listed defaults to google_shopping, which has broader coverage for
// mass-produced items (bags, watches, toys, apparel).
const LISTINGS_SOURCE_BY_CATEGORY = {
  coins_money:      'ebay',
  antiques_vintage: 'ebay',
  sports_card:      'ebay',
};
function getListingsSource(category) {
  return LISTINGS_SOURCE_BY_CATEGORY[category] || 'google_shopping';
}

// ─── Lens visual matches as a priority listings source ───────────────────
// For fashion / luxury categories, Google Lens's own visual_matches already
// return real listings from Vestiaire, Farfetch, TheRealReal, Fashionphile,
// etc. — the same sites we'd otherwise hit via Shopping. Reusing them means
// zero extra SerpApi call in the nominal case; Shopping only fires as a
// fallback when Lens surfaces fewer than 3 items after filtering.
//
// Not enabled for coins/antiques/sports_card (dealer-specialist markets
// where Lens rarely surfaces real listings — eBay remains the primary
// source there).
const USE_LENS_CARDS_FOR = new Set([
  'bags_accessories',
  'jewelry_watches',
  'fashion_women',
  'fashion_men',
]);

// SerpApi Lens returns prices with a currency SYMBOL, not ISO code. Map to
// what toEur() expects.
const CURRENCY_SYMBOL_TO_ISO = { '€': 'EUR', '$': 'USD', '£': 'GBP' };

// Convert a `lensResult.cards[]` entry into our listings shape. Returns
// null when the currency can't be converted (unknown symbol or toEur
// declined) — the caller filters null out. All cards from handleGoogleLens
// already have hasPrice === true, so `c.price` is always a positive number.
function mapLensCard(c) {
  if (!c || typeof c.price !== 'number' || c.price <= 0) return null;
  const iso = CURRENCY_SYMBOL_TO_ISO[c.currency] || null;
  if (!iso) return null;
  const priceEur = toEur(c.price, iso);
  if (priceEur == null) return null;
  return {
    title:     c.title || '',
    price:     priceEur,
    currency:  'EUR',
    seller:    c.retailer || c.domain || null,
    image_url: c.imageUrl || null,
    link:      c.url || null,
    source:    'lens',
  };
}
function mapLensCardsToListings(cards) {
  return (cards || []).map(mapLensCard).filter(Boolean);
}

// ─── country → eBay marketplace ID ───────────────────────────────────────
// TODO: query_ebay from Gemini is French-language. For non-FR marketplaces
// (US/UK/DE) we'd need an English query — currently we still send the FR
// query, which returns fewer results on foreign markets. Acceptable for v2
// because FR is our primary user base; revisit if we ship internationally.
const EBAY_MARKETPLACE_BY_COUNTRY = {
  fr: 'EBAY_FR',
  us: 'EBAY_US',
  gb: 'EBAY_GB',
  de: 'EBAY_DE',
};
function getEbayMarketplace(country) {
  return EBAY_MARKETPLACE_BY_COUNTRY[(country || '').toLowerCase()] || 'EBAY_FR';
}

// ─── Normalization for the brand filter ──────────────────────────────────
// "Paul & Joe" vs "Paul Marius" — a naïve `title.includes(brand)` matches
// both, so a Paul Marius listing gets shown as proof for a Paul & Joe scan.
// We lowercase, strip diacritics, and replace "&" with " and " so the two
// strings differ unambiguously.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

function passesBrandFilter(title, brand) {
  if (!brand || brand.length < 2) return true;   // no brand → skip filter
  const nb = normalize(brand);
  const nt = normalize(title);
  return nt.includes(nb);
}

function passesPriceFilter(priceEur, geminiMin, geminiMax) {
  if (!priceEur || priceEur <= 0) return false;
  // If Gemini couldn't estimate (both zero), we can't filter by bounds —
  // let everything through and let downstream trust the count.
  if (!geminiMin || geminiMin <= 0) return true;
  const lower = geminiMin * 0.25;
  const upper = (geminiMax || geminiMin) * 4;
  return priceEur >= lower && priceEur <= upper;
}

// ─── Google Shopping wrapper ─────────────────────────────────────────────
// Takes the raw handleGoogleShopping return shape and maps it to our
// listings shape. handleGoogleShopping already handles counterfeits and
// kids-size filtering (see server.js:3286) so we don't repeat those here.
function mapShoppingCards(cards) {
  return (cards || [])
    .map(c => {
      const priceEur = toEur(c.price, c.currency);
      if (priceEur == null) return null;         // unsupported currency → skip
      return {
        title:     c.title,
        price:     priceEur,
        currency:  'EUR',
        seller:    c.retailer || null,
        image_url: c.imageUrl || null,
        link:      c.url || null,
        source:    'google_shopping',
      };
    })
    .filter(Boolean);
}

// ─── eBay Browse wrapper (active listings, NOT sold) ─────────────────────
// Not reusing fetchEbayBrowse because it's built for TCG cards (needs a
// card object, applies grading filters, forces filter=soldItems:true).
// This is a much simpler flavour: search by keyword, return active items.
// Per user directive: no sort param (default = relevance, not endDateDesc
// which only makes sense for sold), limit=50 (not 200).
async function fetchEbayBrowseListings({ query, marketplace, ebayToken }) {
  const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
    + `?q=${encodeURIComponent(query)}&limit=50&fieldgroups=EXTENDED`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${ebayToken}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplace,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`eBay Browse ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const items = data.itemSummaries || [];
  const out = [];
  for (const it of items) {
    const priceStr = it.price?.value;
    const currency = it.price?.currency || 'EUR';
    const priceNum = parseFloat(priceStr);
    if (!priceStr || isNaN(priceNum) || priceNum <= 0) continue;
    const priceEur = toEur(priceNum, currency);
    if (priceEur == null) continue;              // unsupported currency
    out.push({
      title:     it.title || '',
      price:     priceEur,
      currency:  'EUR',
      seller:    it.seller?.username || null,
      image_url: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
      link:      it.itemWebUrl || null,
      source:    'ebay',
    });
  }
  return out;
}

// ─── Main entry ──────────────────────────────────────────────────────────
// Given a Gemini identity + country + eBay token + a Shopping caller,
// return { listings, market_price_min, market_price_max, price_source }
// or null if disabled / no query / catastrophic failure.
//
// shoppingCaller: a bound function (query, country) => Promise<{ cards }>
//   Passed in rather than required('./server') to avoid a circular import.
async function fetchListingsForVision({ vision, country, ebayToken, shoppingCaller, lensCards }) {
  if (!isListingsV2Enabled()) return null;
  if (!vision || !vision.category) return null;

  const source = getListingsSource(vision.category);
  const marketplace = getEbayMarketplace(country);
  const geminiMin = Number(vision.estimated_price_min) || 0;
  const geminiMax = Number(vision.estimated_price_max) || 0;

  // Helper: apply the brand + price filters, return top 5.
  const filterAndRank = (raw, capAt = 5) => {
    const kept = [];
    for (const item of raw) {
      if (!passesBrandFilter(item.title, vision.brand)) continue;
      if (!passesPriceFilter(item.price, geminiMin, geminiMax)) continue;
      kept.push(item);
      if (kept.length >= capAt) break;
    }
    return kept;
  };

  // ── Priority source: Lens visual_matches (already fetched upstream) ──
  // Zero-cost enrichment for fashion / luxury when Lens has surfaced real
  // marketplace listings. Only fires for the whitelisted categories; other
  // categories skip straight to Shopping/eBay so we don't regress niches
  // where Lens is unreliable (coins, antiques, sports cards).
  let lensListings = [];
  if (USE_LENS_CARDS_FOR.has(vision.category) && Array.isArray(lensCards) && lensCards.length > 0) {
    const mapped = mapLensCardsToListings(lensCards);
    lensListings = filterAndRank(mapped);
    console.log(`[Lakkot listings] lens-priority category=${vision.category} raw_cards=${lensCards.length} mapped=${mapped.length} kept=${lensListings.length}`);
    // Enough directly from Lens — return without any SerpApi/eBay call.
    if (lensListings.length >= 3) {
      const prices = lensListings.map(x => x.price).filter(p => p > 0);
      return {
        listings: lensListings,
        market_price_min: Math.round(Math.min(...prices) * 100) / 100,
        market_price_max: Math.round(Math.max(...prices) * 100) / 100,
        price_source: 'listings',
        listings_source: 'lens',
      };
    }
  }

  // Query 1 — use Gemini's primary query (query_ebay for eBay, query_shopping
  // for Shopping — each is optimized differently in the Gemini prompt).
  const primaryQuery = source === 'ebay'
    ? (vision.query_ebay || vision.query_shopping || '').trim()
    : (vision.query_shopping || vision.query_ebay || '').trim();

  if (!primaryQuery) {
    console.warn('[Lakkot listings] no query available for source', source);
    // We may still have 1-2 Lens listings above — surface them anyway.
    return {
      listings: lensListings,
      market_price_min: null,
      market_price_max: null,
      price_source: 'gemini',
      listings_source: lensListings.length ? 'lens' : 'none',
    };
  }

  // Hard timeout 6s (spec) — never block the estimation response.
  const runWithTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('listings_timeout')), ms)),
  ]);

  let raw = [];
  try {
    if (source === 'ebay') {
      if (!ebayToken) throw new Error('no_ebay_token');
      raw = await runWithTimeout(
        fetchEbayBrowseListings({ query: primaryQuery, marketplace, ebayToken }),
        6000
      );
    } else {
      const shoppingRes = await runWithTimeout(shoppingCaller(primaryQuery, country), 6000);
      raw = mapShoppingCards(shoppingRes?.cards || []);
    }
  } catch (err) {
    console.warn('[Lakkot listings] primary fetch failed:', err.message);
    // Same as no-query case — surface any Lens listings we already got.
    return {
      listings: lensListings,
      market_price_min: null,
      market_price_max: null,
      price_source: 'gemini',
      listings_source: lensListings.length ? 'lens' : 'none',
    };
  }

  // Merge Lens listings first, then fallback source, deduping by link so
  // that the same URL never shows twice. Pass the merged list to
  // filterAndRank so brand+price filters apply uniformly.
  const seenLinks = new Set();
  const merged = [];
  for (const item of [...lensListings, ...raw]) {
    const key = item.link || (item.source + ':' + item.title);
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    merged.push(item);
  }
  let kept = filterAndRank(merged);
  console.log(`[Lakkot listings] source=${source} lens_kept=${lensListings.length} raw=${raw.length} merged=${merged.length} kept=${kept.length}`);

  // Retry once with a broader query if 0 kept AND we have a brand to keep
  // in the query (per spec: the retry MUST retain the brand — otherwise
  // we'd fetch generic bags and defeat the whole purpose).
  if (kept.length === 0 && vision.brand) {
    const categoryWord = (() => {
      // Very short mapping — enough to say "bag" / "watch" / "figure" in
      // the retry query. Keeping this local rather than another config
      // file because it's ONLY used here.
      const m = {
        bags_accessories:  'sac',
        jewelry_watches:   'montre',
        toys_hobbies:      'figurine',
        fashion_women:     'vetement',
        fashion_men:       'vetement',
        electronics:       'appareil',
        antiques_vintage:  'vintage',
        coins_money:       'piece',
        sports_card:       'carte',
        art_crafts:        'oeuvre',
      };
      return m[vision.category] || null;
    })();
    if (categoryWord) {
      const broadQuery = `${vision.brand} ${categoryWord}`;
      console.log('[Lakkot listings] retry with broad query:', broadQuery);
      try {
        let retryRaw = [];
        if (source === 'ebay') {
          retryRaw = await runWithTimeout(
            fetchEbayBrowseListings({ query: broadQuery, marketplace, ebayToken }),
            6000
          );
        } else {
          const shoppingRes = await runWithTimeout(shoppingCaller(broadQuery, country), 6000);
          retryRaw = mapShoppingCards(shoppingRes?.cards || []);
        }
        // Re-merge with Lens listings so we don't lose them in the retry
        // (dedupe by link across all three sources: lens + primary + retry).
        const retryMerged = [];
        for (const item of [...lensListings, ...raw, ...retryRaw]) {
          const key = item.link || (item.source + ':' + item.title);
          if (seenLinks.has(key)) continue;
          seenLinks.add(key);
          retryMerged.push(item);
        }
        kept = filterAndRank(retryMerged);
        console.log(`[Lakkot listings] retry raw=${retryRaw.length} merged=${retryMerged.length} kept=${kept.length}`);
      } catch (err) {
        console.warn('[Lakkot listings] retry fetch failed:', err.message);
      }
    }
  }

  // Compute market price range if we have enough data points.
  let market_price_min = null;
  let market_price_max = null;
  let price_source = 'gemini';
  if (kept.length >= 3) {
    const prices = kept.map(x => x.price).filter(p => p > 0);
    market_price_min = Math.round(Math.min(...prices) * 100) / 100;
    market_price_max = Math.round(Math.max(...prices) * 100) / 100;
    price_source = 'listings';
  }
  // 1-2 listings: display them but keep Gemini's band (too few points for
  // a proper market range).

  // Report the source that actually contributed the kept items. If they're
  // all from Lens → 'lens'; all from Shopping/eBay → source name; mix →
  // 'mixed'. Useful for stats: are Lens visual_matches carrying their
  // weight vs the fallback SerpApi call?
  let listings_source;
  if (kept.length === 0) {
    listings_source = 'none';
  } else {
    const uniqueSources = new Set(kept.map(k => k.source));
    listings_source = uniqueSources.size === 1 ? [...uniqueSources][0] : 'mixed';
  }

  return {
    listings: kept,
    market_price_min,
    market_price_max,
    price_source,
    listings_source,
  };
}

module.exports = {
  fetchListingsForVision,
  isListingsV2Enabled,
  getListingsSource,
  getEbayMarketplace,
  passesBrandFilter,   // exported for unit tests
  passesPriceFilter,
  LISTINGS_SOURCE_BY_CATEGORY,
};
