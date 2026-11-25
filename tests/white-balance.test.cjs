const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const I = require('../site/image-input.js');
const M = require('../site/color-math.js');
const W = require('../site/white-balance.js');
const adapters = {createCanvas, decode: async file => loadImage(Buffer.from(await file.arrayBuffer()))};
const pointColor = (pixels, x, y) => M.averagePixels(W.regionAt(pixels, x, y).data);
function solid(rgb, width = 16, height = 16) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return {data, width, height};
}
test('neutral-reference gains operate in linear RGB and preserve reference luminance', () => {
  const rgb = [235, 222, 185], correction = W.coefficients(rgb);
  const correctedLin = M.rgb255ToLin(rgb).map((v, c) => v * correction.gains[c]);
  assert.ok(correctedLin.every(v => Math.abs(v - correction.luminance) < 1e-12));
  assert.ok(Math.abs(W.luminance(correctedLin) - W.luminance(M.rgb255ToLin(rgb))) < 1e-12);
  const gray = pointColor(W.apply(solid(rgb), correction), 8, 8);
  assert.ok(Math.max(...gray) - Math.min(...gray) < 1);
});
test('real yellow-cast PNG: neutral equalized and known color error substantially reduced', async () => {
  // Multiplicative yellow lighting with exactly unit Y on the gray block.
  const cast = [1.14, 1, (1 - 0.2126 * 1.14 - 0.7152) / 0.0722];
  const original = [[210, 210, 210], [60, 80, 155], [105, 65, 130]];
  const source = createCanvas(48, 16), ctx = source.getContext('2d');
  original.forEach((rgb, x) => {
    ctx.fillStyle = M.rgbToHex(M.linToRgb255(M.rgb255ToLin(rgb).map((v, c) => v * cast[c])));
    ctx.fillRect(x * 16, 0, 16, 16);
  });
  const loaded = await I.loadFile(new File([source.toBuffer('image/png')], 'yellow.png', {type: 'image/png'}), adapters);
  const correction = W.referenceAt(loaded.pixels, 8, 8), corrected = W.apply(loaded.pixels, correction);
  const gray = pointColor(corrected, 8, 8);
  assert.ok(Math.max(...gray) - Math.min(...gray) < 1);
  for (let i = 1; i < original.length; i++) {
    const before = M.deltaE2000(M.rgbToLab(pointColor(loaded.pixels, i * 16 + 8, 8)), M.rgbToLab(original[i]));
    const after = M.deltaE2000(M.rgbToLab(pointColor(corrected, i * 16 + 8, 8)), M.rgbToLab(original[i]));
    assert.ok(before > 5, `before=${before}`);
    assert.ok(after < 1 && after < before / 4, `before=${before}, after=${after}`);
  }
});
test('overexposed reference rejected even when only one pixel/channel is clipped', () => {
  assert.throws(() => W.coefficients([250, 230, 210]), /过曝/);
  assert.throws(() => W.coefficients([230, 255, 210]), /过曝/);
  const pixels = solid([225, 220, 200]);
  pixels.data[(4 * 16 + 4) * 4 + 2] = 255;
  assert.throws(() => W.referenceAt(pixels, 8, 8), /过曝/);
});
test('dark, strongly colored, transparent and invalid reference points rejected', () => {
  assert.throws(() => W.coefficients([30, 30, 30]), /太暗/);
  assert.throws(() => W.coefficients([240, 150, 80]), /太艳/);
  assert.throws(() => W.coefficients([NaN, 200, 200]), /无效/);
  const pixels = solid([225, 220, 200]); pixels.data[3] = 0;
  assert.throws(() => W.referenceAt(pixels, 0, 0), /透明/);
  assert.throws(() => W.regionAt(pixels, 16, 8), /图片内/);
  assert.throws(() => W.referenceAt(pixels, -1, 8), /图片内/);
  assert.throws(() => W.referenceAt(pixels, 8, 16), /图片内/);
});
test('reference takes a clipped-at-edge 9x9 linear average rather than a single pixel', () => {
  const pixels = solid([210, 205, 190]);
  pixels.data.set([230, 210, 180, 255], (8 * 16 + 8) * 4);
  const correction = W.referenceAt(pixels, 8, 8);
  assert.deepEqual(correction.region, {x: 4, y: 4, width: 9, height: 9});
  assert.ok(correction.reference[0] > 210 && correction.reference[0] < 211);
  assert.deepEqual(W.referenceAt(pixels, 0, 0).region, {x: 0, y: 0, width: 5, height: 5});
});
test('rendered and sampled correction identical; cancellation restores original without accumulation', () => {
  const original = solid([230, 217, 180]), snapshot = original.data.slice();
  const correction = W.referenceAt(original, 8, 8);
  const first = W.apply(original, correction), second = W.apply(original, correction);
  assert.deepEqual(first, second);
  assert.deepEqual(original.data, snapshot);
  const rendered = createCanvas(16, 16), ctx = rendered.getContext('2d');
  const frame = ctx.createImageData(16, 16); frame.data.set(first.data); ctx.putImageData(frame, 0, 0);
  assert.deepEqual([...ctx.getImageData(8, 8, 1, 1).data], [...W.regionAt(first, 8, 8).data]);
  assert.deepEqual(W.apply(original, null).data, snapshot);
  assert.throws(() => W.apply(original, {gains: [NaN, 1, 1]}), /系数无效/);
});
