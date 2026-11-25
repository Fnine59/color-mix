const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const site = path.join(__dirname, '../site');
test('production page: picker is wired, all image entrances present, no compute button or algorithm jargon', () => {
  const html = fs.readFileSync(path.join(site,'index.html'),'utf8');
  const app = fs.readFileSync(path.join(site,'app.js'),'utf8');
  assert.match(html, /type="file" accept="image\/\*"/);
  assert.doesNotMatch(html, /\bcapture[=>\s]/);
  assert.match(app, /photo-file'\)\.click/);
  for (const event of ['change','drop','paste','pointerup']) assert.ok(app.includes(`'${event}'`));
  assert.doesNotMatch(html.split('<body>')[1], /spectral|Kubelka|KM|RGB 平均|找配方按钮|id="recommend"/i);
  assert.match(html, /<details id="settings">/);
  assert.doesNotMatch(html, /<details id="settings" open/);
  for (const script of [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(v=>v[1]))
    assert.ok(fs.existsSync(path.join(site,script)));
});
test('runtime requests and references are local only; vendored source has MIT license', () => {
  const app = fs.readFileSync(path.join(site,'app.js'),'utf8');
  const html = fs.readFileSync(path.join(site,'index.html'),'utf8');
  assert.doesNotMatch(app, /https?:\/\/|XMLHttpRequest|WebSocket|sendBeacon/);
  assert.deepEqual([...app.matchAll(/fetch\('([^']+)'/g)].map(v=>v[1]).sort(), ['./data/kuelox.json','./example.png']);
  assert.doesNotMatch(html, /(?:href|src)=["'](?:https?:)?\/\//);
  assert.match(html, /connect-src 'self'/);
  for (const name of ['owned-colors.js', 'white-balance.js', 'image-input.js', 'worker.js', 'recipe.js', 'palette.js', 'wax-paper.js', 'wax-render.js', 'soft-smudge.js', 'paper-studio.js', 'paper-worker.js', 'paper-engine.js', 'paper-pipeline.js', 'pick-loupe.js', 'photo-view.js', 'palette-ui.js']) {
    const source = fs.readFileSync(path.join(site, name), 'utf8');
    assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//);
  }
  const vendor = fs.readFileSync(path.join(site,'vendor/spectral.js'),'utf8');
  assert.doesNotMatch(vendor, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
  assert.match(fs.readFileSync(path.join(site,'vendor/LICENSE-spectral.txt'),'utf8'), /MIT License.*Copyright.*Ronald van Wijnen/s);
});
test('scope naming and step order are clear; paper uses responsive non-scrolling Pointer Events', () => {
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(site, 'palette-ui.js'), 'utf8');
  const css = fs.readFileSync(path.join(site, 'style.css'), 'utf8');
  assert.match(html, /软硬档次<select/); assert.match(html, /每档都有 6、7、8 三个色系/);
  assert.match(html, /id="tool-smudge"/); assert.match(html, /id="tool-paper-knife"/);
  assert.doesNotMatch(html, /id="brush-mode"/);
  assert.match(html, /id="tool-paper-knife"[^>]*>刮刀<\/button>/);
  assert.match(html, /③ 拿配方在白纸上试一块/);
  for (const name of fs.readdirSync(site).filter(name => /\.(?:html|js|css)$/.test(name)))
    assert.doesNotMatch(fs.readFileSync(path.join(site, name), 'utf8'), new RegExp(['调色' + '盘', '挤' + '色', '放到' + '调色' + '盘', '刮' + '白纸', 'mixing-' + 'canvas', 'tool-' + 'squeeze', 'tool-' + 'knife', 'recipe-to-' + 'palette'].join('|')), name);
  assert.match(css, /grid-template-columns:190px minmax\(0,1fr\);/);
  assert.match(html, /id="paper-pressure"/); assert.match(html, /id="paper-size"/);
  assert.match(html, /③吸管只取白纸上的颜色/);
  assert.ok(html.indexOf('id="photo-title"') < html.indexOf('id="results-title"'));
  assert.ok(html.indexOf('id="results-title"') < html.indexOf('id="palette-title"'));
  for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) assert.ok(ui.includes(`'${event}'`));
  assert.match(ui, /pointerType === 'pen'.*pressure/);
  assert.match(css, /\.paint-workspace canvas\{[^}]*touch-action:none/);
  assert.match(css, /@media\(max-width:800px\).*paint-workspace\{grid-template-columns:1fr/s);
});

test('photo tools and loupe are independent, bounded and offline; paper API cannot control photo mode', () => {
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(site, 'app.js'), 'utf8');
  const ui = fs.readFileSync(path.join(site, 'palette-ui.js'), 'utf8');
  const css = fs.readFileSync(path.join(site, 'style.css'), 'utf8');
  const photo = html.slice(html.indexOf('id="photo-title"'), html.indexOf('id="results-title"'));
  for (const id of ['photo-pick', 'photo-average', 'photo-zoom-in', 'photo-zoom-out', 'photo-zoom-reset', 'photo-pan'])
    assert.match(photo, new RegExp(`id="${id}"`));
  assert.match(photo, /id="photo-pick"[^>]*aria-pressed="true"/);
  assert.match(photo, /id="photo-average"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(app, /paintUI\.(?:isPicking|takeColor|preview|hideLoupe)|onToolChange/);
  assert.match(ui, /return \{updateColors, usePaint\}/);
  assert.match(html, /id="photo-loupe-canvas" width="11" height="11"/);
  assert.match(css, /#photo\{[^}]*touch-action:none/);
  assert.match(css, /\.image-stage\{touch-action:none/);
  assert.match(fs.readFileSync(path.join(site,'photo-view.js'),'utf8'), /clamp\(next, 1, 5\)/);
  assert.doesNotMatch(app, /addEventListener\('wheel'/);
});
