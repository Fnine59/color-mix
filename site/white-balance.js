// Single neutral-reference white balance. Always apply to the original image.
(function (root) {
  const M = typeof module !== 'undefined' ? require('./color-math.js') : root.ColorMath;
  const REFERENCE_RADIUS = 4, CLIPPED_CHANNEL = 250, MIN_LUMINANCE = 0.06, MAX_SATURATION = 0.35;
  const luminance = lin => 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  function coefficients(rgb) {
    if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some(v => !Number.isFinite(v) || v < 0 || v > 255))
      throw new Error('参考点颜色无效，请换一处白纸');
    if (Math.max(...rgb) >= CLIPPED_CHANNEL)
      throw new Error('参考点太亮，可能已经过曝，请换一处没有反光的白纸');
    const lin = M.rgb255ToLin(rgb), y = luminance(lin);
    if (y < MIN_LUMINANCE)
      throw new Error('参考点太暗，请换一处较亮的白纸或浅灰处');
    if ((Math.max(...rgb) - Math.min(...rgb)) / Math.max(...rgb) > MAX_SATURATION)
      throw new Error('参考点颜色太艳，不像白纸或浅灰，请换一处');
    // All three corrected channels become the original luminance Y, not 1.
    return {gains: lin.map(channel => y / channel), reference: rgb.slice(), luminance: y};
  }
  function regionAt(pixels, x, y, width = 1, height = 1) {
    if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 ||
        x + width > pixels.width || y + height > pixels.height)
      throw new Error('请在图片内选择参考点或颜色');
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      const start = ((y + row) * pixels.width + x) * 4;
      data.set(pixels.data.subarray(start, start + width * 4), row * width * 4);
    }
    return {data, width, height};
  }
  function referenceAt(pixels, x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= pixels.width || y >= pixels.height)
      throw new Error('请在图片内选择参考点');
    const left = Math.max(0, x - REFERENCE_RADIUS), top = Math.max(0, y - REFERENCE_RADIUS);
    const region = regionAt(pixels, left, top,
      Math.min(pixels.width, x + REFERENCE_RADIUS + 1) - left,
      Math.min(pixels.height, y + REFERENCE_RADIUS + 1) - top);
    for (let i = 0; i < region.data.length; i += 4) {
      if (region.data[i + 3] !== 255) throw new Error('参考区域有透明像素，请换一处实拍白纸');
      if (Math.max(region.data[i], region.data[i + 1], region.data[i + 2]) >= CLIPPED_CHANNEL)
        throw new Error('参考区域太亮，可能已经过曝，请换一处没有反光的白纸');
    }
    return {...coefficients(M.averagePixels(region.data)), region: {x: left, y: top, width: region.width, height: region.height}};
  }
  function apply(pixels, correction) {
    const data = new Uint8ClampedArray(pixels.data);
    if (correction) {
      if (!Array.isArray(correction.gains) || correction.gains.length !== 3 ||
          correction.gains.some(v => !Number.isFinite(v) || v <= 0))
        throw new Error('灯光校正系数无效');
      // Lookup tables avoid millions of pow() calls on large photos.
      const tables = correction.gains.map(gain => Uint8ClampedArray.from({length: 256},
        (_, value) => M.toGam(M.clamp01(M.toLin(value / 255) * gain)) * 255));
      for (let i = 0; i < data.length; i += 4)
        for (let c = 0; c < 3; c++) data[i + c] = tables[c][data[i + c]];
    }
    return {data, width: pixels.width, height: pixels.height};
  }
  const api = {REFERENCE_RADIUS, CLIPPED_CHANNEL, MIN_LUMINANCE, MAX_SATURATION, luminance, coefficients, regionAt, referenceAt, apply};
  if (typeof module !== 'undefined') module.exports = api;
  else root.WhiteBalance = api;
})(globalThis);
