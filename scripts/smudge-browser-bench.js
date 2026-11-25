// Run on the real static page with ?check=1, after smudge-workload.js.
(function (root) {
  const $ = id => document.getElementById(id), c = $('paper-canvas');
  const W = root.SmudgeWorkload, pipeline = root.PaperMetrics.pipeline;
  const raf = () => new Promise(requestAnimationFrame);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let studio, pointer = 400;
  const begin = PaperStudio.Studio.prototype.begin;
  PaperStudio.Studio.prototype.begin = function (...args) { studio = this; return begin.apply(this, args); };
  const settle = async () => { if (pipeline) await root.PaperMetrics.settled(); await raf(); await raf(); };
  function emit(type, points, id, pointerType) {
    const r = c.getBoundingClientRect();
    const events = points.map(p => new PointerEvent(type, {pointerId: id, pointerType,
      bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: r.left + p.x / W.WIDTH * r.width, clientY: r.top + p.y / W.HEIGHT * r.height}));
    if (events.length > 1) Object.defineProperty(events.at(-1), 'getCoalescedEvents', {value: () => events});
    c.dispatchEvent(events.at(-1));
  }
  function hash(data) {
    let a = 2166136261, b = 5381;
    for (const value of data) { const n = typeof value === 'string' ? value.charCodeAt(0) : value; a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n; }
    return [(a >>> 0).toString(16), (b >>> 0).toString(16)].join('-');
  }
  function snapshot() {
    const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const saved = localStorage.getItem('kuelox-paper-v2');
    return {pixels: hash(pixels), archive: hash(saved || ''), bytes: saved?.length,
      warning: $('palette-storage-warning').textContent};
  }
  async function seed(name, pointerType) {
    $('palette-clear').click(); await settle();
    const blank = new PaperStudio.Studio();
    if (pipeline) {
      await new Promise(resolve => pipeline.request({type: 'restore', value: blank.encode()}, resolve));
    } else Object.assign(studio, blank);
    localStorage.removeItem('kuelox-paper-v2');
    $('tool-brush').click(); $('paper-size').value = 96; $('paper-pressure').value = .95;
    for (const {code, points} of W.paintStrokes(name)) {
      document.querySelector('#paint-colors [data-code="' + code + '"]').click();
      const id = ++pointer;
      emit('pointerdown', [points[0]], id, pointerType);
      for (const p of points.slice(1)) emit('pointermove', [p], id, pointerType);
      emit('pointerup', [points.at(-1)], id, pointerType);
      await settle();
    }
    $('tool-smudge').click(); c.scrollIntoView({block: 'center', behavior: 'instant'});
    await settle();
  }
  async function run({name = 'three', batch = 6, moves = 50, hz = 120, pointerType = 'touch', singleJump = false} = {}) {
    const capture = c.setPointerCapture;
    c.setPointerCapture = () => {};
    try {
      await seed(name, pointerType);
      const before = snapshot(), paths = W.smudgeStrokes(name, moves), passes = [];
      for (const points of paths) {
        const longTasks = [], frames = [], inputs = [], id = ++pointer, t0 = performance.now();
        let framing = true, lastFrame;
        function frame(t) { if (lastFrame != null) frames.push(t - lastFrame); lastFrame = t; if (framing) requestAnimationFrame(frame); }
        requestAnimationFrame(frame);
        const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => ({at: e.startTime - t0, ms: e.duration}))));
        observer.observe({type: 'longtask'});
        const timed = (type, samples, due) => {
          const start = performance.now(); emit(type, samples, id, pointerType);
          const end = performance.now(); inputs.push({type, at: start - t0, ms: end - start,
            samples: samples.length, lag: due == null ? null : start - due}); return end;
        };
        timed('pointerdown', [points[0]]);
        await sleep(0);
        const origin = performance.now();
        if (singleJump) timed('pointermove', [points.at(-1)], origin);
        else for (let n = 1; n < points.length; n += batch) {
          const samples = points.slice(n, n + batch), due = origin + 1000 / hz * (n + samples.length - 1);
          await sleep(Math.max(0, due - performance.now())); timed('pointermove', samples, due);
        }
        const dragEnd = performance.now();
        await sleep(0);
        const upStart = performance.now();
        timed('pointerup', [points.at(-1)]); await settle();
        const upSettled = performance.now() - upStart;
        await sleep(40); framing = false; observer.disconnect();
        passes.push({inputs, frames, longTasks, dragLongTasks: longTasks.filter(t => t.at >= 0 && t.at < dragEnd - t0),
          inputMs: W.statistics(inputs.filter(i => i.type === 'pointermove').map(i => i.ms)),
          lagMs: W.statistics(inputs.filter(i => i.type === 'pointermove').map(i => i.lag)),
          upHandlerMs: inputs.at(-1).ms, upSettledMs: upSettled, wallMs: dragEnd - t0, snapshot: snapshot()});
      }
      return {worker: !!pipeline?.worker, config: {name, batch, moves, hz, pointerType, singleJump},
        layout: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState},
        before, passes, userAgent: navigator.userAgent};
    } finally { c.setPointerCapture = capture; }
  }
  async function restored() { await settle(); return snapshot(); }
  let native;
  async function startNative() {
    const capture = c.setPointerCapture;
    c.setPointerCapture = () => {};
    try { await seed('three', 'mouse'); } finally { c.setPointerCapture = capture; }
    const t0 = performance.now(), tasks = [], observer = new PerformanceObserver(list =>
      tasks.push(...list.getEntries().map(e => ({at: e.startTime - t0, ms: e.duration}))));
    observer.observe({type: 'longtask'});
    root.PaperMetrics.simulation.length = 0;
    native = {t0, tasks, observer, before: snapshot()};
    const rect = c.getBoundingClientRect();
    return {from: {x: 110 / 448 * rect.width, y: 124 / 274 * rect.height},
      to: {x: 344 / 448 * rect.width, y: 132 / 274 * rect.height}};
  }
  async function stopNative() {
    await settle(); await sleep(40); native.observer.disconnect();
    return {worker: !!pipeline?.worker, before: native.before, after: snapshot(),
      longTasks: native.tasks, inputSimulationMs: W.statistics(root.PaperMetrics.simulation),
      wallMs: performance.now() - native.t0};
  }
  root.smudgeWorkerBench = {run, restored, settle, startNative, stopNative};
})(globalThis);
