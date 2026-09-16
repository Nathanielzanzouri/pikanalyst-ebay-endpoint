# Design — Prix gradés PSA 10 / PSA 9 sur scan de carte raw

**Date :** 2026-09-16
**Statut :** design validé, prêt pour plan d'implémentation
**Auteur :** VP R&D (session Lakkot)

## 1. Problème / demande

Un utilisateur scanne une carte Pokémon **raw** (non gradée). Aujourd'hui Lakkot
affiche uniquement la cote **raw**. La demande : afficher **aussi** le prix de
revente de la **même carte** si elle était gradée **PSA 10** et **PSA 9**, pour
que le vendeur/acheteur voie le gain potentiel d'une gradation.

## 2. Scope v1 (validé)

- **Déclencheur :** scan d'une carte Pokémon **raw** uniquement (`match_type='raw'`,
  catégorie Pokémon). Si on scanne un slab déjà gradé → comportement actuel inchangé.
- **Graders :** PSA uniquement, grades **10** et **9**.
- **Affichage :** prix raw **instantané** (inchangé), puis PSA 10 / PSA 9 en
  **async** (~1-2 s après), remplis en arrière-plan.
- **Surfaces :** extension Chrome **et** web app (Lovable). Le backend renvoie les
  prix ; chaque front les affiche.
- **Hors scope v1 :** One Piece, autres graders (CGC/BGS…), scan de slabs gradés,
  cache des prix gradés.

## 3. Mécanisme (le cœur)

On réutilise l'identité de carte trouvée par le scan raw et on relance eBay 2 fois
avec le grade ajouté. Pour chaque grade, `handleCard` fait **deux** choses (déjà
implémentées, réutilisées telles quelles) :

1. **Ajoute le grade à la requête eBay** : `"<carte> PSA 10"`.
2. **Filtre les résultats** via `makeGradedTitleFilter({company:'PSA', grade:'10'})`
   pour ne garder que les annonces dont le titre est réellement PSA 10 — sinon la
   requête ramènerait aussi des PSA 9 / CGC / raw et la médiane serait fausse.

```
Scan raw          → query "Dracaufeu 223/197"          → médiane raw  (instantané)
+ PSA 10 (async)  → query "Dracaufeu 223/197 PSA 10"   → médiane PSA 10
+ PSA 9  (async)  → query "Dracaufeu 223/197 PSA 9"    → médiane PSA 9
```

## 4. Architecture — Approche A : endpoint de suivi

Nouvel endpoint **`POST /scan/graded-prices`** dans `ebay-endpoint/server.js`.
Le hot path `/scan` n'est **pas** modifié (feature 100 % additive).

Flux :

```
1. /scan → CARD_RESULT (raw) affiché instantanément                    [inchangé]
2. Front lit card_name + card_number + language du résultat
   (CARD_RESULT renvoie déjà card_name et card_number — vérifié)
3. Front → POST /scan/graded-prices { cardName, cardNumber, language }
4. Endpoint lance 2 requêtes eBay Browse EN PARALLÈLE (Promise.all) :
     handleCard(card, gradeFilter={company:'PSA', grade:'10'})
     handleCard(card, gradeFilter={company:'PSA', grade:'9'})
5. Renvoie { psa10, psa9 }
6. Front remplit les 2 lignes (ou "—" si pas de données)
```

Réutilise sans les modifier : `handleCard`, `makeGradedTitleFilter`, `removeOutliers`,
le calcul de médiane, `fetchEbayBrowse`.

### Subtilité critique — requête STRICTE, pas de cascade
On appelle **`handleCard` directement** (une seule requête stricte PSA 10, filtre PSA 10),
**PAS** `handleAnalyze` — car `handleAnalyze` déroule la cascade gradée
(strict → peer → peer-all → **raw fallback**). Si on utilisait la cascade et que
PSA 10 a 0 vente, elle retomberait sur le prix **raw** en l'étiquetant "PSA 10" → prix
FAUX. Règle : pour chaque grade, **une seule requête stricte** ; si 0 vente (ou
`count < 2`), on renvoie `median: null` — **jamais** de fallback vers un autre grade ni
vers le raw.

