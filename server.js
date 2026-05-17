// Load .env in development (Render injects env vars directly in production)
if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch {}
}

const express = require('express');
const crypto  = require('crypto');
const sharp   = require('sharp');
const { POKEMON_NAMES, pokemonToEN, pokemonToFR, isPokemonName } = require('./pokemon-names');
const { POKEMON_SETS, findSetInText } = require('./pokemon-sets');
const Stripe  = require('stripe');
const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);
const { buildIdentity, buildShoppingQuery, filterBySku, medianOf, isMarketplace, extractCommonPhrase } = require('./sneaker-id');
const { buildGeminiRequest, parseGeminiResponse, mapToCardResult,
  buildIdentityRequest, buildEbayPricePrompt, buildTcgplayerPricePrompt, buildPriceChartingPrompt, buildTextOnlyRequest,
  mapIdentityToCardResult, mapEbayPriceToCardResult, mapTcgplayerPriceToCardResult, mapPriceChartingToCardResult,
} = require('./gemini-scan');

const app = express();

// In-memory counter so we can tell if /scan/gemini requests are even arriving.
let geminiHitCount = 0;
let geminiLastHit = null;
let geminiLastError = null;
// Captures the last logScan failure (any route) so we can diagnose silent
// scan_log write failures without Render log access. Surfaced via /version.
let lastLogScanError = null;
// Last Gemini API error so we can tell which call type/status caused api_error.
let lastGeminiApiError = null;

// Module-scope copy of the scan-logging helper so endpoints OUTSIDE the
// `app.post('/scan', ...)` handler can write to scan_logs. The nested copy
// inside /scan stays untouched and shadows this one in its own scope. Body
// is identical so /scan and /scan/gemini behave consistently.
async function logScan({ userEmail, userName, platform, domTitle, imageBase64, croppedImageBase64, route, productName, lensProductName, ebayQuery, resultType, marketPrice, askingPrice, verdict, sourcesCount, ebaySalesCount, lensMatches, lensSelected, ebayResults, langToggle }) {
  try {
    let imageUrl = null;
    if (imageBase64) {
      const buf = Buffer.from(imageBase64, 'base64');
      const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jpg`;
      const { data: uploadData, error: uploadErr } = await supabase.storage
        .from('scan-images').upload(fileName, buf, { contentType: 'image/jpeg', upsert: false });
      if (!uploadErr && uploadData) {
        const { data: urlData } = supabase.storage.from('scan-images').getPublicUrl(fileName);
        imageUrl = urlData?.publicUrl ?? null;
      }
    }
    let croppedImageUrl = null;
    if (croppedImageBase64) {
      const cropBuf = Buffer.from(croppedImageBase64, 'base64');
      const cropFileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-crop.jpg`;
      const { data: cropUpload, error: cropErr } = await supabase.storage
        .from('scan-images').upload(cropFileName, cropBuf, { contentType: 'image/jpeg', upsert: false });
      if (!cropErr && cropUpload) {
        const { data: cropUrlData } = supabase.storage.from('scan-images').getPublicUrl(cropFileName);
        croppedImageUrl = cropUrlData?.publicUrl ?? null;
      }
    }
    const { data: logData, error: insertErr } = await supabase.from('scan_logs').insert({
      user_email: userEmail ?? null,
      user_name: userName ?? null,
      platform: platform ?? null,
      dom_title: domTitle ?? null,
      image_url: imageUrl,
      cropped_image_url: croppedImageUrl,
      route: route ?? null,
      product_name: productName ?? null,
      lens_product_name: lensProductName ?? null,
      ebay_query: ebayQuery ?? null,
      result_type: resultType ?? null,
      market_price: marketPrice ?? null,
      asking_price: askingPrice ?? null,
      verdict: verdict ?? null,
      sources_count: sourcesCount ?? 0,
      ebay_sales_count: ebaySalesCount ?? 0,
      lens_matches: lensMatches ?? null,
      lens_selected: lensSelected ?? null,
      ebay_results: ebayResults ?? null,
      lang_toggle: langToggle ?? null,
    }).select('id').single();
    if (insertErr) {
      console.warn('[Lakkot] (global logScan) insert error:', insertErr.message, '| details:', insertErr.details || '');
      lastLogScanError = (route || '?') + ' @ ' + new Date().toISOString() + ' insert: ' + insertErr.message + (insertErr.details ? ' | ' + insertErr.details : '');
    }
    return logData?.id ?? null;
  } catch (err) {
    console.warn('[Lakkot] (global logScan) threw:', err.message);
    lastLogScanError = (route || '?') + ' @ ' + new Date().toISOString() + ' threw: ' + err.message;
    return null;
  }
}

// ─── Gemini diagnostic endpoints (temp, no auth) ─────────────────────────────
// /diag/gemini-models — lists models the configured key can access.
// /diag/gemini-ping   — sends a 1-line text prompt to confirm key + model work
//                        end to end without involving images or grounded search.
app.get('/diag/gemini-models', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'no_key' });
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await r.json().catch(() => ({ raw: 'not-json' }));
    const flash = (data.models || []).filter((m) => /flash/i.test(m.name || ''));
    return res.json({ status: r.status, total: (data.models || []).length, flashModels: flash.map((m) => ({ name: m.name, methods: m.supportedGenerationMethods })) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// /diag/gemini-scan-url?url=<image_url> — runs the FULL production Gemini
// pipeline (same prompt, same model, same grounded search) on a public image
// and returns Gemini's raw output. Proof that image-in → card+prices-out works.
app.get('/diag/gemini-scan-url', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'no_key' });
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).json({ error: 'missing url query param' });
  const model = req.query.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  try {
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
    if (!imgRes.ok) return res.status(502).json({ error: 'image_fetch_failed', status: imgRes.status });
    const arr = new Uint8Array(await imgRes.arrayBuffer());
    const imageBase64 = Buffer.from(arr).toString('base64');
    const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(buildGeminiRequest(imageBase64, mimeType)),
      signal: AbortSignal.timeout(40_000),
    });
    const text = await r.text();
    let parsedJson = null;
    let geminiText = null;
    try {
      const data = JSON.parse(text);
      geminiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
      parsedJson = geminiText ? parseGeminiResponse(geminiText) : null;
    } catch (_) {}
    return res.json({
      status: r.status,
      model,
      mimeType,
      imageBytes: arr.length,
      geminiText,
      parsed: parsedJson,
      mapped: parsedJson && !parsedJson.error ? mapToCardResult(parsedJson) : null,
      raw: text.slice(0, 1200),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, model });
  }
});

app.get('/diag/gemini-ping', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'no_key' });
  const model = req.query.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const grounded = req.query.grounded === '1';
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK and nothing else.' }] }],
  };
  if (grounded) body.tools = [{ google_search: {} }];
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    return res.json({ status: r.status, model, grounded, body: text.slice(0, 800) });
  } catch (err) {
    return res.status(500).json({ error: err.message, model, grounded });
  }
});

// Version probe — returns true only when sneaker-id is loaded, i.e. this build
// has the SKU-based sneaker pipeline. Used to verify which build Render is running.
app.get('/version', (req, res) => {
  res.json({
    build: 'sneaker-pipeline-v4+gemini-2.5-flash',
    sneakerIdLoaded: typeof buildIdentity === 'function',
    geminiLoaded: typeof buildGeminiRequest === 'function',
    geminiKeyConfigured: !!process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    geminiHitCount,
    geminiLastHit,
    geminiLastError,
    lastLogScanError,
    lastGeminiApiError,
    cleanQueryStripping: true,
    fallbackQuery: true,
    retailerAugment: true,
    minBasket: 1,
    styleCodeThreshold: 5,
  });
});

// CORS — allow the lakkot.com site, Lovable preview domains, and the Chrome extension
const ALLOWED_ORIGINS = [
  'https://lakkot.com',
  'https://www.lakkot.com',
  'https://yamoapp.lovable.app',
  'https://yamo.app',
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    !origin ||
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/[a-z0-9-]+\.lovableproject\.com$/.test(origin) ||
    /^chrome-extension:\/\//.test(origin) ||
    /^moz-extension:\/\//.test(origin)
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// JSON body parser — skip for Stripe webhook (needs raw body for signature validation)
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe/webhook') return next();
  express.json({ limit: '20mb' })(req, res, next);
});

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Plan monthly limits
const PLAN_LIMITS = { free: 20, pro: 200, power: 1500 };

// Get current month as YYYY-MM string
function currentMonth() { return new Date().toISOString().slice(0, 7); }

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

  // Reset monthly count if it's a new month
  const month = currentMonth();
  if (!user.scan_reset_at || user.scan_reset_at.slice(0, 7) !== month) {
    await supabase
      .from('users')
      .update({ scan_count: 0, scan_reset_at: month })
      .eq('id', user.id);
    user.scan_count = 0;
  }

  // Check limit
  const limit = user.scan_limit_override ?? (PLAN_LIMITS[user.plan] ?? PLAN_LIMITS.free);
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
    case 'JP': return baseQuery;
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
  // Minor / European (only unambiguous company names — NOT 'tag', 'mnt', 'pcs', 'acs', 'ags', 'icg')
  'ccc', 'hga', 'pfx', 'fcg', 'sfg',
  // ACE grading (with number to avoid false positives)
  'ace 10', 'ace 9', 'ace 8',
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

// ─── TCG card detection (unified scan router) ────────────────────────────────
const TCG_BRAND_KEYWORDS = [
  'pokemon', 'pokémon', 'pocket monsters', 'pocket monster',
  'pikachu', 'charizard', 'dracaufeu',
  'yugioh', 'yu-gi-oh', 'yu gi oh',
  'one piece card', 'one piece tcg',
  'magic the gathering', 'mtg',
  'digimon card', 'dragon ball super card',
  'psa', 'cgc', 'bgs', 'pca',
  'carddass', 'bandai',
  'topps', 'wizards',
];
const TCG_MECHANIC_KEYWORDS = [
  'holo', 'reverse holo', 'vstar', 'vmax', 'ex', 'gx',
  'full art', 'alt art', 'trainer gallery', 'radiant',
  'illustration rare', 'special art rare', 'art rare',
  'spell card', 'trap card', 'synchro', 'xyz', 'link', 'pendulum',
  'manga rare', 'leader card', 'don card',
  'ultra rare', 'secret rare', 'starlight rare',
  'near mint', 'lightly played', 'moderately played',
  'common', 'uncommon', 'rare holo',
  'mega ', 'méga ', 'promo', 'gold star',
];
// Card number regex + date exclusion
const _CARD_NUM_BASE = /\b[A-Za-z]{0,3}\d{2,4}\s*\/\s*[A-Za-z]{0,3}\d{2,4}\b/g;
const CARD_NUMBER_RE = {
  test(text) {
    _CARD_NUM_BASE.lastIndex = 0;
    let m;
    while ((m = _CARD_NUM_BASE.exec(text)) !== null) {
      // Reject if followed by / (it's a date like 05/12/2014)
      if (text[m.index + m[0].length] === '/') continue;
      return true;
    }
    return false;
  }
};

