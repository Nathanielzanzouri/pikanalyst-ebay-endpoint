'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildPrompt, buildRequest, validateIdentity, TOP_N_TITLES } = require('../ai-product-id');

// ─── buildPrompt ──────────────────────────────────────────────────────────────
test('buildPrompt: includes all provided titles, numbered', () => {
  const p = buildPrompt(['Nike SB Killshot 2 - ZALANDO.FR', 'Nike Chaussures Killshot 2 - Blanc']);
  assert.ok(p.includes('1. Nike SB Killshot 2 - ZALANDO.FR'));
  assert.ok(p.includes('2. Nike Chaussures Killshot 2 - Blanc'));
});

test('buildPrompt: declares the JSON schema fields the model must return', () => {
  const p = buildPrompt(['x']);
  for (const field of ['brand', 'model', 'variant', 'sku', 'category', 'query', 'confidence']) {
    assert.ok(p.includes(field), 'prompt should declare schema field: ' + field);
  }
});

// ─── buildRequest ─────────────────────────────────────────────────────────────
test('buildRequest: returns Gemini-shape request with structured-JSON output', () => {
  const r = buildRequest(['Nike SB Killshot 2']);
  assert.ok(Array.isArray(r.contents));
  assert.strictEqual(r.generationConfig.responseMimeType, 'application/json');
  assert.strictEqual(r.generationConfig.temperature, 0);
  // No reasoning tokens — pattern-extraction task, not reasoning
  assert.strictEqual(r.generationConfig.thinkingConfig.thinkingBudget, 0);
});

// ─── validateIdentity ─────────────────────────────────────────────────────────
test('validateIdentity: rejects when query is missing/empty', () => {
  assert.strictEqual(validateIdentity({ brand: 'Nike' }), null);
  assert.strictEqual(validateIdentity({ query: '' }), null);
  assert.strictEqual(validateIdentity({ query: '   ' }), null);
  assert.strictEqual(validateIdentity(null), null);
  assert.strictEqual(validateIdentity('not an object'), null);
});

test('validateIdentity: returns full normalized object on happy path', () => {
  const out = validateIdentity({
    brand: 'Nike', model: 'SB Killshot 2', variant: 'Beige', sku: null,
    category: 'sneaker', query: 'Nike SB Killshot 2 Beige', confidence: 'high',
  });
  assert.strictEqual(out.brand, 'Nike');
  assert.strictEqual(out.query, 'Nike SB Killshot 2 Beige');
  assert.strictEqual(out.confidence, 'high');
  assert.strictEqual(out.sku, null);
  assert.strictEqual(out._source, 'ai');
});

test('validateIdentity: defaults bad/missing confidence to "medium"', () => {
  const out = validateIdentity({ query: 'X', confidence: 'banana' });
  assert.strictEqual(out.confidence, 'medium');
  const out2 = validateIdentity({ query: 'X' });
  assert.strictEqual(out2.confidence, 'medium');
});

test('validateIdentity: defaults missing category to "other"', () => {
  const out = validateIdentity({ query: 'Coca Cola can' });
  assert.strictEqual(out.category, 'other');
});

test('validateIdentity: trims whitespace + nulls empty strings', () => {
  const out = validateIdentity({ brand: '  Nike  ', model: '', sku: '   ', query: 'Nike X' });
  assert.strictEqual(out.brand, 'Nike');
  assert.strictEqual(out.model, null);
  assert.strictEqual(out.sku, null);
});

// ─── TOP_N_TITLES alignment ──────────────────────────────────────────────────
test('TOP_N_TITLES matches the convention used by the rest of the pipeline (15)', () => {
  // sneaker-id.js uses topN=15 for extractStyleCode/extractBrand. Keeping these
  // aligned means the AI sees the same evidence the legacy path would.
  assert.strictEqual(TOP_N_TITLES, 15);
});
