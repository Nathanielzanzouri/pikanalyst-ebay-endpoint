#!/usr/bin/env node
/**
 * Diagnostic: run the FULL new sneaker pipeline locally against real scan
 * images, and report exactly where results survive or die.
 *
 * Run: ( set -a; . ./.env; set +a; node scripts/diagnose-pipeline.js <id> <id> ... )
 */
const { createClient } = require('@supabase/supabase-js');
const { buildIdentity, buildShoppingQuery, filterBySku, medianOf } = require('../sneaker-id');

const KEY = process.env.SERPAPI_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ids = process.argv.slice(2);

async function lens(imageUrl) {
  const p = new URLSearchParams({ engine: 'google_lens', url: imageUrl, api_key: KEY, type: 'products' });
  const r = await fetch('https://serpapi.com/search.json?' + p);
  return (await r.json()).visual_matches || [];
}
async function shopping(q) {
  const p = new URLSearchParams({ engine: 'google_shopping', q, api_key: KEY, num: '40' });
  const r = await fetch('https://serpapi.com/search.json?' + p);
  return ((await r.json()).shopping_results || [])
    .filter((x) => x.extracted_price > 0)
    .map((x) => ({ title: x.title, price: x.extracted_price, source: x.source }));
}

(async () => {
  const { data } = await supabase.from('scan_logs').select('id,dom_title,cropped_image_url,image_url').in('id', ids);
  for (const row of data || []) {
    console.log('\n' + '='.repeat(76));
    console.log('scan:', row.id);
    console.log('dom_title:', row.dom_title);
    const img = row.cropped_image_url || row.image_url;
    const vm = await lens(img);
    console.log('lens visual_matches:', vm.length);

    const id = buildIdentity(vm);
    console.log('buildIdentity →', JSON.stringify({ brand: id.brand, styleCode: id.styleCode, score: id.score, confident: id.confident }));
    console.log('  referenceTitle:', id.referenceTitle);

    if (!id.confident) {
      console.log('  >> NOT CONFIDENT → falls to loose path');
      continue;
    }
    const q = buildShoppingQuery(id);
    console.log('shopping query:', JSON.stringify(q));
    const raw = await shopping(q);
    console.log('raw shopping results (priced):', raw.length);
    const basket = filterBySku(raw, id.styleCode);
    console.log('after filterBySku (title contains ' + id.styleCode + '):', basket.length);
    console.log('basket median:', medianOf(basket), '| need >= 3 to show a result');
    raw.slice(0, 12).forEach((c) => {
      const hit = filterBySku([c], id.styleCode).length ? 'KEEP' : '  - ';
      console.log(`  [${hit}] ${String(c.price).padEnd(8)} ${(c.source || '').slice(0, 14).padEnd(14)} ${(c.title || '').slice(0, 50)}`);
    });
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
