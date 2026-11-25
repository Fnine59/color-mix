// Bounded beam search; all evaluated candidates ranked with CIEDE2000.
(function (root) {
  const S = typeof module !== 'undefined' ? require('./vendor/spectral.js') : root.spectral;
  const M = typeof module !== 'undefined' ? require('./color-math.js') : root.ColorMath;
  const UNREACHABLE_DE = 5;
  const EXTRA_STICK_DE = 3;
  const description = de => de < 1 ? '几乎看不出' : de < 3 ? '细看有差' : '明显不同';
  const byDifference = (a, b) => a.de - b.de || a.indices.length - b.indices.length || a.key.localeCompare(b.key);
  // A camera/light difference of a few ΔE units is not worth an extra stick.
  // Each additional stick must reduce ΔE by at least 3 (two extra sticks: 6).
  const byRecommendation = (a, b) =>
    (a.de + EXTRA_STICK_DE * a.indices.length) - (b.de + EXTRA_STICK_DE * b.indices.length)
    || b.indices.length - a.indices.length || byDifference(a, b);
  function selectCandidates(candidates, limit = 3) {
    const sorted = candidates.slice().sort(byDifference), byCount = new Map();
    for (const candidate of sorted)
      if (!byCount.has(candidate.indices.length)) byCount.set(candidate.indices.length, candidate);
    const selected = [...byCount.values()].sort(byRecommendation).slice(0, limit);
    for (const candidate of sorted) {
      if (selected.length >= limit) break;
      if (!selected.includes(candidate)) selected.push(candidate);
    }
    return selected;
  }
  const clamp = v => Math.min(255, Math.max(0, v));
  function validateRgb(rgb) {
    if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some(v => !Number.isFinite(v) || v < 0 || v > 255))
      throw new Error('目标色必须是有效的 RGB');
  }
  function prepare(palette) {
    return palette.map(p => {
      const rgb = p.rgb || M.hexToRgb(p.hex);
      validateRgb(rgb);
      const color = new S.Color(rgb);
      return {...p, rgb, color, ks: color.KS, luminance: color.luminance};
    });
  }
  // Derive the library's exact reflectance -> linear RGB matrix once.
  const T = Array.from({length: 3}, () => new Float64Array(38));
  for (let i = 0; i < 38; i++) {
    const basis = new Array(38).fill(0); basis[i] = 1;
    const linear = new S.Color(basis).lRGB;
    for (let c = 0; c < 3; c++) T[c][i] = linear[c];
  }
  function fastMix(paints, parts) {
    const weights = parts.map((part, j) => part * part * paints[j].luminance);
    const sum = weights.reduce((a, b) => a + b, 0);
    const w = weights.map(v => v / sum);
    let red = 0, green = 0, blue = 0;
    for (let i = 0; i < 38; i++) {
      let k = 0;
      for (let j = 0; j < paints.length; j++) k += w[j] * paints[j].ks[i];
      const r = 1 + k - Math.sqrt(k * k + 2 * k);
      red += T[0][i] * r; green += T[1][i] * r; blue += T[2][i] * r;
    }
    return [red, green, blue].map(v => clamp(Math.round(M.toGam(v) * 255)));
  }
  function mix(paints, parts) {
    if (paints.length !== parts.length || !parts.length || parts.some(v => !(v > 0)))
      throw new Error('配方比例必须大于零');
    const prepared = prepare(paints);
    if (prepared.length === 1) return prepared[0].rgb.slice();
    return S.mix(...prepared.map((p, i) => [p.color, parts[i]])).sRGB.map(clamp);
  }
  // Opaque patches: first stick is a full base; each subsequent stick covers
  // part/(accumulated parts) of that base. Weighted reflectance, NOT KM.
  function layer(paints, parts) {
    const prepared = prepare(paints);
    let accumulated = parts[0], reflectance = prepared[0].color.R.slice();
    for (let i = 1; i < prepared.length; i++) {
      const coverage = parts[i] / (accumulated + parts[i]);
      reflectance = reflectance.map((r, k) => (1 - coverage) * r + coverage * prepared[i].color.R[k]);
      accumulated += parts[i];
    }
    return new S.Color(reflectance).sRGB.map(clamp);
  }
  function solve(palette, target, options = {}) {
    validateRgb(target);
    const started = performance.now(), paints = prepare(palette), n = paints.length;
    const lab = M.rgbToLab(target), combinations = new Map();
    const maxPaints = options.maxPaints ?? 3;
    if (![1, 2, 3].includes(maxPaints)) throw new Error('最多支持三支');
    let evaluations = 0;
    const rank = byDifference;
    function consider(indices, parts) {
      if (parts.some(v => !Number.isInteger(v))) {
        const total = parts.reduce((a, b) => a + b, 0);
        parts = parts.map(v => Math.max(1, Math.round(v / total * 20)));
      }
      const ordered = indices.map((i, j) => [i, parts[j]]).sort((a, b) => a[0] - b[0]);
      indices = ordered.map(v => v[0]); parts = ordered.map(v => v[1]);
      const key = indices.join(',');
      const rgb = indices.length === 1 ? paints[indices[0]].rgb : fastMix(indices.map(i => paints[i]), parts);
      const de = M.deltaE2000(lab, M.rgbToLab(rgb));
      evaluations++;
      const previous = combinations.get(key);
      if (!previous || de < previous.de) combinations.set(key, {key, indices, parts, rgb, de});
    }
    for (let i = 0; i < n; i++) consider([i], [1]);
    if (maxPaints >= 2) {
      // All pairs, 10% grid, including 3:7. No RGB-based shortlist of sticks.
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++)
        for (let i = 1; i < 10; i++) consider([a, b], [i, 10 - i]);
      const pairs = [...combinations.values()].filter(v => v.indices.length === 2).sort(rank);
      // Refine the top 16 pairs at 5% granularity.
      for (const pair of pairs.slice(0, 16))
        for (let i = 1; i < 20; i++) consider(pair.indices, [i, 20 - i]);
      if (maxPaints >= 3) {
        // Keep the best 32 pair paths and try EVERY third stick at 20% steps.
        for (const pair of pairs.slice(0, 32)) {
          for (let c = 0; c < n; c++) {
            if (pair.indices.includes(c)) continue;
            for (let share = 1; share < 5; share++) {
              const total = pair.parts[0] + pair.parts[1];
              consider([...pair.indices, c], [...pair.parts.map(v => v / total * (5 - share)), share]);
            }
          }
        }
        const triples = [...combinations.values()].filter(v => v.indices.length === 3).sort(rank).slice(0, 16);
        // Full simplex on promising triples, positive integer shares / 20.
        for (const triple of triples)
          for (let a = 1; a < 19; a++) for (let b = 1; a + b < 20; b++)
            consider(triple.indices, [a, b, 20 - a - b]);
      }
    }
    const best = selectCandidates([...combinations.values()]);
    const recipes = best.map(candidate => {
      const selected = candidate.indices.map(i => paints[i]);
      let parts = candidate.parts;
      const gcd = (a, b) => b ? gcd(b, a % b) : a;
      const divisor = parts.reduce(gcd);
      parts = parts.map(v => v / divisor);
      const rubbed = mix(selected, parts), layered = layer(selected, parts);
      const de = M.deltaE2000(lab, M.rgbToLab(rubbed));
      const layerDe = M.deltaE2000(lab, M.rgbToLab(layered));
      return {
        paints: selected.map(p => ({code: p.code, nameZh: p.nameZh, hex: p.hex, materialType: p.materialType})),
        parts, rubbed, layered, de, layerDe,
        description: description(de), layerDescription: description(layerDe),
      };
    });
    return {
      // Reachability is about the closest candidate, not the simplicity-first card.
      recipes, unreachable: !!recipes.length && Math.min(...recipes.map(v => v.de)) > UNREACHABLE_DE,
      threshold: UNREACHABLE_DE,
      stats: {paletteSize: n, maxPaints, evaluations, elapsedMs: performance.now() - started, search: '全双色 + 32 路三色束搜索，非全局最优保证'},
    };
  }
  const api = {solve, mix, layer, prepare, fastMix, description, selectCandidates, EXTRA_STICK_DE, UNREACHABLE_DE};
  if (typeof module !== 'undefined') module.exports = api;
  else root.Recipe = api;
})(globalThis);
