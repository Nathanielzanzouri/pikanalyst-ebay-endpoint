# Unified Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Lakkot's tab-based UI with a single unified scan that auto-detects cards vs non-cards and routes to eBay sold or Google Shopping pricing.

**Architecture:** One scan button auto-detects item type using DOM title keywords and card number patterns. Cards route to the existing eBay sold pipeline; everything else routes to Google Lens → Google Shopping. Claude Vision, TCG Player, sneaker-specific code, and KicksDB/StockX are removed entirely.

**Tech Stack:** Chrome Extension (MV3), Node.js/Express backend, eBay Finding/Browse APIs, SerpApi (Google Lens + Google Shopping)

---

### Task 1: Update verdict thresholds to symmetric ±10%

**Files:**
- Modify: `pikanalyst-extension/src/sidepanel.js` (lines 480-509, 265-280, 1422-1448)
- Modify: `pikanalyst-extension/src/background.js` (lines 452-458)

This task updates all verdict threshold checks across the codebase from the current asymmetric values (0.85/1.15 for web, 0.92/1.12 for cards) to a uniform ±10% (0.90/1.10).

- [ ] **Step 1: Update card verdict in sidepanel.js `showResult()`**

In `sidepanel.js` around line 480, change the verdict thresholds:

```javascript
// BEFORE:
if (ratio < 0.92) {
// ...
} else if (ratio > 1.12) {

// AFTER:
if (ratio < 0.90) {
// ...
} else if (ratio > 1.10) {
```

- [ ] **Step 2: Update test tab verdict in sidepanel.js `showTestResult()`**

In `sidepanel.js` around line 265, change:

```javascript
// BEFORE:
if (ratio < 0.85) {
// ...
} else if (ratio > 1.15) {

// AFTER:
if (ratio < 0.90) {
// ...
} else if (ratio > 1.10) {
```

- [ ] **Step 3: Update web verdict in sidepanel.js `finalizeWebResult()`**

In `sidepanel.js` around line 1430, change:

```javascript
// BEFORE:
if (ratio < 0.85) {
// ...
} else if (ratio > 1.15) {

// AFTER:
if (ratio < 0.90) {
// ...
} else if (ratio > 1.10) {
```

- [ ] **Step 4: Update background.js deal score calculation**

In `background.js` around line 452, change:

```javascript
// BEFORE:
dealScore = ratio < 0.85
  ? { label: 'GREAT DEAL', pct: Math.round((1 - ratio) * 100) + '% vs retail', type: 'great' }
  : ratio > 1.15
  ? { label: 'OVERPRICED', pct: '+' + Math.round((ratio - 1) * 100) + '% vs retail', type: 'over' }
  : { label: 'FAIR PRICE', pct: Math.round((1 - ratio) * 100) + '% vs retail', type: 'fair' };

// AFTER:
dealScore = ratio < 0.90
  ? { label: 'GREAT DEAL', pct: Math.round((1 - ratio) * 100) + '% vs retail', type: 'great' }
  : ratio > 1.10
  ? { label: 'OVERPRICED', pct: '+' + Math.round((ratio - 1) * 100) + '% vs retail', type: 'over' }
  : { label: 'FAIR PRICE', pct: Math.round((1 - ratio) * 100) + '% vs retail', type: 'fair' };
```

- [ ] **Step 5: Commit**

```bash
git add pikanalyst-extension/src/sidepanel.js pikanalyst-extension/src/background.js
git commit -m "feat: update verdict thresholds to symmetric ±10%"
```

---

### Task 2: Add card detection function to backend

**Files:**
- Modify: `ebay-endpoint/server.js`

Add a function `isTCGCard(text)` that checks whether a string (DOM title or Google Lens product name) looks like a trading card. This function is used by the unified scan router in Task 5.

- [ ] **Step 1: Add the `isTCGCard()` function after the existing filter functions (after `isSpecialEdition` around line 213)**

```javascript
// ─── TCG card detection (unified scan router) ────────────────────────────────
const TCG_BRAND_KEYWORDS = [
  'pokemon', 'pokémon', 'pikachu', 'charizard', 'dracaufeu',
  'yugioh', 'yu-gi-oh', 'yu gi oh',
  'one piece card', 'one piece tcg',
  'magic the gathering', 'mtg',
  'digimon card', 'dragon ball super card',
];
const TCG_MECHANIC_KEYWORDS = [
  'holo', 'reverse holo', 'vstar', 'vmax', 'ex', 'gx',
  'full art', 'alt art', 'trainer gallery', 'radiant',
  'illustration rare', 'special art rare', 'art rare',
  'spell card', 'trap card', 'synchro', 'xyz', 'link', 'pendulum',
  'manga rare', 'leader card', 'don card',
  'ultra rare', 'secret rare', 'starlight rare',
  'common', 'uncommon', 'rare holo',
  'near mint', 'lightly played', 'moderately played',
];
const CARD_NUMBER_RE = /\b\d{1,3}\s*\/\s*\d{1,3}\b/;

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
```

