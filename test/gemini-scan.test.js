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
  assert.ok(Array.isArray(req.contents) && req.contents.length === 1, 'contents must have exactly one turn');
  assert.strictEqual(req.contents[0].role, 'user');
  const parts = req.contents[0].parts;
  const textPart = parts.find((p) => typeof p.text === 'string');
  assert.ok(textPart, 'text part missing');
  assert.strictEqual(textPart.text, buildGeminiPrompt());
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

test('buildGeminiRequest: throws when imageBase64 is missing', () => {
  assert.throws(() => buildGeminiRequest(),     /imageBase64 is required/);
  assert.throws(() => buildGeminiRequest(null), /imageBase64 is required/);
  assert.throws(() => buildGeminiRequest(''),   /imageBase64 is required/);
});

const { parseGeminiResponse } = require('../gemini-scan');

test('parseGeminiResponse: parses clean JSON', () => {
  const raw = '{"game":"Pokemon","card_name":"Charizard","ebay_sold_avg_eur":120}';
  assert.deepStrictEqual(parseGeminiResponse(raw),
    { game: 'Pokemon', card_name: 'Charizard', ebay_sold_avg_eur: 120 });
});

test('parseGeminiResponse: strips ```json markdown fences', () => {
  const raw = '```json\n{"card_name":"Pikachu","ebay_sold_avg_eur":15}\n```';
  const out = parseGeminiResponse(raw);
  assert.strictEqual(out.card_name, 'Pikachu');
  assert.strictEqual(out.ebay_sold_avg_eur, 15);
});

test('parseGeminiResponse: strips ``` fences without language tag', () => {
  const raw = '```\n{"card_name":"Mewtwo"}\n```';
  assert.strictEqual(parseGeminiResponse(raw).card_name, 'Mewtwo');
});

test('parseGeminiResponse: extracts first JSON object when surrounded by prose', () => {
  const raw = 'Here is the result:\n{"card_name":"Snorlax","ebay_sold_avg_eur":40}\nHope this helps.';
  assert.strictEqual(parseGeminiResponse(raw).card_name, 'Snorlax');
});

test('parseGeminiResponse: returns parse_failed on invalid JSON', () => {
  const out = parseGeminiResponse('not json at all');
  assert.strictEqual(out.error, 'parse_failed');
});

test('parseGeminiResponse: handles null/empty input', () => {
  assert.strictEqual(parseGeminiResponse('').error,   'parse_failed');
  assert.strictEqual(parseGeminiResponse(null).error, 'parse_failed');
});

test('parseGeminiResponse: passes through {error:"unidentified"}', () => {
  assert.deepStrictEqual(parseGeminiResponse('{"error":"unidentified"}'),
    { error: 'unidentified' });
});
