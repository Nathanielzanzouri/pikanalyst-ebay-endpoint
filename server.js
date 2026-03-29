const express = require('express');
const crypto  = require('crypto');

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  const { challenge_code } = req.query;

  if (challenge_code) {
    const hash = crypto
      .createHash('sha256')
      .update(challenge_code + process.env.VERIFICATION_TOKEN + process.env.ENDPOINT_URL)
      .digest('hex');

    return res.status(200).json({ challengeResponse: hash });
  }

  res.status(200).send('OK');
});

app.post('/', (req, res) => {
  res.status(200).send('OK');
});

app.get('/sneakers', async (req, res) => {
  const query = req.query.q;
  const size = req.query.size;
  if (!query) return res.status(400).json({ error: 'Missing query param q' });
  try {
    // Try multiple query variants — kicks.dev indexes "Air Jordan", not "Nike Air Jordan"
    const variants = [
      query,
      query.replace(/^Nike\s+/i, ''),
      query.replace(/^Adidas\s+/i, ''),
      query.replace(/^(Nike|Adidas|Jordan|New Balance|Asics|Puma|Reebok|Converse|Vans)\s+/i, ''),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    let product = null;
    for (const q of variants) {
      const searchRes = await fetch(
        `https://api.kicks.dev/v1/products/search?query=${encodeURIComponent(q)}&limit=1`,
        { headers: { 'x-api-key': process.env.KICKSDB_API_KEY } }
      );
      const searchData = await searchRes.json();
      product = searchData?.data?.[0];
      if (product) break;
    }
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const priceRes = await fetch(
      `https://api.kicks.dev/v1/products/${product.id}/prices${size ? `?size=${size}` : ''}`,
      { headers: { 'x-api-key': process.env.KICKSDB_API_KEY } }
    );
    const priceData = await priceRes.json();

    return res.json({
      name: product.title,
      brand: product.brand,
      thumbnail: product.image,
      sku: product.sku,
      stockxPrice: priceData?.data?.stockx?.price || null,
      goatPrice: priceData?.data?.goat?.price || null,
      requestedSize: size || null,
      source: 'kicksdb'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Market price: StockX Algolia → GOAT Algolia fallback ────────────────────
app.get('/stockx', async (req, res) => {
  const query = req.query.q;
  const slug  = req.query.slug;
  if (!query && !slug) return res.status(400).json({ error: 'Missing q or slug param' });

  const searchQuery = query || slug.replace(/-/g, ' ');

  // Method 1: StockX via Algolia (try DSN then main cluster)
  for (const host of ['xw7sbct9ad-dsn.algolia.net', 'xw7sbct9ad.algolia.net']) {
    try {
      const r = await fetch(`https://${host}/1/indexes/products/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Algolia-Application-Id': 'XW7SBCT9AD',
          'X-Algolia-API-Key': '6b5e76b49705eb9f51a06d3c82f7acee',
        },
        body: JSON.stringify({ params: `query=${encodeURIComponent(searchQuery)}&hitsPerPage=1` }),
        signal: AbortSignal.timeout(5000),
      });
      console.log('[/stockx] StockX Algolia', host, '→', r.status);
      if (r.ok) {
        const d = await r.json();
        const hit = d?.hits?.[0];
        const lowestAsk = hit?.market?.lowestAsk ?? hit?.lowest_ask ?? null;
        const lastSale  = hit?.market?.lastSale  ?? hit?.last_sale  ?? null;
        if (lowestAsk != null || lastSale != null) {
          return res.json({ lowestAsk, lastSale, name: hit.name ?? hit.title ?? null, source: 'stockx' });
        }
      }
    } catch (e) { console.warn('[/stockx] StockX Algolia', host, 'failed:', e.message); }
  }

  // Method 2: GOAT via Algolia (similar market data, different source)
  try {
    const r = await fetch('https://2fwotdvm2o-dsn.algolia.net/1/indexes/product_variants_v2/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Algolia-Application-Id': '2FWOTDVM2O',
        'X-Algolia-API-Key': 'ac96de6a3afb9236e994f9c3c9a5ab9d',
      },
      body: JSON.stringify({ params: `query=${encodeURIComponent(searchQuery)}&hitsPerPage=1` }),
      signal: AbortSignal.timeout(5000),
    });
    console.log('[/stockx] GOAT Algolia →', r.status);
    if (r.ok) {
      const d = await r.json();
      const hit = d?.hits?.[0];
      const lowestAsk = hit?.lowest_listing_price_cents != null ? hit.lowest_listing_price_cents / 100 : null;
      const lastSale  = hit?.last_sold_price_cents      != null ? hit.last_sold_price_cents / 100      : null;
      console.log('[/stockx] GOAT hit:', hit?.name, '| ask:', lowestAsk, '| last:', lastSale);
      if (lowestAsk != null || lastSale != null) {
        return res.json({ lowestAsk, lastSale, name: hit.name ?? null, source: 'goat' });
      }
    }
  } catch (e) { console.warn('[/stockx] GOAT Algolia failed:', e.message); }

  return res.status(404).json({ error: 'Market price not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`eBay endpoint listening on port ${PORT}`));
