// Load .env in development (Render injects env vars directly in production)
if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch {}
}

const express = require('express');
const crypto  = require('crypto');
const sharp   = require('sharp');

const app = express();

// CORS — allow Lovable preview/prod domains and the Chrome extension
const ALLOWED_ORIGINS = [
  'https://yamoapp.lovable.app',
  'https://yamo.app',
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.lovableproject\.com$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '20mb' }));

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Plan daily limits
const PLAN_LIMITS = { free: 10, pro: 100 };

// Validate token, check + increment scan count.
// Returns { user } on success, calls res.status(4xx).json() and returns null on failure.
async function validateAndCount(token, res) {
  if (!token) {
    res.status(401).json({ error: 'missing_token' });
    return null;
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('id, plan, scan_count, scan_reset_at, scan_limit_override')
    .eq('token', token)
    .single();

  if (error || !user) {
    res.status(401).json({ error: 'invalid_token' });
    return null;
  }

  // Reset daily count if it's a new day
  const today = new Date().toISOString().slice(0, 10);
  if (user.scan_reset_at !== today) {
    await supabase
      .from('users')
      .update({ scan_count: 0, scan_reset_at: today })
      .eq('id', user.id);
    user.scan_count = 0;
  }

  // Check limit
  const limit = user.scan_limit_override ?? (PLAN_LIMITS[user.plan] ?? 10);
  if (user.scan_count >= limit) {
    res.status(402).json({ error: 'limit_reached', plan: user.plan, limit, count: user.scan_count });
    return null;
  }

  // Increment
  await supabase
    .from('users')
    .update({ scan_count: user.scan_count + 1 })
    .eq('id', user.id);

  return user;
}

// ─── In-memory cache (30 min) ─────────────────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }); }

// ─── eBay rate limits ──────────────────────────────────────────────────────────
let lastFindingCallTime = 0;
const FINDING_MIN_INTERVAL = 1_000; // eBay allows 18 calls/sec; 1s is safely conservative

// ─── eBay OAuth token cache ────────────────────────────────────────────────────
let ebayOAuthToken  = null;
let ebayTokenExpiry = 0;

// ─── Claude fetch with retry on 529 overload ──────────────────────────────────
async function claudeFetch(body, maxRetries = 3) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 529) {
      const wait = (attempt + 1) * 4000;
      console.warn(`[Yamo] Claude overloaded (529), retry ${attempt + 1}/${maxRetries} in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) { const t = await res.text(); throw new Error(`Claude API ${res.status}: ${t}`); }
    return res.json();
  }
  throw new Error('Claude API overloaded after retries (529)');
}

// ─── Currency normalisation ───────────────────────────────────────────────────
const USD_TO_EUR = 0.92;
function toEur(price, currency) {
  if (currency === 'EUR') return price;
  if (currency === 'USD') return Math.round(price * USD_TO_EUR * 100) / 100;
  return price;
}

// ─── Language helpers ─────────────────────────────────────────────────────────
function applyLanguageToQuery(baseQuery, language) {
  switch (language) {
    case 'JP': return baseQuery + ' Japanese';
    case 'FR': case 'EN': case 'WORLD': default: return baseQuery;
  }
}

function getMarketsForLanguage(language) {
  switch (language) {
    case 'JP':    return ['EBAY_FR', 'EBAY_US', 'EBAY_DE', 'EBAY_GB'];
    case 'FR':    return ['EBAY_FR', 'EBAY_GB', 'EBAY_DE'];
    case 'EN':    return ['EBAY_US', 'EBAY_GB', 'EBAY_FR'];
    case 'WORLD': default: return ['EBAY_FR', 'EBAY_GB', 'EBAY_US', 'EBAY_DE'];
  }
}

// ─── Graded card filter ───────────────────────────────────────────────────────
const GRADING_KEYWORDS = [
  // Major grading companies
  'psa', 'cgc', 'bgs', 'sgc', 'beckett',
  // Minor / European (only unambiguous company names — NOT 'tag', 'ace', 'mnt', 'pcs', 'acs', 'ags', 'icg')
  'ccc', 'hga', 'pfx', 'fcg', 'sfg',
  // Collect Aura
  'collectaura', 'collect aura', 'collect-aura', 'ca grade', 'ca 9', 'ca 10',
  // French grading companies
  'pca', 'pca 9', 'pca9', 'pca 10', 'pca10',
  'carte gradée', 'carte gradee', 'cartes gradées', 'cartes gradees',
  // Generic terms
  'graded', 'slab', 'slabbed',
  'gem mint', 'gem mt', 'gem-mint',
  // Grade scores with company prefix (safe — require company name)
  'psa 9', 'psa 10', 'cgc 9', 'cgc 10', 'bgs 9', 'bgs 10',
];
function isGradedCard(title) {
  const lower = title.toLowerCase();
  return GRADING_KEYWORDS.some(kw => lower.includes(kw));
}

function isLot(title) {
  const lower = title.toLowerCase();
  return /\blot\b|\bbundle\b|\blot de\b|\bpack\b|\bx\d{2,}\b|\d{2,}x\b/.test(lower);
}

function isBooster(title) {
  const lower = title.toLowerCase();
  return [
    'booster', 'karten booster', 'pokemon karten', 'pack pokemon',
    'pack de boosters', 'display', 'etb', 'elite trainer',
  ].some(kw => lower.includes(kw));
}

function isFigurine(title) {
  const lower = title.toLowerCase();
  return [
    'figurine', 'jouet', 'toy', 'peluche', 'plush', 'figure',
    'happy meal', 'statuette', 'mini figure',
  ].some(kw => lower.includes(kw));
}

function isMultiChoice(title) {
  const lower = title.toLowerCase();
  return [
    'au choix', 'à l\'unité', "a l'unite", 'liste déroulante', 'liste deroulante',
    'you choose', 'pick one', 'choose your', 'your choice',
  ].some(kw => lower.includes(kw));
}

function isSpecialEdition(title) {
  const lower = title.toLowerCase();
  return [
    'ars 10', 'ars10', 'competition', 'top prize', 'tournament prize',
    'coffret', 'collection box', 'box set', 'complete set',
    'sealed', 'scellé', 'scelle', 'unopened',
    'jumbo', 'oversized',
    'korean', 'coréen', 'coreen',
  ].some(kw => lower.includes(kw));
}

// ─── Card identity filter ─────────────────────────────────────────────────────
function filterByCardIdentity(query, items, getTitleFn, language = 'WORLD') {
  if (language === 'JP') {
    const cardNumber = query.match(/\b(\d{2,3}\/\d{2,3})\b/);
    if (!cardNumber) {
      console.log('[Yamo] JP flag — name-based card identity filter disabled, returning all items');
      return items;
    }
    // fall through to number filter below
  }

  const cardNumber = query.match(/\b(\d{2,3}\/\d{2,3})\b/);

  if (cardNumber) {
    const targetNum = cardNumber[1];
    const before = items.length;
    const filtered = items.filter(item => {
      const title = getTitleFn(item);
      const itemNum = title.match(/\b(\d{2,3}\/\d{2,3})\b/);
      if (!itemNum) return language === 'JP';
      return itemNum[1] === targetNum;
    });
    console.log(`[Pikanalyst] Card identity filter: by number ${targetNum} | ${before} → ${filtered.length}`);
    return filtered;
  }

  // No card number — filter by Pokemon name using multilingual synonyms
  const words = query
    .replace(/\b(me\d+|ev\d+|sv\d*|eb\d+|ma)\b/gi, '')
    .replace(/\b(japanese|deutsch|français|francais)\b/gi, '')
    .replace(/[-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length >= 4);

  if (words.length === 0) return items;

  const pokemonName = words[0].toLowerCase();
  const variants = getNameVariants(pokemonName);
  const before = items.length;
  const filtered = items.filter(item => {
    const titleLower = getTitleFn(item).toLowerCase();
    return variants.some(v => titleLower.includes(v));
  });
  console.log(`[Pikanalyst] Card identity filter: by name "${pokemonName}" (variants: ${variants.join(', ')}) | ${before} → ${filtered.length}`);
  return filtered;
}

// Two-pass outlier removal: trim tails then remove anything >2.5x or <0.25x provisional median
function removeOutliers(prices) {
  if (prices.length < 3) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.10);
  const trimmed = trimCount > 0 ? sorted.slice(trimCount, sorted.length - trimCount) : sorted;
  if (trimmed.length === 0) return sorted;
  const provisionalMedian = trimmed[Math.floor(trimmed.length / 2)];
  const clean = sorted.filter(p => p <= provisionalMedian * 2.5 && p >= provisionalMedian * 0.25);
  console.log(`[Pikanalyst] Outlier removal: ${prices.length} → ${clean.length} | provisional median: $${provisionalMedian.toFixed(2)}`);
  return clean.length > 0 ? clean : sorted;
}

// Pokemon name synonyms (FR / EN / DE / JP romanized)
const POKEMON_SYNONYMS = [
  // Gen 1 starters
  ['bulbizarre', 'bulbasaur', 'bisasam'],
  ['florizarre', 'venusaur', 'bisaflor'],
  ['salamèche', 'salameche', 'charmander', 'glumanda'],
  ['reptincel', 'charmeleon', 'glutexo'],
  ['dracaufeu', 'charizard', 'glurak', 'lizardon'],
  ['carapuce', 'squirtle', 'schiggy'],
  ['carabaffe', 'wartortle', 'schillok'],
  ['tortank', 'blastoise', 'turtok'],
  // Gen 1 iconic
  ['pikachu'],
  ['raichu'],
  ['mewtwo', 'mewtu'],
  ['mew'],
  ['magicarpe', 'magikarp', 'karpador'],
  ['ronflex', 'snorlax', 'relaxo'],
  ['lokhlass', 'lapras'],
  ['évoli', 'evoli', 'eevee', 'evoli'],
  ['pyroli', 'flareon', 'flamara'],
  ['aquali', 'vaporeon', 'aquana'],
  ['voltali', 'jolteon', 'blitza'],
  ['noctali', 'umbreon', 'nachtara'],
  ['mentali', 'espeon', 'psiana'],
  ['givrali', 'glaceon', 'glaziola'],
  ['phyllali', 'leafeon', 'folipurba'],
  ['nymphali', 'sylveon', 'feelinara'],
  ['braségali', 'brasegali', 'sylveon', 'feelinara'],
  ['électhor', 'electhor', 'zapdos', 'donnerblitz'],
  ['artikodin', 'articuno', 'arktos'],
  ['sulfura', 'moltres', 'lavados'],
  ['feunard', 'ninetales', 'vulnona'],
  ['staross', 'starmie'],
  ['miaouss', 'meowth', 'mauzi'],
  ['rondoudou', 'jigglypuff', 'pummeluff'],
  ['géngar', 'gengar'],
  ['dracolosse', 'dragonite', 'dragoran'],
  ['ditto', 'metamorph'],
  // Gen 2
  ['meganium'],
  ['flambusard', 'typhlosion', 'tornupto'],
  ['aligatueur', 'feraligatr', 'impergator'],
  ['lugia'],
  ['ho-oh', 'ho oh', 'houou'],
  ['celebi'],
  // Gen 3+
  ['metagross'],
  ['rayquaza'],
  ['jirachi'],
  ['deoxys'],
  ['dialga'],
  ['palkia'],
  ['giratina'],
  ['lucario'],
  ['darkrai'],
  ['garchompe', 'garchomp'],
  ['togekiss'],
  ['tyranocif', 'tyranitar', 'despotar'],
  ['victini'],
  ['reshiram'],
  ['zekrom'],
  ['kyurem'],
  ['xerneas'],
  ['yveltal'],
  ['zygarde'],
  ['solgaleo'],
  ['lunala'],
  ['necrozma'],
  ['zacian'],
  ['zamazenta'],
  ['eternatus'],
  ['koraidon'],
  ['miraidon'],
  ['skeledirge', 'cramoisiel'],
  ['armarouge', 'armorouqe'],
  ['ceruledge'],
  // Misc
  ['gamblast', 'jumpluff', 'kappalores'],
];

function getNameVariants(pokemonName) {
  const lower = pokemonName.toLowerCase();
  for (const variants of POKEMON_SYNONYMS) {
    if (variants.includes(lower)) return variants;
  }
  return [lower];
}

function titleMatchesCard(query, resultTitle) {
  const qLower = query.toLowerCase();
  const rLower = resultTitle.toLowerCase();

  let queryGroup = null;
  for (const variants of POKEMON_SYNONYMS) {
    if (variants.some(v => qLower.includes(v))) { queryGroup = variants; break; }
  }
  if (!queryGroup) return true;

  for (const variants of POKEMON_SYNONYMS) {
    if (variants === queryGroup) continue;
    if (variants.some(v => rLower.includes(v))) return false;
  }
  return true;
}

// ─── Fake Whatnot placeholder titles ─────────────────────────────────────────
const FAKE_TITLES = [
  // Generic "card on screen" placeholders
  'carte vue en live',
  'carte vue a l\'écran',
  'carte vue à l\'écran',
  'carte vue a l\'ecran',
  'carte vue à l\'ecran',
  'card shown in live',
  'card on screen',
  'article en live',
  'live item',
  'en live',
  'vue en live',
  // Auction house filler: "Pas d'annulation 1€ #25", "No cancellation 1€ #3", etc.
  'pas d\'annulation',
  'pas d\'annulation',
  'no cancellation',
  'pdd ',           // "PDD 1 PAS D'ANNULATION", "PDD #25" etc.
  // Generic numbered lot placeholders
  'lot #',
  'item #',
  'article #',
  'surprise ',
  'mystère',
  'mystere',
  'blind box',
  // "Sold by the unit" placeholders — no card name, just a category label
  'carte à l\'unit',
  'carte a l\'unit',
  'carte a l\'unité',
  'carte à l\'unité',
  'cartes à l\'unit',
  'cartes a l\'unit',
  'vendu à l\'unit',
  'vendu a l\'unit',
  'à l\'unité',
  'a l\'unite',
];
function isFakeTitle(title) {
  const lower = title.toLowerCase().trim();
  return FAKE_TITLES.some(fake => lower.includes(fake));
}

const SHOE_KEYWORDS = ['nike','adidas','jordan','air max','dunk','yeezy','new balance','asics','puma','reebok','converse','vans','saucony','salomon','on running','nb ','af1','force 1','blazer','cortez','pegasus','ultraboost','stan smith','superstar','gazelle','990','991','992','993','2002','990v'];
function isShoeTitle(title) {
  const lower = title.toLowerCase();
  return SHOE_KEYWORDS.some(k => lower.includes(k));
}
// Strip EU size info ("taille 37,5", "taille 42", "T42", "sz 42" etc.) from shoe titles
function stripShoeSizeFromTitle(title) {
  return title
    .replace(/\btaille\s*[\d,\.]+/gi, '')
    .replace(/\bT\s*[\d,\.]+(?=\s|$)/gi, '')
    .replace(/\bsz\.?\s*[\d,\.]+/gi, '')
    .replace(/\bsize\s*[\d,\.]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Helper: recursive key search in deep object ──────────────────────────────
function findDeep(obj, key, depth = 0) {
  if (depth > 10 || obj === null || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findDeep(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ─── DOM title cleaner ────────────────────────────────────────────────────────
function buildEbayQuery(domTitle) {
  return domTitle
    .replace(/^\s*\d+\s*\[\s*/, '')
    .replace(/\s*#\d+\s*$/, '')
    .replace(/[^\u0000-\u024F]/g, '')
    .replace(/[()]/g, '')          // strip parentheses (eBay treats them as grouping operators)
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Parse Whatnot-style "(SETCODE NUMBER)" titles ────────────────────────────
// e.g. "Charizard (CLL 003)" → { cardName: "Charizard", setCode: "CLL", cardNum: "003" }
function parseWhatnotTitle(ebayQuery) {
  const m = ebayQuery.match(/^(.+?)\s+([A-Za-z]{2,5})\s+(\d{2,4}(?:\/\d{2,4})?)\s*$/);
  if (!m) return null;
  // The middle token must look like a set abbreviation (all uppercase after trim)
  const setCode = m[2];
  if (!/^[A-Z]{2,5}$/.test(setCode)) return null;
  return { cardName: m[1].trim(), setCode, cardNum: m[3] };
}

// ─── Query builder ────────────────────────────────────────────────────────────
function buildSearchQuery(card) {
  const name = card.card_name || '';
  const number = (card.card_number || '').replace('/', ' ').trim();
  const setMatch = (card.set_name || '').match(/\b(\d{3}|base set|jungle|fossil|rocket|neo|ex|gx|vmax|vstar)\b/i);
  const setShort = setMatch ? setMatch[1] : '';
  const condMap = { 'Near Mint': 'NM', 'Lightly Played': 'LP', 'Moderately Played': 'MP', 'Heavily Played': 'HP', 'Damaged': 'HP' };
  return [name, number, setShort, condMap[card.condition] || 'NM'].filter(Boolean).join(' ').trim();
}

function buildBrowseQueries(card) {
  const queries = [];

  if (card.ebay_search) queries.push(card.ebay_search);

  const name     = card.card_name || '';
  const number   = card.card_number || '';
  const setWords = (card.set_name || '').split(/\s+/).filter(w => !/^(scarlet|violet|sword|shield|sun|moon|x|y|&)$/i.test(w));
  const setShort = setWords.slice(-2).join(' ').trim();

  if (name && number && setShort) queries.push(`${name} ${number} ${setShort} pokemon card`);
  if (name && setShort)           queries.push(`${name} ${setShort} pokemon card`);
  if (name && number)             queries.push(`${name} ${number} pokemon card`);
  if (name)                       queries.push(`${name} pokemon card`);

  return [...new Set(queries.map(q => q.trim()).filter(Boolean))];
}

// ─── eBay OAuth token ─────────────────────────────────────────────────────────
async function getEbayOAuthToken() {
  if (ebayOAuthToken && Date.now() < ebayTokenExpiry) return ebayOAuthToken;
  const clientId = process.env.EBAY_APP_ID;
  const certId   = process.env.EBAY_CERT_ID;
  console.log('[Yamo] Fetching eBay OAuth token...');
  const creds = Buffer.from(`${clientId}:${certId}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`OAuth ${res.status}: ${t.slice(0, 200)}`); }
  const d = await res.json();
  ebayOAuthToken  = d.access_token;
  ebayTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  console.log('[Yamo] eBay OAuth token OK, expires in', d.expires_in, 's');
  return ebayOAuthToken;
}

