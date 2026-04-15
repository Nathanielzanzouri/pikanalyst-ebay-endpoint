# Lakkot Unified Scan — Design Spec

**Date:** 2026-04-15
**Status:** Approved

## Overview

Replace Lakkot's tab-based UI (Cards / SCAN ITEM / TEST) with a single unified scan that auto-detects item type and routes to the correct pricing pipeline. Cards use eBay sold pricing; everything else uses Google Shopping retail pricing.

## Architecture

### Detection & Routing

One scan button. The system detects item type and routes automatically:

1. **DOM title exists + card signals detected** → parse title → eBay sold query
2. **DOM title exists + no card signals** → Google Shopping retail pricing
3. **No usable DOM title** → Google Lens identifies the product → if card, eBay sold query; if not, Google Shopping pricing

Card detection keywords (priority order):
- Card number pattern: `NNN/NNN` (e.g., `215/182`)
- TCG brand keywords: pokemon, yugioh, yu-gi-oh, one piece card
- TCG mechanic keywords: holo, reverse holo, VSTAR, VMAX, EX, GX, V, full art, alt art, trainer gallery, radiant, illustration rare, spell card, trap card, synchro, xyz, link, pendulum, manga rare, leader card, don card
- TCG rarity keywords: ultra rare, secret rare, starlight rare
- Condition keywords: NM, LP, MP, HP, near mint, lightly played
- Grading keywords: PSA, CGC, BGS (triggers unsupported item handling, not pricing)

### Pricing Pipelines

**Cards (eBay Sold):**
- Source: eBay Finding API + eBay Browse API (existing logic)
- Price: Median of sold prices after two-pass outlier removal (10% trim + 2.5x median filter)
- Includes: price low (10th percentile), price high (90th percentile), sale count, listing details

**Non-cards (Google Shopping):**
- Source: SerpApi Google Shopping API (existing `handleGoogleShopping()`)
- Price: Median of retail prices after IQR-based outlier removal
- Includes: retailer names, prices, links, thumbnails

### Card Identification (No DOM Title)

When no DOM title is available, Google Lens is the sole identification method:
1. Upload frame to imgbb
2. Google Lens visual search via SerpApi
3. Extract product name from results
4. Run the same card detection keywords against the Google Lens product name (pokemon, yugioh, card number patterns, etc.)
5. If card detected → build eBay sold query from identified name/number
6. If not card → Google Shopping pricing with identified product name

Claude Vision is removed from the identification pipeline entirely.

## Verdict Logic

**Symmetric ±10% thresholds (all categories):**
- **GREAT DEAL** 🔥: `asking / market < 0.90` (10%+ below market)
- **FAIR PRICE** ⚖️: `asking / market` between 0.90 and 1.10
- **OVERPRICED** 🚨: `asking / market > 1.10` (10%+ above market)

**Sale count display:** Show "Based on X sales" for cards (eBay sold data). Not shown for non-card items.

**No confidence dot system.** Listings serve as the trust/verification layer — users can glance at thumbnails to confirm correct product identification.

## Unsupported Item Handling

**Graded cards (PSA, CGC, BGS, etc.):**
- Detected via `isGradedCard()` keyword matching in DOM title or Google Lens result
- Verdict suppressed. Message: "Graded card — pricing not supported yet"
- Card identity (name, set, number) still displayed
- Full graded pricing: roadmap

**Sealed product (boosters, ETBs, displays):**
- Detected via `isBooster()` filtering
- Verdict suppressed. Message: "Sealed product — pricing not supported yet"
- Roadmap

**Lots/bundles:**
- Detected via `isLot()` filtering
- Verdict suppressed with message

## JP Toggle

The JP toggle remains as a **result filter**, not a query modifier:
- **JP off (default):** All eBay sold results shown, unfiltered
- **JP on:** eBay sold results filtered to listings containing "japan", "japanese", "jap", or "jp" in the title
- Median price recalculated from the filtered subset
- Future: extend same pattern to other languages (FR, IT, EN)

## UI Layout

### No Tabs

The Cards / SCAN ITEM / TEST tabs are removed. One scan button, auto-routing.

### Card Result (eBay Sold)
- Card name + set
- Verdict bar (DEAL / FAIR / OVER) with percentage
- "Based on X sales"
- Price grid: eBay Sold median | Asking price
- Collapsed listings section (thumbnails, prices, dates for trust/verification)
- JP toggle available

### Non-Card Result (Google Shopping)
- Product name
- Verdict bar (same verdict logic)
- Price grid: Retail median | Asking price
- Retail sources section (store names, prices, links)

## Code Cleanup

### Remove (backend — server.js)
- `identifyCard()` — Claude Vision card identification
- `identifySneaker()` — Claude Vision sneaker identification
- `identifyItem()` — Claude Vision unified identification
- `VISION_PROMPT_CARDS` — card vision prompt constant
- `VISION_PROMPT_SHOES` — sneaker vision prompt constant
- `handleSneaker()` — sneaker pricing handler
- `fetchSneakerPrices()` — sneaker eBay sold pipeline
- `fetchKicksDBServerPrice()` — KicksDB/StockX lookup
- `CONDITION_MULTIPLIERS` — condition-based price adjustment
- `fetchPokemonTCG()` — TCG player pricing (eBay sold is the sole card source)
- `SHOE_BUNDLE_RE` / `isShoeBundleTitle()` — sneaker bundle filter

### Remove (frontend — sidepanel.js/html)
- Tab switching logic (Cards / SCAN ITEM / TEST)
- Mode state management (`currentMode`)
- Confidence dot display
- Shoe-specific UI elements

### Keep
- `buildEbayQuery()`, `buildSearchQuery()`, `buildBrowseQueries()` — query building
- `fetchEbayFinding()`, `fetchEbayBrowse()`, `fetchEbayAny()` — eBay sold pricing
- `removeOutliers()`, `filterByCardIdentity()` — price cleanup
- `isGradedCard()`, `isBooster()`, `isLot()`, `isMultiChoice()`, `isSpecialEdition()`, `isFakeTitle()` — item type filters
- `POKEMON_SYNONYMS`, `getNameVariants()` — multilingual card name matching
- `handleGoogleLens()`, `handleGoogleShopping()` — Google identification and retail pricing
- JP toggle logic (reworked as result filter)
- `handleCard()`, `fetchPrices()` — simplify `fetchPrices()` to only call `fetchEbayAny()` (remove TCG branch)
- Currency conversion, exchange rate logic
- Cache layer, auth/quota system

## Roadmap (Out of Scope)

- Graded card pricing (dedicated pricing lane per grade)
- Sealed product pricing (boosters, ETBs, displays)
- Language-specific result filtering (FR, IT, EN — extending JP toggle pattern)
- StockX/GOAT integration (if a reliable API becomes available)