function isTCGCard(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Card number pattern is a strong signal
  if (CARD_NUMBER_RE.test(text)) return true;
  // Brand keywords
  if (TCG_BRAND_KEYWORDS.some(kw => lower.includes(kw))) return true;
  // Mechanic keywords (require at least 2 to avoid false positives on generic terms)
  const mechanicHits = TCG_MECHANIC_KEYWORDS.filter(kw => lower.includes(kw));
  if (mechanicHits.length >= 2) return true;
  return false;
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

  const cardNumber = query.match(/\b([A-Za-z]{0,3}\d{1,4}\s*\/\s*[A-Za-z]{0,3}\d{1,4})\b/);

  if (cardNumber) {
    // Normalize: strip leading zeros and spaces for comparison
    const normalize = (num) => num.replace(/\s/g, '').replace(/^0+(\d)/, '$1').replace(/\/0+(\d)/, '/$1').toLowerCase();
    const targetNum = normalize(cardNumber[1]);
    const before = items.length;
    const filtered = items.filter(item => {
      const title = getTitleFn(item);
      // Match both pure numeric and alphanumeric card numbers in listing titles
      const nums = title.match(/\b([A-Za-z]{0,3}\d{1,4}\s*\/\s*[A-Za-z]{0,3}\d{1,4})\b/g);
      if (!nums) return language === 'JP';
      return nums.some(n => normalize(n) === targetNum);
    });
    console.log(`[Lakkot] Card identity filter: by number ${targetNum} | ${before} → ${filtered.length}`);
    // If filter removed everything, return unfiltered (better to show something)
    if (filtered.length === 0 && before > 0) {
      console.log('[Lakkot] Card identity filter: all items filtered out, returning unfiltered');
      return items;
    }
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

// ─── Pokemon vote system — extract name + number from visual matches ─────────

// Build promo code regex from pokemon-sets.js — all sets with "Promo" in name
const _promoPrefixes = (() => {
  const prefixes = new Set();
  for (const [code, name] of POKEMON_SETS) {
    if (/promo/i.test(name)) {
      const upper = code.toUpperCase();
      // Add full code (e.g., SVP, SWSHP, SMP)
      if (upper.length >= 2) prefixes.add(upper);
      // Also add without trailing P if result is >= 2 chars (SWSH, SM, XY, BW, DP, HS)
      const noP = upper.replace(/P$/, '');
      if (noP.length >= 2) prefixes.add(noP);
    }
  }
  // Add common variants with FR/EN suffix (SVPFR, SVPEN, SVFR, SVEN, etc.)
  for (const p of [...prefixes]) {
    prefixes.add(p + 'FR');
    prefixes.add(p + 'EN');
  }
  return [...prefixes].sort((a, b) => b.length - a.length); // longest first for regex
})();
const PROMO_CODE_RE = new RegExp('\\b(' + _promoPrefixes.join('|') + ')\\s*[#]?\\s*(\\d{2,4})\\b', 'i');
console.log('[Lakkot] Promo prefixes:', _promoPrefixes.join(', '));

// Detect language of a Lens match title based on signals
function detectTitleLang(title) {
  // JP signals checked FIRST — "Carte Pokémon Japonaise" should be JP, not FR
  if (/\b(japanese|japonais[e]?|japan|jap)\b/i.test(title)) return 'JP';
  if (/[\u30A0-\u30FF\u3040-\u309F\u4E00-\u9FFF]/.test(title)) return 'JP'; // katakana/hiragana/kanji
  if (/\b(mercari\.jp|rakuten|yahoo\s*japan|cardova\s*japan|japantcg|meccha\s*japan)\b/i.test(title)) return 'JP';
  if (/\b(M1[LSMA]|M2[ab]|SV[0-9]{1,2}[a-z]|S[0-9]{1,2}[a-z])\b/i.test(title)) return 'JP'; // JP-exclusive set codes (must have letter suffix: SV9a, S12a, M1L)
  // FR signals: French Pokemon terms, French set names, .fr domains
  if (/\b(carte pokémon|carte pokemon|cartes pokémon)\b/i.test(title)) return 'FR';
  if (/\b(étincelles|déferlantes|écarlate|obsidiennes|mascarade|destinées|rivaux|flamboyant|flammes|crépuscul|aube|tempête)\b/i.test(title)) return 'FR';
  if (/\bamazon\.fr\b/i.test(title)) return 'FR';
  // EN signals: English TCG terms, English set names, English sites
  if (/\b(pokemon tcg|pokemon card[^e]|surging sparks|destined rivals|obsidian flames|twilight masquerade|paldea evolved|scarlet.*violet|silver tempest|crown zenith|brilliant stars)\b/i.test(title)) return 'EN';
  if (/\b(ebay|gamestop|fanatics|tcgplayer)\b/i.test(title)) return 'EN';
  return null; // unknown
}

function extractPokemonFromMatches(visualMatches, targetLang = 'EN') {
  const nameVotes = {};
  const nameWithNumber = []; // [{name, nameEN, number, title, lang}]

  const cardNumRe = /\b([A-Za-z]{0,3}\d{1,4}\s*\/\s*[A-Za-z]{0,3}\d{1,4})\b/;
  // Also match dash-separated format: "033-106-SV8-B" → "033/106"
  const dashNumRe = /^(\d{2,4})-(\d{2,4})-[A-Z]{2,}/;
  // Promo codes: uses PROMO_CODE_RE built from pokemon-sets.js at module load

  for (const match of (visualMatches || []).slice(0, 15)) {
    const title = match.title || '';
    const titleLang = detectTitleLang(title);
    // Split title into words and check each against Pokemon names
    // Also split on hyphens — "Méga-Lucario-ex" → ["Méga", "Lucario", "ex"]
    const words = title.replace(/[^a-zA-ZÀ-ÿ\s'-]/g, ' ').split(/[\s-]+/).filter(w => w.length >= 3);

    for (const word of words) {
      const lower = word.toLowerCase();
      if (isPokemonName(lower)) {
        const en = pokemonToEN(lower) || lower;
        nameVotes[en] = (nameVotes[en] || 0) + 1;

        // Also check if this match has a card number
        const numMatch = title.match(cardNumRe);
        if (numMatch && numMatch[0].indexOf('/') > -1) {
          // Verify it's not a date
          const afterIdx = title.indexOf(numMatch[0]) + numMatch[0].length;
          if (title[afterIdx] !== '/') {
            nameWithNumber.push({ name: lower, nameEN: en, number: numMatch[1], title, lang: titleLang });
          }
        } else {
          // Try dash-separated format: "033-106-SV8-B" → "033/106"
          const dashMatch = title.match(dashNumRe);
          if (dashMatch) {
            nameWithNumber.push({ name: lower, nameEN: en, number: `${dashMatch[1]}/${dashMatch[2]}`, title, lang: titleLang });
          } else {
            // Try promo code: SVP044, SVPFR 044, etc.
            const promoMatch = title.match(PROMO_CODE_RE);
            if (promoMatch) {
              const promoNum = `${promoMatch[1].toUpperCase()} ${promoMatch[2]}`;
              nameWithNumber.push({ name: lower, nameEN: en, number: promoNum, title, lang: titleLang, isPromo: true });
            } else {
              // Try "Promo" + number pattern: "Evoli 173 Promo" or "Promo 173"
              const promoNumMatch = title.match(/\bpromo\b[^0-9]*(\d{2,4})\b|\b(\d{2,4})\s+promo\b/i);
              if (promoNumMatch) {
                const pNum = promoNumMatch[1] || promoNumMatch[2];
                nameWithNumber.push({ name: lower, nameEN: en, number: `Promo ${pNum}`, title, lang: titleLang, isPromo: true });
              }
            }
          }
        }
      }
    }
  }

  if (Object.keys(nameVotes).length === 0) return null;

  // Get the most voted English name
  const sorted = Object.entries(nameVotes).sort((a, b) => b[1] - a[1]);
  const topNameEN = sorted[0][0];
  const topVotes = sorted[0][1];
  console.log(`[Lakkot] Pokemon vote: "${topNameEN}" (${topVotes} votes) | all: ${JSON.stringify(sorted.slice(0, 5))}`);

  // Find the best number for this Pokemon — prefer number from matching language
  const matchesForTop = nameWithNumber.filter(m => m.nameEN === topNameEN);

  let bestMatch = null;
  if (targetLang === 'JP') {
    // JP cards use NNN/NNN set numbers, never promo codes (SVP, SWSH, etc.)
    // Priority: JP-tagged non-promo > any JP-tagged > neutral non-promo > any non-promo > fallback
    bestMatch =
      matchesForTop.find(m => m.lang === 'JP' && !m.isPromo) ||
      matchesForTop.find(m => m.lang === 'JP') ||
      matchesForTop.find(m => m.lang === null && !m.isPromo) ||
      matchesForTop.find(m => !m.isPromo) ||
      matchesForTop[0] || null;
  } else {
    // EN/FR: prefer language-matched > neutral > any
    bestMatch =
      matchesForTop.find(m => m.lang === targetLang) ||
      matchesForTop.find(m => m.lang === null) ||
      matchesForTop[0] || null;
  }
  const bestNumber = bestMatch ? bestMatch.number : null;
  const selectedTitle = bestMatch ? bestMatch.title : null;

  if (matchesForTop.length > 0) {
    console.log(`[Lakkot] Number candidates for "${topNameEN}":`);
    matchesForTop.forEach(m => console.log(`  [${m.lang || '?'}] ${m.number} ← ${m.title.slice(0, 60)}`));
    console.log(`  → Selected [${bestMatch?.lang || '?'}]: ${bestNumber}`);
  }

  // Get FR name
  const topNameFR = pokemonToFR(topNameEN) || topNameEN;

  // Vote on set name
  const setVotes = {};
  for (const match of (visualMatches || []).slice(0, 15)) {
    const setInfo = findSetInText(match.title || '');
    if (setInfo) {
      const key = setInfo.name;
      setVotes[key] = (setVotes[key] || { ...setInfo, count: 0 });
      setVotes[key].count++;
    }
  }
  const topSet = Object.values(setVotes).sort((a, b) => b.count - a.count)[0] || null;
  if (topSet) console.log(`[Lakkot] Set vote: "${topSet.name}" (${topSet.series}) — ${topSet.count} votes`);

  return {
    nameEN: topNameEN,
    nameFR: topNameFR,
    number: bestNumber,
    isPromo: bestMatch?.isPromo ?? false,
    votes: topVotes,
    totalMatches: Object.keys(nameVotes).length,
    set: topSet ? { name: topSet.name, series: topSet.series, code: topSet.code } : null,
    selectedTitle,
  };
}

// ─── TCGPlayer price lookup (EN cards only) ──────────────────────────────────
async function fetchPokemonTCG(card) {
  const NULL_PRICES = { market_price_usd: null };
  const rawName = (card.card_name || '').replace(/"/g, '').trim();
  const rawNum = card.card_number ? card.card_number.split('/')[0].trim() : '';

  // Parse the number. Promo cards arrive in three shapes:
  //   "SWSH039"        — letters+digits, no separator
  //   "SWSH 039"       — letters+space+digits (from the vote system's promoNum)
  //   "Promo 173"      — generic promo, no recognized prefix
  //   "Promo 044"      — same
  // Regular cards arrive as "069" or "069/195" or similar.
  let numberPart = null;
  let inferredPromoSet = null;
  if (rawNum) {
    // Compact letter+digit form (e.g. "SWSH039") — already valid pokemontcg.io format
    if (/^[a-zA-Z]+\d+$/.test(rawNum)) {
      numberPart = rawNum;
    } else {
      // letters + space + digits → join them so it matches the API's format
      const promoMatch = rawNum.match(/^([A-Za-z]+)\s+(\d+)$/);
      if (promoMatch) {
        numberPart = (promoMatch[1] + promoMatch[2]).toUpperCase();
      } else {
        // Plain digits (regular set): strip non-digits and leading zeros
        const digitsOnly = rawNum.replace(/\D/g, '').replace(/^0+(\d)/, '$1');
        numberPart = digitsOnly || null;
      }
    }
  }

  // Promo-set inference: when we have a letter prefix on the number and the
  // caller didn't pass a set, map the prefix to the matching Black Star Promo
  // set id on pokemontcg.io. Prevents falling back to a wrong card with the
  // same numeric suffix in an unrelated set.
  if (numberPart && /^[A-Z]+\d+$/.test(numberPart)) {
    const prefix = numberPart.match(/^[A-Z]+/)[0];
    const promoSetMap = {
      SWSH: 'swshp',
      SVP: 'svp',
      SVPSV: 'svp',
      BW: 'bwp',
      XY: 'xyp',
      SM: 'smp',
      DP: 'dpp',
      HGSS: 'hsp',
      NP: 'np',
    };
    if (promoSetMap[prefix]) inferredPromoSet = promoSetMap[prefix];
  }

  const setId = ((card.set_name || '').toLowerCase().trim()) || inferredPromoSet || '';
  const queries = [];
  if (numberPart && setId) queries.push(`name:"${rawName}" number:"${numberPart}" set.id:"${setId}"`);
  // Only fall back to number-without-set if we have no set info at all
  if (numberPart && !setId) queries.push(`name:"${rawName}" number:"${numberPart}"`);
  // No loose fallbacks — returns wrong cards too often

  for (const q of queries) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(
        `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&select=id,name,number,set,tcgplayer&pageSize=5`,
        { headers: { 'Accept': 'application/json' }, signal: ctrl.signal }
      );
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      for (const c of (data.data ?? [])) {
        const prices = c.tcgplayer?.prices;
        if (!prices) continue;
        const marketPrice = Object.values(prices).find(p => p?.market != null)?.market;
        if (marketPrice) {
          console.log('[Lakkot] TCG match:', c.name, '|', c.set?.name, '→ $' + marketPrice);
          return { market_price_usd: Math.round(marketPrice * 100) / 100, tcg_url: c.tcgplayer?.url ?? null };
        }
      }
    } catch (e) { continue; }
  }
  return NULL_PRICES;
}

// ─── DOM title cleaner ────────────────────────────────────────────────────────
function buildEbayQuery(domTitle) {
  return domTitle
    .replace(/^\s*\d{1,4}\s*[-–—]\s*/, '')   // strip seller lot number prefix (e.g. "051 - ")
    .replace(/^\s*\d+\s*\[\s*/, '')
    .replace(/\s*#\d+\s*$/, '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")   // smart quotes → normal apostrophe
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')   // smart double quotes → normal
    .replace(/[^\u0000-\u024F']/g, '')
    .replace(/[()]/g, '')          // strip parentheses (eBay treats them as grouping operators)
    // Strip seller jargon and non-card descriptors
    .replace(/\b(swirl|swirled|no swirl)\b/gi, '')
    .replace(/\b(exclu|exclusif|exclusive|exclusivit[ée])\b/gi, '')
    .replace(/\b(jpn|jap|japanese|anglaise|fran[çc]aise?|monde?|world)\b/gi, '')
    .replace(/\b(neuf|mint|played|damaged|exc|tbe|tb|be)\b/gi, '')
    .replace(/\b(1[eè]re?\s*[ée]d(ition)?|1st\s*ed(ition)?|first\s*edition)\b/gi, '1st edition')
    .replace(/\b(pas d.annulation|pdd|vu en live|vue en live)\b/gi, '')
    .replace(/\b(us|eu|fr|en)\b/gi, '')
    .replace(/&/g, '')
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
async function fetchEbayFinding(card, language = 'WORLD', dateRange = 90) {
  const ebayAppId = process.env.EBAY_APP_ID;
  const now = Date.now();
  const waitTime = FINDING_MIN_INTERVAL - (now - lastFindingCallTime);
  if (waitTime > 0) {
    console.log(`[Lakkot] Finding API: waiting ${waitTime}ms for cooldown...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastFindingCallTime = Date.now();

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

  let identity = filterByCardIdentity(query, clean, i => i?.title?.[0] ?? '', language);

  // Language filters for Finding API
  if (language === 'JP') {
    const jpKw = ['japan', 'japanese', 'jap', 'jp', 'japonais', 'japonaise'];
    identity = identity.filter(i => jpKw.some(kw => (i?.title?.[0] ?? '').toLowerCase().includes(kw)));
  }
  if (language === 'FR') {
    const exKw = ['japan', 'japanese', 'jap', 'japonais', 'japonaise', 'english version'];
    identity = identity.filter(i => !exKw.some(kw => (i?.title?.[0] ?? '').toLowerCase().includes(kw)));
  }

  // Date range filter
  if (dateRange && dateRange < 90) {
    const cutoff = Date.now() - dateRange * 24 * 60 * 60 * 1000;
    const beforeDate = identity.length;
    identity = identity.filter(i => {
      const d = i?.listingInfo?.[0]?.endTime?.[0];
      return d ? new Date(d).getTime() >= cutoff : false;
    });
    console.log(`[Lakkot] Date filter (${dateRange}d): ${beforeDate} → ${identity.length} listings`);
  }

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
    const lType = i?.listingInfo?.[0]?.listingType?.[0] ?? '';
    const isAuc = lType === 'Auction' || lType === 'AuctionWithBIN';
    return {
      title:    i?.title?.[0] ?? '',
      price:    priceEur != null ? Math.round(priceEur * 100) / 100 : null,
      soldDate: i?.listingInfo?.[0]?.endTime?.[0] ?? null,
      imageUrl: (i?.galleryURL?.[0] ?? '').replace('http://', 'https://') || null,
      itemUrl:  i?.viewItemURL?.[0] ?? null,
      country:  i?.country?.[0] ?? null,
      listingType: isAuc ? 'Auction' : 'Fixed Price',
      bidCount: isAuc ? (parseInt(i?.sellingStatus?.[0]?.bidCount?.[0]) || null) : null,
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

async function fetchEbayBrowse(card, token, language = 'WORLD', dateRange = 90) {
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
        const dateFilter = dateRange && dateRange < 90
          ? `,itemEndDate:[${new Date(Date.now() - dateRange * 86400000).toISOString()}..]`
          : '';
        if (dateFilter) console.log(`[Lakkot] Browse date filter: last ${dateRange} days`);
        const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&filter=soldItems:true${dateFilter}&sort=endDateDesc&limit=200&fieldgroups=EXTENDED`;
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
        // Debug: log first item's date fields
        if (data.itemSummaries?.[0]) {
          const first = data.itemSummaries[0];
          console.log(`[Pikanalyst] Browse first item keys: ${Object.keys(first).join(', ')}`);
          console.log(`[Pikanalyst] Browse first item dates: lastSoldDate=${first.lastSoldDate ?? 'MISSING'} itemEndDate=${first.itemEndDate ?? 'MISSING'} itemCreationDate=${first.itemCreationDate ?? 'MISSING'}`);
        }
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

    let identityItems = filterByCardIdentity(query, cleanItems, i => i.title ?? '', language);

    // JP filter: if language is JP, only keep listings with Japanese keywords in title
    if (language === 'JP') {
      const jpKeywords = ['japan', 'japanese', 'jap', 'jp', 'japonais', 'japonaise'];
      const beforeJp = identityItems.length;
      identityItems = identityItems.filter(l => {
        const titleLower = (l.title || '').toLowerCase();
        return jpKeywords.some(kw => titleLower.includes(kw));
      });
      console.log(`[Lakkot] JP filter: ${beforeJp} → ${identityItems.length} listings`);
    }

    // FR filter: if language is FR, exclude Japanese/English-only listings
    if (language === 'FR') {
      const excludeKeywords = ['japan', 'japanese', 'jap', 'japonais', 'japonaise', 'english version'];
      const beforeFr = identityItems.length;
      identityItems = identityItems.filter(l => {
        const titleLower = (l.title || '').toLowerCase();
        return !excludeKeywords.some(kw => titleLower.includes(kw));
      });
      console.log(`[Lakkot] FR filter: ${beforeFr} → ${identityItems.length} listings`);
    }

    console.log('CLEAN items used for median:');
    identityItems.forEach((item, idx) => {
      const raw = parseFloat(item.price?.value);
      const cur = item.price?.currency ?? 'EUR';
      const eur = isNaN(raw) ? '?' : toEur(raw, cur).toFixed(2);
      console.log(`${idx + 1}. [€${eur} (${cur} ${item.price?.value})] [${item._market}] ${item.title} | lastSoldDate=${item.lastSoldDate ?? 'null'} itemEndDate=${item.itemEndDate ?? 'null'}`);
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
      const buyOpts = i.buyingOptions ?? [];
      const isAuction = buyOpts.includes('AUCTION');
      return {
        title:    i.title ?? '',
        price:    priceEur != null ? Math.round(priceEur * 100) / 100 : null,
        soldDate: i.lastSoldDate ?? i.itemEndDate ?? i.itemCreationDate ?? null,
        imageUrl: i.image?.imageUrl ?? null,
        itemUrl:  i.itemWebUrl ?? null,
        country:  i.itemLocation?.country ?? null,
        listingType: isAuction ? 'Auction' : 'Fixed Price',
        bidCount: isAuction ? (i.bidCount ?? null) : null,
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

async function fetchEbayAny(card, language = 'WORLD', dateRange = 90) {
  const ebayAppId = process.env.EBAY_APP_ID;
  const certId    = process.env.EBAY_CERT_ID;
  try {
    if (ebayAppId) return await fetchEbayFinding(card, language, dateRange);
  } catch (e) {
    console.warn('[Yamo] Finding API failed:', e.message, '→ trying Browse API...');
  }
  if (ebayAppId && certId) {
    const token = await getEbayOAuthToken();
    return await fetchEbayBrowse(card, token, language, dateRange);
  }
  throw new Error('No eBay credentials available');
}

async function fetchPrices(card, language = 'WORLD', dateRange = 90) {
  let ebay = null;
  try {
    ebay = await fetchEbayAny(card, language, dateRange);
  } catch (err) {
    console.warn('[Yamo] eBay failed:', err.message);
  }
  if (ebay) console.log('[Yamo] eBay OK:', ebay.ebay_sales_count, 'items, €' + ebay.market_price_usd);
  return {
    market_price_usd:  ebay?.market_price_usd ?? null,
    price_low_usd:     ebay?.price_low_usd    ?? null,
    price_high_usd:    ebay?.price_high_usd   ?? null,
    price_source:      ebay ? 'ebay' : 'none',
    ebay_market_price: ebay?.market_price_usd ?? null,
    ebay_sales_count:  ebay?.ebay_sales_count  ?? 0,
    ebay_url:          ebay?.ebay_url           ?? null,
    listings:          ebay?.listings          ?? [],
  };
}

async function handleCard(item, sellerPrice, language = 'WORLD', dateRange = 90) {
  const cacheKey = `card|${item.card_name}|${item.card_number ?? ''}|${item.condition ?? ''}|${language}|${dateRange}`;
  const cached = cacheGet(cacheKey);
  let priceData;
  if (cached) {
    priceData = cached;
  } else {
    try {
      priceData = await fetchPrices(item, language, dateRange);
    } catch (err) {
      console.error('[Lakkot] Card price error:', err.message);
      priceData = { market_price_usd: null, price_low_usd: null, price_high_usd: null, price_source: 'none', ebay_market_price: null, ebay_sales_count: 0, ebay_url: null, listings: [] };
    }

    // DEBUG: log what the first query returned
    console.log(`[Lakkot] FIRST QUERY: sales=${priceData.ebay_sales_count} | market=${priceData.market_price_usd} | listings=${(priceData.listings||[]).length} | first_listing=${(priceData.listings?.[0]?.title||'-').slice(0,50)}`);

    // Retry if no results — try card number with name (not number alone)
    const promoMatch = !item.card_number && (item.ebay_search || '').match(/\b(SM\d{2,3}|SWSH\d{2,3}|XY\d{2,3}|BW\d{2,3}|SVP?\d{2,3})\b/i);
    const retryNumber = item.card_number || (promoMatch ? promoMatch[1] : null);
    if ((!priceData.ebay_sales_count || priceData.ebay_sales_count === 0) && retryNumber) {
      // Try multiple retry queries in order of specificity
      const name = (item.card_name || '').trim();
      const retryQueries = [
        name ? `${name} ${retryNumber}` : null,                    // "Saquedeneu 218/217"
        name ? `${name} pokemon card` : null,                      // "Saquedeneu pokemon card"
        `${retryNumber} pokemon card`,                              // "218/217 pokemon card" (last resort)
      ].filter(Boolean);

      for (const retryQuery of retryQueries) {
        console.log('[Lakkot] Card retry →', retryQuery);
        const retryItem = { ...item, ebay_search: retryQuery };
        try {
          const retryData = await fetchPrices(retryItem, language);
          if (retryData.ebay_sales_count >= 3) {
            console.log('[Lakkot] Card retry: found', retryData.ebay_sales_count, 'results');
            priceData = retryData;
            break;
          }
        } catch (_) {}
      }
    }

    cacheSet(cacheKey, priceData);
  }
  return { ...item, ...priceData, seller_asking_price: sellerPrice ?? item.seller_asking_price ?? null };
}

async function handleAnalyze({ imageBase64, streamTitle, sellerPrice, mode, manualCardOverride, language = 'WORLD', dateRange = 90 }) {
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
    // No usable title — unified endpoint handles this via Google Lens
    return { item_type: 'unknown' };
  }

  if (!item || item.item_type === 'unknown') return { item_type: 'unknown' };
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

  return handleCard(item, sellerPrice, language, dateRange);
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
    catch (err) { priceData = { market_price_usd: null, price_low_usd: null, price_high_usd: null, price_source: 'none', ebay_market_price: null, ebay_sales_count: 0, ebay_url: null, listings: [] }; }

    // Retry if no results — try card number with name
    if ((!priceData.ebay_sales_count || priceData.ebay_sales_count === 0) && cardNumber) {
      const name = parsedName.trim();
      const retryQueries = [
        name ? `${name} ${cardNumber}` : null,
        name ? `${name} pokemon card` : null,
        `${cardNumber} pokemon card`,
      ].filter(Boolean);

      for (const retryQuery of retryQueries) {
        console.log('[Lakkot] Manual retry →', retryQuery);
        const retryCard = { ...card, ebay_search: retryQuery };
        try {
          const retryData = await fetchPrices(retryCard, language);
          if (retryData.ebay_sales_count >= 3) {
            console.log('[Lakkot] Manual retry: found', retryData.ebay_sales_count, 'results');
            priceData = retryData;
            break;
          }
        } catch (_) {}
      }
    }

    cacheSet(cacheKey, priceData);
  }
  return { ...card, ...priceData };
}

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Google Auth ──────────────────────────────────────────────────────────────
app.post('/auth/google', async (req, res) => {
  const { googleToken } = req.body;
  if (!googleToken) {
    return res.status(400).json({ error: 'missing_token' });
  }

  try {
    // Verify Google token
    const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${googleToken}`);
    if (!googleRes.ok) {
      return res.status(401).json({ error: 'invalid_google_token' });
    }
    const googleUser = await googleRes.json();
    const email = googleUser.email;
    if (!email) {
      return res.status(401).json({ error: 'no_email_in_token' });
    }

    // Get profile info from Google userinfo endpoint
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${googleToken}` },
    });
    const profile = profileRes.ok ? await profileRes.json() : {};
    const name = profile.name || email.split('@')[0];
    const picture = profile.picture || null;

    // Find or create user by email
    const { data: existing } = await supabase
      .from('users')
      .select('id, token, plan, scan_count, scan_reset_at, scan_limit_override, name, picture')
      .eq('email', email)
      .single();

    let user;
    if (existing) {
      // Update profile if changed
      if (existing.name !== name || existing.picture !== picture) {
        await supabase.from('users').update({ name, picture }).eq('id', existing.id);
      }
      user = existing;
    } else {
      // Create new user
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert({ email, name, picture, plan: 'free' })
        .select('id, token, plan, scan_count, scan_reset_at, scan_limit_override')
        .single();
      if (insertError) throw insertError;
      user = newUser;
    }

    // Reset monthly count if new month
    const month = currentMonth();
    if (!user.scan_reset_at || user.scan_reset_at.slice(0, 7) !== month) {
      await supabase.from('users').update({ scan_count: 0, scan_reset_at: month }).eq('id', user.id);
      user.scan_count = 0;
    }

    const limit = user.scan_limit_override ?? (PLAN_LIMITS[user.plan] ?? PLAN_LIMITS.free);

    console.log('[Lakkot] Google auth OK:', email, '| plan:', user.plan, '| scans:', user.scan_count + '/' + limit);

    return res.json({
      token: user.token,
      email,
      name,
      picture,
      plan: user.plan || 'free',
      scanCount: user.scan_count,
      scanLimit: limit,
    });
  } catch (err) {
    console.error('[Lakkot] /auth/google error:', err.message);
    return res.status(500).json({ error: 'auth_failed' });
  }
});

// ─── Stripe: create checkout session ─────────────────────────────────────────
// LIVE price IDs (not secret — safe in source). These must match the live
// STRIPE_SECRET_KEY this server runs with, or checkout fails with "No such price".
const STRIPE_PRICE_IDS = {
  pro:   'price_1TX4ZxGZw1nrPqC9veIVB053', // Lakkot Pro — €9.99/mo / 200 scans (live)
  power: 'price_1TX4aJGZw1nrPqC96PZn8Dym', // Lakkot Power — €39.99/mo / 1500 scans (live)
};

app.post('/stripe/checkout', async (req, res) => {
  const { email, plan } = req.body;
  if (!email) return res.status(400).json({ error: 'missing_email' });

  const priceId = STRIPE_PRICE_IDS[plan] || STRIPE_PRICE_IDS.pro;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: 'https://lakkot.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://lakkot.com/pricing',
      metadata: { email, plan: plan || 'pro' },
    });
    console.log('[Lakkot] Stripe checkout session created:', session.id, '| email:', email, '| plan:', plan);
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[Lakkot] Stripe checkout error:', err.message);
    return res.status(500).json({ error: 'checkout_failed', detail: err.message });
  }
});

// ─── Stripe: webhook ─────────────────────────────────────────────────────────
// NOTE: This must be BEFORE express.json() middleware for raw body access
// But since we already have express.json() at the top, we use express.raw() here
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret && sig) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // No webhook secret configured — parse directly (dev/test mode)
      event = JSON.parse(req.body.toString());
      console.warn('[Lakkot] Stripe webhook: no signature validation (STRIPE_WEBHOOK_SECRET not set)');
    }
  } catch (err) {
    console.error('[Lakkot] Stripe webhook signature error:', err.message);
    return res.status(400).json({ error: 'invalid_signature' });
  }

  console.log('[Lakkot] Stripe webhook event:', event.type);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.metadata?.email;
    const plan = session.metadata?.plan || 'pro';
    const customerId = session.customer;

    if (email) {
      // Plan upgrade: change plan and set new limit
      const newLimit = PLAN_LIMITS[plan] || 200;
      const { error } = await supabase
        .from('users')
        .update({ plan, scan_limit_override: newLimit, stripe_customer_id: customerId })
        .eq('email', email);
      if (error) {
        console.error('[Lakkot] Stripe webhook: upgrade failed:', error.message);
      } else {
        console.log('[Lakkot] Stripe webhook: upgraded', email, 'to', plan, '(' + newLimit + ' scans/month)');
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    // Find user by stripe_customer_id and downgrade
    const { data: user } = await supabase
      .from('users')
      .select('id, email')
      .eq('stripe_customer_id', customerId)
      .single();

    if (user) {
      await supabase
        .from('users')
        .update({ plan: 'free', scan_limit_override: null })
        .eq('id', user.id);
      console.log('[Lakkot] Stripe webhook: downgraded', user.email, 'to free (subscription cancelled)');
    }
  }

  res.json({ received: true });
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

  // Reset count if it's a new month
  const month = currentMonth();
  let scanCount = user.scan_count;
  if (!user.scan_reset_at || user.scan_reset_at.slice(0, 7) !== month) scanCount = 0;

  const limit = user.scan_limit_override ?? (PLAN_LIMITS[user.plan] ?? PLAN_LIMITS.free);
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

  // Filter out secondhand/resale sources — retail price is the anchor for non-card items
  // Remove counterfeit marketplaces (always)
  const COUNTERFEIT_DOMAINS = [
    'aliexpress', 'temu', 'dhgate', 'wish',
  ];
  const KIDS_RE = /\b(kids|enfant|enfants|junior|juniors|toddler|infant|pre.?school|grade.?school|little kid|big kid|bébé|bebe|ps|td|gs)\b/i;
  const legitimate = filtered.filter(c => {
    const domain = (c.retailer || c.domain || '').toLowerCase();
    if (COUNTERFEIT_DOMAINS.some(r => domain.includes(r))) return false;
    if (KIDS_RE.test(c.title || '')) return false;
    return true;
  });

  // Trusted marketplaces — never filter these even if flagged as secondhand
  const TRUSTED_MARKETPLACES = ['stockx', 'goat', 'klekt'];
  // From legitimate results, prefer retail + trusted marketplaces over secondhand
  const retailOnly = legitimate.filter(c => {
    const domain = (c.retailer || c.domain || '').toLowerCase();
    if (TRUSTED_MARKETPLACES.some(t => domain.includes(t))) return true;
    return !c.isSecondHand;
  });
  const displaySource = retailOnly.length > 0 ? retailOnly : legitimate;
  const displayCards = displaySource.slice(0, 8);

  // Median from displayed results — so the number matches what the user sees
  const displayPrices = displayCards.map(c => c.price);
  const median = displayPrices.length > 0
    ? displayPrices[Math.floor(displayPrices.length / 2)]
    : null;

  return {
    cards: displayCards,
    medianPrice: median,
    totalFound: displaySource.length,
  };
}

// ─── Temporary image hosting (self-hosted, replaces imgbb) ───────────────────
const _tempImages = new Map();
const TEMP_IMAGE_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/tmp-img/:id', (req, res) => {
  const data = _tempImages.get(req.params.id);
  if (!data) return res.status(404).send('Not found');
  const buf = Buffer.from(data, 'base64');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(buf);
});

function hostTempImage(base64) {
  const id = crypto.randomUUID();
  _tempImages.set(id, base64);
  setTimeout(() => _tempImages.delete(id), TEMP_IMAGE_TTL);
  return `https://pikanalyst-ebay-endpoint.onrender.com/tmp-img/${id}`;
}

async function handleGoogleLens(imageBase64) {
  // STEP A: Host image temporarily on our own server
  const imageUrl = hostTempImage(imageBase64);
  console.log('[Lakkot] google_lens: self-hosted image OK —', imageUrl);

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

  // STEP C: Extract visual_matches + detected_objects
  const visualMatches = serpData.visual_matches ?? [];
  const detectedObjects = serpData.detected_objects ?? [];
  console.log(`[Lakkot] google_lens: ${visualMatches.length} visual matches, ${detectedObjects.length} detected objects`);
  console.log('[Lakkot] detected_objects:', JSON.stringify(detectedObjects?.slice(0, 3), null, 2));
  console.log('[Lakkot] visual_matches sample:', JSON.stringify(visualMatches?.slice(0, 3).map(m => m.title), null, 2));

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

  // STEP E: Product name — prefer titles with color keywords for specificity
  const COLOR_KEYWORDS = [
    'black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple',
    'pink', 'grey', 'gray', 'brown', 'beige', 'cream', 'navy', 'teal',
    'gold', 'silver', 'bronze', 'ivory', 'tan', 'khaki', 'olive',
    'noir', 'blanc', 'rouge', 'bleu', 'vert', 'jaune', 'rose', 'gris', 'marron',
    'bred', 'mocha', 'obsidian', 'sail', 'bone', 'cement', 'shadow',
    'university', 'royal', 'chicago', 'panda', 'dunk', 'infrared',
  ];
  function titleHasColor(title) {
    if (!title) return false;
    const lower = title.toLowerCase();
    return COLOR_KEYWORDS.some(c => lower.includes(c));
  }

  const kgTitle = serpData.knowledge_graph?.title ?? null;
  const colorMatch = visualMatches.find(m => titleHasColor(m.title));
  // For cards: prefer visual match with card number AND English name (best for eBay)
  const CARD_NUM_RE = /\b[A-Za-z]{0,3}\d{1,4}\s*\/\s*[A-Za-z]{0,3}\d{1,4}\b/;
  const FR_SIGNAL_RE = /\b(carte|pokémon carte|aube|crépuscul|destins|mascarade|équilibre|flammes|obsidiennes|tempête|étoiles|phyllali|dracaufeu|tortank|florizarre|ronflex|noctali|mentali|givrali|voltali|pyroli|aquali)\b/i;
  const EN_SIGNAL_RE = /\b(pokemon tcg|charizard|blastoise|venusaur|pikachu|mewtwo|mew|eevee|leafeon|snorlax|gengar|dragonite|lugia|rayquaza|garchomp|vaporeon|jolteon|flareon|umbreon|espeon|glaceon|sylveon|hidden fates|twilight|obsidian|paldea|scarlet|violet|silver tempest|crown zenith|astral|brilliant stars)\b/i;

  // Best: card number + English name
  const bestCardMatch = visualMatches.find(m => m.title && CARD_NUM_RE.test(m.title) && EN_SIGNAL_RE.test(m.title));
  // Good: English name (even without number)
  const englishMatch = visualMatches.find(m => m.title && EN_SIGNAL_RE.test(m.title));
  // OK: card number (even if French)
  const cardNumberMatch = visualMatches.find(m => m.title && CARD_NUM_RE.test(m.title) && !FR_SIGNAL_RE.test(m.title));
  // Fallback: any card number
  const anyCardNumberMatch = visualMatches.find(m => m.title && CARD_NUM_RE.test(m.title));

  const productName =
    (bestCardMatch?.title ?? null) ??
    (englishMatch?.title ?? null) ??
    (cardNumberMatch?.title ?? null) ??
    kgTitle ??
    (colorMatch?.title ?? null) ??
    (anyCardNumberMatch?.title ?? null) ??
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
    visualMatches: visualMatches.slice(0, 15), // for Pokemon vote system
  };
}