### Modules touchés
- `ebay-endpoint/server.js` — nouvel endpoint (isolé, ~40 lignes).
- `pikanalyst-extension/src/sidepanel.js` (+ `.html`/`.css`) — affichage des 2 lignes async.
- Web app Lovable — via prompt fourni (contrat d'endpoint).

## 5. Garde-fou cache (point critique)

`tryDbCache` et la table `ebay_sold_history` sont indexés sur
`(card_name, card_number, language)` — **sans le grade**. Si les requêtes gradées
écrivaient leurs ventes dans ce cache, elles **pollueraient la cote raw** (une PSA 10
à 120 € contaminerait le raw à 12 €).

**Décision (option a, validée) :** l'endpoint gradé interroge eBay **sans passer par
le cache** — ni lecture, ni écriture dans `ebay_sold_history`. Calcul de médiane à la
volée. Zéro risque de pollution du raw. Léger surcoût (pas de cache gradé) mais async
donc invisible pour l'utilisateur. Un cache gradé (clé suffixée par le grade) pourra
être ajouté plus tard si nécessaire.

**Implémentation :** ne pas router par `fetchEbayAny` (qui lit/écrit le cache) ;
appeler le chemin Browse direct pour les requêtes gradées, ou passer un flag
`skipCache` qui court-circuite `tryDbCache` + `upsertSoldHistory`.

## 6. Contrat de réponse

```json
{
  "psa10": { "median": 120.0, "count": 8,  "currency": "EUR" },
  "psa9":  { "median": 45.0,  "count": 12, "currency": "EUR" }
}
```

Règles :
- Aucune vente PSA pour la carte → `{ "median": null, "count": 0 }`.
- **Seuil de confiance :** afficher un prix seulement si `count >= 2`. En dessous,
  renvoyer `median: null` (le front affiche "—"). Évite un prix basé sur 1 vente.
- Devise : EUR (normalisée via `toEur`, comme le reste du pipeline).
- L'endpoint ne renvoie jamais d'erreur bloquante : si une requête échoue/timeout,
  ce grade retourne `{ median: null, count: 0 }` et l'autre reste valide.

## 7. Affichage

### Extension (`sidepanel.js`)
Sous le prix raw du `CARD_RESULT`, deux lignes qui apparaissent en async :
- état initial : `PSA 9 : …` / `PSA 10 : …` (chargement)
- valeur : `PSA 9 : 45 €` / `PSA 10 : 120 €`
- pas de données : `PSA 9 : —` / `PSA 10 : —`

Le front n'appelle l'endpoint que si le résultat est une carte Pokémon raw
(`match_type='raw'`). L'extension a déjà le pattern d'appel de suivi (`/scan/cardmarket`,
`/scan/timing`).

### Web app (Lovable)
Même contrat. Un prompt Lovable dédié sera fourni : appeler `POST /scan/graded-prices`
après le rendu du CARD_RESULT, afficher les 2 lignes avec les mêmes règles.

## 8. Non-régression / sécurité
- `/scan` et le pipeline cartes **ne sont pas touchés** — feature additive.
- Aucune écriture dans `ebay_sold_history` par le chemin gradé (garde-fou §5).
- Coût : 2 requêtes eBay Browse (API directe, **gratuite**, pas de SerpApi) par scan
  raw, en parallèle, async.
- Latence perçue : nulle sur le raw (async). L'endpoint gradé ~1-2 s.

## 9. Tests
1. **Carte à fort marché gradé** (ex. Charizard) → PSA 10 et PSA 9 remplis, médianes
   plausibles (PSA 10 > PSA 9 > raw).
2. **Carte commune sans marché gradé** → PSA 10/9 = "—" proprement (pas de crash, pas
   de faux prix).
3. **Non-pollution du raw** : scanner une carte, noter la cote raw ; déclencher
   l'endpoint gradé ; re-scanner la même carte → la cote raw est **identique**
   (preuve que le cache n'a pas été pollué).
4. **Filtre de grade** : vérifier que la médiane PSA 10 ne contient que des annonces
   PSA 10 (log des titres retenus).
5. **Résilience** : une requête grade qui timeout → l'autre grade s'affiche quand même.

## 10. Décisions ouvertes (à trancher au plan / plus tard)
- Persister psa10/psa9 dans `scan_logs` pour analytics (colonnes) — reporté v2.
- Cache gradé (clé + grade) — reporté v2.
- Étendre à One Piece / autres graders — reporté v2.
