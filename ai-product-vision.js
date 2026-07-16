'use strict';
// Gemini Vision pipeline for non-TCG / non-sneaker items.
//
// Live shopping screenshots (Whatnot, Voggt) are often blurry, partial, and
// covered by app overlays — Google Lens visual matching fails silently on
// this content (returns "similar-looking cousins" instead of the actual
// product). For anything that isn't a TCG card or a sneaker with a style
// code, we skip Lens entirely and ask Gemini Vision to identify the product
// AND give a rough EUR price band in a single call.
//
// This module is deliberately isolated: server.js calls identifyProductVision
// only from the "Other" branch of the unified scan, only when the feature
// flag USE_GEMINI_PIPELINE=true. Any failure here → caller falls back to the
// legacy Lens+Shopping path. No downstream code depends on this succeeding.
//
// Cost ≈ €0.0003/scan (Flash Vision, 1 image + short prompt in, small JSON
// out). Latency ≈ 800–1500ms. Cache by image hash to dedupe rescan spam.

const MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
const FETCH_TIMEOUT_MS = 8000;      // spec: 8s max then fall back
const RETRY_ONCE_ON_5XX = true;     // spec: 1 retry on network / 5xx

// Feature flag — read at call time (not module load) so a Render env change
// takes effect on the next request without redeploy.
function isEnabled() {
  return String(process.env.USE_GEMINI_PIPELINE || '').toLowerCase() === 'true';
}

// ─── Prompt ──────────────────────────────────────────────────────────────
// Exact spec from the product brief. Keep the categories list in sync with
// the router in server.js — if we add "sports_card" here, server.js needs
// to know it maps to the TCG path (not the estimation path).
const CATEGORIES = [
  'tcg_card', 'sports_card', 'sneakers', 'fashion_women', 'fashion_men',
  'bags_accessories', 'jewelry_watches', 'toys_hobbies', 'coins_money',
  'electronics', 'antiques_vintage', 'art_crafts', 'sports_equipment',
  'outdoors_hunting', 'stones_crystals', 'beauty', 'baby_kids',
  'home_garden', 'food_drinks', 'other',
];

