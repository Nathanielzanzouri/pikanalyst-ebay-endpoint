'use strict';
// ─── Product crop (observation mode) ─────────────────────────────────────────
// iPhone Shortcut scans send a full-screen screenshot — there is no scan zone
// like in the extension or the web app. This module asks Gemini where the
// product for sale sits in the screenshot and cuts that region out.
//
// OBSERVATION ONLY for now: the crop is stored in scan_logs.cropped_image_url
// so it can be reviewed in the admin "Avant / Après" tab. It is NOT sent to
// Lens and does not influence the scan result.
const sharp = require('sharp');

const PRODUCT_BOX_PROMPT = [
  'This is a phone screenshot from a shopping context (live auction stream, marketplace listing, photo).',
  'Find the single main product being shown or sold: a trading card (raw or in a graded slab), a sealed product, a sneaker, a bag, a watch, etc.',
  'If the product is partly covered by chat messages or buttons, still box the whole product.',
  'Ignore app UI, chat, avatars, thumbnails of other listings, and people.',
  'Return JSON only: {"found": true, "box_2d": [ymin, xmin, ymax, xmax]} with coordinates normalized to 0-1000,',
  'or {"found": false} when no product for sale is visible (chat conversation, video call, text document, home screen...).',
].join(' ');

function buildProductBoxRequest(imageBase64, mimeType) {
  if (!imageBase64) throw new TypeError('buildProductBoxRequest: imageBase64 is required');
  return {
    contents: [{
      role: 'user',
      parts: [
        { text: PRODUCT_BOX_PROMPT },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
      ],
    }],
    generationConfig: {
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
    },
  };
}

// Gemini answer → { ymin, xmin, ymax, xmax } in 0-1000, or null when there is
// no usable box (not found, malformed, degenerate).
function parseProductBox(parsed) {
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!obj || obj.found === false) return null;
  const b = obj.box_2d;
  if (!Array.isArray(b) || b.length !== 4) return null;
  const n = b.map(Number);
  if (n.some(v => !Number.isFinite(v))) return null;
  const clamp = v => Math.max(0, Math.min(1000, v));
  const [ymin, xmin, ymax, xmax] = n.map(clamp);
  if (ymax - ymin < 20 || xmax - xmin < 20) return null;   // < 2% of the screen: not a product
  return { ymin, xmin, ymax, xmax };
}

// Normalized box → pixel rectangle, with a margin so the crop never shaves the
// product's edges. Returns null when the crop would be (almost) the whole
// image — a "crop" that changes nothing is not worth storing.
function boxToPixels(box, width, height, marginRatio = 0.06) {
  if (!box || !width || !height) return null;
  const bw = (box.xmax - box.xmin) / 1000 * width;
  const bh = (box.ymax - box.ymin) / 1000 * height;
  const mx = bw * marginRatio, my = bh * marginRatio;
  const left = Math.max(0, Math.floor(box.xmin / 1000 * width - mx));
  const top = Math.max(0, Math.floor(box.ymin / 1000 * height - my));
  const right = Math.min(width, Math.ceil(box.xmax / 1000 * width + mx));
  const bottom = Math.min(height, Math.ceil(box.ymax / 1000 * height + my));
  const w = right - left, h = bottom - top;
  if (w < 8 || h < 8) return null;
  if ((w * h) / (width * height) > 0.9) return null;
  return { left, top, width: w, height: h };
}

async function cropToBox(imageBase64, box) {
  const buf = Buffer.from(imageBase64, 'base64');
  const meta = await sharp(buf).metadata();
  const rect = boxToPixels(box, meta.width, meta.height);
  if (!rect) return null;
  const out = await sharp(buf).extract(rect).jpeg({ quality: 90 }).toBuffer();
  return { base64: out.toString('base64'), rect, source: { width: meta.width, height: meta.height } };
}

module.exports = { PRODUCT_BOX_PROMPT, buildProductBoxRequest, parseProductBox, boxToPixels, cropToBox };
