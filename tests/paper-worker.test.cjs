const {test} = require('node:test'), assert = require('node:assert/strict');
const R = require('../site/recipe.js'), spectral = require('../site/vendor/spectral.js');
const P = require('../site/paper-studio.js'), {Engine} = require('../site/paper-engine.js');
const {Pipeline} = require('../site/paper-pipeline.js');
const bench = require('../scripts/smudge-node-bench.cjs');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

test('paper spectra normalize HEX, stay bounded/read-only and cannot pollute paints or arbitrary picker RGB', () => {
  const cache = R.paperMixer(4), a = [{hex: '#f4ec65'}, {hex: '#1e3d8b'}], parts = [2, 3];
  const old = spectral.mix; let seen;
  spectral.mix = (...args) => { seen = args.map(v => v[0]); return old(...args); };
  try {
    const expected = R.mix(a, parts);
    assert.deepEqual(cache.mix(a, parts), expected);
    assert.equal(cache.size, 2);
    const first = seen[0];
    cache.mix([{hex: '#F4EC65'}, a[1]], parts); assert.equal(seen[0], first);
    assert(Object.isFrozen(first)); assert(Object.isFrozen(first.R)); assert(Object.isFrozen(first.KS));
    const paints = JSON.stringify(a), shares = parts.slice();
    const output = cache.mix(a, parts); output[0] = -1;
    assert.deepEqual(cache.mix(a, parts), R.mix(a, parts));
    assert.equal(JSON.stringify(a), paints); assert.deepEqual(parts, shares);
    for (let n = 0; n < 1200; n++) cache.mix([{hex: '#' + n.toString(16).padStart(6, '0')}], [1]);
    assert.equal(cache.size, 4);
    const max = R.paperMixer();
    for (let n = 0; n < 1100; n++) max.mix([{hex: '#' + n.toString(16).padStart(6, '0')}], [1]);
    assert.equal(max.size, 1024);
    const rgb = [{rgb: [7, 13, 217]}]; assert.deepEqual(cache.mix(rgb, [1]), [7, 13, 217]);
    assert.equal(cache.size, 4); assert.deepEqual(rgb[0].rgb, [7, 13, 217]);
    assert.throws(() => R.paperMixer(1025));
  } finally { spectral.mix = old; }
});
test('production Surface/Engine pigment paths reuse read-only spectra across different ratios and restores', () => {
  const studio = new P.Studio(), engine = new Engine(studio);
  const old = spectral.mix, inputs = new Map(); let calls = 0;
  spectral.mix = (...args) => {
    calls++;
    for (const [color] of args) {
      const key = color.sRGB.join(',');
      assert(Object.isFrozen(color), 'production paper mixing must use the read-only input spectrum cache');
      if (inputs.has(key)) assert.equal(color, inputs.get(key), 'different ratios reuse the same HEX Color');
      else inputs.set(key, color);
    }
    return old(...args);
  };
  try {
    engine.run({type: 'begin', hex: '#F4EC65'}); engine.run({type: 'samples', samples: [sample()]});
    engine.run({type: 'commit'});
    engine.run({type: 'begin', hex: '#1E3D8B'}); engine.run({type: 'samples', samples: [sample({x: 130, y: 90}, to)]});
    engine.run({type: 'commit'});
    const paper = studio.paper, pigments = paper.pigments;
    // Exercise all four real call sites, not a stand-alone paperMixer factory.
    for (const ratio of [1, 2, 3]) {
      pigments.transport.mix({'#F4EC65': ratio, '#1E3D8B': 4});
      pigments.restoreState([['#1E3D8B', 1 / (ratio + 1)], ['#F4EC65', ratio / (ratio + 1)]],
        `#1E3D8B/1,#F4EC65/${ratio}`);
      pigments.restore([['#1E3D8B', ratio / (ratio + 5)], ['#F4EC65', 5 / (ratio + 5)]]);
      pigments.fine({'#F4EC65': ratio, '#1E3D8B': 7});
    }
    engine.run({type: 'begin'}); engine.run({type: 'samples', samples: [sample(to, from, 'smudge')]});
    engine.run({type: 'commit'});
    assert(calls > 12); assert.equal(inputs.size, 2, 'only two shared HEX spectra despite many mixtures');
  } finally { spectral.mix = old; }
});
for (const name of ['three', 'cover', 'repeat']) test('baseline three-color ' + name + ': every committed pass retains mass, identities and pixels', () => {
  const expected = require('./fixtures/smudge-baseline.json').cases[name].before;
  const actual = bench.run(P, name);
  assert.deepEqual(actual.before, expected.before);
  assert.deepEqual(actual.passes, expected.passes);
});

