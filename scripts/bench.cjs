const {solve} = require('../site/recipe.js');
const {colors} = require('../site/data/kuelox.json');
const targets = [[110,130,85], [255,0,255], [120,160,190], [212,128,95], [73,65,87]];
for (const target of targets) {
  const result = solve(colors, target, {maxPaints:3});
  console.log(JSON.stringify({target, ...result.stats, bestDE:result.recipes[0].de}));
}
