'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findStyleCodes } = require('../sneaker-id');

test('findStyleCodes: Nike modern code', () => {
  assert.deepStrictEqual(findStyleCodes('Nike Air Pegasus 2K5 Pearl Pink IB8873-666'), ['IB8873-666']);
});

test('findStyleCodes: Nike legacy code', () => {
  assert.deepStrictEqual(findStyleCodes('Air Jordan 1 Chicago 555088-101'), ['555088-101']);
});

test('findStyleCodes: New Balance code', () => {
  assert.deepStrictEqual(findStyleCodes("New Balance 9060 'Blue Haze' U9060FNB"), ['U9060FNB']);
});

test('findStyleCodes: adidas code', () => {
  assert.deepStrictEqual(findStyleCodes('adidas Samba OG Maroon ID0477'), ['ID0477']);
});

test('findStyleCodes: does NOT mistake a Nike prefix for an adidas code', () => {
  // "IB8873" is the prefix of "IB8873-666" — must not also be returned as an adidas code
  assert.deepStrictEqual(findStyleCodes('IB8873-666'), ['IB8873-666']);
});

test('findStyleCodes: no code returns empty array', () => {
  assert.deepStrictEqual(findStyleCodes('Nike running shoes'), []);
});

test('findStyleCodes: handles null/undefined', () => {
  assert.deepStrictEqual(findStyleCodes(null), []);
  assert.deepStrictEqual(findStyleCodes(undefined), []);
});

const { extractStyleCode } = require('../sneaker-id');
const pegasus = require('./fixtures/pegasus.json');
const jordan = require('./fixtures/jordan-1-low.json');
const nb9060 = require('./fixtures/nb-9060.json');
const samba = require('./fixtures/samba-og.json');

test('extractStyleCode: Pegasus fixture → correct SKU', () => {
  assert.strictEqual(extractStyleCode(pegasus.visualMatches).styleCode, 'IB8873-666');
});

test('extractStyleCode: Jordan 1 Low fixture → correct SKU (position-weighting beats lookalikes)', () => {
  // Flat voting picks the wrong "DD9315" Golf colorway; position-weighting must pick IQ9381-100.
  assert.strictEqual(extractStyleCode(jordan.visualMatches).styleCode, 'IQ9381-100');
});

test('extractStyleCode: New Balance 9060 fixture → correct SKU', () => {
  assert.strictEqual(extractStyleCode(nb9060.visualMatches).styleCode, 'U9060FNB');
});

test('extractStyleCode: Samba OG fixture → correct SKU', () => {
  assert.strictEqual(extractStyleCode(samba.visualMatches).styleCode, 'ID0477');
});

test('extractStyleCode: empty input → null', () => {
  assert.deepStrictEqual(extractStyleCode([]), { styleCode: null, score: 0 });
});
