#!/usr/bin/env node
/**
 * One-off: capture real Google Lens visual_matches for 4 known sneakers
 * and write them to test/fixtures/ as committed test data.
 *
 * Run:  ( set -a; . ./.env; set +a; node scripts/capture-lens-fixtures.js )
 */
const fs = require('fs');
const path = require('path');

const KEY = process.env.SERPAPI_KEY;
if (!KEY) { console.error('Missing SERPAPI_KEY'); process.exit(1); }

const SHOES = [
  { slug: 'pegasus',      sku: 'IB8873-666',
    url: 'https://cdn.sanity.io/images/pu5wtzfc/production/e66c98f63de2a21836ed7015c85f9783fa764df4-2000x2000.jpg/nike-air-pegasus-2k5-pearl-pink-ib8873-666-7.jpg' },
  { slug: 'jordan-1-low', sku: 'IQ9381-100',
    url: 'https://cdn.sanity.io/images/pu5wtzfc/production/282ee69133017dad4083ea78df94ed971e3bb256-3091x1932.jpg/air-jordan-1-low-white-metallic-silver-iq9381-100-5.jpg' },
  { slug: 'nb-9060',      sku: 'U9060FNB',
    url: 'https://cdn.sanity.io/images/pu5wtzfc/production/4d3fe9fd0dba64e03e9165bc18a33c34bc2e3ff3-1200x749.jpg' },
  { slug: 'samba-og',     sku: 'ID0477',
    url: 'https://cdn.sanity.io/images/pu5wtzfc/production/14ffe5d99018491f4376c1cb1a96673c8aa3e131-2400x1500.jpg' },
];

const outDir = path.join(__dirname, '..', 'test', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  for (const shoe of SHOES) {
    const p = new URLSearchParams({ engine: 'google_lens', url: shoe.url, api_key: KEY, type: 'products' });
    const res = await fetch('https://serpapi.com/search.json?' + p);
    const data = await res.json();
    const visualMatches = (data.visual_matches || []).slice(0, 15);
    const fixture = { slug: shoe.slug, expectedSku: shoe.sku, visualMatches };
    fs.writeFileSync(path.join(outDir, shoe.slug + '.json'), JSON.stringify(fixture, null, 2));
    console.log(`wrote test/fixtures/${shoe.slug}.json — ${visualMatches.length} matches`);
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
