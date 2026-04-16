# Lakkot Chrome Web Store Submission — Design Spec

**Date:** 2026-04-16
**Status:** Approved

## Overview

Publish Lakkot as an **unlisted** Chrome Web Store extension for private beta testing with 10-50 testers. Unlisted means it won't appear in search — only people with the direct link can install. When ready, flip to public for general availability.

## Manifest Cleanup

Remove dead host permissions that Chrome review will flag:

**Remove:**
- `<all_urls>` — too broad, will be rejected
- `https://api.anthropic.com/*` — Claude Vision removed
- `https://api.pokemontcg.io/*` — TCG Player removed
- `https://api.openai.com/*` — audio transcription not used
- `https://svcs.ebay.com/*` — eBay called from backend, not extension
- `https://api.ebay.com/*` — eBay called from backend, not extension

**Keep:**
- `https://pikanalyst-ebay-endpoint.onrender.com/*` — Lakkot backend
- `https://api.exchangerate-api.com/*` — currency rates (called from sidepanel.js)

## Description (Bilingual)

**French (primary):**
Lakkot analyse les articles en temps réel sur les lives Whatnot et Voggt. Cartes Pokémon, sneakers, sacs, jouets — obtenez le prix marché instantanément et sachez si c'est une bonne affaire avant d'enchérir.

**English:**
Lakkot analyzes items in real time on Whatnot and Voggt live streams. Pokémon cards, sneakers, bags, toys — get the market price instantly and know if it's a good deal before you bid.

## Privacy Policy

Host at `lakkot.com/privacy`. Must cover:

**Data collected:**
- Video frame screenshots: sent to Lakkot backend, then to Google Lens/Shopping (SerpApi) for product identification. Images are temporary (imgbb, 10-minute expiry).
- Scan count: tracked per user in Supabase for daily quota enforcement.
- Authentication token: stored in Chrome local storage and Supabase.
- Email address: collected at signup for token delivery via Resend.

**Data NOT collected:**
- No browsing history
- No personal information beyond email
- No data sold to third parties
- No tracking or analytics cookies

**Data retention:**
- Frame images: deleted after 10 minutes (imgbb expiry)
- Scan counts: reset daily
- User accounts: retained until user requests deletion

## Chrome Web Store Listing

- **Name:** Lakkot — Live Price Intelligence
- **Category:** Shopping
- **Language:** French (primary) + English
- **Visibility:** Unlisted (beta), switch to Public when ready
- **Screenshots:** 3-5 screenshots of extension in action (card result, sneaker result, idle state). To be captured by user.
- **Promotional images:** Deferred to public launch

## Submission Steps

1. Register Chrome Web Store developer account ($5 one-time fee)
2. Clean up manifest.json — remove dead host permissions
3. Update manifest description — bilingual
4. Write privacy policy — host at lakkot.com/privacy
5. Package extension — zip the pikanalyst-extension folder
6. Upload to Chrome Web Store Developer Dashboard — set as Unlisted
7. Add listing details — description, screenshots, category
8. Submit for review (1-3 business days)
9. Share unlisted link with beta testers

## Auto-Updates

After initial approval, future updates:
1. Bump `version` in manifest.json (e.g., 0.1.0 → 0.1.1)
2. Zip and re-upload to Developer Dashboard
3. Submit for review
4. Testers receive update automatically
