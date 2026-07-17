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

// Words that are too generic to distinguish one product from another —
// they'd let a "Chanel eyeliner" pass a "Chanel 19 bag" filter. Extended
// as we spot false positives in prod.
const GENERIC_TOKENS = new Set([
  // FR product nouns
  'sac', 'sacs', 'main', 'montre', 'montres', 'bijou', 'bijoux',
  'vetement', 'vetements', 'chaussure', 'chaussures',
  // EN product nouns
  'bag', 'bags', 'watch', 'watches', 'shoe', 'shoes',
  // Other noise
  'pokemon', 'accessoire', 'accessoires', 'accessory', 'accessories',
  'edition', 'collection', 'authentic', 'authentique', 'occasion',
  'used', 'new', 'neuf', 'seconde',
  // Colors alone are too weak (a "bleu" Chanel eyeliner and a "bleu" bag
  // would both match) — needs a model marker to distinguish.
  'bleu', 'noir', 'blanc', 'rouge', 'vert', 'jaune', 'rose', 'gris',
  'blue', 'black', 'white', 'red', 'green', 'yellow', 'pink', 'grey',
]);

// Build the list of tokens that MUST anchor the listing to the scanned
// product. Two rules:
// 1) Include tokens from Gemini's product_name and variant.
// 2) Drop the brand itself (already handled by the brand filter) and
//    anything in GENERIC_TOKENS.
// 3) Number-like tokens (19, 30, 555, JR9806…) are always kept — they're
//    the strongest anchors for luxury lines named after a number.
function extractDistinguishingTokens(vision) {
  if (!vision) return [];
  const brandNorm = normalize(vision.brand || '');
  const brandWords = new Set(brandNorm.split(' ').filter(w => w.length >= 2));
  const rawText = `${vision.product_name || ''} ${vision.variant || ''}`;
  const words = normalize(rawText).split(' ');
  const seen = new Set();
  const tokens = [];
  for (const w of words) {
    if (w.length < 2) continue;
    if (brandWords.has(w)) continue;
    if (GENERIC_TOKENS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    tokens.push(w);
  }
  return tokens;
}

// The listing must contain at least ONE distinguishing token from the
// identified product. This is the filter that rejects false positives
// like "Chanel eyeliner" for a "Chanel 19 Denim bag" scan — same brand,
// price band even overlaps in some cases, but no shared model/variant
// keyword.
function passesModelFilter(title, distinguishingTokens) {
  if (!distinguishingTokens || distinguishingTokens.length === 0) return true;
  const nt = normalize(title);
  return distinguishingTokens.some(tok => nt.includes(tok));
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
  // Distinguishing tokens from product_name + variant. Any listing whose
  // title contains ZERO of these is rejected — this is what stopped the
  // "Chanel eyeliner" from showing up as proof for a "Chanel 19 Denim bag"
  // scan (both match brand + price band, but no shared model/variant token).
  const modelTokens = extractDistinguishingTokens(vision);
  console.log(`[Lakkot listings] distinguishing tokens for filter:`, modelTokens.join(', '));

  // Helper: apply the 3 filters (brand + price + model), return top capAt.
  const CAP = 8;
  const filterAndRank = (items, capAt = CAP) => {
    const kept = [];
    const rejected = { brand: 0, price: 0, model: 0 };
    for (const item of items) {
      if (!passesBrandFilter(item.title, vision.brand)) { rejected.brand++; continue; }
      if (!passesPriceFilter(item.price, geminiMin, geminiMax)) { rejected.price++; continue; }
      if (!passesModelFilter(item.title, modelTokens)) { rejected.model++; continue; }
      kept.push(item);
      if (kept.length >= capAt) break;
    }
    return { kept, rejected };
  };

  // ── Lens source: use visualMatches already fetched upstream for luxury.
  // For non-luxury categories the mapping still runs — but we typically get
  // nothing usable so lensListings ends up empty and we fall through to the
  // Shopping/eBay fetch below. Cost of the check is negligible.
  let lensListings = [];
  if (USE_LENS_CARDS_FOR.has(vision.category) && Array.isArray(lensCards) && lensCards.length > 0) {
    const mapped = mapLensCardsToListings(lensCards);
    console.log(`[Lakkot listings] lens mapped=${mapped.length} from ${lensCards.length} raw cards`);
    lensListings = mapped;  // filter later, after merging with Shopping
  }

  // Primary query: for eBay use query_ebay, for Shopping use query_shopping.
  const primaryQuery = source === 'ebay'
    ? (vision.query_ebay || vision.query_shopping || '').trim()
    : (vision.query_shopping || vision.query_ebay || '').trim();

  // Hard timeout 6s (spec) — never block the estimation response.
  const runWithTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('listings_timeout')), ms)),
  ]);

  // ── Fallback source: Shopping (default) or eBay Browse — always fired
  // now, not conditional on Lens count. Ancien flow's strength was merging
  // BOTH sources; we do the same and let the filters drop noise.
  let fallbackRaw = [];
  if (primaryQuery) {
    try {
      if (source === 'ebay') {
        if (ebayToken) {
          fallbackRaw = await runWithTimeout(
            fetchEbayBrowseListings({ query: primaryQuery, marketplace, ebayToken }),
            6000
          );
        } else {
          console.warn('[Lakkot listings] no ebay token — skipping fallback');
        }
      } else {
        const shoppingRes = await runWithTimeout(shoppingCaller(primaryQuery, country), 6000);
        fallbackRaw = mapShoppingCards(shoppingRes?.cards || []);
      }
    } catch (err) {
      console.warn('[Lakkot listings] fallback fetch failed:', err.message);
      fallbackRaw = [];   // fall through — we may still have Lens listings
    }
  }

  // Merge Lens + fallback, dedupe by URL (or title as backup key).
  const seenLinks = new Set();
  const merged = [];
  for (const item of [...lensListings, ...fallbackRaw]) {
    const key = item.link || (item.source + ':' + item.title);
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    merged.push(item);
  }
  const filtered = filterAndRank(merged);
  let kept = filtered.kept;
  console.log(`[Lakkot listings] source=${source} lens=${lensListings.length} fallback=${fallbackRaw.length} merged=${merged.length} kept=${kept.length} rejected(brand=${filtered.rejected.brand},price=${filtered.rejected.price},model=${filtered.rejected.model})`);

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
        // Re-merge with Lens + primary fallback, dedupe by link so the
        // retry only ADDS new items.
        const retryMerged = [...merged];
        for (const item of retryRaw) {
          const key = item.link || (item.source + ':' + item.title);
          if (seenLinks.has(key)) continue;
          seenLinks.add(key);
          retryMerged.push(item);
        }
        const retryFiltered = filterAndRank(retryMerged);
        kept = retryFiltered.kept;
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
  passesModelFilter,
  extractDistinguishingTokens,
  LISTINGS_SOURCE_BY_CATEGORY,
};
