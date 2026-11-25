/* Shared deterministic input geometry for the Node and Ego browser measurements. */
(function (root) {
  const WIDTH = 448, HEIGHT = 274;
  const PAINT_SIZE = 96, PAINT_PRESSURE = .95;
  const properties = {
    one: {codes: ['704', '704', '704'], passes: 1},
    two: {codes: ['704', '845', '845'], passes: 1},
    'two-aligned': {codes: ['704', '845', '704'], passes: 1},
    three: {codes: ['704', '845', '745'], passes: 1},
    repeat: {codes: ['704', '845', '745'], passes: 3},
    cover: {codes: ['704', '845', '745'], passes: 1, exactCover: true}
  };
  const vertices = [[110, 124], [157, 133], [201, 150], [254, 125], [302, 149], [344, 132]];

  function polyline(vertices, moves) {
    const segments = vertices.length - 1;
    if (moves % segments) throw new Error('moves must divide evenly among segments');
    const steps = moves / segments;
    const [x, y] = vertices[0];
    const points = [{x, y}];
    for (let k = 0; k < segments; k++) {
      const [x, y] = vertices[k], [toX, toY] = vertices[k + 1];
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        points.push({x: x + (toX - x) * t, y: y + (toY - y) * t});
      }
    }
    return points;
  }

  function paintStrokes(name) {
    const {codes, exactCover} = properties[name];
    const rows = exactCover ? [137, 137, 137] : [113, 137, 160];
    return codes.map((code, k) => ({code, points: polyline([[92, rows[k]], [356, rows[k]]], 32)}));
  }

  function smudgeStrokes(name, moves = 100) {
    const offset = [0, 12, -10];
    return Array.from({length: properties[name].passes}, (_, k) => {
      const path = vertices.map(([x, y]) => [x, y + offset[k]]);
      if (k % 2) path.reverse();
      return polyline(path, moves);
    });
  }

  function radius(size, pressure, tool) {
    return WIDTH * size / 1370 * (.46 + pressure * .72) * (tool === 'brush' ? 1 : 1.55);
  }

  function statistics(values) {
    if (!values.length) return {n: 0, sum: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0};
    const sorted = values.slice().sort((a, b) => a - b);
    const quantile = q => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
    const sum = values.reduce((n, v) => n + v, 0);
    return {n: values.length, sum, mean: sum / values.length, p50: quantile(.50),
      p95: quantile(.95), p99: quantile(.99), max: sorted.at(-1)};
  }

  function cacheSizes(pigments) {
    return {
      displayMix: pigments.mixtures.size, displayPair: pigments.pairs.size,
      transportMix: pigments.transport.mixtures.size, transportPair: pigments.transport.pairs.size
    };
  }

  const api = {WIDTH, HEIGHT, PAINT_SIZE, PAINT_PRESSURE, paintStrokes, smudgeStrokes, radius, statistics, cacheSizes};
  if (typeof module !== 'undefined') module.exports = api;
  else root.SmudgeWorkload = api;
})(globalThis);
