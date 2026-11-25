// sRGB / D65 Lab and CIEDE2000 (Sharma 2005). Self-written research core.
(function(root) {
  // ---------- 基础色彩换算 ----------
  const M_XYZ2RGB = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.969266, 1.8760108, 0.041556],
    [0.0556434, -0.2040259, 1.0572252],
  ];
  const M_RGB2XYZ = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.072175],
    [0.0193339, 0.119192, 0.9503041],
  ];
  const WHITE = [0.95047, 1.0, 1.08883];

  const toLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const toGam = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
  }
  const rgb255ToLin = (rgb) => rgb.map((v) => toLin(v / 255));
  const linToRgb255 = (lin) => lin.map((v) => toGam(clamp01(v)) * 255);

  function mat3(m, v) {
    return [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]);
  }
  function linToLab(lin) {
    const xyz = mat3(M_RGB2XYZ, lin.map(clamp01));
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const fx = f(xyz[0] / WHITE[0]), fy = f(xyz[1] / WHITE[1]), fz = f(xyz[2] / WHITE[2]);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  // CIEDE2000（Sharma 2005 公式）
  function deltaE2000(lab1, lab2) {
    const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
    const rad = Math.PI / 180;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
    const Cb = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const hp = (a, b) => { if (a === 0 && b === 0) return 0; let h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
    const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
    const dLp = L2 - L1, dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
    const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp = h1p + h2p;
    if (C1p * C2p !== 0) {
      if (Math.abs(h1p - h2p) > 180) hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
      else hbp = (h1p + h2p) / 2;
    }
    const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
      + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
    const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
    const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
    const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
    const Rt = -Math.sin(2 * dTheta * rad) * Rc;
    return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
  }


  function averagePixels(data) {
    let sum = [0,0,0], weight = 0;
    for (let i=0; i<data.length; i+=4) {
      // Composite transparent pixels onto white in linear light.
      const alpha = data[i+3]/255;
      for (let c=0;c<3;c++) sum[c] += alpha*toLin(data[i+c]/255)+(1-alpha);
      weight++;
    }
    if (!weight) throw new Error('区域没有像素');
    return linToRgb255(sum.map(v=>v/weight));
  }
  const rgbToLab = rgb => linToLab(rgb255ToLin(rgb));
  const api = {toLin,toGam,clamp01,hexToRgb,rgbToHex,rgb255ToLin,linToRgb255,rgbToLab,deltaE2000,averagePixels};
  if (typeof module !== 'undefined') module.exports=api;
  else root.ColorMath=api;
})(globalThis);
