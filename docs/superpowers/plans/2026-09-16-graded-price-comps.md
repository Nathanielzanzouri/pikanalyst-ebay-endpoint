# Graded Price Comps (PSA 10 / PSA 9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a raw Pokémon card scan, show the raw price instantly, then fetch and display the same card's resale median for PSA 10 and PSA 9 asynchronously.

**Architecture:** A new backend follow-up endpoint `POST /scan/graded-prices` reuses the existing eBay Browse graded-query infrastructure (`fetchEbayBrowse` + `makeGradedTitleFilter`) to run two strict single-tier queries (PSA 10, PSA 9) in parallel, bypassing all caches to avoid poisoning the raw sold-history cache. The pure query/format logic lives in a new isolated module `graded-prices.js` (unit-tested). The extension and web app call this endpoint after the raw result renders and fill in two lines. A premium gate exists from day one but defaults OFF (free for testing).

**Tech Stack:** Node.js/Express (`ebay-endpoint/server.js`), `node --test` unit tests, Supabase (users plan for the gate), Chrome extension vanilla JS (`pikanalyst-extension/src/sidepanel.js`), web app on Lovable (prompt handoff).

**Spec:** `docs/superpowers/specs/2026-09-16-graded-price-comps-design.md`

---

## File Structure

- **Create** `graded-prices.js` — pure helpers `buildGradedCard()`, `formatGradedResult()`, and the injectable orchestrator `fetchGradedPrices()`. No `require('./server')` (avoid circular import); eBay calls are injected.
- **Create** `test/graded-prices.test.js` — unit tests for the three functions (no network; fakes injected).
- **Modify** `server.js` — import `graded-prices`, add the `POST /scan/graded-prices` endpoint (near the existing `/scan/cardmarket` at line ~3977), wired to the real `getEbayOAuthToken` + `fetchEbayBrowse`, with the premium gate.
- **Modify** `pikanalyst-extension/src/sidepanel.js` (+ `sidepanel.html` / `sidepanel.css`) — after a raw Pokémon `CARD_RESULT` renders, POST to the endpoint and fill two lines (PSA 9 / PSA 10) with loading → value → "—" states.
- **Create** `docs/superpowers/plans/2026-09-16-graded-price-comps-lovable-prompt.md` — the copy-paste prompt for Lovable to implement the same display on the web app.

Reused unchanged: `fetchEbayBrowse` (query + `makeGradedTitleFilter` + median), `getEbayOAuthToken`, the EUR-normalised `market_price_usd` field. The `/scan` hot path and the card pipeline are NOT modified.

**Key facts anchored in current code:**
- `fetchEbayBrowse(card, token, language='WORLD', dateRange=30)` returns `{ market_price_usd (=median EUR), price_low_usd, price_high_usd, ebay_sales_count, listings, ... }` and applies `makeGradedTitleFilter(card._gradeFilter)`. It **throws** `'Browse: 0 results for all queries and markets'` when nothing matches. (`server.js:2283`, return block `server.js:2466`.)
- `buildBrowseQueries(card)` uses `card.ebay_search` first (`server.js:2050`) — so putting `"<name> <number> PSA 10"` in `ebay_search` makes the query target the grade; `_gradeFilter` then filters titles to that grade.
- Strict grade mode `makeGradedTitleFilter({company, grade})` keeps titles containing `"psa 10"` / `"psa10"` / `"psa-10"` (`server.js:703+`). No `pokemonName` needed for strict mode.
- `CARD_RESULT` responses already include `card_name` and `card_number` (`server.js:5959` and the `result` spread) — the front has the identity to call back with.
- Tests live in `test/`, style: `const test = require('node:test'); const assert = require('node:assert'); const {...} = require('../module');` (`test/price-stats.test.js`).

---

## Task 1: Pure helpers — `buildGradedCard` + `formatGradedResult`

