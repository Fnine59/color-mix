(function (root) {
  const E = typeof module !== 'undefined' ? require('./paper-engine.js') : root.PaperEngine;
  const P = typeof module !== 'undefined' ? require('./paper-studio.js') : root.PaperStudio;
  class View {
    constructor(width, height) {
      this.width = width; this.height = height; this.dirty = null;
      this.pixels = new Uint8ClampedArray(width * height * 4);
      this.rgb = new Float64Array(width * height * 3);
    }
    apply({area, pixels, rgb}) {
      const {left, top, right, bottom} = area, width = right - left + 1;
      for (let y = top; y <= bottom; y++) {
        const src = (y - top) * width, dst = y * this.width + left;
        this.pixels.set(pixels.subarray(src * 4, (src + width) * 4), dst * 4);
        this.rgb.set(rgb.subarray(src * 3, (src + width) * 3), dst * 3);
      }
      const old = this.dirty;
      this.dirty = old ? {left: Math.min(left, old.left), top: Math.min(top, old.top),
        right: Math.max(right, old.right), bottom: Math.max(bottom, old.bottom)} : area;
    }
    writeFlat(index, out, offset = 0) { out.set(this.pixels.subarray(index * 4, index * 4 + 3), offset); }
    rgbAt(x, y) {
      const i = (Math.max(0, Math.min(this.height - 1, Math.floor(y))) * this.width
        + Math.max(0, Math.min(this.width - 1, Math.floor(x)))) * 3;
      return Array.from(this.rgb.subarray(i, i + 3));
    }
  }
  class Pipeline {
    constructor({studio = new P.Studio(), workerFactory, onChange = () => {}, onError = () => {}} = {}) {
      this.onChange = onChange; this.onError = onError; this.history = studio.history.length;
      this.waiting = new Map(); this.samples = []; this.nextId = 0; this.failed = false;
      this.engine = null; this.worker = null; this.closed = false;
      this.starting = false; this.startupQueue = []; this.journal = [];
      this.unloadSnapshot = null;
      try {
        const factory = workerFactory || (typeof root.Worker === 'function' ? () => new root.Worker('./paper-worker.js') : null);
        if (factory) this.worker = factory();
      } catch { /* Construction/CSP failure: clean synchronous path, no replay. */ }
      if (this.worker) {
        this.view = new View(studio.paper.width, studio.paper.height);
        this.initialStudio = studio;
        this.starting = true; this.startupId = 1;
        this.worker.onmessage = ({data}) => this.receive(data);
        this.worker.onerror = event => { event.preventDefault?.(); this.workerFailure('白纸计算线程异常；请保留页面，重试前先刷新已保存的白纸。'); };
        this.request({type: 'restore', value: studio.encode()});
      } else {
        this.engine = new E.Engine(studio); this.view = studio.paper;
      }
    }
    get busy() { return this.waiting.size > 0 || this.samples.length > 0; }
    workerFailure(message) {
      if (this.closed || this.failed) return;
      if (!this.starting) { this.fail(message); return; }
      // Only restore was sent. No drawing commands may reach a Worker until
      // that handshake succeeds, so this is still a clean model to fall back to.
      this.worker.terminate(); this.worker = null; this.starting = false;
      this.startupQueue = [];
      this.engine = new E.Engine(this.initialStudio);
      const pending = this.journal; this.journal = [];
      for (const {id, commands} of pending) {
        const callbacks = this.waiting.get(id) || [];
        this.waiting.delete(id);
        this.send(commands, callbacks);
      }
    }
    fail(message) {
      // Never replay on a stale main-thread model after a live Worker crash.
      this.failed = true; this.samples = [];
      for (const callbacks of this.waiting.values()) for (const callback of callbacks) callback?.(null, message);
      this.waiting.clear(); this.onError(message);
    }
    receive(reply) {
      if (this.closed || !this.worker) return;
      const callbacks = this.waiting.get(reply.id);
      if (!callbacks) return;
      if (reply.error) { this.workerFailure(reply.error); return; }
      this.waiting.delete(reply.id);
      if (reply.patch) this.view.apply(reply.patch);
      this.history = reply.history;
      if (this.starting && reply.id === this.startupId) {
        this.starting = false;
        const queued = this.startupQueue; this.startupQueue = [];
        for (const message of queued) this.post(message);
      }
      this.onChange();
      callbacks.forEach((callback, n) => callback?.(reply.results[n]));
    }
    post(message) {
      try { this.worker.postMessage(message); }
      catch (error) { this.workerFailure(error.message); }
    }
    send(commands, callbacks) {
      this.unloadSnapshot = null;
      if (this.failed || this.closed) { callbacks.forEach(callback => callback?.(null, '白纸计算线程不可用')); return; }
      if (!this.worker) {
        const results = commands.map(command => this.engine.run(command));
        this.view = this.engine.studio.paper; this.history = this.engine.studio.history.length;
        this.onChange(); callbacks.forEach((callback, n) => callback?.(results[n])); return;
      }
      const id = ++this.nextId; this.waiting.set(id, callbacks);
      // Immutable input log, not a mirror of the Worker-owned paper/View.
      // Retain all model commands since startup: a later wax snapshot
      // alone omits live stroke/transport state and is not a safe replay base.
      const message = {id, commands: structuredClone(commands)};
      this.journal.push(message);
      if (this.starting && id !== this.startupId) this.startupQueue.push(message);
      else this.post(message);
    }
    flush() {
      if (!this.samples.length) return;
      const samples = this.samples; this.samples = [];
      this.send([{type: 'samples', samples}], [null]);
    }
    sample(sample) {
      if (this.failed || this.closed) return;
      this.unloadSnapshot = null;
      this.samples.push(sample);
      if (this.samples.length === 1) (root.queueMicrotask || (fn => Promise.resolve().then(fn)))(() => this.flush());
      if (!this.worker) this.flush();
    }
    request(command, callback) {
      // A fence is its own message: its pixels/results cannot include commands
      // accepted AFTER it (especially a pick followed immediately by a brush).
      this.flush(); this.send([command], [callback]);
    }
    settled() { return new Promise(resolve => this.request({type: 'barrier'}, resolve)); }
    close() { this.request({type: 'barrier'}, () => this.worker?.terminate()); }
    snapshotForUnload() {
      if (this.failed || this.closed) throw new Error('白纸计算线程不可用；本次未覆盖已保存的白纸。');
      if (this.unloadSnapshot !== null) return this.unloadSnapshot;
      this.flush();
      if (!this.worker) return this.engine.run({type: 'save'});
      const engine = new E.Engine(), view = this.view, history = this.history;
      try {
        // Replay only here, from the SAME restore used by the Worker. Never
        // use the stale caller studio or the relief-rendered View as a model.
        // Pending read callbacks see their exact prefix, resolve deferred ink,
        // and append any accepted after-read inputs to the end of this log.
        for (const {id, commands} of this.journal) {
          const results = commands.map(command => engine.run(command));
          this.view = engine.studio.paper; this.history = engine.studio.history.length;
          const callbacks = this.waiting.get(id);
          if (callbacks) {
            this.waiting.set(id, callbacks.map(() => null));
            callbacks.forEach((callback, n) => callback?.(results[n]));
          }
          this.flush();
        }
        this.unloadSnapshot = engine.run({type: 'save'});
        return this.unloadSnapshot;
      } finally {
        this.view = view; this.history = history;
      }
    }
    dispose() {
      // Actual non-BFCache unload cannot await a final Worker reply.
      this.closed = true; this.worker?.terminate();
      this.samples = []; this.waiting.clear(); this.startupQueue = []; this.journal = [];
    }
  }
  const api = {Pipeline, View};
  if (typeof module !== 'undefined') module.exports = api;
  else root.PaperPipeline = api;
})(globalThis);