// ─── eBay Finding API (legacy, rate limit 5000/day) ──────────────────────────
async function fetchEbayFinding(card, language = 'WORLD') {
  const ebayAppId = process.env.EBAY_APP_ID;
  const now = Date.now();
  if (now - lastFindingCallTime < FINDING_MIN_INTERVAL) {
    throw new Error(`Finding API cooldown (${Math.round((FINDING_MIN_INTERVAL - (now - lastFindingCallTime)) / 1000)}s)`);
  }
  lastFindingCallTime = now;

  const baseQuery = card.ebay_search || buildSearchQuery(card);
  const query = applyLanguageToQuery(baseQuery, language);
  console.log('[Yamo] eBay Finding query:', query, '| language:', language);

  const GLOBAL_IDS = getMarketsForLanguage(language).map(m => m.replace('_', '-'));
  let allItems = [];
  for (const globalId of GLOBAL_IDS) {
    const qs = [
      `GLOBAL-ID=${globalId}`,
      'OPERATION-NAME=findCompletedItems',
      'SERVICE-VERSION=1.0.0',
      `SECURITY-APPNAME=${encodeURIComponent(ebayAppId)}`,
      'RESPONSE-DATA-FORMAT=JSON',
      `keywords=${encodeURIComponent(query)}`,
      'paginationInput.entriesPerPage=20',
      'sortOrder=EndTimeSoonest',
    ].join('&');
    try {
      const res = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${qs}`);
      if (!res.ok) {
        const b = await res.text().catch(() => '');
        console.warn(`[Yamo] Finding ${globalId} HTTP ${res.status}: ${b.slice(0, 100)}`);
        continue;
      }
      const data = await res.json();
      const root = data?.findCompletedItemsResponse?.[0];
      const ack  = root?.ack?.[0];
      if (ack === 'Failure' || ack === 'PartialFailure') {
        const err    = root?.errorMessage?.[0]?.error?.[0];
        const errId  = err?.errorId?.[0] ?? '';
        const errMsg = err?.message?.[0] ?? 'unknown';
        if (errId === '10001') { lastFindingCallTime = Date.now() + 60_000; }
        console.warn(`[Yamo] Finding ${globalId} API error ${errId}: ${errMsg}`);
        continue;
      }
      const items = root?.searchResult?.[0]?.item ?? [];
      console.log(`[Yamo] Finding ${globalId}: ${items.length} results`);
      allItems = allItems.concat(items);
    } catch (e) {
      console.warn(`[Yamo] Finding ${globalId} exception: ${e.message}`);
    }
  }

  if (allItems.length === 0) throw new Error('Finding: 0 results across all markets');

  const sold = allItems
    .filter(i => i?.sellingStatus?.[0]?.sellingState?.[0] === 'EndedWithSales')
    .sort((a, b) => {
      const tA = new Date(a?.listingInfo?.[0]?.endTime?.[0] ?? 0).getTime();
      const tB = new Date(b?.listingInfo?.[0]?.endTime?.[0] ?? 0).getTime();
      return tB - tA;
    });

  if (sold.length === 0) throw new Error('Finding: 0 sold results');

  let gradedOut = 0, lotOut = 0, boostersOut = 0, figuresOut = 0, multichoiceOut = 0, specialOut = 0;
  const clean = sold.filter(i => {
    const t = i?.title?.[0] ?? '';
    if (isGradedCard(t))   { gradedOut++;     return false; }
    if (isLot(t))          { lotOut++;        return false; }
    if (isBooster(t))      { boostersOut++;   return false; }
    if (isFigurine(t))     { figuresOut++;    return false; }
    if (isMultiChoice(t))  { multichoiceOut++;return false; }
    if (isSpecialEdition(t)){ specialOut++;   return false; }
    return true;
  });
  console.log(`[Yamo] Finding sold: ${sold.length} | graded=${gradedOut} | lots=${lotOut} | boosters=${boostersOut} | figurines=${figuresOut} | multichoice=${multichoiceOut} | special=${specialOut} | clean=${clean.length}`);

  if (clean.length === 0) throw new Error('Finding: 0 results after graded/lot filter');

  const identity = filterByCardIdentity(query, clean, i => i?.title?.[0] ?? '', language);

  if (identity.length === 0) throw new Error('Finding: 0 results after card identity filter');

  const rawPrices = identity
    .map(i => {
      const currency = i?.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] ?? 'EUR';
      const value    = parseFloat(i?.sellingStatus?.[0]?.currentPrice?.[0]?.__value__);
      return isNaN(value) || value <= 0 ? null : toEur(value, currency);
    })
    .filter(v => v != null);

  if (rawPrices.length === 0) throw new Error('Finding: 0 valid prices after currency conversion');

  const cleanPrices = removeOutliers(rawPrices);
  const avg = cleanPrices.reduce((s, v) => s + v, 0) / cleanPrices.length;
  console.log('[Yamo] Finding (ungraded)', cleanPrices.length, 'sales:', cleanPrices.map(p => '€' + p.toFixed(2)).join(', '), '→ avg €' + avg.toFixed(2));

  const listings = identity.slice(0, 10).map(i => {
    const cur  = i?.sellingStatus?.[0]?.currentPrice?.[0]?.['@currencyId'] ?? 'EUR';
    const val  = parseFloat(i?.sellingStatus?.[0]?.currentPrice?.[0]?.__value__);
    const priceEur = isNaN(val) || val <= 0 ? null : toEur(val, cur);
    return {
      title:    i?.title?.[0] ?? '',
      price:    priceEur != null ? Math.round(priceEur * 100) / 100 : null,
      soldDate: i?.listingInfo?.[0]?.endTime?.[0] ?? null,
      imageUrl: (i?.galleryURL?.[0] ?? '').replace('http://', 'https://') || null,
      itemUrl:  i?.viewItemURL?.[0] ?? null,
      country:  i?.country?.[0] ?? null,
    };
  }).filter(l => l.price != null);

  return {
    market_price_usd: Math.round(avg * 100) / 100,
    price_low_usd:    Math.round(Math.min(...cleanPrices) * 100) / 100,
    price_high_usd:   Math.round(Math.max(...cleanPrices) * 100) / 100,
    ebay_sales_count: cleanPrices.length,
    gradedOut,
    price_source:     'ebay',
    ebay_url:         `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1`,
    listings,
  };
}

// ─── eBay Browse API (OAuth, active listings) ─────────────────────────────────
const BROWSE_SITE_MAP = { EBAY_FR: 'www.ebay.fr', EBAY_US: 'www.ebay.com', EBAY_DE: 'www.ebay.de', EBAY_GB: 'www.ebay.co.uk' };

async function fetchEbayBrowse(card, token, language = 'WORLD') {
  const baseQueries = buildBrowseQueries(card);
  const queries = baseQueries.map(q => applyLanguageToQuery(q, language));

  if (language === 'JP' && queries.length > 0) {
    const primary = queries[0].split(/\s+/);
    if (primary.length > 2) queries.push(primary.slice(1).join(' '));
    if (primary.length > 3) queries.push(primary.slice(2).join(' '));
  }

  const MARKETS = getMarketsForLanguage(language).map(id => ({ id, site: BROWSE_SITE_MAP[id] ?? 'www.ebay.com' }));

  for (const query of queries) {
    const settled = await Promise.allSettled(
      MARKETS.map(async (market) => {
        const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&filter=soldItems:true&sort=endDateDesc&limit=200`;
        console.log(`[Pikanalyst] Browse API URL [${market.id}]:`, url);
        const res = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': market.id,
            'Content-Type': 'application/json',
          },
        });
        if (!res.ok) { const t = await res.text(); throw new Error(`Browse ${market.id} ${res.status}: ${t.slice(0, 100)}`); }
        const data = await res.json();
        console.log(`[Pikanalyst] Browse raw [${market.id}]: total=${data.total ?? '?'} returned=${data.itemSummaries?.length ?? 0}`);
        return { market, items: data.itemSummaries ?? [] };
      })
    );

    const seen = new Set();
    const combined = [];
    const counts = {};
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        console.warn('[Pikanalyst] Browse market failed:', result.reason?.message ?? String(result.reason));
        continue;
      }
      const { market, items } = result.value;
      counts[market.id] = items.length;
      for (const item of items) {
        if (!seen.has(item.itemId)) {
          seen.add(item.itemId);
          combined.push({ ...item, _market: market.id, _site: market.site });
        }
      }
    }

    const frCount = counts['EBAY_FR'] ?? 0;
    const usCount = counts['EBAY_US'] ?? 0;
    const deCount = counts['EBAY_DE'] ?? 0;

    let gradedOut = 0, lotOut = 0, boostersOut = 0, figuresOut = 0, multichoiceOut = 0, specialOut = 0;
    const cleanItems = combined.filter(i => {
      const t = i.title ?? '';
      if (isGradedCard(t))    { gradedOut++;     return false; }
      if (isLot(t))           { lotOut++;        return false; }
      if (isBooster(t))       { boostersOut++;   return false; }
      if (isFigurine(t))      { figuresOut++;    return false; }
      if (isMultiChoice(t))   { multichoiceOut++;return false; }
      if (isSpecialEdition(t)){ specialOut++;    return false; }
      return true;
    });

    console.log(`[Pikanalyst] Browse raw: ${combined.length} | FR: ${frCount} | US: ${usCount} | DE: ${deCount} | graded=${gradedOut} | lots=${lotOut} | boosters=${boostersOut} | figurines=${figuresOut} | multichoice=${multichoiceOut} | special=${specialOut} | clean=${cleanItems.length} | query: "${query}"`);

    const identityItems = filterByCardIdentity(query, cleanItems, i => i.title ?? '', language);

    console.log('CLEAN items used for median:');
    identityItems.forEach((item, idx) => {
      const raw = parseFloat(item.price?.value);
      const cur = item.price?.currency ?? 'EUR';
      const eur = isNaN(raw) ? '?' : toEur(raw, cur).toFixed(2);
      console.log(`${idx + 1}. [€${eur} (${cur} ${item.price?.value})] [${item._market}] ${item.title}`);
    });

    const rawPrices = identityItems
      .map(i => {
        const value    = parseFloat(i.price?.value);
        const currency = i.price?.currency ?? 'EUR';
        return isNaN(value) || value <= 0 ? null : toEur(value, currency);
      })
      .filter(v => v != null);

    if (rawPrices.length === 0) {
      console.log('[Pikanalyst] Browse 0 clean results for query:', query);
      continue;
    }

    const prices = removeOutliers(rawPrices).sort((a, b) => a - b);

    console.log('[Pikanalyst] eBay Browse (ungraded combined):', prices.length, 'listings | query:', query);
    const median = prices[Math.floor(prices.length / 2)];
    const primarySite = frCount > 0 ? 'www.ebay.fr' : 'www.ebay.com';
    const markets = Object.entries(counts).filter(([, n]) => n > 0).map(([id]) => id);

    const listings = identityItems.slice(0, 10).map(i => {
      const val  = parseFloat(i.price?.value);
      const cur  = i.price?.currency ?? 'EUR';
      const priceEur = isNaN(val) || val <= 0 ? null : toEur(val, cur);
      return {
        title:    i.title ?? '',
        price:    priceEur != null ? Math.round(priceEur * 100) / 100 : null,
        soldDate: i.lastSoldDate ?? null,
        imageUrl: i.image?.imageUrl ?? null,
        itemUrl:  i.itemWebUrl ?? null,
        country:  i.itemLocation?.country ?? null,
      };
    }).filter(l => l.price != null);

    return {
      market_price_usd: Math.round(median * 100) / 100,
      price_low_usd:    Math.round(prices[Math.floor(prices.length * 0.10)] * 100) / 100,
      price_high_usd:   Math.round(prices[Math.floor(prices.length * 0.90)] * 100) / 100,
      ebay_sales_count: prices.length,
      gradedOut,
      markets,
      price_source:     'ebay',
      ebay_url:         `https://${primarySite}/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1`,
      listings,
    };
  }

  throw new Error('Browse: 0 results for all queries and markets');
}