- [ ] **Step 2: Commit**

```bash
cd ebay-endpoint
git add server.js
git commit -m "feat: add isTCGCard() detection for unified scan routing"
```

---

### Task 3: Add unified scan endpoint to backend

**Files:**
- Modify: `ebay-endpoint/server.js`

Add a new `/scan` type `unified` that:
1. Checks the DOM title for card signals using `isTCGCard()`
2. If card → runs existing `handleAnalyze` with mode `cards`
3. If not card or no title → runs Google Lens → checks if Lens result is a card → routes accordingly
4. Detects graded/sealed/lot and returns suppressed verdict

- [ ] **Step 1: Add the unified scan handler in the `/scan` route**

Find the section in the `/scan` POST handler where `type === 'google_lens'` is handled (around line 1877). Add a new type handler BEFORE it:

```javascript
  // unified: auto-detect item type and route to correct pricing pipeline
  if (type === 'unified') {
    try {
      const { imageBase64, streamTitle, sellerPrice, language = 'WORLD', streamCurrency = 'EUR' } = params;
      const rawTitle = (streamTitle ?? '').trim();
      const hasTitle = rawTitle.length > 3 && !isFakeTitle(rawTitle);

      // Check for unsupported items first
      if (hasTitle) {
        if (isGradedCard(rawTitle)) {
          return res.json({ type: 'UNSUPPORTED', reason: 'graded', message: 'Graded card — pricing not supported yet', title: rawTitle });
        }
        if (isBooster(rawTitle)) {
          return res.json({ type: 'UNSUPPORTED', reason: 'sealed', message: 'Sealed product — pricing not supported yet', title: rawTitle });
        }
        if (isLot(rawTitle)) {
          return res.json({ type: 'UNSUPPORTED', reason: 'lot', message: 'Lot/bundle — pricing not supported yet', title: rawTitle });
        }
        if (isMultiChoice(rawTitle)) {
          return res.json({ type: 'UNSUPPORTED', reason: 'multi', message: 'Multi-choice listing — pricing not supported yet', title: rawTitle });
        }
      }

      // Route 1: DOM title looks like a card → eBay sold pipeline
      if (hasTitle && isTCGCard(rawTitle)) {
        console.log('[Lakkot] Unified: card detected from title →', rawTitle);
        const result = await handleAnalyze({ imageBase64, streamTitle: rawTitle, sellerPrice, mode: 'cards', manualCardOverride: '', language });
        return res.json({ type: 'CARD_RESULT', ...result, ebay_sales_count: result.ebay_sales_count ?? 0 });
      }

      // Route 2: Not a card (or no title) → Google Lens → check if card → route
      console.log('[Lakkot] Unified: non-card or no title, running Google Lens...');
      const lensResult = await handleGoogleLens(imageBase64);
      const productName = lensResult?.productName ?? null;

      // Check if Lens identified a card
      if (productName && isTCGCard(productName)) {
        console.log('[Lakkot] Unified: Lens identified card →', productName);
        // Use Lens product name as the title for card pipeline
        const result = await handleAnalyze({ imageBase64, streamTitle: productName, sellerPrice, mode: 'cards', manualCardOverride: productName, language });
        return res.json({ type: 'CARD_RESULT', ...result, ebay_sales_count: result.ebay_sales_count ?? 0, identified_by: 'lens' });
      }

      // Route 3: Non-card → Google Shopping for retail pricing
      let shoppingResult = { cards: [], medianPrice: null, totalFound: 0 };
      if (productName) {
        try {
          shoppingResult = await handleGoogleShopping(productName);
          console.log(`[Lakkot] Unified: Google Shopping ${shoppingResult.cards.length} results, median=${shoppingResult.medianPrice}`);
        } catch (err) {
          console.error('[Lakkot] Unified: Google Shopping error:', err.message);
        }
      }

      const usesShopping = shoppingResult.cards.length > 0;
      const finalCards = usesShopping ? shoppingResult.cards : (lensResult?.cards ?? []);
      const medianPrice = shoppingResult.medianPrice ?? lensResult?.medianPrice ?? null;

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
      });
    } catch (err) {
      console.error('[Lakkot] Unified scan error:', err.message);
      return res.json({ type: 'WEB_RESULT', productName: null, cards: [], medianPrice: null, sourcesCount: 0, pricesCount: 0, sellerPrice: null, streamCurrency: 'EUR', priceSource: 'lens', _error: err.message });
    }
  }
```

