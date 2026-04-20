# Lakkot Google Auth + Stripe Upgrade — Design Spec

**Date:** 2026-04-20
**Status:** Approved

## Overview

Replace the manual token-by-email signup with one-click Google login via Chrome Identity API. Add Stripe Checkout for self-service Pro upgrades. Email is the universal user identifier across all future platforms (extension, mobile, web).

## Login Flow

**Not logged in:**
1. Side panel shows "Sign in with Google" button (scan UI hidden)
2. User clicks → `chrome.identity.getAuthToken()` triggers Google consent screen
3. User authorizes → extension gets Google OAuth token
4. Extension sends token to backend `POST /auth/google`
5. Backend verifies with Google (`https://oauth2.googleapis.com/tokeninfo`), extracts email + name + picture
6. Backend finds or creates user in Supabase by email (free plan, 10 scans/day)
7. Backend returns Lakkot session token + user profile
8. Extension stores token + profile in `chrome.storage.local` → shows scan UI

**Already logged in:**
- Token in `chrome.storage.local` → straight to scanning
- User avatar + name shown in header

## Backend Changes

### New endpoint: `POST /auth/google`
- Input: `{ googleToken }`
- Verifies token: `https://oauth2.googleapis.com/tokeninfo?access_token=<token>`
- Extracts: email, name, picture
- Finds user by email in Supabase users table
- If not found: creates new user (free plan, 0 scans)
- Returns: `{ token, email, name, picture, plan, scanCount, scanLimit }`

### New endpoint: `POST /stripe/webhook`
- Receives Stripe `checkout.session.completed` event
- Validates webhook signature with Stripe signing secret
- Extracts customer email from checkout session
- Updates Supabase user: `plan = 'pro'`, stores `stripe_customer_id`

### Supabase `users` table additions
- `name` (text, nullable) — Google profile display name
- `picture` (text, nullable) — Google avatar URL
- `stripe_customer_id` (text, nullable) — Stripe customer reference

### Removed
- `POST /auth/signup` endpoint
- Resend email dependency for auth (Resend can stay for other transactional emails)

### Unchanged
- `validateAndCount()` — still validates by token, checks plan limits, increments scan count
- `GET /me` — still works with token
- `POST /scan` — still requires token

## Stripe Upgrade Flow

1. User hits daily limit (10 free scans) → sees "Daily limit reached" screen
2. Clicks "Upgrade to Pro" → opens Stripe Checkout page in browser
3. Checkout pre-filled with user's email (passed as URL parameter)
4. User pays → Stripe fires `checkout.session.completed` webhook
5. Backend webhook handler updates plan to "pro" in Supabase
6. Next scan → `validateAndCount()` sees `plan = 'pro'` → 100 scans/day

### External setup required
- Create Stripe account
- Create product: "Lakkot Pro" (monthly or one-time — pricing TBD)
- Create Stripe Checkout link
- Configure webhook endpoint: `https://pikanalyst-ebay-endpoint.onrender.com/stripe/webhook`
- Store `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Render env vars

## Extension UI Changes

### Not logged in (new state)
- Hide: scan button, query input, JP toggle, scan pill
- Show: "Sign in with Google" button centered
- Below: "Free — 10 scans/day"

### Header (logged in)
- Show user avatar (small circle) + name
- Remove token input from settings

### Settings panel (simplified)
- Show: email, plan, scans remaining today
- "Sign out" button (clears `chrome.storage.local`, returns to login screen)
- "Upgrade to Pro" button (if free plan, opens Stripe Checkout)
- Remove: token input, OpenAI key input

### Limit reached (updated)
- Keep current layout
- Upgrade button opens Stripe Checkout URL with user's email
- Text: "Upgrade to Pro — 100 scans/day"

## Manifest Changes

Add to `permissions`:
```json
"identity"
```

Add new section:
```json
"oauth2": {
  "client_id": "<google-cloud-client-id>.apps.googleusercontent.com",
  "scopes": ["email", "profile"]
}
```

### Google Cloud Console setup required
- Create project (or use existing)
- Enable Google Identity API
- Create OAuth 2.0 credentials (type: Chrome Extension)
- Use extension ID from Chrome Web Store Developer Dashboard

## Future Compatibility

Email is the universal identifier. Future platforms authenticate differently but resolve to the same email → same Supabase user:
- **Chrome extension**: `chrome.identity` → Google OAuth → email
- **Mobile app**: Google Sign-In SDK → email
- **Web app**: Supabase Auth with Google provider → email

## Roadmap (Out of Scope)
- Onboarding flow after first login
- Mobile app auth
- Web app auth
- Stripe customer portal (manage subscription, cancel, etc.)
