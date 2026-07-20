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

// Base prompt. Lens context titles are appended by buildPrompt() when
// available — they act as a consensus check that catches Gemini's
// variant-level errors on subtle products (a "Rolex 41" scanned but ID'd
// as "36mm", a "Funko #78" ID'd as "#01"). The prompt tells Gemini to
// prefer whichever variant / size / number the Lens titles agree on.
const BASE_PROMPT = [
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
  "- CRUCIAL sur les variantes (taille en mm/ml, numéro dans une série #NN,",
  "  référence catalogue, année) : si des titres de vendeurs sont fournis en",
  "  contexte ci-dessous, PRIVILÉGIE le variant qui apparaît le plus souvent",
  "  dans ces titres plutôt que ta propre estimation visuelle (une Rolex 41mm",
  "  et une 36mm se ressemblent, un Funko #01 et un #78 aussi — le consensus",
  "  textuel des vendeurs est plus fiable que le pixel-matching sur ces cas).",
  "",
  "Règles SPÉCIFIQUES coins_money :",
  '- coin_year_readable et coin_mintmark_readable : mets false et laisse le champ',
  "  vide si tu n'es pas SÛR à 100% que le chiffre est lisible sur l'image.",
  "  Une année inventée est PIRE qu'une année absente (la cascade de recherche",
  "  eBay part directement en query générique quand year_readable=false).",
  '- coin_weight_grams et coin_fineness : uniquement si tu connais les',
  "  caractéristiques standard du type précis (ex : 10 francs Hercule 1965-1973",
  '  = 25g / 0.900). Sinon mets null / null.',
  '- coin_metal : "silver", "gold", "base" (cuivre/nickel/laiton/euro courant),',
  '  ou "unknown" si non identifiable.',
  '- coin_graded / coin_grade_visible : true UNIQUEMENT si la pièce est visiblement',
  "  sous coque de grading (PCGS, NGC, coque plastique avec code de grade lisible).",
  "  NE TENTE JAMAIS d'évaluer TB/SUP/FDC depuis l'image d'une pièce brute — ",
  "  c'est le rôle des ventes eBay filtrées par mots-clés d'état, pas le tien.",
].join('\n');