// ─── Scan feedback (thumbs up/down) ──────────────────────────────────────────
// ─── Test endpoint: check detected_objects from SerpApi Lens ──────────────────
app.get('/test/lens-objects', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).json({ error: 'missing url param' });
  try {
    const params = new URLSearchParams({
      engine: 'google_lens',
      url: imageUrl,
      api_key: process.env.SERPAPI_KEY,
      hl: 'fr',
      country: 'fr',
    });
    const serpRes = await fetch('https://serpapi.com/search.json?' + params);
    const serpData = await serpRes.json();
    return res.json({
      keys: Object.keys(serpData),
      detected_objects: serpData.detected_objects ?? [],
      visual_matches_count: (serpData.visual_matches ?? []).length,
      visual_matches_titles: (serpData.visual_matches ?? []).slice(0, 5).map(m => m.title),
      knowledge_graph: serpData.knowledge_graph ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Clear cache (dev/debug) ──────────────────────────────────────────────────
app.get('/cache/clear', (req, res) => {
  const size = _cache.size;
  _cache.clear();
  console.log(`[Lakkot] Cache cleared: ${size} entries`);
  res.json({ cleared: size });
});

// ─── Wishlist ─────────────────────────────────────────────────────────────────
app.post('/wishlist/add', async (req, res) => {
  const { token, productName, imageUrl, marketPrice, scanLogId } = req.body;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  const { data: user } = await supabase.from('users').select('email').eq('token', token).single();
  if (!user) return res.status(401).json({ error: 'invalid_token' });
  try {
    const { data, error } = await supabase.from('wishlists').insert({
      user_email: user.email,
      product_name: productName ?? null,
      image_url: imageUrl ?? null,
      market_price: marketPrice ?? null,
      scan_log_id: scanLogId ?? null,
    }).select('id').single();
    if (error) throw error;
    return res.json({ success: true, id: data.id });
  } catch (err) {
    console.error('[Lakkot] wishlist add error:', err.message);
    return res.status(500).json({ error: 'wishlist_add_failed' });
  }
});

app.post('/wishlist/remove', async (req, res) => {
  const { token, id } = req.body;
  if (!token || !id) return res.status(400).json({ error: 'missing_params' });
  const { data: user } = await supabase.from('users').select('email').eq('token', token).single();
  if (!user) return res.status(401).json({ error: 'invalid_token' });
  try {
    await supabase.from('wishlists').delete().eq('id', id).eq('user_email', user.email);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'wishlist_remove_failed' });
  }
});

app.get('/wishlist', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  const { data: user } = await supabase.from('users').select('email').eq('token', token).single();
  if (!user) return res.status(401).json({ error: 'invalid_token' });
  const { data: items } = await supabase.from('wishlists').select('*').eq('user_email', user.email).order('created_at', { ascending: false });
  return res.json({ items: items ?? [] });
});

