# Lovable prompt — graded PSA 10 / PSA 9 prices on card results

Copy-paste the block below into Lovable to add the graded-price display on the
web app. The backend endpoint is already live on the Render service.

---

Backend adds a follow-up endpoint on the Render service (same base URL the web
app already uses for scans):

`POST /scan/graded-prices`

Request body:
```json
{ "cardName": "string", "cardNumber": "string", "language": "FR|EN|JP|WORLD", "token": "string|null" }
```

Response:
```json
{
  "psa10": { "median": 120, "count": 8,  "currency": "EUR" },
  "psa9":  { "median": 45,  "count": 12, "currency": "EUR" }
}
```

- `median` is `null` when there are fewer than 2 graded sales → display **"—"**.
- HTTP `403 { "error": "upgrade_required" }` will happen only if the premium gate
  is turned on later — handle it by hiding the block (or showing an upgrade CTA).

**Task:** on the card result page, ONLY for a raw Pokémon card (`match_type === 'raw'`),
after the raw price renders, call this endpoint with the card's name / number /
language and display two lines under the raw price:

```
Raw     : 12 €
PSA 9   : 45 €      (or "…" while loading, "—" if median is null)
PSA 10  : 120 €
```

**Rules:**
- Non-blocking: the raw price must render first; the two graded lines fill in async.
- Do NOT call the endpoint for graded scans or non-Pokémon cards.
- Pass the signed-in user's token in the body (`null` if not signed in).
- Show me where the card result renders and the diff before applying.

---

## Notes for us (not for Lovable)
- The endpoint returns EUR medians (already normalised).
- Confidence threshold (count ≥ 2) is enforced server-side, so the web app just
  checks `median != null`.
- The extension uses the exact same contract — keep the two displays consistent.
- When we make this premium: set `GRADED_PRICES_PREMIUM_ONLY=true` on Render, then
  ask Lovable to render the 403 as an upgrade CTA instead of hiding the block.
