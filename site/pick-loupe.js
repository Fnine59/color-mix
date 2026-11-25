(function (root) {
  const SIZE = 11, HALF = 5;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const rgbOf = bytes => ColorMath.averagePixels(bytes).map(Math.round);
  function point(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return {x: clamp(Math.floor((event.clientX - rect.left) * canvas.width / rect.width), 0, canvas.width - 1),
      y: clamp(Math.floor((event.clientY - rect.top) * canvas.height / rect.height), 0, canvas.height - 1)};
  }
  function readLoupe(canvas, x, y, sample) {
    x = clamp(Math.floor(x), 0, canvas.width - 1); y = clamp(Math.floor(y), 0, canvas.height - 1);
    const left = Math.max(0, x - HALF), top = Math.max(0, y - HALF);
    const right = Math.min(canvas.width - 1, x + HALF), bottom = Math.min(canvas.height - 1, y + HALF);
    const width = right - left + 1;
    const pixels = canvas.getContext('2d', {willReadFrequently: true}).getImageData(left, top, width, bottom - top + 1).data;
    const grid = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let row = 0; row < SIZE; row++) for (let col = 0; col < SIZE; col++) {
      const px = clamp(x + col - HALF, 0, canvas.width - 1), py = clamp(y + row - HALF, 0, canvas.height - 1);
      const i = ((py - top) * width + px - left) * 4, out = (row * SIZE + col) * 4;
      grid.set(sample ? sample(px, py) : rgbOf(pixels.subarray(i, i + 4)), out); grid[out + 3] = 255;
    }
    return grid;
  }
  function originAt(canvas, at) {
    const rect = canvas.getBoundingClientRect();
    return {x: rect.left + (at.x + .5) / canvas.width * rect.width,
      y: rect.top + (at.y + .5) / canvas.height * rect.height};
  }
  function mount({prefix = 'pick', swatch = 'picked-swatch'} = {}) {
    const $ = id => document.getElementById(id);
    const loupe = $(prefix + '-loupe'), ctx = $(prefix + '-loupe-canvas').getContext('2d');
    const frame = ctx.createImageData(SIZE, SIZE);
    let pending, raf = 0, closing = 0, effects = [];
    const motion = root.matchMedia?.('(prefers-reduced-motion: reduce)');
    function hide({boundary = false} = {}) {
      // Touch release immediately emits out/leave/lostcapture. Those normal
      // boundary notifications must not cancel an already confirmed frame.
      if (boundary && closing) return;
      pending = null;
      if (raf) root.cancelAnimationFrame(raf);
      if (closing) root.cancelAnimationFrame(closing);
      closing = 0;
      raf = 0; loupe.hidden = true;
    }
    function render({canvas, at, sample}) {
      const origin = originAt(canvas, at);
      frame.data.set(readLoupe(canvas, at.x, at.y, sample)); ctx.putImageData(frame, 0, 0);
      const center = (HALF * SIZE + HALF) * 4;
      const rgb = [...frame.data.subarray(center, center + 3)];
      const hex = ColorMath.rgbToHex(rgb).toUpperCase();
      $(prefix + '-loupe-hex').textContent = hex;
      loupe.style.borderColor = hex;
      const chip = $(prefix + '-loupe-swatch');
      if (chip) chip.style.background = hex;
      loupe.style.left = `${clamp(origin.x + 14, 68, root.innerWidth - 68)}px`;
      // Prefer above the target, flip below only near the top of the viewport.
      loupe.style.top = `${clamp(origin.y + (origin.y > 180 ? -108 : 108), 82, root.innerHeight - 82)}px`;
      loupe.hidden = false;
      return rgb;
    }
    function show(canvas, at, sample) {
      if (closing) { root.cancelAnimationFrame(closing); closing = 0; }
      pending = {canvas, at, sample};
      if (raf) return;
      raf = root.requestAnimationFrame(() => {
        raf = 0;
        if (!pending) return;
        render(pending);
      });
    }
    function confirm(canvas, at, sample) {
      hide();
      // Release center and result share this exact snapshot, even when a
      // pending move has not drawn yet. Leave it through one painted frame.
      const rgb = render({canvas, at, sample});
      closing = root.requestAnimationFrame(() => {
        closing = root.requestAnimationFrame(() => { closing = 0; loupe.hidden = true; });
      });
      return rgb;
    }
    function clearEffects() {
      for (const {element, animation} of effects) { animation.cancel(); element?.remove(); }
      effects = [];
    }
    motion?.addEventListener?.('change', event => { if (event.matches) clearEffects(); });
    function animateDrop(hex, origin) {
      clearEffects();
      const chip = $(swatch);
      if (!origin || motion?.matches || typeof chip.animate !== 'function') return;
      const rect = chip.getBoundingClientRect(), end = {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      const add = (className, frames, options) => {
        const element = document.createElement('span'); element.className = className; element.style.background = hex;
        document.body.append(element);
        const animation = element.animate(frames, options);
        const effect = {element, animation}; effects.push(effect);
        const remove = () => { element.remove(); effects = effects.filter(item => item !== effect); };
        animation.onfinish = remove; animation.oncancel = remove;
      };
      const loc = (x, y, scale) => `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`;
      add('pick-drop', [
        {transform: loc(origin.x, origin.y, .5), opacity: .9},
        {transform: loc((origin.x + end.x) / 2, Math.min(origin.y, end.y) - 40, 1.1), offset: .55},
        {transform: loc(end.x, end.y, .25), opacity: 0},
      ], {duration: 430, easing: 'cubic-bezier(.25,.52,.55,1)'});
      for (const [dx, dy] of [[-18, -20], [20, -14], [8, 22]]) add('pick-splash', [
        {transform: loc(origin.x, origin.y, .8), opacity: .8},
        {transform: loc(origin.x + dx, origin.y + dy, .15), opacity: 0},
      ], {duration: 240, easing: 'ease-out'});
    }
    return {show, hide, confirm, animateDrop};
  }
  root.PickLoupe = {point, readLoupe, originAt, mount};
})(globalThis);