// ─── Cardmarket price via TCGdex ─────────────────────────────────────────────
app.post('/scan/cardmarket', async (req, res) => {
  const { cardName, cardNumber, setName, language } = req.body;
  if (!cardName) return res.status(400).json({ error: 'missing cardName' });
  try {
    // Map our language toggle to TCGdex path
    const langMap = { EN: 'en', FR: 'fr', JP: 'ja' };
    const tcgdexLang = langMap[language] || 'en';

    // For JP scans, look up the Japanese (katakana) name from POKEMON_NAMES.
    // The /v2/ja/ database requires a Japanese name to return useful matches —
    // searching with the English name returns almost nothing.
    let searchName = cardName;
    if (language === 'JP') {
      const lc = (cardName || '').toLowerCase().split(/\s+/)[0];
      const row = POKEMON_NAMES.find(r => r[0] === lc);
      if (row && row[2]) searchName = row[2];
    }

    // Extract the card number (first part before /)
    const num = cardNumber ? cardNumber.split('/')[0].trim() : '';

    // Search TCGdex by name (+ set name if available)
    let searchUrl = `https://api.tcgdex.net/v2/${tcgdexLang}/cards?name=${encodeURIComponent(searchName)}`;
    if (setName && language !== 'JP') searchUrl += `&set.name=${encodeURIComponent(setName)}`;

    const ctrl1 = new AbortController();
    const timer1 = setTimeout(() => ctrl1.abort(), 5000);
    const searchRes = await fetch(searchUrl, { signal: ctrl1.signal });
    clearTimeout(timer1);
    const searchData = await searchRes.json();

    if (!Array.isArray(searchData) || searchData.length === 0) {
      return res.json({ cardmarket: null });
    }

    // Find matching card by number
    let match = null;
    if (num) {
      const padNum = num.padStart(3, '0');
      match = searchData.find(c => c.localId === padNum || c.localId === num);
    }
    // Fallback: first result if no number match
    if (!match) match = searchData[0];

    // Fetch full card data with pricing
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), 5000);
    const cardRes = await fetch(`https://api.tcgdex.net/v2/${tcgdexLang}/cards/${match.id}`, { signal: ctrl2.signal });
    clearTimeout(timer2);
    const cardData = await cardRes.json();

    const cm = cardData.pricing?.cardmarket;
    if (!cm) {
      return res.json({ cardmarket: null });
    }

    // Pick the most reliable price reference.
    // For sparse markets (typical for JP variants), the "trend" can collapse to
    // the minimum listing (e.g. €0.02). avg30 — the 30-day average — is more
    // resistant to that, so prefer it when it's meaningfully higher than trend.
    const trend = cm.trend ?? null;
    const avg30 = cm['avg30'] ?? null;
    const referencePrice = (avg30 != null && (trend == null || avg30 > trend * 2))
      ? avg30
      : trend;
    if (referencePrice == null || referencePrice <= 0) {
      return res.json({ cardmarket: null });
    }

    return res.json({
      cardmarket: {
        trend: referencePrice,
        avg: cm.avg,
        low: cm.low,
        avg30: avg30,
        // Cardmarket's /Cards/{idProduct} short URL is unreliable. Use the
        // advanced singles search — we add the localId from TCGdex (which carries
        // any leading zero) plus the set's TCGdex slug (e.g. "sv2a", "sv03.5") so
        // the right variant lands at or near the top of the results.
        url: (() => {
          const setSlug = cardData?.set?.id || '';
          const localId = cardData?.localId || (cardNumber || '').split('/')[0] || '';
          const terms = [cardName, localId, setSlug].filter(Boolean).join(' ').trim();
          return terms
            ? `https://www.cardmarket.com/en/Pokemon/Products/Singles?searchString=${encodeURIComponent(terms)}`
            : null;
        })(),
        updated: cm.updated,
      }
    });
  } catch (err) {
    console.warn('[Lakkot] Cardmarket fetch failed:', err.message);
    return res.json({ cardmarket: null });
  }
});

