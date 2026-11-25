// Programmatically generated blocks and gradients; no downloaded photograph.
const {createCanvas} = require('@napi-rs/canvas');
const {writeFileSync} = require('node:fs');
const {join} = require('node:path');
const canvas = createCanvas(1200, 560), ctx = canvas.getContext('2d');
ctx.fillStyle = '#f2eee4'; ctx.fillRect(0,0,1200,560);
['#2063AD','#F4EC65','#C97972','#7E9980','#C4B2CF','#FF00FF'].forEach((color, i) => {
  ctx.fillStyle = color; ctx.fillRect(24+i*196,24,172,212);
});
let gradient = ctx.createLinearGradient(24,0,1176,0);
gradient.addColorStop(0,'#2063AD'); gradient.addColorStop(.35,'#75BBC1');
gradient.addColorStop(.65,'#B5C490'); gradient.addColorStop(1,'#F4CE26');
ctx.fillStyle = gradient; ctx.fillRect(24,260,1152,130);
gradient = ctx.createLinearGradient(24,0,1176,0);
gradient.addColorStop(0,'#111111'); gradient.addColorStop(1,'#eeeeee');
ctx.fillStyle = gradient; ctx.fillRect(24,414,1152,122);
writeFileSync(join(__dirname, '../site/example.png'), canvas.toBuffer('image/png'));