// ─── pokemontcg.io ────────────────────────────────────────────────────────────
const CONDITION_MULTIPLIERS = {
  'Near Mint': 1.00, 'Lightly Played': 1.00, 'Moderately Played': 0.70,
  'Heavily Played': 0.50, 'Damaged': 0.30,
};

async function fetchPokemonTCG(card) {
  const NULL_PRICES = { market_price_usd: null, price_low_usd: null, price_high_usd: null, price_source: 'pokemontcg', ebay_sales_count: 0, ebay_url: null };
  const rawName    = card.card_name.replace(/"/g, '').trim();
  // Preserve non-standard numbers like "TG04"; only strip non-digits for plain NNN/NNN format
  const rawNum     = card.card_number ? card.card_number.split('/')[0].trim() : '';
  const numberPart = rawNum ? (/^[a-zA-Z]+\d+$/.test(rawNum) ? rawNum : rawNum.replace(/\D/g, '') || null) : null;
  const setName    = (card.set_name || '').replace(/"/g, '').trim();
  const setKeyword = setName.split(/\s+/).filter(Boolean).pop() || '';

  const altName = rawName
    .replace(/^Mega\s+/i, 'M ')
    .replace(/\s+EX$/i, '-EX')
    .replace(/\s+GX$/i, '-GX');

  const queries = [];
  if (numberPart && setName)      queries.push(`name:"${rawName}" number:"${numberPart}" set.name:"${setName}"`);
  if (numberPart)                 queries.push(`name:"${rawName}" number:"${numberPart}"`);
  if (altName !== rawName && setName) queries.push(`name:"${altName}" set.name:"${setName}"`);
  if (setName)                    queries.push(`name:"${rawName}" set.name:"${setName}"`);
  if (!numberPart && !setName) {
    console.warn('[Pikanalyst] TCG skipped — no card_number or set_name');
    return NULL_PRICES;
  }
  if (altName !== rawName)        queries.push(`name:"${altName}"`);
  queries.push(`name:"${rawName}"`);

  for (const q of [...new Set(queries)]) {
    console.log('[Pikanalyst] pokemontcg.io query:', q);
    try {
      const ctrl = new AbortController();
      const tcgTimer = setTimeout(() => ctrl.abort(), 8000);
      let res;
      try {
        res = await fetch(
          `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&select=id,name,number,set,tcgplayer&pageSize=20`,
          { headers: { 'Accept': 'application/json' }, signal: ctrl.signal }
        );
      } finally {
        clearTimeout(tcgTimer);
      }
      if (!res.ok) continue;
      const data  = await res.json();
      const cards = data.data ?? [];

      const sorted = setKeyword
        ? [...cards].sort((a, b) => {
            const aOk = a.set?.name?.toLowerCase().includes(setKeyword.toLowerCase()) ? 0 : 1;
            const bOk = b.set?.name?.toLowerCase().includes(setKeyword.toLowerCase()) ? 0 : 1;
            return aOk - bOk;
          })
        : cards;

      for (const c of sorted) {
        const prices = c.tcgplayer?.prices;
        if (!prices) continue;
        const marketPrice = Object.values(prices).find(p => p?.market != null)?.market;
        if (marketPrice) {
          console.log('[Pikanalyst] TCG match:', c.name, '|', c.set?.name, '→ $' + marketPrice);
          const mult = CONDITION_MULTIPLIERS[card.condition] ?? 1.0;
          const m    = Math.round(marketPrice * mult * 100) / 100;
          return {
            market_price_usd: m,
            price_low_usd:    Math.round(m * 0.80 * 100) / 100,
            price_high_usd:   Math.round(m * 1.25 * 100) / 100,
            price_source:     'pokemontcg',
            ebay_sales_count: 0,
            ebay_url:         c.tcgplayer?.url ?? null,
          };
        }
      }
    } catch (e) { continue; }
  }

  console.warn('[Pikanalyst] pokemontcg.io: no price for', rawName, numberPart);
  return NULL_PRICES;
}

async function fetchEbayAny(card, language = 'WORLD') {
  const ebayAppId = process.env.EBAY_APP_ID;
  const certId    = process.env.EBAY_CERT_ID;
  try {
    if (ebayAppId) return await fetchEbayFinding(card, language);
  } catch (e) {
    console.warn('[Yamo] Finding API failed:', e.message, '→ trying Browse API...');
  }
  if (ebayAppId && certId) {
    const token = await getEbayOAuthToken();
    return await fetchEbayBrowse(card, token, language);
  }
  throw new Error('No eBay credentials available');
}

async function fetchPrices(card, language = 'WORLD') {
  const fetchTCG = language === 'EN';
  const [ebaySettled, tcgSettled] = await Promise.allSettled([
    fetchEbayAny(card, language),
    fetchTCG ? fetchPokemonTCG(card) : Promise.resolve(null),
  ]);
  const ebay = ebaySettled.status === 'fulfilled' ? ebaySettled.value : null;
  const tcg  = fetchTCG && tcgSettled.status === 'fulfilled' ? tcgSettled.value : null;
  if (ebay) console.log('[Yamo] eBay OK:', ebay.ebay_sales_count, 'items, €' + ebay.market_price_usd);
  else      console.warn('[Yamo] eBay failed:', ebaySettled.reason?.message);
  if (fetchTCG && tcg)  console.log('[Yamo] TCG OK: $' + tcg.market_price_usd);
  return {
    market_price_usd:  ebay?.market_price_usd ?? tcg?.market_price_usd ?? null,
    price_low_usd:     ebay?.price_low_usd    ?? tcg?.price_low_usd    ?? null,
    price_high_usd:    ebay?.price_high_usd   ?? tcg?.price_high_usd   ?? null,
    price_source:      ebay ? 'ebay' : (tcg ? 'pokemontcg' : 'none'),
    ebay_market_price: ebay?.market_price_usd ?? null,
    ebay_sales_count:  ebay?.ebay_sales_count  ?? 0,
    ebay_url:          ebay?.ebay_url           ?? null,
    tcg_market_price:  tcg?.market_price_usd  ?? null,
    tcg_url:           tcg?.ebay_url           ?? null,
    listings:          ebay?.listings          ?? [],
  };
}

// ─── KicksDB + StockX price lookup (server-side) ─────────────────────────────
async function fetchKicksDBServerPrice(item) {
  const query = `${item.brand || ''} ${item.model || ''} ${item.colorway || ''}`.trim();
  if (!query) return null;
  const sizeUs = item.size_us ?? item.size_us_m ?? item.size_us_w ?? null;

  // 1. KicksDB direct
  try {
    const variants = [
      query,
      query.replace(/^Nike\s+/i, ''),
      query.replace(/^Adidas\s+/i, ''),
      query.replace(/^(Nike|Adidas|Jordan|New Balance|Asics|Puma|Reebok|Converse|Vans)\s+/i, ''),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    let product = null;
    for (const q of variants) {
      const searchRes = await fetch(
        `https://api.kicks.dev/v1/products/search?query=${encodeURIComponent(q)}&limit=1`,
        { headers: { 'x-api-key': process.env.KICKSDB_API_KEY } }
      );
      const searchData = await searchRes.json();
      product = searchData?.data?.[0];
      if (product) break;
    }
    if (product) {
      const priceRes = await fetch(
        `https://api.kicks.dev/v1/products/${product.id}/prices${sizeUs ? `?size=${sizeUs}` : ''}`,
        { headers: { 'x-api-key': process.env.KICKSDB_API_KEY } }
      );
      const priceData = await priceRes.json();
      const stockxPrice = priceData?.data?.stockx?.price ?? null;
      const goatPrice   = priceData?.data?.goat?.price   ?? null;
      if (stockxPrice != null || goatPrice != null) {
        return { stockx_lowest_ask: stockxPrice, goat_price: goatPrice, market_source: 'kicksdb' };
      }
    }
  } catch (e) { console.warn('[Yamo] KicksDB error:', e.message); }

  // 2. StockX Algolia fallback
  for (const host of ['xw7sbct9ad-dsn.algolia.net', 'xw7sbct9ad.algolia.net']) {
    try {
      const r = await fetch(`https://${host}/1/indexes/products/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Algolia-Application-Id': 'XW7SBCT9AD',
          'X-Algolia-API-Key': '6b5e76b49705eb9f51a06d3c82f7acee',
        },
        body: JSON.stringify({ params: `query=${encodeURIComponent(query)}&hitsPerPage=1` }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const d = await r.json();
        const hit       = d?.hits?.[0];
        const lastSale  = hit?.market?.lastSale  ?? hit?.last_sale  ?? null;
        const lowestAsk = hit?.market?.lowestAsk ?? hit?.lowest_ask ?? null;
        if (lastSale != null || lowestAsk != null) {
          return {
            stockx_last_sale:  lastSale  != null ? Math.round(lastSale  * 100) / 100 : null,
            stockx_lowest_ask: lowestAsk != null ? Math.round(lowestAsk * 100) / 100 : null,
            goat_price: null,
            market_source: 'stockx',
          };
        }
      }
    } catch (e) { console.warn('[Yamo] StockX Algolia', host, 'failed:', e.message); }
  }

  return null;
}

const SHOE_BUNDLE_RE = /\b(lot|bundle|pack|paires?|x[2-9]|\d+x|pour pi[eè]ces?|d[eé]faut)\b/i;
function isShoeBundleTitle(title) { return SHOE_BUNDLE_RE.test(title); }

// ─── Prix sneaker via eBay (sold avg + lowest active ask) ────────────────────
async function fetchSneakerPrices(item) {
  const ebayAppId = process.env.EBAY_APP_ID;
  const certId    = process.env.EBAY_CERT_ID;
  const query = item.ebay_search || `${item.brand || ''} ${item.model || ''} ${item.colorway || ''}`.trim();
  console.log('[Yamo] Sneaker eBay query:', query);

  let soldData = null;

  // 1. Finding API — sold prices (rate-limited)
  if (ebayAppId) {
    const now = Date.now();
    if (now - lastFindingCallTime >= FINDING_MIN_INTERVAL) {
      try {
        lastFindingCallTime = now;
        const qs = [
          'OPERATION-NAME=findCompletedItems',
          'SERVICE-VERSION=1.0.0',
          `SECURITY-APPNAME=${encodeURIComponent(ebayAppId)}`,
          'RESPONSE-DATA-FORMAT=JSON',
          `keywords=${encodeURIComponent(query)}`,
          'paginationInput.entriesPerPage=25',
        ].join('&');
        const res = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${qs}`);
        if (res.ok) {
          const data = await res.json();
          const root  = data?.findCompletedItemsResponse?.[0];
          const items = root?.searchResult?.[0]?.item ?? [];
          const rawPrices = items
            .filter(i => i?.sellingStatus?.[0]?.sellingState?.[0] === 'EndedWithSales')
            .filter(i => !isShoeBundleTitle(i?.title?.[0] ?? ''))
            .map(i => parseFloat(i?.sellingStatus?.[0]?.convertedCurrentPrice?.[0]?.__value__))
            .filter(v => !isNaN(v) && v > 0);
          if (rawPrices.length > 0) {
            const prices = removeOutliers(rawPrices).sort((a, b) => a - b);
            const median = prices[Math.floor(prices.length / 2)];
            const min = prices[0];
            const max = prices[prices.length - 1];
            soldData = {
              market_price_usd:  Math.round(median * 100) / 100,
              price_low_usd:     Math.round(prices[Math.floor(prices.length * 0.10)] * 100) / 100,
              price_high_usd:    Math.round(prices[Math.floor(prices.length * 0.90)] * 100) / 100,
              ebay_market_price: Math.round(median * 100) / 100,
              ebay_sales_count:  prices.length,
              ebay_url:          `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1`,
              bimodal_warning:   (max - median) > 2 * (median - min),
            };
          }
        }
      } catch (e) {
        console.warn('[Yamo] Sneaker Finding failed:', e.message);
      }
    }
  }

  // 2. Browse API — fallback when Finding didn't run (sold listings only)
  if (!soldData && ebayAppId && certId) {
    try {
      const token = await getEbayOAuthToken();
      const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=50&filter=soldItems:true&sort=endDateDesc`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      });
      if (res.ok) {
        const data = await res.json();
        const rawPrices = (data.itemSummaries ?? [])
          .filter(i => !isShoeBundleTitle(i.title ?? ''))
          .map(i => parseFloat(i.price?.value))
          .filter(v => !isNaN(v) && v > 0);
        if (rawPrices.length > 0) {
          const prices = removeOutliers(rawPrices).sort((a, b) => a - b);
          const median = prices[Math.floor(prices.length / 2)];
          const min = prices[0];
          const max = prices[prices.length - 1];
          soldData = {
            market_price_usd:  Math.round(median * 100) / 100,
            price_low_usd:     Math.round(prices[Math.floor(prices.length * 0.10)] * 100) / 100,
            price_high_usd:    Math.round(prices[Math.floor(prices.length * 0.90)] * 100) / 100,
            ebay_market_price: Math.round(median * 100) / 100,
            ebay_sales_count:  prices.length,
            ebay_url:          `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1`,
            bimodal_warning:   (max - median) > 2 * (median - min),
          };
        }
      }
    } catch (e) {
      console.warn('[Yamo] Sneaker Browse failed:', e.message);
    }
  }

  if (!soldData) return { market_price_usd: null, price_low_usd: null, price_high_usd: null, ebay_market_price: null, ebay_sales_count: 0, ebay_url: null, bimodal_warning: false };
  return soldData;
}

async function handleCard(item, sellerPrice, language = 'WORLD') {
  const cacheKey = `card|${item.card_name}|${item.card_number ?? ''}|${item.condition ?? ''}|${language}`;
  const cached = cacheGet(cacheKey);
  let priceData;
  if (cached) {
    priceData = cached;
  } else {
    try {
      priceData = await fetchPrices(item, language);
    } catch (err) {
      console.error('[Yamo] Card price error:', err.message);
      priceData = { market_price_usd: null, price_low_usd: null, price_high_usd: null, price_source: 'none', ebay_market_price: null, ebay_sales_count: 0, ebay_url: null, tcg_market_price: null, tcg_url: null, listings: [] };
    }
    cacheSet(cacheKey, priceData);
  }
  return { ...item, ...priceData, seller_asking_price: sellerPrice ?? item.seller_asking_price ?? null };
}

async function handleSneaker(item, sellerPrice) {
  const cacheKey = `sneaker|${item.brand}|${item.model}|${item.colorway}|${item.size_eu ?? ''}`;
  const cached = cacheGet(cacheKey);
  let priceData;
  if (cached) {
    priceData = cached;
  } else {
    const [ebaySettled, kicksSettled] = await Promise.allSettled([
      fetchSneakerPrices(item),
      fetchKicksDBServerPrice(item),
    ]);
    const ebay  = ebaySettled.status  === 'fulfilled' ? ebaySettled.value  : null;
    const kicks = kicksSettled.status === 'fulfilled' ? kicksSettled.value : null;
    priceData = {
      ...(ebay  ?? { market_price_usd: null, price_low_usd: null, price_high_usd: null, ebay_market_price: null, ebay_sales_count: 0, ebay_url: null }),
      ...(kicks ?? { stockx_lowest_ask: null, goat_price: null, market_source: null }),
    };
    cacheSet(cacheKey, priceData);
  }
  const stockxUrl = item.stockx_slug
    ? `https://stockx.com/${item.stockx_slug}`
    : `https://stockx.com/search?s=${encodeURIComponent(`${item.brand || ''} ${item.model || ''} ${item.colorway || ''}`.trim())}`;
  return { ...item, ...priceData, stockx_url: stockxUrl, seller_asking_price: sellerPrice ?? item.seller_asking_price ?? null };
}

// ─── Vision prompt constants (used ONLY when no DOM title exists) ─────────────
const VISION_PROMPT_CARDS = `You are an expert in collectible trading cards.
Look at this image from a live auction stream.
Return ONLY a search string optimized for eBay, nothing else.
Include: card name (as printed) + card number + set name + edition + language if not English + grade if visible.

CRITICAL — card number:
- It is printed in small text at the BOTTOM-LEFT corner of the card (format: NNN/NNN e.g. 215/182)
- Read it pixel by pixel from the image — do NOT guess or infer from the set name
- If you cannot read it clearly, omit it entirely — a missing number is better than a wrong one

Examples:
"Charizard 4/102 Base Set 1st Edition Holo PSA 9"
"Spiritomb 244/217 Scarlet Violet Twilight Masquerade Alt Art"
"Lugia 9/111 Neo Genesis 1st Edition Holo"
If unclear reply exactly: UNCLEAR`;

const VISION_PROMPT_SHOES = `You are an expert in sneaker resale markets.
Look at this image from a live auction stream.
Reply ONLY with JSON (no markdown):
{"item_type":"sneaker","brand":"Nike","model":"Air Jordan 1 Retro High OG","colorway":"Bred Toe","sku":"555088-610","stockx_slug":"air-jordan-1-retro-high-og-bred-toe-2019","ebay_search":"Air Jordan 1 Retro High OG Bred Toe","confidence":85,"low_confidence":false}

Rules:
- stockx_slug: exact slug from stockx.com/sneakers/<slug>
- ebay_search: brand + model + colorway only, never include size or year
- low_confidence: set true if colorway is a generic single color only (White, Black, Grey, Blue, Red) AND you are under 80% confident on the exact model
- If no sneaker visible: {"item_type":"unknown"}`;

// ─── Identification Claude (sneaker seul, mode Shoes) ────────────────────────
async function identifySneaker(imageBase64, streamTitle, sellerPrice) {
  const hasTitle = streamTitle && streamTitle.trim().length > 0;

  if (!hasTitle) {
    const data = await claudeFetch({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: VISION_PROMPT_SHOES },
      ]}],
    });
    const raw = (data.content?.[0]?.text ?? '').trim();
    const cleaned = raw.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
    console.log('[Yamo] Shoe vision result:', cleaned.slice(0, 200));
    try {
      const parsed = JSON.parse(cleaned);
      if (!parsed || parsed.item_type === 'unknown' || (!parsed.brand && !parsed.model)) {
        return { item_type: 'unknown' };
      }
      return {
        item_type:           'sneaker',
        brand:               parsed.brand      ?? '',
        model:               parsed.model      ?? '',
        colorway:            parsed.colorway   ?? '',
        sku:                 parsed.sku        ?? '',
        size_us:             null,
        size_eu:             null,
        condition:           'New',
        seller_asking_price: sellerPrice ?? null,
        stockx_slug:         parsed.stockx_slug ?? '',
        ebay_search:         parsed.ebay_search ?? `${parsed.brand ?? ''} ${parsed.model ?? ''} ${parsed.colorway ?? ''}`.trim(),
        confidence:          parsed.confidence ?? 80,
      };
    } catch {
      // Fallback: treat raw text as plain eBay search string
      if (!cleaned || cleaned.toUpperCase() === 'UNCLEAR' || cleaned.length < 5) {
        return { item_type: 'unknown' };
      }
      const brandMatch = cleaned.match(/^(Nike|Adidas|Jordan|New Balance|Asics|Puma|Reebok|Converse|Vans|Saucony|On Running|Salomon)\b/i);
      return {
        item_type: 'sneaker', brand: brandMatch?.[1] ?? '', model: cleaned, colorway: '',
        size_us: null, size_eu: null, condition: 'New', seller_asking_price: sellerPrice ?? null,
        stockx_slug: '', ebay_search: cleaned, confidence: 75,
      };
    }
  }

  const prompt = `You are a sneaker expert analyzing an image.
STREAM TITLE (PRIMARY SOURCE — trust this above everything else): "${streamTitle}"
DISPLAYED PRICE: ${sellerPrice != null ? sellerPrice : 'not detected'}

RULES:
- Extract brand, model and colorway FROM THE TITLE first. Use image to confirm.
- Codes like VSK12345 or #038 in the title are auction refs — ignore for identification.
- "Taille XX" in the title = EU size.
- Do NOT confuse Jordan 1 Mid with Jordan 1 High/Retro High OG — different shoes.

Reply ONLY with JSON (no markdown):
{"item_type":"sneaker","brand":"Nike","model":"Air Jordan 1 Mid","colorway":"Grey Fog","sku":"554724-059","size_eu":"45","size_us":"11","condition":"New","seller_asking_price":null,"stockx_slug":"air-jordan-1-mid-grey-fog","ebay_search":"Air Jordan 1 Mid Grey Fog","confidence":90,"low_confidence":false}

If no sneaker identifiable: {"item_type":"unknown"}
stockx_slug = exact slug from stockx.com. confidence is 0-100.
ebay_search = brand + model + colorway ONLY — never include size.
low_confidence: set true if colorway is a generic single color only (White, Black, Grey, Blue, Red) AND confidence < 80.`;

  const data = await claudeFetch({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt },
    ]}],
  });
  const raw = data.content?.[0]?.text ?? '';
  const cleaned = raw.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    console.error('[Yamo] Sneaker JSON parse error:', cleaned.slice(0, 200));
    return { item_type: 'unknown' };
  }
}

