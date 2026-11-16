'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { buildProductBoxRequest, parseProductBox, boxToPixels, cropToBox } = require('../product-crop');

test('buildProductBoxRequest: carries the image and asks for JSON', () => {
  const req = buildProductBoxRequest('AAAA', 'image/jpeg');
  assert.strictEqual(req.contents[0].parts[1].inline_data.data, 'AAAA');
  assert.strictEqual(req.generationConfig.responseMimeType, 'application/json');
  assert.throws(() => buildProductBoxRequest(''), TypeError);
});

test('parseProductBox: valid box', () => {
  assert.deepStrictEqual(parseProductBox({ found: true, box_2d: [300, 150, 750, 850] }),
    { ymin: 300, xmin: 150, ymax: 750, xmax: 850 });
});

test('parseProductBox: array-wrapped answer and string numbers', () => {
  assert.deepStrictEqual(parseProductBox([{ box_2d: ['100', '200', '600', '800'] }]),
    { ymin: 100, xmin: 200, ymax: 600, xmax: 800 });
});

test('parseProductBox: clamps out-of-range coordinates', () => {
  assert.deepStrictEqual(parseProductBox({ box_2d: [-50, 100, 1200, 900] }),
    { ymin: 0, xmin: 100, ymax: 1000, xmax: 900 });
});

test('parseProductBox: not found / malformed / degenerate → null', () => {
  assert.strictEqual(parseProductBox({ found: false }), null);
  assert.strictEqual(parseProductBox({ found: true }), null);
  assert.strictEqual(parseProductBox({ box_2d: [1, 2, 3] }), null);
  assert.strictEqual(parseProductBox({ box_2d: [100, 100, 'x', 500] }), null);
  assert.strictEqual(parseProductBox({ box_2d: [500, 500, 505, 900] }), null);   // 0.5% tall
  assert.strictEqual(parseProductBox({ error: 'parse_failed' }), null);
  assert.strictEqual(parseProductBox(null), null);
});

test('boxToPixels: scales to pixels and adds a margin inside the image', () => {
  const r = boxToPixels({ ymin: 250, xmin: 250, ymax: 750, xmax: 750 }, 1000, 2000, 0.1);
  assert.deepStrictEqual(r, { left: 200, top: 400, width: 600, height: 1200 });
});

test('boxToPixels: margin never leaves the image', () => {
  const r = boxToPixels({ ymin: 0, xmin: 0, ymax: 500, xmax: 500 }, 200, 434, 0.2);
  assert.strictEqual(r.left, 0);
  assert.strictEqual(r.top, 0);
  assert.ok(r.left + r.width <= 200 && r.top + r.height <= 434);
});

test('boxToPixels: near-full-screen box → null (nothing to crop)', () => {
  assert.strictEqual(boxToPixels({ ymin: 10, xmin: 10, ymax: 990, xmax: 990 }, 200, 434), null);
});

test('cropToBox: cuts the expected region out of a real image', async () => {
  // 200x400 image: left half red, right half blue
  const red = await sharp({ create: { width: 100, height: 400, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const img = await sharp({ create: { width: 200, height: 400, channels: 3, background: '#0000ff' } })
    .composite([{ input: red, left: 0, top: 0 }]).jpeg().toBuffer();
  const out = await cropToBox(img.toString('base64'), { ymin: 250, xmin: 600, ymax: 750, xmax: 900 });
  assert.ok(out);
  const meta = await sharp(Buffer.from(out.base64, 'base64')).metadata();
  assert.strictEqual(meta.width, out.rect.width);
  assert.strictEqual(meta.height, out.rect.height);
  assert.ok(out.rect.left >= 100, 'crop sits in the blue half');
  const { data } = await sharp(Buffer.from(out.base64, 'base64')).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[2] > 200 && data[0] < 60, 'cropped pixels are blue');
  assert.deepStrictEqual(out.source, { width: 200, height: 400 });
});

test('cropToBox: full-screen box → null', async () => {
  const img = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  assert.strictEqual(await cropToBox(img.toString('base64'), { ymin: 0, xmin: 0, ymax: 1000, xmax: 1000 }), null);
});
