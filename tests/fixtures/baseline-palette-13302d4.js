// Canvas-independent paint state; the browser and Node evidence use this same renderer.
(function (root) {
  const M = typeof module !== 'undefined' ? require('./color-math.js') : root.ColorMath;
  const R = typeof module !== 'undefined' ? require('./recipe.js') : root.Recipe;
  const WIDTH = 720, HEIGHT = 420, TILE = 4, PAPER_TILE = 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const grain = (x, y) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return (n - Math.floor(n)) * .75 + (Math.sin(y * 1.7 + x * .13) + 1) * .125;
  };
  const packed = rgb => (Math.round(rgb[0]) << 16) | (Math.round(rgb[1]) << 8) | Math.round(rgb[2]);
  const unpack = n => [n >>> 16, (n >>> 8) & 255, n & 255];
  const paperBase = (x, y) => {
    const n = 255 - Math.round(grain(x, y) * 7);
    return [n, n, n - 1];
  };
  // Rasterized swept capsule: each cell represents the amount of paint in that area.
  function capsule(from, to, radius, tile) {
    const cells = [], cols = WIDTH / tile, rows = HEIGHT / tile;
    const dx = to.x - from.x, dy = to.y - from.y, length2 = dx * dx + dy * dy;
    for (let y = clamp(Math.floor((Math.min(from.y, to.y) - radius) / tile), 0, rows - 1);
      y <= clamp(Math.ceil((Math.max(from.y, to.y) + radius) / tile), 0, rows - 1); y++) {
      for (let x = clamp(Math.floor((Math.min(from.x, to.x) - radius) / tile), 0, cols - 1);
        x <= clamp(Math.ceil((Math.max(from.x, to.x) + radius) / tile), 0, cols - 1); x++) {
        const px = (x + .5) * tile, py = (y + .5) * tile;
        const t = length2 ? clamp(((px - from.x) * dx + (py - from.y) * dy) / length2, 0, 1) : 0;
        if (Math.hypot(px - from.x - t * dx, py - from.y - t * dy) <= radius) cells.push(y * cols + x);
      }
    }
    return cells;
  }
  class Palette {
    constructor() {
      this.cells = new Map(); this.paper = new Map(); this.history = [];
      this.pending = null; this.cache = new Map();
    }
    snapshot() { return {cells: new Map([...this.cells].map(([i, c]) => [i, {...c}])), paper: new Map(this.paper)}; }
    begin() { if (!this.pending) this.pending = this.snapshot(); }
    commit() {
      if (!this.pending) return false;
      const before = JSON.stringify(this.encode(this.pending));
      const changed = before !== JSON.stringify(this.encode());
      if (changed) { this.history.push(this.pending); if (this.history.length > 20) this.history.shift(); }
      this.pending = null; return changed;
    }
    undo() {
      const state = this.history.pop();
      if (!state) return false;
      this.cells = state.cells; this.paper = state.paper; this.pending = null; return true;
    }
    clear() { this.begin(); this.cells.clear(); this.paper.clear(); return this.commit(); }
    squeeze(paint, x, y, parts = 1) {
      if (!/^#[\da-f]{6}$/i.test(paint.hex) || !Number.isFinite(parts) || parts <= 0 || parts > 100)
        throw new Error('颜料或份数无效');
      const radius = 22 * Math.sqrt(parts), hex = paint.hex.toLowerCase();
      const indices = capsule({x, y}, {x, y}, radius, TILE);
      for (const i of indices) {
        const cell = this.cells.get(i) || {};
        cell[hex] = (cell[hex] || 0) + parts / indices.length; this.cells.set(i, cell);
      }
      return {code: paint.code, parts, radius, x, y};
    }
    addRecipe(recipe) {
      this.begin();
      const dabs = recipe.paints.map((p, i) =>
        this.squeeze(p, WIDTH * (i + 1) / (recipe.paints.length + 1), HEIGHT / 2, recipe.parts[i]));
      this.commit(); return dabs;
    }
    knife(from, to, visited = new Set()) {
      for (const i of capsule(from, to, 19, TILE)) visited.add(i);
      const total = {};
      for (const i of visited) for (const [hex, mass] of Object.entries(this.cells.get(i) || {}))
        total[hex] = (total[hex] || 0) + mass;
      if (!Object.keys(total).length) return visited;
      // Redistribute ONLY the swept quantity, retaining original pigment identities.
      // A pass exchanges 32% of each cell's paint with the blade's swept pool.
      // Mass is conserved, including the paint carried onto previously empty path cells.
      for (const i of visited) {
        const old = this.cells.get(i) || {}, next = {};
        for (const hex of Object.keys(total)) next[hex] = .68 * (old[hex] || 0) + .32 * total[hex] / visited.size;
        this.cells.set(i, next);
      }
      return visited;
    }
    mixed(cell) {
      const entries = Object.entries(cell), sum = entries.reduce((n, [, m]) => n + m, 0);
      // Cache 1/200 share bins, never RGB averages. Keep every positive component.
      const parts = entries.map(([, mass]) => Math.max(1, Math.round(mass / sum * 200)));
      const key = 'm' + entries.map(([hex], i) => hex + ':' + parts[i]).join(',');
      return this.cached(key, () => R.mix(entries.map(([hex]) => ({hex})), parts).map(Math.round));
    }
    cached(key, calculate) {
      if (!this.cache.has(key)) {
        if (this.cache.size >= 12000) this.cache.clear();
        this.cache.set(key, calculate());
      }
      return this.cache.get(key);
    }
    brush(from, to, paint, strength = .65, touched = new Set()) {
      strength = clamp(strength, .05, 1);
      for (const i of capsule(from, to, 15, PAPER_TILE)) {
        if (touched.has(i)) continue;
        touched.add(i);
        const x = i % (WIDTH / PAPER_TILE), y = Math.floor(i / (WIDTH / PAPER_TILE)), tooth = grain(x, y);
        if (tooth > .15 + strength * .85) continue; // Light strokes expose more paper.
        const base = this.paper.has(i) ? unpack(this.paper.get(i)) : paperBase(x, y);
        const coverage = clamp(Math.round((strength * .8 + tooth * .15) * 20), 1, 19);
        const top = paint.hex.toLowerCase(), key = 'l' + packed(base) + top + ':' + coverage;
        const color = this.cached(key, () => R.layer([{rgb: base}, {hex: top}], [20 - coverage, coverage]).map(Math.round));
        this.paper.set(i, packed(color));
      }
      return touched;
    }
    renderPalette(ctx) {
      const image = ctx.createImageData(WIDTH, HEIGHT), cols = WIDTH / TILE;
      for (let cy = 0; cy < HEIGHT / TILE; cy++) for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx, cell = this.cells.get(i);
        let color = cell ? this.mixed(cell) : [237, 233, 222];
        // A narrow lit rim and shaded lower edge give squeezed dabs a little depth.
        if (cell) {
          const edge = !this.cells.has(i - cols) ? 15 : !this.cells.has(i + cols) ? -16 : 0;
          color = color.map(v => clamp(v + edge, 0, 255));
        }
        for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
          const offset = ((cy * TILE + y) * WIDTH + cx * TILE + x) * 4;
          image.data[offset] = color[0]; image.data[offset + 1] = color[1];
          image.data[offset + 2] = color[2]; image.data[offset + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
    }
    renderPaper(ctx) {
      const image = ctx.createImageData(WIDTH, HEIGHT), cols = WIDTH / PAPER_TILE;
      for (let cy = 0; cy < HEIGHT / PAPER_TILE; cy++) for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx, color = this.paper.has(i) ? unpack(this.paper.get(i)) : paperBase(cx, cy);
        for (let y = 0; y < PAPER_TILE; y++) for (let x = 0; x < PAPER_TILE; x++) {
          const offset = ((cy * PAPER_TILE + y) * WIDTH + cx * PAPER_TILE + x) * 4;
          image.data[offset] = color[0]; image.data[offset + 1] = color[1];
          image.data[offset + 2] = color[2]; image.data[offset + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
    }
    sample(ctx, x, y) {
      const rgb = [...ctx.getImageData(clamp(Math.floor(x), 0, WIDTH - 1), clamp(Math.floor(y), 0, HEIGHT - 1), 1, 1).data].slice(0, 3);
      return {rgb, hex: M.rgbToHex(rgb).toUpperCase()};
    }
    encode(state = this) { return {v: 1, cells: [...state.cells], paper: [...state.paper]}; }
    restore(value) {
      const validIndex = (i, tile) => Number.isInteger(i) && i >= 0 && i < WIDTH * HEIGHT / (tile * tile);
      if (value?.v !== 1 || !Array.isArray(value.cells) || !Array.isArray(value.paper)
        || value.cells.length > WIDTH * HEIGHT / TILE ** 2 || value.paper.length > WIDTH * HEIGHT / PAPER_TILE ** 2)
        throw new Error('本地画布数据无效');
      for (const [i, cell] of value.cells) {
        if (!validIndex(i, TILE) || !cell || Object.keys(cell).length > 237 || !Object.keys(cell).length
          || Object.entries(cell).some(([hex, mass]) => !/^#[\da-f]{6}$/i.test(hex) || !Number.isFinite(mass) || mass <= 0))
          throw new Error('本地颜料数据无效');
      }
      for (const [i, color] of value.paper)
        if (!validIndex(i, PAPER_TILE) || !Number.isInteger(color) || color < 0 || color > 0xffffff)
          throw new Error('本地纸面数据无效');
      this.cells = new Map(value.cells); this.paper = new Map(value.paper); this.history = []; this.pending = null;
    }
  }
  const api = {Palette, WIDTH, HEIGHT, grain};
  if (typeof module !== 'undefined') module.exports = api;
  else root.PaintPalette = api;
})(globalThis);