// Execute the actual classic Worker script/importScripts in an isolated realm,
// asynchronously. Unlike a canned mock this tests its message/transfer contract.
class TestWorker {
  constructor() {
    this.tail = Promise.resolve();
    const context = vm.createContext({Buffer, performance, self: {postMessage: data => this.onmessage?.({data: structuredClone(data)})}});
    const load = name => {
      let source = fs.readFileSync(path.join(__dirname, '../site', name), 'utf8');
      if (name.endsWith('paper-studio.js')) source = source.replace('function encodePaper(surface) {',
        'function encodePaper(surface) { globalThis.encodeCount = (globalThis.encodeCount || 0) + 1;');
      vm.runInContext(source, context, {filename: name});
    };
    context.importScripts = (...names) => names.forEach(load);
    load('paper-worker.js'); this.context = context;
  }
  postMessage(message) {
    const copy = structuredClone(message);
    this.tail = this.tail.then(() => new Promise(resolve => setImmediate(resolve))).then(() => this.context.self.onmessage({data: copy}));
  }
  terminate() { this.stopped = true; }
}
const from = {x: 60, y: 90}, to = {x: 250, y: 90};
const sample = (a = from, b = to, tool = 'brush') => ({from: a, to: b,
  settings: {tool, radius: 12, strength: .95, angle: 0, tilt: 0, dry: false}});
