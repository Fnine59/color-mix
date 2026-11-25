/* global ColorMath, Recipe */
'use strict';

const Recipe = require('../../site/recipe.js');
const WaxPaint = (() => {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const codes = ['644', '726', '704', '707', '610', '745', '701'];
  const ratioSteps = 48;

  function tooth(x, y) {
    let n = Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(y + 13, 0x27d4eb2d);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }

  class Pigments {
    constructor() {
      this.mixtures = new Map();
      this.pairs = new Map();
      this.nextId = 1;
    }

    color(hex) {
      return this.mix({[hex.toUpperCase()]: 1});
    }

    mix(weights) {
      const total = Object.values(weights).reduce((sum, part) => sum + part, 0);
      const entries = Object.keys(weights).sort()
        .map(hex => [hex, Math.round(weights[hex] / total * ratioSteps)])
        .filter(([, part]) => part > 0);
      if (!entries.length) {
        const strongest = Object.keys(weights).reduce((a, b) => weights[a] >= weights[b] ? a : b);
        entries.push([strongest, ratioSteps]);
      }
      const key = entries.map(([hex, part]) => `${hex}/${part}`).join(',');
      if (this.mixtures.has(key)) return this.mixtures.get(key);

      const parts = entries.map(([, part]) => part);
      const paints = entries.map(([hex]) => ({hex}));
      const rgb = Recipe.mix(paints, parts);
      const sum = parts.reduce((amount, part) => amount + part, 0);
      const mixture = {id: this.nextId++, rgb, shares: entries.map(([hex, part]) => [hex, part / sum])};
      if (this.mixtures.size >= 3200) this.mixtures.clear();
      this.mixtures.set(key, mixture);
      return mixture;
    }

    blend(base, added, share) {
      if (!base || base === added) return added;
      const steps = Math.round(clamp(share, 0, 1) * ratioSteps);
      if (steps === 0) return base;
      if (steps === ratioSteps) return added;
      const key = `${base.id}/${added.id}/${steps}`;
      if (this.pairs.has(key)) return this.pairs.get(key);

      const weights = {};
      for (const [hex, part] of base.shares) weights[hex] = part * (ratioSteps - steps);
      for (const [hex, part] of added.shares) weights[hex] = (weights[hex] || 0) + part * steps;
      const result = this.mix(weights);
      if (this.pairs.size >= 10000) this.pairs.clear();
      this.pairs.set(key, result);
      return result;
    }
  }

  class Surface {
    constructor(width, height, ground, pigments) {
      this.width = width;
      this.height = height;
      this.ground = ground;
      this.pigments = pigments;
      this.cells = new Array(width * height).fill(null);
      // Bounded two-layer paper model. cells/mass are derived visible color /
      // total relief, retained for rendering and the existing picker.
      this.mass = new Float32Array(width * height);
      this.bottom = new Array(width * height).fill(null);
      this.top = new Array(width * height).fill(null);
      this.bottomMass = new Float32Array(width * height);
      this.topMass = new Float32Array(width * height);
      this.coat = new Uint32Array(width * height);
      this.moved = new Uint32Array(width * height);
      this.receivedId = new Uint32Array(width * height);
      // Original wax and this stroke's deposits must not be confused: a
      // receiving original cell with unchanged color can still yield ONCE.
      // A recolored old top coat is blocked below, not relayed as new pigment.
      this.receivedBottom = new Float32Array(width * height);
      this.receivedTop = new Float32Array(width * height);
      // Optical thinning belongs to pushed wax and its thin-tail shavings.
      // Scraping preserves it; ordinary brush/body shavings stay solid.
      this.tail = new Uint8Array(width * height);
      this.strokeId = 0;
      // Reused transfer buffers: no per-cell objects or per-step full scan.
      this.targets = new Int32Array(width * height * 2);
      this.amounts = new Float32Array(width * height * 2);
      this.thinSource = new Uint8Array(this.targets.length);
      this.fragments = new Array(width * height * 2);
      this.transferCount = 0;
      this.field = new Uint8Array(width * height * 4);
      this.blank = new Uint8Array(this.field.length);
      this.grain = new Float32Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index = y * width + x;
          this.grain[index] = tooth(x, y);
          const fiber = Math.sin(x * 0.55 + Math.sin(y * 0.23)) + Math.sin(y * 2.1 + x * 0.03);
          const texture = (this.grain[index] - 0.5) * 12 + fiber * 1.7;
          ground.forEach((value, channel) => {
            this.blank[index * 4 + channel] = clamp(Math.round(value + texture), 0, 255);
          });
        }
      }
      this.clear();
    }

    clear() {
      this.cells.fill(null);
      this.mass.fill(0);
      this.bottom.fill(null);
      this.top.fill(null);
      this.bottomMass.fill(0);
      this.topMass.fill(0);
      this.coat.fill(0);
      this.moved.fill(0);
      this.receivedId.fill(0);
      this.receivedBottom.fill(0);
      this.receivedTop.fill(0);
      this.tail.fill(0);
      this.strokeId = 0;
      this.push = null;
      this.transferCount = 0;
      this.field.set(this.blank);
      this.dirty = this.bounds(0, 0, this.width - 1, this.height - 1);
    }

    bounds(left, top, right, bottom) {
      return {
        left: clamp(Math.floor(left), 0, this.width - 1),
        top: clamp(Math.floor(top), 0, this.height - 1),
        right: clamp(Math.ceil(right), 0, this.width - 1),
        bottom: clamp(Math.ceil(bottom), 0, this.height - 1),
      };
    }

    mark(bounds) {
      const patch = this.bounds(bounds.left - 2, bounds.top - 2, bounds.right + 2, bounds.bottom + 2);
      const old = this.dirty;
      this.dirty = old ? {
        left: Math.min(patch.left, old.left), top: Math.min(patch.top, old.top),
        right: Math.max(patch.right, old.right), bottom: Math.max(patch.bottom, old.bottom),
      } : patch;
    }

    at(x, y) {
      const column = clamp(Math.floor(x), 0, this.width - 1);
      const row = clamp(Math.floor(y), 0, this.height - 1);
      return row * this.width + column;
    }

    rgbAt(x, y) {
      const index = this.at(x, y);
      if (this.tail[index] && this.mass[index] < 4 && this.cells[index]) {
        const rgb = new Uint8ClampedArray(3);
        this.writeFlat(index, rgb);
        return Array.from(rgb);
      }
      return this.cells[index]?.rgb || this.ground;
    }

    pigmentAt(x, y, hex) {
      const index = this.at(x, y);
      // "Paint with this color" must match a thin tail's displayed hex.
      return this.tail[index] && this.mass[index] < 4
        ? this.pigments.color(hex) : this.cells[index] || this.pigments.color(hex);
    }

    // Shared Canvas2D/picker/loupe optical rule. Pigment recipes and mass
    // remain untouched; sampling a thin tail returns its displayed color.
    writeFlat(index, output, offset = 0, gloss = false) {
      const i = index * 4, field = this.field, height = field[i + 3];
      const x = index % this.width, y = Math.floor(index / this.width);
      const above = field[(y > 0 ? i - this.width * 4 : i) + 3];
      const below = field[(y < this.height - 1 ? i + this.width * 4 : i) + 3];
      const left = field[(x > 0 ? i - 4 : i) + 3];
      const right = field[(x < this.width - 1 ? i + 4 : i) + 3];
      const mass = this.mass[index];
      const relief = (below - above) * .10 + (right - left) * .05;
      const fiber = (this.grain[index] - .5) * (gloss ? 3 : 10) / (1 + mass / 24);
      const highlight = gloss ? Math.max(relief - 9, 0) * 1.2 : 0;
      const tone = height ? clamp(relief + fiber + highlight, -16, 18)
        : -Math.min(3, (above + left) * .025);
      const coverage = height && this.tail[index] ? Math.min(1, mass / 4) : 1;
      for (let channel = 0; channel < 3; channel++) {
        output[offset + channel] = this.blank[i + channel] * (1 - coverage)
          + (field[i + channel] + tone) * coverage;
      }
    }

    refresh(index) {
      const offset = index * 4;
      const mixture = this.topMass[index] > 0 ? this.top[index] : this.bottom[index];
      const height = this.bottomMass[index] + this.topMass[index];
      this.cells[index] = mixture;
      this.mass[index] = height;
      if (!mixture) {
        this.field.set(this.blank.subarray(offset, offset + 4), offset);
        return;
      }
      const rgb = mixture.rgb;
      this.field[offset] = rgb[0];
      this.field[offset + 1] = rgb[1];
      this.field[offset + 2] = rgb[2];
      // Height is for relief only, not opacity or the mixing ratio.
      this.field[offset + 3] = clamp(Math.round(height), 1, 210);
    }

    beginStroke() {
      this.push = null;
      return ++this.strokeId;
    }

    remove(index, amount, upper) {
      const masses = upper ? this.topMass : this.bottomMass;
      const colors = upper ? this.top : this.bottom;
      const before = masses[index];
      masses[index] = Math.max(0, before - amount);
      if (!masses[index]) colors[index] = null;
      this.refresh(index);
      return before - masses[index];
    }

    add(index, pigment, amount, mix = false) {
      if (!amount) return;
      if (!this.bottomMass[index]) {
        this.bottom[index] = pigment;
        this.bottomMass[index] = amount;
      } else if (!this.topMass[index] && this.bottom[index] === pigment) {
        this.bottomMass[index] += amount;
      } else {
        const old = this.top[index];
        // Only a few shove-contact cells mix. Knife shavings stay solid.
        this.top[index] = mix && old && old !== pigment
          ? this.pigments.blend(old, pigment, amount / (this.topMass[index] + amount))
          : pigment;
        this.topMass[index] += amount;
      }
      this.refresh(index);
    }

    stamp(point, {pigment, radius, strength, angle, tilt = 0, dry = false, deposit = 1, strokeId = 0}) {
      const reach = radius * (1 + 0.66 * tilt);
      const bounds = this.bounds(point.x - reach - 1, point.y - reach - 1, point.x + reach + 1, point.y + reach + 1);
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const invReach = 1 / reach;
      const invRadius = 1 / radius;
      for (let y = bounds.top; y <= bounds.bottom; y++) {
        for (let x = bounds.left; x <= bounds.right; x++) {
          const index = y * this.width + x;
          const across = (y - point.y) * cosine - (x - point.x) * sine;
          const along = (x - point.x) * cosine + (y - point.y) * sine;
          const grain = this.grain[index];
          const edge2 = (along * invReach) ** 2 + (across * invRadius) ** 2;
          // Soft material contacts a continuous perimeter, not isolated
          // grain-dependent dots just outside the body. Dry edge is unchanged.
          const edgeLimit = dry ? 0.81 + grain * 0.19 : 0.96;
          if (edge2 > edgeLimit * edgeLimit) continue;
          // Dry crayon keeps its old broken contact. Soft wax fills valleys:
          // medium+ has continuous contact; light leaves only shallow holes,
          // which a later coat can fill (no permanently excluded paper cells).
          const contact = tooth(x + strokeId * 37, y + strokeId * 19);
          if (dry) {
            if (grain > 0.36 + strength * 0.43) continue;
            if (contact > 0.48 + strength * 0.29 - edge2 * 0.23) continue;
          } else if (strength < 0.55
            && contact > 0.94 + strength * 0.06 + Math.min(0.06, this.mass[index] / 400)) continue;

          const ridge = Math.sin(across * 2.2 + Math.sin(along * 0.19) * 0.8);
          const lay = (0.70 + ridge * 0.16 + grain * 0.14);
          const amount = (dry ? 4 + strength * 12 : 18 + strength * 34) * lay * deposit;
          const upper = this.topMass[index] > 0 || (this.bottomMass[index] > 0 && this.bottom[index] !== pigment);
          const colors = upper ? this.top : this.bottom;
          const masses = upper ? this.topMass : this.bottomMass;
          // First color stays underneath. A third color replaces only the
          // upper coat (two-layer limit); drawing NEVER mixes or picks up wax.
          const same = colors[index] === pigment;
          masses[index] = same
            ? (this.coat[index] === strokeId ? Math.max(masses[index], amount) : masses[index] + amount)
            : amount;
          colors[index] = pigment;
          this.tail[index] = 0;
          this.refresh(index);
          this.coat[index] = strokeId;
        }
      }
      this.mark(bounds);
    }

    spread(point, dx, dy, {radius, strength, tool}) {
      const travel = Math.hypot(dx, dy);
      if (!travel) return;
      const ax = dx / travel;
      const ay = dy / travel;
      const knife = tool === 'knife';
      if (!knife && strength <= 0.30) return; // solid wax yield threshold
      const id = this.push?.id || this.strokeId || 1;
      this.transferCount = 0;
      const width = knife ? Math.max(0.7, radius * 0.025) : radius * 0.70;
      const depth = knife ? Math.max(1.5, travel * 0.6) : radius * 0.50;
      const reachX = Math.abs(ax) * depth + Math.abs(ay) * width + 1;
      const reachY = Math.abs(ay) * depth + Math.abs(ax) * width + 1;
      const bounds = this.bounds(point.x - reachX, point.y - reachY, point.x + reachX, point.y + reachY);
      const queue = (target, pigment, amount, thinSource = false) => {
        // A continuous trail can have more than two deposits per source.
        // Grow only if needed, never silently drop wax at buffer capacity.
        if (this.transferCount === this.targets.length) {
          const capacity = this.targets.length * 2;
          const targets = new Int32Array(capacity), amounts = new Float32Array(capacity);
          const sources = new Uint8Array(capacity);
          targets.set(this.targets); amounts.set(this.amounts);
          sources.set(this.thinSource);
          this.targets = targets; this.amounts = amounts;
          this.thinSource = sources;
          this.fragments.length = capacity;
        }
        const n = this.transferCount++;
        this.targets[n] = target;
        this.fragments[n] = pigment;
        this.amounts[n] = amount;
        this.thinSource[n] = thinSource;
      };
      for (let y = bounds.top; y <= bounds.bottom; y++) {
        for (let x = bounds.left; x <= bounds.right; x++) {
          const u = x - point.x;
          const v = y - point.y;
          const along = u * ax + v * ay;
          const across = v * ax - u * ay;
          if (Math.abs(across) > width || Math.abs(along) > depth) continue;
          // Push the trailing contact, after the pointer has passed the source.
          // Picking the leading half once would exhaust it before a short,
          // body-connected tail has room to form inside the touched footprint.
          if (!knife && along > 0) continue;
          const index = y * this.width + x;
          if (!this.cells[index] || this.moved[index] === id) continue;
          this.moved[index] = id; // each original patch yields at most once
          if (knife) {
            const thinSource = this.tail[index] && this.mass[index] < 4;
            const upper = this.topMass[index] > 0;
            const pigment = upper ? this.top[index] : this.bottom[index];
            const available = upper ? this.topMass[index] : this.bottomMass[index];
            // One stroke cuts the currently exposed layer; subsequent strokes
            // cut deeper. Light pressure thins it, heavy pressure pierces it.
            const fraction = 1 - (1 - clamp((strength - 0.15) / 0.70, 0, 1)) ** 2.5;
            // Default medium clears a normal 30–50 unit coat in 3 passes.
            // Finite residual cutoff, also for the bottom; ALL lifted wax
            // (including the residual) is queued, never silently discarded.
            const requested = available * fraction;
            const amount = this.remove(index, available - requested < 0.15 ? available : requested, upper);
            // Scraped wax stays on the paper, on BOTH sides, not on a tool.
            const offset = width + 1.5 + this.grain[index] * 1.5;
            queue(this.at(x - ay * offset, y + ax * offset), pigment, amount * 0.5, thinSource);
            queue(this.at(x + ay * offset, y - ax * offset), pigment, amount * 0.5, thinSource);
          } else {
            const lane = tooth(Math.floor(across) + 503, 29);
            if (lane < 0.12) continue;
            const upper = this.topMass[index] > 0;
            const available = (upper ? this.topMass[index] : this.bottomMass[index])
              - (this.receivedId[index] === id ? (upper ? this.receivedTop[index] : this.receivedBottom[index]) : 0);
            const pigment = upper ? this.top[index] : this.bottom[index];
            // Keep >= 80% of the original body. Finite, contact-local move;
            // newly deposited wax is not picked up again in this stroke.
            const flow = 0.20 * ((strength - 0.30) / 0.70) ** 2;
            if (available * flow < 0.15) continue;
            // Judge the ACTUAL Float32 source loss, not just the ideal flow.
            // Keep sub-threshold rounding remnants on their source cell.
            const current = upper ? this.topMass[index] : this.bottomMass[index];
            const amount = current - Math.fround(current - available * flow);
            if (amount < 0.15) continue;
            // All destinations lie inside the CURRENT touched disk, not in
            // front of the pointer. A rounding margin also covers floor(at).
            const safeRadius = Math.max(0, radius - 1.5);
            if (Math.abs(across) >= safeRadius) continue;
            const front = Math.sqrt(safeRadius * safeRadius - across * across) - along;
            const taper = 1 - Math.min(1, Math.abs(across) / width) * 0.50;
            // Enough real wax for EVERY connecting cell, >= .15 each.
            // Tiny yields stay at the source instead of creating faint islands.
            const minimum = 0.15001;
            const shift = Math.min(radius * (0.55 + lane * 0.65) * taper,
              front, Math.floor(amount / minimum));
            if (shift < 1) continue;
            const steps = Math.ceil(shift);
            this.remove(index, amount, upper);
            const remainder = amount - minimum * steps;
            const weightSum = steps * (steps + 1) / 2;
            // Rasterize the WHOLE source-to-front trail with <=1-cell steps.
            // Each deposit connects to its predecessor, decreasing in volume.
            // No second displaced shard, no grain dropout, no off-path blur.
            for (let step = 1; step <= steps; step++) {
              const distance = shift * step / steps;
              const target = this.at(x + ax * distance, y + ay * distance);
              const share = minimum + remainder * (steps + 1 - step) / weightSum;
              queue(target, pigment, share);
            }
          }
        }
      }
      for (let n = 0; n < this.transferCount; n++) {
        const target = this.targets[n];
        if (!knife && this.receivedId[target] !== id) {
          this.receivedId[target] = id;
          this.receivedBottom[target] = this.receivedTop[target] = 0;
        }
        const bottomBefore = this.bottomMass[target], topBefore = this.topMass[target];
        const blank = !this.cells[target];
        const topColorBefore = this.top[target];
        // Knife shavings never clear an existing tail; thin-tail sources
        // landing on blank paper also retain mass/4 optical thinning.
        if (knife && blank && this.thinSource[n]) this.tail[target] = 1;
        this.add(target, this.fragments[n], this.amounts[n],
          // Rare, local spectral contact mixing; no relay of recolored coats.
          !knife && this.grain[target] > 0.92);
        if (!knife) {
          this.receivedBottom[target] += this.bottomMass[target] - bottomBefore;
          this.receivedTop[target] += this.topMass[target] - topBefore;
          if (blank) this.moved[target] = id;
          if (topColorBefore && this.top[target] !== topColorBefore) this.moved[target] = id;
          if (blank) this.tail[target] = 1;
        }
        this.fragments[n] = null;
      }
      const movedReach = knife ? width + 4 : radius * 1.3;
      if (this.transferCount) this.mark({
        left: bounds.left - movedReach, top: bounds.top - movedReach,
        right: bounds.right + movedReach, bottom: bounds.bottom + movedReach,
      });
    }

    stroke(from, to, settings) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.hypot(dx, dy);
      if (settings.tool !== 'brush') {
        // Resample the input polyline by accumulated arc length. Tiny events
        // retain their remainder instead of each moving/mixing a whole patch.
        // A final remainder stays below one spacing; it is never flushed per
        // event. A new stroke, tool change, or discontinuity starts fresh.
        let push = this.push;
        if (!push || push.tool !== settings.tool || push.strokeId !== settings.strokeId
          || Math.hypot(from.x - push.input.x, from.y - push.input.y) > 1e-6) {
          push = this.push = {tool: settings.tool, strokeId: settings.strokeId,
            id: settings.strokeId || ++this.strokeId,
            input: from, point: from, pending: 0,
            spacing: settings.tool === 'knife' ? 1 : Math.max(1, settings.radius * 0.18)};
        }
        let walked = 0;
        while (distance - walked + push.pending >= push.spacing - 1e-9 && distance > 0) {
          walked = Math.min(distance, walked + push.spacing - push.pending);
          const point = {x: from.x + dx * walked / distance, y: from.y + dy * walked / distance};
          this.spread(point, point.x - push.point.x, point.y - push.point.y, settings);
          push.point = point;
          push.pending = 0;
        }
        push.pending += distance - walked;
        push.input = to;
        return;
      }
      this.push = null;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, settings.radius * 0.22)));
      for (let i = 1; i <= steps; i++) {
        const point = {x: from.x + dx * i / steps, y: from.y + dy * i / steps};
        this.stamp(point, settings);
      }
    }
  }

  function ribbon(board, paint, xStart, xEnd, height, bend, radius, dry = false) {
    let last;
    const strokeId = board.beginStroke();
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const point = {x: board.width * (xStart + (xEnd - xStart) * t), y: board.height * (height + bend(t))};
      const angle = last ? Math.atan2(point.y - last.y, point.x - last.x) : 0;
      const localRadius = board.width * radius * (0.43 + Math.sin(Math.PI * t) * 0.57);
      board.stroke(last || point, point, {tool: 'brush', pigment: paint, radius: localRadius,
        strength: 0.64 + Math.sin(t * 8) * 0.17, angle, tilt: 0.22, dry, strokeId});
      last = point;
    }
  }

  function seedPaper(board, paint, dry) {
    const swell = t => Math.sin(t * Math.PI * 2.1 - 0.4);
    ribbon(board, paint['745'], 0.11, 0.57, 0.70, t => swell(t) * 0.10, 0.047, dry);
    ribbon(board, paint['644'], 0.13, 0.80, 0.59, t => swell(t) * 0.19, 0.064, dry);
    ribbon(board, paint['726'], 0.16, 0.87, 0.72, t => swell(t) * 0.14 - t * 0.28, 0.062, dry);
    ribbon(board, paint['704'], 0.18, 0.70, 0.38, t => -Math.sin(t * Math.PI * 1.6) * 0.19 + t * 0.12, 0.058, dry);
    ribbon(board, paint['610'], 0.26, 0.67, 0.34, t => -Math.sin(t * Math.PI * 1.45) * 0.13, 0.024, dry);
    ribbon(board, paint['701'], 0.35, 0.67, 0.62, t => swell(t) * 0.08, 0.017, true);
    ribbon(board, paint['707'], 0.66, 0.84, 0.23, t => -Math.sin(t * Math.PI * 0.9) * 0.06, 0.022, dry);
  }

  function seedTray(board, paint) {
    board.clear();
    const half = board.pigments.blend(paint['644'], paint['704'], 0.5);
    const layout = [paint['644'], half, paint['704']];
    layout.forEach((pigment, i) => {
      board.stamp({x: board.width * (0.19 + 0.31 * i), y: board.height * 0.5}, {
        pigment, angle: -0.32, tilt: 0.5, radius: board.height * 0.27, strength: 0.88, deposit: 3.1,
      });
    });
  }

  return {Pigments, Surface, seedPaper, seedTray, clamp, codes};
})();

if (typeof module !== 'undefined') module.exports = WaxPaint;
