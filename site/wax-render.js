'use strict';

const WaxRender = (() => {
  function flat(canvas, surface, gloss = false) {
    canvas.width = surface.width;
    canvas.height = surface.height;
    const ctx = canvas.getContext('2d', {alpha: false});
    const image = ctx.createImageData(surface.width, surface.height);
    function draw() {
      const area = surface.dirty;
      if (!area) return;
      const {left, top, right, bottom} = area;
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const i = (y * surface.width + x) * 4;
          surface.writeFlat(i / 4, image.data, i, gloss);
          image.data[i + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0, left, top, right - left + 1, bottom - top + 1);
      surface.dirty = null;
    }
    return {draw};
  }

  return {flat};
})();
if (typeof module !== 'undefined') module.exports = WaxRender;
else globalThis.WaxRender = WaxRender;
