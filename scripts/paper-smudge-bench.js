/* Ego page-side benchmark; run AFTER paper-smudge-evidence.js. Not site code.
 * r4-browser.js's cumulative-counter / first-and-closing-rAF measurement.
 * No heartbeat, animation, timer loop, forced frame or hidden-tab override. */
(async () => {
  if (!window.smudgeEvidence?.helpers?.metrics) {
    throw Error('未启用性能指标：两版页面都须带 ?check=1，重新运行 paper-smudge-evidence.js 后再跑快推；画布未清空。');
  }
  const {tool, ink, size, event, clear, raf, metrics: m} = smudgeEvidence.helpers;
  document.getElementById('smudge-evidence-board')?.remove();
  clear(); tool('brush'); size(96); ink('745');
  // Recipe results above the paper expand the formal page. A merely "visible"
  // document can still have the canvas outside the viewport and be throttled.
  const canvas = document.getElementById('paper-canvas') || document.getElementById('paper-flat');
  canvas.scrollIntoView({block: 'center'});
  for (const y of [.23, .5, .77]) {
    event('pointerdown', .18, y, .95);
    for (let k = 1; k <= 32; k++) event('pointermove', .18 + .22 * k / 32, y, .95);
    event('pointerup', .4, y, .95); await raf(); await raf();
  }
  tool('smudge');
  for (const animation of document.getAnimations()) animation.cancel();
  const frames = [], simulationFrames = [], drawFrames = [], inputs = [], draws = [];
  let si = m.simulationCount, di = m.drawCount;
  function collect(key, from, into) {
    const delta = m[key + 'Count'] - from;
    if (!Number.isSafeInteger(delta) || delta < 0 || delta > m[key].length) throw Error('metrics overflow/reset');
    const samples = delta ? m[key].slice(-delta) : [];
    into.push(...samples); return samples.reduce((a, b) => a + b, 0);
  }
  const start = performance.now(); let previous = start;
  event('pointerdown', .15, .5, .95);
  while (true) {
    const now = await raf(), current = performance.now();
    frames.push(current - previous); previous = current;
    simulationFrames.push(collect('simulation', si, inputs)); si = m.simulationCount;
    drawFrames.push(collect('draw', di, draws)); di = m.drawCount;
    if (current - start >= 3000) break;
    for (let j = 0; j < 6; j++) {
      const t = (now - start + j * 2.5) / 1000;
      event('pointermove', .5 + Math.sin(t * 19) * .35, .5 + Math.cos(t * 13) * .27, .95);
    }
  }
  event('pointerup', .5, .5); await raf(); await raf();
  collect('simulation', si, inputs); collect('draw', di, draws);
  const summary = xs => ({n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length, max: Math.max(...xs)});
  window.smudgePerf = {version: smudgeEvidence.version, elapsed: previous - start,
    raf: summary(frames), simulationPerFrame: summary(simulationFrames), drawPerFrame: summary(drawFrames),
    simulationPerInput: summary(inputs), frames, simulationFrames, drawFrames, simulationInputs: inputs, draws,
    visibility: document.visibilityState, focus: document.hasFocus(),
    canvasRect: canvas.getBoundingClientRect().toJSON(), viewport: [innerWidth, innerHeight]};
  return smudgePerf;
})()
