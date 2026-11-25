// Dedicated classic Worker: static, same-origin, no runtime/build dependencies.
importScripts('./color-math.js', './vendor/spectral.js', './recipe.js',
  './palette.js', './wax-paper.js', './soft-smudge.js', './paper-studio.js', './paper-engine.js');
const engine = new PaperEngine.Engine();
self.onmessage = ({data: {id, commands}}) => {
  try {
    const reply = engine.batch(commands);
    const transfer = reply.patch ? [reply.patch.pixels.buffer, reply.patch.rgb.buffer] : [];
    self.postMessage({id, ...reply}, transfer);
  } catch (error) {
    self.postMessage({id, error: error.message});
  }
};