- [ ] **Step 2: Commit**

```bash
cd ebay-endpoint
git add server.js
git commit -m "feat: add unified scan endpoint with auto card detection"
```

---

### Task 4: Simplify `fetchPrices()` — remove TCG branch

**Files:**
- Modify: `ebay-endpoint/server.js`

The `fetchPrices()` function (around line 877) currently calls both `fetchEbayAny()` and `fetchPokemonTCG()`. Remove the TCG branch so it only uses eBay sold data.

- [ ] **Step 1: Simplify `fetchPrices()`**

Replace the function (around line 877-900):

```javascript
async function fetchPrices(card, language = 'WORLD') {
  let ebay = null;
  try {
    ebay = await fetchEbayAny(card, language);
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
```

- [ ] **Step 2: Commit**

```bash
cd ebay-endpoint
git add server.js
git commit -m "refactor: simplify fetchPrices to eBay-only, remove TCG branch"
```

---

### Task 5: Update background.js — unified scan routing

**Files:**
- Modify: `pikanalyst-extension/src/background.js` (lines 300-470)

Replace the mode-based branching in `handleScanNow()` with a single unified flow that calls the new `/scan` type `unified` and routes the response to the correct panel.

- [ ] **Step 1: Replace the mode-branching logic in `handleScanNow()`**

Starting at line 364 (after the frame capture and seller price conversion), replace everything from `// ── CARDS tab: run backend identify first` through the end of the Google Lens flow (line 470) with:

```javascript
  // ── Unified scan: auto-detect and route ────────────────────────────────────
  scanTotal++;
  toPanel('FOOT', { scanTotal, apiCallTotal });

  const unifiedResult = await callScanWithTimeout({
    type: 'unified',
    imageBase64,
    streamTitle,
    sellerPrice,
    language,
    streamCurrency,
  }, 60000).catch(err => {
    console.error('[Lakkot BG] unified scan error:', err.message);
    return null;
  });

  if (!unifiedResult) {
    toPanel('ERROR', { msg: 'Scan failed — please try again.' });
    return;
  }

  if (unifiedResult.quota) toPanel('QUOTA', { quota: unifiedResult.quota });

  // Handle unsupported items (graded, sealed, lots)
  if (unifiedResult.type === 'UNSUPPORTED') {
    toPanel('IDLE');
    const errEl = document.querySelector('#pka-error-msg');
    toPanel('ERROR', { msg: unifiedResult.message });
    return;
  }

  // Card result → show card panel
  if (unifiedResult.type === 'CARD_RESULT') {
    apiCallTotal++;
    toPanel('FOOT', { scanTotal, apiCallTotal });
    const isTradingCard = unifiedResult.card_name
      && unifiedResult.card_name !== 'UNCLEAR'
      && unifiedResult.card_name !== 'Non identifiable';
    if (isTradingCard) {
      toPanel('RESULT', { data: unifiedResult, thumb, streamTitle, streamCurrency, manualTitleOverride: '' });
      writeHistory(unifiedResult, '');
    } else {
      toPanel('IDLE');
    }
    return;
  }

  // Web result → show retail panel
  if (unifiedResult.type === 'WEB_RESULT') {
    const productName = unifiedResult.productName ?? null;
    const cards = unifiedResult.cards ?? [];
    const medianPrice = unifiedResult.medianPrice ?? null;
    const priceSource = unifiedResult.priceSource ?? 'lens';
    const totalFound = unifiedResult.totalFound ?? cards.length;

    let dealScore = null;
    if (medianPrice != null && medianPrice > 0.01 && sellerPrice != null) {
      const ratio = sellerPrice / medianPrice;
      dealScore = ratio < 0.90
        ? { label: 'GREAT DEAL', pct: Math.round((1 - ratio) * 100) + '% vs retail', type: 'great' }
        : ratio > 1.10
        ? { label: 'OVERPRICED', pct: '+' + Math.round((ratio - 1) * 100) + '% vs retail', type: 'over' }
        : { label: 'FAIR PRICE', pct: Math.round((1 - ratio) * 100) + '% vs retail', type: 'fair' };
    }

    toPanel('WEB_DONE', { productName, cards, medianPrice, dealScore, sellerPrice, streamCurrency, streamTitle, priceSource, totalFound });

    if (productName || streamTitle) {
      const GARBAGE_TITLE = /vue en live|pas d.annulation|déstockage|destockage|#|\bpdd\b/i;
      const domTitle = streamTitle && !GARBAGE_TITLE.test(streamTitle) ? streamTitle.trim() : null;
      const histTitle = productName ? productName.replace(/^[^|]+\|\s*/, '').replace(/^[^–]+–\s*/, '').trim().slice(0, 80) : domTitle || 'Article vu en live';
      writeHistory({ type: 'other', title: histTitle, medianPrice, sellerPrice });
    }
    return;
  }

  // Fallback
  toPanel('IDLE');
```

