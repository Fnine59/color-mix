// Run the actual browser scripts with a tiny DOM adapter + native canvas.
// No browser/network: asserts event wiring, storage, rendering and solver input.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const M = require('../site/color-math.js');
const data = require('../site/data/kuelox.json');
const site = path.join(__dirname, '../site');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function boot(storage = new Map(), solverResult = {recipes: [], unreachable: false}, reducedMotion = false, paperWorker = false) {
  let document;
  const animations = [], frames = new Map();
  let frameId = 0;
  const motionListeners = [];
  const motion = {matches: reducedMotion, addEventListener(type, fn) { motionListeners.push(fn); },
    change(event) { motionListeners.forEach(fn => fn(event)); }};
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
      this.style = {}; this.dataset = {}; this.children = []; this.attributes = {};
      this.events = {}; this.textContent = ''; this.innerHTML = ''; this.scrolls = [];
      this.classList = {add() {}, remove() {}};
    }
    addEventListener(type, fn) { this.events[type] = fn; }
    emit(type, event = {}) { return this.events[type]?.({target: this, preventDefault() {}, ...event}); }
    click() { if (!this.disabled && !this.hidden) this.onclick?.({target: this}); }
    setAttribute(key, value) { this.attributes[key] = value; }
    replaceChildren(...children) { this.children = children; }
    append(child) { this.children.push(child); child.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    animate(keyframes, options) {
      const animation = {element: this, keyframes, options, cancel() { this.canceled = true; this.oncancel?.(); }};
      animations.push(animation); return animation;
    }
    focus() { document.activeElement = this; }
    matches() { return false; }
    setPointerCapture() {}
    scrollIntoView(options) { this.scrolls.push(options); this.lastScroll = options; }
    getBoundingClientRect() {
      const width = this.width || 500, height = this.height || 500;
      return {left: 0, top: 0, right: width, bottom: height, width, height};
    }
  }
  class Canvas extends Element {
    constructor() { super('canvas'); this.native = createCanvas(1, 1); }
    get width() { return this.native.width; }
    set width(value) { this.native.width = value; }
    get height() { return this.native.height; }
    set height(value) { this.native.height = value; }
    getContext(...args) { return this.native.getContext(...args); }
    getBoundingClientRect() {
      const base = this.baseRect || super.getBoundingClientRect();
      const parts = /translate\(([-.\d]+)px, ([-.\d]+)px\) scale\(([-.\d]+)\)/.exec(this.style.transform || '');
      const [, dx, dy, zoom] = parts || [null, 0, 0, 1];
      const width = base.width * Number(zoom), height = base.height * Number(zoom);
      const left = base.left + Number(dx) + (base.width - width) / 2;
      const top = base.top + Number(dy) + (base.height - height) / 2;
      return {left, top, width, height, right: left + width, bottom: top + height};
    }
  }
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, ['photo', 'paper-canvas', 'pick-loupe-canvas', 'photo-loupe-canvas'].includes(id) ? new Canvas() : new Element()]));
  for (const [, tag, id] of html.matchAll(/<([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    elements[id].hidden = /\bhidden\b/.test(tag);
    elements[id].disabled = /\bdisabled\b/.test(tag);
    for (const [, key, value] of tag.matchAll(/(aria-[\w-]+)="([^"]+)"/g)) elements[id].attributes[key] = value;
  }
  elements.product.value = 'all';
  elements['paper-pressure'].value = '0.55'; elements['paper-size'].value = '45';
  elements['pick-loupe-canvas'].width = elements['pick-loupe-canvas'].height = 11;
  elements['photo-loupe-canvas'].width = elements['photo-loupe-canvas'].height = 11;
  document = {
    activeElement: null, body: new Element(), getElementById: id => elements[id],
    createElement: tag => tag === 'canvas' ? new Canvas() : new Element(tag),
    addEventListener() {},
  };
  const messages = [], decodes = [], rootEvents = {};
  let context, paperTail = Promise.resolve(), asyncStopped = false, frameCalls = 0;
  const paperWorkers = [], suspended = [];
  class Worker {
    constructor(url) {
      if (url === './paper-worker.js' && paperWorker) {
        this.engine = new context.PaperEngine.Engine(); paperWorkers.push(this); return;
      }
      assert.equal(url, './worker.js');
    }
    postMessage(message) {
      if (this.engine) {
        const copy = structuredClone(message);
        paperTail = paperTail.then(flush).then(async () => {
          if (this.stopped) return;
          if (asyncStopped) await new Promise(resolve => suspended.push(resolve));
          if (!this.stopped) this.onmessage({data: {...this.engine.batch(copy.commands), id: copy.id}});
        });
        return;
      }
      messages.push(message);
      // Solver mathematics is separately tested; only app dispatch is mocked.
      queueMicrotask(() => { if (!this.stopped) this.onmessage({data: {id: message.id, result: solverResult}}); });
    }
    terminate() { this.stopped = true; }
  }
  context = vm.createContext({
    document, location: {search: ''}, URLSearchParams, URL, File, Uint8ClampedArray,
    performance, setTimeout, clearTimeout, Worker, queueMicrotask, btoa, atob, structuredClone,
    addEventListener(type, fn) { rootEvents[type] = fn; },
    innerWidth: 1280, innerHeight: 900, matchMedia: () => motion,
    getComputedStyle: element => element.computedStyle || {},
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); queueMicrotask(() => { if (!asyncStopped && frames.delete(id)) { frameCalls++; fn(); } }); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    navigator: {userAgent: 'Node native-canvas DOM adapter'},
    window: {addEventListener() {}},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    fetch: async url => {
      assert.equal(url, './data/kuelox.json');
      return {ok: true, json: async () => data};
    },
    createImageBitmap: file => {
      const decode = (async () => loadImage(Buffer.from(await file.arrayBuffer())))();
      decodes.push(decode); return decode;
    },
  });
  for (const script of ['color-math.js', 'image-input.js', 'owned-colors.js', 'white-balance.js', 'vendor/spectral.js', 'recipe.js', 'palette.js', 'wax-paper.js', 'wax-render.js', 'soft-smudge.js', 'paper-studio.js', 'paper-engine.js', 'paper-pipeline.js', 'pick-loupe.js', 'photo-view.js', 'palette-ui.js', 'app.js']) {
    let source = fs.readFileSync(path.join(site, script), 'utf8');
    // Instrument the real function, including calls via Studio's lexical
    // binding AND direct PaperStudio.encodePaper calls from the Engine.
    if (script === 'paper-studio.js') source = source.replace('function encodePaper(surface) {',
      'function encodePaper(surface) { globalThis.paperEncodeCount = (globalThis.paperEncodeCount || 0) + 1;');
    vm.runInContext(source, context, {filename: script});
  }
  await flush();
  return {
    elements, messages, storage, document, animations, motion, context, rootEvents, paperWorkers, frames,
    stopAsync() { asyncStopped = true; },
    resumeAsync() { asyncStopped = false; suspended.splice(0).forEach(resolve => resolve()); },
    get frameCalls() { return frameCalls; },
    async settlePaper() {
      let tail;
      do { tail = paperTail; await tail; await flush(); } while (tail !== paperTail);
    },
    group: prefix => elements['prefix-groups'].children.find(b => b.dataset.prefix === prefix),
    async upload(file) {
      elements['photo-file'].emit('change', {target: {files: [file]}});
      await Promise.all(decodes); await flush();
      assert.equal(elements['photo-error'].textContent, '');
      assert.equal(elements.photo.hidden, false);
    },
    async point(x, y) {
      elements.photo.emit('pointerdown', {pointerId: 1, clientX: x, clientY: y});
      elements.photo.emit('pointerup', {pointerId: 1, clientX: x, clientY: y});
      await flush();
    },
    async drag(x, y, endX, endY) {
      elements.photo.emit('pointerdown', {pointerId: 1, clientX: x, clientY: y});
      elements.photo.emit('pointermove', {pointerId: 1, clientX: endX, clientY: endY});
      elements.photo.emit('pointerup', {pointerId: 1, clientX: endX, clientY: endY});
      await flush();
    },
  };
}
function photo() {
  const canvas = createCanvas(64, 32), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f0dfb4'; ctx.fillRect(0, 0, 64, 32);
  ctx.fillStyle = '#474e9f'; ctx.fillRect(32, 0, 16, 32);
  ctx.fillStyle = '#60457c'; ctx.fillRect(48, 0, 16, 32);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 10, 10);
  return new File([canvas.toBuffer('image/png')], 'photo.png', {type: 'image/png'});
}
function assertBlankPaper(elements) {
  const {Studio} = require('../site/paper-studio.js'), WaxRender = require('../site/wax-render.js');
  const blank = createCanvas(448, 274);
  WaxRender.flat(blank, new Studio().paper).draw();
  assert.deepEqual(elements['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data,
    blank.getContext('2d').getImageData(0, 0, 448, 274).data, 'whole paper matches the blank textured surface');
}
test('actual app prefix buttons update scope immediately, ignore search, persist and follow series', async () => {
  const app = await boot(), e = app.elements;
  e.product.value = 'extra-soft'; e.product.emit('change');
  await app.upload(photo()); await app.point(40, 16);
  assert.equal(app.messages.at(-1).palette.length, 144);
  e['color-search'].value = '741'; e['color-search'].emit('input');
  app.group('7').focus(); app.group('7').onclick(); await flush();
  assert.equal(e['only-owned'].checked, true);
  assert.match(app.group('7').textContent, /7 开头（48 支）.*全勾/);
  assert.equal(app.document.activeElement, app.group('7'));
  assert.equal(app.messages.at(-1).palette.length, 48);
  assert.ok(app.messages.at(-1).palette.every(p => p.code.startsWith('7')));
  e['palette-list'].emit('change', {target: {value: '741', checked: false}});
  assert.equal(app.group('7').attributes['aria-pressed'], 'mixed');
  app.group('7').onclick(); await flush();
  assert.equal(app.messages.at(-1).palette.length, 48);
  const refreshed = await boot(app.storage);
  assert.equal(refreshed.elements['only-owned'].checked, true);
  assert.equal(refreshed.group('7').dataset.state, 'partial'); // Refresh starts with all products (59 codes).
  refreshed.elements.product.value = 'extra-soft'; refreshed.elements.product.emit('change');
  assert.equal(refreshed.group('7').dataset.state, 'all');
  app.group('7').onclick(); await flush();
  assert.match(e['result-status'].textContent, /没有可用颜色/);
  assert.deepEqual(JSON.parse(app.storage.get('kuelox-owned-v1')).codes, []);
  e.product.value = 'chinese-traditional'; e.product.emit('change');
  assert.equal(e['prefix-groups'].children.length, 1);
  assert.match(app.group('1').textContent, /48 支/);
  e.product.value = 'selected-72'; e.product.emit('change');
  assert.match(app.group('2').textContent, /4 支/);
  assert.match(app.group('7').textContent, /28 支/);
});
test('actual app white-reference click is not a target, updates old region + recipes and restores on cancel', async () => {
  const app = await boot(), e = app.elements;
  assert.equal(e['white-balance-tools'].hidden, true);
  await app.upload(photo());
  assert.equal(e['white-balance-tools'].hidden, false);
  e['photo-average'].onclick();
  await app.drag(34, 12, 42, 20);
  const beforeHex = e['target-hex'].textContent, beforeMessages = app.messages.length;
  assert.equal(beforeHex, '#474E9F');
  e['white-balance-pick'].onclick();
  await app.point(5, 5); // Overexposed rejected; target and photo unchanged.
  assert.match(e['photo-error'].textContent, /过曝/);
  assert.equal(e['white-balance-pick'].attributes['aria-pressed'], 'true');
  assert.equal(e['target-hex'].textContent, beforeHex);
  assert.equal(app.messages.length, beforeMessages);
  await app.point(20, 16);
  assert.equal(e['white-balance-status'].textContent, '已按白纸校正');
  assert.equal(e['white-balance-reset'].hidden, false);
  assert.notEqual(e['target-hex'].textContent, beforeHex);
  const rendered = e.photo.getContext('2d').getImageData(34, 12, 9, 9);
  assert.equal(e['target-hex'].textContent, M.rgbToHex(M.averagePixels(rendered.data)).toUpperCase());
  assert.equal(M.rgbToHex(app.messages.at(-1).target).toUpperCase(), e['target-hex'].textContent);
  assert.equal(app.messages.length, beforeMessages + 1);
  assert.match(e['pick-info'].textContent, /9 × 9.*已按白纸校正/);
  e['white-balance-reset'].onclick(); await flush();
  assert.equal(e['target-hex'].textContent, beforeHex);
  assert.equal(e['white-balance-reset'].hidden, true);
  // Reapply, then change photo: no old correction/target survives.
  e['white-balance-pick'].onclick(); await app.point(20, 16);
  await app.upload(photo());
  assert.equal(e['white-balance-status'].textContent, '');
  assert.equal(e['white-balance-reset'].hidden, true);
  assert.equal(e['target-row'].hidden, true);
  await app.point(40, 16);
  assert.equal(e['target-hex'].textContent, beforeHex);
});
test('actual app supports reference before first color and re-reference uses original pixels', async () => {
  const app = await boot(), e = app.elements; await app.upload(photo());
  e['white-balance-pick'].onclick(); await app.point(20, 16);
  assert.equal(app.messages.length, 0);
  await app.point(40, 16);
  const firstHex = e['target-hex'].textContent;
  e['white-balance-pick'].onclick(); await app.point(20, 16);
  assert.equal(e['target-hex'].textContent, firstHex);
  const messageCount = app.messages.length;
  e['white-balance-pick'].onclick(); await app.point(5, 5);
  assert.match(e['photo-error'].textContent, /过曝/);
  assert.equal(e['target-hex'].textContent, firstHex);
  assert.equal(e['white-balance-reset'].hidden, false);
  assert.equal(app.messages.length, messageCount);
  e.photo.emit('keydown', {key: 'Escape'});
  e['white-balance-pick'].onclick();
  e.photo.emit('keydown', {key: 'Escape'});
  assert.equal(e['white-balance-pick'].attributes['aria-pressed'], 'false');
  assert.equal(e['white-balance-status'].textContent, '已按白纸校正');
});
const paintButton = (app, code) => app.elements['paint-colors'].children.find(b => b.dataset.code === code);
function stroke(canvas, x, y, toX = x, toY = y, extra = {}) {
  const event = {pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, ...extra};
  canvas.emit('pointerdown', {...event, timeStamp: 1});
  canvas.emit('pointermove', {...event, clientX: toX, clientY: toY, timeStamp: 161});
  canvas.emit('pointerup', {...event, clientX: toX, clientY: toY, timeStamp: 162});
}
const pixelHex = (canvas, x, y) => M.rgbToHex([...canvas.getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3)).toUpperCase();
for (const end of ['pointerup', 'pointercancel', 'lostpointercapture', 'tool']) {
  test('async paper input: coalesced fast drag then ' + end + ' commits exact ordered pixels and only one save', async () => {
    const storage = new Map(), writes = [];
    storage.set = (key, value) => { if (key === 'kuelox-paper-v2') writes.push(value); return Map.prototype.set.call(storage, key, value); };
    const app = await boot(storage, undefined, false, true), e = app.elements, c = e['paper-canvas'];
    const reference = await boot(); paintButton(reference, '704').onclick();
    paintButton(app, '704').onclick();
    const event = {pointerId: 7, pointerType: 'touch', clientX: 100, clientY: 90};
    c.emit('pointerdown', event); reference.elements['paper-canvas'].emit('pointerdown', event);
    const samples = [130, 190, 260].map(clientX => ({...event, clientX}));
    const move = {...samples.at(-1), getCoalescedEvents: () => samples};
    c.emit('pointermove', move); reference.elements['paper-canvas'].emit('pointermove', move);
    if (end === 'tool') { e['tool-smudge'].onclick(); reference.elements['tool-smudge'].onclick(); }
    else { c.emit(end, samples.at(-1)); reference.elements['paper-canvas'].emit(end, samples.at(-1)); }
    assert.equal(writes.length, 0, 'input handler returned before simulation and save');
    await app.settlePaper(); await flush();
    assert.equal(writes.length, 1); assert.equal(writes[0], reference.storage.get('kuelox-paper-v2'));
    assert.deepEqual(c.getContext('2d').getImageData(0, 0, 448, 274).data,
      reference.elements['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data);
  });
}
test('async paper: drag then immediately pick, undo/clear and unavailable storage never read/save stale paper', async () => {
  const app = await boot(new Map(), undefined, false, true), e = app.elements, c = e['paper-canvas'];
  paintButton(app, '704').onclick(); stroke(c, 100, 90, 260, 90);
  e['tool-pick'].onclick(); stroke(c, 160, 90);
  await app.settlePaper(); await flush();
  assert.equal(e['picked-hex'].textContent, '#F4EC65');
  const painted = app.storage.get('kuelox-paper-v2');
  e['tool-brush'].onclick(); stroke(c, 100, 120, 260, 120);
  e['palette-undo'].onclick(); await app.settlePaper();
  assert.equal(app.storage.get('kuelox-paper-v2'), painted);
  stroke(c, 100, 120, 260, 120); e['palette-clear'].onclick(); await app.settlePaper();
  assert.equal(JSON.parse(app.storage.get('kuelox-paper-v2')).count, 0);
  e['palette-undo'].onclick(); await app.settlePaper();
  assert(JSON.parse(app.storage.get('kuelox-paper-v2')).count > 0);
  app.storage.set = () => { throw Error('quota'); };
  stroke(c, 100, 140, 260, 140); await app.settlePaper();
  assert.match(e['palette-storage-warning'].textContent, /未能保存/);
  e['palette-undo'].onclick(); await app.settlePaper();
  assert.match(e['palette-storage-warning'].textContent, /未能保存/);
  app.storage.set = Map.prototype.set;
  stroke(c, 100, 180, 260, 180); await app.settlePaper();
  assert.equal(e['palette-storage-warning'].textContent, '');
});
test('beforeunload persists pending samples synchronously even if no prompt or later settlement is possible', async () => {
  const app = await boot(new Map(), undefined, false, true), c = app.elements['paper-canvas'];
  paintButton(app, '704').onclick();
  c.emit('pointerdown', {pointerId: 7, pointerType: 'touch', clientX: 100, clientY: 90});
  c.emit('pointermove', {pointerId: 7, pointerType: 'touch', clientX: 260, clientY: 90});
  let prevented = false;
  app.rootEvents.beforeunload({preventDefault() { prevented = true; }});
  assert(prevented);
  const saved = app.storage.get('kuelox-paper-v2'); assert(JSON.parse(saved).count > 0);
  await app.settlePaper();
  let stablePrevented = false;
  app.rootEvents.beforeunload({preventDefault() { stablePrevented = true; }});
  assert.equal(stablePrevented, false); app.rootEvents.pagehide(); await app.settlePaper();
  assert.equal(app.storage.get('kuelox-paper-v2'), saved);
});
test('actual UI release-to-localStorage has only one real paper encoding after begin', async () => {
  for (const worker of [false, true]) {
    const app = await boot(new Map(), undefined, false, worker), c = app.elements['paper-canvas'];
    paintButton(app, '704').onclick();
    c.emit('pointerdown', {pointerId: 7, pointerType: 'touch', clientX: 100, clientY: 90});
    await app.settlePaper();
    const previous = app.context.paperEncodeCount;
    c.emit('pointermove', {pointerId: 7, pointerType: 'touch', clientX: 260, clientY: 90});
    c.emit('pointerup', {pointerId: 7, pointerType: 'touch', clientX: 260, clientY: 90});
    await app.settlePaper();
    assert.equal(app.context.paperEncodeCount - previous, 1, 'release AND storage, at the actual encodePaper boundary');
    assert(JSON.parse(app.storage.get('kuelox-paper-v2')).count > 0);
  }
});
for (const persisted of [false, true]) test('pagehide synchronously saves in-flight smudge with no async chance; BFCache=' + persisted, async () => {
  const app = await boot(new Map(), undefined, false, true), reference = await boot();
  for (const target of [app, reference]) {
    const e = target.elements, c = e['paper-canvas'];
    e['paper-size'].value = '96'; e['paper-pressure'].value = '.95';
    paintButton(target, '704').onclick(); stroke(c, 100, 90, 250, 90);
    paintButton(target, '845').onclick(); stroke(c, 190, 90, 310, 90);
  }
  await app.settlePaper();
  const old = app.storage.get('kuelox-paper-v2');
  const event = {pointerId: 7, pointerType: 'touch', clientX: 110, clientY: 90};
  for (const target of [app, reference]) {
    target.elements['tool-smudge'].onclick();
    target.elements['paper-canvas'].emit('pointerdown', event);
    target.elements['paper-canvas'].emit('pointermove', {...event, clientX: 290});
  }
  // No beforeunload and no await/settle: pagehide itself has to persist. Kill
  // all later model callbacks/rAF; an async save or empty handler must fail.
  assert.equal(app.storage.get('kuelox-paper-v2'), old);
  app.stopAsync();
  app.rootEvents.pagehide({persisted});
  reference.rootEvents.pagehide({persisted: false});
  const saved = app.storage.get('kuelox-paper-v2');
  assert.notEqual(saved, old); assert(JSON.parse(saved).count > 0);
  assert.equal(saved, reference.storage.get('kuelox-paper-v2'), 'complete v2, including wax mass and transport identities');
  assert.equal(app.frames.size, 0, 'pagehide cancels scheduled drawing');
  assert.equal(!!app.paperWorkers[0].stopped, !persisted, 'BFCache retains its Worker; final unload terminates immediately');
  const frameCalls = app.frameCalls;
  const recovered = await boot(new Map(app.storage));
  const expected = await boot(new Map(reference.storage));
  assert.deepEqual(recovered.elements['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data,
    expected.elements['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data, 'reload pixels match fully settled synchronous Engine');
  assert.equal(app.storage.get('kuelox-paper-v2'), saved, 'no late async writer required');
  assert.equal(app.frameCalls, frameCalls);
  if (persisted) {
    app.resumeAsync(); app.rootEvents.pageshow({persisted: true});
    await app.settlePaper();
    assert.equal(app.storage.get('kuelox-paper-v2'), saved);
    assert.deepEqual(app.elements['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data,
      recovered.elements['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data);
    // Continue on the surviving Worker without a replayed/double smudge.
    recovered.elements['paper-size'].value = '96'; recovered.elements['paper-pressure'].value = '.95';
    recovered.elements['tool-smudge'].onclick();
    for (const target of [app, recovered]) stroke(target.elements['paper-canvas'], 290, 90, 110, 90);
    await app.settlePaper();
    assert.equal(app.storage.get('kuelox-paper-v2'), recovered.storage.get('kuelox-paper-v2'));
    app.rootEvents.pagehide({persisted: false});
    assert(app.paperWorkers[0].stopped);
  }
});
test('pagehide also settles accepted after-picker input using the exact prefix color before asynchronous callbacks', async () => {
  const app = await boot(new Map(), undefined, false, true), reference = await boot();
  for (const target of [app, reference]) {
    const e = target.elements, c = e['paper-canvas'];
    paintButton(target, '704').onclick(); stroke(c, 100, 90, 260, 90);
    paintButton(target, '845').onclick();
    e['tool-pick'].onclick(); stroke(c, 160, 90);
    e['tool-brush'].onclick(); stroke(c, 100, 150, 260, 150);
    paintButton(target, '745').onclick(); stroke(c, 100, 210, 260, 210);
  }
  app.stopAsync(); app.rootEvents.pagehide({persisted: false}); reference.rootEvents.pagehide({persisted: false});
  const saved = app.storage.get('kuelox-paper-v2');
  assert.equal(saved, reference.storage.get('kuelox-paper-v2'));
  const restored = await boot(new Map(app.storage));
  const model = new app.context.PaperStudio.Studio();
  model.restore({...model.palette.encode(), wax: JSON.parse(saved)});
  assert.equal(M.rgbToHex(Array.from(model.paper.rgbAt(160, 150))).toUpperCase(), '#F4EC65');
  assert.equal(M.rgbToHex(Array.from(model.paper.rgbAt(160, 210))).toUpperCase(), '#722934');
  const expected = await boot(new Map(reference.storage));
  assert.deepEqual(restored.elements['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data,
    expected.elements['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data);
  assert.equal(app.frames.size, 0); assert(app.paperWorkers[0].stopped);
});
test('async picker followed before settlement by brush/shelf choice preserves each accepted ink in order', async () => {
  const app = await boot(new Map(), undefined, false, true), e = app.elements, c = e['paper-canvas'];
  paintButton(app, '704').onclick(); stroke(c, 100, 90, 260, 90);
  paintButton(app, '845').onclick(); // Current brush blue, paper yellow.
  e['tool-pick'].onclick(); stroke(c, 160, 90);
  e['tool-brush'].onclick(); stroke(c, 100, 150, 260, 150);
  paintButton(app, '745').onclick(); stroke(c, 100, 210, 260, 210);
  await app.settlePaper(); await flush();
  assert.equal(e['picked-hex'].textContent, '#F4EC65');
  const model = new app.context.PaperStudio.Studio();
  model.restore({...model.palette.encode(), wax: JSON.parse(app.storage.get('kuelox-paper-v2'))});
  assert.equal(M.rgbToHex(Array.from(model.paper.rgbAt(160, 150))).toUpperCase(), '#F4EC65');
  assert.equal(M.rgbToHex(Array.from(model.paper.rgbAt(160, 210))).toUpperCase(), '#722934');
  assert.match(e['paint-selected'].textContent, /745/);
});
test('paper UI filters eligible paints, searches by code/name and persists only paper', async () => {
  const app = await boot(), e = app.elements;
  e.product.value = 'extra-soft'; e.product.emit('change');
  assert.equal(e['paint-colors'].children.length, 144);
  app.group('7').onclick();
  assert.equal(e['paint-colors'].children.length, 48);
  assert.ok(e['paint-colors'].children.every(b => b.dataset.code.startsWith('7')));
  e['paint-search'].value = '718'; e['paint-search'].emit('input');
  assert.equal(e['paint-colors'].children.length, 1);
  paintButton(app, '718').onclick();
  e['paint-search'].value = '钴蓝'; e['paint-search'].emit('input');
  assert.equal(e['paint-colors'].children.length, 1);
  e['tool-brush'].onclick();
  stroke(e['paper-canvas'], 100, 200, 500, 200, {pointerType: 'pen', pressure: .7});
  const paper = e['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data;
  const refreshed = await boot(app.storage), re = refreshed.elements;
  assert.deepEqual([...app.storage.keys()].sort(), ['kuelox-owned-v1', 'kuelox-paper-v2']);
  assert.deepEqual(re['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data, paper);
  assert.equal(re['palette-undo'].disabled, true);
  e['only-owned'].checked = false; e['only-owned'].emit('change');
  assert.equal(e['paint-count'].textContent, '当前可用 144 支 · 显示 1 支');
  e['paint-search'].value = ''; e['paint-search'].emit('input');
  assert.equal(e['paint-colors'].children.length, 144);
});
test('paper eyedropper sends exact pigment color to solver, independent of photo correction', async () => {
  const app = await boot(), e = app.elements;
  paintButton(app, '718').onclick();
  await app.upload(photo()); e['white-balance-pick'].onclick(); await app.point(20, 16);
  stroke(e['paper-canvas'], 100, 200, 400, 200);
  e['tool-pick'].onclick(); stroke(e['paper-canvas'], 200, 200);
  const sampled = paintValue('718');
  assert.equal(e['picked-hex'].textContent, sampled);
  await samePickedTarget(app, sampled);
  e['white-balance-reset'].onclick(); await flush();
  assert.equal(e['target-hex'].textContent, sampled);
});
test('recipe stick, brush, smudge, knife, canceled pointer and clear undo as paper gestures', async () => {
  const recipe = recipeFixture(['718', '705'], [1, 4]);
  const app = await boot(new Map(), {recipes: [recipe], unreachable: false}), e = app.elements, c = e['paper-canvas'];
  await app.upload(photo()); await app.point(40, 16);
  assert.doesNotMatch(e.results.innerHTML, new RegExp(['recipe-to-' + 'palette', 'data-recipe=', '放到' + '调色' + '盘'].join('|')));
  stickClick(e, 0, 0); stroke(c, 100, 150, 300, 150);
  const before = storedState(app);
  for (const tool of ['smudge', 'paper-knife', 'brush']) {
    e['tool-' + tool].onclick(); stroke(c, 130, 150, 250, 150);
    assert.notDeepEqual(storedState(app), before, tool);
    e['palette-undo'].onclick(); assert.deepEqual(storedState(app), before, tool);
  }
  const down = {pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 200};
  c.emit('pointerdown', down);
  assert.equal(e['paper-cursor'].hidden, false, 'immediate r4 tool feedback');
  c.emit('pointermove', {...down, clientX: 300, timeStamp: 160});
  c.emit('pointercancel', down);
  assert.equal(e['paper-cursor'].hidden, true);
  assert.notDeepEqual(storedState(app), before);
  e['palette-undo'].onclick(); assert.deepEqual(storedState(app), before);
  e['palette-clear'].onclick(); assert.equal(storedState(app).wax.count, 0);
  e['palette-clear'].onclick(); // No phantom undo for clearing blank paper.
  e['palette-undo'].onclick(); assert.deepEqual(storedState(app), before);
  e['palette-undo'].onclick(); assert.equal(storedState(app).wax.count, 0);
  assert.equal(e['palette-undo'].disabled, true);
});
const recipeFixture = (codes, parts) => ({
  paints: codes.map(code => data.colors.find(p => p.code === code)), parts,
  rubbed: [99, 151, 90], layered: [200, 200, 80],
  description: '细看有差', layerDescription: '明显不同', de: 2, layerDe: 8,
});
const stickClick = (e, index, paintIndex) => e.results.emit('click', {
  target: {closest: selector => selector === '[data-paint-recipe]'
    ? {dataset: {paintRecipe: String(index), paintIndex: String(paintIndex)}} : null},
});
const shelfLabels = e => e['paint-colors'].children.map(b => b.children[1].textContent);
test('individual stick follows the whole recipe, clears stale search, searches and restores all', async () => {
  const recipes = [recipeFixture(['704', '644', '718'], [2, 1, 3]), recipeFixture(['705', '718'], [4, 1])];
  const app = await boot(new Map(), {recipes, unreachable: false}), e = app.elements;
  await app.upload(photo()); await app.point(40, 16);
  e['paint-search'].value = '不存在'; e['paint-search'].emit('input');
  stickClick(e, 0, 0);
  assert.deepEqual(shelfLabels(e), recipes[0].paints.map((p, i) => `${p.code} ${p.nameZh} · ${recipes[0].parts[i]} 份`));
  assert.equal(e['paint-show-all'].hidden, false);
  e['paint-colors'].children.forEach((b, i) => assert.equal(b.children[0].style.background, recipes[0].paints[i].hex));
  paintButton(app, '644').onclick(); stroke(e['paper-canvas'], 100, 100, 200, 100);
  e['paint-search'].value = '柠檬黄'; e['paint-search'].emit('input');
  assert.equal(e['paint-colors'].children.length, 1);
  assert.equal(e['paint-colors'].children[0].dataset.code, '704');
  e['paint-show-all'].onclick();
  assert.equal(e['paint-show-all'].hidden, true);
  assert.match(e['paint-count'].textContent, /当前可用 237 支/);
  e['paint-search'].value = ''; e['paint-search'].emit('input');
  assert.equal(e['paint-colors'].children.length, 237);
  stickClick(e, 1, 0);
  assert.deepEqual(e['paint-colors'].children.map(b => b.dataset.code), ['705', '718']);
  const stored = JSON.stringify(storedState(app));
  stickClick(e, 0, 2);
  assert.deepEqual(shelfLabels(e), recipes[0].paints.map((p, i) => `${p.code} ${p.nameZh} · ${recipes[0].parts[i]} 份`));
  assert.equal(e['tool-brush'].attributes['aria-pressed'], 'true');
  assert.match(e['paint-selected'].textContent, /718/);
  assert.equal(JSON.stringify(storedState(app)), stored, '拿来画不落笔、不改存档');
  assert.equal(e['paper-canvas'].lastScroll.block, 'center');
  e.product.value = 'extra-soft'; e.product.emit('change');
  assert.equal(e['paint-show-all'].hidden, true, '设置改范围后回到该范围全集');
});
test('paper-only UI has four tools, bounds history to 20 and never reads/writes retired surface when v2 paper exists', async () => {
  const {Palette} = require('../site/palette.js'), tray = new Palette();
  tray.squeeze(data.colors.find(p => p.code === '718'), 160, 180);
  const originalTray = JSON.stringify(tray.encode());
  const storage = new Map([['kuelox-palette-v1', originalTray]]), reads = [], writes = [];
  const get = storage.get.bind(storage), set = storage.set.bind(storage);
  storage.get = key => { reads.push(key); return get(key); };
  storage.set = (key, value) => { writes.push(key); return set(key, value); };
  const app = await boot(storage), e = app.elements;
  for (const id of ['mixing-' + 'canvas', 'tool-' + 'squeeze', 'tool-' + 'knife', 'palette-paints']) assert.equal(e[id], undefined);
  assert.equal(e['tool-brush'].attributes['aria-pressed'], 'true');
  for (const id of ['tool-smudge', 'tool-paper-knife', 'tool-pick']) assert.equal(e[id].attributes['aria-pressed'], 'false');
  for (let i = 0; i < 25; i++) stroke(e['paper-canvas'], 60 + (i % 5) * 70, 40 + Math.floor(i / 5) * 45);
  for (let i = 0; i < 20; i++) e['palette-undo'].onclick();
  assert.equal(e['palette-undo'].disabled, true);
  assert(storedState(app).wax.count > 0, 'first five gestures are beyond undo limit');
  const before = get('kuelox-paper-v2');
  e['palette-clear'].onclick(); assert.equal(storedState(app).wax.count, 0);
  e['palette-undo'].onclick(); assert.equal(get('kuelox-paper-v2'), before);
  reads.length = 0;
  const refreshed = await boot(storage);
  assert.equal(refreshed.elements['palette-undo'].disabled, true);
  assert.equal(get('kuelox-paper-v2'), before);
  assert(!reads.includes('kuelox-palette-v1'), 'v2 load must ignore old surface even if corrupt');
  assert(writes.every(key => key === 'kuelox-paper-v2'), 'only paper is saved');
  assert.equal(get('kuelox-palette-v1'), originalTray, 'clear/undo/reload never touch retired data');
});
test('legacy paper marks migrate without exposing or retaining legacy paint cells in paper undo', async () => {
  const {Palette} = require('../site/palette.js'), legacy = new Palette();
  legacy.squeeze(data.colors.find(p => p.code === '718'), 160, 180);
  legacy.paper.set(100 * 360 + 100, 0xF4EC65);
  const original = JSON.stringify(legacy.encode()), storage = new Map([['kuelox-palette-v1', original]]);
  const app = await boot(storage), e = app.elements;
  const {Studio} = require('../site/paper-studio.js'), expected = new Studio(); expected.restore(JSON.parse(original));
  e['palette-clear'].onclick(); e['palette-undo'].onclick();
  assert.deepEqual(storedState(app).wax, expected.encode().wax);
  assert.equal(storage.get('kuelox-palette-v1'), original);
  const reloaded = await boot(storage);
  assert.deepEqual(storedState(reloaded), storedState(app));
});
test('corrupt v2 paper falls back to legacy marks and keeps them after a new stroke and reload', async () => {
  const original = JSON.stringify({v: 1, cells: [], paper: [[36100, 0xF4EC65]]});
  for (const corrupt of ['{', '{}', 'null', '']) {
    const storage = new Map([['kuelox-palette-v1', original], ['kuelox-paper-v2', corrupt]]);
    const app = await boot(storage), e = app.elements;
    const pixel = elements => [...elements['paper-canvas'].getContext('2d').getImageData(125, 131, 1, 1).data];
    assert.deepEqual(pixel(e), [244, 236, 101, 255], `legacy marks restored when v2 is ${corrupt}`);
    assert.match(e['palette-storage-warning'].textContent, /已从旧存档恢复白纸笔画/);
    assert.equal(storage.get('kuelox-paper-v2'), corrupt, 'loading alone does not overwrite the failed snapshot');
    const blankPixel = [...e['paper-canvas'].getContext('2d').getImageData(300, 80, 1, 1).data];
    paintButton(app, '644').onclick(); stroke(e['paper-canvas'], 250, 80, 350, 80);
    const newPixel = [...e['paper-canvas'].getContext('2d').getImageData(300, 80, 1, 1).data];
    assert.notDeepEqual(newPixel, blankPixel, 'new blue stroke really changed the paper');
    assert.equal(JSON.parse(storage.get('kuelox-paper-v2')).v, 2);
    const refreshStorage = new Map([['kuelox-paper-v2', storage.get('kuelox-paper-v2')]]);
    const reloaded = await boot(refreshStorage);
    assert.deepEqual(pixel(reloaded.elements), [244, 236, 101, 255], 'legacy marks survive the v2 reload');
    assert.deepEqual([...reloaded.elements['paper-canvas'].getContext('2d').getImageData(300, 80, 1, 1).data],
      newPixel, 'new blue stroke also comes from the v2-only reload');
    assert.deepEqual(reloaded.elements['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data,
      e['paper-canvas'].getContext('2d').getImageData(0, 0, 448, 274).data, 'v2 alone restores every live pixel');
    assert.deepEqual(storedState(reloaded), storedState(app));
    assert.equal(storage.get('kuelox-palette-v1'), original, 'legacy bytes stay untouched');
  }
});
test('corrupt legacy paper starts blank with a warning when v2 is missing or corrupt', async () => {
  for (const paper of [undefined, '{']) {
    const storage = new Map([['kuelox-palette-v1', '{']]);
    if (paper !== undefined) storage.set('kuelox-paper-v2', paper);
    const reads = [], get = storage.get.bind(storage);
    storage.get = key => { reads.push(key); return get(key); };
    const app = await boot(storage), e = app.elements;
    assert(reads.includes('kuelox-palette-v1'), 'missing or corrupt v2 must still attempt the legacy key');
    assert.deepEqual([...e['paper-canvas'].getContext('2d').getImageData(125, 131, 1, 1).data], [248, 239, 220, 255]);
    assert.match(e['palette-storage-warning'].textContent, /本次从空白开始/);
    assert.equal(e['palette-undo'].disabled, true);
    assert.equal(storage.get('kuelox-palette-v1'), '{');
    assert.equal(storage.get('kuelox-paper-v2'), paper, 'failed reads never rewrite either key');
  }
});
test('empty v2 paper without legacy marks starts blank with a storage warning', async () => {
  const storage = new Map([['kuelox-paper-v2', '']]);
  const app = await boot(storage), e = app.elements;
  assertBlankPaper(e);
  assert.match(e['palette-storage-warning'].textContent, /没有读出.*从空白开始/);
  assert.equal(e['palette-undo'].disabled, true);
  assert.deepEqual([...storage], [['kuelox-paper-v2', '']], 'loading never rewrites or creates either paper key');
});
test('empty legacy paper without v2 starts blank with a storage warning', async () => {
  const storage = new Map([['kuelox-palette-v1', '']]);
  const app = await boot(storage), e = app.elements;
  assertBlankPaper(e);
  assert.match(e['palette-storage-warning'].textContent, /没有读出.*从空白开始/);
  assert.equal(e['palette-undo'].disabled, true);
  assert.deepEqual([...storage], [['kuelox-palette-v1', '']], 'loading never rewrites or creates either paper key');
});
test('photo recipe entry and independent paper picker each navigate to their own fresh target', async () => {
  const app = await boot(new Map(), {recipes: [recipeFixture(['704'], [1])], unreachable: false}), e = app.elements;
  await app.upload(photo()); await app.point(40, 16);
  assert.equal(e['target-row'].hidden, false);
  assert.equal(e['view-recipes'].hidden, false, '照片入口本身必须可见');
  assert.equal(e['view-recipes'].disabled, false, '照片入口必须可点击，不能禁用');
  assert.equal(typeof e['view-recipes'].onclick, 'function');
  assert.equal(e['results-title'].scrolls.length, 0, '点图不强制打断桌面或连续取色');
  for (let i = 0; i < 2; i++) {
    const before = e['results-title'].scrolls.length;
    e['view-recipes'].click();
    assert.equal(e['results-title'].scrolls.length, before + 1, '每次照片入口点击都必须新跳转');
    assert.equal(e['results-title'].scrolls[before].block, 'start');
  }
  paintButton(app, '718').onclick();
  paintButton(app, '704').onclick();
  e['tool-brush'].onclick(); stroke(e['paper-canvas'], 100, 120, 300, 120); await flush();
  for (const [surface, x, y, expected] of [
    ['paper-canvas', 200, 120, '#F4EC65'],
  ]) {
    e['tool-brush'].onclick();
    assert.equal(e['picked-color'].hidden, true, `${surface}先收起上次结果`);
    e['tool-pick'].onclick(); stroke(e[surface], x, y);
    assert.equal(e['picked-color'].hidden, false, surface);
    assert.equal(e['pick-recipe'].disabled, false, surface);
    assert.equal(e['picked-hex'].textContent, expected, `${surface}必须新取该表面的颜色，不能沿用上次取色`);
    const before = e['results-title'].scrolls.length;
    e['pick-recipe'].onclick(); await flush();
    assert.equal(e['results-title'].scrolls.length, before + 1, `${surface}吸管必须新跳转，不能读上次的结果`);
    assert.equal(e['results-title'].scrolls[before].block, 'start');
    assert.equal(e['target-hex'].textContent, expected, surface);
    assert.match(e.results.innerHTML, /data-paint-recipe="0"/, surface);
  }
});
test('portrait photo reveals an offscreen phone recipe entry only; visible entries and desktop do not scroll', async () => {
  const app = await boot(), e = app.elements, entry = e['view-recipes'];
  const portrait = createCanvas(1200, 1600), ctx = portrait.getContext('2d');
  ctx.fillStyle = '#75B7BC'; ctx.fillRect(0, 0, 1200, 1600);
  await app.upload(new File([portrait.toBuffer('image/png')], 'portrait.png', {type: 'image/png'}));
  app.context.innerWidth = 390; app.context.innerHeight = 844;
  let entryTop = 872;
  entry.getBoundingClientRect = () => ({top: entryTop, bottom: entryTop + 44, left: 200, right: 345, width: 145, height: 44});
  const scroll = entry.scrollIntoView.bind(entry);
  entry.scrollIntoView = options => { scroll(options); entryTop = 800; };
  await app.point(300, 320);
  assert.equal(e['target-row'].hidden, false); assert.equal(entry.hidden, false);
  assert.equal(entry.scrolls.length, 1, '竖图目标行在首屏外时必须露出入口');
  assert.equal(entry.scrolls[0].block, 'nearest');
  assert.equal(entry.scrolls[0].behavior, 'auto');
  assert(entry.getBoundingClientRect().top >= 0 && entry.getBoundingClientRect().bottom <= 844);
  await app.point(300, 321);
  assert.equal(entry.scrolls.length, 1, '可见入口无需再滚动');
  entryTop = 950; app.context.innerWidth = 1280;
  await app.point(300, 322);
  assert.equal(entry.scrolls.length, 1, '桌面即使目标在屏外也保持原行为');
});
test('explicit shelf/stick selection aligns brush pigment; showing all preserves picked RGB', async () => {
  const recipes = [recipeFixture(['704', '644'], [2, 1]), recipeFixture(['605', '645'], [7, 3])];
  const app = await boot(new Map(), {recipes, unreachable: false}), e = app.elements;
  await app.upload(photo()); await app.point(40, 16);
  stickClick(e, 0, 1);
  assert.equal(e['paint-selected'].textContent, '当前笔色：644 靛蓝彩雀');
  assert.equal(paintButton(app, '644').attributes['aria-pressed'], 'true');
  stroke(e['paper-canvas'], 100, 80, 200, 80);
  e['tool-pick'].onclick(); stroke(e['paper-canvas'], 160, 80); await samePickedTarget(app, paintValue('644'));
  e['paint-show-all'].onclick();
  assert.match(e['paint-selected'].textContent, /吸管 #2063AD/);
  stickClick(e, 1, 0);
  assert.equal(e['paint-selected'].textContent, '当前笔色：605 牛轧糖');
  paintButton(app, '645').onclick();
  assert.equal(e['paint-selected'].textContent, '当前笔色：645 莫吉托');
  stroke(e['paper-canvas'], 250, 80, 350, 80);
  e['tool-pick'].onclick(); stroke(e['paper-canvas'], 300, 80); await samePickedTarget(app, paintValue('645'));
});
test('white paper light/medium/heavy replaces old brush selector; pen reads pressure, mouse ignores velocity', async () => {
  async function painted(extra, timeStamp, pressure) {
    const app = await boot(), e = app.elements; paintButton(app, '718').onclick(); e['tool-brush'].onclick();
    e['paper-pressure'].value = pressure;
    e['paper-canvas'].emit('pointerdown', {pointerId: 1, clientX: 100, clientY: 150, timeStamp: 1, ...extra});
    e['paper-canvas'].emit('pointermove', {pointerId: 1, clientX: 350, clientY: 150, timeStamp, ...extra});
    e['paper-canvas'].emit('pointerup', {pointerId: 1, clientX: 350, clientY: 150, timeStamp: timeStamp + 1, ...extra});
    return storedState(app).wax.count;
  }
  assert.ok(await painted({pointerType: 'pen', pressure: .2}, 100, '0.95') < await painted({pointerType: 'pen', pressure: .9}, 100, '0.2'));
  assert.ok(await painted({pointerType: 'touch'}, 100, '0.2') < await painted({pointerType: 'touch'}, 100, '0.95'));
  assert.equal(await painted({pointerType: 'mouse'}, 10, '0.55'), await painted({pointerType: 'mouse'}, 1000, '0.55'));
  const app = await boot(), e = app.elements;
  assert.equal(e['brush-mode'], undefined); assert.equal(e['paper-pressure'].value, '0.55');
  e['tool-smudge'].onclick(); assert.match(e['palette-status'].textContent, /白纸揉擦/);
  e['tool-paper-knife'].onclick(); assert.match(e['palette-status'].textContent, /见底层/);
});
test('unsupported storage still draws new wax paper and retains undo', async () => {
  const app = await boot({get() { throw new Error('denied'); }, set() { throw new Error('denied'); }}), e = app.elements;
  assert.match(e['palette-storage-warning'].textContent, /上次白纸没有读出/);
  e['tool-brush'].onclick(); stroke(e['paper-canvas'], 100, 150, 350, 150);
  assert.equal(e['palette-undo'].disabled, false);
  assert.match(e['palette-storage-warning'].textContent, /未能保存/);
  e['palette-undo'].onclick(); assert.equal(e['palette-undo'].disabled, true);
});
test('independent photo eyedropper auto-solves corrected pixels, reference stays separate and keyboard uses same path', async () => {
  const app = await boot(), e = app.elements;
  await app.upload(photo()); await app.point(40, 16);
  const beforeMessages = app.messages.length;
  e['tool-pick'].onclick(); await app.point(52, 16);
  await samePhotoTarget(app, '#60457C');
  assert.equal(app.messages.length, beforeMessages + 1);
  assert.equal(e['picked-color'].hidden, true);
  e['white-balance-pick'].onclick(); await app.point(20, 16);
  const corrected = pixelHex(e.photo, 52, 16);
  assert.notEqual(corrected, '#60457C');
  const messageCount = app.messages.length;
  await app.point(52, 16); await samePhotoTarget(app, corrected);
  assert.equal(app.messages.length, messageCount + 1);
  e['white-balance-reset'].onclick(); await flush();
  assert.equal(e['target-hex'].textContent, '#60457C', 'stored photo pixel region is resampled from original');
  e.photo.emit('keydown', {key: 'Enter'}); await samePhotoTarget(app, pixelHex(e.photo, 32, 16));
  await app.drag(34, 12, 52, 20); await samePhotoTarget(app, '#60457C');
  assert.equal(e['tool-pick'].attributes['aria-pressed'], 'true', 'photo never changes paper tool');
});
test('single-stick recipe card truthfully shows one stick and both prediction colors', async () => {
  const paint = data.colors.find(p => p.code === '704'), rgb = M.hexToRgb(paint.hex);
  const recipe = {paints: [paint], parts: [1], rubbed: rgb, layered: rgb, de: 0, layerDe: 0,
    description: '几乎看不出', layerDescription: '几乎看不出'};
  const app = await boot(new Map(), {recipes: [recipe], unreachable: false});
  await app.upload(photo()); await app.point(40, 16);
  const html = app.elements.results.innerHTML;
  assert.match(html, /用 1 支/); assert.match(html, /这里只有一支颜色/);
  assert.match(html, /先试单支 · 几乎看不出/); assert.doesNotMatch(html, /最接近/);
  assert.match(html, /揉匀后（预测）/); assert.match(html, /叠涂后（预测）/);
  assert.equal([...html.matchAll(new RegExp(`<code>${paint.hex}</code>`, 'g'))].length, 2);
});
test('sample single-stick first card explicitly says 明显不同 instead of claiming closest', async () => {
  const paint = data.colors.find(p => p.code === '704'), rgb = M.hexToRgb(paint.hex);
  const recipe = {paints: [paint], parts: [1], rubbed: rgb, layered: rgb, de: 3.105174618436, layerDe: 3.105174618436,
    description: '明显不同', layerDescription: '明显不同'};
  const app = await boot(new Map(), {recipes: [recipe], unreachable: false});
  await app.upload(photo()); await app.point(40, 16);
  assert.match(app.elements.results.innerHTML, /先试单支 · 明显不同/);
  assert.match(app.elements.results.innerHTML, /ΔE00 3.11/);
  assert.doesNotMatch(app.elements.results.innerHTML, /最接近/);
});
const centerHex = (app, source = 'pick') => pixelHex(app.elements[source + '-loupe-canvas'], 5, 5);
async function preview(app, canvas, x, y, extra = {}) {
  canvas.emit('pointermove', {pointerId: 9, pointerType: 'mouse', clientX: x, clientY: y, ...extra});
  await flush();
  const source = canvas === app.elements.photo ? 'photo' : 'pick';
  assert.equal(app.elements[source + '-loupe'].hidden, false);
  assert.equal(app.elements[source + '-loupe-hex'].textContent, centerHex(app, source));
  return centerHex(app, source);
}
async function samePhotoTarget(app, hex) {
  await flush();
  assert.equal(app.elements['target-hex'].textContent, hex);
  assert.equal(app.elements['target-swatch'].style.background, hex);
  assert.deepEqual(Array.from(app.messages.at(-1).target), M.hexToRgb(hex));
  assert.equal(app.elements['picked-color'].hidden, true, 'photo never fills the paper picker');
}
async function samePickedTarget(app, hex) {
  const e = app.elements;
  assert.equal(e['picked-hex'].textContent, hex);
  assert.equal(e['picked-swatch'].style.background, hex);
  e['pick-recipe'].onclick(); await flush();
  assert.equal(e['target-swatch'].style.background, hex);
  assert.equal(e['target-hex'].textContent, hex);
  assert.deepEqual(Array.from(app.messages.at(-1).target), M.hexToRgb(hex));
}
test('photo loupe center, target and solver match before/after correction; reference previews without picking', async () => {
  const app = await boot(), e = app.elements;
  await app.upload(photo()); e['tool-pick'].onclick();
  const before = await preview(app, e.photo, 40, 16);
  assert.equal(before, '#474E9F');
  await app.point(40, 16); await samePhotoTarget(app, before);
  const count = app.animations.length;
  assert.equal(count, 4); // One drop and three splashes.
  await preview(app, e.photo, 20, 16);
  e['white-balance-pick'].onclick();
  assert.equal(e['photo-loupe'].hidden, true);
  e.photo.emit('pointermove', {clientX: 20, clientY: 16, pointerType: 'mouse'}); await flush();
  assert.equal(e['photo-loupe'].hidden, false);
  await app.point(20, 16);
  assert.equal(e['white-balance-status'].textContent, '已按白纸校正');
  assert.equal(e['picked-color'].hidden, true);
  assert.equal(app.animations.length, count);
  const corrected = await preview(app, e.photo, 40, 16);
  assert.notEqual(corrected, before);
  assert.equal(corrected, pixelHex(e.photo, 40, 16));
  await app.point(40, 16); await samePhotoTarget(app, corrected);
  e['white-balance-reset'].onclick();
  const restored = await preview(app, e.photo, 40, 16);
  assert.equal(restored, before);
});
test('loupe center matches paper pigment pixels, independent of photo white balance', async () => {
  const app = await boot(), e = app.elements;
  await app.upload(photo()); e['white-balance-pick'].onclick(); await app.point(20, 16);
  paintButton(app, '718').onclick();
  e['tool-brush'].onclick(); stroke(e['paper-canvas'], 100, 200, 500, 200);
  e['tool-pick'].onclick();
  for (const [canvas, x, y] of [[e['paper-canvas'], 200, 200]]) {
    const hex = await preview(app, canvas, x, y);
    assert.equal(hex, paintValue('718'));
    stroke(canvas, x, y); await samePickedTarget(app, hex);
    assert.equal(e['pick-loupe'].hidden, true);
  }
});
test('photo touch/pen drag picks release center, not down point or rectangle average; cancel and photo mode switch do not pick', async () => {
  for (const pointerType of ['touch', 'pen']) {
    const app = await boot(), e = app.elements;
    await app.upload(photo()); e['tool-pick'].onclick();
    const start = {pointerId: 9, pointerType, clientX: 40, clientY: 16};
    e.photo.emit('pointerdown', start);
    const hex = await preview(app, e.photo, 52, 16, {pointerType});
    assert.equal(hex, '#60457C'); assert.equal(e['picked-color'].hidden, true);
    assert.equal(e.selection.hidden, true);
    e.photo.emit('pointerup', {...start, clientX: 52}); await samePhotoTarget(app, hex);
    const count = app.animations.length;
    e.photo.emit('pointerdown', start); e.photo.emit('pointercancel', start);
    e.photo.emit('pointerup', start);
    assert.equal(e['target-hex'].textContent, hex); assert.equal(app.animations.length, count);
    e.photo.emit('pointerdown', start); e['photo-average'].onclick(); e.photo.emit('pointerup', start);
    assert.equal(e['target-hex'].textContent, hex); assert.equal(e['photo-loupe'].hidden, true);
  }
});
test('paper touch/pen drag waits for release, uses scaled/edge pixel and cancels capture cleanly', async () => {
  const app = await boot(), e = app.elements;
  paintButton(app, '718').onclick();
  e['tool-brush'].onclick(); stroke(e['paper-canvas'], 100, 200, 500, 200);
  e['tool-pick'].onclick();
  for (const [pointerType, x, y] of [['touch', 200, 200], ['pen', 200, 200]]) {
    const canvas = e['paper-canvas'], scale = .5;
    canvas.getBoundingClientRect = () => ({left: 20, top: 30, width: canvas.width * scale, height: canvas.height * scale});
    const start = {pointerId: 9, pointerType, clientX: 21, clientY: 31};
    const previous = e['picked-hex'].textContent;
    canvas.emit('pointerdown', start);
    const hex = await preview(app, canvas, 20 + x / 2, 30 + y / 2, {pointerType});
    assert.equal(hex, paintValue('718')); assert.equal(e['picked-hex'].textContent, previous);
    canvas.emit('pointerup', {...start, clientX: 20 + x / 2, clientY: 30 + y / 2});
    await samePickedTarget(app, hex);
    canvas.emit('pointerdown', start); canvas.emit('lostpointercapture', start); canvas.emit('pointerup', start);
    assert.equal(e['picked-hex'].textContent, hex); assert.equal(e['pick-loupe'].hidden, true);
    const edge = await preview(app, canvas, -100, -100);
    assert.equal(edge, '#F8EFDC');
    canvas.emit('pointerleave'); assert.equal(e['pick-loupe'].hidden, true);
  }
});
test('each recipe stick can become exact current brush pigment and brush tool, without adding dabs or changing renderer', async () => {
  const paints = ['718', '705'].map(code => data.colors.find(p => p.code === code));
  const recipe = {paints, parts: [1, 4], rubbed: [99, 151, 90], layered: [200, 200, 80],
    description: '细看有差', layerDescription: '明显不同', de: 2, layerDe: 8};
  const app = await boot(new Map(), {recipes: [recipe], unreachable: false}), e = app.elements;
  await app.upload(photo()); await app.point(40, 16);
  assert.equal([...e.results.innerHTML.matchAll(/>拿来画<\/button>/g)].length, 2);
  for (const [index, paint] of paints.entries()) {
    e['palette-clear'].onclick(); e['tool-pick'].onclick();
    e.results.emit('click', {target: {closest: selector => selector === '[data-paint-recipe]' ?
      {dataset: {paintRecipe: '0', paintIndex: String(index)}} : null}});
    assert.equal(e['tool-brush'].attributes['aria-pressed'], 'true');
    assert.equal(e['tool-pick'].attributes['aria-pressed'], 'false');
    assert.equal(e['paint-selected'].textContent, `当前笔色：${paint.code} ${paint.nameZh}`);
    assert.equal(paintButton(app, paint.code).attributes['aria-pressed'], 'true');
    stroke(e['paper-canvas'], 100, 200, 400, 200, {pointerType: 'pen', pressure: .7});
    const encoded = storedState(app);
    assert.ok(encoded.wax.count);
    assert.ok(encoded.wax.pigments.every(([shares]) => shares.every(([hex]) => hex === paint.hex.toUpperCase())));
    const {Surface, Pigments} = require('../site/wax-paper.js'), {encodePaper} = require('../site/paper-studio.js');
    const pigments = new Pigments(), expected = new Surface(448, 274, [248,239,220], pigments);
    const settings = {tool: 'brush', pigment: pigments.color(paint.hex), strength: .7, radius: 448 * 45 / 1370 * (.46 + .7 * .72),
      angle: 0, tilt: 0, dry: false, strokeId: expected.beginStroke()};
    expected.stroke({x: 100, y: 200}, {x: 100, y: 200}, settings);
    expected.stroke({x: 100, y: 200}, {x: 400, y: 200}, settings);
    // UI retains earlier color-cache identities across clear; the fresh r4
    // fixture does not. Compare unchanged physical encoding, not cache history.
    const {transport: actualCache, ...actualWax} = encoded.wax;
    const {transport: expectedCache, ...expectedWax} = encodePaper(expected);
    assert.deepEqual(actualWax, expectedWax); // r4 coverage/masses unchanged.
    e['tool-pick'].onclick();
    assert.equal(e['picked-color'].hidden, true);
    const shades = new Set();
    for (const [x,y] of [[200,191],[200,200],[200,205],[202,195]]) {
      shades.add(pixelHex(e['paper-canvas'],x,y));
      assert.equal(await preview(app,e['paper-canvas'],x,y), paint.hex.toUpperCase());
      stroke(e['paper-canvas'],x,y); await samePickedTarget(app,paint.hex.toUpperCase());
    }
    assert(shades.size > 1, 'stroke really has relief variation');
    assert.equal(e['picked-color'].hidden,false); e['tool-brush'].onclick();
    assert.equal(e['picked-color'].hidden,true, 'result cannot intercept drawing after leaving picker');
  }
});
test('reduced motion shows result immediately without animations; enabling it cancels live droplets', async () => {
  const app = await boot(new Map(), undefined, true), e = app.elements;
  await app.upload(photo()); e['tool-pick'].onclick(); await app.point(40, 16);
  assert.equal(e['target-hex'].textContent, '#474E9F'); assert.equal(app.animations.length, 0);
  await samePhotoTarget(app, '#474E9F');
  app.motion.matches = false; await app.point(52, 16);
  assert.equal(app.animations.length, 4);
  app.motion.matches = true; app.motion.change({matches: true});
  assert.ok(app.animations.every(animation => animation.canceled));
  assert.equal(app.document.body.children.length, 0);
  await app.point(40, 16);
  assert.equal(app.animations.length, 4); assert.equal(e['target-hex'].textContent, '#474E9F');
});
test('new paper rubbed transition still shares loupe/picked/solver color and paints the picked RGB pigment', async () => {
  const app=await boot(),e=app.elements,c=e['paper-canvas'];
  e['paper-size'].value='96';e['paper-pressure'].value='0.95';e['tool-brush'].onclick();
  paintButton(app,'704').onclick();stroke(c,448*.425,274*.3,448*.425,274*.7);
  paintButton(app,'644').onclick();stroke(c,448*.575,274*.3,448*.575,274*.7);
  e['paper-size'].value='96';e['paper-pressure'].value='0.55';e['tool-smudge'].onclick();
  for(let pass=0;pass<8;pass++)stroke(c,448*(pass%2?.7:.3),137,448*(pass%2?.3:.7),137);
  e['tool-pick'].onclick();const hex=await preview(app,c,229,137);
  assert(M.deltaE2000(M.rgbToLab(M.hexToRgb(hex)), M.rgbToLab([96,179,119])) < 2, `not a rubbed 704/644 transition: ${hex}`);
  stroke(c,229,137);await samePickedTarget(app,hex);
  e['tool-brush'].onclick();stroke(c,360,240,400,240);
  const {decodePaper} = require('../site/paper-studio.js'), {Pigments} = require('../site/soft-smudge.js');
  const paper = decodePaper(storedState(app).wax, new Pigments());
  assert.ok(paper.cells.some((p,i)=> i%448>350 && Math.floor(i/448)>220 && p?.shares.some(([h])=>h===hex)));
});

function paintValue(code) { return data.colors.find(p => p.code === code).hex.toUpperCase(); }
function storedState(app) { return {wax: JSON.parse(app.storage.get('kuelox-paper-v2'))}; }

test('same-frame release confirms the final visible center on all sources; unrelated photo pointer endings and tool hints are isolated', async () => {
  for(const source of ['photo','paper-canvas']) {
    const app=await boot(),e=app.elements,c=e[source];await app.upload(photo());
    paintButton(app,'718').onclick();
    e['tool-brush'].onclick();stroke(e['paper-canvas'],100,200,300,200);
    e['tool-pick'].onclick();
    assert.match(e['pick-info'].textContent,/自动(?:出|找)配方/);
    if(source==='photo') {e['white-balance-pick'].onclick();await app.point(20,16);assert.match(e['pick-info'].textContent,/自动(?:出|找)配方/);e['white-balance-reset'].onclick();}
    const prefix=source==='photo'?'photo':'pick';
    const start=source==='photo'?[40,16]:[10,10],end=source==='photo'?[52,16]:[160,200];
    const down={pointerId:9,pointerType:'touch',clientX:start[0],clientY:start[1]};
    const release={...down,clientX:end[0],clientY:end[1]};
    for (const ending of ['normal boundaries', 'cancel', 'switch tool']) {
      e['tool-pick'].onclick();
      c.emit('pointerdown',down);await flush();const before=centerHex(app,prefix);
      for(const type of ['pointercancel','lostpointercapture'])c.emit(type,{...down,pointerId:2});
      c.emit('pointermove',release);
      if (ending === 'cancel') {
        c.emit('pointercancel',release);c.emit('pointerup',release);
        assert.equal(e[prefix+'-loupe'].hidden,true,'cancel still hides immediately');continue;
      }
      c.emit('pointerup',release); // NO frame between move/up/boundaries.
      const final=centerHex(app,prefix);assert.notEqual(final,before);assert.equal(e[prefix+'-loupe-hex'].textContent,final);
      for (const type of ['lostpointercapture','pointerout','pointerleave']) c.emit(type,release);
      assert.equal(e[prefix+'-loupe'].hidden,false,'normal release boundaries retain final painted snapshot');
      assert.equal(centerHex(app,prefix),final);
      if (ending === 'switch tool') {
        if(source==='photo')e['photo-average'].onclick();else e['tool-brush'].onclick();
        assert.equal(e[prefix+'-loupe'].hidden,true,'source-local mode switch hides even before final frame');
        if(source==='photo')e['photo-pick'].onclick();
      } else {
        await (source==='photo'?samePhotoTarget:samePickedTarget)(app,final);assert.equal(e[prefix+'-loupe'].hidden,true);
      }
    }
    e['tool-brush'].onclick();assert.equal(e['picked-color'].hidden,true);
    assert.match(e['pick-info'].textContent,/自动(?:出|找)配方/);
  }
  const app=await boot(),e=app.elements;e['tool-pick'].onclick();await app.upload(photo());
  assert.match(e['pick-info'].textContent,/自动(?:出|找)配方/);
  const api=vm.runInContext('PaletteUI.mount({})',app.context);
  assert.equal(api.pickColor,undefined);
});

test('five MiB aggregate quota retains full heavy paper and rubbed bands; rejected saving preserves live paper and undo', async () => {
  const quota=5*1024**2;
  class LimitedStore extends Map {
    set(key,value) {
      const bytes=[...this].filter(([k])=>k!==key).reduce((sum,[k,v])=>sum+2*(k.length+v.length),0)+2*(key.length+value.length);
      this.largest=Math.max(this.largest||0,bytes);
      if(bytes>quota || (this.rejectPaper&&key==='kuelox-paper-v2')) {this.rejected=true;throw Error('QuotaExceededError');}
      return super.set(key,value);
    }
  }
  for(const rubbed of [false,true]) {
    const storage=new LimitedStore(),app=await boot(storage),e=app.elements,c=e['paper-canvas'];
    e['paper-pressure'].value='.95';e['paper-size'].value='96';e['tool-brush'].onclick();
    for(const [n,y] of (rubbed?[90,125,160]:[34,102,170,238]).entries()) {
      paintButton(app,rubbed&&n%2?'644':'704').onclick();
      stroke(c,rubbed?80:8,y,rubbed?368:440,y);
    }
    if(rubbed) {e['tool-smudge'].onclick();e['paper-pressure'].value='.55';for(const y of [107.5,142.5])stroke(c,82,y,366,y);}
    assert(!storage.rejected);assert.equal(e['palette-storage-warning'].textContent,'');
    const saved=storedState(app),live=c.getContext('2d').getImageData(0,0,448,274).data;
    const reloaded=await boot(storage);
    assert.deepEqual(storedState(reloaded),saved);
    assert.deepEqual(reloaded.elements['paper-canvas'].getContext('2d').getImageData(0,0,448,274).data,live);
    console.log('quota regression',rubbed?'rubbed bands':'four heavy strokes',JSON.stringify({peakUTF16Bytes:storage.largest,paperJSONBytes:Buffer.byteLength(storage.get('kuelox-paper-v2'))}));
    storage.rejectPaper=true; e['tool-brush'].onclick(); paintButton(app,'644').onclick(); stroke(c,300,180,350,180);
    assert.match(e['palette-storage-warning'].textContent,/^白纸/);
    assert.equal(e['palette-undo'].disabled,false);
    assert.deepEqual(storedState(app),saved,'failed save leaves last stored paper intact');
    const {Pigments}=require('../site/soft-smudge.js'),{decodePaper}=require('../site/paper-studio.js');
    e['tool-pick'].onclick();
    assert.notEqual(M.rgbToHex(decodePaper(saved.wax,new Pigments()).rgbAt(320,180)).toUpperCase(),await preview(app,c,320,180));
    e['palette-undo'].onclick();
    assert.deepEqual(c.getContext('2d').getImageData(0,0,448,274).data,live,'undo still restores live paper after rejected saving');
  }
});

function paperLine(app,start,end,tool,pressure,size,code,steps=32) {
  const e=app.elements,c=e['paper-canvas'];
  e['paper-pressure'].value=String(pressure);e['paper-size'].value=String(size);
  if (code) paintButton(app,code).onclick();
  e['tool-'+tool].onclick();
  const down={pointerId:7,pointerType:'touch',clientX:start[0],clientY:start[1]};
  c.emit('pointerdown',down);let last=down;
  if (start[0]!==end[0] || start[1]!==end[1]) for(let k=1;k<=steps;k++) {
    last={...down,clientX:start[0]+(end[0]-start[0])*k/32,clientY:start[1]+(end[1]-start[1])*k/32};
    c.emit('pointermove',last);
  }
  c.emit('pointerup',last);
}

test('opened zero-wax pore discards its old color before repaint/reload; fresh rubbing uses current neighbor pigments', async () => {
  for(const reloadOpen of [false,true]) {
    let app=await boot();
    paperLine(app,[217,80],[217,194],'brush',.2,45,'704');
    paperLine(app,[231,80],[231,194],'brush',.2,45,'644');
    for(let pass=0;pass<8;pass++)
      paperLine(app,[224,pass%2?183:90],[224,pass%2?90:183],'smudge',.2,45);
    const i=109*448+221;
    assert(storedState(app).wax.pores.some(([index])=>index===i));
    paperLine(app,[221,103],[221,116],'paper-knife',.95,14);
    assert(!storedState(app).wax.pores?.some(([index])=>index===i),'opening must remove persisted old pore');
    if(reloadOpen)app=await boot(app.storage);
    for(const point of [[217,109],[225,109],[221,105],[221,113]])
      paperLine(app,point,point,'brush',.55,14,'713');
    for(const check of [app,await boot(app.storage)]) {
      const e=check.elements;e['tool-pick'].onclick();
      stroke(e['paper-canvas'],221,109);await samePickedTarget(check,'#F8EFDC');
      assert(!storedState(check).wax.pores?.some(([index])=>index===i));
      assert.notEqual(pixelHex(e['paper-canvas'],221,109),'#62B477');
    }
    for(let pass=0;pass<8;pass++)
      paperLine(app,[221,103],[221,116],'smudge',.2,14);
    const {Studio}=require('../site/paper-studio.js'),model=new Studio();model.restore({...model.palette.encode(), ...storedState(app)});
    assert.equal(model.paper.mass[i],0);
    assert(model.paper.pores[i],'fresh rubbing recreates optical cover');
    const local={};
    for(const index of [i-1,i+1,i-448,i+448])
      for(const [hex,weight]of model.paper.cells[index].shares)local[hex]=(local[hex]||0)+weight;
    assert.deepEqual(model.paper.pores[i].rgb,model.pigments.fine(local).rgb);
    assert.notDeepEqual(model.paper.pores[i].rgb,[98,180,119]);
    const hex=M.rgbToHex(model.paper.pores[i].rgb).toUpperCase();
    app.elements['tool-pick'].onclick();stroke(app.elements['paper-canvas'],221,109);
    await samePickedTarget(app,hex);
  }
});

test('near-limit eight-pair paper persists under five MiB with indexed transport identities and reloads exactly', async () => {
  const limit=5*1024**2;
  const storage=new class extends Map {
    set(key,value) {
      const bytes=2*(key.length+value.length)+[...this].filter(([k])=>k!==key)
        .reduce((sum,[k,v])=>sum+2*(k.length+v.length),0);
      if(key==='kuelox-paper-v2')this.lastAttempt={bytes,accepted:bytes<=limit};
      if(bytes>limit)throw Error('QuotaExceededError');
      return super.set(key,value);
    }
  };
  const extras=data.colors.filter(p=>!['#F4EC65','#2063AD'].includes(p.hex.toUpperCase()));
  // Preserve ten real tray dabs in the shared localStorage quota, rather than
  // testing this near-limit paper only with an empty tray.
  const {Palette}=require('../site/palette.js'),tray=new Palette();
  for(let n=0;n<10;n++)tray.squeeze(extras[n],55+53*n,75);
  storage.set('kuelox-palette-v1',JSON.stringify(tray.encode()));
  const withTray=await boot(storage);
  for(const [start,end,tool,code]of [
    [[208,80],[208,194],'brush','704'],[[240,80],[240,194],'brush','644'],
    [[150,137],[325,137],'smudge'],[[325,138],[150,138],'smudge']
  ])paperLine(withTray,start,end,tool,.95,45,code);
  for(let n=0;n<8;n++) {
    paperLine(withTray,[53,28],[53,82],'brush',.95,45,extras[n*2].code);
    paperLine(withTray,[70,28],[70,82],'brush',.95,45,extras[n*2+1].code);
    assert(storage.lastAttempt.accepted);
    paperLine(withTray,[34,50],[101,50],'smudge',.95,45,undefined,n===7?12:32);
    if(n<7)paperLine(withTray,[101,52],[34,52],'smudge',.95,45);
  }
  assert(storage.lastAttempt.accepted,`near-limit snapshot exceeds quota: ${storage.lastAttempt.bytes}`);
  assert.equal(withTray.elements['palette-storage-warning'].textContent,'');
  await flush();const reload=await boot(storage);
  const image=fixture=>fixture.elements['paper-canvas'].getContext('2d').getImageData(0,0,448,274).data;
  assert.deepEqual(image(reload),image(withTray));
  assert.equal(storage.get('kuelox-palette-v1'),JSON.stringify(tray.encode()),'legacy storage still counts against quota but is never edited');
  console.log('near-limit quota',JSON.stringify(storage.lastAttempt));
});

function coordinatePhoto() {
  const c = createCanvas(64, 48), ctx = c.getContext('2d'), image = ctx.createImageData(64, 48);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++)
    image.data.set([150 + x, 150 + y, 150 + (x + y) % 60, 255], (y * 64 + x) * 4);
  ctx.putImageData(image, 0, 0);
  return new File([c.toBuffer('image/png')], 'coordinates.png', {type: 'image/png'});
}
function photoGeometry(e) {
  const base = {left: 120.25, top: 260.5, width: 128.5, height: 96.375};
  e.photo.baseRect = base;
  e['image-stage'].getBoundingClientRect = () => base;
  return base;
}
function clippedPhotoGeometry(e) {
  const base = photoGeometry(e), stage = e['image-stage'];
  stage.clientLeft = stage.clientTop = 1;
  stage.clientWidth = Math.round(base.width); stage.clientHeight = Math.round(base.height);
  stage.offsetWidth = Math.round(base.width + 2); stage.offsetHeight = Math.round(base.height + 2);
  stage.computedStyle = {borderTopLeftRadius: '12px', borderTopRightRadius: '12px',
    borderBottomRightRadius: '12px', borderBottomLeftRadius: '12px',
    borderRightWidth: '1px', borderBottomWidth: '1px'};
  stage.getBoundingClientRect = () => ({left: base.left - 1, top: base.top - 1,
    width: base.width + 2, height: base.height + 2});
  return base;
}
function projected(c, x, y, id = 9, pointerType = 'touch') {
  const r = c.getBoundingClientRect();
  return {pointerId: id, pointerType, clientX: r.left + (x + .5) * r.width / c.width,
    clientY: r.top + (y + .5) * r.height / c.height};
}
function zoomTo(e, zoom) { e['photo-zoom-reset'].onclick(); for (let z = 1; z < zoom; z += .5) e['photo-zoom-in'].onclick(); }
function panPhoto(e, dx, dy) {
  e['photo-pan'].onclick();
  const r = e['image-stage'].getBoundingClientRect();
  const down = {pointerId: 3, pointerType: 'mouse', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2};
  e.photo.emit('pointerdown', down);
  e.photo.emit('pointermove', {...down, clientX: down.clientX + dx, clientY: down.clientY + dy});
  e.photo.emit('pointerup', down); e['photo-pan'].onclick();
}
function clickPixel(e, x, y) {
  const at = projected(e.photo, x, y);
  e.photo.emit('pointerdown', at); e.photo.emit('pointerup', at);
}
test('photo default picker and average are independent of all four paper tools; mouse hover and down-move-up auto-solve', async () => {
  const app = await boot(), e = app.elements; await app.upload(coordinatePhoto());
  assert.equal(e['photo-tools'].hidden, false);
  assert.equal(e['photo-pick'].attributes['aria-pressed'], 'true');
  assert.equal(e['photo-average'].attributes['aria-pressed'], 'false');
  assert.equal(e['tool-brush'].attributes['aria-pressed'], 'true');
  for (const tool of ['brush', 'smudge', 'paper-knife', 'pick']) {
    e['tool-' + tool].onclick();
    await preview(app, e.photo, 20, 18);
    const down = {pointerId: 9, pointerType: 'touch', clientX: 20, clientY: 18};
    e.photo.emit('pointerdown', down); await flush();
    assert.equal(e['photo-loupe'].hidden, false);
    e.photo.emit('pointermove', {...down, clientX: 42}); await flush();
    assert.equal(centerHex(app, 'photo'), pixelHex(e.photo, 42, 18));
    e.photo.emit('pointerup', {...down, clientX: 42});
    await samePhotoTarget(app, pixelHex(e.photo, 42, 18));
    e['photo-average'].onclick(); await app.drag(20, 18, 42, 26);
    assert.match(e['pick-info'].textContent, /23 × 9.*平均/);
    assert.equal(e['tool-' + tool].attributes['aria-pressed'], 'true');
    e['photo-pick'].onclick(); assert.equal(e['photo-average'].attributes['aria-pressed'], 'false');
    assert.equal(e['tool-' + tool].attributes['aria-pressed'], 'true');
  }
});
for (const zoom of [2, 4]) test(`photo ${zoom}x fractional viewport with all four panned edges: exact loupe, pick, average and original white reference before/after correction`, async () => {
  const app = await boot(), e = app.elements; await app.upload(coordinatePhoto()); photoGeometry(e);
  const W = require('../site/white-balance.js');
  const original = e.photo.getContext('2d').getImageData(0, 0, 64, 48);
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    zoomTo(e, zoom); panPhoto(e, sx * 10000, sy * 10000);
    const x = sx > 0 ? 0 : 63, y = sy > 0 ? 0 : 47;
    const at = projected(e.photo, x, y);
    const prior = app.messages.length;
    e['white-balance-pick'].onclick();
    e.photo.emit('pointerdown', at); await flush();
    assert.equal(centerHex(app, 'photo'), pixelHex(e.photo, x, y));
    e.photo.emit('pointerup', at); await flush();
    assert.equal(app.messages.length, prior, 'reference without target never solves');
    assert.equal(e['white-balance-status'].textContent, '已按白纸校正');
    const expected = W.apply(original, W.referenceAt(original, x, y));
    assert.deepEqual(e.photo.getContext('2d').getImageData(0, 0, 64, 48).data, expected.data);
    clickPixel(e, x, y); await flush();
    e['white-balance-reset'].onclick(); await flush();
    assert.deepEqual(Array.from(app.messages.at(-1).target), [...original.data.subarray((y*64+x)*4,(y*64+x)*4+3)],
      'resampling a stored one-pixel target preserves exact integer solver RGB');
    e['white-balance-pick'].onclick(); clickPixel(e, x, y); await flush();
    for (const corrected of [true, false]) {
      if (!corrected) { e['white-balance-reset'].onclick(); await flush(); }
      e.photo.emit('pointerdown', at); await flush();
      const hex = pixelHex(e.photo, x, y);
      assert.equal(centerHex(app, 'photo'), hex);
      e.photo.emit('pointerup', at); await samePhotoTarget(app, hex);
      assert.match(e['pick-info'].textContent, new RegExp(`中心点（${x}, ${y}）`));
      e['photo-average'].onclick();
      const endX = x ? x - 6 : x + 6, endY = y ? y - 5 : y + 5;
      const end = projected(e.photo, endX, endY);
      e.photo.emit('pointerdown', at); e.photo.emit('pointermove', end);
      const rect = e.photo.getBoundingClientRect(), stage = e['image-stage'].getBoundingClientRect();
      assert.equal(parseFloat(e.selection.style.left), rect.left - stage.left + Math.min(x, endX) * rect.width / 64);
      assert.equal(parseFloat(e.selection.style.top), rect.top - stage.top + Math.min(y, endY) * rect.height / 48);
      assert.equal(parseFloat(e.selection.style.width), 7 * rect.width / 64);
      assert.equal(parseFloat(e.selection.style.height), 6 * rect.height / 48);
      e.photo.emit('pointerup', end); await flush();
      const rgb = M.averagePixels(e.photo.getContext('2d').getImageData(Math.min(x,endX), Math.min(y,endY), 7, 6).data);
      assert.deepEqual(Array.from(app.messages.at(-1).target), rgb);
      assert.equal(e['target-hex'].textContent, M.rgbToHex(rgb).toUpperCase());
      e['photo-pick'].onclick();
    }
    // A new image clears the old target, but keeps the independent picker.
    await app.upload(coordinatePhoto()); photoGeometry(e);
  }
});
for (const zoom of [2, 4]) test(`R1 photo ${zoom}x average release without final move aligns displayed box with actual sampled pixels`, async () => {
  const app = await boot(), e = app.elements; await app.upload(coordinatePhoto()); clippedPhotoGeometry(e);
  const ctx = e.photo.getContext('2d'), read = ctx.getImageData.bind(ctx), sampled = [];
  ctx.getImageData = (x, y, width, height) => {
    sampled.push({x, y, width, height}); return read(x, y, width, height);
  };
  for (const corrected of [false, true]) {
    if (corrected) {
      zoomTo(e, 1); e['white-balance-pick'].onclick(); clickPixel(e, 22, 21); await flush();
      assert.equal(e['white-balance-status'].textContent, '已按白纸校正');
    }
    zoomTo(e, zoom); panPhoto(e, 11, -7); e['photo-average'].onclick();
    for (const [start, move, end, movedPastThreshold] of [
      [[30, 22], [32, 24], [34, 25], true],
      [[34, 25], [32, 24], [30, 22], true],
      [[30, 22], [30.25, 22.25], [34, 25], false],
    ]) {
      const down = projected(e.photo, ...start), last = projected(e.photo, ...move), up = projected(e.photo, ...end);
      e.photo.emit('pointerdown', down); e.photo.emit('pointermove', last);
      assert.equal(e.selection.hidden, !movedPastThreshold);
      sampled.length = 0;
      const count = app.messages.length;
      e.photo.emit('pointerup', up); await flush();
      const region = {x: Math.min(start[0], end[0]), y: Math.min(start[1], end[1]),
        width: Math.abs(end[0] - start[0]) + 1, height: Math.abs(end[1] - start[1]) + 1};
      assert.deepEqual(sampled, [region], 'sampleRegion must read the final release region exactly once');
      assert.equal(e.selection.hidden, false);
      const rect = e.photo.getBoundingClientRect(), stage = e['image-stage'].getBoundingClientRect();
      assert.equal(parseFloat(e.selection.style.left), rect.left - stage.left - 1 + region.x * rect.width / 64);
      assert.equal(parseFloat(e.selection.style.top), rect.top - stage.top - 1 + region.y * rect.height / 48);
      assert.equal(parseFloat(e.selection.style.width), region.width * rect.width / 64);
      assert.equal(parseFloat(e.selection.style.height), region.height * rect.height / 48);
      const rgb = M.averagePixels(read(region.x, region.y, region.width, region.height).data);
      assert.equal(app.messages.length, count + 1);
      assert.deepEqual(Array.from(app.messages.at(-1).target), rgb);
      assert.equal(e['target-hex'].textContent, M.rgbToHex(rgb).toUpperCase());
      assert.match(e['pick-info'].textContent, /5 × 4.*平均/);
    }
    e['photo-pick'].onclick();
    const down = projected(e.photo, 30, 22), up = projected(e.photo, 34, 25);
    e.photo.emit('pointerdown', down); e.photo.emit('pointerup', up);
    await samePhotoTarget(app, pixelHex(e.photo, 34, 25));
    assert.equal(e.selection.hidden, true, 'independent picker still confirms only the release pixel');
  }
});
test('R2 photo containment accepts visible curved edges but rejects clipped pixels and canvas gaps', async () => {
  const app = await boot(), e = app.elements; await app.upload(coordinatePhoto());
  const b = clippedPhotoGeometry(e), contains = (x, y) => app.context.PhotoView.contains(e.photo, e['image-stage'],
    {clientX: b.left + x, clientY: b.top + y});
  zoomTo(e, 4); panPhoto(e, 11, -7);
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const corner = (x, y) => contains(sx > 0 ? x : b.width - x, sy > 0 ? y : b.height - y);
    assert.equal(corner(1, 1), false, 'inside content rectangle but outside the 11px inner corner');
    assert.equal(corner(3.21, 3.21), false, 'just outside the circular boundary');
    assert.equal(corner(3.23, 3.23), true, 'just inside the circular boundary must remain pickable');
    assert.equal(corner(.01, 11), true, 'visible edge next to the rounded arc must remain pickable');
  }
  assert.equal(contains(0, b.height / 2), true);
  assert.equal(contains(b.width - .01, b.height / 2), true);
  assert.equal(contains(b.width, b.height / 2), false);
  assert.equal(contains(b.width / 2, 0), true);
  assert.equal(contains(b.width / 2, b.height), false);
  // Real DOM client/offset sizes are integers even with a fractional DOMRect.
  assert.equal(contains(b.width - .01, b.height / 2), true);
  assert.equal(contains(b.width + .1, b.height / 2), false, 'fractional border strip is still outside');
  assert.equal(contains(b.width / 2, b.height - .01), true, 'fractional bottom content remains visible');
  assert.equal(contains(b.width / 2, b.height + .1), false);
  e['photo-zoom-reset'].onclick();
  e.photo.baseRect = {...b, left: b.left + 20, width: b.width - 40};
  assert.equal(contains(10, b.height / 2), false, 'uncovered stage content is not visible photo');
  assert.equal(contains(20, b.height / 2), true);
});
for (const zoom of [2, 4]) for (const boundary of ['border', 'rounded corners'])
  test(`R2 photo ${zoom}x ${boundary} cancel captured picking without overwriting an existing target`, async () => {
    const app = await boot(), e = app.elements; await app.upload(coordinatePhoto());
    const b = clippedPhotoGeometry(e);
    for (const corrected of [false, true]) {
      zoomTo(e, 1);
      if (corrected) {
        e['white-balance-pick'].onclick(); clickPixel(e, 22, 21); await flush();
        assert.equal(e['white-balance-status'].textContent, '已按白纸校正');
      }
      clickPixel(e, 32, 24); await flush();
      const hex = e['target-hex'].textContent, count = app.messages.length;
      for (const [dx, dy] of [[11, -7], [10000, 10000], [-10000, 10000], [10000, -10000], [-10000, -10000]]) {
        zoomTo(e, zoom); panPhoto(e, dx, dy);
        const center = {pointerId: 9, pointerType: 'touch', clientX: b.left + b.width / 2, clientY: b.top + b.height / 2};
        const points = boundary === 'border'
          ? [[b.left - .75, center.clientY], [b.left + b.width + .75, center.clientY],
            [center.clientX, b.top - .75], [center.clientX, b.top + b.height + .75]]
          : [[b.left + 1, b.top + 1], [b.left + b.width - 1, b.top + 1],
            [b.left + b.width - 1, b.top + b.height - 1], [b.left + 1, b.top + b.height - 1]];
        for (const mode of ['pick', 'average']) {
          e['photo-' + mode].onclick();
          for (const [clientX, clientY] of points) {
            const outside = {...center, clientX, clientY};
            const unchanged = () => {
              assert.equal(app.messages.length, count, 'solverDelta must remain zero');
              assert.equal(e['target-hex'].textContent, hex, 'clipped pixels must not replace the existing target');
              assert.equal(e.selection.hidden, true); assert.equal(e['photo-loupe'].hidden, true);
            };
            for (const ending of ['move-up-outside', 'move-return-release', 'release-without-move']) {
              e.photo.emit('pointerdown', center); await flush();
              if (mode === 'pick') assert.equal(e['photo-loupe'].hidden, false, 'valid content must still start a pick');
              else {
                e.photo.emit('pointermove', {...center, clientX: center.clientX + 8});
                assert.equal(e.selection.hidden, false, 'valid content must still start a selection');
              }
              if (ending !== 'release-without-move') {
                e.photo.emit('pointermove', outside); await flush();
                if (ending === 'move-return-release') unchanged();
              }
              if (ending === 'move-return-release') {
                e.photo.emit('pointermove', center); await flush(); unchanged();
              }
              e.photo.emit('pointerup', ending === 'move-return-release' ? center : outside);
              await flush(); unchanged();
            }
            // Hover/down must reject the same clipped points as captured move/up.
            e.photo.emit('pointermove', {...outside, pointerType: 'mouse'}); await flush(); unchanged();
            e.photo.emit('pointerdown', outside); await flush(); unchanged();
            e.photo.emit('pointerup', outside); await flush(); unchanged();
          }
        }
      }
      e['photo-pick'].onclick();
    }
  });
test('pinch enters immediately cancel single pick, suppresses residual finger, pans non-origin and resets centered at 100%', async () => {
  const app = await boot(), e = app.elements; await app.upload(coordinatePhoto()); const b = photoGeometry(e);
  const a = {pointerId: 9, pointerType: 'touch', clientX: b.left + 40, clientY: b.top + 40};
  const second = {...a, pointerId: 10, clientX: b.left + 80};
  e.photo.emit('pointerdown', a); await flush(); assert.equal(e['photo-loupe'].hidden, false);
  e.photo.emit('pointerdown', second);
  assert.equal(e['photo-loupe'].hidden, true); assert.equal(e.selection.hidden, true);
  e.photo.emit('pointermove', {...second, clientX: b.left + 160});
  assert.equal(e['photo-zoom-value'].textContent, '300%');
  const r = e.photo.getBoundingClientRect();
  assert.notEqual(r.left, b.left + (b.width - r.width) / 2, 'pinch centroid translates');
  e.photo.emit('pointerup', second); e.photo.emit('pointermove', a); e.photo.emit('pointerup', a); await flush();
  assert.equal(app.messages.length, 0); assert.equal(e['target-row'].hidden, true); assert.equal(e['photo-loupe'].hidden, true);
  e['photo-zoom-reset'].onclick(); assert.equal(e['photo-zoom-value'].textContent, '100%');
  assert.deepEqual(e.photo.getBoundingClientRect(), {...b, right: b.left+b.width, bottom: b.top+b.height});
  assert.equal(e['photo-pan'].disabled, true);
  for (let n = 0; n < 15; n++) e['photo-zoom-in'].onclick();
  assert.equal(e['photo-zoom-value'].textContent, '500%'); assert.equal(e['photo-zoom-in'].disabled, true);
});
test('cancel, visible-viewport exit, lost capture, zoom or mode switch never overwrite an existing photo target', async () => {
  const app = await boot(), e = app.elements; await app.upload(coordinatePhoto()); const b = photoGeometry(e);
  clickPixel(e, 20, 20); await flush(); const hex = e['target-hex'].textContent, count = app.messages.length;
  for (const cancel of [() => e.photo.emit('pointercancel', at), () => e.photo.emit('lostpointercapture', at),
    () => e.photo.emit('pointermove', {...at, clientX: b.left - 10}), () => e['photo-average'].onclick(),
    () => e['photo-zoom-in'].onclick()]) {
    e['photo-pick'].onclick(); zoomTo(e,1);
    var at = projected(e.photo, 40, 20);
    e.photo.emit('pointerdown', at); await flush(); cancel(); e.photo.emit('pointerup', at); await flush();
    assert.equal(e['target-hex'].textContent, hex); assert.equal(app.messages.length, count); assert.equal(e['photo-loupe'].hidden, true);
  }
});
test('desktop right-button pan keeps left picking available and never picks at 100%', async () => {
  const app = await boot(), e = app.elements; await app.upload(coordinatePhoto()); const b = photoGeometry(e);
  const at = projected(e.photo, 30, 24, 1, 'mouse');
  e.photo.emit('pointerdown', {...at, button:2}); e.photo.emit('pointerup', {...at, button:2}); await flush();
  assert.equal(app.messages.length, 0);
  zoomTo(e, 4);
  const down = {...at, clientX:b.left+b.width/2,clientY:b.top+b.height/2,button:2};
  e.photo.emit('pointerdown', down); e.photo.emit('pointermove', {...down,clientX:down.clientX+30,clientY:down.clientY+20});
  e.photo.emit('pointerup', down); await flush();
  assert.equal(app.messages.length, 0); assert.equal(e['photo-pan'].attributes['aria-pressed'], 'false');
  const r = e.photo.getBoundingClientRect();
  assert.equal(r.left,b.left+(b.width-r.width)/2+30);
  assert.equal(r.top,b.top+(b.height-r.height)/2+20);
  clickPixel(e,30,24); await samePhotoTarget(app,pixelHex(e.photo,30,24));
});