// Prepend the Lens titles as a "seller context" block so Gemini can vote
// on ambiguous variants (see the "CRUCIAL sur les variantes" rule). We
// keep at most 15 titles (matching the Lens slice we use elsewhere) and
// bail out cleanly when none are provided so the pure-image path still
// works.
//
// Ordering matters: the matches are ranked by visual similarity, top =
// closest to the scanned image. Earlier prompt wording treated all 15
// as equal-weight context, which let Gemini prefer well-known brands
// (Tronsmart) it happened to recognize over lesser-known brands (FASR)
// that Lens correctly surfaced in position #2. The rules below force
// the top-3 to be respected when they carry a specific brand + model.
function buildPrompt(lensTitles) {
  if (!Array.isArray(lensTitles) || lensTitles.length === 0) {
    return BASE_PROMPT;
  }
  const cleaned = lensTitles
    .map(t => (typeof t === 'string' ? t : (t?.title || '')))
    .filter(t => t && t.length > 0)
    .slice(0, 15);
  if (cleaned.length === 0) return BASE_PROMPT;
  const contextBlock = [
    "",
    "CONTEXTE — titres de vendeurs / retailers qui montrent des produits",
    "visuellement similaires, ORDONNÉS par similarité visuelle DÉCROISSANTE",
    "(le #1 est le plus proche de l'image que tu vois, le #15 le plus lointain).",
    "",
    "RÈGLES d'utilisation OBLIGATOIRES — dans cet ordre de priorité :",
    "",
    "0. ANCRAGE CATÉGORIEL — PRIORITÉ ABSOLUE.",
    "   Regarde le TYPE de produit dans les 5 premiers matches. La",
    "   catégorie DOMINANTE (celle qui revient le plus) est la catégorie",
    "   visuelle de l'image scannée.",
    "   Le produit identifié DOIT appartenir à cette catégorie dominante.",
    "   Un match d'une AUTRE catégorie (même s'il a une marque claire,",
    "   même s'il est en position 6 ou 7) est du bruit et doit être",
    "   IGNORÉ. C'est la règle la plus importante.",
    "",
    "   Exemple concret : top 5 = 4× 'Enceinte Bluetooth' + 1× 'Boîte",
    "   repas chauffante Tristar'. La catégorie dominante est ENCEINTE.",
    "   La boîte repas est du bruit → à ignorer même si Tristar est",
    "   une marque connue.",
    "",
    "1. Une fois la catégorie ancrée, PRÉFÈRE dans le top 3 (puis top 5)",
    "   tout match qui contient une référence produit spécifique — soit",
    "   marque + modèle ('JBL Charge 5', 'Sony WH-1000XM4'), soit modèle",
    "   seul même sans marque explicite ('V11', 'Bang 2', 'AF400EU').",
    "   Un modèle numéroté est un signal fort de la vraie référence,",
    "   même quand tu ne connais pas la marque associée.",
    "",
    "2. Si le top 3 ne contient que des titres 100% génériques (aucun",
    "   modèle numéroté, aucune marque, ex uniquement 'Enceinte Bluetooth",
    "   - Photo, audio & vidéo'), regarde les matches #4-8 en gardant",
    "   l'ancrage catégoriel de la Règle 0.",
    "",
    "3. N'invente JAMAIS spontanément le nom d'une marque simplement",
    "   parce que tu la connais mieux. Si la marque n'apparaît pas dans",
    "   les matches, ne la mets pas dans product_name.",
    "",
    "4. Les catégories/breadcrumbs de plateformes ('Photo, audio & vidéo',",
    "   'Téléphones & Objets connectés', 'Accessoires téléphone') servent",
    "   à confirmer la catégorie mais ne sont PAS des produits.",
    "",
    "Matches (ordonnés par similarité) :",
    ...cleaned.map((t, i) => `  ${i + 1}. ${t}`),
  ].join('\n');
  return BASE_PROMPT + '\n' + contextBlock;
}

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
    // Coin-specific fields — only meaningful when category === "coins_money".
    // For any other category Gemini returns empty strings / null and downstream
    // code ignores them. Kept as required so the schema stays stable.
    coin_country:          { type: 'STRING' },
    coin_denomination:     { type: 'STRING' },
    coin_type:             { type: 'STRING' },
    coin_year:             { type: 'STRING' },
    coin_year_readable:    { type: 'BOOLEAN' },
    coin_mintmark:         { type: 'STRING' },
    coin_mintmark_readable:{ type: 'BOOLEAN' },
    coin_metal:            { type: 'STRING' },
    // NUMBER fields can't be null in Gemini schema — sentinel 0 = "unknown"
    // for weight and fineness. Consumer treats 0 as null.
    coin_weight_grams:     { type: 'NUMBER' },
    coin_fineness:         { type: 'NUMBER' },
    coin_graded:           { type: 'BOOLEAN' },
    coin_grade_visible:    { type: 'STRING' },
  },
  required: [
    'category', 'brand', 'product_name', 'variant', 'display_title',
    'query_shopping', 'query_ebay', 'confidence',
    'estimated_price_min', 'estimated_price_max', 'price_confidence',
    'coin_country', 'coin_denomination', 'coin_type', 'coin_year',
    'coin_year_readable', 'coin_mintmark', 'coin_mintmark_readable',
    'coin_metal', 'coin_weight_grams', 'coin_fineness',
    'coin_graded', 'coin_grade_visible',
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
  const nOrNull = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const conf = (v) => Math.max(0, Math.min(1, n(v, 0)));
  const b = (v) => v === true || v === 'true';

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
    // Coin fields — filled by Gemini only for category === "coins_money".
    // Consumer treats empty strings / false / null as "not applicable".
    coin_country:           s(obj.coin_country),
    coin_denomination:      s(obj.coin_denomination),
    coin_type:              s(obj.coin_type),
    coin_year:              s(obj.coin_year),
    coin_year_readable:     b(obj.coin_year_readable),
    coin_mintmark:          s(obj.coin_mintmark),
    coin_mintmark_readable: b(obj.coin_mintmark_readable),
    coin_metal:             s(obj.coin_metal).toLowerCase(),   // "silver"|"gold"|"base"|"unknown"|""
    coin_weight_grams:      nOrNull(obj.coin_weight_grams),
    coin_fineness:          nOrNull(obj.coin_fineness),
    coin_graded:            b(obj.coin_graded),
    coin_grade_visible:     s(obj.coin_grade_visible),
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

  // Cache key includes both the image AND the lens titles: a rescan with
  // fresh Lens context should re-run Gemini so the consensus check runs
  // on the new titles, not on a stale cached identity.
  const lensTitles = Array.isArray(opts.lensTitles) ? opts.lensTitles : [];
  const cacheKey = hashImage(imageBase64) + '|' + lensTitles.slice(0, 5).join('|').slice(0, 200);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const t0 = Date.now();
  const promptText = buildPrompt(lensTitles);
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: promptText },
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
