'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildGeminiPrompt, buildGeminiRequest } = require('../gemini-scan');

test('buildGeminiPrompt: mentions all supported TCGs and the JSON contract', () => {
  const p = buildGeminiPrompt();
  for (const game of ['Pokemon', 'OnePiece', 'YuGiOh', 'MTG']) {
    assert.ok(p.includes(game), `prompt missing game: ${game}`);
  }
  for (const field of ['ebay_sold_avg_eur', 'tcgplayer_price_eur', 'pricecharting_price_eur', 'card_name', 'set_name', 'card_number']) {
    assert.ok(p.includes(field), `prompt missing JSON field: ${field}`);
  }
  assert.ok(/grounded\s+(web\s+)?search/i.test(p), 'prompt should require grounded search');
  assert.ok(/do not guess prices/i.test(p),       'prompt should forbid guessing');
});

test('buildGeminiRequest: wraps image + prompt and enables grounded search', () => {
  const req = buildGeminiRequest('BASE64DATA', 'image/jpeg');
  assert.strictEqual(req.contents[0].role, 'user');
  const parts = req.contents[0].parts;
  assert.ok(parts.some((p) => typeof p.text === 'string' && p.text.length > 100), 'text part missing');
  const img = parts.find((p) => p.inline_data);
  assert.ok(img,                                              'inline_data part missing');
  assert.strictEqual(img.inline_data.mime_type, 'image/jpeg');
  assert.strictEqual(img.inline_data.data,      'BASE64DATA');
  assert.ok(Array.isArray(req.tools) && req.tools.length > 0, 'tools array missing');
  assert.ok(req.tools.some((t) => t.google_search !== undefined), 'google_search tool missing');
});

test('buildGeminiRequest: defaults mime type to image/jpeg', () => {
  const req = buildGeminiRequest('XYZ');
  const img = req.contents[0].parts.find((p) => p.inline_data);
  assert.strictEqual(img.inline_data.mime_type, 'image/jpeg');
});
