'use strict';
// optcgapi.com client — canonical One Piece card data (variants, names,
// rarities, official images, TCGplayer reference prices) keyed by card number.
//
// Used by the OP route to (a) discover ALL variants for a card_number
// authoritatively (vs. heuristic eBay clustering), and (b) get official
// Bandai card images for the variant picker UI. eBay still provides the
// actual sold prices used for the verdict.
//
// API author asked "please don't blast it" (personal VPS). We cache responses
// per card_number for 24h (prices are scraped daily upstream anyway, so a
// shorter TTL would just hammer their server without giving fresher data).

const CACHE = new Map();                          // card_number → { variants, fetchedAt }
const TTL_MS = 24 * 60 * 60 * 1000;               // 24 hours
const FETCH_TIMEOUT_MS = 6000;
const BASE_URL = 'https://optcgapi.com/api/sets/card';

// Extract the variant descriptor from the API's card_name field.
// Examples:
//   "Monkey.D.Luffy (118)"                       → null    (base print)
//   "Monkey.D.Luffy (118) (Alternate Art)"       → "Alternate Art"
//   "Roronoa Zoro (001) (Parallel)"              → "Parallel"
//   "Monkey.D.Luffy (118) (Manga)"               → "Manga"
// The first parens is usually the card number echo; second parens (if any)
// is the variant descriptor.
function extractVariantDescriptor(cardName) {
  if (!cardName) return null;
  const parens = [...String(cardName).matchAll(/\(([^)]+)\)/g)].map(m => m[1].trim());
  if (parens.length < 2) return null;            // no descriptor parens → base print
  return parens[parens.length - 1];               // last parens = descriptor
}

// Normalize an API record into the shape the server + sidepanel expect.
function normalizeApiRecord(raw) {
  if (!raw) return null;
  return {
    card_image_id:       raw.card_image_id || null,
    card_name:           raw.card_name || null,
    rarity:              raw.rarity || null,
    card_color:          raw.card_color || null,
    card_type:           raw.card_type || null,
    sub_types:           raw.sub_types || null,
    set_name:            raw.set_name || null,
    set_id:              raw.set_id || null,
    card_image:          raw.card_image || null,    // official Bandai image URL
    market_price_usd:    typeof raw.market_price === 'number' ? raw.market_price : null,
    inventory_price_usd: typeof raw.inventory_price === 'number' ? raw.inventory_price : null,
    date_scraped:        raw.date_scraped || null,
    variant_descriptor:  extractVariantDescriptor(raw.card_name),
  };
}

// Fetch all variants of a One Piece card by canonical card number.
// Returns array of normalized variant objects, or null when the API has no
// record / errored. Caches successful results for 24h, failed lookups for
// 5 min (so a transient blip doesn't get cached for a day).
async function getOnePieceCardVariants(cardNumber) {
  if (!cardNumber) return null;
  const key = String(cardNumber).toUpperCase();
  const cached = CACHE.get(key);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    const validFor = cached.variants ? TTL_MS : 5 * 60 * 1000;
    if (age < validFor) return cached.variants;
  }
  const url = `${BASE_URL}/${encodeURIComponent(key)}/`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) {
      console.warn('[optcg-api]', r.status, 'for', key);
      CACHE.set(key, { variants: null, fetchedAt: Date.now() });
      return null;
    }
    const raw = await r.json();
    if (!Array.isArray(raw) || raw.length === 0) {
      CACHE.set(key, { variants: null, fetchedAt: Date.now() });
      return null;
    }
    const variants = raw.map(normalizeApiRecord).filter(Boolean);
    CACHE.set(key, { variants, fetchedAt: Date.now() });
    return variants;
  } catch (err) {
    console.warn('[optcg-api] fetch failed for', key, ':', err.message);
    CACHE.set(key, { variants: null, fetchedAt: Date.now() });
    return null;
  }
}

// Map a variant descriptor ("Alternate Art" / "Manga" / "Parallel") to the
// set of keyword variants sellers actually use in eBay titles. Used to
// bucket eBay listings into API-defined variants.
function descriptorMatchTerms(descriptor) {
  if (!descriptor) return [];
  const d = descriptor.toLowerCase();
  if (d.includes('alternate art') || d.includes('alternative art') || d === 'aa') {
    return ['alt art', 'alternate art', 'alternative art', ' aa ', ' aa)', '(aa)', ' aa-', 'comic parallel'];
  }
  if (d.includes('manga')) return ['manga', 'comic'];
  if (d.includes('parallel')) return ['parallel', 'foil parallel'];
  if (d.includes('foil')) return ['foil'];
  if (d.includes('promo')) return ['promo', 'event pack', 'one piece day', 'op day'];
  if (d.includes('championship')) return ['championship', 'cs '];
  if (d.includes('finalist')) return ['finalist'];
  return [d]; // catch-all: match the descriptor literally
}

// Given eBay listings + API-known variants, bucket each listing into the
// matching variant by title keyword. Listings not matching any non-base
// variant fall into the base (first) bucket. Returns variant objects with
// per-bucket listings + median eBay price.
function bucketListingsByVariant(ebayListings, apiVariants) {
  if (!Array.isArray(apiVariants) || apiVariants.length === 0) return [];
  // Prepare buckets, preserving the API order. Variant 0 = base (no descriptor).
  const buckets = apiVariants.map((v) => ({ ...v, _listings: [] }));
  for (const listing of (ebayListings || [])) {
    const title = ((listing && listing.title) || '').toLowerCase();
    let placed = false;
    // Try to match against non-base variants first (they have descriptors)
    for (let i = 0; i < buckets.length; i++) {
      const terms = descriptorMatchTerms(buckets[i].variant_descriptor);
      if (terms.length === 0) continue; // skip base for now
      if (terms.some(t => title.includes(t))) {
        buckets[i]._listings.push(listing);
        placed = true;
        break;
      }
    }
    // Anything not matched goes to the first variant WITHOUT a descriptor (the base)
    if (!placed) {
      const baseIdx = buckets.findIndex(b => !b.variant_descriptor);
      const target = baseIdx >= 0 ? baseIdx : 0;
      buckets[target]._listings.push(listing);
    }
  }
  return buckets.map((b, i) => {
    const prices = b._listings
      .map(l => l.price)
      .filter(p => typeof p === 'number' && p > 0)
      .sort((a, c) => a - c);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length === 0 ? null
      : prices.length % 2 ? prices[mid]
      : (prices[mid - 1] + prices[mid]) / 2;
    return {
      id:        'api-v' + i,
      label:     b.variant_descriptor || 'Base',
      price:     median,                  // eBay-derived sold-price median
      priceMin:  prices[0] || null,
      priceMax:  prices[prices.length - 1] || null,
      count:     b._listings.length,
      imageUrl:  b.card_image,            // official Bandai image
      sampleTitle: b.card_name,
      // TCGplayer reference price (USD) — secondary info
      tcg_ref_usd: b.market_price_usd,
      // The actual eBay listings in this bucket (for downstream filtering UI)
      listings:  b._listings,
    };
  });
}

module.exports = {
  TTL_MS,
  extractVariantDescriptor,
  normalizeApiRecord,
  getOnePieceCardVariants,
  descriptorMatchTerms,
  bucketListingsByVariant,
  _cache: CACHE,    // exposed for tests
};