// ─── Identification Claude (carte seule, pour lookup manuel) ──────────────────
async function identifyCard(imageBase64, streamTitle, sellerPrice) {
  const hasTitle = streamTitle && streamTitle.trim().length > 0;

  if (!hasTitle) {
    const data = await claudeFetch({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: VISION_PROMPT_CARDS },
      ]}],
    });
    const result = (data.content?.[0]?.text ?? '').trim().replace(/^["']|["']$/g, '');
    console.log('[Yamo] Card plain-string result:', result);
    if (!result || result.toUpperCase() === 'UNCLEAR' || result.length < 5) {
      return { card_name: 'UNCLEAR' };
    }
    const cardNumMatch = result.match(/\b(\d+\/\d+)\b/);
    // Extract name = everything before the card number, or full result if no number
    const cardName = cardNumMatch
      ? result.slice(0, result.indexOf(cardNumMatch[1])).replace(/[#\s]+$/, '').trim()
      : result.replace(/\b\d+\/\d+\b.*/, '').trim();
    return {
      card_name: cardName || result,
      card_number: cardNumMatch?.[1] ?? '',
      set_name: '',
      condition: 'Near Mint',
      condition_score: 85,
      confidence: 80,
      seller_asking_price: sellerPrice ?? null,
      ebay_search: result,
    };
  }

  const priceText = sellerPrice != null ? `$${sellerPrice}` : 'not detected';
  const prompt = `You are a Pokemon card expert. Analyze this image from a live auction stream.
STREAM TITLE: ${streamTitle}
DISPLAYED PRICE: ${priceText}
Identify the Pokemon card. If the image is blurry or no card is visible, return card_name: 'Non identifiable'.
IMPORTANT:
- card_name: EXACTLY as printed on the card — do NOT translate
- card_number: READ from bottom-left corner of the card (format NNN/NNN). If not clearly legible, return ""  — do NOT guess
- set_name: in English
Reply ONLY with JSON, no markdown:
{ "card_name": "name exactly as on card e.g. Vibraninf", "card_number": "215/182", "set_name": "English set name e.g. Scarlet & Violet 151", "condition": "Near Mint|Lightly Played|Moderately Played|Heavily Played|Damaged", "condition_score": 0, "seller_asking_price": null, "ebay_search": "optimized eBay search e.g. Vibraninf 215/182 SV", "confidence": 95 }
Note: confidence is an integer 0-100. card_number must be read from the image, never inferred.`;

  const data = await claudeFetch({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt },
    ]}],
  });
  const raw = data.content?.[0]?.text ?? '';
  const cleaned = raw.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    console.error('[Yamo] JSON parse error, raw:', cleaned.slice(0, 200));
    const nameMatch = cleaned.match(/"card_name"\s*:\s*"([^"]+)"/);
    if (nameMatch && nameMatch[1] !== 'Non identifiable') {
      return { card_name: nameMatch[1], card_number: cleaned.match(/"card_number"\s*:\s*"([^"]+)"/)?.[1] ?? '', set_name: cleaned.match(/"set_name"\s*:\s*"([^"]+)"/)?.[1] ?? '', condition: 'Near Mint', condition_score: 70, confidence: 40, seller_asking_price: null, ebay_search: nameMatch[1] };
    }
    return { card_name: 'Non identifiable' };
  }
}

