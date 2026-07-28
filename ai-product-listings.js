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
// NOTE: coins_money is intentionally NOT here — it defaults to google_shopping.
// eBay is thin for modern/European commemorative coins (a 2026 Bulgaria 2€
// returned 0 on eBay but 9-10 coin-shop listings on Shopping: Trésor du
// Patrimoine, Arthur Maury, Philantologie...). Routing coins to eBay made a
// web scan fall to a bogus Gemini estimate while the extension (Lens→Shopping
// path) priced it correctly. Shopping + Lens cards is the identity-first path.
const LISTINGS_SOURCE_BY_CATEGORY = {
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
// Enabled for any category routed to Google Shopping — Lens surfaces
// priced listings from Fnac/Darty/Rakuten for electronics, Cultura/King
// Jouet for toys, Vestiaire/Farfetch for luxury, etc. Skipped for the
// eBay-specialist categories (coins, antiques, sports_card) where the
// listings come from eBay Browse directly.
function shouldUseLensCards(category) {
  return getListingsSource(category) === 'google_shopping';
}

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

// Route a coin to the marketplace + Shopping locale that actually stocks it,
// from Gemini's coin_country. A US coin (Buffalo nickel) lives on ebay.com,
// a euro / world coin on ebay.fr. Defaults to FR — our user base, and the EU
// is the practical hub for euro + world coins (ebay.fr carried the Mongolia
// Togrog). Only US/UK/DE get their own market; everything else → FR.
function coinMarket(coinCountry) {
  const c = String(coinCountry || '').toLowerCase();
  if (/\b(usa|u\.?s\.?a?|united states|etats.?unis|états.?unis|amerique|amerik|american|americaine)\b/.test(c)) {
    return { marketplace: 'EBAY_US', country: 'us' };
  }
  if (/\b(uk|united kingdom|royaume.?uni|grande.?bretagne|britain|british|angleterre|england)\b/.test(c)) {
    return { marketplace: 'EBAY_GB', country: 'gb' };
  }
  if (/\b(germany|allemagne|deutschland|german|allemande)\b/.test(c)) {
    return { marketplace: 'EBAY_DE', country: 'de' };
  }
  return { marketplace: 'EBAY_FR', country: 'fr' };
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

// Drop non-commerce "listings" that leak in via Lens visual_matches: Wikipedia
// / Wikimedia pages, image files, catalog/reference pages. Their "price" is
// bogus (a face value, an image dimension) and pollutes the median — a
// Wikipedia entry showed a 2€ face value for a JO commemorative that sells at
// ~18€. Matched on title AND source.
const JUNK_RE = /\b(wikip|wikimedia|fichier:|file:|\.png|\.jpe?g|\.gif|\.svg|numista)\b/i;
function passesJunkFilter(title, source) {
  const hay = `${title || ''} ${source || ''}`;
  return !JUNK_RE.test(hay);
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

// First 4-digit year (19xx/20xx) in a string. For a sports card, Gemini gives
// card_year as "2023" or a season "2023-24"; we anchor on the base year 2023.
function extractBaseYear(str) {
  const m = String(str || '').match(/\b(?:19|20)\d{2}\b/);
  return m ? m[0] : null;
}

// Vote the card year from the LENS titles — Lens is the identity source of
// truth (it visually matched the exact card), so its consensus year is more
// reliable than Gemini's single guess. Returns the most frequent base year,
// but only when at least two titles agree (else the noise wins). Naturally
// ignores stray years from unrelated matches (a "2026 Hit Parade" box, a
// "2021-22 Mosaic") because the real card's year dominates the vote.
function consensusYearFromLens(lensTitles) {
  if (!Array.isArray(lensTitles) || lensTitles.length === 0) return null;
  const counts = {};
  for (const t of lensTitles) {
    const y = extractBaseYear(t);
    if (y) counts[y] = (counts[y] || 0) + 1;
  }
  let best = null, bestN = 0;
  for (const [y, n] of Object.entries(counts)) if (n > bestN) { best = y; bestN = n; }
  return bestN >= 2 ? best : null;
}

// Sports-card YEAR gate. The single strongest discriminator between otherwise
// similar cards is the year: a "2023-24 Panini Select FIFA Henry auto" scan was
// returning "2017-18" and "2024-25" Henry autos too (they share brand + "Select"
// + "Signatures"), wrecking the median. Require the card's base year in the
// title. A season listing "2023-2024"/"2023-24" contains "2023" and passes;
// "2024-25"/"2017-18" do not. Listings with no year at all are dropped (we
// cannot confirm they are the scanned card — precision over recall).
function passesYearFilter(title, cardYear) {
  if (!cardYear) return true; // no year identified → cannot gate, keep
  return new RegExp('\\b' + cardYear + '\\b').test(String(title));
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
async function fetchListingsForVision({ vision, country, ebayToken, shoppingCaller, lensCards, lensTitles }) {
  if (!isListingsV2Enabled()) return null;
  if (!vision || !vision.category) return null;

  const source = getListingsSource(vision.category);
  const marketplace = getEbayMarketplace(country);
  // Coins: search the marketplace that stocks them, from the coin's country
  // (US coin → ebay.com/us, euro/world → ebay.fr/fr), not the request country
  // (which is often us and starves European coins). Non-coins keep the request
  // country.
  const coinMkt = vision.category === 'coins_money' ? coinMarket(vision.coin_country) : null;
  const searchCountry = coinMkt ? coinMkt.country : country;
  if (coinMkt) console.log(`[Lakkot listings] coin market: ${coinMkt.marketplace} / ${coinMkt.country} (coin_country="${vision.coin_country || ''}")`);
  const geminiMin = Number(vision.estimated_price_min) || 0;
  const geminiMax = Number(vision.estimated_price_max) || 0;
  // Distinguishing tokens from product_name + variant. Any listing whose
  // title contains ZERO of these is rejected — this is what stopped the
  // "Chanel eyeliner" from showing up as proof for a "Chanel 19 Denim bag"
  // scan (both match brand + price band, but no shared model/variant token).
  const modelTokens = extractDistinguishingTokens(vision);
  console.log(`[Lakkot listings] distinguishing tokens for filter:`, modelTokens.join(', '));

  // Sports cards: enforce the YEAR, but ONLY when Lens gives a confident
  // consensus (>= 2 titles agree). Lens is the identity source of truth; a lone
  // Gemini card_year guess is unreliable (it can misread the year on a blurry
  // card) and gating on it wrongly dropped EVERY listing — the Karl-Anthony
  // Towns / Carmelo scans returned 0 that way. No consensus → don't gate on
  // year (better a slightly mixed basket than nothing). Only for sports_card.
  const cardYear = vision.category === 'sports_card' ? consensusYearFromLens(lensTitles) : null;
  if (cardYear) {
    console.log(`[Lakkot listings] sports-card year filter: require ${cardYear} (lens-consensus)`);
  }

  // Helper: apply the filters (brand + price + model + year), return top capAt.
  const CAP = 8;
  const filterAndRank = (items, capAt = CAP) => {
    const run = (useModel) => {
      const kept = [];
      const rejected = { brand: 0, price: 0, model: 0, year: 0, junk: 0 };
      for (const item of items) {
        if (!passesJunkFilter(item.title, item.source || item.seller)) { rejected.junk++; continue; }
        if (!passesBrandFilter(item.title, vision.brand)) { rejected.brand++; continue; }
        if (!passesPriceFilter(item.price, geminiMin, geminiMax)) { rejected.price++; continue; }
        if (useModel && !passesModelFilter(item.title, modelTokens)) { rejected.model++; continue; }
        if (!passesYearFilter(item.title, cardYear)) { rejected.year++; continue; }
        kept.push(item);
        if (kept.length >= capAt) break;
      }
      return { kept, rejected };
    };
    const r = run(true);
    // The model filter is NON-DESTRUCTIVE: when a specific distinguishing token
    // (a bag model like "Kira", a card parallel) isn't repeated in the listing
    // titles it wrongly drops everything — the SAME Chloé bag returned 1 result
    // when Gemini said "cuir noir" but 0 when it said "Kira". Brand + the Lens
    // visual match already anchor identity, so if the model gate empties the
    // basket we relax it rather than return nothing.
    if (r.kept.length === 0 && r.rejected.model > 0) {
      const relaxed = run(false);
      if (relaxed.kept.length > 0) {
        console.log(`[Lakkot listings] model filter relaxed (was 0, tokens: ${modelTokens.join(',')}) → kept ${relaxed.kept.length}`);
        return relaxed;
      }
    }
    return r;
  };

  // ── Lens source: use visualMatches already fetched upstream for luxury.
  // For non-luxury categories the mapping still runs — but we typically get
  // nothing usable so lensListings ends up empty and we fall through to the
  // Shopping/eBay fetch below. Cost of the check is negligible.
  let lensListings = [];
  if (shouldUseLensCards(vision.category) && Array.isArray(lensCards) && lensCards.length > 0) {
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
        const shoppingRes = await runWithTimeout(shoppingCaller(primaryQuery, searchCountry), 6000);
        fallbackRaw = mapShoppingCards(shoppingRes?.cards || []);
      }
    } catch (err) {
      console.warn('[Lakkot listings] fallback fetch failed:', err.message);
      fallbackRaw = [];   // fall through — we may still have Lens listings
    }
  }

  // Coins: ALSO query eBay Browse (FR marketplace) and merge. eBay has by far
  // the best coin coverage — 60 listings for a Bulgaria 2€ / a 1/4€ Cécifoot vs
  // 1 on Shopping — and it was the US marketplace, not eBay, that returned 0
  // before. Shopping still contributes the coin-shop sellers (Trésor du
  // Patrimoine, Arthur Maury). FR marketplace regardless of the request country
  // (our users scan mostly euro / world coins sold on ebay.fr).
  if (vision.category === 'coins_money' && ebayToken) {
    const coinQuery = (vision.query_ebay || primaryQuery || '').trim();
    if (coinQuery) {
      try {
        const ebayCoins = await runWithTimeout(
          fetchEbayBrowseListings({ query: coinQuery, marketplace: coinMkt.marketplace, ebayToken }),
          6000
        );
        console.log(`[Lakkot listings] coins: +${ebayCoins.length} ${coinMkt.marketplace} listings merged`);
        fallbackRaw = [...fallbackRaw, ...ebayCoins];
      } catch (err) {
        console.warn('[Lakkot listings] coins eBay fetch failed:', err.message);
      }
    }
  }

  // Sport cards: ALSO query Google Shopping and merge. eBay Browse alone can
  // return 0 for niche parallels (a Panini Obsidian Gold Mirror), while both
  // Shopping (40+) and eBay (60+) actually carry them. Primary source above is
  // eBay Browse (source='ebay'); Shopping is added here.
  if (vision.category === 'sports_card' && shoppingCaller) {
    const spQuery = (vision.query_shopping || vision.query_ebay || primaryQuery || '').trim();
    if (spQuery) {
      try {
        const spRes = await runWithTimeout(shoppingCaller(spQuery, searchCountry), 6000);
        const spCards = mapShoppingCards(spRes?.cards || []);
        console.log(`[Lakkot listings] sports: +${spCards.length} Shopping listings merged`);
        fallbackRaw = [...fallbackRaw, ...spCards];
      } catch (err) {
        console.warn('[Lakkot listings] sports Shopping fetch failed:', err.message);
      }
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
  console.log(`[Lakkot listings] source=${source} lens=${lensListings.length} fallback=${fallbackRaw.length} merged=${merged.length} kept=${kept.length} rejected(brand=${filtered.rejected.brand},price=${filtered.rejected.price},model=${filtered.rejected.model},year=${filtered.rejected.year},junk=${filtered.rejected.junk})`);

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
          const shoppingRes = await runWithTimeout(shoppingCaller(broadQuery, searchCountry), 6000);
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

  // Compute market price range if we have enough data points. Most categories
  // need >= 3 for a stable range, but COINS have thin coverage and a single
  // real coin-shop listing is a better cote than a Gemini guess (a Mongolia
  // Togrog had 1 real listing at 70€ but showed Gemini's 30€ band). For coins
  // we price from whatever real listings we have (>= 1).
  const minForListings = vision.category === 'coins_money' ? 1 : 3;
  let market_price_min = null;
  let market_price_max = null;
  let price_source = 'gemini';
  if (kept.length >= minForListings) {
    const prices = kept.map(x => x.price).filter(p => p > 0);
    market_price_min = Math.round(Math.min(...prices) * 100) / 100;
    market_price_max = Math.round(Math.max(...prices) * 100) / 100;
    price_source = 'listings';
  }
  // Below the threshold: display the listings but keep Gemini's band (too few
  // points for a proper market range).

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