const SYSTEM_PROMPT = [
  "Tu es un expert en produits de collection et d'occasion vendus en live shopping",
  "(Whatnot, Voggt). On te montre un screenshot d'un live de vente, souvent flou,",
  "avec parfois des overlays d'interface par-dessus le produit.",
  "",
  "Identifie le produit principal visible et réponds UNIQUEMENT avec un JSON valide,",
  "sans markdown, sans texte autour, respectant exactement ce schéma :",
  "",
  "{",
  '  "category": string,          // une valeur de la liste CATEGORIES ci-dessous',
  '  "brand": string,             // marque ou éditeur, "" si inconnue',
  '  "product_name": string,      // nom précis du produit',
  '  "variant": string,           // couleur, taille, édition, année, référence... "" si non identifiable',
  '  "display_title": string,     // titre court et vendeur pour l\'UI, en français, max 60 caractères',
  '  "query_shopping": string,    // requête Google Shopping optimale (marque + modèle + variante), en français',
  '  "query_ebay": string,        // requête eBay optimale : COURTE, mots que les vendeurs mettent dans leurs titres, marque OBLIGATOIRE si connue',
  '  "confidence": number,        // 0 à 1 : ta certitude sur l\'identification',
  '  "estimated_price_min": number,  // fourchette basse en EUR, marché de l\'occasion/collection',
  '  "estimated_price_max": number,  // fourchette haute en EUR',
  '  "price_confidence": number   // 0 à 1 : si tu ne connais pas ce produit précis, mets < 0.3',
  "}",
  "",
  "CATEGORIES possibles (taxonomie Whatnot) :",
  '"tcg_card"           → cartes Pokémon, One Piece, Magic, Yu-Gi-Oh...',
  '"sports_card"        → cartes de sport (foot, NBA, PSA...)',
  '"sneakers"           → sneakers et chaussures',
  '"fashion_women"      → mode femme (vêtements)',
  '"fashion_men"        → mode homme (vêtements)',
  '"bags_accessories"   → sacs, maroquinerie, accessoires',
  '"jewelry_watches"    → bijoux et montres',
  '"toys_hobbies"       → jouets, figurines, Funko, LEGO, peluches',
  '"coins_money"        → pièces de monnaie, billets, numismatique',
  '"electronics"        → électronique, consoles, audio',
  '"antiques_vintage"   → antiquités et décoration vintage',
  '"art_crafts"         → art et artisanat',
  '"sports_equipment"   → articles de sport',
  '"outdoors_hunting"   → plein air, chasse, couteaux',
  '"stones_crystals"    → pierres et cristaux',
  '"beauty"             → beauté, cosmétiques',
  '"baby_kids"          → bébé et enfant',
  '"home_garden"        → maison et jardin',
  '"food_drinks"        → aliments et boissons',
  '"other"              → tout le reste',
  "",
  "Règles :",
  '- Si la catégorie est "tcg_card" ou "sneakers", remplis quand même tout le JSON',
  "  (le routage se fera côté application).",
  '- Pour "coins_money" : précise pays, année, dénomination, atelier dans variant.',
  '- Pour "jewelry_watches" : précise matière, marque, référence si lisible.',
  '- Pour "toys_hobbies" : précise fabricant (Banpresto, Funko...), licence, gamme.',
  '- Pour "bags_accessories" : précise ligne/modèle, matière, coloris.',
  "- La fourchette de prix concerne le marché de l'OCCASION en Europe, pas le neuf,",
  "  sauf pour les produits encore en retail courant.",
  "- Ne JAMAIS inventer une référence précise : si tu hésites entre deux modèles,",
  "  choisis le plus probable et baisse confidence en conséquence.",
].join('\n');

// ─── JSON schema (Gemini responseSchema) ─────────────────────────────────
// Forces structured output — Gemini fills each field. String fields default
// to "" (not null) so downstream can format without null checks.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category:              { type: 'STRING', enum: CATEGORIES },
    brand:                 { type: 'STRING' },
    product_name:          { type: 'STRING' },
    variant:               { type: 'STRING' },
    display_title:         { type: 'STRING' },
    query_shopping:        { type: 'STRING' },
    query_ebay:            { type: 'STRING' },
    confidence:            { type: 'NUMBER' },
    estimated_price_min:   { type: 'NUMBER' },
    estimated_price_max:   { type: 'NUMBER' },
    price_confidence:      { type: 'NUMBER' },
  },
  required: [
    'category', 'brand', 'product_name', 'variant', 'display_title',
    'query_shopping', 'query_ebay', 'confidence',
    'estimated_price_min', 'estimated_price_max', 'price_confidence',
  ],
};

// ─── Cache ───────────────────────────────────────────────────────────────
// Same image (byte-identical) scanned twice in a row = same identity. Cheap
// FNV-ish hash on a prefix of the base64; collisions are harmless because
// worst case is we make an extra Gemini call.
const CACHE = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 200;

function hashImage(base64) {
  const s = String(base64 || '');
  const sample = s.length > 4096 ? s.slice(0, 2048) + s.slice(-2048) : s;
  let h = 0;
  for (let i = 0; i < sample.length; i++) h = ((h << 5) - h + sample.charCodeAt(i)) | 0;
  return String(h) + ':' + s.length;
}

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > CACHE_TTL_MS) { CACHE.delete(key); return null; }
  return hit.identity;
}
function cacheSet(key, identity) {
  if (CACHE.size >= CACHE_MAX) {
    // FIFO — delete oldest 20 entries
    let i = 0;
    for (const k of CACHE.keys()) { CACHE.delete(k); if (++i >= 20) break; }
  }
  CACHE.set(key, { identity, fetchedAt: Date.now() });
}

