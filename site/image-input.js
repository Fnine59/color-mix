// Shared file -> decode -> reduced canvas pixels pipeline. Browser adapters are
// injected, so Node tests run the SAME orchestration with a real native decoder.
(function (root) {
  const MAX_EDGE = 1600;
  function scaledSize(width, height, edge = MAX_EDGE) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
      throw new Error('图片尺寸无效，请换一张图片');
    const scale = Math.min(1, edge / Math.max(width, height));
    return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
  }
  function validateFile(file) {
    if (!file || !file.size) throw new Error('没有收到图片，请重新选图、拖入或粘贴');
    if (file.size > 80 * 1024 * 1024) throw new Error('图片超过 80 MB，请先缩小图片再试');
    const extension = (file.name || '').split('.').pop().toLowerCase();
    if (file.type && !file.type.startsWith('image/') && !['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(extension))
      throw new Error('这不是图片文件，请选择照片或截图');
    return {heic: /heic|heif/i.test(file.type || '') || ['heic', 'heif'].includes(extension)};
  }
  function filesFromTransfer(transfer) {
    if (!transfer) return [];
    const files = Array.from(transfer.files || []);
    if (files.length) return files;
    return Array.from(transfer.items || []).filter(v => v.kind === 'file').map(v => v.getAsFile()).filter(Boolean);
  }
  async function loadFile(file, {decode, createCanvas}) {
    const metadata = validateFile(file);
    let image;
    try { image = await decode(file); }
    catch {
      throw new Error(metadata.heic
        ? '这个浏览器读不了苹果 HEIC 照片，请转成 JPG、PNG 或截图后再试'
        : '图片解码失败，可能格式不支持或文件已损坏；请换 JPG、PNG 或 WebP 图片');
    }
    try {
      const original = {width: image.width || image.naturalWidth, height: image.height || image.naturalHeight};
      const size = scaledSize(original.width, original.height);
      const canvas = createCanvas(size.width, size.height);
      const ctx = canvas.getContext('2d', {willReadFrequently: true, colorSpace: 'srgb'});
      if (!ctx) throw new Error('画布不可用');
      ctx.drawImage(image, 0, 0, size.width, size.height);
      const pixels = ctx.getImageData(0, 0, size.width, size.height);
      return {canvas, pixels, original, size};
    } catch (error) {
      throw new Error(`图片处理失败，请换一张较小的图片再试（${error.message}）`);
    } finally { image.close?.(); }
  }
  async function browserDecode(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file, {imageOrientation: 'from-image'}); }
      catch { /* Fallback for formats decoded by HTMLImageElement only. */ }
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法解码')); };
      image.src = url;
    });
  }
  const api = {MAX_EDGE, scaledSize, validateFile, filesFromTransfer, loadFile, browserDecode};
  if (typeof module !== 'undefined') module.exports = api;
  else root.ImageInput = api;
})(globalThis);
