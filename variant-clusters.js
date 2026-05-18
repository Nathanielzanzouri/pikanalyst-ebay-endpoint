'use strict';
// Variant cluster detection — groups eBay listings into price clusters and
// labels each cluster with the keyword that distinguishes its titles.
//
// Why: many OPCG (and some Pokemon) cards exist in multiple printings that
// share the same card number — base print, promo, parallel foil, championship
// finalist version, etc. — but have hugely different prices. Returning a
// single median across all of them is misleading. Instead we surface the
// clusters and let the user pick the variant they actually have.
//
// Algorithm:
//   1. Sort listings ascending by price.
//   2. Walk sorted prices — split into a new cluster when the gap between
//      consecutive prices exceeds GAP_MULTIPLIER× (default 3×).
//   3. For each cluster, extract the most-common distinguishing keyword
//      from listing titles ("Promo", "Parallel", "Championship", etc.).
//   4. Compute median + min + max per cluster.
//   5. Pick a representative thumbnail (first listing's imageUrl).
//   6. Drop clusters below MIN_CLUSTER_SIZE (default 2 — single listings
//      are too noisy to be a real "variant").

// Real OPCG/Pokemon variant price gaps tend to be 10×+ (base €5 → promo €50
// → Championship €500). A 3× threshold was splitting normal price scatter
// within the same variant (€1.50 base → €4.50 base = 3×, but same card).
// 5× is more conservative and matches real variant gaps in user testing.
const GAP_MULTIPLIER = 5;
const MIN_CLUSTER_SIZE = 2;

// Keyword → human-readable label. Order matters: more specific patterns first
// so "Manga Rare" doesn't match "Rare", "Championship Finalist" wins over
// plain "Championship", etc.
const VARIANT_PATTERNS = [
  { re: /\bfinalist\b/i,                         label: 'Finalist' },
  { re: /\bchampionship\b/i,                     label: 'Championship' },
  { re: /\b(one\s*piece\s*day|op\s*day)\b/i,     label: 'OP Day Promo' },
  { re: /\b(\d+(?:rd|th|st|nd)?\s*anniversary|anniversaire)\b/i, label: 'Anniversary' },
  { re: /\btreasure\s*campaign\b/i,              label: 'Treasure Campaign' },
  { re: /\bpremium\s*card\s*collection\b/i,      label: 'Premium Collection' },
  { re: /\bmanga\s*rare\b/i,                     label: 'Manga Rare' },
  { re: /\b(alt(?:ernate)?\s*art|alt\s*art|alternative\s*art)\b/i, label: 'Alt Art' },
  { re: /\bparallel\b/i,                         label: 'Parallel Foil' },
  { re: /\bpromo\b/i,                            label: 'Promo' },
  { re: /\bfoil\b/i,                             label: 'Foil' },
  { re: /\b(reprint|reimpression)\b/i,           label: 'Reprint' },
  { re: /\bevent\s*pack\b/i,                     label: 'Event Pack' },
  { re: /\bpre[-\s]*release\b/i,                 label: 'Pre-Release' },
  // PSA / CGC / etc. grades — used when graded scans return multiple grade clusters
  { re: /\bpsa\s*10\b/i,                         label: 'PSA 10' },
  { re: /\bpsa\s*9\.5\b/i,                       label: 'PSA 9.5' },
  { re: /\bpsa\s*9\b/i,                          label: 'PSA 9' },
  { re: /\bcgc\s*10\b/i,                         label: 'CGC 10' },
  { re: /\bcgc\s*9\.5\b/i,                       label: 'CGC 9.5' },
  { re: /\bbgs\s*10\b/i,                         label: 'BGS 10' },
  { re: /\bbgs\s*9\.5\b/i,                       label: 'BGS 9.5' },
  { re: /\bace\s*10\b/i,                         label: 'ACE 10' },
];

// Split listings into clusters based on price gaps.
function splitIntoClusters(listings, gapMultiplier = GAP_MULTIPLIER) {
  const valid = (listings || []).filter(l => l && typeof l.price === 'number' && l.price > 0);
  if (valid.length === 0) return [];
  const sorted = [...valid].sort((a, b) => a.price - b.price);
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].price;
    const curr = sorted[i].price;
    if (curr / prev >= gapMultiplier) {
      clusters.push([sorted[i]]);
    } else {
      clusters[clusters.length - 1].push(sorted[i]);
    }
  }
  return clusters;
}

// For a cluster of listings, find the most common distinguishing variant
// keyword across titles. Returns null if no pattern matches in enough titles.
function labelCluster(cluster) {
  if (!cluster || cluster.length === 0) return null;
  const titles = cluster.map(l => (l.title || '').toLowerCase());
  // Count how many titles match each pattern
  const counts = new Map();
  for (const { re, label } of VARIANT_PATTERNS) {
    const hits = titles.filter(t => re.test(t)).length;
    if (hits > 0) counts.set(label, hits);
  }
  if (counts.size === 0) return null;
  // Pick the label with the most hits (≥ half the cluster to be confident)
  let best = null, bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount) { best = label; bestCount = count; }
  }
  // If less than half the cluster shares the keyword, the label is weak — null
  return bestCount >= Math.ceil(cluster.length / 2) ? best : null;
}

// Compute median of a sorted-ascending list of numbers.
function median(sortedNums) {
  if (sortedNums.length === 0) return null;
  const mid = Math.floor(sortedNums.length / 2);
  return sortedNums.length % 2 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

// Main: returns an array of variant clusters with metadata. Empty array if
// only one meaningful cluster (no picker needed).
function clusterListings(listings, opts = {}) {
  const minSize = opts.minClusterSize ?? MIN_CLUSTER_SIZE;
  const clusters = splitIntoClusters(listings, opts.gapMultiplier);
  const variants = clusters
    .filter(c => c.length >= minSize)
    .map((cluster, idx) => {
      const prices = cluster.map(l => l.price).sort((a, b) => a - b);
      const repWithImage = cluster.find(l => l.imageUrl) || cluster[0];
      return {
        id:        'v' + idx,
        label:     labelCluster(cluster) || (idx === 0 ? 'Base' : 'Variant ' + (idx + 1)),
        price:     median(prices),
        priceMin:  prices[0],
        priceMax:  prices[prices.length - 1],
        count:     cluster.length,
        imageUrl:  repWithImage.imageUrl || null,
        sampleTitle: repWithImage.title || null,
        // Actual listings in this cluster — sidepanel uses these to filter
        // the listings panel when the user picks this variant.
        listings:  cluster,
      };
    })
    // Sort variants ascending by price for predictable UI ordering
    .sort((a, b) => a.price - b.price);
  // Only return variants if there are 2+ clusters AND the spread between
  // them is meaningful (max/min ≥ gapMultiplier). Otherwise the median
  // alone is a reasonable answer and the picker would just be noise.
  if (variants.length < 2) return [];
  const gap = (opts.gapMultiplier ?? GAP_MULTIPLIER);
  if (variants[variants.length - 1].price / variants[0].price < gap) return [];
  return variants;
}

module.exports = {
  GAP_MULTIPLIER,
  MIN_CLUSTER_SIZE,
  VARIANT_PATTERNS,
  splitIntoClusters,
  labelCluster,
  clusterListings,
};