- [ ] **Step 2: Remove the `mode` parameter from scan commands**

In the same function, remove `mode` from destructuring at line 304 since it's no longer used. Also update `sendCmd` calls in sidepanel.js to stop sending `mode`:

In `sidepanel.js`, update the scan button click handler (around line 1576):
```javascript
// BEFORE:
sendCmd('CMD_SCAN_NOW', { query, lastAutoFilled: lastAutoFilledQuery, mode: currentMode, language: currentLanguage });

// AFTER:
sendCmd('CMD_SCAN_NOW', { query, lastAutoFilled: lastAutoFilledQuery, language: currentLanguage });
```

Do the same for the rescan button (line 1581), new scan button (line 1585), and query enter key (line 1669).

- [ ] **Step 3: Commit**

```bash
git add pikanalyst-extension/src/background.js pikanalyst-extension/src/sidepanel.js
git commit -m "feat: replace mode-based scan with unified auto-detect routing"
```

---

### Task 6: Add "Based on X sales" to card result UI

**Files:**
- Modify: `pikanalyst-extension/src/sidepanel.html` (line 145-150)
- Modify: `pikanalyst-extension/src/sidepanel.js` (in `showResult()` around line 480-509)

- [ ] **Step 1: Add sales count element to HTML**

In `sidepanel.html`, after the verdict bar (after line 149), add:

```html
        <div id="pka-sales-count" style="display:none"></div>
```

- [ ] **Step 2: Populate sales count in `showResult()`**

In `sidepanel.js` `showResult()`, after the verdict logic block (after the closing `}` around line 509), add:

```javascript
  // Sales count display
  const salesCountEl = document.querySelector('#pka-sales-count');
  if (salesCountEl) {
    const count = data.ebay_sales_count ?? 0;
    if (count > 0) {
      salesCountEl.textContent = `Based on ${count} sale${count !== 1 ? 's' : ''}`;
      salesCountEl.style.display = 'block';
    } else {
      salesCountEl.style.display = 'none';
    }
  }
```

- [ ] **Step 3: Add minimal CSS for the sales count**

In `pikanalyst-extension/src/overlay.css`, add:

```css
#pka-sales-count {
  text-align: center;
  font-size: 11px;
  color: #888;
  margin-top: 2px;
  margin-bottom: 4px;
}
```

- [ ] **Step 4: Commit**

```bash
git add pikanalyst-extension/src/sidepanel.html pikanalyst-extension/src/sidepanel.js pikanalyst-extension/src/overlay.css
git commit -m "feat: add 'Based on X sales' display for card results"
```

---

### Task 7: Remove tabs from UI

**Files:**
- Modify: `pikanalyst-extension/src/sidepanel.html` (lines 32-36)
- Modify: `pikanalyst-extension/src/sidepanel.js` (lines 1556-1621)

- [ ] **Step 1: Remove the mode row from HTML**

In `sidepanel.html`, remove lines 31-36 (the entire `pka-mode-row` div):

```html
    <!-- REMOVE THIS ENTIRE BLOCK -->
    <div id="pka-mode-row">
      <button class="pka-mode-btn active" id="pka-mode-cards" data-mode="cards">Pok&#xe9;mon / YGO</button>
      <button class="pka-mode-btn" id="pka-mode-other" data-mode="other">SCAN ITEM</button>
      <button class="pka-mode-btn pka-mode-test" id="pka-mode-test" data-mode="test">TEST</button>
    </div>
```

- [ ] **Step 2: Remove the test result panel from HTML**

