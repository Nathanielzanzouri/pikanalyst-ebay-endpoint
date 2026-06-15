'use strict';

// SerpApi's eBay engine returns sold_date strings in mixed formats:
//   - English: "Jun 15, 2026"
//   - French:  "14 juin 2026"
//   - French with prefix: "Vendu le 27 avr. 2026"
// Returns a unix-ms timestamp, or null if unparseable.
// Month name lookups — both French (with accents) and English (long + short).
// All keys lowercased so callers normalize before lookup.
const MONTH_LOOKUP = {
  // French
  janvier: 0, janv: 0, jan: 0,
  fevrier: 1, 'février': 1, fev: 1, 'févr': 1,
  mars: 2,
  avril: 3, avr: 3,
  mai: 4,
  juin: 5,
  juillet: 6, juil: 6,
  aout: 7, 'août': 7,
  septembre: 8, sept: 8,
  octobre: 9, oct: 9,
  novembre: 10, nov: 10,
  decembre: 11, 'décembre': 11, 'déc': 11,
  // English (long + short)
  january: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8,
  october: 9,
  november: 10,
  december: 11, dec: 11,
};
function parseSoldDate(s) {
  if (!s || typeof s !== 'string') return null;
  const cleaned = s.replace(/^Vendu le\s+/i, '').trim();
  if (!cleaned) return null;
  // English: "Jun 15, 2026" / "June 15, 2026"
  const enMatch = cleaned.match(/^([a-z]+)\.?\s+(\d{1,2}),\s+(\d{4})$/i);
  if (enMatch) {
    const month = MONTH_LOOKUP[enMatch[1].toLowerCase()];
    if (month !== undefined) {
      return Date.UTC(parseInt(enMatch[3], 10), month, parseInt(enMatch[2], 10));
    }
  }
  // French: "DD <month> YYYY"
  const frMatch = cleaned.match(/^(\d{1,2})\s+([a-zàâäéèêëïîôöùûüç]+)\.?\s+(\d{4})$/i);
  if (frMatch) {
    const month = MONTH_LOOKUP[frMatch[2].toLowerCase()];
    if (month !== undefined) {
      return Date.UTC(parseInt(frMatch[3], 10), month, parseInt(frMatch[1], 10));
    }
  }
  return null;
}

// Map SerpApi's shipping_location strings (in French because ebay.fr) to
// ISO-like country codes used in our existing `country` column / log fields.
const SHIPPING_COUNTRY_MAP = [
  [/japon/i, 'JP'],
  [/royaume.?uni/i, 'GB'],
  [/uk\b/i, 'GB'],
  [/etats?.?unis|united states|usa\b/i, 'US'],
  [/allemagne|germany/i, 'DE'],
  [/italie|italy/i, 'IT'],
  [/espagne|spain/i, 'ES'],
  [/belgique|belgium/i, 'BE'],
  [/pays.?bas|netherlands/i, 'NL'],
  [/canada/i, 'CA'],
  [/france/i, 'FR'],
];
function inferCountry(shippingLocation) {
  if (!shippingLocation) return null;
  for (const [re, code] of SHIPPING_COUNTRY_MAP) if (re.test(shippingLocation)) return code;
  return null;
}

const CURRENCY_RE = /\b(EUR|USD|GBP|JPY|CHF|CAD|AUD|SEK|NOK|DKK|PLN)\b/i;

// Normalize a SerpApi eBay "organic_results" entry into the canonical listing
// shape we feed into filters / median / Supabase upsert. Returns null when
// the item is missing data we require (price, link, parseable date).
function parseSerpListing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const link = raw.link || raw.serpapi_link;
  if (!link) return null;
  const priceExtracted = raw.price?.extracted ?? raw.price?.value ?? null;
  if (priceExtracted == null || isNaN(priceExtracted) || priceExtracted <= 0) return null;
  const soldDateTs = parseSoldDate(raw.sold_date);
  if (!soldDateTs) return null;
  const priceRaw = raw.price?.raw ?? '';
  const ccMatch = priceRaw.match(CURRENCY_RE);
  const currencyOrig = ccMatch ? ccMatch[1].toUpperCase() : 'EUR';
  const sellerCountry = inferCountry(raw.shipping_location || raw.location || null);
  return {
    title:           raw.title ?? null,
    item_url:        link,
    image_url:       raw.thumbnail ?? null,
    price_orig:      priceExtracted,
    currency_orig:   currencyOrig,
    sold_date_ts:    soldDateTs,
    seller_country:  sellerCountry,
    condition:       raw.condition ?? null,
    seller_username: raw.seller?.username ?? null,
    buying_format:   raw.buying_format ?? null,
  };
}

// Map our scan language to the eBay domain to query. JP cards trade mostly
// on ebay.fr (FR sellers + JP sellers shipping to FR, matches our user base).
const DOMAIN_BY_LANGUAGE = {
  JP: 'ebay.fr',
  FR: 'ebay.fr',
  EN: 'ebay.com',
  WORLD: 'ebay.fr',
};

async function fetchEbaySerpApi({ query, language = 'WORLD', limit = 60, fetchImpl = fetch }) {
  const domain = DOMAIN_BY_LANGUAGE[language] || 'ebay.fr';
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error('SERPAPI_KEY missing');
  if (!query) throw new Error('fetchEbaySerpApi: query is required');
  const params = new URLSearchParams({
    engine: 'ebay',
    _nkw: query,
    ebay_domain: domain,
    show_only: 'Sold',
    _ipg: String(limit),
    api_key: apiKey,
  });
  const res = await fetchImpl('https://serpapi.com/search.json?' + params, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SerpApi eBay HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const organic = data?.organic_results ?? data?.search_results ?? [];
  const parsed = organic.map(parseSerpListing).filter(Boolean);
  return {
    listings:    parsed,
    domain,
    ebay_url:    data?.search_metadata?.ebay_url ?? null,
    total_found: data?.search_information?.total_results ?? parsed.length,
  };
}

module.exports = { parseSoldDate, parseSerpListing, fetchEbaySerpApi };