const request = (p, c) => new Promise((resolve, reject) => p.request(c, (r, e) => e ? reject(Error(e)) : resolve(r)));
test('commit reuses its single encoding in save; repeated begin/restore/undo never reuse stale pre-gesture snapshots', () => {
  const {context} = new TestWorker(), api = context.PaperStudio;
  const studio = new api.Studio(), engine = new context.PaperEngine.Engine(studio);
  let count = 0; const encode = studio.encode.bind(studio);
  studio.encode = () => { count++; return encode(); };
  engine.run({type: 'begin', hex: '#F4EC65'}); engine.run({type: 'samples', samples: [sample()]});
  const previous = count, realPrevious = context.encodeCount, stored = engine.run({type: 'commit'});
  assert.equal(count - previous, 1);
  assert.equal(context.encodeCount - realPrevious, 1, 'count every real encodePaper call, including direct Engine calls');
  assert.equal(stored, JSON.stringify(studio.committedSnapshot.wax));
  assert.equal(stored, JSON.stringify(P.encodePaper(studio.paper)));
  studio.undo(); assert.equal(studio.committedSnapshot, null);
  assert.equal(P.encodePaper(studio.paper).count, 0);
  engine.run({type: 'begin', hex: '#1E3D8B'}); engine.run({type: 'samples', samples: [sample()]});
  assert.notEqual(engine.run({type: 'commit'}), stored);
  studio.restore(encode()); assert.equal(studio.committedSnapshot, null);
  studio.paper.clear(); studio.begin(); assert.equal(studio.pending.wax.count, 0);
});
test('real Worker release-to-storage chain calls the actual encodePaper function only once after begin', async () => {
  const worker = new TestWorker(), p = new Pipeline({workerFactory: () => worker});
  await request(p, {type: 'begin', hex: '#F4EC65'});
  p.sample(sample());
  const previous = worker.context.encodeCount, storage = new Map();
  await new Promise(resolve => p.request({type: 'commit'}, snapshot => { storage.set('kuelox-paper-v2', snapshot); resolve(); }));
  assert.equal(worker.context.encodeCount - previous, 1);
  assert.equal(storage.get('kuelox-paper-v2'), JSON.stringify(vm.runInContext('PaperStudio.encodePaper(engine.studio.paper)', worker.context)));
  p.dispose();
});
test('one-pass encoding preserves same-key distinct transport objects and same-color continuation after cache eviction/reselection', () => {
  const old = bench.baseline();
  function exercise(api, reselect) {
    const model = new api.Studio(), p = model.paper, yellow = model.pigments.color('#F4EC65');
    p.add(p.at(100, 90), yellow, 20);
    // Actual bounded transport-cache eviction, not just clearing a lookup.
    const transport = model.pigments.transport;
    for (let n = 1; n <= 3201; n++) transport.color('#' + n.toString(16).padStart(6, '0'));
    const next = reselect ? model.pigments.color('#F4EC65') : yellow;
    model.begin();
    p.stroke(from, to, {...sample().settings, pigment: next, strokeId: p.beginStroke()});
    model.commit(); const saved = JSON.stringify(model.committedSnapshot?.wax || api.encodePaper(p));
    const copy = new api.Studio(); copy.restore({...copy.palette.encode(), wax: JSON.parse(saved)});
    model.begin(); copy.begin();
    for (const m of [model, copy]) {
      const q = m.paper; q.stroke(to, from, {...sample().settings, tool: 'smudge',
        pigment: m.pigments.color('#F4EC65'), strokeId: q.beginStroke()}); m.commit();
    }
    assert.equal(JSON.stringify(api.encodePaper(copy.paper)), JSON.stringify(api.encodePaper(model.paper)));
    model.undo(); assert.equal(JSON.stringify(api.encodePaper(model.paper)), saved);
    return saved;
  }
  for (const reselect of [false, true]) assert.equal(exercise(P, reselect), exercise(old, reselect));
  const model = new P.Studio(), a = model.pigments.transport.color('#F4EC65');
  const b = {...a, id: model.pigments.transport.nextId++};
  const optical = model.pigments.color('#F4EC65');
  model.paper.add(0, model.pigments.withState(optical, a), 20);
  model.paper.add(1, model.pigments.withState(optical, b), 20);
  const encoded = P.encodePaper(model.paper);
  assert.equal(encoded.pigments.length, 2, 'same optical shares cannot collapse distinct transport identities');
  const loaded = new P.Studio(); loaded.restore({...loaded.palette.encode(), wax: encoded});
  assert.notEqual(loaded.pigments.state(loaded.paper.bottom[0]), loaded.pigments.state(loaded.paper.bottom[1]));
});
test('real Worker interpreter: fast samples, commit, picker fence, undo, clear and save settle in arrival order', async () => {
  const p = new Pipeline({workerFactory: () => new TestWorker()});
  p.request({type: 'begin', hex: '#F4EC65'});
  p.sample(sample(from, from)); p.sample(sample());
  let committed;
  p.request({type: 'commit'}, r => { committed = r; });
  // Submit another color AFTER a read fence. Callback must see yellow,
  // never the following blue frame; FIFO delivery is part of the contract.
  let picked;
  p.request({type: 'barrier'}, () => { picked = p.view.rgbAt(100, 90).map(Math.round); });
  p.request({type: 'begin', hex: '#1E3D8B'}); p.sample(sample()); p.request({type: 'commit'});
  assert.equal(committed, undefined, 'no synchronous simulation in input/commit callers');
  await p.settled(); assert(committed); assert.deepEqual(picked, [244, 236, 101]); assert.equal(p.history, 2);
  const restored = new P.Studio(); restored.restore({...restored.palette.encode(), wax: JSON.parse(await request(p, {type: 'save'}))});
  for (let i = 0; i < restored.paper.cells.length; i++) {
    const rgba = new Uint8ClampedArray(4); restored.paper.writeFlat(i, rgba); rgba[3] = 255;
    assert.deepEqual(p.view.pixels.subarray(i * 4, i * 4 + 4), rgba);
  }
  assert.equal(await request(p, {type: 'undo'}), committed);
  assert.equal(JSON.parse(await request(p, {type: 'clear'})).count, 0);
  assert.equal(await request(p, {type: 'undo'}), committed);
  p.close(); await p.worker.tail; assert(p.worker.stopped);
});
test('unload Engine replay uses the exact loaded baseline and command history, not the stale caller paper or a later partial checkpoint', async () => {
  const initial = new P.Studio(), seed = new Engine(initial);
  seed.run({type: 'begin', hex: '#F4EC65'}); seed.run({type: 'samples', samples: [sample()]}); seed.run({type: 'commit'});
  const baseline = JSON.stringify(initial.encode()), worker = new TestWorker();
  const p = new Pipeline({studio: initial, workerFactory: () => worker});
  await p.settled();
  p.request({type: 'begin', hex: '#1E3D8B'}); p.sample(sample({x: 150, y: 90}, to)); p.request({type: 'commit'});
  await p.settled();
  p.request({type: 'undo'}); p.request({type: 'clear'});
  p.request({type: 'restore', value: JSON.parse(baseline)});
  p.request({type: 'begin'}); p.sample(sample(to, from, 'smudge')); p.request({type: 'commit'});
  const synchronous = p.snapshotForUnload();
  assert.notEqual(synchronous, JSON.stringify(JSON.parse(baseline).wax), 'accepted in-flight samples must change the loaded paper');
  assert.equal(JSON.stringify(initial.encode()), baseline, 'the caller baseline was never mutated by the Worker');
  const settled = await request(p, {type: 'save'});
  assert.equal(synchronous, settled, 'entire v2/transport/wax archive is byte-identical to actual classic Worker');
  const recovered = new P.Studio(); recovered.restore({...recovered.palette.encode(), wax: JSON.parse(synchronous)});
  for (let i = 0; i < recovered.paper.cells.length; i++) {
    const pixels = new Uint8ClampedArray(4); recovered.paper.writeFlat(i, pixels); pixels[3] = 255;
    assert.deepEqual(p.view.pixels.subarray(i * 4, i * 4 + 4), pixels);
    assert.deepEqual(p.view.rgbAt(i % recovered.paper.width, Math.floor(i / recovered.paper.width)),
      recovered.paper.rgbAt(i % recovered.paper.width, Math.floor(i / recovered.paper.width)));
  }
  p.dispose();
});
test('no Worker / constructor-denied fallback has the same ordered commands and usable undo', () => {
  for (const workerFactory of [undefined, () => { throw Error('CSP denied'); }]) {
    const p = new Pipeline({workerFactory});
    assert.equal(p.worker, null);
    p.request({type: 'begin', hex: '#F4EC65'}); p.sample(sample());
    let saved; p.request({type: 'commit'}, value => { saved = value; });
    assert(JSON.parse(saved).count > 0); assert.equal(p.history, 1);
    p.request({type: 'undo'}, value => assert.equal(JSON.parse(value).count, 0));
    assert.equal(p.history, 0);
  }
});
test('live Worker failure rejects pending fences without replaying old paper; duplicate late replies ignored', async () => {
  let message;
  const worker = {postMessage() {}, terminate() {}};
  const p = new Pipeline({workerFactory: () => worker, onError: error => { message = error; }});
  // Acknowledge restore: this is a LIVE crash, not a clean startup failure.
  worker.onmessage({data: {id: 1, history: 0, results: [null]}});
  const saved = request(p, {type: 'save'}); worker.onerror({preventDefault() {}});
  await assert.rejects(saved, /线程异常/); assert.equal(p.failed, true); assert(message);
  worker.onmessage({data: {id: 1, history: 999, results: [null]}}); assert.equal(p.history, 0);
});
test('first async Worker startup failure cleanly falls back with queued input, exact RGB/history and immediate save', () => {
  for (const failure of ['onerror', 'restore error', 'post throw']) {
    const sent = [], worker = {postMessage(message) { sent.push(message); if (failure === 'post throw') throw Error('CSP denied'); },
      terminate() { this.stopped = true; }};
    const p = new Pipeline({workerFactory: () => worker});
    const reference = new Pipeline();
    let saved, expected;
    for (const pipeline of [p, reference]) {
      pipeline.request({type: 'begin', hex: '#F4EC65'}); pipeline.sample(sample());
      pipeline.request({type: 'commit'}, result => { if (pipeline === p) saved = result; else expected = result; });
    }
    if (failure !== 'post throw') {
      assert.equal(sent.length, 1, 'no samples reach the Worker before ready/restore');
      assert.equal(saved, undefined);
      if (failure === 'onerror') worker.onerror({preventDefault() {}});
      else worker.onmessage({data: {id: 1, error: 'initialization failed'}});
    }
    assert(worker.stopped); assert.equal(p.worker, null); assert(p.engine); assert.equal(p.failed, false);
    assert.equal(saved, expected); assert(JSON.parse(saved).count > 0);
    assert.equal(p.history, 1); assert.deepEqual(p.view.rgbAt(100, 90), reference.view.rgbAt(100, 90));
    p.request({type: 'save'}, result => assert.equal(result, expected));
    worker.onmessage({data: {id: 1, history: 999, results: [null]}});
    assert.equal(p.history, 1, 'failed worker late replies cannot overwrite fallback');
    p.request({type: 'undo'}, result => assert.equal(JSON.parse(result).count, 0));
  }
});