**Files:**
- Create: `graded-prices.js`
- Test: `test/graded-prices.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/graded-prices.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildGradedCard, formatGradedResult } = require('../graded-prices');

// ─── buildGradedCard ────────────────────────────────────────────────────────
test('buildGradedCard: ebay_search combines name + number + grade', () => {
  const card = buildGradedCard('Dracaufeu', '223/197', 'PSA', '10');
  assert.strictEqual(card.ebay_search, 'Dracaufeu 223/197 PSA 10');
});

test('buildGradedCard: sets a strict _gradeFilter for the title filter', () => {
  const card = buildGradedCard('Pikachu', '58/102', 'PSA', '9');
  assert.deepStrictEqual(card._gradeFilter, { company: 'PSA', grade: '9', pokemonName: 'Pikachu' });
});

test('buildGradedCard: omits an empty card number cleanly (no double space)', () => {
  const card = buildGradedCard('Mewtwo', '', 'PSA', '10');
  assert.strictEqual(card.ebay_search, 'Mewtwo PSA 10');
});

// ─── formatGradedResult ─────────────────────────────────────────────────────
test('formatGradedResult: returns median + count when count >= threshold', () => {
  const r = formatGradedResult({ market_price_usd: 120, ebay_sales_count: 8 }, 2);
  assert.deepStrictEqual(r, { median: 120, count: 8, currency: 'EUR' });
});

test('formatGradedResult: nulls the median when count is below threshold', () => {
  const r = formatGradedResult({ market_price_usd: 120, ebay_sales_count: 1 }, 2);
  assert.deepStrictEqual(r, { median: null, count: 1, currency: 'EUR' });
});

test('formatGradedResult: handles a null browse result (no sales)', () => {
  const r = formatGradedResult(null, 2);
  assert.deepStrictEqual(r, { median: null, count: 0, currency: 'EUR' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/graded-prices.test.js`
Expected: FAIL — `Cannot find module '../graded-prices'`.

- [ ] **Step 3: Write the minimal implementation**

Create `graded-prices.js`:

```js
'use strict';

// Graded-price comps: given a raw card identity, build the eBay query for a
// specific grade (e.g. PSA 10) and normalise a fetchEbayBrowse result into a
// small {median, count} shape. Pure functions — no network, no server import.

// Build a card object for a single strict grade query. Putting the grade in
// ebay_search makes buildBrowseQueries target it; _gradeFilter makes the title
// filter keep only that grade (strict mode). Both together = a clean grade
// median, never mixed with other grades or raw.
function buildGradedCard(cardName, cardNumber, company, grade) {
  const name = String(cardName || '').trim();
  const num  = String(cardNumber || '').trim();
  const ebay_search = [name, num, `${company} ${grade}`].filter(Boolean).join(' ');
  return {
    card_name: name,
    card_number: num,
    ebay_search,
    _gradeFilter: { company, grade: String(grade), pokemonName: name },
  };
}

// Normalise a fetchEbayBrowse result (or null) into {median, count, currency}.
// market_price_usd is already EUR-normalised in this codebase. Below the
// confidence threshold (default 2 sales) we null the median so the front shows
// "—" instead of a price backed by a single sale.
function formatGradedResult(browseResult, minCount = 2) {
  const count  = (browseResult && browseResult.ebay_sales_count) || 0;
  const median = browseResult && browseResult.market_price_usd != null
    ? browseResult.market_price_usd
    : null;
  if (median == null || count < minCount) {
    return { median: null, count, currency: 'EUR' };
  }
  return { median, count, currency: 'EUR' };
}

module.exports = { buildGradedCard, formatGradedResult };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/graded-prices.test.js`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add graded-prices.js test/graded-prices.test.js
git commit -m "feat(graded-prices): pure helpers buildGradedCard + formatGradedResult"
```

---

## Task 2: Orchestrator — `fetchGradedPrices` (parallel, injectable, no cache)

**Files:**
- Modify: `graded-prices.js`
- Test: `test/graded-prices.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/graded-prices.test.js`:

```js
const { fetchGradedPrices, GRADES } = require('../graded-prices');

