# Sneaker scan pipeline — "Lens + tri" (2 SerpApi calls)

**Date:** 2026-07-26
**Owner:** VP R&D (advisory)
**Status:** design approved, pending spec review

## Problem

Sneaker scans on the legacy `lens-web-shopping` path cost up to **4 SerpApi
calls** (1 Lens + 3 Shopping) for a result a **single Shopping call already
produces**. Decomposition of scan `5c5a0293-d39b-4d7f-92a7-3fca20f30cb6`
(Nike Air Force 1 "White Aquarius Blue", FQ4296-100) proved:

- **Call 1 — Lens:** identifies correctly, style code `FQ4296-100` present in
  matches #6/#10/#15.
- **Call 2 — Gemini query** `Nike Air Force 1 Low 07 White Aquarius Blue
  FQ4296-100`: **34 clean listings, median ~115 € at scan time** (GOAT, DICK's,
  Solefly, Finish Line). *This alone is the answer.*
- **Call 3 — legacy `skuQuery`:** query **identical** to call 2, then
  `filterBySku` returns **0** because retailers (GOAT/DICK's/Finish Line) never
  put the style code in their titles → empties the basket.
- **Call 4 — retailer-augment:** compensates for the empty basket; adds
  retailers already present in call 2's basket.

**Root cause:** `filterBySku` (the "tri") requires the style code *in each
result title*, which does not match how retailers title listings. It discards
good results, which triggers compensating calls. The extra calls fix a broken
filter, not a real gap.

## Goal

Reproduce the scan's result (basket + median) with **Lens + 1 Shopping call**
(+ at most 1 fallback retry). Identity from Lens (source of truth), price from
Shopping (mandatory).

## Design

Pipeline (target):

```
Lens ─► Gemini builds 1 query (from Lens titles)
     ─► 1 Shopping call
     ─► TRI by identity (tolerant, NOT style-code-in-title)
     ─► [if < 3 kept] 1 broader retry, then stop
```

### 1. Identity (unchanged)
`extractProductIdentity(lensMatches)` (Gemini, `ai-product-id.js`) stays the
**primary** query builder — proven to produce an excellent query, cost
negligible (~€0.0002). Its structured output `{ brand, model, variant, sku,
query }` feeds the tri.

Minimal safety net: if Gemini returns no query, fall back to a name query built
from the consensus Lens phrase (`extractCommonPhrase`) — **no** style-code
filter.

### 2. Single Shopping call
Run `handleGoogleShopping(identity.query, country)`. Keep existing hygiene
filters: `extracted_price > 0`, thumbnail + link present, drop counterfeit
domains (aliexpress/temu/dhgate/wish) and kids sizes.

### 3. The tri — `filterByShoeIdentity` (replaces `filterBySku`)

Normalize text: lowercase, strip accents, collapse non-alphanumerics to single
spaces.

Token sets from identity (normalized, stopwords removed):
- `brandTok` — brand tokens (e.g. `["nike"]`)
- `modelTok` — **core** model tokens only (e.g. `["air","force","1"]`).
  Strip generic silhouette qualifiers before building this set:
  `low`, `high`, `mid`, `07`, `'07`, `og`, `sp`, `gs`, `lv8`, and bare years.
  This prevents the model gate from over-filtering on words retailers omit or
  vary (e.g. a title "Nike Air Force 1 White Aquarius Blue" must still pass even
  though it lacks "Low '07").
- `colorTok` — colorway/variant tokens (e.g. `["white","aquarius","blue"]`)

Rules:
1. **Hard requirement (model gate):** a listing is kept only if its title
   contains **all** `modelTok` **and** the `brandTok` (when brand is known),
   order-independent. This keeps AF1 listings, drops "Dunk Low" lookalikes.
   Style code is **never** required in the title.
2. **Colorway = scoring, not gating:** `colorScore` = count of `colorTok`
   present in the title. Used to rank and to choose the pricing subset — never
   to exclude (colorways are named inconsistently: "Aquarius Blue" vs
   "University Blue" vs "White Blue").

### 4. Pricing subset + median
- Let `kept` = model-gated listings.
- If ≥ 3 listings have `colorScore ≥ 1`, price over **those** (correct
  colorway). Else price over all `kept`.
- Median after `removeOutliers` (existing helper).

### 5. Fallback (≤ 1 extra call)
If `kept.length < 3`: **one** broader retry query `"{brand} {model}
{colorway}"` (no SKU). Merge unique titles, re-apply the model gate. If still
`< 3`, take the raw hygiene-filtered basket median as best effort (never return
nothing when the basket had listings).

### 6. Removed
Delete the sneaker cascade: `buildIdentity` → `buildShoppingQuery` →
`filterBySku` → thin-basket fallback → retailer-augment (calls #3 and #4).
`sneaker-id.js`'s style-code vote may still feed diagnostics/logging but must
not drive a second Shopping call.

**Scope note:** the cascade's `if (identity.confident)` block only fires for
sneakers (needs a style code), so removing it does not affect bags/toys/other
fall-through products — they already rely on the Gemini query path.

## Acceptance criteria
1. Re-running the logic against scan `5c5a0293` yields:
   - **2 SerpApi calls** (Lens + 1 Shopping),
   - a basket retaining the real retailers (DICK's, Finish Line, GOAT, Solefly),
   - median within ~±10 % of the original **115 €**.
2. No regression for non-sneaker fall-through products (still Gemini query →
   Shopping).
3. Hard-to-ID sneaker (weak/no Lens SKU) still returns a price via the 1 retry,
   or a best-effort basket median — never a silent 0 when listings existed.

## Non-goals
- KicksDB / StockX / GOAT resale API integration (separate future chantier).
- Changing the eBay-sold or TCG paths.
