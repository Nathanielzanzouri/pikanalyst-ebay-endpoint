#!/usr/bin/env node
/**
 * Diagnostic: run the full v4 pipeline locally — SKU basket + fallback + retailer augment.
 * Run: ( set -a; . ./.env; set +a; node scripts/diagnose-v4.js <scan-id> )
 */
const { createClient } = require('@supabase/supabase-js');
const { buildIdentity, buildShoppingQuery, filterBySku, medianOf, isMarketplace, extractCommonPhrase } = require('../sneaker-id');

const KEY = process.env.SERPAPI_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function lens(url) {
  const p = new URLSearchParams({ engine: 'google_lens', url, api_key: KEY, type: 'products' });
  return (await (await fetch('https://serpapi.com/search.json?' + p)).json()).visual_matches || [];
}
async function shopping(q) {
  const p = new URLSearchParams({ engine: 'google_shopping', q, api_key: KEY, num: '40' });
  return ((await (await fetch('https://serpapi.com/search.json?' + p)).json()).shopping_results || [])
    .filter((x) => x.extracted_price > 0)
    .map((x) => ({ title: x.title, price: x.extracted_price, source: x.source }));
}

(async () => {
  const { data } = await supabase.from('scan_logs').select('id,dom_title,cropped_image_url,image_url').in('id', process.argv.slice(2));
  for (const row of data) {
    console.log('\n' + '='.repeat(76));
    console.log('scan:', row.id, '|', row.dom_title);
    const vm = await lens(row.cropped_image_url || row.image_url);
    const id = buildIdentity(vm);
    console.log('identity:', JSON.stringify({ brand: id.brand, sku: id.styleCode, score: id.score, confident: id.confident }));
    if (!id.confident) { console.log('NOT CONFIDENT'); continue; }

    const skuQ = buildShoppingQuery(id);
    console.log('SKU query:', skuQ);
    const r1 = await shopping(skuQ);
    let basket = filterBySku(r1, id.styleCode);
    console.log(`  SKU basket: ${basket.length} (${r1.length} raw)`);

    if (basket.length < 2) {
      const fbQ = `${id.brand} ${id.styleCode}`;
      const r2 = await shopping(fbQ);
      const more = filterBySku(r2, id.styleCode);
      const seen = new Set(basket.map(c => c.title));
      for (const c of more) if (!seen.has(c.title)) { basket.push(c); seen.add(c.title); }
      console.log(`  + fallback "${fbQ}": basket now ${basket.length}`);
    }

    const phrase = extractCommonPhrase(vm);
    if (phrase && id.brand) {
      const nameQ = `${id.brand} ${phrase}`;
      console.log('  retailer query:', nameQ);
      const r3 = await shopping(nameQ);
      const retailers = r3.filter(c => !isMarketplace(c.source));
      const seen = new Set(basket.map(c => c.title));
      let added = 0;
      for (const c of retailers) if (!seen.has(c.title)) { basket.push(c); seen.add(c.title); added++; }
      console.log(`  + retailer augment added ${added} → basket now ${basket.length}`);
    }

    console.log('FINAL basket median:', medianOf(basket), '| size:', basket.length);
    console.log('sources breakdown:');
    const bySrc = {};
    for (const c of basket) { const k = isMarketplace(c.source) ? '[marketplace] ' + c.source : '[retailer]    ' + c.source; bySrc[k] = (bySrc[k] || 0) + 1; }
    for (const [k, v] of Object.entries(bySrc).sort((a,b) => b[1]-a[1])) console.log(`  ${k}: ${v}`);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
