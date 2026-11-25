importScripts('./vendor/spectral.js', './color-math.js', './recipe.js');
onmessage = event => {
  const {id, palette, target, options} = event.data;
  try { postMessage({id, result: Recipe.solve(palette, target, options)}); }
  catch (error) { postMessage({id, error: error.message}); }
};
