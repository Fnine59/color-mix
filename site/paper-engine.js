(function (root) {
  const P = typeof module !== 'undefined' ? require('./paper-studio.js') : root.PaperStudio;
  // The sole model owner. Both Worker and the no-Worker path use this exact
  // ordered command interpreter; no simulation or serialization in the proxy.
  class Engine {
    constructor(studio = new P.Studio()) { this.studio = studio; this.stroke = null; }
    run(command) {
      const model = this.studio;
      switch (command.type) {
        case 'restore': model.restore(command.value); model.history = []; break;
        case 'begin':
          model.begin();
          this.stroke = {strokeId: model.paper.beginStroke(),
            pigment: command.hex ? model.pigments.color(command.hex) : null};
          break;
        case 'samples':
          if (!this.stroke) throw new Error('白纸笔画尚未开始');
          for (const sample of command.samples)
            model.paper.stroke(sample.from, sample.to, {...sample.settings, ...this.stroke});
          break;
        case 'commit': {
          const changed = model.commit(); this.stroke = null;
          return changed ? JSON.stringify(model.committedSnapshot.wax) : null;
        }
        case 'undo':
          this.stroke = null;
          return model.undo() ? JSON.stringify(P.encodePaper(model.paper)) : null;
        case 'clear':
          this.stroke = null; model.begin(); model.paper.clear();
          return model.commit() ? JSON.stringify(model.committedSnapshot.wax) : null;
        case 'save': return JSON.stringify(P.encodePaper(model.paper));
        case 'barrier': break;
        default: throw new Error('未知白纸命令');
      }
      return null;
    }
    patch() {
      const paper = this.studio.paper, area = paper.dirty;
      if (!area) return null;
      const {left, top, right, bottom} = area;
      const width = right - left + 1, height = bottom - top + 1;
      const pixels = new Uint8ClampedArray(width * height * 4);
      // Picker pigment RGB differs from relief-rendered RGB, and thin ends
      // use the old display rule. Float64 preserves the original rounding.
      const rgb = new Float64Array(width * height * 3);
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const n = (y - top) * width + x - left;
        paper.writeFlat(y * paper.width + x, pixels, n * 4);
        pixels[n * 4 + 3] = 255;
        rgb.set(paper.rgbAt(x, y), n * 3);
      }
      paper.dirty = null;
      return {area, pixels, rgb};
    }
    batch(commands) {
      const results = commands.map(command => this.run(command));
      return {results, history: this.studio.history.length, patch: this.patch()};
    }
  }
  const api = {Engine};
  if (typeof module !== 'undefined') module.exports = api;
  else root.PaperEngine = api;
})(globalThis);
