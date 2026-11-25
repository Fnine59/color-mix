const {test} = require('node:test');
const assert = require('node:assert/strict');
const O = require('../site/owned-colors.js');
const data = require('../site/data/kuelox.json');
test('renamed scope labels identify real palette families without changing prefix selection', () => {
  const groups = O.groups(data.colors, 'extra-soft', new Set());
  assert.deepEqual(groups.map(O.groupLabel), ['马卡龙 · 6 开头（48 支）', '经典 · 7 开头（48 支）', '莫兰迪 · 8 开头（48 支）']);
  const classic = O.toggleGroup(new Set(), groups[1].codes);
  assert.equal(classic.owned.size, 48);
  assert.ok(data.colors.filter(p => classic.owned.has(p.code)).every(p => p.palettes.includes('classic')));
  assert.equal(O.groupLabel(O.groups(data.colors, 'chinese-traditional', new Set())[0]), '中国传统色 · 1 开头（48 支）');
});

test('prefix groups use first digit, unique codes and actual current-product counts', () => {
  for (const id of ['extra-soft', 'professional-soft', 'beginner-super-soft', 'skyists']) {
    const groups = O.groups(data.colors, id, new Set());
    assert.deepEqual(groups.map(g => [g.prefix, g.codes.length, g.state]), [
      ['6', 48, 'none'], ['7', 48, 'none'], ['8', 48, 'none'],
    ]);
    assert.ok(groups.every(g => g.codes.every(code => code.startsWith(g.prefix))));
    assert.equal(new Set(groups.flatMap(g => g.codes)).size, 144);
  }
  assert.equal(O.groups(data.colors, 'all', new Set()).flatMap(g => g.codes).length, 237);
});
test('none / partial group toggles to all and requests only-owned mode', () => {
  const codes = O.groups(data.colors, 'extra-soft', new Set()).find(g => g.prefix === '7').codes;
  for (const owned of [new Set(), new Set([codes[0]])]) {
    const result = O.toggleGroup(owned, codes);
    assert.equal(result.select, true);
    assert.equal(result.owned.size, 48);
    assert.equal(O.groups(data.colors, 'extra-soft', result.owned)[1].state, 'all');
  }
});
test('all group toggles to none without removing other-prefix owned colors', () => {
  const codes = O.groups(data.colors, 'extra-soft', new Set()).find(g => g.prefix === '7').codes;
  const owned = new Set([...codes, '644']);
  const result = O.toggleGroup(owned, codes);
  assert.equal(result.select, false);
  assert.deepEqual([...result.owned], ['644']);
  assert.equal(owned.size, 49);
  assert.equal(O.groups(data.colors, 'extra-soft', result.owned)[1].state, 'none');
});
test('switching series rebuilds groups including traditional 1 and wooden-box 2', () => {
  const full = O.groups(data.colors, 'extra-soft', new Set()), owned = new Set(full[1].codes);
  assert.deepEqual(O.groups(data.colors, 'chinese-traditional', owned).map(g => [g.prefix, g.codes.length, g.state]), [['1', 48, 'none']]);
  const wooden = O.groups(data.colors, 'selected-72', owned);
  assert.deepEqual(wooden.map(g => [g.prefix, g.codes.length]), [['2', 4], ['6', 25], ['7', 28], ['8', 15]]);
  const result = O.toggleGroup(owned, wooden.find(g => g.prefix === '7').codes);
  assert.equal(result.owned.size, 20); // Only this product's 28 codes removed.
  assert.equal(O.groups(data.colors, 'extra-soft', result.owned)[1].state, 'partial');
  assert.equal(O.groups(data.colors, 'extra-soft', result.owned)[1].selected, 20);
});
test('prefix selections survive JSON storage and preserve selected state', () => {
  const group = O.groups(data.colors, 'extra-soft', new Set())[1];
  const result = O.toggleGroup(new Set(), group.codes);
  const stored = JSON.parse(JSON.stringify({codes: [...result.owned], onlyOwned: result.select}));
  assert.equal(stored.onlyOwned, true);
  assert.deepEqual(O.groups(data.colors, 'extra-soft', new Set(stored.codes))[1], {...group, selected: 48, state: 'all'});
});