// A fake fetchEbayBrowse: returns a different sales count per grade, keyed off
// the grade string present in card.ebay_search. Records the queries it saw.
function makeFakeBrowse(byGrade, seen) {
  return async (card, _token, _lang) => {
    if (seen) seen.push(card.ebay_search);
    if (card.ebay_search.includes('PSA 10')) return byGrade.psa10;
    if (card.ebay_search.includes('PSA 9'))  return byGrade.psa9;
    return null;
  };
}
const okToken = async () => 'fake-token';

test('fetchGradedPrices: returns psa10 + psa9 medians from the browse fn', async () => {
  const browse = makeFakeBrowse({
    psa10: { market_price_usd: 120, ebay_sales_count: 8 },
    psa9:  { market_price_usd: 45,  ebay_sales_count: 12 },
  });
  const out = await fetchGradedPrices({
    cardName: 'Dracaufeu', cardNumber: '223/197', language: 'FR',
    getToken: okToken, browse,
  });
  assert.deepStrictEqual(out, {
    psa10: { median: 120, count: 8,  currency: 'EUR' },
    psa9:  { median: 45,  count: 12, currency: 'EUR' },
  });
});

test('fetchGradedPrices: runs one query per grade with the grade in the query', async () => {
  const seen = [];
  const browse = makeFakeBrowse({ psa10: null, psa9: null }, seen);
  await fetchGradedPrices({ cardName: 'Pikachu', cardNumber: '58/102', getToken: okToken, browse });
  assert.deepStrictEqual(seen.sort(), ['Pikachu 58/102 PSA 10', 'Pikachu 58/102 PSA 9']);
});

test('fetchGradedPrices: a browse throw for one grade nulls that grade only', async () => {
  const browse = async (card) => {
    if (card.ebay_search.includes('PSA 10')) throw new Error('Browse: 0 results');
    return { market_price_usd: 45, ebay_sales_count: 12 };
  };
  const out = await fetchGradedPrices({ cardName: 'Pikachu', cardNumber: '58/102', getToken: okToken, browse });
  assert.strictEqual(out.psa10.median, null);
  assert.strictEqual(out.psa9.median, 45);
});

test('fetchGradedPrices: a token failure nulls all grades without throwing', async () => {
  const browse = makeFakeBrowse({ psa10: { market_price_usd: 120, ebay_sales_count: 8 }, psa9: null });
  const out = await fetchGradedPrices({
    cardName: 'Pikachu', cardNumber: '58/102',
    getToken: async () => { throw new Error('oauth down'); }, browse,
  });
  assert.deepStrictEqual(out, {
    psa10: { median: null, count: 0, currency: 'EUR' },
    psa9:  { median: null, count: 0, currency: 'EUR' },
  });
});

