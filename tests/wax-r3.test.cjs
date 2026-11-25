'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.Recipe = require('../site/recipe.js');
const {Surface, Pigments} = require('../site/wax-paper.js');
const pigments = new Pigments();
const red = pigments.color('#722934'), yellow = pigments.color('#F4EC65');
const green = pigments.blend(pigments.color('#2063AD'), yellow, .5);
const white = pigments.color('#FFFFFF');
const make = () => new Surface(160, 100, [248, 239, 220], pigments);
const total = b => b.bottomMass.reduce((a, v, i) => a + v + b.topMass[i], 0);
function block(b, pigment, left = 20, right = 65) {
  for (let y = 30; y <= 70; y++) for (let x = left; x <= right; x++) b.add(b.at(x, y), pigment, 40);
}
function tool(b, name, pressure, from = {x: 55, y: 50}, to = {x: 135, y: 50}) {
  b.stroke(from, to, {tool: name, radius: 20, strength: pressure, strokeId: b.beginStroke()});
}
test('drawing keeps first coat underneath, third replaces only the top, never mixes or carries old ink', () => {
  const b = make(); block(b, yellow);
  const paint = color => ({tool: 'brush', pigment: color, radius: 10, angle: 0, strength: .95, strokeId: b.beginStroke()});
  b.stroke({x: 30, y: 50}, {x: 60, y: 50}, paint(green));
  let layered = 0;
  for (let i = 0; i < b.cells.length; i++) if (b.top[i]) {
    layered++; assert.equal(b.bottom[i], yellow); assert.equal(b.bottomMass[i], 40);
    assert.equal(b.top[i], green); assert.equal(b.cells[i], green);
  }
  assert(layered > 300);
  b.stroke({x: 30, y: 50}, {x: 130, y: 50}, paint(white));
  for (let i = 0; i < b.cells.length; i++) {
    if (b.top[i] === white && i % 160 <= 65) assert.equal(b.bottom[i], yellow);
    if (i % 160 > 80 && b.cells[i]) assert.equal(b.cells[i], white);
  }
  // New stroke at clean paper also starts pure white.
  b.stroke({x: 100, y: 80}, {x: 140, y: 80}, paint(white));
  assert(b.cells.some((p, i) => p === white && Math.floor(i / 160) === 80));
});
test('heavy push loses exactly what the finite tail gains; light has a yield threshold; body stays >=80%', () => {
  const b = make(); block(b, red);
  const before = total(b), masses = b.mass.slice();
  tool(b, 'smudge', .2); assert.deepEqual(b.mass, masses);
  tool(b, 'smudge', .95);
  let lost = 0, gained = 0, front = 0;
  for (let i = 0; i < b.cells.length; i++) {
    if (masses[i]) {
      // Net loss of the ORIGINAL footprint, including internal redistribution.
      lost += masses[i] - b.mass[i];
      assert(b.mass[i] >= masses[i] * .80);
      assert.equal(b.cells[i], red);
    } else {
      gained += b.mass[i];
      if (b.mass[i]) front = Math.max(front, i % 160);
    }
  }
  assert(gained > 100); assert(lost > 100);
  assert(Math.abs(lost - gained) < .01);
  assert(Math.abs(total(b) - before) < .01);
  assert(front >= 80 && front < 100, 'tail stops well before pointer endpoint 135');
  const profile = x => b.mass.reduce((a, v, i) => a + (i % 160 === x ? v : 0), 0);
  assert(profile(70) > profile(85), 'short tail becomes thinner towards its end');
  // Mean of this originally blank tail region is only a threshold for
  // detached thick fragments below. It is NOT proof of an end or side rim.
  const tailMean = (left, right, y1, y2) => {
    let sum = 0, n = 0;
    for (let y = y1; y <= y2; y++) for (let x = left; x <= right; x++) {
      assert.equal(masses[b.at(x, y)], 0);
      sum += b.mass[b.at(x, y)]; n++;
    }
    return sum / n;
  };
  const adjacent = tailMean(75, 80, 40, 60);
  // Flood from the ORIGINAL body through 8-connected wax. Thick islands
  // cannot justify one another: only body-connected tail is an anchor.
  const connected = new Uint8Array(b.cells.length), pending = [];
  masses.forEach((v, i) => {
    if (v) { connected[i] = 1; pending.push(i); }
  });
  for (let k = 0; k < pending.length; k++) {
    const i = pending[k], x = i % 160, y = Math.floor(i / 160);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (x + dx < 0 || x + dx >= 160 || y + dy < 0 || y + dy >= 100) continue;
      const next = (y + dy) * 160 + x + dx;
      if (b.mass[next] && !connected[next]) { connected[next] = 1; pending.push(next); }
    }
  }
  for (let i = 0; i < b.mass.length; i++) {
    if (masses[i] || b.mass[i] <= adjacent || connected[i]) continue;
    const x = i % 160, y = Math.floor(i / 160);
    let nearTail = false;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (x + dx < 0 || x + dx >= 160 || y + dy < 0 || y + dy >= 100) continue;
      nearTail ||= Boolean(connected[(y + dy) * 160 + x + dx]);
    }
    assert(nearTail, `thick tail fragment at ${x},${y} must connect to body/tail or be within 2 cells`);
  }
  // 11-21 scope change: no end/side rim requirement. Keep conservation,
  // taper, finite reach, body color/thickness and detached-fragment checks.
  assert(b.cells.filter(Boolean).every(p => p === red), 'no fog or new mixed color');
});
test('heavy knife exposes yellow then paper, light only thins; shavings and total mass are conserved', () => {
  const b = make(); block(b, yellow, 20, 140); block(b, green, 20, 140);
  const i = b.at(70, 50), before = total(b);
  const sideMass = side => {
    let sum = 0;
    for (let x = 40; x <= 120; x++) for (let offset = 2; offset <= 3; offset++) {
      sum += b.mass[b.at(x, 50 + side * offset)];
    }
    return sum;
  };
  const sidesBefore = [-1, 1].map(sideMass);
  tool(b, 'knife', .2, {x: 35, y: 50}, {x: 125, y: 50});
  assert(b.topMass[i] > 0 && b.topMass[i] < 40);
  assert.deepEqual(b.rgbAt(70, 50), green.rgb);
  tool(b, 'knife', .95, {x: 35, y: 50}, {x: 125, y: 50});
  assert.equal(b.topMass[i], 0); assert.equal(b.bottomMass[i], 40);
  assert.deepEqual(b.rgbAt(70, 50), yellow.rgb);
  assert(sideMass(-1) > sidesBefore[0] && sideMass(1) > sidesBefore[1],
    'BOTH side bands grow, not just one');
  tool(b, 'knife', .95, {x: 35, y: 50}, {x: 125, y: 50});
  assert.equal(b.bottomMass[i], 0); assert.equal(b.cells[i], null);
  assert.deepEqual(b.rgbAt(70, 50), b.ground);
  assert(Math.abs(total(b) - before) < .01);
  const untouched = b.mass.slice();
  tool(b, 'knife', .95, {x: 35, y: 90}, {x: 125, y: 90});
  assert.deepEqual(b.mass, untouched, 'a clean knife never drops previous color on blank paper');
  // Default medium must pierce a normal layer after three passes.
  const medium = make();
  block(medium, yellow, 20, 140); block(medium, green, 20, 140);
  const mediumBefore = total(medium);
  for (let pass = 0; pass < 3; pass++) tool(medium, 'knife', .55, {x: 35, y: 50}, {x: 125, y: 50});
  for (let x = 40; x <= 120; x++) {
    assert.equal(medium.topMass[medium.at(x, 50)], 0, 'medium repeated scrape exposes bottom');
    assert.equal(medium.cells[medium.at(x, 50)], yellow);
  }
  for (let pass = 0; pass < 3; pass++) tool(medium, 'knife', .55, {x: 35, y: 50}, {x: 125, y: 50});
  assert.equal(medium.cells[medium.at(70, 50)], null, 'medium residual cutoff also clears bottom');
  assert(Math.abs(total(medium) - mediumBefore) < .01);
});
test('tail contact mixing uses spectral, only a few contact cells change; no brush/knife mixing', () => {
  const b = make(); block(b, red); block(b, yellow, 66, 115);
  // A top coat at the tail contact, needed for the only actual pigment mix.
  block(b, white, 66, 115);
  tool(b, 'smudge', .95);
  const mixed = b.cells.filter(p => p?.shares.length > 1);
  assert(mixed.length > 0 && mixed.length < 40);
  for (let i = 0; i < b.cells.length; i++) if (b.cells[i]?.shares.length > 1) {
    assert(i % b.width <= 65 + 1.2 * 20, 'mixing stays at short-tail contact, not endpoint 135');
  }
  for (const p of mixed) assert.deepEqual(p.rgb,
    Recipe.mix(p.shares.map(([hex]) => ({hex})), p.shares.map(([, part]) => part)));
});