// ─── Scan history per user ───────────────────────────────────────────────────
app.post('/scan/history', async (req, res) => {
  const { token, route } = req.body;
  if (!token) return res.status(400).json({ error: 'missing token' });
  const { data: user } = await supabase.from('users').select('email').eq('token', token).single();
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  try {
    let q = supabase
      .from('scan_logs')
      .select('id, created_at, image_url, cropped_image_url, product_name, market_price, asking_price, sold_price, ebay_sales_count, lang_toggle, route, result_type')
      .eq('user_email', user.email)
      .not('product_name', 'is', null);
    // Optional route filter — used by the extension to show only Gemini scans
    // in history when the Gemini toggle is on.
    if (typeof route === 'string' && route.trim()) q = q.eq('route', route.trim());
    const { data: scans } = await q
      .order('created_at', { ascending: false })
      .limit(50);
    return res.json({ history: scans ?? [] });
  } catch (err) {
    console.error('[Lakkot] history error:', err.message);
    return res.json({ history: [] });
  }
});

// ─── Record SOLD price for a scan (auto-captured when Whatnot SOLD banner fires) ─
app.post('/scan/sold', async (req, res) => {
  const { token, scanLogId, soldPrice } = req.body;
  if (!token || !scanLogId) return res.status(400).json({ error: 'missing token or scanLogId' });
  const { data: user } = await supabase.from('users').select('email').eq('token', token).single();
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const price = soldPrice == null ? null : Number(soldPrice);
  if (price != null && (!Number.isFinite(price) || price < 0 || price > 999999)) {
    return res.status(400).json({ error: 'invalid soldPrice' });
  }
  const { error } = await supabase
    .from('scan_logs')
    .update({ sold_price: price })
    .eq('id', scanLogId)
    .eq('user_email', user.email);
  if (error) {
    console.error('[Lakkot] /scan/sold update error:', error.message);
    return res.status(500).json({ error: 'update_failed' });
  }
  return res.json({ ok: true });
});

// ─── Re-price: same card query, different date range (no new scan) ───────────
app.post('/scan/reprice', async (req, res) => {
  const { query, language = 'WORLD', dateRange = 90 } = req.body;
  if (!query) return res.status(400).json({ error: 'missing query' });
  try {
    const result = await handleAnalyze({ imageBase64: '', streamTitle: query, sellerPrice: null, mode: 'cards', manualCardOverride: query, language, dateRange });
    const mp = result.market_price_usd ?? result.ebay_market_price ?? null;
    return res.json({
      market_price_usd: mp,
      ebay_sales_count: result.ebay_sales_count ?? 0,
      listings: result.listings ?? [],
      ebay_url: result.ebay_url ?? null,
      dateRange,
    });
  } catch (err) {
    console.error('[Lakkot] reprice error:', err.message);
    return res.json({ market_price_usd: null, ebay_sales_count: 0, listings: [], dateRange });
  }
});

app.post('/scan/feedback', async (req, res) => {
  const { scanLogId, feedback, reason } = req.body;
  if (!scanLogId || !['thumbs_up', 'thumbs_down'].includes(feedback)) {
    return res.status(400).json({ error: 'invalid_feedback' });
  }
  try {
    // Always update the core feedback fields — works regardless of whether the
    // feedback_reason column has been added to scan_logs yet.
    await supabase.from('scan_logs')
      .update({ user_feedback: feedback, feedback_at: new Date().toISOString() })
      .eq('id', scanLogId);
    // Optionally store the reason in a separate update so a missing column
    // doesn't fail the whole feedback save.
    if (typeof reason === 'string' && reason.trim()) {
      const trimmed = reason.trim().slice(0, 2000);
      const { error: reasonErr } = await supabase.from('scan_logs')
        .update({ feedback_reason: trimmed }).eq('id', scanLogId);
      if (reasonErr) {
        console.warn('[Lakkot] feedback_reason save failed (column may not exist yet):', reasonErr.message);
      }
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[Lakkot] feedback error:', err.message);
    return res.status(500).json({ error: 'feedback_failed' });
  }
});

// ─── /scan/gemini — experimental Gemini 3 Flash card path ────────────────────
// Takes the image, calls Gemini with grounded web search, maps the strict-JSON
// response into the existing CARD_RESULT shape so the current renderer handles
// it unchanged. No fallback to the standard pipeline — failures are shown honestly.
app.post('/scan/gemini', async (req, res) => {
  geminiHitCount++;
  geminiLastHit = new Date().toISOString();
  console.log('[Lakkot/Gemini] HIT #' + geminiHitCount, geminiLastHit, 'bodyKeys:', Object.keys(req.body || {}).join(','));

  // Wrap the entire handler so any unhandled rejection becomes a clean 500
  // instead of crashing the Node process (Express 4 does not auto-catch async
  // errors). Crashing the worker is what was returning 502 to the extension.
  try {
  // Extension's scan dispatcher sends the unified-scan body shape; we read the
  // image + asking price + the user's language toggle (for the scan_log row;
  // Gemini's own claimed language is unreliable for the schema's constraint).
  const { imageBase64, fullFrameBase64, askingPrice, sellerPrice, streamCurrency, streamTitle, language, token } = req.body || {};
  const ask = askingPrice ?? sellerPrice ?? null; // extension uses sellerPrice

  if (!token)       { geminiLastError = 'missing_token at ' + geminiLastHit;       return res.status(401).json({ error: 'missing_token' }); }
  if (!imageBase64) { geminiLastError = 'missing_image at ' + geminiLastHit;       return res.status(400).json({ error: 'missing_image' }); }
  if (!process.env.GEMINI_API_KEY) {
    console.error('[Lakkot/Gemini] GEMINI_API_KEY not set');
    geminiLastError = 'gemini_not_configured at ' + geminiLastHit;
    return res.status(500).json({ error: 'gemini_not_configured' });
  }

  // --- Quota: same shape as the unified scan path ---
  let user, userErr;
  try {
    const sel = await supabase
      .from('users')
      .select('id, email, name, plan, scan_count, scan_reset_at, scan_limit_override')
      .eq('token', token)
      .single();
    user = sel.data; userErr = sel.error;
  } catch (e) {
    console.error('[Lakkot/Gemini] supabase select threw:', e.message);
    geminiLastError = 'supabase_select_threw: ' + e.message + ' at ' + geminiLastHit;
    return res.status(503).json({ error: 'db_unavailable', detail: e.message });
  }
  if (userErr || !user) {
    geminiLastError = 'invalid_token (userErr=' + (userErr?.message || 'none') + ') at ' + geminiLastHit;
    return res.status(401).json({ error: 'invalid_token' });
  }

  const month = currentMonth();
  try {
    if (!user.scan_reset_at || user.scan_reset_at.slice(0, 7) !== month) {
      await supabase.from('users').update({ scan_count: 1, scan_reset_at: month }).eq('id', user.id);
      user.scan_count = 1;
    } else {
      await supabase.from('users').update({ scan_count: user.scan_count + 1 }).eq('id', user.id);
      user.scan_count += 1;
    }
  } catch (e) {
    console.error('[Lakkot/Gemini] supabase update threw:', e.message);
    geminiLastError = 'supabase_update_threw: ' + e.message + ' at ' + geminiLastHit;
    return res.status(503).json({ error: 'db_unavailable', detail: e.message });
  }
  const limit = user.scan_limit_override ?? (PLAN_LIMITS[user.plan] ?? PLAN_LIMITS.free);
  const quota = { count: user.scan_count, remaining: Math.max(0, limit - user.scan_count), limit };
  if (user.scan_count > limit) {
    return res.json({ type: 'LIMIT_REACHED', quota });
  }

  // --- Call Gemini Flash ---
  // Auth via header (not URL query) so the key never appears in any URL log.
  // 25s timeout: Gemini Flash with grounded search can be slow; without a
  // timeout the request handler would hang indefinitely if Google stalls.
  // Model: 2.5-flash is the stable Flash model with grounded search support.
  // Override at deploy time with GEMINI_MODEL for testing newer previews
  // (e.g. gemini-3-flash-preview-MM-YYYY when available).
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let parsed;
  let apiDiagnostic = null; // temp: surface API failures in the response for debugging
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify(buildGeminiRequest(imageBase64, 'image/jpeg')),
      signal: AbortSignal.timeout(55_000),  // bumped from 25s — the multi-step
                                            // grounded search (per-grade prices +
                                            // 12-month history) genuinely takes longer
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[Lakkot/Gemini] API error', r.status, text.slice(0, 400));
      apiDiagnostic = { status: r.status, body: text.slice(0, 400), model };
      lastGeminiApiError = `HTTP ${r.status}: ${text.slice(0, 300)} @ ${new Date().toISOString()}`;
      parsed = { error: 'api_error' };
    } else {
      const data = await r.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      parsed = parseGeminiResponse(rawText);
      if (!rawText) {
        apiDiagnostic = { status: 200, body: '(empty text part)', model, raw: JSON.stringify(data).slice(0, 400) };
        lastGeminiApiError = `200 empty text part. raw=${JSON.stringify(data).slice(0, 300)} @ ${new Date().toISOString()}`;
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      console.error('[Lakkot/Gemini] timeout after 55s');
      apiDiagnostic = { status: 0, body: 'timeout after 55s', model };
      lastGeminiApiError = `timeout 55s @ ${new Date().toISOString()}`;
    } else {
      console.error('[Lakkot/Gemini] fetch failed:', err.message);
      apiDiagnostic = { status: 0, body: 'fetch failed: ' + err.message, model };
      lastGeminiApiError = `fetch threw: ${err.message} @ ${new Date().toISOString()}`;
    }
    parsed = { error: 'api_error' };
  }

  // --- Map to CARD_RESULT and compute verdict ---
  const result = mapToCardResult(parsed);
  const mp = result.market_price;
  const verdict = mp && ask
    ? (ask / mp < 0.90 ? 'DEAL' : ask / mp > 1.10 ? 'OVER' : 'FAIR')
    : 'NO_DATA';

  console.log(
    '[Lakkot/Gemini]',
    result.card_name || '(unidentified)',
    '| game:', result.card_game,
    '| eBay:', result.market_price, 'TCG:', result.tcg_player_price, 'PC:', result.cardmarket_price,
    '| verdict:', verdict,
  );

  let logId = null;
  let logScanError = null;
  try {
    logId = await logScan({
      userEmail: user.email, userName: user.name,
      domTitle: streamTitle ?? null,                       // seller's DOM listing title
      imageBase64: imageBase64 ?? null,                    // store the scanned image so the admin dashboard + scan history can show a thumbnail
      croppedImageBase64: null,
      route: 'gemini',
      productName: result.card_name,
      lensProductName: result.card_name,
      ebayQuery: null,
      resultType: result.card_name ? 'CARD_RESULT' : 'NO_DATA',
      marketPrice: mp,
      askingPrice: ask,
      verdict,
      sourcesCount: 0,
      ebaySalesCount: 0,
      lensMatches: [JSON.stringify(parsed).slice(0, 800)],
      lensSelected: result.card_name,
      langToggle: language || 'WORLD',                     // user's toggle, NOT Gemini's claimed language
    });
  } catch (e) {
    console.error('[Lakkot/Gemini] logScan threw:', e.message);
    logScanError = e.message;
    // continue — we still want to return the result to the user
  }

  return res.json({
    type: result.card_name ? 'CARD_RESULT' : 'NO_DATA',
    ...result,
    asking_price: ask,
    stream_currency: streamCurrency || 'EUR',
    verdict,
    quota,
    scanLogId: logId,
    _geminiDiagnostic: apiDiagnostic, // temp: helps diagnose API failures from the response itself
    _logScanError: logScanError,      // temp: surface the logScan failure reason
    _geminiRaw: JSON.stringify(parsed).slice(0, 800), // temp: see Gemini's actual parsed output
  });
  } catch (err) {
    console.error('[Lakkot/Gemini] UNCAUGHT in handler:', err && err.stack ? err.stack : err);
    geminiLastError = 'uncaught: ' + (err && err.message || String(err)) + ' at ' + geminiLastHit;
    if (!res.headersSent) return res.status(500).json({ error: 'gemini_handler_threw', detail: err && err.message || String(err) });
  }
});