test('GRADES: v1 targets PSA 10 and PSA 9', () => {
  assert.deepStrictEqual(GRADES, [
    { key: 'psa10', company: 'PSA', grade: '10' },
    { key: 'psa9',  company: 'PSA', grade: '9'  },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/graded-prices.test.js`
Expected: FAIL — `fetchGradedPrices`/`GRADES` are `undefined` (not exported yet).

- [ ] **Step 3: Extend the implementation**

In `graded-prices.js`, add above `module.exports`:

```js
// v1 grades. Add CGC/BGS or other grades here later without touching callers.
const GRADES = [
  { key: 'psa10', company: 'PSA', grade: '10' },
  { key: 'psa9',  company: 'PSA', grade: '9'  },
];

// Fetch the median for each grade in parallel. Dependencies are INJECTED
// (getToken, browse) so this is unit-testable without network and so the
// module never imports server.js (no circular dependency). browse is expected
// to be the real fetchEbayBrowse(card, token, language) — which does NOT touch
// the sold-history cache, so the raw cote is never polluted (spec §5).
async function fetchGradedPrices({
  cardName, cardNumber, language = 'WORLD',
  getToken, browse, minCount = 2, grades = GRADES,
}) {
  let token = null;
  try { token = await getToken(); }
  catch (_) { token = null; }

  const entries = await Promise.all(grades.map(async (g) => {
    if (!token) return [g.key, { median: null, count: 0, currency: 'EUR' }];
    try {
      const card = buildGradedCard(cardName, cardNumber, g.company, g.grade);
      const result = await browse(card, token, language);
      return [g.key, formatGradedResult(result, minCount)];
    } catch (_) {
      // fetchEbayBrowse throws on 0 results — that's a valid "no data" outcome.
      return [g.key, { median: null, count: 0, currency: 'EUR' }];
    }
  }));
  return Object.fromEntries(entries);
}
```

Then change the exports line to:

```js
module.exports = { GRADES, buildGradedCard, formatGradedResult, fetchGradedPrices };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/graded-prices.test.js`
Expected: PASS — 11 tests passing.

- [ ] **Step 5: Commit**

```bash
git add graded-prices.js test/graded-prices.test.js
git commit -m "feat(graded-prices): parallel injectable fetchGradedPrices orchestrator"
```

---

## Task 3: Wire the `POST /scan/graded-prices` endpoint (+ premium gate)

**Files:**
- Modify: `server.js` (import near line ~109 with the other module requires; endpoint after the `/scan/cardmarket` handler, which ends before `app.get('/card/history'` at line ~4148)

- [ ] **Step 1: Add the module import**

Find the block of `require('./...')` imports near the top of `server.js` (e.g. `const { fetchListingsForVision, ... } = require('./ai-product-listings');` at line ~109). Add on a new line right after it:

```js
const { fetchGradedPrices } = require('./graded-prices');
```

- [ ] **Step 2: Add the endpoint**

Immediately BEFORE the line `app.get('/card/history', async (req, res) => {` (line ~4148), insert:

```js
// ─── /scan/graded-prices — PSA 10 / PSA 9 comps for a raw card ────────────────
// Follow-up call: the front already showed the raw price; it now asks for the
// same card's graded resale medians. Two strict eBay Browse queries in parallel
// (PSA 10, PSA 9). No cache read/write (raw sold-history stays uncontaminated).
// Premium gate is OFF by default — flip GRADED_PRICES_PREMIUM_ONLY=true on Render
// to restrict to paid plans (30s, no deploy).
app.post('/scan/graded-prices', async (req, res) => {
  const { cardName, cardNumber, language, token } = req.body || {};
  if (!cardName) return res.status(400).json({ error: 'missing_card' });

  if (process.env.GRADED_PRICES_PREMIUM_ONLY === 'true') {
    const user = token
      ? (await supabase.from('users').select('plan').eq('token', token).single()).data
      : null;
    const paid = !!user && (user.plan === 'pro' || user.plan === 'power');
    if (!paid) return res.status(403).json({ error: 'upgrade_required' });
  }

  try {
    const prices = await fetchGradedPrices({
      cardName,
      cardNumber: cardNumber || '',
      language: language || 'WORLD',
      getToken: getEbayOAuthToken,
      browse: fetchEbayBrowse,
    });
    return res.json(prices);   // { psa10: {...}, psa9: {...} }
  } catch (err) {
    console.error('[Lakkot] graded-prices error:', err.message);
    return res.status(500).json({ error: 'graded_prices_failed' });
  }
});
```

- [ ] **Step 3: Syntax check**

Run: `node --check server.js`
Expected: no output (exit 0). If it errors, fix the insertion (unbalanced braces / wrong location).

- [ ] **Step 4: Manual smoke test against production data**

Start the server locally is not required; instead verify the wiring compiles and the module resolves:

Run: `node -e "require('./graded-prices'); const s=require('./package.json'); console.log('resolves OK')"`
Expected: prints `resolves OK` with no throw.

(Live eBay verification is done post-deploy: after pushing, call the endpoint from the extension on a known card — see Task 4 Step 6. Local eBay creds are invalid in this environment, so a local curl to eBay will 401; that is expected and not a blocker.)

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(graded-prices): POST /scan/graded-prices endpoint with premium gate (default off)"
```

Note: if the local working tree contains the `[Lakkot sports] gate check` debug console.log, remove it before committing and restore it after (session convention — it is never committed).

---

## Task 4: Extension display — raw price + async PSA 9 / PSA 10 lines

**Files:**
- Modify: `pikanalyst-extension/src/sidepanel.js`
- Modify: `pikanalyst-extension/src/sidepanel.html`
- Modify: `pikanalyst-extension/src/sidepanel.css`

The extension is not a git repo and has no unit-test harness; verification is manual in Chrome. Follow the existing follow-up-call pattern already used for `/scan/cardmarket`.

- [ ] **Step 1: Locate the CARD_RESULT render**

Read `pikanalyst-extension/src/sidepanel.js` and find the function that renders a `CARD_RESULT` (search for `CARD_RESULT`, `card_name`, or where the raw market price is written into the DOM). Note the function name and the element that holds the price. This is where the two graded lines get appended and where the async call is triggered.

Run: `grep -n "CARD_RESULT\|card_name\|renderCard\|market_price" pikanalyst-extension/src/sidepanel.js`
Expected: identifies the render function + price element id/class.

- [ ] **Step 2: Add the graded-prices container to the HTML**

In `sidepanel.html`, inside the card-result block (near where the raw price is shown), add:

```html
<div id="pka-graded-prices" class="pka-graded" style="display:none">
  <div class="pka-graded-row"><span class="pka-graded-label">PSA 9</span><span id="pka-graded-psa9" class="pka-graded-val">…</span></div>
  <div class="pka-graded-row"><span class="pka-graded-label">PSA 10</span><span id="pka-graded-psa10" class="pka-graded-val">…</span></div>
</div>
```

- [ ] **Step 3: Add styles**

In `sidepanel.css`, append:

```css
.pka-graded { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.pka-graded-row { display: flex; justify-content: space-between; font-size: 13px; }
.pka-graded-label { color: var(--text-secondary, #9aa); font-weight: 600; }
.pka-graded-val { font-variant-numeric: tabular-nums; }
```

- [ ] **Step 4: Add the fetch + fill helper**

In `sidepanel.js`, add this function (uses the same `BACKEND_URL` constant the file already defines for other calls):

```js
// Fetch PSA 9 / PSA 10 comps for a raw Pokémon card and fill the two lines.
// Called after a raw CARD_RESULT renders. Non-blocking: failures leave "—".
async function loadGradedPrices(cardName, cardNumber, language) {
  const box   = document.querySelector('#pka-graded-prices');
  const el9    = document.querySelector('#pka-graded-psa9');
  const el10   = document.querySelector('#pka-graded-psa10');
  if (!box || !el9 || !el10) return;
  box.style.display = '';
  el9.textContent = '…'; el10.textContent = '…';
  const fmt = (g) => (g && g.median != null) ? `${g.median} €` : '—';
  try {
    const res = await fetch(`${BACKEND_URL}/scan/graded-prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardName, cardNumber, language,
        token: currentUser?.token || null,   // used only when the premium gate is on
      }),
    });
    if (res.status === 403) { box.style.display = 'none'; return; } // premium-gated (future)
    const data = await res.json();
    el9.textContent  = fmt(data.psa9);
    el10.textContent = fmt(data.psa10);
  } catch (err) {
    console.warn('[Lakkot] graded-prices failed:', err.message);
    el9.textContent = '—'; el10.textContent = '—';
  }
}
```

- [ ] **Step 5: Trigger it from the render (raw Pokémon only)**

In the CARD_RESULT render function found in Step 1, AFTER the raw price is written to the DOM, add a guarded call. Use the fields the response carries (`card_name`, `card_number`, `card_language`/`lang_toggle`, `match_type`):

```js
// Graded comps only for a RAW Pokémon card (not slabs). result is the /scan payload.
if (result.type === 'CARD_RESULT' && result.match_type === 'raw') {
  loadGradedPrices(result.card_name, result.card_number, result.card_language || currentLanguage);
} else {
  const box = document.querySelector('#pka-graded-prices');
  if (box) box.style.display = 'none';
}
```

(If the render function uses a different variable name than `result` for the scan payload, use that name. `currentLanguage` is the existing language variable in `sidepanel.js`.)

- [ ] **Step 6: Manual test in Chrome**

1. Reload the extension at `chrome://extensions`.
2. Scan a raw high-value Pokémon card with a known graded market (e.g. a Charizard). Expect: raw price shows immediately, then PSA 9 and PSA 10 fill in within ~1-2s with plausible values (PSA 10 > PSA 9 > raw).
3. Scan a common cheap card with no graded market. Expect: PSA 9 / PSA 10 show "—" cleanly.
4. Confirm the raw price is unchanged from before this feature (open the same card twice; raw stays identical).

---

## Task 5: Web app (Lovable) handoff prompt

**Files:**
- Create: `docs/superpowers/plans/2026-09-16-graded-price-comps-lovable-prompt.md`

- [ ] **Step 1: Write the Lovable prompt**

Create the file with:

````markdown
# Lovable prompt — graded PSA 10 / PSA 9 prices on card results

Backend adds a follow-up endpoint on the Render service (same base URL the web
app already uses for scans):

`POST /scan/graded-prices`
Request body: `{ "cardName": string, "cardNumber": string, "language": "FR"|"EN"|"JP"|"WORLD", "token": string|null }`
Response: `{ "psa10": { "median": number|null, "count": number, "currency": "EUR" },
             "psa9":  { "median": number|null, "count": number, "currency": "EUR" } }`
- `median` is null when there are fewer than 2 graded sales → display "—".
- HTTP 403 `{ "error": "upgrade_required" }` will happen only if the premium gate
  is turned on later — handle it by hiding the block (or showing an upgrade CTA).

Task: on the card result page, ONLY for a raw Pokémon card (match_type === 'raw'),
after the raw price renders, call this endpoint with the card's name/number/language
and display two lines under the raw price:

```
Raw     : 12 €
PSA 9   : 45 €      (or "…" while loading, "—" if median is null)
PSA 10  : 120 €
```

Rules:
- Non-blocking: the raw price must render first; the two graded lines fill in async.
- Do not call the endpoint for graded scans or non-Pokémon.
- Pass the signed-in user's token in the body (null if not signed in).
- Show me where the card result renders and the diff before applying.
````

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-09-16-graded-price-comps-lovable-prompt.md
git commit -m "docs(graded-prices): Lovable handoff prompt for web app display"
```

---

## Deployment (after all tasks)

- [ ] Push `server.js` + `graded-prices.js` + tests to `main` → Render auto-deploys the endpoint.
- [ ] Reload the extension in Chrome (manual — not deployed).
- [ ] Paste the Lovable prompt into Lovable for the web app.
- [ ] Leave `GRADED_PRICES_PREMIUM_ONLY` unset (free for testing). When ready to make it premium, set `GRADED_PRICES_PREMIUM_ONLY=true` on Render (30s, no deploy).

---

## Self-Review notes (author)

- **Spec coverage:** §3 mechanism → Task 1/2 (buildGradedCard adds grade to query + _gradeFilter). §4 endpoint → Task 3. §5 cache safeguard → Task 2 uses injected `fetchEbayBrowse` (Browse-direct, no cache) + endpoint passes it; documented. §5 "strict, no cascade" → Task 1/2 call the Browse path directly, never `handleAnalyze`. §6 contract + count>=2 → `formatGradedResult`. §7 display → Task 4 (extension) + Task 5 (Lovable). Premium gate → Task 3 + front 403 handling in Task 4/5.
- **No placeholders:** all steps carry real code/commands.
- **Type consistency:** `{median, count, currency}` shape and `{psa10, psa9}` keys are identical across graded-prices.js, tests, endpoint, and both fronts.
