'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseSoldDate } = require('../price-serpapi');

test('parseSoldDate: English "Jun 15, 2026"', () => {
  const ts = parseSoldDate('Jun 15, 2026');
  assert.strictEqual(new Date(ts).toISOString().slice(0, 10), '2026-06-15');
});

test('parseSoldDate: French "14 juin 2026"', () => {
  const ts = parseSoldDate('14 juin 2026');
  assert.strictEqual(new Date(ts).toISOString().slice(0, 10), '2026-06-14');
});

test('parseSoldDate: French "Vendu le 27 avr. 2026"', () => {
  const ts = parseSoldDate('Vendu le 27 avr. 2026');
  assert.strictEqual(new Date(ts).toISOString().slice(0, 10), '2026-04-27');
});

test('parseSoldDate: French "8 décembre 2025" with accents', () => {
  const ts = parseSoldDate('8 décembre 2025');
  assert.strictEqual(new Date(ts).toISOString().slice(0, 10), '2025-12-08');
});

test('parseSoldDate: French "Vendu le 31 août 2026"', () => {
  const ts = parseSoldDate('Vendu le 31 août 2026');
  assert.strictEqual(new Date(ts).toISOString().slice(0, 10), '2026-08-31');
});

test('parseSoldDate: null on empty / invalid', () => {
  assert.strictEqual(parseSoldDate(null), null);
  assert.strictEqual(parseSoldDate(''), null);
  assert.strictEqual(parseSoldDate('foobar'), null);
});

const { parseSerpListing } = require('../price-serpapi');

test('parseSerpListing: normal item with all fields', () => {
  const raw = {
    title: 'Carte Pokemon Mew ex SSR 327/190',
    link: 'https://www.ebay.fr/itm/12345',
    thumbnail: 'https://i.ebayimg.com/x.jpg',
    condition: 'Pre-Owned',
    price: { extracted: 28.5, raw: '28,50 EUR' },
    sold_date: 'Vendu le 27 avr. 2026',
    seller: { username: 'collect-avenue' },
    shipping_location: 'de France',
  };
  const out = parseSerpListing(raw);
  assert.strictEqual(out.title, raw.title);
  assert.strictEqual(out.price_orig, 28.5);
  assert.strictEqual(out.currency_orig, 'EUR');
  assert.strictEqual(out.item_url, raw.link);
  assert.strictEqual(out.image_url, raw.thumbnail);
  assert.strictEqual(out.seller_country, 'FR');
  assert.ok(out.sold_date_ts > 0);
});

test('parseSerpListing: currency parsed from raw price string', () => {
  const out = parseSerpListing({
    title: 'Pokemon X', link: 'https://x', thumbnail: 'h',
    price: { extracted: 100, raw: '100,00 USD' },
    sold_date: 'Jun 1, 2026',
  });
  assert.strictEqual(out.currency_orig, 'USD');
});

test('parseSerpListing: shipping_location "de Japon" → JP', () => {
  const out = parseSerpListing({
    title: 'x', link: 'h', thumbnail: 'h',
    price: { extracted: 10, raw: '10 EUR' },
    sold_date: 'Jun 1, 2026',
    shipping_location: 'de Japon',
  });
  assert.strictEqual(out.seller_country, 'JP');
});

test('parseSerpListing: shipping_location "de Royaume-Uni" → GB', () => {
  const out = parseSerpListing({
    title: 'x', link: 'h', thumbnail: 'h',
    price: { extracted: 10, raw: '10 GBP' },
    sold_date: 'Jun 1, 2026',
    shipping_location: 'de Royaume-Uni',
  });
  assert.strictEqual(out.seller_country, 'GB');
});

test('parseSerpListing: returns null when price missing', () => {
  assert.strictEqual(parseSerpListing({
    title: 'x', link: 'h', sold_date: 'Jun 1, 2026',
  }), null);
});

test('parseSerpListing: returns null when sold_date unparseable', () => {
  assert.strictEqual(parseSerpListing({
    title: 'x', link: 'h', price: { extracted: 10 }, sold_date: 'foobar',
  }), null);
});

test('parseSerpListing: returns null when link missing (no dedup key)', () => {
  assert.strictEqual(parseSerpListing({
    title: 'x', price: { extracted: 10 }, sold_date: 'Jun 1, 2026',
  }), null);
});

const { fetchEbaySerpApi } = require('../price-serpapi');

test('fetchEbaySerpApi: builds URL and parses response', async () => {
  process.env.SERPAPI_KEY = 'test-key';
  let capturedUrl = null;
  const mockFetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true, status: 200,
      json: async () => ({
        search_metadata: { ebay_url: 'https://www.ebay.fr/sch/i.html?_nkw=test&LH_Sold=1' },
        search_information: { total_results: 42 },
        organic_results: [{
          title: 'Pokemon X', link: 'https://www.ebay.fr/itm/1',
          thumbnail: 'https://img/1', condition: 'Pre-Owned',
          price: { extracted: 10, raw: '10,00 EUR' },
          sold_date: 'Jun 1, 2026', shipping_location: 'de France',
        }],
      }),
    };
  };
  const result = await fetchEbaySerpApi({ query: 'mew 327/190', language: 'JP', fetchImpl: mockFetch });
  assert.ok(capturedUrl.includes('engine=ebay'));
  assert.ok(capturedUrl.includes('show_only=Sold'));
  assert.ok(capturedUrl.includes('ebay_domain=ebay.fr'));
  assert.strictEqual(result.domain, 'ebay.fr');
  assert.strictEqual(result.listings.length, 1);
  assert.strictEqual(result.listings[0].price_orig, 10);
  assert.strictEqual(result.listings[0].seller_country, 'FR');
});

test('fetchEbaySerpApi: EN language → ebay.com', async () => {
  process.env.SERPAPI_KEY = 'test-key';
  let capturedUrl = null;
  const mockFetch = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ organic_results: [] }) };
  };
  await fetchEbaySerpApi({ query: 'pikachu 173/165', language: 'EN', fetchImpl: mockFetch });
  assert.ok(capturedUrl.includes('ebay_domain=ebay.com'));
});

test('fetchEbaySerpApi: throws on missing API key', async () => {
  delete process.env.SERPAPI_KEY;
  await assert.rejects(
    fetchEbaySerpApi({ query: 'x', language: 'FR' }),
    /SERPAPI_KEY missing/,
  );
  process.env.SERPAPI_KEY = 'test-key';
});

test('fetchEbaySerpApi: drops listings that fail parseSerpListing', async () => {
  process.env.SERPAPI_KEY = 'test-key';
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      organic_results: [
        { title: 'good', link: 'h1', price: { extracted: 10 }, sold_date: 'Jun 1, 2026' },
        { title: 'bad — no price', link: 'h2', sold_date: 'Jun 1, 2026' },
        { title: 'bad — no link', price: { extracted: 10 }, sold_date: 'Jun 1, 2026' },
      ],
    }),
  });
  const result = await fetchEbaySerpApi({ query: 'x', language: 'FR', fetchImpl: mockFetch });
  assert.strictEqual(result.listings.length, 1);
  assert.strictEqual(result.listings[0].title, 'good');
});
