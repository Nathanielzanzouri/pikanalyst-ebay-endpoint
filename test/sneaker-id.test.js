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