In `sidepanel.html`, remove the entire `pka-test-result` div (lines 203-248).

- [ ] **Step 3: Remove mode state and tab event listeners from JS**

In `sidepanel.js`:

1. Remove the `currentMode` variable declaration (line 11):
```javascript
// DELETE: let currentMode = 'cards';
```

2. Remove the mode init block in DOMContentLoaded (lines 1555-1564):
```javascript
// DELETE: the mode btn forEach and other-mode-active init
```

3. Remove the mode button click listeners (lines 1602-1622):
```javascript
// DELETE: the entire document.querySelectorAll('.pka-mode-btn').forEach block
```

4. Remove `showTestResult()` function (lines 213-311).

5. Remove the `TEST_RESULT` case from `handlePortMessage()` (lines 207-209).

- [ ] **Step 4: Remove `currentMode` from all `sendCmd` calls**

Search for remaining references to `currentMode` and remove them. The `sendCmd('CMD_MODE', ...)` call is no longer needed.

- [ ] **Step 5: Commit**

```bash
git add pikanalyst-extension/src/sidepanel.html pikanalyst-extension/src/sidepanel.js
git commit -m "feat: remove mode tabs, unify to single scan"
```

---

### Task 8: Rework JP toggle as result filter

**Files:**
- Modify: `ebay-endpoint/server.js`

Currently the JP toggle modifies the eBay search query. Change it to filter eBay sold results instead.

- [ ] **Step 1: Update the eBay Browse results filtering**

In `fetchEbayBrowse()` (around line 652), after collecting all listings and before computing the median, add a `language` parameter and filter logic:

Add `language` parameter to `fetchEbayBrowse`:
```javascript
async function fetchEbayBrowse(card, token, language = 'WORLD') {
```

After the listings are collected and filtered for graded/booster/etc. (before the `removeOutliers` call), add:

```javascript
    // JP filter: if language is JP, only keep listings with Japanese keywords in title
    if (language === 'JP') {
      const jpKeywords = ['japan', 'japanese', 'jap', 'jp', 'japonais', 'japonaise'];
      const beforeJp = listings.length;
      listings = listings.filter(l => {
        const titleLower = (l.title || '').toLowerCase();
        return jpKeywords.some(kw => titleLower.includes(kw));
      });
      console.log(`[Lakkot] JP filter: ${beforeJp} → ${listings.length} listings`);
      prices = listings.map(l => l.price).filter(p => p != null);
    }
```

- [ ] **Step 2: Remove the query-level language modification**

In `applyLanguageToQuery()` (around line 135), change the JP case to not append "Japanese":

```javascript
// BEFORE:
case 'JP': return `${baseQuery} Japanese`;

// AFTER:
case 'JP': return baseQuery;
```

- [ ] **Step 3: Commit**

```bash
cd ebay-endpoint
git add server.js
git commit -m "feat: rework JP toggle as result filter instead of query modifier"
```

---

### Task 9: Remove dead backend code

**Files:**
- Modify: `ebay-endpoint/server.js`

Remove all unused functions and constants. This is a large deletion — do it carefully.

- [ ] **Step 1: Remove Claude Vision identification functions**

Delete these functions entirely:
- `identifyCard()` (lines ~1228-1296)
- `identifySneaker()` (lines ~1143-1225)
- `identifyItem()` (lines ~1298-1350)
- `VISION_PROMPT_CARDS` constant (lines ~1115-1129)
- `VISION_PROMPT_SHOES` constant (lines ~1131-1140)

- [ ] **Step 2: Remove sneaker-specific code**

Delete these functions entirely:
- `handleSneaker()` (lines ~1089-1112)
- `fetchSneakerPrices()` (lines ~978-1069)
- `fetchKicksDBServerPrice()` (lines ~903-972)
- `SHOE_BUNDLE_RE` and `isShoeBundleTitle()` (lines ~974-975)

- [ ] **Step 3: Remove TCG Player code**

Delete:
- `fetchPokemonTCG()` (lines ~785-860)
- `CONDITION_MULTIPLIERS` constant (lines ~780-783)

- [ ] **Step 4: Update `handleAnalyze()` to remove Claude Vision fallback**

In `handleAnalyze()` (around line 1352), the `else` branch that calls `identifyCard()`, `identifySneaker()`, and `identifyItem()` should be simplified. When there's no title and mode is cards, return `{ item_type: 'unknown' }` instead of calling Claude Vision — the unified endpoint handles the no-title case via Google Lens.

