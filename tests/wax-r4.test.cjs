'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.Recipe = require('../site/recipe.js');
const {Surface, Pigments} = require('../site/wax-paper.js');
const pigments = new Pigments();
const red = pigments.color('#722934'), yellow = pigments.color('#F4EC65');
const make = () => new Surface(160, 100, [248, 239, 220], pigments);
const mass = b => b.mass.reduce((sum, v) => sum + v, 0);
const fields = ['mass', 'bottomMass', 'topMass', 'cells', 'bottom', 'top'];
const snapshot = b => Object.fromEntries(fields.map(key => [key, b[key].slice()]));
const distance = (x, y, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
};
function connected(b, before) {
  const seen = new Uint8Array(b.mass.length), pending = [];
  before.mass.forEach((v, i) => { if (v && b.mass[i]) { seen[i] = 1; pending.push(i); } });
  for (let k = 0; k < pending.length; k++) {
    const i = pending[k], x = i % b.width, y = Math.floor(i / b.width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (x + dx < 0 || x + dx >= b.width || y + dy < 0 || y + dy >= b.height) continue;
      const n = (y + dy) * b.width + x + dx;
      if (b.mass[n] && !seen[n]) { seen[n] = 1; pending.push(n); }
    }
  }
  b.mass.forEach((v, i) => { if (v && !before.mass[i]) assert(seen[i], `detached new wax at ${i % b.width},${Math.floor(i / b.width)}`); });
}
test('push leaves wax amounts AND both layer colors outside the touched path unchanged, at EVERY input prefix', () => {
  const routes = [
    [{x: 55, y: 50}, {x: 65, y: 50}], // short early stop exposes old forward teleport
    [{x: 55, y: 50}, {x: 135, y: 50}],
    [{x: 70, y: 55}, {x: 115, y: 20}, {x: 125, y: 65}, {x: 60, y: 80}],
    [{x: 145, y: 50}, {x: 159, y: 90}, {x: 100, y: 90}],
  ];
  let changedInside = 0, newWax = 0;
  for (const strength of [.2, .31, .4, .55, .95]) for (const radius of [2, 7, 20, 35]) for (const route of routes) {
    const b = make();
    for (let y = 30; y <= 70; y++) for (let x = 20; x <= 149; x++) {
      // Connected body with occasional paper holes and a different top coat.
      if ((x * 17 + y * 13) % 23 === 0) continue;
      b.add(b.at(x, y), red, 40);
      if (x > 90) b.add(b.at(x, y), yellow, 40);
    }
    const before = snapshot(b), total = mass(b), segments = [];
    const settings = {tool: 'smudge', radius, strength, strokeId: b.beginStroke()};
    for (let k = 1; k < route.length; k++) {
      const a = route[k - 1], end = route[k], n = 8;
      let last = a;
      for (let step = 1; step <= n; step++) {
        const next = {x: a.x + (end.x - a.x) * step / n, y: a.y + (end.y - a.y) * step / n};
        b.stroke(last, next, settings); segments.push([last, next]); last = next;
        for (let i = 0; i < b.mass.length; i++) {
          const changed = fields.some(key => b[key][i] !== before[key][i]);
          if (!changed) continue;
          const x = i % b.width, y = Math.floor(i / b.width);
          assert(segments.some(([from, to]) => distance(x, y, from, to) <= radius),
            `outside touched prefix: ${x},${y}, radius=${radius}, pressure=${strength}`);
          changedInside++;
          if (!before.mass[i] && b.mass[i]) newWax++;
        }
        connected(b, before);
        assert(Math.abs(mass(b) - total) < .02, 'wax conserved including every connecting trail cell');
      }
    }
    if (strength <= .3) for (const key of fields) assert.deepEqual(b[key], before[key]);
  }
  assert(changedInside > 100 && newWax > 100, 'not a vacuous no-op push test');
});
test('medium/heavy soft wax fills core on first and repeated coats; light holes decrease; edge never diffuses', () => {
  for (const strength of [.2, .55, .95]) {
    const b = make(), holes = [];
    for (let pass = 0; pass < 3; pass++) {
      b.stroke({x: pass % 2 ? 140 : 20, y: 50}, {x: pass % 2 ? 20 : 140, y: 50},
        {tool: 'brush', pigment: red, radius: 13, strength, angle: 0, strokeId: b.beginStroke()});
      let empty = 0;
      for (let y = 43; y <= 57; y++) for (let x = 30; x <= 130; x++) empty += !b.cells[b.at(x, y)];
      holes.push(empty);
      if (strength >= .55) assert.equal(empty, 0);
      if (strength >= .55) {
        const anchor = snapshot(b);
        anchor.mass.fill(0);
        anchor.mass[b.at(80, 50)] = 1;
        connected(b, anchor); // ALL wax, including perimeter, connects to core.
      }
      for (let i = 0; i < b.mass.length; i++) if (b.mass[i]) {
        assert(distance(i % b.width, Math.floor(i / b.width), {x: 20, y: 50}, {x: 140, y: 50}) <= 13);
        assert.equal(b.cells[i], red);
      }
    }
    if (strength === .2) assert(holes[0] > holes[1] && holes[1] >= holes[2]);
  }
});
test('clear resets received-wax transport state, and new wax is not pushed repeatedly in one stroke', () => {
  const b = make();
  for (let y = 30; y <= 70; y++) for (let x = 20; x <= 65; x++) b.add(b.at(x, y), red, 40);
  b.stroke({x: 55, y: 50}, {x: 135, y: 50}, {tool: 'smudge', radius: 20, strength: .95, strokeId: b.beginStroke()});
  assert(b.receivedId.some(Boolean));
  assert(b.receivedBottom.some(Boolean));
  assert(!b.mass.some((v, i) => v && i % b.width >= 100),
    'same-stroke new deposits cannot be relayed to pointer endpoint 135');
  b.clear();
  for (const key of ['receivedId', 'receivedBottom', 'receivedTop', 'tail']) assert(b[key].every(v => v === 0));
  const large = new Surface(448, 274, b.ground, pigments);
  const radius = s => 448 * 96 / 1370 * (.46 + s * .72);
  large.stroke({x: .18 * 448, y: .77 * 274}, {x: .4 * 448, y: .77 * 274},
    {tool: 'brush', pigment: red, radius: radius(.9), strength: .9, angle: 0, strokeId: large.beginStroke()});
  const original = large.mass.slice();
  large.stroke({x: .34 * 448, y: .77 * 274}, {x: .75 * 448, y: .77 * 274},
    {tool: 'smudge', radius: radius(.95) * 1.55, strength: .95, strokeId: large.beginStroke()});
  let newMass = 0, front = 0;
  for (let i = 0; i < original.length; i++) if (!original[i] && large.mass[i]) {
    newMass += large.mass[i]; front = Math.max(front, i % large.width);
  }
  assert(newMass > 6000 && newMass < 7500, 'received-wax subtraction caps real-size tail mass');
  assert(front <= 265, 'received wax cannot extend the real-size front');
});
test('two-layer recolored receivers cannot relay red through the covered block', () => {
  for (const cover of [yellow, pigments.color('#FFFFFF')]) {
    const b = make(), edge = 65, radius = 20;
    for (let y = 30; y <= 70; y++) for (let x = 20; x <= 115; x++) {
      b.add(b.at(x, y), x <= edge || cover === yellow ? red : yellow, 40);
      if (x > edge) b.add(b.at(x, y), cover, 40);
    }
    const pigmentMass = () => b.mass.reduce((sum, _, i) => sum +
      [false, true].reduce((n, upper) => {
        const p = upper ? b.top[i] : b.bottom[i];
        const amount = upper ? b.topMass[i] : b.bottomMass[i];
        return n + amount * (p?.shares.find(([hex]) => hex === cover.shares[0][0])?.[1] || 0);
      }, 0), 0);
    const before = mass(b), coveredBefore = pigmentMass();
    b.stroke({x: 55, y: 50}, {x: 135, y: 50},
      {tool: 'smudge', radius, strength: .95, strokeId: b.beginStroke()});
    let changed = 0;
    for (let y = 30; y <= 70; y++) for (let x = edge + 1; x <= 115; x++) {
      const i = b.at(x, y);
      if (b.top[i] !== cover) {
        changed++;
        assert(x <= edge + 1.2 * radius, `covered pigment relayed to x=${x}, endpoint=135`);
      }
      if (x >= 100) {
        assert.equal(b.top[i], cover, 'remote path remains original covered color');
        assert(b.topMass[i] >= 32, 'remote original coat stays thick');
      }
    }
    assert(changed > 0, 'must exercise a real recolored receiver');
    // The fixed two-layer add approximation can replace a LOCAL old coat;
    // preserve >=88% of its pigment, counting spectral shares in both layers.
    assert(pigmentMass() >= coveredBefore * .88, 'covered pigment mass must be basically conserved');
    assert(Math.abs(mass(b) - before) < .02, 'total wax conservation');
  }
});
test('thin pushed tails share Canvas2D sampling; knife residuals stay solid until actually cleared', () => {
  const {createCanvas} = require('@napi-rs/canvas');
  const render = require('../site/wax-render.js');
  const b = make();
  for (let y = 30; y <= 70; y++) for (let x = 20; x <= 65; x++) b.add(b.at(x, y), red, 40);
  b.stroke({x: 55, y: 50}, {x: 135, y: 50},
    {tool: 'smudge', radius: 20, strength: .55, strokeId: b.beginStroke()});
  const canvas = createCanvas(b.width, b.height);
  render.flat(canvas, b).draw();
  const pixels = canvas.getContext('2d').getImageData(0, 0, b.width, b.height).data;
  let thin = 0;
  for (let i = 0; i < b.mass.length; i++) if (b.tail[i] && b.mass[i] < 4) {
    thin++;
    assert.deepEqual(b.rgbAt(i % b.width, Math.floor(i / b.width)),
      Array.from(pixels.slice(i * 4, i * 4 + 3)));
  }
  assert(thin > 0);
  b.clear();
  for (let y = 30; y <= 70; y++) for (let x = 20; x <= 140; x++) b.add(b.at(x, y), yellow, 40);
  for (let pass = 1; pass <= 3; pass++) {
    b.stroke({x: 35, y: 50}, {x: 125, y: 50},
      {tool: 'knife', radius: 20, strength: .55, strokeId: b.beginStroke()});
    render.flat(canvas, b).draw();
    assert.equal(b.tail[b.at(70, 50)], 0);
    if (pass < 3) {
      const rgb = Array.from(canvas.getContext('2d').getImageData(70, 50, 1, 1).data).slice(0, 3);
      assert.deepEqual(b.rgbAt(70, 50), yellow.rgb);
      assert(rgb[2] < 120, 'remaining yellow must not look like paper');
    } else assert.equal(b.cells[b.at(70, 50)], null);
  }
});
test('thin-tail picked hex matches the pigment used by paint-picked', () => {
  const b = make();
  for (let y = 30; y <= 70; y++) for (let x = 20; x <= 65; x++) b.add(b.at(x, y), red, 40);
  b.stroke({x: 55, y: 50}, {x: 135, y: 50},
    {tool: 'smudge', radius: 20, strength: .55, strokeId: b.beginStroke()});
  const i = b.mass.findIndex((v, i) => b.tail[i] && v > .15 && v < 1);
  assert(i >= 0, 'must pick a real pushed thin tail');
  const x = i % b.width, y = Math.floor(i / b.width);
  const hexOf = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  const rgb = b.rgbAt(x, y), hex = hexOf(rgb);
  const picked = {rgb, hex, pigment: b.pigmentAt(x, y, hex)};
  assert.equal(hexOf(picked.pigment.rgb), picked.hex);
  assert.equal(b.cells[i], red, 'sampling does not recolor the original wax');
  assert.notEqual(picked.pigment, red, 'thin display color is not full burgundy');
  const drawn = make();
  drawn.stroke({x: 30, y: 50}, {x: 100, y: 50},
    {tool: 'brush', pigment: picked.pigment, radius: 13, strength: .9, angle: 0, strokeId: drawn.beginStroke()});
  assert.equal(hexOf(drawn.rgbAt(65, 50)), picked.hex, 'new brush coat uses picked color');
  assert.equal(b.pigmentAt(40, 50, hexOf(red.rgb)), red, 'non-tail keeps original pigment');
  b.add(i, red, 10);
  assert.equal(b.pigmentAt(x, y, hexOf(red.rgb)), red, 'thick tail keeps original pigment');
  assert.deepEqual(b.pigmentAt(0, 0, hexOf(b.ground)).rgb, b.ground, 'blank keeps ground-color fallback');
});
test('light knife cannot make reduced thin-tail wax farther from paper color', () => {
  const b = new Surface(448, 274, [248, 239, 220], pigments);
  const radius = s => b.width * 96 / 1370 * (.46 + s * .72);
  b.stroke({x: .18 * b.width, y: .5 * b.height}, {x: .4 * b.width, y: .5 * b.height},
    {tool: 'brush', pigment: red, radius: radius(.9), strength: .9, angle: 0, strokeId: b.beginStroke()});
  b.stroke({x: .34 * b.width, y: .5 * b.height}, {x: .75 * b.width, y: .5 * b.height},
    {tool: 'smudge', radius: radius(.55) * 1.55, strength: .55, strokeId: b.beginStroke()});
  const fromPaper = rgb => Math.hypot(...rgb.map((v, c) => v - b.ground[c]));
  const tails = [];
  for (let i = 0; i < b.mass.length; i++) if (b.tail[i] && b.mass[i] < 4) {
    tails.push({i, mass: b.mass[i], distance: fromPaper(b.rgbAt(i % b.width, Math.floor(i / b.width)))});
  }
  assert.equal(tails.length, 285, 'same real-size pushed-tail reproduction');
  const blank = b.cells.map(cell => !cell);
  b.stroke({x: 212, y: 107}, {x: 212, y: 167},
    {tool: 'knife', radius: 19.5, strength: .2, strokeId: b.beginStroke()});
  let reduced = 0;
  for (const before of tails) {
    const {i} = before;
    assert.equal(b.tail[i], 1, 'knife sources and shaving receivers preserve existing tail');
    if (b.mass[i] >= before.mass) continue;
    reduced++;
    const after = fromPaper(b.rgbAt(i % b.width, Math.floor(i / b.width)));
    assert(after <= before.distance, `reduced tail at ${i % b.width},${Math.floor(i / b.width)} became more solid`);
  }
  assert(reduced > 0, 'must actually scrape thin-tail wax');
  const {createCanvas} = require('@napi-rs/canvas');
  const canvas = createCanvas(b.width, b.height);
  require('../site/wax-render.js').flat(canvas, b).draw();
  const pixels = canvas.getContext('2d').getImageData(0, 0, b.width, b.height).data;
  let thinShavings = 0, bodyShavings = 0;
  for (let i = 0; i < b.mass.length; i++) {
    if (!blank[i] || !b.cells[i]) continue;
    const rgb = b.rgbAt(i % b.width, Math.floor(i / b.width));
    const pixel = Array.from(pixels.slice(i * 4, i * 4 + 3));
    if (b.mass[i] < .15) {
      thinShavings++;
      assert(fromPaper(rgb) <= 70 && fromPaper(pixel) <= 70,
        `thin-tail shaving on blank paper at ${i % b.width},${Math.floor(i / b.width)} became solid`);
      assert.equal(b.tail[i], 1, 'thin-tail shavings on blank paper inherit optical thinning');
      assert.deepEqual(rgb, pixel, 'shaving sampling matches real Canvas2D display');
    } else if (b.mass[i] >= 3) {
      bodyShavings++;
      assert.equal(b.tail[i], 0, 'body shavings on blank paper remain non-tail');
      assert.deepEqual(rgb, red.rgb, 'body shavings keep full pigment color');
      assert(fromPaper(pixel) > 250, 'body shavings remain solid on Canvas2D');
    }
  }
  assert.equal(thinShavings, 7, 'exercise all seven thin-tail shaving reproduction cells');
  assert.equal(bodyShavings, 4, 'exercise all four thick-body shaving cells');
});