// Global process-level guards so an unhandled async error never takes the
// service down (which is what was returning 502 to clients).
process.on('unhandledRejection', (reason) => {
  console.error('[Lakkot] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Lakkot] uncaughtException:', err && err.stack ? err.stack : err);
});

// ─── /scan/gemini-stream — sub-6s perceived response ─────────────────────────
// Streams partial results via Server-Sent Events:
//   event: identity   — card identity (after ~2-3s vision call, no grounded search)
//   event: price      — one per source as it returns (ebay / tcgplayer / pricecharting)
//   event: done       — final merged scan_log id + quota
//   event: error      — fatal error in the pipeline (won't terminate price stream)
//
// Architecture: 1 identity call (no search) + 3 parallel price calls (each
// single-source grounded search) instead of 1 omnibus call. Faster identity,
// faster individual prices, progressive UI.
async function callGeminiText(prompt, withGrounding, timeoutMs) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify(buildTextOnlyRequest(prompt, withGrounding)),
    signal: AbortSignal.timeout(timeoutMs || 45_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 200));
  }
  const data = await r.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseGeminiResponse(rawText);
}

async function callGeminiIdentity(imageBase64, timeoutMs) {
  // Identity uses a faster/smaller model than the price-lookup calls. It does
  // visual-only ID (no grounded search), so a lighter model is sufficient and
  // shaves ~2-3s vs gemini-2.5-flash. Override via GEMINI_IDENTITY_MODEL.
  const model = process.env.GEMINI_IDENTITY_MODEL || 'gemini-2.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify(buildIdentityRequest(imageBase64, 'image/jpeg')),
    signal: AbortSignal.timeout(timeoutMs || 20_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 200));
  }
  const data = await r.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseGeminiResponse(rawText);
}

