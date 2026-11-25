const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const I = require('../site/image-input.js');
const M = require('../site/color-math.js');

const adapters = {createCanvas, decode: async file => loadImage(Buffer.from(await file.arrayBuffer()))};
for (const [format, type, extension] of [['png','image/png','png'], ['jpeg','image/jpeg','jpg'], ['webp','image/webp','webp']]) {
  test(`real ${extension} file -> decode -> canvas pixels -> point / region color`, async () => {
    const source = createCanvas(32, 16), ctx = source.getContext('2d');
    ctx.fillStyle = '#2063ad'; ctx.fillRect(0, 0, 32, 16);
    const buffer = format === 'webp' ? source.toBuffer('image/webp') : source.toBuffer(type);
    const file = new File([buffer], `fixture.${extension}`, {type});
    const loaded = await I.loadFile(file, adapters);
    assert.deepEqual(loaded.size, {width:32, height:16});
    const point = loaded.canvas.getContext('2d').getImageData(12, 8, 1, 1);
    const color = M.averagePixels(point.data);
    assert.ok(M.deltaE2000(M.rgbToLab(color), M.rgbToLab([32,99,173])) < 1);
    assert.ok(M.deltaE2000(M.rgbToLab(M.averagePixels(loaded.pixels.data)), M.rgbToLab([32,99,173])) < 1);
  });
}
test('4000-pixel image reduced before pixel extraction', async () => {
  const source = createCanvas(4000, 2000), ctx = source.getContext('2d');
  ctx.fillStyle = '#c97972'; ctx.fillRect(0,0,4000,2000);
  const file = new File([source.toBuffer('image/png')], 'big.png', {type:'image/png'});
  const loaded = await I.loadFile(file, adapters);
  assert.deepEqual(loaded.size, {width:1600, height:800});
  assert.equal(loaded.pixels.data.length, 1600*800*4);
  assert.equal(M.rgbToHex(M.averagePixels(loaded.canvas.getContext('2d').getImageData(800,400,1,1).data)), '#c97972');
});
test('HEIC failure, corrupted file, wrong file, oversized image give Chinese reasons', async () => {
  await assert.rejects(I.loadFile(new File(['bad'], 'photo.heic', {type:'image/heic'}), adapters), /HEIC.*JPG/);
  await assert.rejects(I.loadFile(new File(['bad'], 'photo.png', {type:'image/png'}), adapters), /图片解码失败/);
  assert.throws(() => I.validateFile({name:'text.txt',size:10,type:'text/plain'}), /不是图片/);
  assert.throws(() => I.validateFile({name:'huge.png',size:81*1024*1024,type:'image/png'}), /80 MB/);
  assert.throws(() => I.scaledSize(0,20), /尺寸无效/);
});
test('same file extraction supports drop files and paste file items', () => {
  const file = new File(['image'], 'clip.png', {type:'image/png'});
  assert.deepEqual(I.filesFromTransfer({files:[file]}), [file]);
  assert.deepEqual(I.filesFromTransfer({files:[],items:[{kind:'file',getAsFile:()=>file}]}), [file]);
  assert.deepEqual(I.filesFromTransfer({files:[],items:[{kind:'string'}]}), []);
});
test('canvas failure is surfaced and decoded bitmap reclaimed', async () => {
  let closed = false;
  await assert.rejects(I.loadFile({size:10,type:'image/png'}, {
    decode:async()=>({width:10,height:10,close:()=>{closed=true;}}),
    createCanvas:()=>({getContext:()=>null}),
  }), /图片处理失败/);
  assert.ok(closed);
});