Replace the else block (lines ~1383-1402):

```javascript
  } else {
    // No usable title — unified endpoint handles this via Google Lens
    return { item_type: 'unknown' };
  }
```

- [ ] **Step 5: Verify the server starts without errors**

```bash
cd ebay-endpoint
node -e "require('./server.js')" 2>&1 | head -5
```

Expected: no syntax errors or missing function references.

- [ ] **Step 6: Commit**

```bash
cd ebay-endpoint
git add server.js
git commit -m "refactor: remove dead code — Claude Vision, sneaker pipeline, TCG Player"
```

---

### Task 10: Clean up frontend dead code

**Files:**
- Modify: `pikanalyst-extension/src/sidepanel.js`
- Modify: `pikanalyst-extension/src/sidepanel.html`

- [ ] **Step 1: Remove confidence dot logic from `showResult()`**

In `sidepanel.js` around lines 520-528, remove the confidence dot color logic:

```javascript
// DELETE this block:
  const confRaw = data.confidence ?? null;
  const confPct = confRaw == null ? '—' : confRaw <= 1 ? Math.round(confRaw * 100) : Math.round(confRaw);
  const subtitleEl = document.querySelector('#pka-card-subtitle');
  if (subtitleEl) {
    const pct = typeof confPct === 'number' ? confPct : 0;
    subtitleEl.style.setProperty('--dot-color',
      pct >= 90 ? '#10B981' : pct >= 70 ? '#A855F7' : '#F43F5E');
  }
```

- [ ] **Step 2: Remove TCGPlayer link from HTML**

In `sidepanel.html`, remove the TCGPlayer row (lines 193-196):

```html
    <!-- DELETE -->
    <div id="pka-pc-row">
      <span id="pka-pc-graded"></span>
      <a id="pka-pc-link" href="#" target="_blank" rel="noopener noreferrer">View on TCGPlayer &#x2192;</a>
    </div>
```

- [ ] **Step 3: Remove condition-related labels from HTML**

In `sidepanel.html`, remove "Non gradé" from the price header (line 153):

```html
<!-- BEFORE -->
<span id="pka-price-label-right">Non grad&#xe9;</span>

<!-- AFTER -->
<span id="pka-price-label-right"></span>
```

- [ ] **Step 4: Remove `UNCERTAIN` handler from sidepanel.js**

In `handlePortMessage()`, remove the `case 'UNCERTAIN':` block (lines 102-122) since uncertain sneaker identification no longer exists.

- [ ] **Step 5: Remove shoe-specific references**

Search for and remove any remaining references to `sneaker`, `shoe`, `brand`, `model`, `colorway`, `stockx` in sidepanel.js that are no longer used.

- [ ] **Step 6: Commit**

```bash
git add pikanalyst-extension/src/sidepanel.js pikanalyst-extension/src/sidepanel.html
git commit -m "refactor: remove dead frontend code — confidence dot, TCGPlayer, sneaker UI"
```

---

### Task 11: End-to-end manual testing

**Files:** None (testing only)

- [ ] **Step 1: Start the backend locally**

```bash
cd ebay-endpoint
node server.js
```

- [ ] **Step 2: Load the extension in Chrome**

Go to `chrome://extensions`, enable Developer Mode, click "Load unpacked" and select the `pikanalyst-extension` directory. Open the side panel on a Whatnot or Voggt stream.

- [ ] **Step 3: Test card with DOM title**

Find a stream with a Pokémon card that has a proper title (name + card number). Hit scan. Verify:
- Card is identified correctly
- eBay sold price shows
- Verdict shows with ±10% thresholds
- "Based on X sales" text appears
- Listings expand and show correct cards

- [ ] **Step 4: Test non-card item**

Find a stream with sneakers or other item. Hit scan. Verify:
- Google Lens identifies the product
- Google Shopping retail price shows
- Verdict bar works
- Retail sources show with store names and prices

- [ ] **Step 5: Test JP toggle**

Enable JP toggle, scan a Japanese card. Verify:
- Results are filtered to Japanese listings only
- Median is recalculated from filtered results

- [ ] **Step 6: Test graded card detection**

If available, find a stream showing a PSA/CGC slab. Verify:
- "Graded card — pricing not supported yet" message appears
- No misleading price is shown

- [ ] **Step 7: Test manual search**

Type a card name in the search box and press Enter. Verify:
- eBay sold results show correctly
- Works the same as before

- [ ] **Step 8: Commit any fixes**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end testing"
```
