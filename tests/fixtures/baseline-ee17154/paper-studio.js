(function (root) {
  const P = typeof module !== 'undefined' ? require('./palette.js') : root.PaintPalette;
  const S = typeof module !== 'undefined' ? require('./soft-smudge.js') : root.SoftSmudge;
  const width = 448, height = 274, ground = [248, 239, 220];
  const validShares = shares => Array.isArray(shares) && shares.length > 0 && shares.length <= S.MAX_PIGMENTS
    && shares.every(entry => Array.isArray(entry) && entry.length === 2 && /^#[\da-f]{6}$/i.test(entry[0])
      && Number.isFinite(entry[1]) && entry[1] > 0 && entry[1] <= 1)
    && new Set(shares.map(([hex]) => hex.toUpperCase())).size === shares.length
    && Math.abs(shares.reduce((sum, [, part]) => sum + part, 0) - 1) <= 1e-6;
  function encodePaper(surface) {
    const pigments = [], ids = new Map(), bytes = [], float = new DataView(new ArrayBuffer(4));
    const registry = surface.pigments.transport || surface.pigments;
    const states = [], stateIds = new Map();
    const stateIndex = state => {
      if (!stateIds.has(state)) {
        if (!state.key || !Number.isSafeInteger(state.id)) throw new Error('本地搬运身份无效');
        stateIds.set(state, states.length); states.push([state.id, state.key]);
      }
      return stateIds.get(state);
    };
    const uint = value => { do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value); };
    const f32 = value => { float.setFloat32(0, value, true); for (let j = 0; j < 4; j++) bytes.push(float.getUint8(j)); };
    const pigment = color => {
      if (!validShares(color.shares)) throw new Error('本地蜡层颜色无效');
      const state = surface.pigments.state?.(color) || color;
      if (!validShares(state.shares)) throw new Error('本地搬运颜色无效');
      // Distinct evicted objects can have the same key. Deduplicate identity
      // by object, not by normalised shares/key; display entries use an index.
      const entry = [color.shares, stateIndex(state)], key = JSON.stringify(entry);
      if (!ids.has(key)) { ids.set(key, pigments.length); pigments.push(entry); }
      return ids.get(key);
    };
    let previous = -1, count = 0;
    for (let i = 0; i < surface.cells.length; i++) if (surface.mass[i]) {
      uint(i - previous); previous = i; count++;
      const soft = surface.soft?.[i] || 0;
      bytes.push(surface.tail[i] | ((surface.sealed?.[i] || 0) << 1)
        | (surface.bottomMass[i] ? 4 : 0) | (surface.topMass[i] ? 8 : 0) | (soft ? 16 : 0));
      for (const [color, mass] of [[surface.bottom[i], surface.bottomMass[i]], [surface.top[i], surface.topMass[i]]]) {
        if (mass) { uint(pigment(color)); f32(mass); }
      }
      if (soft) f32(soft);
    }
    const array = Uint8Array.from(bytes);
    const data = typeof Buffer !== 'undefined' ? Buffer.from(array).toString('base64')
      : btoa(Array.from({length: Math.ceil(array.length / 8192)}, (_, n) =>
        String.fromCharCode(...array.subarray(n * 8192, (n + 1) * 8192))).join(''));
    const pores = [], porePigments = [], poreIds = new Map();
    surface.pores?.forEach((color, i) => {
      if (!color || surface.mass[i]) return;
      if (!validShares(color.shares)) throw new Error('本地孔隙颜色无效');
      const key = JSON.stringify(color.shares);
      if (!poreIds.has(key)) { poreIds.set(key, porePigments.length); porePigments.push(color.shares); }
      pores.push([i, poreIds.get(key)]);
    });
    // Optical pigments never enter the r4 transport registry, even on save.
    const mixtures = [...registry.mixtures.values()].map(stateIndex);
    // Numeric tuple avoids quoted slash-separated keys without dropping any
    // input identity, strength step, result index or cache insertion order.
    const pairs = [...registry.pairs].flatMap(([key, state]) => [...key.split('/').map(Number), stateIndex(state)]);
    const transport = {states, mixtures, pairs, pairStride: 4, nextId: registry.nextId};
    return {v: 2, width, height, count, pigments, data, transport, ...(pores.length ? {pores, porePigments} : {})};
  }
  function decodePaper(value, pigments) {
    const bad = () => { throw new Error('本地蜡层数据无效'); };
    if (![1, 2].includes(value?.v) || value.width !== width || value.height !== height) bad();
    const surface = new S.Surface(width, height, ground, pigments), seen = new Set();
    // Keep the v2 decoder usable before/without the optional pore renderer.
    surface.sealed ||= new Uint8Array(width * height);
    const pigment = (shares, mass) => {
      if (!Number.isFinite(mass) || mass < 0 || mass > 1e8) throw new Error('本地蜡量无效');
      if (!mass && shares === null) return null;
      if (!mass || !validShares(shares)) throw new Error('本地蜡层颜色无效');
      return pigments.restore(shares);
    };
    const apply = (i, bottom, bm, top, tm, tail, soft, sealed = 0) => {
      if (!Number.isInteger(i) || i < 0 || i >= width * height || seen.has(i) || (tail !== 0 && tail !== 1)) bad();
      if (!Number.isFinite(soft) || soft < 0 || soft > 1) throw new Error('本地揉擦数据无效');
      if (!bm && !tm) bad();
      seen.add(i); surface.bottom[i] = bottom; surface.bottomMass[i] = bm;
      surface.top[i] = top; surface.topMass[i] = tm;
      surface.tail[i] = tail; surface.soft[i] = soft; surface.sealed[i] = sealed; surface.refresh(i);
    };
    if (value.v === 1) {
      if (!Array.isArray(value.cells) || value.cells.length > width * height) bad();
      for (const entry of value.cells) {
        if (!Array.isArray(entry) || ![6, 7].includes(entry.length)) bad();
        const [i, bottom, bm, top, tm, tail, soft = 0] = entry;
        apply(i, pigment(bottom, bm), bm, pigment(top, tm), tm, tail, soft);
      }
    } else {
      if (!Number.isInteger(value.count) || value.count < 0 || value.count > width * height
        || !Array.isArray(value.pigments) || value.pigments.length > width * height * 2
        || typeof value.data !== 'string' || value.data.length > width * height * 48
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) bad();
      let registry, states;
      if (value.transport !== undefined) {
        const saved = value.transport, limit = width * height * 2 + 13200;
        if (!saved || !Array.isArray(saved.states) || saved.states.length > limit
          || !Array.isArray(saved.mixtures) || saved.mixtures.length > 3200
          || !Array.isArray(saved.pairs) || saved.pairs.length > (saved.pairStride === 4 ? 40000 : 10000)
          || (saved.pairStride !== undefined && saved.pairStride !== 4)
          || (saved.pairStride === 4 && saved.pairs.length % 4)
          || !Number.isSafeInteger(saved.nextId) || saved.nextId < 1) bad();
        const loader = new S.Pigments(), identities = new Set();
        states = saved.states.map(entry => {
          if (!Array.isArray(entry) || entry.length !== 2) bad();
          const [id, key] = entry;
          if (!Number.isSafeInteger(id) || id < 1 || id >= saved.nextId || identities.has(id)
            || typeof key !== 'string') bad();
          identities.add(id);
          const parts = key.split(',').map(part => part.split('/'));
          if (!parts.length || parts.length > S.MAX_PIGMENTS || parts.some(part =>
            part.length !== 2 || !/^#[\da-f]{6}$/i.test(part[0]) || !/^[1-9]\d*$/.test(part[1])
            || Number(part[1]) > 48)) bad();
          const total = parts.reduce((sum, [, part]) => sum + Number(part), 0);
          const shares = parts.map(([hex, part]) => [hex, Number(part) / total]);
          if (!validShares(shares)) bad();
          return {...loader.restoreState(shares, key), id};
        });
        registry = loader.transport; registry.mixtures.clear(); registry.pairs.clear();
        for (const index of saved.mixtures) {
          if (!Number.isInteger(index) || !states[index] || registry.mixtures.has(states[index].key)) bad();
          registry.mixtures.set(states[index].key, states[index]);
        }
        const pairs = saved.pairStride === 4
          ? Array.from({length: saved.pairs.length / 4}, (_, n) => saved.pairs.slice(n * 4, n * 4 + 4)) : saved.pairs;
        for (const entry of pairs) {
          if (!Array.isArray(entry) || ![2, 4].includes(entry.length)) bad();
          if (entry.length === 4 && entry.slice(0, 3).some(n => !Number.isSafeInteger(n))) bad();
          const [key, index] = entry.length === 4 ? [entry.slice(0, 3).join('/'), entry[3]] : entry;
          const parts = typeof key === 'string' && key.split('/').map(Number);
          if (!parts || parts.length !== 3 || parts.some(n => !Number.isSafeInteger(n) || n < 1)
            || parts[0] >= saved.nextId || parts[1] >= saved.nextId || parts[2] >= 48
            || !Number.isInteger(index) || !states[index] || registry.pairs.has(key)) bad();
          registry.pairs.set(key, states[index]);
        }
        registry.nextId = saved.nextId;
      }
      const table = value.pigments.map(entry => {
        if (states) {
          if (!Array.isArray(entry) || entry.length !== 2 || !validShares(entry[0])
            || !Number.isInteger(entry[1]) || !states[entry[1]]) bad();
          return pigments.withState(pigments.restore(entry[0]), states[entry[1]]);
        }
        if (!Array.isArray(entry) || ![2, 3].includes(entry.length) || !validShares(entry[0]) || !validShares(entry[1])) bad();
        return pigments.withState(pigments.restore(entry[0]), pigments.restoreState(entry[1], entry[2]));
      });
      const bytes = typeof Buffer !== 'undefined' ? Uint8Array.from(Buffer.from(value.data, 'base64'))
        : Uint8Array.from(atob(value.data), c => c.charCodeAt(0));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 0, i = -1;
      const byte = () => { if (offset >= bytes.length) bad(); return bytes[offset++]; };
      const uint = () => { let n = 0, shift = 0, b; do { b = byte(); n += (b & 127) * 2 ** shift; shift += 7; if (shift > 35) bad(); } while (b & 128); return n; };
      const f32 = () => { if (offset + 4 > bytes.length) bad(); const n = view.getFloat32(offset, true); offset += 4; return n; };
      const layer = present => {
        if (!present) return [null, 0];
        const color = table[uint()], mass = f32();
        if (!color || !Number.isFinite(mass) || mass <= 0 || mass > 1e8) bad();
        return [color, mass];
      };
      for (let n = 0; n < value.count; n++) {
        const delta = uint(); if (!delta) bad(); i += delta;
        const flags = byte(); if (flags > 31) bad();
        const [bottom, bm] = layer(flags & 4), [top, tm] = layer(flags & 8);
        apply(i, bottom, bm, top, tm, flags & 1, flags & 16 ? f32() : 0, (flags >> 1) & 1);
      }
      if (offset !== bytes.length) bad();
      if (value.pores !== undefined) {
        if (!Array.isArray(value.pores) || value.pores.length > width * height
          || !Array.isArray(value.porePigments) || value.porePigments.length > width * height) bad();
        const optical = value.porePigments.map(shares => { if (!validShares(shares)) bad(); return pigments.restore(shares); });
        for (const entry of value.pores) {
          if (!Array.isArray(entry) || entry.length !== 2) bad();
          const [index, id] = entry;
          if (!Number.isInteger(index) || index < 0 || index >= width * height || seen.has(index)
            || !Number.isInteger(id) || !optical[id]) bad();
          seen.add(index); surface.pores[index] = optical[id];
        }
      }
      if (registry) {
        // Replace only after the full snapshot validates. Both current caches
        // and evicted layer/pair-result identities survive reload and undo.
        pigments.transport = registry; pigments.states = new WeakMap();
      }
    }
    return surface;
  }
  class Studio {
    constructor() {
      this.palette = new P.Palette(); this.pigments = new S.Pigments();
      this.paper = new S.Surface(width, height, ground, this.pigments);
      this.history = []; this.pending = null;
    }
    encode() { return {...this.palette.encode(), wax: encodePaper(this.paper)}; }
    restore(value) {
      const palette = new P.Palette(); palette.restore(value);
      let paper;
      if (value.wax) paper = decodePaper(value.wax, this.pigments);
      else {
        // Preserve old paper marks on upgrade; old brush choice is retired.
        paper = new S.Surface(width, height, ground, this.pigments);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const old = Math.floor(y / height * P.HEIGHT / 2) * (P.WIDTH / 2) + Math.floor(x / width * P.WIDTH / 2);
          const packed = palette.paper.get(old);
          if (packed === undefined) continue;
          const rgb = [packed >>> 16, packed >>> 8 & 255, packed & 255].map(v =>
            Math.max(0, Math.min(255, v + (palette.texture.get(old) || 0))));
          const hex = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
          paper.add(y * width + x, this.pigments.color(hex), 40);
        }
      }
      palette.paper.clear(); palette.texture.clear();
      this.palette = palette; this.paper = paper; this.pending = null;
    }
    begin() { this.pending ||= this.encode(); }
    commit() {
      if (!this.pending) return false;
      const changed = JSON.stringify(this.pending) !== JSON.stringify(this.encode());
      if (changed) { this.history.push(this.pending); if (this.history.length > 20) this.history.shift(); }
      this.pending = null; return changed;
    }
    undo() {
      const value = this.history.at(-1);
      if (!value) return false;
      this.restore(value); this.history.pop(); return true;
    }
    clear() { this.begin(); this.palette.clear(); this.paper.clear(); return this.commit(); }
    squeeze(...args) { return this.palette.squeeze(...args); }
    knife(...args) { return this.palette.knife(...args); }
    addRecipe(...args) { this.begin(); const result = this.palette.addRecipe(...args); this.commit(); return result; }
    renderPalette(ctx) { this.palette.renderPalette(ctx); }
  }
  const api = {Studio, encodePaper, decodePaper, width, height, ground};
  if (typeof module !== 'undefined') module.exports = api;
  else root.PaperStudio = api;
})(globalThis);