// ─── Validation ──────────────────────────────────────────────────────────
// Gemini follows responseSchema most of the time, but we validate anyway.
// Missing critical fields → return null → caller falls back to legacy path.
function validate(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const category = typeof obj.category === 'string' ? obj.category : null;
  const productName = typeof obj.product_name === 'string' ? obj.product_name.trim() : '';
  // Critical fields per spec: category + product_name. Without those we
  // can't route or display — reject and let the fallback take over.
  if (!category || !CATEGORIES.includes(category)) return null;
  if (!productName) return null;

  const n = (v, def = 0) => (typeof v === 'number' && isFinite(v) ? v : def);
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const conf = (v) => Math.max(0, Math.min(1, n(v, 0)));

  return {
    category,
    brand:               s(obj.brand),
    product_name:        productName,
    variant:             s(obj.variant),
    display_title:       s(obj.display_title).slice(0, 60),  // spec: max 60 chars
    query_shopping:      s(obj.query_shopping),
    query_ebay:          s(obj.query_ebay),
    confidence:          conf(obj.confidence),
    estimated_price_min: n(obj.estimated_price_min, 0),
    estimated_price_max: n(obj.estimated_price_max, 0),
    price_confidence:    conf(obj.price_confidence),
    _model: MODEL,
    _source: 'gemini_vision',
  };
}

// ─── Main entry ──────────────────────────────────────────────────────────
// imageBase64: bare base64 string (no data:image/... prefix)
// Returns validated identity object or null on any failure.
async function identifyProductVision(imageBase64, opts = {}) {
  if (!isEnabled()) return null;
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[Lakkot vision] GEMINI_API_KEY missing');
    return null;
  }
  if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.length < 100) {
    return null;
  }

  const cacheKey = hashImage(imageBase64);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const t0 = Date.now();
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: SYSTEM_PROMPT },
        { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY };

  async function attempt() {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      clearTimeout(to);
      return res;
    } finally {
      clearTimeout(to);
    }
  }

  let res;
  try {
    res = await attempt();
    // Retry once on 5xx or timeout
    if (RETRY_ONCE_ON_5XX && res.status >= 500) {
      console.warn('[Lakkot vision] first attempt', res.status, '— retrying once');
      res = await attempt();
    }
  } catch (err) {
    console.warn('[Lakkot vision] fetch error:', err.message);
    // Retry on abort/timeout
    if (RETRY_ONCE_ON_5XX && (err.name === 'AbortError' || /network|fetch failed/i.test(err.message))) {
      try { res = await attempt(); } catch (e2) {
        console.error('[Lakkot vision] retry also failed:', e2.message);
        return null;
      }
    } else {
      return null;
    }
  }

  if (!res || !res.ok) {
    const txt = res ? await res.text().catch(() => '') : '(no response)';
    console.error('[Lakkot vision] HTTP', res?.status, '—', txt.slice(0, 300));
    return null;
  }

  let data;
  try { data = await res.json(); } catch (e) {
    console.error('[Lakkot vision] JSON parse error:', e.message);
    return null;
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    console.error('[Lakkot vision] no text in Gemini response');
    return null;
  }

  let parsed;
  try { parsed = JSON.parse(rawText); } catch (e) {
    console.error('[Lakkot vision] Gemini returned non-JSON:', rawText.slice(0, 200));
    return null;
  }

  const identity = validate(parsed);
  if (!identity) {
    console.warn('[Lakkot vision] validation failed for parsed:', JSON.stringify(parsed).slice(0, 300));
    return null;
  }

  identity._latencyMs = Date.now() - t0;
  identity._raw = parsed;   // kept for logging; caller can strip before responding to client
  cacheSet(cacheKey, identity);
  return identity;
}

module.exports = { identifyProductVision, isEnabled, CATEGORIES };
