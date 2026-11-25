const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCanvas} = require('@napi-rs/canvas');
const {Palette, WIDTH, HEIGHT} = require('../site/palette.js');
const R = require('../site/recipe.js'), M = require('../site/color-math.js');
const data = require('../site/data/kuelox.json');
const blue = data.colors.find(p => p.code === '718'), yellow = data.colors.find(p => p.code === '705');
const at = (x, y) => ({x, y}), cellAt = (p, x, y) => p.cells.get(Math.floor(y / 4) * (WIDTH / 4) + Math.floor(x / 4));
const mass = (p, hex) => [...p.cells.values()].reduce((n, c) => n + (c[hex.toLowerCase()] || 0), 0);
const ctx = () => createCanvas(WIDTH, HEIGHT).getContext('2d');
const delta = (a, b) => M.deltaE2000(M.rgbToLab(a), M.rgbToLab(b));
test('squeeze paints a round raised dab with exact pigment quantity', () => {
  const p = new Palette(), c = ctx(); p.begin();
  const dab = p.squeeze(blue, 160, 180, 1); p.commit(); p.renderPalette(c);
  assert.equal(dab.radius, 22); assert.ok(Math.abs(mass(p, blue.hex) - 1) < 1e-12);
  assert.equal(p.sample(c, 160, 180).hex, blue.hex.toUpperCase());
  assert.equal(p.sample(c, 190, 180).hex, '#EDE9DE');
  assert.ok([...p.cells.keys()].every(i => Math.hypot((i % 180 + .5) * 4 - 160, (Math.floor(i / 180) + .5) * 4 - 180) <= 22));
  assert.throws(() => p.squeeze({hex: 'invalid'}, 0, 0)); assert.throws(() => p.squeeze(blue, 0, 0, 0));
});
test('knife fully rubs two equal dabs close to existing model: blue plus yellow is green', () => {
  const p = new Palette(), c = ctx(), a = at(160, 180), b = at(300, 180);
  p.squeeze(blue, a.x, a.y); p.squeeze(yellow, b.x, b.y);
  for (let i = 0; i < 30; i++) {
    const swept = p.knife(a, b);
    p.knife(at(160, 164), at(300, 164), swept);
    p.knife(at(160, 196), at(300, 196), swept);
  }
  const expected = R.mix([blue, yellow], [1, 1]);
  p.renderPalette(c);
  for (const x of [160, 230, 300]) {
    const sampled = p.sample(c, x, 180).rgb;
    assert.ok(delta(sampled, expected) < 1, `${x}: ${sampled} vs ${expected}`);
    assert.ok(sampled[1] > sampled[0] && sampled[1] > sampled[2]);
  }
  assert.ok(Math.abs(mass(p, blue.hex) - 1) < 1e-10);
  assert.ok(Math.abs(mass(p, yellow.hex) - 1) < 1e-10);
});
test('knife uses only swept quantity, leaves unswept paint, and repeated passes homogenize streaks', () => {
  const p = new Palette(), a = at(160, 180), b = at(300, 180);
  p.squeeze(blue, 160, 180); p.squeeze(yellow, 300, 180, 4);
  const untouched = JSON.stringify(cellAt(p, 300, 214));
  p.knife(a, b);
  assert.equal(JSON.stringify(cellAt(p, 300, 214)), untouched);
  const left = () => p.mixed(cellAt(p, 160, 180)), right = () => p.mixed(cellAt(p, 300, 180));
  const firstDifference = delta(left(), right());
  assert.ok(firstDifference > 10);
  for (let i = 0; i < 24; i++) p.knife(a, b);
  assert.ok(delta(left(), right()) < firstDifference / 10);
  assert.ok(Math.abs(mass(p, yellow.hex) - 4) < 1e-10);
  // The large yellow dab is only partly swept, so the pooled ratio is not 1:4.
  const cell = cellAt(p, 230, 180);
  assert.ok(cell[yellow.hex.toLowerCase()] / cell[blue.hex.toLowerCase()] < 3);
});
test('dry brush two layers retains existing layered model, sampled color is rendered pixel', () => {
  const p = new Palette(), c = ctx(), a = at(80, 200), b = at(620, 200);
  p.brush(a, b, blue, .8, new Set(), 'dry'); p.renderPaper(c);
  const index = [...p.paper.keys()].find(i => p.paper.has(i));
  const x = index % (WIDTH / 2), y = Math.floor(index / (WIDTH / 2));
  const before = p.sample(c, x * 2, y * 2).rgb;
  const tooth = require('../site/palette.js').grain(x, y);
  const coverage = Math.max(1, Math.min(19, Math.round((.8 * .8 + tooth * .15) * 20)));
  p.brush(a, b, yellow, .8, new Set(), 'dry'); p.renderPaper(c);
  const after = p.sample(c, x * 2, y * 2);
  assert.deepEqual(after.rgb, R.layer([{rgb: before}, yellow], [20 - coverage, coverage]).map(Math.round));
  assert.equal(after.hex, M.rgbToHex(after.rgb).toUpperCase());
  assert.notEqual(after.hex, M.rgbToHex(before).toUpperCase());
  assert.ok(delta(after.rgb, R.mix([blue, yellow], [1, 1])) > 2);
});
test('dry programmatic paper texture: light strokes expose more paper; resampling does not double-layer', () => {
  const light = new Palette(), heavy = new Palette(), a = at(80, 100), b = at(620, 100);
  light.brush(a, b, blue, .15, new Set(), 'dry'); heavy.brush(a, b, blue, .95, new Set(), 'dry');
  assert.ok(light.paper.size < heavy.paper.size / 2);
  const once = JSON.stringify(heavy.encode().paper);
  const p = new Palette(), touched = p.brush(a, b, blue, .95, new Set(), 'dry');
  p.brush(b, a, blue, .95, touched, 'dry');
  assert.equal(JSON.stringify(p.encode().paper), once);
  const c = ctx(); light.renderPaper(c);
  const grains = new Set(Array.from({length: 20}, (_, i) => light.sample(c, i * 2, 0).hex));
  assert.ok(grains.size > 3);
});
test('default soft single layer is opaque: exposed paper drops from 12.71% dry to 0%', () => {
  const dry = new Palette(), soft = new Palette(), a = at(110, 120), b = at(600, 120);
  const area = dry.brush(a, b, blue, .75, new Set(), 'dry').size;
  soft.brush(a, b, blue, .75);
  assert.equal(area, 4092); assert.equal(dry.paper.size, 3572);
  for (const i of dry.brush(a, b, blue, .75, new Set(), 'dry')) assert.ok(soft.paper.has(i));
  const exposed = (area - dry.paper.size) / area;
  assert.ok(exposed > .12 && exposed < .13);
  const c = ctx(); soft.renderPaper(c);
  for (const i of soft.paper.keys()) {
    const sampled = soft.sample(c, (i % 360) * 2, Math.floor(i / 360) * 2).rgb;
    assert.ok(sampled.every((v, j) => Math.abs(v - M.hexToRgb(blue.hex)[j]) <= 6));
    assert.equal(soft.paper.get(i), parseInt(blue.hex.slice(1), 16)); // Lighting is not pigment.
  }
});
test('soft second layer mixes only a small amount of old paint with the existing rubbed model', () => {
  const p = new Palette(), c = ctx(), a = at(80, 200), b = at(620, 200);
  p.brush(a, b, blue, .8); p.brush(a, b, yellow, .8); p.renderPaper(c);
  const i = [...p.paper.keys()][0], x = i % 360, y = Math.floor(i / 360);
  const share = Math.round(12 + .2 * 10 + require('../site/palette.js').grain(x, y) * 3);
  const sampled = p.sample(c, x * 2, y * 2).rgb, tone = p.texture.get(i);
  const lit = rgb => rgb.map(v => Math.max(0, Math.min(255, Math.round(v) + tone)));
  assert.ok(share >= 12 && share <= 25);
  assert.deepEqual(sampled, lit(R.mix([blue, yellow], [share, 100 - share])));
  assert.notDeepEqual(sampled, lit(R.layer([blue, yellow], [share, 100 - share])));
});
test('soft light/heavy strokes have solid cores and continuous edges; resampling is idempotent', () => {
  const p = new Palette(), heavy = new Palette(), a = at(80, 100), b = at(620, 100);
  const touched = p.brush(a, b, blue, .15);
  heavy.brush(a, b, blue, .95);
  assert.ok(p.paper.size < heavy.paper.size); assert.ok(p.paper.size > heavy.paper.size * .9);
  for (let x = 80; x <= 620; x += 2) {
    const painted = [...p.paper.keys()].filter(i => i % 360 === x / 2).map(i => Math.floor(i / 360)).sort((a, b) => a - b);
    assert.ok(painted.length >= 15);
    assert.equal(painted.at(-1) - painted[0] + 1, painted.length); // No paper holes between the uneven edges.
  }
  const before = JSON.stringify(p.encode());
  p.brush(b, a, blue, .15, touched);
  assert.equal(JSON.stringify(p.encode()), before);
});
test('soft wax texture is subtle, follows horizontal/vertical/diagonal direction and has uneven outer edges', () => {
  const difference = (p, dx, dy) => {
    let total = 0, n = 0;
    for (let y = 100; y < 115; y++) for (let x = 100; x < 200; x++) {
      const i = y * 360 + x, j = (y + dy) * 360 + x + dx;
      if (p.texture.has(i) && p.texture.has(j)) { total += Math.abs(p.texture.get(i) - p.texture.get(j)); n++; }
    }
    assert.ok(n > 100); return total / n;
  };
  for (const [a, b, dx, dy] of [[at(80, 210), at(620, 210), 1, 0], [at(210, 80), at(210, 380), 0, 1],
    [at(80, 80), at(400, 400), 1, 1]]) {
    const p = new Palette(); p.brush(a, b, blue, .75);
    assert.ok(new Set(p.texture.values()).size > 6);
    assert.ok([...p.texture.values()].every(v => Math.abs(v) <= 6));
    assert.ok(difference(p, dx, dy) < difference(p, -dy, dx) / 2);
  }
  const p = new Palette(); p.brush(at(80, 210), at(620, 210), blue, .75);
  const topEdges = new Set();
  for (let x = 100; x < 300; x++) {
    const rows = [...p.paper.keys()].filter(i => i % 360 === x).map(i => Math.floor(i / 360));
    topEdges.add(Math.min(...rows));
    assert.equal(Math.max(...rows) - Math.min(...rows) + 1, rows.length);
  }
  assert.ok(topEdges.size > 1);
});
test('texture persists and undoes with paint; old canvases load without it; dry over soft clears its lighting', () => {
  const p = new Palette(), restored = new Palette(), c = ctx(), d = ctx(), a = at(80, 210), b = at(620, 210);
  p.begin(); p.brush(a, b, blue, .75); p.commit();
  restored.restore(JSON.parse(JSON.stringify(p.encode())));
  p.renderPaper(c); restored.renderPaper(d);
  assert.deepEqual(c.getImageData(0, 0, WIDTH, HEIGHT).data, d.getImageData(0, 0, WIDTH, HEIGHT).data);
  const old = p.encode(); delete old.texture; restored.restore(old); assert.equal(restored.texture.size, 0);
  const before = JSON.stringify(p.encode()), dry = new Palette(); dry.restore(old);
  dry.brush(a, b, yellow, .75, new Set(), 'dry');
  p.begin(); p.brush(a, b, yellow, .75, new Set(), 'dry'); p.commit();
  for (const [i, color] of dry.paper) if (color !== parseInt(blue.hex.slice(1), 16)) assert.ok(!p.texture.has(i));
  p.undo(); assert.equal(JSON.stringify(p.encode()), before);
  const invalid = {...p.encode(), texture: [[0, 99]]};
  assert.throws(() => p.restore(invalid)); assert.equal(JSON.stringify(p.encode()), before);
  p.clear(); assert.equal(p.texture.size, 0); p.undo(); assert.equal(JSON.stringify(p.encode()), before);
  p.undo(); assert.equal(p.texture.size, 0); assert.equal(p.paper.size, 0);
});
test('dry mode matches local 13302d4 state and rendered pixels for all pressures, one/two layers and resampling', () => {
  const {BaselinePalette, source} = require('./helpers/baseline-palette.cjs');
  const current = require('node:fs').readFileSync(require.resolve('../site/palette.js'), 'utf8');
  const body = (text, name) => text.slice(text.indexOf(`    ${name}(`), text.indexOf('    renderPalette(')).replace(`${name}(`, 'brush(');
  assert.equal(body(current, 'dryBrush'), body(source, 'brush'));
  const c = ctx(), d = ctx();
  for (const strength of [.05, .15, .65, .75, .95, 1]) {
    const before = new BaselinePalette(), dry = new Palette(), a = at(110, 120), b = at(600, 120);
    for (const paint of [blue, yellow]) {
      const oldTouched = before.brush(a, b, paint, strength);
      const newTouched = dry.brush(a, b, paint, strength, new Set(), 'dry');
      before.brush(b, a, paint, strength, oldTouched);
      dry.brush(b, a, paint, strength, newTouched, 'dry');
      assert.equal(JSON.stringify(dry.encode()), JSON.stringify(before.encode()));
      before.renderPaper(c); dry.renderPaper(d);
      assert.deepEqual(c.getImageData(0, 0, WIDTH, HEIGHT).data, d.getImageData(0, 0, WIDTH, HEIGHT).data);
    }
  }
});
test('squeeze and knife remain identical to 13302d4 including quantities and rendered palette', () => {
  const {BaselinePalette} = require('./helpers/baseline-palette.cjs');
  const old = new BaselinePalette(), next = new Palette(), c = ctx(), d = ctx();
  for (const p of [old, next]) {
    p.addRecipe({paints: [blue, yellow], parts: [1, 4]});
    for (let i = 0; i < 12; i++) p.knife(at(240, 210), at(480, 210));
  }
  assert.equal(JSON.stringify(next.encode()), JSON.stringify(old.encode()));
  old.renderPalette(c); next.renderPalette(d);
  assert.deepEqual(c.getImageData(0, 0, WIDTH, HEIGHT).data, d.getImageData(0, 0, WIDTH, HEIGHT).data);
});
test('recipe on palette preserves parts, larger parts have proportional area and radius squared', () => {
  const p = new Palette(), dabs = p.addRecipe({paints: [blue, yellow], parts: [1, 4]});
  assert.deepEqual(dabs.map(d => [d.code, d.parts, d.radius]), [['718', 1, 22], ['705', 4, 44]]);
  assert.ok(Math.abs(mass(p, blue.hex) - 1) < 1e-12); assert.ok(Math.abs(mass(p, yellow.hex) - 4) < 1e-12);
  const area = hex => [...p.cells.values()].filter(c => c[hex.toLowerCase()]).length;
  assert.ok(Math.abs(area(yellow.hex) / area(blue.hex) - 4) < .2);
  assert.equal(p.history.length, 1); p.undo(); assert.equal(p.cells.size, 0);
});
test('undo is one gesture, works for squeeze, knife, layering and clear; history bounded at 20', () => {
  const p = new Palette(); p.begin(); p.squeeze(blue, 100, 100); p.commit();
  const before = JSON.stringify(p.encode());
  p.begin(); for (let i = 0; i < 4; i++) p.knife(at(100, 100), at(300, 100)); p.commit();
  p.undo(); assert.equal(JSON.stringify(p.encode()), before);
  p.begin(); p.brush(at(100, 100), at(300, 100), blue); p.brush(at(300, 100), at(400, 100), yellow); p.commit();
  p.undo(); assert.equal(p.paper.size, 0);
  p.clear(); assert.equal(p.cells.size, 0); p.undo(); assert.equal(JSON.stringify(p.encode()), before);
  p.begin(); p.commit(); assert.equal(p.history.length, 1);
  for (let i = 0; i < 25; i++) { p.begin(); p.squeeze(blue, 100, 100); p.commit(); }
  assert.equal(p.history.length, 20);
});
test('local persistence restores both surfaces pixel-for-pixel; damaged state is rejected atomically', () => {
  const p = new Palette(), restored = new Palette(), c = ctx(), d = ctx();
  p.addRecipe({paints: [blue, yellow], parts: [1, 2]}); p.knife(at(240, 210), at(480, 210));
  p.brush(at(80, 200), at(620, 200), blue, .6);
  restored.restore(JSON.parse(JSON.stringify(p.encode())));
  p.renderPalette(c); restored.renderPalette(d);
  assert.deepEqual(c.getImageData(0, 0, WIDTH, HEIGHT).data, d.getImageData(0, 0, WIDTH, HEIGHT).data);
  p.renderPaper(c); restored.renderPaper(d);
  assert.deepEqual(c.getImageData(0, 0, WIDTH, HEIGHT).data, d.getImageData(0, 0, WIDTH, HEIGHT).data);
  assert.equal(restored.history.length, 0);
  const before = JSON.stringify(restored.encode());
  for (const invalid of [{v: 3}, {v: 1, cells: [[-1, {'#ffffff': 1}]], paper: []},
    {v: 1, cells: [[0, {'#ffffff': -1}]], paper: []}, {v: 1, cells: [], paper: [[0, NaN]]}])
    assert.throws(() => restored.restore(invalid));
  assert.equal(JSON.stringify(restored.encode()), before);
});
