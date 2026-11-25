// Offline same-host baseline/after measurement. No package/network updates.
const path = require('node:path'), Module = require('node:module');
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const workload = require('./smudge-workload.js');
function baseline() {
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name).exports;
    const module = new Module(name); modules.set(name, module);
    const source = fs.readFileSync(path.join(__dirname, '../tests/fixtures/baseline-ee17154', name), 'utf8');
    module.require = relative => load(path.posix.normalize(path.posix.join(path.posix.dirname(name), relative)));
    module._compile(source, name); return module.exports;
  }
  return load('paper-studio.js');
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function digest(model, api) {
  const p = model.paper, pixels = new Uint8ClampedArray(p.cells.length * 4);
  for (let i = 0; i < p.cells.length; i++) { p.writeFlat(i, pixels, i * 4); pixels[i * 4 + 3] = 255; }
  return {pixels: sha(pixels), mass: sha(Buffer.concat([Buffer.from(p.bottomMass.buffer), Buffer.from(p.topMass.buffer)])),
    snapshot: sha(JSON.stringify(api.encodePaper(p)))};
}
function run(api, name, repeat = 1) {
  const times = []; let before, after, passes;
  for (let trial = 0; trial < repeat; trial++) {
    const model = new api.Studio();
    function stroke(tool, points, hex, record) {
      model.begin();
      const settings = {tool, radius: workload.radius(96, .95, tool), strength: .95,
        dry: false, strokeId: model.paper.beginStroke(), pigment: hex && model.pigments.color(hex)};
      let last = points[0];
      model.paper.stroke(last, last, {...settings, angle: 0});
      const start = performance.now();
      for (const to of points.slice(1)) {
        model.paper.stroke(last, to, {...settings, angle: Math.atan2(to.y - last.y, to.x - last.x)});
        last = to;
      }
      if (record) times.push(performance.now() - start);
      model.commit();
    }
    const colors = require('../site/data/kuelox.json').colors;
    for (const paint of workload.paintStrokes(name))
      stroke('brush', paint.points, colors.find(c => c.code === paint.code).hex);
    before = digest(model, api); passes = [];
    for (const points of workload.smudgeStrokes(name)) {
      stroke('smudge', points, null, true); passes.push(digest(model, api));
    }
    after = digest(model, api);
  }
  const perTrial = Array.from({length: repeat}, (_, n) => times.slice(n * passes.length, (n + 1) * passes.length).reduce((a, b) => a + b, 0));
  return {before, after, passes, cpuMs: workload.statistics(perTrial)};
}
if (require.main === module) {
  const old = baseline(), current = require('../site/paper-studio.js');
  const results = {baselineRevision: 'ee17154', repeats: 3, cases: {}};
  for (const name of ['three', 'cover', 'repeat']) {
    const before = run(old, name, 3), after = run(current, name, 3);
    results.cases[name] = {before, after, reduction: 1 - after.cpuMs.p50 / before.cpuMs.p50,
      identical: JSON.stringify(before.passes) === JSON.stringify(after.passes) && JSON.stringify(before.before) === JSON.stringify(after.before)};
    if (!results.cases[name].identical) throw new Error(name + ' differs from baseline');
  }
  console.log(JSON.stringify(results, null, 2));
}
module.exports = {baseline, digest, run};