// ─── Identification Claude (unifié carte + sneaker) ───────────────────────────
async function identifyItem(imageBase64, streamTitle, sellerPrice) {
  const priceText = sellerPrice != null ? `${sellerPrice}` : 'not detected';
  const hasTitleAuto = streamTitle && streamTitle.trim().length > 0;
  const prompt = `You are an expert at identifying items sold on live auction streams (Whatnot, Voggt, etc.).
${hasTitleAuto ? `STREAM TITLE (PRIMARY SOURCE — trust this above all else): "${streamTitle}"` : 'NO STREAM TITLE — rely entirely on the image.'}
DISPLAYED PRICE: ${priceText}

RULES:
${hasTitleAuto ? `- Extract brand/model/colorway FROM THE TITLE first. Use image to confirm only.
- Codes like VSK12345, #038 in titles are auction refs — ignore for identification.
- "Taille XX" in title = EU size.` : `- Identify from image only.`}
- Do NOT confuse Jordan 1 Mid with Jordan 1 High/Retro High OG — different shoes.

If SNEAKER, reply ONLY with JSON (no markdown):
{"item_type":"sneaker","brand":"Nike","model":"Air Jordan 1 Mid","colorway":"Grey Fog","sku":"554724-059","size_eu":"45","size_us":"11","condition":"New","seller_asking_price":null,"stockx_slug":"air-jordan-1-mid-grey-fog","ebay_search":"Air Jordan 1 Mid Grey Fog","confidence":90}
ebay_search = brand + model + colorway ONLY — never include size.

If POKEMON CARD, reply ONLY with JSON (no markdown):
{"item_type":"card","card_name":"Squirtle","card_number":"170/165","set_name":"Scarlet & Violet 151","condition":"Near Mint","condition_score":85,"seller_asking_price":null,"ebay_search":"Squirtle 170/165 151 NM","confidence":95}

If unidentifiable: {"item_type":"unknown"}
card_name EXACTLY as printed on the card — do NOT translate. set_name in English. stockx_slug = exact slug from stockx.com. confidence is 0-100.
card_number: READ from bottom-left corner of the card — do NOT guess. If not clearly legible, return "".`;

  const data = await claudeFetch({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt },
    ]}],
  });
  const raw = data.content?.[0]?.text ?? '';
  const cleaned = raw.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    console.error('[Yamo] JSON parse error, raw:', cleaned.slice(0, 200));
    const itemType = cleaned.match(/"item_type"\s*:\s*"([^"]+)"/)?.[1] ?? 'unknown';
    if (itemType === 'sneaker') {
      const brand = cleaned.match(/"brand"\s*:\s*"([^"]+)"/)?.[1] ?? '';
      const model = cleaned.match(/"model"\s*:\s*"([^"]+)"/)?.[1] ?? '';
      return { item_type: 'sneaker', brand, model, colorway: '', confidence: 40, ebay_search: `${brand} ${model}`.trim() };
    }
    const nameMatch = cleaned.match(/"card_name"\s*:\s*"([^"]+)"/);
    if (nameMatch && nameMatch[1] !== 'Non identifiable') {
      return { item_type: 'card', card_name: nameMatch[1], card_number: '', set_name: '', condition: 'Near Mint', condition_score: 70, confidence: 40, seller_asking_price: null, ebay_search: nameMatch[1] };
    }
    return { item_type: 'unknown' };
  }
}