app.post('/scan/gemini-stream', async (req, res) => {
  geminiHitCount++;
  geminiLastHit = new Date().toISOString();
  const t0 = Date.now();
  console.log('[Lakkot/Gemini-stream] HIT #' + geminiHitCount, geminiLastHit);

  // --- SSE headers (must be sent before first event) ---
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
  res.flushHeaders?.();

  const sse = (event, dataObj) => {
    try {
      res.write('event: ' + event + '\n');
      res.write('data: ' + JSON.stringify(dataObj) + '\n\n');
    } catch (e) { /* client disconnected */ }
  };

  try {
    const { imageBase64, askingPrice, sellerPrice, streamCurrency, streamTitle, language, token } = req.body || {};
    const ask = askingPrice ?? sellerPrice ?? null;

    if (!token)       { sse('error', { error: 'missing_token' });           return res.end(); }
    if (!imageBase64) { sse('error', { error: 'missing_image' });           return res.end(); }
    if (!process.env.GEMINI_API_KEY) { sse('error', { error: 'gemini_not_configured' }); return res.end(); }

    // --- Quota (inline; mirrors /scan/gemini) ---
    const { data: user, error: userErr } = await supabase.from('users')
      .select('id, email, name, plan, scan_count, scan_reset_at, scan_limit_override')
      .eq('token', token).single();
    if (userErr || !user) { sse('error', { error: 'invalid_token' }); return res.end(); }
    const month = currentMonth();
    if (!user.scan_reset_at || user.scan_reset_at.slice(0, 7) !== month) {
      await supabase.from('users').update({ scan_count: 1, scan_reset_at: month }).eq('id', user.id);
      user.scan_count = 1;
    } else {
      await supabase.from('users').update({ scan_count: user.scan_count + 1 }).eq('id', user.id);
      user.scan_count += 1;
    }
    const limit = user.scan_limit_override ?? (PLAN_LIMITS[user.plan] ?? PLAN_LIMITS.free);
    const quota = { count: user.scan_count, remaining: Math.max(0, limit - user.scan_count), limit };
    sse('quota', quota);
    if (user.scan_count > limit) { sse('error', { error: 'limit_reached', quota }); return res.end(); }

    // --- Stage 1: identity (no grounded search) ---
    let identity = null;
    const identityModel = process.env.GEMINI_IDENTITY_MODEL || 'gemini-2.5-flash-lite';
    const identityT0 = Date.now();
    try {
      identity = await callGeminiIdentity(imageBase64, 20_000);
      console.log('[Lakkot/Gemini-stream] identity model=' + identityModel + ' took ' + (Date.now() - identityT0) + 'ms');
    } catch (e) {
      console.error('[Lakkot/Gemini-stream] identity failed:', e.message);
      sse('identity', { _engine: 'gemini', _geminiError: 'identity_failed', error: e.message });
      sse('done', { quota, scanLogId: null, ms: Date.now() - t0 });
      return res.end();
    }
    const mappedIdentity = mapIdentityToCardResult(identity);
    sse('identity', mappedIdentity);
    console.log('[Lakkot/Gemini-stream] identity at +' + (Date.now() - t0) + 'ms:', mappedIdentity.card_name);

    if (!mappedIdentity.card_name) {
      // No usable identity → no point fetching prices
      sse('done', { quota, scanLogId: null, ms: Date.now() - t0 });
      // Log the failed-identification attempt async (don't block response)
      setImmediate(() => {
        logScan({
          userEmail: user.email, userName: user.name,
          domTitle: streamTitle ?? null, imageBase64,
          route: 'gemini-stream', productName: null, resultType: 'NO_DATA',
          marketPrice: null, askingPrice: ask, verdict: 'NO_DATA',
          lensMatches: [JSON.stringify(identity).slice(0, 800)],
          langToggle: language || 'WORLD',
        }).catch((err) => console.warn('[Lakkot/Gemini-stream] async log fail:', err.message));
      });
      return res.end();
    }

    // --- Stage 2: 3 parallel price calls ---
    const merged = { ...mappedIdentity };
    const runPrice = async (sourceName, prompt, mapper) => {
      const tStart = Date.now();
      try {
        const parsed = await callGeminiText(prompt, true, 45_000);
        const mapped = mapper(parsed);
        Object.assign(merged, mapped);
        const elapsed = Date.now() - tStart;
        sse('price', { source: sourceName, ...mapped, _ms: elapsed });
        console.log('[Lakkot/Gemini-stream] ' + sourceName + ' at +' + (Date.now() - t0) + 'ms (' + elapsed + 'ms call)');
      } catch (e) {
        console.error('[Lakkot/Gemini-stream] ' + sourceName + ' failed:', e.message);
        sse('price', { source: sourceName, error: e.message });
      }
    };
    await Promise.allSettled([
      runPrice('ebay',          buildEbayPricePrompt(identity),         mapEbayPriceToCardResult),
      runPrice('tcgplayer',     buildTcgplayerPricePrompt(identity),    mapTcgplayerPriceToCardResult),
      runPrice('pricecharting', buildPriceChartingPrompt(identity),     mapPriceChartingToCardResult),
    ]);

    // --- Compute final verdict + done event ---
    const mp = merged.ebay_market_price ?? merged.market_price ?? null;
    const verdict = mp && ask ? (ask / mp < 0.90 ? 'DEAL' : ask / mp > 1.10 ? 'OVER' : 'FAIR') : 'NO_DATA';

    sse('done', { quota, verdict, asking_price: ask, stream_currency: streamCurrency || 'EUR', ms: Date.now() - t0 });
    res.end();

    // --- Async log (fire and forget, off critical path) ---
    setImmediate(() => {
      logScan({
        userEmail: user.email, userName: user.name,
        domTitle: streamTitle ?? null, imageBase64,
        route: 'gemini-stream', productName: merged.card_name,
        lensProductName: merged.card_name,
        resultType: 'CARD_RESULT',
        marketPrice: mp, askingPrice: ask, verdict,
        lensMatches: [JSON.stringify({ identity, merged }).slice(0, 1200)],
        lensSelected: merged.card_name,
        langToggle: language || 'WORLD',
      }).catch((err) => console.warn('[Lakkot/Gemini-stream] async log fail:', err.message));
    });
  } catch (err) {
    console.error('[Lakkot/Gemini-stream] UNCAUGHT:', err && err.stack || err);
    geminiLastError = 'stream_uncaught: ' + (err && err.message);
    try { sse('error', { error: 'pipeline_failed', detail: err && err.message }); } catch (_) {}
    try { res.end(); } catch (_) {}
  }
});

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

  // ─── Scan logging helper ──────────────────────────────────────────────────
  async function logScan({ userEmail, userName, platform, domTitle, imageBase64, croppedImageBase64, route, productName, lensProductName, ebayQuery, resultType, marketPrice, askingPrice, verdict, sourcesCount, ebaySalesCount, lensMatches, lensSelected, ebayResults, langToggle }) {
    try {
      // Upload original image to Supabase Storage
      let imageUrl = null;
      if (imageBase64) {
        const buf = Buffer.from(imageBase64, 'base64');
        const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jpg`;
        const { data: uploadData, error: uploadErr } = await supabase.storage
          .from('scan-images')
          .upload(fileName, buf, { contentType: 'image/jpeg', upsert: false });
        if (!uploadErr && uploadData) {
          const { data: urlData } = supabase.storage.from('scan-images').getPublicUrl(fileName);
          imageUrl = urlData?.publicUrl ?? null;
        }
      }
      // Upload cropped image if exists
      let croppedImageUrl = null;
      if (croppedImageBase64) {
        const cropBuf = Buffer.from(croppedImageBase64, 'base64');
        const cropFileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-crop.jpg`;
        const { data: cropUpload, error: cropErr } = await supabase.storage
          .from('scan-images')
          .upload(cropFileName, cropBuf, { contentType: 'image/jpeg', upsert: false });
        if (!cropErr && cropUpload) {
          const { data: cropUrlData } = supabase.storage.from('scan-images').getPublicUrl(cropFileName);
          croppedImageUrl = cropUrlData?.publicUrl ?? null;
        }
      }
      // Insert log
      const { data: logData, error: insertErr } = await supabase.from('scan_logs').insert({
        user_email: userEmail ?? null,
        user_name: userName ?? null,
        platform: platform ?? null,
        dom_title: domTitle ?? null,
        image_url: imageUrl,
        cropped_image_url: croppedImageUrl,
        route: route ?? null,
        product_name: productName ?? null,
        lens_product_name: lensProductName ?? null,
        ebay_query: ebayQuery ?? null,
        result_type: resultType ?? null,
        market_price: marketPrice ?? null,
        asking_price: askingPrice ?? null,
        verdict: verdict ?? null,
        sources_count: sourcesCount ?? 0,
        ebay_sales_count: ebaySalesCount ?? 0,
        lens_matches: lensMatches ?? null,
        lens_selected: lensSelected ?? null,
        ebay_results: ebayResults ?? null,
        lang_toggle: langToggle ?? null,
      }).select('id').single();
      if (insertErr) {
        console.warn('[Lakkot] scan log insert error:', insertErr.message, '| details:', insertErr.details || '');
        lastLogScanError = (route || '?') + ' @ ' + new Date().toISOString() + ' insert: ' + insertErr.message + (insertErr.details ? ' | ' + insertErr.details : '');
      }
      return logData?.id ?? null;
    } catch (err) {
      console.warn('[Lakkot] scan log failed:', err.message);
      lastLogScanError = (route || '?') + ' @ ' + new Date().toISOString() + ': ' + err.message;
      return null;
    }
  }

  // unified: auto-detect item type and route to correct pricing pipeline
  if (type === 'unified') {
    // Track quota — increment scan count and return remaining
    let quota = null;
    let scanUser = null;
    if (token) {
      const { data: user } = await supabase.from('users').select('id, email, name, plan, scan_count, scan_reset_at, scan_limit_override').eq('token', token).single();
      scanUser = user;
      if (user) {
        const month = currentMonth();
        if (!user.scan_reset_at || user.scan_reset_at.slice(0, 7) !== month) {
          await supabase.from('users').update({ scan_count: 1, scan_reset_at: month }).eq('id', user.id);
          user.scan_count = 1;
        } else {
          await supabase.from('users').update({ scan_count: user.scan_count + 1 }).eq('id', user.id);
          user.scan_count += 1;
        }
        const limit = user.scan_limit_override ?? (PLAN_LIMITS[user.plan] ?? PLAN_LIMITS.free);
        quota = { count: user.scan_count, remaining: Math.max(0, limit - user.scan_count), limit };

        if (user.scan_count > limit) {
          return res.json({ type: 'LIMIT_REACHED', quota });
        }
      }
    }

    try {
      let { imageBase64, fullFrameBase64, streamTitle, sellerPrice, language = 'WORLD', streamCurrency = 'EUR', cropCenter = false, dateRange = 90 } = params;
      // If client sent a full frame (scan zone active), use it as the original for logging
      // imageBase64 = the zone-cropped image (what Lens/eBay sees)
      // fullFrameBase64 = the full stream frame (for QA)
      const originalImageBase64 = fullFrameBase64 || imageBase64;
      const rawTitle = (streamTitle ?? '').trim();
      const hasTitle = rawTitle.length > 3 && !isFakeTitle(rawTitle);
      // If zone crop was done client-side, imageBase64 is already cropped
      let croppedImageBase64 = fullFrameBase64 ? imageBase64 : null;
      const hasZone = !!fullFrameBase64; // scan zone is active

      // Centre crop: crop to center 50% of image for better card recognition
      if (cropCenter && imageBase64) {
        try {
          const buf = Buffer.from(imageBase64, 'base64');
          const meta = await sharp(buf).metadata();
          const w = meta.width, h = meta.height;
          const cropW = Math.round(w * 0.5);
          const cropH = Math.round(h * 0.5);
          const left = Math.round((w - cropW) / 2);
          const top = Math.round((h - cropH) / 2);
          const cropped = await sharp(buf).extract({ left, top, width: cropW, height: cropH }).jpeg().toBuffer();
          croppedImageBase64 = cropped.toString('base64');
          imageBase64 = croppedImageBase64;
          console.log(`[Lakkot] Centre crop: ${w}x${h} → ${cropW}x${cropH}`);
        } catch (cropErr) {
          console.warn('[Lakkot] Centre crop failed:', cropErr.message);
        }
      }

      // Check for unsupported items (sealed, lots, multi — graded cards are allowed, Lens identifies through slab)
      if (hasTitle) {
        const unsupportedReason = isBooster(rawTitle) ? 'sealed' : isMultiChoice(rawTitle) ? 'multi' : null;
        if (unsupportedReason) {
          const messages = { sealed: 'Sealed product — pricing not supported yet', lot: 'Lot/bundle — pricing not supported yet', multi: 'Multi-choice listing — pricing not supported yet' };
          const logId = await logScan({ userEmail: scanUser?.email, userName: scanUser?.name, domTitle: rawTitle, imageBase64: originalImageBase64, croppedImageBase64, route: 'title-unsupported', resultType: 'UNSUPPORTED', askingPrice: sellerPrice });
          return res.json({ type: 'UNSUPPORTED', reason: unsupportedReason, message: messages[unsupportedReason], title: rawTitle, quota, scanLogId: logId });
        }
      }

      // All scans go through Google Lens — no DOM title route
      console.log('[Lakkot] Unified: non-card or no title, running Google Lens...');
      const lensResult = await handleGoogleLens(imageBase64);
      const productName = lensResult?.productName ?? null;

      // === EN toggle: vote-based Pokemon identification ===
      if (language === 'EN' && lensResult?.visualMatches) {
        const vote = extractPokemonFromMatches(lensResult.visualMatches, 'EN');
        if (vote) {
          const voteQuery = vote.number
            ? `${vote.nameEN} ${vote.number}`
            : `${vote.nameEN} pokemon card`;
          console.log(`[Lakkot] EN vote query: "${voteQuery}" (${vote.nameEN} / ${vote.nameFR}, number: ${vote.number})`);

          // eBay sold price
          const result = await handleAnalyze({ imageBase64, streamTitle: voteQuery, sellerPrice, mode: 'cards', manualCardOverride: voteQuery, language, dateRange });
          const mp = result.market_price_usd ?? result.ebay_market_price ?? null;
          const v = mp && sellerPrice ? (sellerPrice / mp < 0.90 ? 'DEAL' : sellerPrice / mp > 1.10 ? 'OVER' : 'FAIR') : 'NO_DATA';

          // TCGPlayer price (EN cards only)
          let tcgPrice = null;
          let tcgUrl = null;
          if (vote.number) {
            try {
              // Always pass set ID when available — prevents wrong card with same number
              const tcgSetId = vote.set ? vote.set.code : '';
              const tcgCard = { card_name: vote.nameEN, card_number: vote.number, set_name: tcgSetId, condition: 'Near Mint' };
              const tcgData = await fetchPokemonTCG(tcgCard);
              tcgPrice = tcgData?.market_price_usd ?? null;
              tcgUrl = tcgData?.tcg_url ?? null;
              if (tcgPrice) console.log(`[Lakkot] TCGPlayer price: $${tcgPrice}`);
            } catch (e) {
              console.warn('[Lakkot] TCGPlayer failed:', e.message);
            }
          }

          const lensMatchTitles = (lensResult.visualMatches || []).slice(0, 15).map(m => m.title || '');
          const ebayTopResults = (result.listings || []).slice(0, 10).map(l => ({ title: l.title, price: l.price, soldDate: l.soldDate || null }));
          const logId = await logScan({ userEmail: scanUser?.email, userName: scanUser?.name, domTitle: rawTitle, imageBase64: originalImageBase64, croppedImageBase64, route: 'lens-card-en-vote', productName: `${vote.nameEN} ${vote.number || ''}`, lensProductName: productName, ebayQuery: voteQuery, resultType: mp ? 'CARD_RESULT' : 'NO_DATA', marketPrice: mp, askingPrice: sellerPrice, verdict: v, ebaySalesCount: result.ebay_sales_count ?? 0, lensMatches: lensMatchTitles, lensSelected: vote.selectedTitle, ebayResults: ebayTopResults, langToggle: language });

          return res.json({
            type: 'CARD_RESULT',
            ...result,
            card_name: vote.nameEN,
            card_name_fr: vote.nameFR,
            set_name: vote.set ? `${vote.set.name} (${vote.set.series})` : result.set_name || '',
            ebay_sales_count: result.ebay_sales_count ?? 0,
            tcg_market_price: tcgPrice,
            tcg_url: tcgUrl,
            identified_by: 'lens-en-vote',
            pokemon_votes: vote.votes,
            quota,
            scanLogId: logId,
          });
        }
      }

      // === JP toggle: vote-based Pokemon identification ===
      if (language === 'JP' && lensResult?.visualMatches) {
        const vote = extractPokemonFromMatches(lensResult.visualMatches, 'JP');
        if (vote) {
          const voteQuery = vote.number
            ? `${vote.nameEN} ${vote.number} japanese`
            : `${vote.nameEN} japanese pokemon card`;
          console.log(`[Lakkot] JP vote query: "${voteQuery}" (${vote.nameEN} / ${vote.nameFR}, number: ${vote.number})`);

          // eBay sold price — search with JP language filter
          const result = await handleAnalyze({ imageBase64, streamTitle: voteQuery, sellerPrice, mode: 'cards', manualCardOverride: voteQuery, language: 'JP', dateRange });
          const mp = result.market_price_usd ?? result.ebay_market_price ?? null;
          const v = mp && sellerPrice ? (sellerPrice / mp < 0.90 ? 'DEAL' : sellerPrice / mp > 1.10 ? 'OVER' : 'FAIR') : 'NO_DATA';

          const lensMatchTitles = (lensResult.visualMatches || []).slice(0, 15).map(m => m.title || '');
          const ebayTopResults = (result.listings || []).slice(0, 10).map(l => ({ title: l.title, price: l.price, soldDate: l.soldDate || null }));
          const logId = await logScan({ userEmail: scanUser?.email, userName: scanUser?.name, domTitle: rawTitle, imageBase64: originalImageBase64, croppedImageBase64, route: 'lens-card-jp-vote', productName: `${vote.nameEN} ${vote.number || ''} (JP)`, lensProductName: productName, ebayQuery: voteQuery, resultType: mp ? 'CARD_RESULT' : 'NO_DATA', marketPrice: mp, askingPrice: sellerPrice, verdict: v, ebaySalesCount: result.ebay_sales_count ?? 0, lensMatches: lensMatchTitles, lensSelected: vote.selectedTitle, ebayResults: ebayTopResults, langToggle: language });

          // Flag when JP toggle couldn't find a JP-specific number (fell back to EN/FR promo)
          const langMismatch = vote.isPromo ? 'EN promo — JP version not found' : null;
          if (langMismatch) console.log(`[Lakkot] JP lang mismatch: ${vote.number} is a promo code, not a JP set number`);

          return res.json({
            type: 'CARD_RESULT',
            ...result,
            card_name: vote.nameEN,
            card_name_fr: vote.nameFR,
            set_name: vote.set ? `${vote.set.name} (${vote.set.series})` : result.set_name || '',
            ebay_sales_count: result.ebay_sales_count ?? 0,
            identified_by: 'lens-jp-vote',
            lang_mismatch: langMismatch,
            pokemon_votes: vote.votes,
            quota,
            scanLogId: logId,
          });
        }
      }

      // === FR toggle: vote-based Pokemon identification ===
      if (language === 'FR' && lensResult?.visualMatches) {
        const vote = extractPokemonFromMatches(lensResult.visualMatches, 'FR');
        if (vote) {
          // Use French name for eBay query — French cards are listed with FR names on eBay France
          const voteQuery = vote.number
            ? `${vote.nameFR} ${vote.number}`
            : `${vote.nameFR} carte pokemon`;
          console.log(`[Lakkot] FR vote query: "${voteQuery}" (${vote.nameEN} / ${vote.nameFR}, number: ${vote.number})`);

          // eBay sold price — search with FR language filter
          const result = await handleAnalyze({ imageBase64, streamTitle: voteQuery, sellerPrice, mode: 'cards', manualCardOverride: voteQuery, language: 'FR', dateRange });
          const mp = result.market_price_usd ?? result.ebay_market_price ?? null;
          const v = mp && sellerPrice ? (sellerPrice / mp < 0.90 ? 'DEAL' : sellerPrice / mp > 1.10 ? 'OVER' : 'FAIR') : 'NO_DATA';

          const lensMatchTitles = (lensResult.visualMatches || []).slice(0, 15).map(m => m.title || '');
          const ebayTopResults = (result.listings || []).slice(0, 10).map(l => ({ title: l.title, price: l.price, soldDate: l.soldDate || null }));
          const logId = await logScan({ userEmail: scanUser?.email, userName: scanUser?.name, domTitle: rawTitle, imageBase64: originalImageBase64, croppedImageBase64, route: 'lens-card-fr-vote', productName: `${vote.nameFR} ${vote.number || ''}`, lensProductName: productName, ebayQuery: voteQuery, resultType: mp ? 'CARD_RESULT' : 'NO_DATA', marketPrice: mp, askingPrice: sellerPrice, verdict: v, ebaySalesCount: result.ebay_sales_count ?? 0, lensMatches: lensMatchTitles, lensSelected: vote.selectedTitle, ebayResults: ebayTopResults, langToggle: language });

          return res.json({
            type: 'CARD_RESULT',
            ...result,
            card_name: vote.nameFR,
            card_name_fr: vote.nameFR,
            set_name: vote.set ? `${vote.set.name} (${vote.set.series})` : result.set_name || '',
            ebay_sales_count: result.ebay_sales_count ?? 0,
            identified_by: 'lens-fr-vote',
            pokemon_votes: vote.votes,
            quota,
            scanLogId: logId,
          });
        }
      }

      // Clean Lens product name — strip YouTube/article titles, domain names
      const cleanLensName = productName
        ? productName
            .replace(/\s*[:|\-–—]\s*(pourquoi|comment|top|best|how|why|watch|review|unboxing|is this|is my|are these).*/i, '') // YouTube/Reddit titles
            .replace(/\s*:\s*r\/\w+.*$/i, '')  // Reddit subreddit references
            .replace(/\s*\|\s*.+$/, '')  // "Product | Site Name"
            .replace(/\s*-\s*(amazon|ebay|fnac|rakuten|cdiscount|reddit|fandom|wiki).*$/i, '') // site suffixes
            .replace(/\.(com|fr|co\.uk|de|net)\s*$/i, '') // domain extensions
            .replace(/\b(legit|fake|real|authentic|counterfeit)\b/gi, '') // authentication questions
            .replace(/\b(r\/\w+)\b/gi, '') // subreddit refs
            .replace(/\b(jual|beli|shopee|tokopedia|bukalapak|lazada)\b/gi, '') // Indonesian marketplace noise
            .replace(/\s+/g, ' ')
            .trim()
        : null;

      // Check if Lens identified a card
      if (cleanLensName && isTCGCard(cleanLensName)) {
        // Strip grading keywords from Lens product name — Lens often finds graded listings
        // but the card on stream is typically raw
        const cleanedName = cleanLensName
          .replace(/\b(psa|cgc|bgs|sgc|beckett|pca|hga|ccc|collectaura|collect aura)\s*\d*\b/gi, '')
          .replace(/\b(graded|slab|slabbed|gem mint|gem mt|gold label|silver label|black label)\b/gi, '')
          .replace(/\b(grad[ée]+e?|carte grad[ée]+e?|cartes grad[ée]+e?s?)\b/gi, '')
          .replace(/\bcarte\s+pok[ée]mon\b/gi, '')
          .replace(/\bpok[ée]mon\s+carte\b/gi, '')
          .replace(/\bcartes?\s+promo\b/gi, '')
          .replace(/\bblack\s+star\b/gi, '')
          .replace(/\bcarte[s]?\s+/gi, '')
          .replace(/\bpok[ée]mon\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        console.log('[Lakkot] Unified: Lens identified card →', productName, '→ cleaned:', cleanedName);
        const result = await handleAnalyze({ imageBase64, streamTitle: cleanedName, sellerPrice, mode: 'cards', manualCardOverride: cleanedName, language, dateRange });
        const mp = result.market_price_usd ?? result.ebay_market_price ?? null;
        const v = mp && sellerPrice ? (sellerPrice / mp < 0.90 ? 'DEAL' : sellerPrice / mp > 1.10 ? 'OVER' : 'FAIR') : 'NO_DATA';
        const lensMatchTitles2 = (lensResult.visualMatches || []).slice(0, 15).map(m => m.title || '');
        const ebayTopResults2 = (result.listings || []).slice(0, 10).map(l => ({ title: l.title, price: l.price, soldDate: l.soldDate || null }));
        const logId = await logScan({ userEmail: scanUser?.email, userName: scanUser?.name, domTitle: rawTitle, imageBase64: originalImageBase64, croppedImageBase64, route: 'lens-card', productName: result.card_name, lensProductName: productName, ebayQuery: result.ebay_search, resultType: mp ? 'CARD_RESULT' : 'NO_DATA', marketPrice: mp, askingPrice: sellerPrice, verdict: v, ebaySalesCount: result.ebay_sales_count ?? 0, lensMatches: lensMatchTitles2, lensSelected: productName, ebayResults: ebayTopResults2, langToggle: language });
        return res.json({ type: 'CARD_RESULT', ...result, ebay_sales_count: result.ebay_sales_count ?? 0, identified_by: 'lens', quota, scanLogId: logId });
      }

      // Route 3: Non-card → Google Shopping for retail/resale pricing.
      // Items with a detectable style code (sneakers) get the precise path:
      // confident ID from Lens visual matches → "brand model sku" query →
      // results filtered to the style code. Everything else keeps the
      // original loose-title behavior, so non-sneaker items are not regressed.
      let shoppingResult = { cards: [], medianPrice: null, totalFound: 0 };
      let lowConfidence = false;
      const identity = buildIdentity(lensResult?.visualMatches || []);
      if (identity.confident) {
        const skuQuery = buildShoppingQuery(identity);
        console.log('[Lakkot] Unified: style-code ID', identity.styleCode, '(score', identity.score + ') → query:', skuQuery);
        try {
          const raw1 = await handleGoogleShopping(skuQuery);
          let basket = filterBySku(raw1.cards, identity.styleCode);
          // Fallback: if the precise query yielded too few SKU matches, retry with
          // a broader "brand + sku" query and pool the unique results. This is the
          // resilience layer against Google Lens / Shopping result variance.
          if (basket.length < 2 && identity.brand && identity.styleCode) {
            const fallbackQuery = `${identity.brand} ${identity.styleCode}`;
            console.log('[Lakkot] Unified: thin basket — fallback query →', fallbackQuery);
            const raw2 = await handleGoogleShopping(fallbackQuery);
            const more = filterBySku(raw2.cards, identity.styleCode);
            const seen = new Set(basket.map((c) => c.title));
            for (const c of more) if (!seen.has(c.title)) { basket.push(c); seen.add(c.title); }
            console.log('[Lakkot] Unified: pooled basket size', basket.length);
          }
          // Retailer augment: SKU-only filtering biases toward marketplaces
          // (eBay sellers consistently put style codes in titles; major retailers
          // don't). To surface Nike / Foot Locker / JD Sports / Zalando / etc.,
          // run a second query built from the consensus product name (word vote
          // across Lens match titles) and keep results from non-marketplace
          // sources only. Adds source diversity to the SKU-precise basket.
          const phrase = extractCommonPhrase(lensResult?.visualMatches || []);
          if (phrase && identity.brand) {
            const nameQuery = `${identity.brand} ${phrase}`;
            console.log('[Lakkot] Unified: retailer-augment query →', nameQuery);
            try {
              const raw3 = await handleGoogleShopping(nameQuery);
              const retailers = (raw3.cards || []).filter((c) => !isMarketplace(c.source));
              const seenTitles = new Set(basket.map((c) => c.title));
              let added = 0;
              for (const c of retailers) {
                if (!seenTitles.has(c.title)) { basket.push(c); seenTitles.add(c.title); added++; }
              }
              console.log('[Lakkot] Unified: retailer augment added', added, '→ basket now', basket.length);
            } catch (err) {
              console.error('[Lakkot] Unified: retailer-augment error:', err.message);
            }
          }
          if (basket.length >= 1) {
            shoppingResult = { cards: basket, medianPrice: medianOf(basket), totalFound: basket.length };
            console.log('[Lakkot] Unified: final basket', basket.length, 'median=' + shoppingResult.medianPrice);
          } else {
            lowConfidence = true;
            console.log('[Lakkot] Unified: 0 matches even after all fallbacks — honest no-data');
          }
        } catch (err) {
          console.error('[Lakkot] Unified: SKU shopping error:', err.message);
        }
      } else {
        const shoppingQuery = cleanLensName || productName;
        if (shoppingQuery) {
          try {
            shoppingResult = await handleGoogleShopping(shoppingQuery);
            console.log('[Lakkot] Unified: Google Shopping (loose)', shoppingResult.cards.length, 'results, median=' + shoppingResult.medianPrice);
          } catch (err) {
            console.error('[Lakkot] Unified: Google Shopping error:', err.message);
          }
        }
      }

      // Prefer Shopping (more results, better median) over Lens visual matches.
      // When a confident style code yielded too few SKU matches, do NOT fall
      // back to the unreliable Lens-priced matches — return an honest null median.
      const usesShopping = shoppingResult.cards.length > 0;
      const finalCards = lowConfidence ? [] : (usesShopping ? shoppingResult.cards : (lensResult?.cards ?? []));
      const medianPrice = lowConfidence ? null : (shoppingResult.medianPrice ?? lensResult?.medianPrice ?? null);
      const webRoute = !productName ? 'lens-failed' : usesShopping ? 'lens-web-shopping' : 'lens-web-fallback';
      const webVerdict = medianPrice && sellerPrice ? (sellerPrice / medianPrice < 0.90 ? 'DEAL' : sellerPrice / medianPrice > 1.10 ? 'OVER' : 'FAIR') : 'NO_DATA';
      const lensMatchTitles3 = (lensResult?.visualMatches || []).slice(0, 15).map(m => m.title || '');
      const logId = await logScan({ userEmail: scanUser?.email, userName: scanUser?.name, domTitle: rawTitle, imageBase64: originalImageBase64, croppedImageBase64, route: webRoute, productName, lensProductName: productName, resultType: medianPrice ? 'WEB_RESULT' : 'NO_DATA', marketPrice: medianPrice, askingPrice: sellerPrice, verdict: webVerdict, sourcesCount: finalCards.length, lensMatches: lensMatchTitles3, lensSelected: productName, langToggle: language });

      return res.json({
        type: 'WEB_RESULT',
        productName,
        cards: finalCards,
        medianPrice,
        sourcesCount: finalCards.length,
        pricesCount: finalCards.filter(c => c.hasPrice).length,
        sellerPrice,
        streamCurrency,
        priceSource: usesShopping ? 'shopping' : 'lens',
        totalFound: usesShopping ? shoppingResult.totalFound : (lensResult?.sourcesCount ?? 0),
        quota,
        scanLogId: logId,
      });
    } catch (err) {
      console.error('[Lakkot] Unified scan error:', err.message);
      return res.json({ type: 'WEB_RESULT', productName: null, cards: [], medianPrice: null, sourcesCount: 0, pricesCount: 0, sellerPrice: null, streamCurrency: 'EUR', priceSource: 'lens', _error: err.message, quota });
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
    const month = currentMonth();
    const scanCount = (!user.scan_reset_at || user.scan_reset_at.slice(0, 7) !== month) ? 0 : user.scan_count;
    const limit = user.scan_limit_override ?? (PLAN_LIMITS[user.plan] ?? PLAN_LIMITS.free);
    quota = { email: user.email, remaining: Math.max(0, limit - scanCount), limit };
  } else if (token) {
    const { data: user } = await supabase.from('users').select('email, plan, scan_count, scan_reset_at, scan_limit_override').eq('token', token).single();
    if (user) {
      const month = currentMonth();
      const scanCount = (!user.scan_reset_at || user.scan_reset_at.slice(0, 7) !== month) ? 0 : user.scan_count;
      const limit = user.scan_limit_override ?? (PLAN_LIMITS[user.plan] ?? PLAN_LIMITS.free);
      quota = { email: user.email, remaining: Math.max(0, limit - scanCount), limit };
    }
  }

  try {
    let result;
    if (type === 'analyze') {
      result = await handleAnalyze(params);
    } else if (type === 'manual') {
      result = await handleManualLookup(params.cardName, params.language);
      // TCGPlayer for EN manual lookups
      if (params.language === 'EN' && result.card_name && result.card_number) {
        try {
          const tcgCard = { card_name: result.card_name, card_number: result.card_number, set_name: '', condition: 'Near Mint' };
          const tcgData = await fetchPokemonTCG(tcgCard);
          if (tcgData?.market_price_usd) {
            result.tcg_market_price = tcgData.market_price_usd;
            result.tcg_url = tcgData.tcg_url ?? null;
          }
        } catch (e) { console.warn('[Lakkot] TCG manual failed:', e.message); }
      }
      // Log manual lookup
      const manualUser = token ? (await supabase.from('users').select('email, name').eq('token', token).single()).data : null;
      const mp = result.market_price_usd ?? result.ebay_market_price ?? null;
      const v = mp ? 'NO_DATA' : 'NO_DATA'; // manual lookups don't have asking price for verdict
      if (mp) {
        const askP = result.seller_asking_price ?? null;
        const verdict = mp && askP ? (askP / mp < 0.90 ? 'DEAL' : askP / mp > 1.10 ? 'OVER' : 'FAIR') : 'NO_DATA';
        await logScan({ userEmail: manualUser?.email, userName: manualUser?.name, domTitle: params.cardName, route: 'manual-lookup', productName: result.card_name, ebayQuery: result.ebay_search ?? params.cardName, resultType: mp ? 'CARD_RESULT' : 'NO_DATA', marketPrice: mp, verdict, ebaySalesCount: result.ebay_sales_count ?? 0, langToggle: params.language });
      } else {
        await logScan({ userEmail: manualUser?.email, userName: manualUser?.name, domTitle: params.cardName, route: 'manual-lookup', productName: result.card_name, ebayQuery: params.cardName, resultType: 'NO_DATA', verdict: 'NO_DATA', langToggle: params.language });
      }
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
