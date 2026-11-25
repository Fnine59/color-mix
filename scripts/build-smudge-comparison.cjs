// Compose/crop only the two Ego screenshot files; do not simulate or edit colors.
const fs = require('node:fs'), path = require('node:path');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
(async () => {
  const dir = path.resolve(__dirname, '../evidence/soft-smudge-261122');
  const images = await Promise.all(['adjacent-r4.jpg', 'adjacent-formal.jpg'].map(name => loadImage(path.join(dir, name))));
  if (images.some(image => image.width !== 448 || image.height !== 390)) throw Error('unexpected Ego screenshot size');
  for (const [name, top, height] of [
    ['adjacent-comparison.png', 0, 390],
    ['whole-comparison.png', 30, 274],
    ['boundary-comparison.png', 310, 80],
  ]) {
    const canvas = createCanvas(904, height), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    images.forEach((image, i) => ctx.drawImage(image, 0, top, 448, height, i * 456, 0, 448, height));
    fs.writeFileSync(path.join(dir, name), canvas.toBuffer('image/png'));
    console.log(name, `${canvas.width}x${canvas.height}`, 'left: r4; right: formal');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