async function handleAnalyze({ imageBase64, streamTitle, sellerPrice, mode, manualCardOverride, language = 'WORLD' }) {
  const rawTitle = streamTitle?.trim() ?? '';
  const hasTitle = rawTitle.length > 3 && !isFakeTitle(rawTitle);

  let item;

  if (hasTitle && mode === 'cards') {
    const ebayQuery = buildEbayQuery(rawTitle);
    const numMatch    = ebayQuery.match(/\b(\d+\/\d+)\b/);
    // Detect non-standard card numbers: TG01-TG30 (Trainer Gallery), PROMO, S-prefix, etc.
    const altNumMatch = !numMatch && ebayQuery.match(/\b(tg\d{1,3}|s\d{1,3}|promo\d*)\b/i);
    // Detect Whatnot-style "Name SETCODE NUMBER" format (after paren stripping): "Charizard CLL 003"
    const whatnotParsed = (!numMatch && !altNumMatch) ? parseWhatnotTitle(ebayQuery) : null;

    let cardName, cardNumber, setName = '';
    if (numMatch) {
      cardNumber = numMatch[1];
      cardName   = ebayQuery.replace(numMatch[0], '').replace(/[#\s]+$/, '').trim() || ebayQuery;
    } else if (altNumMatch) {
      cardNumber = altNumMatch[1].toUpperCase();
      cardName   = ebayQuery.replace(new RegExp(`\\b${altNumMatch[1]}\\b`, 'i'), '').replace(/[#\s]+$/, '').trim() || ebayQuery;
    } else if (whatnotParsed) {
      cardName   = whatnotParsed.cardName;
      cardNumber = whatnotParsed.cardNum;
      setName    = whatnotParsed.setCode;
    } else {
      cardName   = ebayQuery;
      cardNumber = '';
    }

    item = { item_type: 'card', card_name: cardName, card_number: cardNumber, set_name: setName, condition: 'Near Mint', condition_score: 85, confidence: 100, seller_asking_price: sellerPrice ?? null, ebay_search: ebayQuery, title_source: 'dom' };
  } else {
    try {
      if (mode === 'shoes') {
        // Always use vision for shoes — title alone has no colorway info
        // Only pass title if it actually looks like a shoe name (not auction placeholders like "PDD 1 PAS D'ANNULATION")
        const shoeTitle = hasTitle && isShoeTitle(rawTitle) ? stripShoeSizeFromTitle(rawTitle) : null;
        item = await identifySneaker(imageBase64, shoeTitle, sellerPrice);
        if (item) item.title_source = 'vision';
      } else if (mode === 'cards') {
        const card = await identifyCard(imageBase64, null, sellerPrice);
        item = card ? { item_type: 'card', ...card, title_source: 'vision' } : { item_type: 'unknown' };
      } else {
        item = await identifyItem(imageBase64, streamTitle, sellerPrice);
        if (item) item.title_source = streamTitle ? 'dom' : 'vision';
      }
    } catch (err) {
      console.error('[Yamo] Claude error:', err);
      return { item_type: 'unknown', error: err.message };
    }
  }

  if (!item || item.item_type === 'unknown') return { item_type: 'unknown' };
  if (item.item_type === 'sneaker') {
    if ((item.confidence ?? 100) < 75 || item.low_confidence === true) {
      console.log(`[Yamo] Sneaker confidence too low (${item.confidence}) — skipping price fetch`);
      return {
        item_type:           'uncertain_sneaker',
        brand:               item.brand    ?? '',
        model:               item.model    ?? '',
        colorway:            item.colorway ?? '',
        confidence:          item.confidence ?? 0,
        ebay_search:         item.ebay_search ?? `${item.brand ?? ''} ${item.model ?? ''}`.trim(),
        seller_asking_price: sellerPrice ?? null,
      };
    }
    return handleSneaker(item, sellerPrice);
  }
  if (item.card_name === 'UNCLEAR') return { card_name: 'UNCLEAR' };
  if (!item.card_name || item.card_name === 'Non identifiable') return { card_name: 'Non identifiable' };

  // Safeguard: ensure ebay_search always includes card_name
  // Claude sometimes drops the Pokemon name from the search query
  if (item.ebay_search && item.card_name) {
    const nameWords = item.card_name.replace(/[/\\]/g, ' ').trim().split(/\s+/);
    const searchLower = item.ebay_search.toLowerCase();
    const firstWord = nameWords[0]?.toLowerCase();
    if (firstWord && firstWord.length >= 3 && !searchLower.includes(firstWord)) {
      item.ebay_search = `${item.card_name} ${item.ebay_search}`.trim();
      console.log('[Lakkot] Fixed ebay_search — card name was missing:', item.ebay_search);
    }
  }

  if (manualCardOverride && manualCardOverride.trim()) {
    const overrideStr = manualCardOverride.trim();
    const numMatch = overrideStr.match(/^(\d+(?:\/\d+)?)/);
    if (numMatch) {
      item.card_number = numMatch[1];
      const afterNum = overrideStr.slice(numMatch[0].length).trim();
      if (afterNum) item.set_name = afterNum;
    } else {
      item.set_name = overrideStr;
    }
  }

  return handleCard(item, sellerPrice, language);
}

async function handleManualLookup(cardName, language = 'WORLD') {
  const numMatch = cardName.match(/\b(\d{1,3}\/\d{1,3})\b/);
  const cardNumber = numMatch?.[1] ?? '';
  const parsedName = cardNumber
    ? cardName.replace(numMatch[0], '').replace(/\s*[-–]\s*$/, '').replace(/^\s*[-–]\s*/, '').trim()
    : cardName.trim();
  const cacheKey = `manual|${cardName}|${language}`;
  const cached = cacheGet(cacheKey);
  const card = { card_name: parsedName, card_number: cardNumber, set_name: '', condition: 'Near Mint', condition_score: 80, confidence: 100, seller_asking_price: null, ebay_search: cardName };
  let priceData = cached;
  if (!priceData) {
    try { priceData = await fetchPrices(card, language); }
    catch (err) { priceData = { market_price_usd: null, price_low_usd: null, price_high_usd: null, price_source: 'none', ebay_market_price: null, ebay_sales_count: 0, ebay_url: null, tcg_market_price: null, tcg_url: null, listings: [] }; }
    cacheSet(cacheKey, priceData);
  }
  return { ...card, ...priceData };
}

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

app.post('/auth/signup', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  try {
    // Check if user already exists — re-send their token if so (idempotent)
    const { data: existing } = await supabase
      .from('users')
      .select('token')
      .eq('email', email)
      .single();

    let token = existing?.token ?? null;

    if (!existing) {
      // Create new user
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert({ email })
        .select('token')
        .single();
      if (insertError) throw insertError;
      token = newUser.token;
    }

    // Send token email via Resend
    const { error: sendError } = await resend.emails.send({
      from: 'Yamo <onboarding@resend.dev>',
      to: email,
      subject: 'Your Yamo access token',
      html: `
        <p>Welcome to Yamo!</p>
        <p>Your access token is:</p>
        <p style="font-size:18px;font-weight:bold;letter-spacing:2px;">${token}</p>
        <p>Paste this token into the Yamo extension popup to activate it.</p>
        <p>Free plan: 10 scans/day. Upgrade to Pro at <a href="https://yamo.app">yamo.app</a>.</p>
      `,
    });
    if (sendError) console.warn('[Yamo] /auth/signup email not sent (Resend sandbox limit):', sendError.message ?? JSON.stringify(sendError));

    return res.json({ success: true });
  } catch (err) {
    console.error('[Yamo] /auth/signup error:', err.message);
    return res.status(500).json({ error: 'signup_failed' });
  }
});

app.get('/me', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'missing_token' });

  const { data: user } = await supabase
    .from('users')
    .select('email, plan, scan_count, scan_reset_at, scan_limit_override')
    .eq('token', token)
    .single();

  if (!user) return res.status(401).json({ error: 'invalid_token' });

  // Reset count if it's a new day
  const today = new Date().toISOString().slice(0, 10);
  let scanCount = user.scan_count;
  if (user.scan_reset_at < today) scanCount = 0;

  const limit = user.scan_limit_override ?? (user.plan === 'pro' ? 100 : 10);
  const remaining = Math.max(0, limit - scanCount);

  return res.json({ email: user.email, plan: user.plan, scan_count: scanCount, limit, remaining });
});

