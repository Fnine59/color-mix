const {test} = require('node:test');
const assert = require('node:assert/strict');
const data = require('../site/data/kuelox.json');
const R = require('../site/recipe.js');
const M = require('../site/color-math.js');
const palette = data.colors;
const byCode = code => palette.find(p => p.code === code);

test('237 unique, complete official swatches; typed materials and variants', () => {
  assert.equal(palette.length, 237);
  assert.equal(new Set(palette.map(p => p.code)).size, 237);
  assert.deepEqual(data.missingCodes, []);
  for (const p of palette) {
    assert.match(p.hex, /^#[A-F0-9]{6}$/);
    assert.ok(p.nameEn && p.nameZh && p.family && p.products.length && p.variants.length);
    assert.equal(p.materialType, 'oil-pastel');
  }
});
test('palette single target recommends itself with ΔE00 < 0.5', () => {
  const p = byCode('644');
  const result = R.solve(palette, M.hexToRgb(p.hex));
  assert.equal(result.recipes[0].paints[0].code, p.code);
  assert.equal(result.recipes[0].paints.length, 1);
  assert.ok(result.recipes[0].de < 0.5);
});
test('two-stick 3:7 synthetic target recovers sticks and share within 10%', () => {
  const paints = [byCode('644'), byCode('703')];
  const target = R.mix(paints, [3, 7]);
  const result = R.solve(paints, target);
  const best = result.recipes[0];
  assert.equal(best.paints.length, 2);
  const index = best.paints.findIndex(p => p.code === paints[0].code);
  assert.ok(Math.abs(best.parts[index] / best.parts.reduce((a, b) => a + b, 0) - 0.3) <= 0.1);
  assert.ok(best.de < 0.5);
});
test('3:7 source pair is recovered even with all 237 sticks enabled', () => {
  const paints = [byCode('644'), byCode('703')], target = R.mix(paints, [3, 7]);
  const best = R.solve(palette, target).recipes[0];
  assert.deepEqual(best.paints.map(p => p.code).sort(), ['644', '703']);
  const index = best.paints.findIndex(p => p.code === '644');
  assert.ok(Math.abs(best.parts[index] / best.parts.reduce((a, b) => a + b, 0) - 0.3) <= 0.1);
});
test('blue plus yellow rubbed model is green (negative a*, positive b*)', () => {
  const green = R.mix([byCode('644'), byCode('704')], [1, 1]);
  const lab = M.rgbToLab(green);
  assert.ok(lab[1] < -5 && lab[2] > 5, `${green}: ${lab}`);
});
test('unreachable fluorescent magenta clearly rejected with full 237 palette', () => {
  const result = R.solve(palette, [255, 0, 255]);
  assert.ok(result.unreachable);
  assert.ok(result.recipes[0].de > R.UNREACHABLE_DE);
});
test('fast KM path agrees with original spectral.js to the byte', () => {
  const paints = [byCode('644'), byCode('703'), byCode('736')];
  for (const parts of [[3, 7, 1], [1, 1, 1], [1, 8, 11], [17, 2, 1]])
    assert.deepEqual(R.fastMix(R.prepare(paints), parts), R.mix(paints, parts));
});
test('linear average black + white = #bcbcbc, not #808080', () => {
  assert.equal(M.rgbToHex(M.averagePixels([0, 0, 0, 255, 255, 255, 255, 255])), '#bcbcbc');
  assert.equal(M.rgbToHex(M.averagePixels([0, 0, 0, 0])), '#ffffff');
  assert.throws(() => M.averagePixels([]));
});
test('CIEDE2000 Sharma reference pair, symmetry and neutral cases', () => {
  const a = [50, 2.6772, -79.7751], b = [50, 0, -82.7485];
  assert.ok(Math.abs(M.deltaE2000(a, b) - 2.0425) < 0.0001);
  assert.ok(Math.abs(M.deltaE2000(a, b) - M.deltaE2000(b, a)) < 1e-10);
  assert.equal(M.deltaE2000([50, 0, 0], [50, 0, 0]), 0);
});
test('layer coverage differs from rubbed prediction; output always bounded', () => {
  const paints = [byCode('644'), byCode('703')];
  assert.notDeepEqual(R.layer(paints, [1, 1]), R.mix(paints, [1, 1]));
  for (const rgb of [R.layer(paints, [3, 7]), R.mix(paints, [3, 7])])
    assert.ok(rgb.every(v => Number.isFinite(v) && v >= 0 && v <= 255));
});
test('empty selection, one owned stick, and invalid targets', () => {
  assert.equal(R.solve([], [123, 120, 100]).recipes.length, 0);
  const one = R.solve([byCode('644')], [20, 60, 90]);
  assert.equal(one.recipes.length, 1);
  assert.ok(one.recipes.every(v => v.paints.every(p => p.code === '644')));
  assert.throws(() => R.solve(palette, [NaN, 0, 0]));
});
test('top three offer different stick counts; near-match uses fewer sticks ahead of slightly lower ΔE00', () => {
  const result = R.solve(palette, [110, 130, 85]);
  assert.equal(result.recipes.length, 3);
  assert.equal(new Set(result.recipes.map(v => v.paints.map(p => p.code).join(','))).size, 3);
  assert.deepEqual(result.recipes.map(v => v.paints.length), [2, 3, 1]);
  assert.ok(result.recipes[0].de < 1);
  assert.ok(result.recipes[1].de < result.recipes[0].de);
  for (const recipe of result.recipes) {
    const paints = recipe.paints.map(p => byCode(p.code));
    assert.deepEqual(R.mix(paints, recipe.parts), recipe.rubbed);
  }
});
test('single-stick exact target retains both predictions as the stick itself', () => {
  const paint = byCode('704'), rgb = M.hexToRgb(paint.hex), best = R.solve(palette, rgb).recipes[0];
  assert.deepEqual(best.paints.map(p => p.code), ['704']);
  assert.deepEqual(best.parts, [1]); assert.equal(best.de, 0);
  assert.deepEqual(best.rubbed, rgb); assert.deepEqual(best.layered, rgb);
});
test('equal blue/yellow rubbed target still prefers the source pair when single-stick error exceeds 6', () => {
  const paints = [byCode('704'), byCode('718')], rgb = R.mix(paints, [1, 1]);
  const result = R.solve(palette, rgb), best = result.recipes[0];
  assert.deepEqual(best.paints.map(p => p.code), ['704', '718']);
  assert.deepEqual(best.parts, [1, 1]); assert.equal(best.de, 0);
  assert.deepEqual(result.recipes.map(v => v.paints.length).sort(), [1, 2, 3]);
});
test('sample #E7DF65 with classic 7-prefix scope recommends 704 alone at ΔE00 3.1052', () => {
  const result = R.solve(palette.filter(p => p.code.startsWith('7')), M.hexToRgb('#E7DF65'));
  assert.deepEqual(result.recipes[0].paints.map(p => p.code), ['704']);
  assert.deepEqual(result.recipes[0].parts, [1]);
  assert.ok(Math.abs(result.recipes[0].de - 3.1051746184360405) < 1e-9);
  assert.equal(result.recipes[0].description, '明显不同');
  assert.deepEqual(result.recipes.map(v => v.paints.length), [1, 2, 3]);
});
test('every extra stick requires at least ΔE00 3 improvement, including the exact boundary', () => {
  const candidate = (count, de, key = String(count)) => ({indices: Array(count).fill(0), de, key});
  const first = (...values) => R.selectCandidates(values)[0];
  const one = candidate(1, .9), two = candidate(2, .01), three = candidate(3, 0);
  assert.equal(first(three, two, one), one);
  assert.equal(first(candidate(1, 1), two, three).indices.length, 1);
  for (const count of [1, 2]) {
    const simple = candidate(count, 4), tooSmall = candidate(count + 1, 1.001), enough = candidate(count + 1, 1);
    assert.equal(first(simple, tooSmall), simple);
    assert.equal(first(simple, enough), enough);
  }
  const simple = candidate(1, 7), triple = candidate(3, 1);
  assert.equal(first(simple, candidate(3, 1.001)), simple);
  assert.equal(first(simple, triple), triple); // Two extras require 6, not just 3.
  assert.equal(first(candidate(1, 3.01), candidate(2, 2.99)).indices.length, 1); // No special tier shortcut.
});
test('two sticks win when one is >8 away but a 1:1 rubbed target is within 1', () => {
  const paints = [byCode('704'), byCode('718')], target = R.mix(paints, [1, 1]);
  const single = R.solve(paints, target, {maxPaints: 1});
  assert.ok(single.recipes[0].de > 8);
  const best = R.solve(paints, target).recipes[0];
  assert.deepEqual(best.paints.map(p => p.code), ['704', '718']);
  assert.deepEqual(best.parts, [1, 1]); assert.ok(best.de < 1);
});
test('nearby single pigments stay preferred over an exact pair when camera-scale improvement is <3', () => {
  const target = R.mix([byCode('705'), byCode('718')], [1, 1]);
  const result = R.solve(palette, target);
  assert.deepEqual(result.recipes[0].paints.map(p => p.code), ['633']);
  assert.ok(result.recipes[0].de < 3);
  assert.deepEqual(result.recipes[1].paints.map(p => p.code), ['705', '718']);
  assert.equal(result.recipes[1].de, 0);
});
test('selector retains best same-count choice, fills sparse palettes, handles limits and empty input', () => {
  const a = {indices: [0], de: 2, key: '0'}, b = {indices: [1], de: 1.8, key: '1'};
  assert.deepEqual(R.selectCandidates([a, b]), [b, a]);
  assert.deepEqual(R.selectCandidates([a, b], 1), [b]);
  assert.deepEqual(R.selectCandidates([]), []);
  const two = R.solve([byCode('704'), byCode('718')], [110, 130, 85], {maxPaints: 1});
  assert.equal(two.recipes.length, 2); assert.ok(two.recipes.every(v => v.paints.length === 1));
});
test('simplicity-first card does not falsely mark a better three-stick alternative unreachable', () => {
  const result = R.solve(['704', '718', '701'].map(byCode), [60, 90, 140]);
  assert.equal(result.recipes[0].paints.length, 2);
  assert.ok(result.recipes[0].de > R.UNREACHABLE_DE);
  assert.ok(result.recipes.some(v => v.de < R.UNREACHABLE_DE));
  assert.equal(result.unreachable, false);
});
