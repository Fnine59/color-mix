'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.Recipe = require('../site/recipe.js');
const {Pigments, Surface} = require('../site/wax-paper.js');
const pigments = new Pigments();
const blue = pigments.color('#2063AD'), yellow = pigments.color('#F5EC67');
const make = () => new Surface(160, 100, [248, 239, 220], pigments);
const brush = (board, color, x1, x2, dry = false) => board.stroke({x: x1, y: 50}, {x: x2, y: 50}, {
  tool: 'brush', pigment: color, radius: 13, strength: .72, angle: 0, dry, strokeId: board.beginStroke(),
});
test('soft wax fills paper valleys, dry is still thinner and more open', () => {
  const wax = make(), dry = make();
  brush(wax, blue, 20, 140); brush(dry, blue, 20, 140, true);
  assert(wax.cells.filter(Boolean).length > dry.cells.filter(Boolean).length);
  assert(wax.mass.reduce((a, b) => a + b) > dry.mass.reduce((a, b) => a + b));
  assert(!wax.cells.some((cell, i) => !cell && i % 160 > 30 && i % 160 < 130 && Math.abs(Math.floor(i / 160) - 50) < 7));
});
test('cross coat is opaque, no intermediate color until a tool moves wax', () => {
  const b = make(); brush(b, yellow, 20, 140); brush(b, blue, 70, 110);
  assert.equal(b.cells.filter(p => p?.shares.length > 1).length, 0);
  const crop = b.cells.filter((_, i) => i % 160 >= 70 && i % 160 <= 110 && Math.abs(Math.floor(i / 160) - 50) < 10);
  assert(crop.includes(blue));
  // Medium wax now covers its core completely: yellow remains UNDER it,
  // rather than showing through fixed holes (the requested r4 change).
  assert(b.cells.includes(yellow));
  assert(b.bottom.some((p, i) => p === yellow && b.top[i] === blue));
});
for (const tool of ['smudge', 'knife']) {
  test(`${tool} conserves two-layer wax, preserves solid colors and is sample-density independent (r3)`, () => {
    const b = make(); brush(b, yellow, 20, 78); brush(b, blue, 81, 140);
    const sum = () => b.mass.reduce((a, v) => a + v, 0);
    const mass = sum(), counts = [];
    for (let pass = 0; pass < 6; pass++) {
      b.stroke({x: 58, y: 50}, {x: 117, y: 50}, {tool, radius: 18, strength: .95, strokeId: b.beginStroke()});
      counts.push(b.cells.filter(p => p?.shares.length > 1).length);
      assert(Math.abs(sum() - mass) / mass < 1e-5);
      if (pass === 0) {
        const contact = b.cells.filter((p, i) => p && i % 160 >= 70 && i % 160 <= 100
          && Math.abs(Math.floor(i / 160) - 50) <= 10);
        assert(contact.filter(p => p.shares.length > 1).length / contact.length < .55,
          'one push must not dissolve most of the contact region');
        assert(contact.includes(blue) && contact.includes(yellow),
          'pure shards must remain inside the pushed region');
      }
    }
    // R3 no longer mixes knife grooves; A moves finite solid shards and
    // mixes only at rare tail contacts, not an increasingly uniform smear.
    if (tool === 'knife') assert(counts.every(n => n === 0));
    for (const strength of (tool === 'smudge'
      ? [.31, .32, .33, .34, .35, .36, .37, .38, .39, .40, .55, .72, .95] : [.95])) {
      const sampled = [];
      for (const samples of [33, 128, 512]) {
        const board = new Surface(448, 274, [248, 239, 220], pigments);
        const line = (x1, x2, settings, n) => {
          let last = {x: x1 * 448, y: 137};
          for (let i = 1; i <= n; i++) {
            const next = {x: (x1 + (x2 - x1) * i / n) * 448, y: 137};
            board.stroke(last, next, settings); last = next;
          }
        };
        const paint = color => ({tool: 'brush', pigment: color, radius: 30.7,
          strength: .72, angle: 0, strokeId: board.beginStroke()});
        line(.14, .48, paint(yellow), 32); line(.50, .80, paint(blue), 32);
        line(.37, .73, {tool, radius: 30.7 * 1.55, strength, strokeId: board.beginStroke()}, samples);
        const mixed = board.cells.filter(p => p?.shares.length > 1).length;
        board.clear();
        line(.20, .42, paint(blue), 32);
        const original = board.cells.slice();
        line(.34, .69, {tool, radius: 30.7 * 1.55, strength, strokeId: board.beginStroke()}, samples);
        let front = 0, substantialFront = 0, colored = 0, thin = 0;
        board.cells.forEach((p, i) => {
          if (p) {
            colored++;
            if (board.mass[i] < .15) thin++;
            front = Math.max(front, i % 448);
          }
          if (board.mass[i] > 5) substantialFront = Math.max(substantialFront, i % 448);
        });
        assert(thin / colored < .02,
          `${tool} ${strength}: near-empty colored cells must stay below 2% after pushing`);
        if (tool === 'smudge' && strength <= .36) {
          assert.equal(board.cells.filter((p, i) => p && !original[i]).length, 0,
            `pressure ${strength}: newly colored cells must stay zero just above yield`);
        }
        sampled.push({mixed, front, substantialFront});
      }
      for (const result of sampled.slice(1)) {
        assert(Math.abs(result.mixed - sampled[0].mixed) / Math.max(1, sampled[0].mixed) < .05,
          `${tool}: mixed cells must not depend on pointer sample density`);
        assert(Math.abs(result.front - sampled[0].front) <= 2,
          `${tool}: trace front must not recede with dense samples`);
        assert(Math.abs(result.substantialFront - sampled[0].substantialFront) <= 2,
          `${tool}: mass > 5 front must not recede with dense samples`);
      }
    }
    const c = make(); brush(c, blue, 25, 60);
    const sideMass = (b, side) => {
      let sum = 0;
      for (let x = 50; x <= 90; x++) for (let offset = 2; offset <= 3; offset++) {
        sum += b.mass[b.at(x, 50 + side * offset)];
      }
      return sum;
    };
    const sidesBefore = [-1, 1].map(side => sideMass(c, side));
    const before = Math.max(...c.mass);
    c.stroke({x: 50, y: 50}, {x: 90, y: 50}, {tool, radius: 18, strength: .95, strokeId: c.beginStroke()});
    if (tool === 'smudge') assert(c.cells.some((p, i) => p && i % 160 > 74));
    else for (const [j, side] of [-1, 1].entries()) {
      assert(sideMass(c, side) > sidesBefore[j], `knife shavings increase side ${side}`);
    }
    if (tool === 'knife') assert(Math.max(...c.mass) > before, 'scraped wax piles beside the knife path');
  });
}
test('mix still matches the existing spectral.js recipe', () => {
  const mixed = pigments.blend(blue, yellow, .5);
  assert.deepEqual(mixed.rgb, Recipe.mix([{hex: '#2063AD'}, {hex: '#F5EC67'}], [1, 1]));
});
test('clear removes coats and a rapid sparse stroke has no disconnected gaps', () => {
  const b = make(); brush(b, blue, 10, 150);
  for (let x = 10; x <= 150; x++) assert(b.cells.some((p, i) => p && i % 160 === x));
  const push = {tool: 'smudge', radius: 18, strength: .72};
  b.stroke({x: 58, y: 50}, {x: 59, y: 50}, push);
  // Leave real transport marks, then a partial stroke remainder. Comparing
  // only cells/mass would miss stale moved IDs after strokeId restarts at 0.
  b.stroke({x: 58, y: 50}, {x: 85, y: 50}, {...push, strokeId: b.beginStroke()});
  b.beginStroke();
  b.stroke({x: 58, y: 50}, {x: 59, y: 50}, push);
  b.clear(); assert.equal(b.mass.reduce((a, v) => a + v), 0);
  assert(b.cells.every(p => !p));
  const fresh = make();
  const fields = ['cells', 'mass', 'bottom', 'top', 'bottomMass', 'topMass', 'moved'];
  const differences = () => {
    let count = 0;
    for (let i = 0; i < b.cells.length; i++) {
      if (fields.some(key => b[key][i] !== fresh[key][i])) count++;
    }
    return count + Number(b.transferCount !== fresh.transferCount);
  };
  assert.equal(differences(), 0, 'clear resets both layers, moved and transferCount (different cells/state)');
  // Refill via stamp, not brush/beginStroke: those would reset the remainder
  // themselves and mask a broken clear(). Replay from the same input point.
  for (const board of [b, fresh]) {
    board.stamp({x: 58, y: 50}, {pigment: blue, radius: 13, strength: .72, angle: 0});
    board.stroke({x: 59, y: 50}, {x: 62.5, y: 50}, push);
  }
  assert.equal(differences(), 0, 'a push after clear behaves like fresh paper (different cells/state)');
});
test('pushing off paper does not wrap to the other side', () => {
  const b = make();
  for (let i = 0; i < 30; i++) brush(b, i % 2 ? blue : yellow, 110, 150);
  b.stroke({x: 139, y: 50}, {x: 159, y: 50}, {tool: 'smudge', radius: 18, strength: .95});
  assert(!b.cells.some((p, i) => p && i % 160 < 90));
});