async function handleMatchListings({ imageBase64, listings }) {
  if (!imageBase64 || !Array.isArray(listings) || listings.length === 0) {
    return { matchIndices: [] };
  }

  // Fetch up to 10 listing thumbnails server-side
  const validThumbnails = [];
  for (let i = 0; i < Math.min(listings.length, 10); i++) {
    const imageUrl = listings[i]?.imageUrl;
    if (!imageUrl) continue;
    try {
      const r = await fetch(imageUrl, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Yamo/1.0)' },
      });
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let j = 0; j < bytes.byteLength; j += 8192) {
        binary += String.fromCharCode(...bytes.subarray(j, Math.min(j + 8192, bytes.byteLength)));
      }
      validThumbnails.push({ originalIndex: i, base64: btoa(binary) });
    } catch { /* skip failed thumbnails */ }
  }

  if (validThumbnails.length === 0) return { matchIndices: [] };

  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
    ...validThumbnails.map(t => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: t.base64 },
    })),
    {
      type: 'text',
      text: `The first image is a Pokemon card from a live auction.\nThe other images are eBay sold listing thumbnails.\nWhich eBay images show the exact same card (same Pokemon, same artwork, same card type)?\nReturn a JSON array of matching indices only (0-indexed, relative to the eBay images, not counting the first card image).\nExample: [0, 2, 4]\nReturn [] if none match. Return ONLY the JSON array, nothing else.`,
    },
  ];

  const data = await claudeFetch({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [{ role: 'user', content }],
  });

  const raw = (data.content?.[0]?.text ?? '[]').trim();
  let parsed = [];
  try {
    const match = raw.match(/\[[\d,\s]*\]/);
    parsed = match ? JSON.parse(match[0]) : [];
    if (!Array.isArray(parsed)) parsed = [];
  } catch { parsed = []; }

  const matchIndices = parsed
    .filter(j => Number.isInteger(j) && j >= 0 && j < validThumbnails.length)
    .map(j => validThumbnails[j].originalIndex);

  console.log(`[Yamo] match_listings: ${validThumbnails.length} thumbnails → ${matchIndices.length} matches:`, matchIndices);
  return { matchIndices };
}

// Labels to skip — these are people/scene elements, not products
const SKIP_LABELS = ['person', 'man', 'woman', 'girl', 'boy', 'human face', 'human body',
  'face', 'head', 'arm', 'hand', 'finger', 'room', 'building', 'floor', 'wall', 'ceiling',
  'shelf', 'furniture', 'sky', 'tree', 'plant', 'land vehicle', 'car', 'wheel'];

async function cropToObject(imageBase64, normalizedVertices) {
  try {
    const buf = Buffer.from(imageBase64, 'base64');
    const meta = await sharp(buf).metadata();
    const { width, height } = meta;
    const xs = normalizedVertices.map(v => (v.x ?? 0) * width);
    const ys = normalizedVertices.map(v => (v.y ?? 0) * height);
    // Add 5% padding around the object
    const padX = (Math.max(...xs) - Math.min(...xs)) * 0.05;
    const padY = (Math.max(...ys) - Math.min(...ys)) * 0.05;
    const left   = Math.max(0, Math.floor(Math.min(...xs) - padX));
    const top    = Math.max(0, Math.floor(Math.min(...ys) - padY));
    const right  = Math.min(width,  Math.ceil(Math.max(...xs) + padX));
    const bottom = Math.min(height, Math.ceil(Math.max(...ys) + padY));
    if (right - left < 20 || bottom - top < 20) return null;
    const cropped = await sharp(buf)
      .extract({ left, top, width: right - left, height: bottom - top })
      .jpeg({ quality: 90 })
      .toBuffer();
    return cropped.toString('base64');
  } catch (err) {
    console.error('[Yamo] cropToObject error:', err.message);
    return null;
  }
}

// ─── Google Shopping pricing engine (used after Lens identifies the product) ──
function detectCurrency(priceStr) {
  if (!priceStr) return '$';
  if (priceStr.includes('₪')) return '₪';
  if (priceStr.includes('£')) return '£';
  if (priceStr.includes('€')) return '€';
  return '$';
}

async function handleGoogleShopping(productName) {
  const params = new URLSearchParams({
    engine: 'google_shopping',
    q: productName,
    api_key: process.env.SERPAPI_KEY,
    num: '40',
  });

  const res = await fetch('https://serpapi.com/search.json?' + params);
  const data = await res.json();

  const raw = data.shopping_results ?? [];
  console.log(`[Lakkot] google_shopping: ${raw.length} results for "${productName}"`);

  const cards = raw
    .filter(item => item.extracted_price && item.extracted_price > 0 && item.thumbnail && item.product_link)
    .map(item => ({
      title: item.title,
      retailer: item.source,
      sourceIcon: item.source_icon ?? null,
      url: item.product_link,
      imageUrl: item.thumbnail,
      price: item.extracted_price,
      currency: detectCurrency(item.price ?? ''),
      hasPrice: true,
      isSecondHand: item.second_hand_condition === 'pre-owned',
      tag: item.tag ?? null,
    }));

  if (cards.length < 2) {
    return { cards, medianPrice: cards[0]?.price ?? null, totalFound: cards.length };
  }

  // Remove price outliers: keep Q1*0.5 to Q3*2
  const prices = cards.map(c => c.price).sort((a, b) => a - b);
  const q1 = prices[Math.floor(prices.length * 0.25)];
  const q3 = prices[Math.floor(prices.length * 0.75)];
  const filtered = cards.filter(c => c.price >= q1 * 0.5 && c.price <= q3 * 2);

  // Sort by price ascending
  filtered.sort((a, b) => a.price - b.price);

  // Median from filtered prices
  const filteredPrices = filtered.map(c => c.price);
  const median = filteredPrices.length > 0
    ? filteredPrices[Math.floor(filteredPrices.length / 2)]
    : null;

  return {
    cards: filtered.slice(0, 8),
    medianPrice: median,
    totalFound: filtered.length,
  };
}

async function handleGoogleLens(imageBase64) {
  // STEP A: Upload image to imgbb to get a public URL
  const formData = new URLSearchParams({
    key: process.env.IMGBB_KEY,
    image: imageBase64,
    expiration: '600',
  });

  const imgbbRes = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: formData });
  const imgbbData = await imgbbRes.json();

  if (!imgbbData.success) {
    throw new Error('imgbb upload failed: ' + JSON.stringify(imgbbData));
  }

  const imageUrl = imgbbData.data.url;
  console.log('[Yamo] google_lens: imgbb upload OK —', imageUrl);

  // STEP B: Call SerpApi Google Lens
  const params = new URLSearchParams({
    engine: 'google_lens',
    url: imageUrl,
    api_key: process.env.SERPAPI_KEY,
    hl: 'fr',
    country: 'fr',
  });

  const serpRes = await fetch('https://serpapi.com/search.json?' + params);
  const serpData = await serpRes.json();

  // STEP C: Extract visual_matches
  const visualMatches = serpData.visual_matches ?? [];
  console.log(`[Yamo] google_lens: ${visualMatches.length} visual matches`);
  console.log('SerpApi visual_matches sample:', JSON.stringify(visualMatches?.slice(0, 3), null, 2));

  // Price extraction helpers
  function extractPriceFromString(str) {
    if (!str) return null;
    const m = str.match(/[€$£₪¥]\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?[€$£₪¥]/);
    if (!m) return null;
    return {
      price: parseFloat((m[1] ?? m[2]).replace(',', '.')),
      currency: str.includes('₪') ? '₪' : str.includes('$') ? '$' : str.includes('£') ? '£' : '€',
    };
  }

  function extractCardPrice(match) {
    if (match.price?.extracted_value != null)
      return { price: match.price.extracted_value, currency: match.price.currency ?? '€' };
    const fromTitle = extractPriceFromString(match.title ?? '');
    if (fromTitle) return fromTitle;
    const fromSnippet = extractPriceFromString(match.snippet ?? '');
    if (fromSnippet) return fromSnippet;
    return { price: null, currency: null };
  }

  // STEP D: Build cards
  const OFFICIAL_DOMAINS = [
    'nike.com', 'adidas.com', 'newbalance.com', 'jordan.com', 'puma.com',
    'reebok.com', 'fearofgod.com', 'vans.com', 'converse.com',
    'timberland.com', 'ugg.com', 'birkenstock.com',
    'essentials.com', 'supremenewyork.com',
  ];

  const cards = visualMatches
    .filter(m => m.thumbnail && m.link)
    .slice(0, 8)
    .map(m => {
      const domain = (() => {
        try { return new URL(m.link).hostname.replace('www.', ''); } catch { return m.source ?? ''; }
      })();
      const { price, currency } = extractCardPrice(m);
      return {
        title: m.title ?? null,
        retailer: m.source ?? domain,
        domain,
        url: m.link,
        imageUrl: m.thumbnail,
        price,
        currency,
        hasPrice: price !== null,
        sourceIcon: m.source_icon ?? null,
        isOfficial: OFFICIAL_DOMAINS.some(d => domain.includes(d)),
      };
    });

  // Merge inline_shopping_results — prices live here, not in visual_matches
  const shoppingResults = serpData.inline_shopping_results ?? [];
  console.log('inline_shopping_results count:', shoppingResults.length);
  console.log('sample shopping result:', JSON.stringify(shoppingResults?.[0], null, 2));

  shoppingResults.forEach(item => {
    if (!item.price || !item.link) return;

    const priceVal = typeof item.price === 'string'
      ? parseFloat(item.price.replace(/[^0-9.,]/g, '').replace(',', '.'))
      : item.price?.extracted_value ?? null;

    if (!priceVal) return;

    const currency = typeof item.price === 'string'
      ? (item.price.includes('₪') ? '₪' : item.price.includes('$') ? '$' : item.price.includes('£') ? '£' : '€')
      : item.price?.currency ?? '€';

    const existing = cards.find(c =>
      c.url === item.link ||
      (c.retailer && item.source &&
        c.retailer.toLowerCase().includes(item.source.toLowerCase()))
    );

    if (existing) {
      existing.price = priceVal;
      existing.currency = currency;
      existing.hasPrice = true;
    } else if (item.thumbnail && item.link) {
      const domain = (() => {
        try { return new URL(item.link).hostname.replace('www.', ''); } catch { return item.source ?? ''; }
      })();
      cards.push({
        title: item.title ?? null,
        retailer: item.source ?? domain,
        domain,
        url: item.link,
        imageUrl: item.thumbnail,
        price: priceVal,
        currency,
        hasPrice: true,
        sourceIcon: null,
        isOfficial: OFFICIAL_DOMAINS.some(d => domain.includes(d)),
      });
    }
  });

  // Sort: results with price first
  cards.sort((a, b) => {
    if (a.hasPrice && !b.hasPrice) return -1;
    if (!a.hasPrice && b.hasPrice) return 1;
    return 0;
  });

  // STEP E: Product name
  const productName =
    serpData.knowledge_graph?.title ??
    serpData.visual_matches?.[0]?.title ??
    null;

  // STEP F: Median price calculation
  const prices = cards
    .filter(c => c.price !== null)
    .map(c => c.price)
    .sort((a, b) => a - b);

  const medianPrice = prices.length > 0 ? prices[Math.floor(prices.length / 2)] : null;

  // Only return cards with a confirmed price
  const pricedCards = cards.filter(c => c.hasPrice);

  return {
    productName,
    cards: pricedCards,
    medianPrice,
    sourcesCount: pricedCards.length,
    pricesCount: prices.length,
  };
}

