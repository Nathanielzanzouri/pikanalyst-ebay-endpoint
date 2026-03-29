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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`eBay endpoint listening on port ${PORT}`));
