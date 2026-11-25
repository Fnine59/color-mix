(() => {
  const $ = id => document.getElementById(id), M = ColorMath, I = ImageInput, O = OwnedColors, W = WhiteBalance;
  const canvas = $('photo'), stage = $('image-stage'), selector = $('selection');
  const storeKey = 'kuelox-owned-v1';
  let data, target, owned = new Set(), imageReady = false, uploadId = 0;
  let worker, activeId = 0, pointer, benchmarkBusy = false;
  let originalPixels, correction = null, referenceMode = false, targetRegion = null;
  const requests = new Map();
  let shownRecipes = [];
  const photoLoupe = PickLoupe.mount({prefix: 'photo', swatch: 'target-swatch'});
  let photoMode = 'pick', panMode = false, pinch;
  const contacts = new Map();
  const view = PhotoView.mount(canvas, stage, ({zoom}) => {
    $('photo-zoom-value').textContent = `${Math.round(zoom * 100)}%`;
    $('photo-zoom-out').disabled = zoom <= 1; $('photo-zoom-in').disabled = zoom >= 5;
    $('photo-pan').disabled = zoom <= 1;
    if (zoom <= 1) panMode = false;
    $('photo-pan').setAttribute('aria-pressed', String(panMode));
    canvas.style.cursor = panMode ? 'grab' : 'crosshair';
  });
  const paintUI = PaletteUI.mount({onTarget: (rgb, source) => {
    targetRegion = null; setTarget(rgb, `已从${source}吸色`);
    $('results-title').scrollIntoView?.({behavior: 'smooth', block: 'start'});
  }});
  $('results').addEventListener('click', event => {
    const stick = event.target.closest?.('[data-paint-recipe]');
    if (stick) {
      const recipe = shownRecipes[Number(stick.dataset.paintRecipe)];
      const paint = recipe?.paints[Number(stick.dataset.paintIndex)];
      if (paint) paintUI.usePaint(paint, recipe);
      return;
    }
  });
  $('view-recipes').onclick = () => $('results-title').scrollIntoView?.({behavior: 'auto', block: 'start'});
  if (new URLSearchParams(location.search).get('preview') === 'phone') document.body.classList.add('phone-preview');
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const colorHex = rgb => M.rgbToHex(rgb).toUpperCase();
  function status(text, className = '') { $('result-status').textContent = text; $('result-status').className = className; }
  function photoError(text) { $('photo-error').textContent = text; }
  function ensureWorker() {
    if (worker) return;
    worker = new Worker('./worker.js');
    worker.onmessage = event => {
      const {id, result, error} = event.data, request = requests.get(id);
      if (!request) return;
      clearTimeout(request.timer); requests.delete(id);
      error ? request.reject(new Error(error)) : request.resolve(result);
    };
    worker.onerror = () => {
      for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('推荐计算没有启动成功，请刷新后重试')); }
      requests.clear(); worker.terminate(); worker = null;
    };
  }
  function runSolver(palette, rgb) {
    ensureWorker();
    const id = ++activeId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (requests.has(id)) {
          for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('推荐耗时过长，请刷新后重试或在设置里减少颜色')); }
          requests.clear(); worker?.terminate(); worker = null;
        }
      }, 15000);
      requests.set(id, {resolve, reject, timer});
      worker.postMessage({id, palette, target: rgb, options: {maxPaints: 3}});
    });
  }
  let generation = 0;
  function cancelSolver() {
    generation++;
    if (!benchmarkBusy && requests.size) {
      worker?.terminate(); worker = null;
      for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('已改选颜色')); }
      requests.clear();
    }
  }
  function eligible() {
    return data ? O.inProduct(data.colors, $('product').value).filter(p =>
      !$('only-owned').checked || owned.has(p.code)) : [];
  }
  function save() {
    try { localStorage.setItem(storeKey, JSON.stringify({codes: [...owned], onlyOwned: $('only-owned').checked})); }
    catch { $('storage-warning').textContent = '浏览器不允许保存设置；本次能用，关闭页面后勾选会丢失'; }
  }
  function updateScope() {
    const count = eligible().length;
    $('owned-count').textContent = `已勾选 ${owned.size} 支 · 只保存在此浏览器`;
    $('scope-status').textContent = `现在会从 ${count} 支油画棒里找配方`;
    $('scope-summary').textContent = $('only-owned').checked ? `我有的 ${count} 色` : `可用 ${count} 色`;
    prefixGroups();
    paintUI.updateColors(eligible());
  }
  function prefixGroups() {
    if (!data) return;
    const states = {all: '全勾', partial: '部分勾', none: '未勾'};
    // Group buttons ignore the search filter; restore focus after toggling.
    const groups = O.groups(data.colors, $('product').value, owned);
    $('prefix-groups').replaceChildren(...groups.map(group => {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.prefix = group.prefix;
      button.dataset.state = group.state;
      button.setAttribute('aria-pressed', group.state === 'partial' ? 'mixed' : String(group.state === 'all'));
      button.textContent = `${O.groupLabel(group)} · ${states[group.state]}`;
      button.onclick = () => {
        const wasFocused = document.activeElement === button;
        const result = O.toggleGroup(owned, group.codes);
        owned = result.owned;
        if (result.select) $('only-owned').checked = true;
        save(); updateScope(); paletteList(); recommend();
        if (wasFocused) [...$('prefix-groups').children].find(b => b.dataset.prefix === group.prefix)?.focus();
      };
      return button;
    }));
  }
  function paletteList() {
    const query = $('color-search').value.trim().toLowerCase();
    const visible = O.inProduct(data.colors, $('product').value).filter(p =>
      `${p.code} ${p.nameZh} ${p.nameEn}`.toLowerCase().includes(query));
    $('palette-list').innerHTML = visible.map(p => `<label class="color-option"><input type="checkbox" value="${p.code}" ${owned.has(p.code) ? 'checked' : ''}><span class="mini-swatch" style="background:${p.hex}"></span><span class="color-name">${escape(p.nameZh)}<small>${p.code} · ${escape(p.nameEn)}</small></span></label>`).join('') || '<p class="hint">没有找到这个颜色</p>';
  }
  $('palette-list').addEventListener('change', event => {
    const {value, checked} = event.target;
    checked ? owned.add(value) : owned.delete(value);
    if (checked) $('only-owned').checked = true;
    save(); updateScope(); recommend();
  });
  $('product').addEventListener('change', () => { updateScope(); paletteList(); recommend(); });
  $('only-owned').addEventListener('change', () => { save(); updateScope(); recommend(); });
  $('color-search').addEventListener('input', () => { if (data) paletteList(); });
  $('clear-owned').onclick = () => { owned.clear(); save(); updateScope(); paletteList(); recommend(); };

  function renderRecipes(result, rgb) {
    shownRecipes = result.recipes;
    $('results').innerHTML = result.recipes.map((recipe, index) => {
      const total = recipe.parts.reduce((a, b) => a + b, 0);
      let accumulated = recipe.parts[0];
      const covers = recipe.paints.slice(1).map((paint, i) => {
        const share = recipe.parts[i + 1] / (accumulated + recipe.parts[i + 1]);
        accumulated += recipe.parts[i + 1];
        return `${paint.code} ${escape(paint.nameZh)} 盖住已有颜色约 ${Math.round(share * 100)}%`;
      });
      const prediction = (title, color, phrase, de) => `<div class="prediction"><div class="swatch" style="background:${colorHex(color)}"></div><strong>${title}</strong><small class="difference">${phrase || '你选的颜色'}</small>${de == null ? '' : `<small class="numeric">ΔE00 ${de.toFixed(2)}</small>`}<code>${colorHex(color)}</code></div>`;
      const heading = index ? `方案 ${index + 1}` : `${recipe.paints.length === 1 ? '先试单支' : '优先试这个'} · ${recipe.description}`;
      return `<article class="recipe"><div class="recipe-rank"><strong>${escape(heading)}</strong><span>用 ${recipe.paints.length} 支</span></div>
        <div class="sticks">${recipe.paints.map((p, j) => `<div class="stick"><span class="mini-swatch" style="background:${p.hex}"></span><strong>${p.code} ${escape(p.nameZh)}</strong><b>${recipe.parts[j]} 份</b><button type="button" class="stick-to-brush" data-paint-recipe="${index}" data-paint-index="${j}" aria-label="拿 ${p.code} ${escape(p.nameZh)} 来画">拿来画</button></div>`).join('')}</div>
        <div class="predictions">${prediction('目标色', rgb)}${prediction('揉匀后（预测）', recipe.rubbed, recipe.description, recipe.de)}${prediction('叠涂后（预测）', recipe.layered, recipe.layerDescription, recipe.layerDe)}</div>
        <div class="layer-guide"><p><strong>揉匀：</strong>几支在纸上揉开混匀。</p><p><strong>叠涂：</strong>一层盖一层，下层从缝里露出来。</p><p>${escape(recipe.paints[0].code)} ${escape(recipe.paints[0].nameZh)} 先铺满${covers.length ? '；' + covers.join('；') : '，这里只有一支颜色'}。</p><small>各份约占 ${recipe.parts.map(v => Math.round(v / total * 100) + '%').join(' : ')}；按同样大小的刮屑或面积估计。</small></div>
        </article>`;
    }).join('');
  }
  async function recommend() {
    if (!target || !data || benchmarkBusy) return;
    cancelSolver();
    const current = generation, rgb = target.slice(), palette = eligible();
    $('results').innerHTML = ''; $('timing').textContent = '';
    if (!palette.length) { status('现在没有可用颜色。打开“设置”勾选你有的颜色，或取消“只用我有的颜色推荐”。', 'failure'); return; }
    status('正在找最接近的配方…');
    const start = performance.now();
    try {
      const result = await runSolver(palette, rgb);
      if (current !== generation) return;
      renderRecipes(result, rgb);
      $('timing').textContent = `${palette.length} 色 · ${(performance.now() - start).toFixed(0)} 毫秒`;
      status(result.unreachable
        ? '这个颜色目前调不出来。下面给你最接近的配方，但会明显不同；这是当前预测和搜索的结论，仍可试涂。'
        : '试试下面的配方。先看“揉匀后”，再用真油画棒试一小块。', result.unreachable ? 'warning' : '');
    } catch (error) { if (current === generation) status(error.message, 'failure'); }
  }
  function setTarget(rgb, message) {
    target = rgb.map(v => Math.max(0, Math.min(255, v)));
    $('target-row').hidden = false; $('target-swatch').style.background = colorHex(target);
    $('target-hex').textContent = colorHex(target); $('target-rgb').textContent = `RGB ${target.map(Math.round).join(', ')}`;
    $('pick-info').textContent = message + ' · 已自动找配方。';
    photoError(''); recommend();
  }
  function clearTarget() {
    cancelSolver(); target = null; targetRegion = null; $('target-row').hidden = true;
    $('results').innerHTML = ''; $('timing').textContent = '';
    status('点照片里的一个颜色，配方会自动出现在这里。');
  }
  async function openFile(file, label = '照片') {
    const current = ++uploadId; photoError(''); imageReady = false; pointer = null;
    cancelPhoto(); contacts.clear(); pinch = null;
    originalPixels = null; correction = null; referenceMode = false; updateWhiteBalance();
    keyboardPoint = null; keyboardStart = null;
    selector.hidden = true; clearTarget(); $('pick-info').textContent = '正在读取图片，请稍等…';
    try {
      const loaded = await I.loadFile(file, {
        decode: I.browserDecode,
        createCanvas: (width, height) => { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; },
      });
      if (current !== uploadId) return;
      canvas.width = loaded.size.width; canvas.height = loaded.size.height;
      stage.style.minHeight = '0';
      canvas.getContext('2d', {willReadFrequently: true}).putImageData(loaded.pixels, 0, 0);
      originalPixels = loaded.pixels;
      $('empty-image').hidden = true; canvas.hidden = false; imageReady = true;
      view.reset(); updateWhiteBalance();
      $('image-info').textContent = `${label} · ${loaded.original.width} × ${loaded.original.height}${loaded.size.width !== loaded.original.width ? '（已缩小）' : ''}`;
      photoHint();
    } catch (error) {
      if (current !== uploadId) return;
      canvas.hidden = true; $('empty-image').hidden = false;
      $('image-info').textContent = ''; $('pick-info').textContent = '图片没有读入，请按下面的提示换图再试。';
      photoError(error.message);
    }
  }
  $('upload').onclick = () => { $('photo-file').click(); };
  $('photo-file').addEventListener('change', event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (file) openFile(file);
    else photoError('没有选到图片，请重新选择');
  });
  $('example').onclick = async () => {
    try {
      const response = await fetch('./example.png');
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      await openFile(new File([blob], 'example.png', {type: 'image/png'}), '程序绘制的示例图');
    } catch { photoError('示例图读取失败，请刷新后再试'); }
  };
  document.addEventListener('dragover', event => { event.preventDefault(); stage.classList.add('dragging'); });
  document.addEventListener('dragleave', event => { if (!event.relatedTarget) stage.classList.remove('dragging'); });
  document.addEventListener('drop', event => {
    event.preventDefault(); stage.classList.remove('dragging');
    const files = I.filesFromTransfer(event.dataTransfer);
    files.length ? openFile(files[0]) : photoError('没有收到图片文件，请拖入电脑上的照片文件');
  });
  document.addEventListener('paste', event => {
    const files = I.filesFromTransfer(event.clipboardData);
    if (files.length) { event.preventDefault(); openFile(files[0], '粘贴的图片'); }
    else if (!event.target.matches('input, textarea, [contenteditable]')) photoError('剪贴板里没有图片，请先复制截图，再粘贴到这里');
  });
  function updateWhiteBalance() {
    $('photo-tools').hidden = !imageReady;
    $('white-balance-tools').hidden = !imageReady;
    $('white-balance-pick').textContent = referenceMode ? '取消选参考点' : '校正灯光';
    $('white-balance-pick').setAttribute('aria-pressed', String(referenceMode));
    $('white-balance-reset').hidden = !correction;
    $('white-balance-status').textContent = referenceMode ? '下一次点照片只选参考点，不取色' : correction ? '已按白纸校正' : '';
    if (imageReady) photoHint();
  }
  function photoHint() {
    $('pick-info').textContent = referenceMode ? '按住 / 悬停看放大镜，松手只选白纸参考点，不取目标色。'
      : (correction ? '已按白纸校正。' : '') + (photoMode === 'pick'
        ? '按住移动看放大镜，抬起吸取中心点，自动出配方。'
        : '拖动框选一小块的平均色，松手自动出配方。');
  }
  function redrawPhoto() {
    const pixels = W.apply(originalPixels, correction);
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    const frame = ctx.createImageData(pixels.width, pixels.height);
    frame.data.set(pixels.data); ctx.putImageData(frame, 0, 0);
    if (targetRegion) sampleRegion(targetRegion);
  }
  $('white-balance-pick').onclick = () => {
    if (!imageReady) return;
    cancelPhoto(); panMode = false; view.refresh(); referenceMode = !referenceMode; keyboardStart = null;
    photoLoupe.hide();
    photoError(''); updateWhiteBalance();
  };
  $('white-balance-reset').onclick = () => {
    if (!imageReady) return;
    cancelPhoto(); correction = null; referenceMode = false; updateWhiteBalance(); photoError(''); redrawPhoto();
    photoLoupe.hide();
    if (!targetRegion) photoHint();
  };
  function pickReference(point) {
    try {
      const next = W.referenceAt(originalPixels, point.x, point.y);
      correction = next; referenceMode = false; selector.hidden = true;
      photoError(''); updateWhiteBalance(); redrawPhoto();
      if (!targetRegion) photoHint();
    } catch (error) { photoError(error.message); }
  }
  const canvasPoint = event => PhotoView.point(canvas, event);
  function cancelPhoto() { pointer = null; selector.hidden = true; photoLoupe.hide(); }
  function setPhotoMode(mode) {
    cancelPhoto(); keyboardStart = null; photoMode = mode; panMode = false;
    $('photo-pick').setAttribute('aria-pressed', String(mode === 'pick'));
    $('photo-average').setAttribute('aria-pressed', String(mode === 'average'));
    view.refresh(); if (imageReady) photoHint();
  }
  $('photo-pick').onclick = () => setPhotoMode('pick');
  $('photo-average').onclick = () => setPhotoMode('average');
  for (const [id, delta] of [['photo-zoom-in', .5], ['photo-zoom-out', -.5]]) $(id).onclick = () => {
    cancelPhoto(); keyboardStart = null; view.setZoom(view.snapshot().zoom + delta);
  };
  $('photo-zoom-reset').onclick = () => { cancelPhoto(); keyboardStart = null; pinch = null; view.reset(); };
  $('photo-pan').onclick = () => {
    cancelPhoto(); panMode = !panMode && view.snapshot().zoom > 1; view.refresh();
  };
  globalThis.addEventListener?.('resize', () => { cancelPhoto(); pinch = null; view.refresh(); });
  globalThis.addEventListener?.('scroll', () => photoLoupe.hide(), true);
  globalThis.addEventListener?.('blur', () => { cancelPhoto(); contacts.clear(); pinch = null; });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => {
    if (!imageReady || (event.button != null && ![0, 2].includes(event.button))) return;
    if (event.button === 2 && view.snapshot().zoom <= 1) return;
    event.preventDefault();
    contacts.set(event.pointerId, event);
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Capture may be unavailable in an embedding. */ }
    if (contacts.size >= 2) {
      cancelPhoto(); keyboardStart = null;
      if (contacts.size === 2) pinch = {start: view.snapshot(), from: PhotoView.pair([...contacts.values()])};
      else pinch = null;
      return;
    }
    if (pointer || !PhotoView.contains(canvas, stage, event)) return;
    const panning = view.snapshot().zoom > 1 && (panMode || event.button === 2);
    pointer = {id: event.pointerId, start: canvasPoint(event), dragged: false, panning,
      view: view.snapshot(), picking: referenceMode || photoMode === 'pick'};
    selector.hidden = true;
    if (pointer.picking && !panning) photoLoupe.show(canvas, pointer.start);
  });
  canvas.addEventListener('pointermove', event => {
    if (!imageReady) return;
    if (contacts.has(event.pointerId)) contacts.set(event.pointerId, event);
    if (contacts.size >= 2) {
      event.preventDefault();
      if (pinch && contacts.size === 2) view.pinch(pinch.start, pinch.from, PhotoView.pair([...contacts.values()]));
      return;
    }
    if (!pointer) {
      if (!contacts.size && event.pointerType !== 'touch' && !panMode &&
          (referenceMode || photoMode === 'pick') && PhotoView.contains(canvas, stage, event)) photoLoupe.show(canvas, canvasPoint(event));
      else photoLoupe.hide();
      return;
    }
    if (pointer.id !== event.pointerId) return;
    event.preventDefault();
    if (pointer.panning) {
      view.pan(event.clientX - pointer.start.screenX, event.clientY - pointer.start.screenY, pointer.view); return;
    }
    // Captured pointers outside the visible image cancel, never clamp-pick an edge.
    if (!PhotoView.contains(canvas, stage, event)) { cancelPhoto(); return; }
    const end = canvasPoint(event), start = pointer.start;
    if (pointer.picking) { photoLoupe.show(canvas, end); return; }
    if (Math.hypot(end.screenX - start.screenX, end.screenY - start.screenY) > 5) pointer.dragged = true;
    if (pointer.dragged) showSelection(start, end);
  });
  function showSelection(start, end) {
    const rect = canvas.getBoundingClientRect(), parent = stage.getBoundingClientRect();
    selector.hidden = false;
    selector.style.left = `${rect.left - parent.left - (stage.clientLeft || 0) + Math.min(start.x, end.x) / canvas.width * rect.width}px`;
    selector.style.top = `${rect.top - parent.top - (stage.clientTop || 0) + Math.min(start.y, end.y) / canvas.height * rect.height}px`;
    selector.style.width = `${(Math.abs(end.x - start.x) + 1) / canvas.width * rect.width}px`;
    selector.style.height = `${(Math.abs(end.y - start.y) + 1) / canvas.height * rect.height}px`;
  }
  function sample(start, end, dragged) {
    if (referenceMode) { photoLoupe.confirm(canvas, end); pickReference(end); return; }
    try {
      if (photoMode === 'pick') {
        const rgb = photoLoupe.confirm(canvas, end);
        targetRegion = {x: end.x, y: end.y, width: 1, height: 1, dragged: false};
        setTarget(rgb, `已吸取中心点（${end.x}, ${end.y}）` + (correction ? ' · 已按白纸校正' : ''));
        photoLoupe.animateDrop(colorHex(rgb), PickLoupe.originAt(canvas, end));
        revealRecipeEntry(); return;
      }
      const x = dragged ? Math.min(start.x, end.x) : end.x, y = dragged ? Math.min(start.y, end.y) : end.y;
      const width = dragged ? Math.abs(end.x - start.x) + 1 : 1, height = dragged ? Math.abs(end.y - start.y) + 1 : 1;
      sampleRegion({x, y, width, height, dragged});
    } catch { photoError('这个位置取色失败，请在图片内重试'); }
  }
  function sampleRegion(region) {
    const {x, y, width, height, dragged} = region;
    const pixels = canvas.getContext('2d', {willReadFrequently: true}).getImageData(x, y, width, height);
    const averaged = M.averagePixels(pixels.data);
    const rgb = width === 1 && height === 1 ? averaged.map(Math.round) : averaged;
    targetRegion = region;
    setTarget(rgb,
      (dragged ? `已取 ${width} × ${height} 像素的平均色` : `已取这个点（${x}, ${y}）`) +
      (correction ? ' · 已按白纸校正' : ''));
    revealRecipeEntry();
  }
  function revealRecipeEntry() {
    if (innerWidth <= 800) {
      const entry = $('view-recipes'), rect = entry.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > innerHeight) entry.scrollIntoView?.({behavior: 'auto', block: 'nearest'});
    }
  }
  canvas.addEventListener('pointerup', event => {
    if (!contacts.delete(event.pointerId)) return;
    if (pinch || contacts.size) { pinch = null; cancelPhoto(); return; }
    if (!pointer || pointer.id !== event.pointerId) return;
    const active = pointer; pointer = null;
    if (active.panning) return;
    if (!PhotoView.contains(canvas, stage, event)) { cancelPhoto(); return; }
    const end = canvasPoint(event);
    const dragged = !active.picking && (active.dragged ||
      Math.hypot(end.screenX - active.start.screenX, end.screenY - active.start.screenY) > 5);
    if (dragged) showSelection(active.start, end);
    sample(active.start, end, dragged);
  });
  for (const ending of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(ending, event => {
    const tracked = contacts.delete(event.pointerId);
    if (pointer?.id === event.pointerId || (tracked && pinch)) { pinch = null; cancelPhoto(); }
  });
  canvas.addEventListener('pointerleave', () => { if (!pointer) photoLoupe.hide({boundary: true}); });
  canvas.addEventListener('blur', () => { cancelPhoto(); contacts.clear(); pinch = null; });
  // Accessible alternative to pointer dragging, using the identical sampler.
  let keyboardPoint, keyboardStart;
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', event => {
    if (!imageReady) return;
    keyboardPoint ||= {x: Math.floor(canvas.width / 2), y: Math.floor(canvas.height / 2)};
    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const step = event.shiftKey ? 50 : 10;
      keyboardPoint.x = Math.max(0, Math.min(canvas.width - 1, keyboardPoint.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)));
      keyboardPoint.y = Math.max(0, Math.min(canvas.height - 1, keyboardPoint.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)));
      if (photoMode === 'pick' || referenceMode) { selector.hidden = true; photoLoupe.show(canvas, keyboardPoint); }
      else showSelection(keyboardStart || keyboardPoint, keyboardPoint);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey && !keyboardStart && !referenceMode && photoMode === 'average') { keyboardStart = {...keyboardPoint}; showSelection(keyboardStart, keyboardPoint); }
      else { sample(keyboardStart || keyboardPoint, keyboardPoint, !!keyboardStart); keyboardStart = null; }
    } else if (event.key === 'Escape') {
      cancelPhoto(); keyboardStart = null; referenceMode = false; updateWhiteBalance();
    }
  });

  $('benchmark').onclick = async () => {
    if (!data) { $('bench-output').textContent = '色表还没加载好，请稍后再试'; return; }
    cancelSolver(); benchmarkBusy = true; $('benchmark').disabled = true;
    const lines = [], targets = [[110,130,85],[255,0,255],[120,160,190],[212,128,95],[73,65,87]];
    $('bench-output').textContent = '正在检查…';
    try {
      for (const rgb of targets) {
        const start = performance.now(), result = await runSolver(data.colors, rgb);
        lines.push(`${colorHex(rgb)}：总耗时 ${(performance.now() - start).toFixed(1)} ms；计算 ${result.stats.elapsedMs.toFixed(1)} ms；${result.stats.evaluations} 次；最佳 ΔE00 ${result.recipes[0].de.toFixed(2)}`);
        $('bench-output').replaceChildren(...[`浏览器：${navigator.userAgent}`, '237 色，最多 3 支', ...lines].map(text => {
          const row = document.createElement('p'); row.textContent = text; return row;
        }));
      }
    } catch (error) { $('bench-output').textContent += '\n' + error.message; }
    finally { benchmarkBusy = false; $('benchmark').disabled = false; recommend(); }
  };
  async function init() {
    try {
      const response = await fetch('./data/kuelox.json');
      if (!response.ok) throw new Error();
      data = await response.json();
      try {
        const stored = JSON.parse(localStorage.getItem(storeKey) || '{}');
        if (Array.isArray(stored.codes)) owned = new Set(stored.codes.filter(code => data.colors.some(p => p.code === code)));
        $('only-owned').checked = !!stored.onlyOwned;
      } catch { $('storage-warning').textContent = '上次的本地设置没有读出；本次从全部颜色开始'; }
      for (const product of data.products) {
        const option = document.createElement('option'); option.value = product.id; option.textContent = product.label;
        $('product').append(option);
      }
      paletteList(); updateScope(); if (target) recommend();
    } catch { status('本地色表加载失败，请刷新后重试。请从预览站打开，不要直接双击网页文件。', 'failure'); }
  }
  window.addEventListener('error', () => { photoError('页面发生错误，请刷新后重试；若仍失败请保留此提示反馈'); });
  window.addEventListener('unhandledrejection', event => { photoError('操作失败：' + (event.reason?.message || '请刷新后重试')); });
  init();
})();
