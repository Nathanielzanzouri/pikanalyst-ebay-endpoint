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

// ─── StockX price via Algolia (server-side, no CORS issues) ──────────────────
const SX_ALGOLIA_APP = 'XW7SBCT9AD';
const SX_ALGOLIA_KEY = '6b5e76b49705eb9f51a06d3c82f7acee';

app.get('/stockx', async (req, res) => {
  const query = req.query.q;
  const slug  = req.query.slug;
  if (!query && !slug) return res.status(400).json({ error: 'Missing q or slug param' });

  const searchQuery = query || (slug ? slug.replace(/-/g, ' ') : '');
  try {
    const algoliaRes = await fetch(
      `https://${SX_ALGOLIA_APP}-dsn.algolia.net/1/indexes/products/query`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Algolia-Application-Id': SX_ALGOLIA_APP,
          'X-Algolia-API-Key': SX_ALGOLIA_KEY,
        },
        body: JSON.stringify({ params: `query=${encodeURIComponent(searchQuery)}&hitsPerPage=1&getRankingInfo=false` }),
      }
    );
    console.log('[StockX] Algolia status:', algoliaRes.status, '| query:', searchQuery);
    if (!algoliaRes.ok) {
      const txt = await algoliaRes.text();
      return res.status(502).json({ error: `Algolia ${algoliaRes.status}: ${txt.slice(0, 200)}` });
    }
    const ad = await algoliaRes.json();
    const hit = ad?.hits?.[0];
    if (!hit) return res.status(404).json({ error: 'No StockX result found' });

    const lowestAsk = hit.market?.lowestAsk ?? hit.lowest_ask ?? null;
    const lastSale  = hit.market?.lastSale  ?? hit.last_sale  ?? null;
    console.log('[StockX] hit:', hit.name ?? hit.title, '| ask:', lowestAsk, '| last:', lastSale);

    return res.json({
      name:       hit.name ?? hit.title ?? null,
      lowestAsk:  lowestAsk,
      lastSale:   lastSale,
      url:        hit.url ? `https://stockx.com/${hit.url}` : (slug ? `https://stockx.com/${slug}` : null),
      source:     'stockx_algolia',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`eBay endpoint listening on port ${PORT}`));
