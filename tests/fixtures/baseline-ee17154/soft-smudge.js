(function (root) {
  const W = typeof module !== 'undefined' ? require('./wax-paper.js') : root.WaxPaint;
  const R = typeof module !== 'undefined' ? require('./recipe.js') : root.Recipe;
  // Keep at most 1024 fine-ratio shares; arbitrary picker colors are not
  // limited by the 237 paints in the catalogue.
  const MAX_PIGMENTS = 1024;
  // Keep the r4 transport/brush/knife core intact. Only smudge homogenizes
  // real pigment shares in the touched footprint, never RGB interpolation.
  class Pigments extends W.Pigments {
    constructor() {
      super();
      this.transport = new W.Pigments();
      this.states = new WeakMap();
    }
    state(pigment) {
      if (!pigment) return null;
      if (pigment.transport) return pigment.transport;
      if (!this.states.has(pigment)) this.states.set(pigment, this.transport.mix(Object.fromEntries(pigment.shares)));
      return this.states.get(pigment);
    }
    withState(pigment, state) {
      return {...pigment, transport: state};
    }
    restoreState(shares, key) {
      if (key === undefined) {
        // Earlier v2 files stored only normalised transport shares. Recover
        // their integer rounding sum where possible, without re-quantising.
        const sums = Array.from({length: 48 + shares.length}, (_, n) => n + 1)
          .sort((a, b) => Math.abs(a - 48) - Math.abs(b - 48));
        const sum = sums.find(n => shares.every(([, part]) => Math.abs(part * n - Math.round(part * n)) < 1e-8));
        if (!sum) throw new Error('本地搬运比例无效');
        key = shares.map(([hex, part]) => `${hex}/${Math.round(part * sum)}`).join(',');
      }
      const entries = typeof key === 'string' && key.split(',').map(entry => entry.split('/'));
      const total = entries && entries.reduce((n, [, part]) => n + Number(part), 0);
      if (!entries || entries.length !== shares.length || entries.some(([hex, part], n) =>
        hex !== shares[n][0] || !/^[1-9]\d*$/.test(part) || Number(part) > 48
        || Math.abs(Number(part) / total - shares[n][1]) > 1e-8)) throw new Error('本地搬运身份无效');
      // Read and live blend must intern in the SAME r4 key registry; a second
      // saved-only registry makes equal incoming wax incorrectly form a top.
      if (this.transport.mixtures.has(key)) return this.transport.mixtures.get(key);
      const state = {id: this.transport.nextId++, key, shares,
        rgb: R.mix(shares.map(([hex]) => ({hex})), shares.map(([, part]) => part))};
      if (this.transport.mixtures.size >= 3200) this.transport.mixtures.clear();
      this.transport.mixtures.set(key, state);
      return state;
    }
    restore(shares) {
      if (shares.length === 1) return this.color(shares[0][0]);
      const key = 'saved:' + JSON.stringify(shares);
      if (this.mixtures.has(key)) return this.mixtures.get(key);
      const result = {id: this.nextId++, shares,
        rgb: R.mix(shares.map(([hex]) => ({hex})), shares.map(([, part]) => part))};
      if (this.mixtures.size >= 3200) this.mixtures.clear();
      this.mixtures.set(key, result); return result;
    }
    fine(weights) {
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      const entries = Object.entries(weights).sort(([a], [b]) => a.localeCompare(b))
        .map(([hex, weight]) => [hex, Math.round(weight / sum * 1024)]).filter(([, part]) => part > 0);
      if (!entries.length) {
        const strongest = Object.keys(weights).reduce((a, b) => weights[a] >= weights[b] ? a : b);
        entries.push([strongest, 1024]);
      }
      // Rounding can retain up to 2048 half-unit contributions. Bound those
      // deterministically, using the same limit as encoding and decoding.
      if (entries.length > MAX_PIGMENTS) {
        entries.sort((a, b) => weights[b[0]] - weights[a[0]] || a[0].localeCompare(b[0]));
        entries.length = MAX_PIGMENTS; entries.sort(([a], [b]) => a.localeCompare(b));
      }
      if (entries.length === 1) return this.color(entries[0][0]);
      const key = 'soft:' + entries.map(([hex, part]) => `${hex}/${part}`).join(',');
      if (this.mixtures.has(key)) return this.mixtures.get(key);
      const total = entries.reduce((a, [, part]) => a + part, 0);
      const result = {id: this.nextId++, rgb: R.mix(entries.map(([hex]) => ({hex})), entries.map(([, part]) => part)),
        shares: entries.map(([hex, part]) => [hex, part / total])};
      if (this.mixtures.size >= 3200) this.mixtures.clear();
      this.mixtures.set(key, result); return result;
    }
    soften(base, pool, fraction) {
      if (!base || base === pool || fraction <= 0) return base;
      // Bounded radial strength bins; 1024 pigment ratios avoid old 1/48 hue steps.
      const steps = Math.round(fraction * 64), key = `soft:${base.id}/${pool.id}/${steps}`;
      if (!steps) return base;
      if (this.pairs.has(key)) return this.pairs.get(key);
      const weights = {};
      for (const [hex, part] of base.shares) weights[hex] = part * (64 - steps);
      for (const [hex, part] of pool.shares) weights[hex] = (weights[hex] || 0) + part * steps;
      const result = this.fine(weights);
      if (this.pairs.size >= 10000) this.pairs.clear();
      this.pairs.set(key, result); return result;
    }
  }
  class Surface extends W.Surface {
    constructor(...args) {
      super(...args);
      this.soft = new Float32Array(this.cells.length);
      // Optical sealing of an enclosed paper pore is distinct from transport
      // tail flags. It never changes mass, layer identity or a free thin end.
      this.sealed = new Uint8Array(this.cells.length);
      // Zero-wax pores have an optical pigment only: never insert transport
      // wax or layer identity merely to hide an enclosed paper pinhole.
      this.pores = new Array(this.cells.length).fill(null);
      this.contact = new Int32Array(this.cells.length);
      this.contactWeight = new Float32Array(this.cells.length);
    }
    clear() {
      super.clear(); this.soft?.fill(0); this.sealed?.fill(0); this.pores?.fill(null);
      this.brushId = undefined; this.brushSource = null; this.brushPigment = null;
    }
    stamp(point, settings) {
      // A new brush stroke obtains today's r4 cache identity; existing coats
      // keep their captured identity even if the displayed pen color is cached.
      if (this.brushId !== settings.strokeId || this.brushSource !== settings.pigment) {
        this.brushId = settings.strokeId; this.brushSource = settings.pigment;
        this.brushPigment = this.pigments.withState(settings.pigment,
          this.pigments.transport.mix(Object.fromEntries(settings.pigment.shares)));
      }
      settings = {...settings, pigment: this.brushPigment};
      super.stamp(point, settings);
      // New strokes get the unchanged r4 relief. Only an actual new coat resets.
      const reach = settings.radius * (1 + .66 * (settings.tilt || 0));
      const area = this.bounds(point.x - reach - 1, point.y - reach - 1, point.x + reach + 1, point.y + reach + 1);
      if (!this.soft || !area) return;
      for (let y = area.top; y <= area.bottom; y++) for (let x = area.left; x <= area.right; x++) {
        const i = y * this.width + x;
        if (this.coat[i] === settings.strokeId) { this.soft[i] = 0; this.sealed[i] = 0; this.pores[i] = null; }
      }
    }
    samePigment(a, b) { return this.pigments.state(a) === this.pigments.state(b); }
    blendPigment(base, added, share) {
      const state = this.pigments.transport.blend(this.pigments.state(base), this.pigments.state(added), share);
      return this.pigments.withState(this.pigments.blend(base, added, share), state);
    }
    remove(index, amount, upper) {
      const removed = super.remove(index, amount, upper);
      if (!this.mass[index]) {
        if (this.soft) this.soft[index] = 0;
        if (this.sealed) this.sealed[index] = 0;
        if (this.pores) this.pores[index] = null;
      }
      // Scraping one of a pore's four neighbors permanently breaks that
      // optical cover. Repainting the rim must not resurrect its old color.
      if (this.pores) {
        const x = index % this.width, y = Math.floor(index / this.width);
        for (const neighbor of [x > 0 ? index - 1 : -1, x < this.width - 1 ? index + 1 : -1,
          y > 0 ? index - this.width : -1, y < this.height - 1 ? index + this.width : -1]) {
          if (neighbor >= 0 && this.pores[neighbor] && !this.enclosed(neighbor)) this.pores[neighbor] = null;
        }
      }
      return removed;
    }
    poreCovered(index) {
      return (this.sealed[index] || this.pores[index]) && this.enclosed(index);
    }
    enclosed(index) {
      const x = index % this.width, y = Math.floor(index / this.width);
      return x > 0 && x < this.width - 1 && y > 0 && y < this.height - 1
        && [index - 1, index + 1, index - this.width, index + this.width]
          .every(j => this.mass[j] >= 4 && !this.tail[j]);
    }
    rgbAt(x, y) {
      const index = this.at(x, y);
      return !this.mass[index] && this.pores[index] && this.poreCovered(index)
        ? this.pores[index].rgb : super.rgbAt(x, y);
    }
    writeFlat(index, out, offset = 0, gloss = false) {
      if (!this.mass[index] && this.pores[index] && this.poreCovered(index)) {
        for (let c = 0; c < 3; c++) out[offset + c] = this.pores[index].rgb[c];
        return;
      }
      super.writeFlat(index, out, offset, gloss);
      const soft = this.soft?.[index];
      if (!soft || !this.cells[index]) return;
      const sealed = this.poreCovered(index);
      const coverage = this.tail[index] && !sealed ? Math.min(1, this.mass[index] / 4) : 1;
      const color = this.cells[index].rgb, i = index * 4;
      for (let c = 0; c < 3; c++) {
        const smooth = this.blank[i + c] * (1 - coverage) + color[c] * coverage;
        out[offset + c] = sealed ? smooth : out[offset + c] * (1 - soft) + smooth * soft;
      }
    }
    add(index, pigment, amount, mix = false) {
      // Destination layer and transport identity are EXACTLY r4. The color
      // payload can mix continuously without changing any r4 identity test.
      const bottom = !this.bottomMass[index] || (!this.topMass[index]
        && this.samePigment(this.bottom[index], pigment));
      const old = bottom ? this.bottom[index] : this.top[index];
      const mass = bottom ? this.bottomMass[index] : this.topMass[index];
      super.add(index, pigment, amount, mix);
      if (this.smudging && amount && old) {
        const layer = bottom ? this.bottom : this.top;
        layer[index] = this.pigments.withState(
          this.pigments.soften(old, pigment, amount / (mass + amount)), this.pigments.state(layer[index]));
        this.refresh(index);
      }
    }
    spread(point, dx, dy, settings) {
      this.smudging = settings.tool === 'smudge';
      try { super.spread(point, dx, dy, settings); }
      finally { this.smudging = false; }
      if (settings.tool !== 'smudge' || settings.strength <= 0 || !Math.hypot(dx, dy)) return;
      const radius = settings.radius, r2 = radius * radius;
      const area = this.bounds(point.x - radius, point.y - radius, point.x + radius, point.y + radius);
      if (!area) return;
      let count = 0;
      const weights = {};
      // Read the whole contact before writing, with a continuous radial kernel:
      // no random subset, isolated mixture cells or feedback within one step.
      for (let y = area.top; y <= area.bottom; y++) for (let x = area.left; x <= area.right; x++) {
        const d2 = (x - point.x) ** 2 + (y - point.y) ** 2, i = y * this.width + x;
        if (d2 >= r2 || (!this.cells[i] && !this.enclosed(i))) continue;
        const weight = (1 - d2 / r2) ** 2;
        this.contact[count] = i; this.contactWeight[count++] = weight;
        for (const [layer, mass] of [[this.bottom[i], this.bottomMass[i]], [this.top[i], this.topMass[i]]]) {
          if (!layer || !mass) continue;
          for (const [hex, part] of layer.shares) weights[hex] = (weights[hex] || 0) + part * mass * weight;
        }
      }
      if (Object.keys(weights).length < 2) return; // Single-color r4 push is untouched.
      const pool = this.pigments.fine(weights);
      // Light pressure can still blend contacts, without moving wax below
      // r4's .30 yield threshold. Higher pressure homogenizes faster.
      const rate = settings.strength <= .30 ? .40 * settings.strength / .30
        : .40 + .50 * ((settings.strength - .30) / .70);
      for (let n = 0; n < count; n++) {
        const i = this.contact[n], weight = this.contactWeight[n];
        if (!this.cells[i]) continue;
        for (const layer of [this.bottom, this.top]) if (layer[i]) {
          layer[i] = this.pigments.withState(this.pigments.soften(layer[i], pool, rate * weight), this.pigments.state(layer[i]));
        }
        // Smooth both real coats so an opaque top also actually mixes with
        // the bottom; knife can still reveal it without altering its thickness.
        this.refresh(i);
        this.soft[i] = Math.min(1, this.soft[i] + weight * .65);
        const x = i % this.width, y = Math.floor(i / this.width);
        if (this.tail[i] && this.mass[i] < 4 && x > 0 && x < this.width - 1 && y > 0 && y < this.height - 1
          && [i - 1, i + 1, i - this.width, i + this.width].every(j => this.mass[j] >= 4 && !this.tail[j])) {
          this.sealed[i] = 1;
        }
      }
      // Fill optical pores AFTER mixing their four real neighbors. A whole
      // disk pool can differ from a local transition and leave a green speck.
      for (let n = 0; n < count; n++) {
        const i = this.contact[n];
        if (this.cells[i] || !this.enclosed(i)) continue;
        const local = {};
        for (const j of [i - 1, i + 1, i - this.width, i + this.width])
          for (const [hex, part] of this.cells[j].shares) local[hex] = (local[hex] || 0) + part;
        this.pores[i] = this.pigments.fine(local);
      }
      this.mark(area);
    }
  }
  const api = {Surface, Pigments, MAX_PIGMENTS};
  if (typeof module !== 'undefined') module.exports = api;
  else root.SoftSmudge = api;
})(globalThis);
