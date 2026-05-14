#!/usr/bin/env node
/**
 * One-off: create the Lakkot Pro & Power subscription products in Stripe.
 *
 * Run locally — your key never leaves your machine:
 *   STRIPE_SECRET_KEY=sk_live_xxx node scripts/create-stripe-products.js
 *
 * It is safe to re-run: existing products (matched by name) are reused
 * instead of duplicated. Prices are immutable in Stripe, so a matching
 * recurring price is reused if one already exists on the product.
 *
 * Output: the two price IDs to paste into STRIPE_PRICE_IDS in server.js.
 */

const Stripe = require('stripe');

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Missing STRIPE_SECRET_KEY env var.');
  console.error('Run: STRIPE_SECRET_KEY=sk_live_xxx node scripts/create-stripe-products.js');
  process.exit(1);
}
const stripe = new Stripe(key);

// name, monthly amount in cents, currency
const PLANS = [
  { key: 'pro',   name: 'Lakkot Pro',   amount: 999,  currency: 'eur' },
  { key: 'power', name: 'Lakkot Power', amount: 3999, currency: 'eur' },
];

async function findProductByName(name) {
  // Stripe has no name filter on list; page through active products.
  let starting_after;
  for (;;) {
    const page = await stripe.products.list({ limit: 100, active: true, starting_after });
    const hit = page.data.find((p) => p.name === name);
    if (hit) return hit;
    if (!page.has_more) return null;
    starting_after = page.data[page.data.length - 1].id;
  }
}

async function findRecurringPrice(productId, amount, currency) {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  return prices.data.find(
    (p) =>
      p.unit_amount === amount &&
      p.currency === currency &&
      p.recurring &&
      p.recurring.interval === 'month'
  ) || null;
}

async function ensurePlan({ name, amount, currency }) {
  let product = await findProductByName(name);
  if (product) {
    console.log(`  product exists: ${name} (${product.id})`);
  } else {
    product = await stripe.products.create({ name });
    console.log(`  product created: ${name} (${product.id})`);
  }

  let price = await findRecurringPrice(product.id, amount, currency);
  if (price) {
    console.log(`  price exists:   ${price.id}`);
  } else {
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: amount,
      currency,
      recurring: { interval: 'month' },
    });
    console.log(`  price created:  ${price.id}`);
  }
  return price.id;
}

(async () => {
  const mode = key.includes('_live_') ? 'LIVE' : 'TEST';
  console.log(`Stripe mode: ${mode}\n`);

  const result = {};
  for (const plan of PLANS) {
    console.log(`${plan.name}:`);
    result[plan.key] = await ensurePlan(plan);
    console.log('');
  }

  console.log('─'.repeat(50));
  console.log('Paste these into STRIPE_PRICE_IDS in server.js:\n');
  console.log(`  pro:   '${result.pro}',`);
  console.log(`  power: '${result.power}',`);
})().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
