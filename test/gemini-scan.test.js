'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildGeminiPrompt, buildGeminiRequest, parseGeminiResponse, mapToCardResult } = require('../gemini-scan');

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
  assert.deepStrictEqual(parseGeminiResponse(raw), { card_name: 'Snorlax', ebay_sold_avg_eur: 40 });
});

test('parseGeminiResponse: returns parse_failed on invalid JSON', () => {
  const out = parseGeminiResponse('not json at all');
  assert.strictEqual(out.error, 'parse_failed');
});

test('parseGeminiResponse: handles null/undefined/empty input', () => {
  assert.strictEqual(parseGeminiResponse('').error,        'parse_failed');
  assert.strictEqual(parseGeminiResponse(null).error,      'parse_failed');
  assert.strictEqual(parseGeminiResponse(undefined).error, 'parse_failed');
});

test('parseGeminiResponse: passes through {error:"unidentified"}', () => {
  assert.deepStrictEqual(parseGeminiResponse('{"error":"unidentified"}'),
    { error: 'unidentified' });
});

test('mapToCardResult: maps an identified card to CARD_RESULT shape', () => {
  const parsed = {
    game: 'Pokemon', card_name: 'Charizard ex', set_name: 'Obsidian Flames',
    card_number: '125/197', language: 'EN', rarity: 'Special Illustration',
    ebay_sold_avg_eur: 220, tcgplayer_price_eur: 245, pricecharting_price_eur: 210,
    notes: 'Sample of 30 sales over 90 days',
  };
  const out = mapToCardResult(parsed);
  assert.strictEqual(out.card_name,         'Charizard ex');
  assert.strictEqual(out.set_name,          'Obsidian Flames');
  assert.strictEqual(out.card_number,       '125/197');
  assert.strictEqual(out.language,          'EN');
  assert.strictEqual(out.card_game,         'Pokemon');
  assert.strictEqual(out.market_price,      220);    // drives the verdict
  assert.strictEqual(out.market_price_usd,  220);    // alias used by renderer
  assert.strictEqual(out.tcg_player_price,  245);
  assert.strictEqual(out.cardmarket_price,  210);    // PriceCharting goes in the cardmarket slot
  assert.deepStrictEqual(out.listings,      []);     // Gemini does not return listings
  assert.strictEqual(out.ebay_sales_count,  0);
  assert.strictEqual(out._engine,           'gemini');
  assert.strictEqual(out._geminiError,      null);
  assert.strictEqual(out._geminiNotes,      'Sample of 30 sales over 90 days');
});

test('mapToCardResult: passes through {error:"unidentified"} and zeroes-out as null', () => {
  const out = mapToCardResult({ error: 'unidentified' });
  assert.strictEqual(out.card_name,        null);
  assert.strictEqual(out.market_price,     null);
  assert.strictEqual(out._engine,          'gemini');
  assert.strictEqual(out._geminiError,     'unidentified');
  assert.strictEqual(out.ebay_sales_count, null,
    'error path must distinguish "could not try" (null) from "tried, none" (0)');
});

test('mapToCardResult: passes through parse_failed and zeroes-out as null', () => {
  const out = mapToCardResult({ error: 'parse_failed' });
  assert.strictEqual(out._geminiError,     'parse_failed');
  assert.strictEqual(out.card_name,        null);
  assert.strictEqual(out.ebay_sales_count, null);
});

test('mapToCardResult: identified card has ebay_sales_count: 0 (we tried, Gemini does not return a count)', () => {
  const out = mapToCardResult({ game: 'Pokemon', card_name: 'Pikachu', ebay_sold_avg_eur: 12 });
  assert.strictEqual(out.ebay_sales_count, 0);
  assert.strictEqual(out._geminiError,     null);
});

test('mapToCardResult: null-safe on missing optional fields', () => {
  const out = mapToCardResult({ game: 'YuGiOh', card_name: 'Blue-Eyes' });
  assert.strictEqual(out.card_name,         'Blue-Eyes');
  assert.strictEqual(out.set_name,          null);
  assert.ok(!Object.prototype.hasOwnProperty.call(out, 'ebay_sold_avg_eur'),
    'raw Gemini field name should not leak into the CARD_RESULT shape');
  assert.strictEqual(out.market_price,      null);
  assert.strictEqual(out.tcg_player_price,  null);
  assert.strictEqual(out.cardmarket_price,  null);
});

test('mapToCardResult: handles null/undefined input gracefully', () => {
  const out1 = mapToCardResult(null);
  const out2 = mapToCardResult(undefined);
  assert.strictEqual(out1.card_name,    null);
  assert.strictEqual(out1._engine,      'gemini');
  assert.strictEqual(out2.card_name,    null);
  assert.strictEqual(out2._engine,      'gemini');
});