app.post('/scan', async (req, res) => {
  const { token, type, ...params } = req.body;

  // match_listings: vision matching — does not consume quota
  if (type === 'match_listings') {
    try {
      const result = await handleMatchListings(params);
      return res.json(result);
    } catch (err) {
      console.error('[Yamo] match_listings error:', err.message);
      return res.json({ matchIndices: [] });
    }
  }

  // google_lens: SerpApi Google Lens + Google Shopping — does not consume quota
  if (type === 'google_lens') {
    try {
      const sellerPrice = params.sellerPrice ?? null;
      const streamCurrency = params.streamCurrency ?? 'EUR';
      // Step 1: Google Lens identifies the product visually
      const lensResult = await handleGoogleLens(params.imageBase64);
      const productName = lensResult.productName ?? null;

      // Step 2: Google Shopping searches by product name for confirmed prices
      let shoppingResult = { cards: [], medianPrice: null, totalFound: 0 };
      if (productName) {
        try {
          shoppingResult = await handleGoogleShopping(productName);
          console.log(`[Lakkot] google_shopping: ${shoppingResult.cards.length} priced cards, median=${shoppingResult.medianPrice}`);
        } catch (shErr) {
          console.error('[Lakkot] google_shopping error (falling back to lens):', shErr.message);
        }
      }

      // Prefer shopping cards (all have confirmed prices), fall back to lens
      const usesShopping = shoppingResult.cards.length > 0;
      const finalCards = usesShopping ? shoppingResult.cards : lensResult.cards;
      const medianPrice = shoppingResult.medianPrice ?? lensResult.medianPrice;

      return res.json({
        type: 'WEB_DONE',
        productName,
        cards: finalCards,
        medianPrice,
        sourcesCount: finalCards.length,
        pricesCount: finalCards.filter(c => c.hasPrice).length,
        sellerPrice,
        streamCurrency,
        priceSource: usesShopping ? 'shopping' : 'lens',
        totalFound: usesShopping ? shoppingResult.totalFound : lensResult.sourcesCount,
      });
    } catch (err) {
      console.error('[Lakkot] google_lens error:', err.message);
      return res.json({ type: 'WEB_DONE', productName: null, cards: [], medianPrice: null, sourcesCount: 0, pricesCount: 0, sellerPrice: null, streamCurrency: 'EUR', priceSource: 'lens', _error: err.message });
    }
  }

  // Token validation + quota info (always fetch when token provided)
  let quota = null;
  if (process.env.REQUIRE_AUTH !== 'false') {
    const user = await validateAndCount(token, res);
    if (!user) return;
    const today = new Date().toISOString().slice(0, 10);
    const scanCount = user.scan_reset_at < today ? 0 : user.scan_count;
    const limit = user.scan_limit_override ?? (user.plan === 'pro' ? 100 : 10);
    quota = { email: user.email, remaining: Math.max(0, limit - scanCount), limit };
  } else if (token) {
    const { data: user } = await supabase.from('users').select('email, plan, scan_count, scan_reset_at, scan_limit_override').eq('token', token).single();
    if (user) {
      const today = new Date().toISOString().slice(0, 10);
      const scanCount = user.scan_reset_at < today ? 0 : user.scan_count;
      const limit = user.scan_limit_override ?? (user.plan === 'pro' ? 100 : 10);
      quota = { email: user.email, remaining: Math.max(0, limit - scanCount), limit };
    }
  }

  try {
    let result;
    if (type === 'analyze') {
      result = await handleAnalyze(params);
    } else if (type === 'manual') {
      result = await handleManualLookup(params.cardName, params.language);
    } else {
      return res.status(400).json({ error: 'unknown_type', type });
    }
    return res.json({ ...result, quota });
  } catch (err) {
    console.error('[Yamo] /scan error:', err.message);
    return res.status(500).json({ error: 'scan_failed', message: err.message });
  }
});

app.get('/', (req, res) => {
  const { challenge_code } = req.query;

  if (challenge_code) {
    const hash = crypto
      .createHash('sha256')
      .update(challenge_code + process.env.VERIFICATION_TOKEN + process.env.ENDPOINT_URL)
      .digest('hex');

    return res.status(200).json({ challengeResponse: hash });
  }

  res.status(200).send('OK');
});

app.post('/', (req, res) => {
  res.status(200).send('OK');
});

app.get('/sneakers', async (req, res) => {
  const query = req.query.q;
  const size = req.query.size;
  if (!query) return res.status(400).json({ error: 'Missing query param q' });
  try {
    // Try multiple query variants — kicks.dev indexes "Air Jordan", not "Nike Air Jordan"
    const variants = [
      query,
      query.replace(/^Nike\s+/i, ''),
      query.replace(/^Adidas\s+/i, ''),
      query.replace(/^(Nike|Adidas|Jordan|New Balance|Asics|Puma|Reebok|Converse|Vans)\s+/i, ''),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    let product = null;
    for (const q of variants) {
      const searchRes = await fetch(
        `https://api.kicks.dev/v1/products/search?query=${encodeURIComponent(q)}&limit=1`,
        { headers: { 'x-api-key': process.env.KICKSDB_API_KEY } }
      );
      const searchData = await searchRes.json();
      product = searchData?.data?.[0];
      if (product) break;
    }
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const priceRes = await fetch(
      `https://api.kicks.dev/v1/products/${product.id}/prices${size ? `?size=${size}` : ''}`,
      { headers: { 'x-api-key': process.env.KICKSDB_API_KEY } }
    );
    const priceData = await priceRes.json();

    return res.json({
      name: product.title,
      brand: product.brand,
      thumbnail: product.image,
      sku: product.sku,
      stockxPrice: priceData?.data?.stockx?.price || null,
      goatPrice: priceData?.data?.goat?.price || null,
      requestedSize: size || null,
      source: 'kicksdb'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Market price: StockX Algolia → GOAT Algolia fallback ────────────────────
app.get('/stockx', async (req, res) => {
  const query = req.query.q;
  const slug  = req.query.slug;
  if (!query && !slug) return res.status(400).json({ error: 'Missing q or slug param' });

  const searchQuery = query || slug.replace(/-/g, ' ');

  // Method 1: StockX via Algolia (try DSN then main cluster)
  for (const host of ['xw7sbct9ad-dsn.algolia.net', 'xw7sbct9ad.algolia.net']) {
    try {
      const r = await fetch(`https://${host}/1/indexes/products/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Algolia-Application-Id': 'XW7SBCT9AD',
          'X-Algolia-API-Key': '6b5e76b49705eb9f51a06d3c82f7acee',
        },
        body: JSON.stringify({ params: `query=${encodeURIComponent(searchQuery)}&hitsPerPage=1` }),
        signal: AbortSignal.timeout(5000),
      });
      console.log('[/stockx] StockX Algolia', host, '→', r.status);
      if (r.ok) {
        const d = await r.json();
        const hit = d?.hits?.[0];
        const lowestAsk = hit?.market?.lowestAsk ?? hit?.lowest_ask ?? null;
        const lastSale  = hit?.market?.lastSale  ?? hit?.last_sale  ?? null;
        if (lowestAsk != null || lastSale != null) {
          return res.json({ lowestAsk, lastSale, name: hit.name ?? hit.title ?? null, source: 'stockx' });
        }
      }
    } catch (e) { console.warn('[/stockx] StockX Algolia', host, 'failed:', e.message); }
  }

  // Method 2: GOAT via Algolia (similar market data, different source)
  try {
    const r = await fetch('https://2fwotdvm2o-dsn.algolia.net/1/indexes/product_variants_v2/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Algolia-Application-Id': '2FWOTDVM2O',
        'X-Algolia-API-Key': 'ac96de6a3afb9236e994f9c3c9a5ab9d',
      },
      body: JSON.stringify({ params: `query=${encodeURIComponent(searchQuery)}&hitsPerPage=1` }),
      signal: AbortSignal.timeout(5000),
    });
    console.log('[/stockx] GOAT Algolia →', r.status);
    if (r.ok) {
      const d = await r.json();
      const hit = d?.hits?.[0];
      const lowestAsk = hit?.lowest_listing_price_cents != null ? hit.lowest_listing_price_cents / 100 : null;
      const lastSale  = hit?.last_sold_price_cents      != null ? hit.last_sold_price_cents / 100      : null;
      console.log('[/stockx] GOAT hit:', hit?.name, '| ask:', lowestAsk, '| last:', lastSale);
      if (lowestAsk != null || lastSale != null) {
        return res.json({ lowestAsk, lastSale, name: hit.name ?? null, source: 'goat' });
      }
    }
  } catch (e) { console.warn('[/stockx] GOAT Algolia failed:', e.message); }

  return res.status(404).json({ error: 'Market price not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`eBay endpoint listening on port ${PORT}`));
