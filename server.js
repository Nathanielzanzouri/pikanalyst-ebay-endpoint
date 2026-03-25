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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`eBay endpoint listening on port ${PORT}`));
