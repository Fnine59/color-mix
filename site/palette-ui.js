(function (root) {
  function mount({onTarget, onToolChange}) {
    const $ = id => document.getElementById(id);
    const model = new PaperStudio.Studio(), surfaces = {paper: $('paper-canvas')};
    let paperRenderer, pipeline;
    const paper = () => pipeline?.view || model.paper;
    const metrics = new URLSearchParams(location.search).get('check') === '1'
      ? (root.PaperMetrics = {simulation: [], draw: [], simulationCount: 0, drawCount: 0}) : null;
    let drawFrame = 0, pageHidden = false;
    for (const canvas of Object.values(surfaces)) {
      canvas.width = model.paper.width; canvas.height = model.paper.height;
      canvas.getContext('2d', {willReadFrequently: true});
    }
    const paperKey = 'kuelox-paper-v2';
    let tool = 'brush', colors = [], chosen, brushColor, picked, active, inkChoice;
    function chooseInk(color) { brushColor = color; inkChoice = {hex: color?.hex}; }
    let shelfRecipe = null;
    let pickActive;
    const loupe = PickLoupe.mount();
    const tell = text => { $('palette-status').textContent = text; };
    function draw(name) {
      if (!name || name === 'paper') {
        if (!paperRenderer || paperRenderer.surface !== paper()) {
          paperRenderer = {...WaxRender.flat(surfaces.paper, paper()), surface: paper()};
        }
        paperRenderer.draw();
      }
      $('palette-undo').disabled = !(pipeline ? pipeline.history || pipeline.busy : model.history.length);
    }
    let reading = false, afterRead = [];
    function ordered(action) { if (reading) afterRead.push(action); else action(); }
    function commitGesture() {
      ordered(() => pipeline.request({type: 'commit'}, snapshot => {
        if (snapshot) save(snapshot);
        if (pipeline.worker) schedulePaper(); else draw();
      }));
    }
    function schedulePaper() {
      if (drawFrame || pageHidden) return;
      drawFrame = root.requestAnimationFrame(() => {
        drawFrame = 0; const began = performance.now(); draw('paper');
        if (metrics) { metrics.draw.push(performance.now() - began); metrics.drawCount++; if (metrics.draw.length > 1000) metrics.draw.shift(); }
      });
    }
    function save(snapshot) {
      try {
        localStorage.setItem(paperKey, snapshot);
        $('palette-storage-warning').textContent = '';
      } catch {
        $('palette-storage-warning').textContent = '白纸本次能用，但浏览器未能保存；刷新后可能丢失（存储被禁用或已满）。';
      }
    }
    function finish() {
      if (!active) return;
      active = null; $('paper-cursor').hidden = true;
      commitGesture();
    }
    function setTool(next) {
      finish(); pickActive = null; loupe.hide(); tool = next;
      if (tool !== 'pick') $('picked-color').hidden = true;
      onToolChange?.();
      for (const name of ['brush', 'smudge', 'paper-knife', 'pick']) $('tool-' + name).setAttribute('aria-pressed', String(name === tool));
      tell({brush: '白纸第 4 版涂法：中 / 重档填满缝隙，第二色盖在上面、不沾色；压感笔按压力，鼠标 / 手指按力度档。',
        smudge: '白纸揉擦：两色挨着或叠着，沿交界来回揉成平滑过渡；重档混得快。短尾连着主体渐薄，不飞色。',
        'paper-knife': '刮刀：在白纸上刮开面层见底层，重复刮见纸。',
        pick: '白纸吸管：鼠标指过去看放大镜；手指或笔按住移动，抬起吸色。取白纸颜料底色（很薄的尾巴取显示色）；可涂纸或找配方。'}[tool]);
    }
    function pickColor(rgb, source, origin, choice) {
      const snapshot = rgb.map(Math.round);
      picked = {rgb: snapshot, hex: ColorMath.rgbToHex(snapshot).toUpperCase(), source};
      choice.hex = picked.hex;
      // A later explicit shelf choice wins, but strokes accepted immediately
      // after this pick keep its deferred token and will use the confirmed RGB.
      if (inkChoice === choice) brushColor = {hex: picked.hex};
      $('picked-swatch').style.background = picked.hex; $('picked-hex').textContent = picked.hex;
      $('picked-color').hidden = false; $('pick-recipe').disabled = false; selection();
      loupe.animateDrop(picked.hex, origin);
      tell(`已吸取${source}上的 ${picked.hex}；切换油画棒可用这个颜色涂。`);
    }
    function takeColor(canvas, at, source) {
      finish();
      const choice = inkChoice = {hex: brushColor?.hex};
      const confirm = () => pickColor(loupe.confirm(canvas, at, sampler(canvas)), source, PickLoupe.originAt(canvas, at), choice);
      if (canvas !== surfaces.paper || !pipeline.worker) { confirm(); return; }
      ordered(() => {
        reading = true;
        pipeline.request({type: 'barrier'}, (_, error) => {
          if (!error) { schedulePaper(); confirm(); }
          reading = false;
          const actions = afterRead; afterRead = [];
          actions.forEach(action => ordered(action));
        });
      });
    }
    function sampler(canvas) {
      return canvas === surfaces.paper ? (x, y) => paper().rgbAt(
        x / canvas.width * paper().width, y / canvas.height * paper().height) : undefined;
    }
    let previewId = 0;
    function preview(canvas, at) {
      const id = ++previewId;
      // Position feedback uses the last complete frame immediately; refresh
      // from the ordered fence, never confirm a color from that stale frame.
      loupe.show(canvas, at, sampler(canvas));
      if (canvas === surfaces.paper && pipeline.worker && pipeline.busy) {
        pipeline.request({type: 'barrier'}, (_, error) => {
          if (!error && id === previewId && tool === 'pick') loupe.show(canvas, at, sampler(canvas));
        });
      }
    }
    function usePaint(paint, recipe) {
      finish(); chosen = paint; chooseInk(paint);
      if (recipe) showRecipe(recipe);
      setTool('brush'); list(); selection();
      $('paper-canvas').scrollIntoView?.({behavior: 'auto', block: 'center'});
    }
    function list() {
      const query = $('paint-search').value.trim().toLowerCase();
      const available = shelfRecipe ? shelfRecipe.paints : colors;
      const visible = available.filter(p => `${p.code} ${p.nameZh}`.toLowerCase().includes(query));
      $('paint-colors').className = 'paint-colors' + (shelfRecipe ? ' recipe-colors' : '');
      $('paint-show-all').hidden = !shelfRecipe;
      $('paint-colors').replaceChildren(...visible.map(p => {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.code = p.code;
        button.setAttribute('aria-pressed', String(chosen?.code === p.code));
        const swatch = document.createElement('span'); swatch.className = 'mini-swatch'; swatch.style.background = p.hex;
        const parts = shelfRecipe?.parts[shelfRecipe.paints.indexOf(p)];
        const label = document.createElement('span'); label.textContent = `${p.code} ${p.nameZh}${parts == null ? '' : ` · ${parts} 份`}`;
        button.append(swatch); button.append(label);
        button.onclick = () => { finish(); chosen = p; chooseInk(p); list(); selection(); };
        return button;
      }));
      $('paint-count').textContent = shelfRecipe
        ? `当前配方 ${available.length} 支 · 显示 ${visible.length} 支`
        : `当前可用 ${colors.length} 支 · 显示 ${visible.length} 支`;
    }
    function showRecipe(recipe) {
      shelfRecipe = {paints: recipe.paints.slice(), parts: recipe.parts.slice()};
      // A previous all-colors search must not hide the newly selected recipe.
      $('paint-search').value = ''; $('paint-colors').scrollTop = 0;
      // Changing the shelf is not choosing a pigment. Preserve the user's
      // brush choice until they explicitly click a stick.
      list();
    }
    function selection() {
      $('paint-selected').textContent = brushColor ? `当前笔色：${brushColor.code || '吸管'} ${brushColor.nameZh || brushColor.hex.toUpperCase()}` : '没有可用颜色，请在①设置里调整范围。';
    }
    function updateColors(next) {
      finish(); colors = next; shelfRecipe = null;
      chosen = colors.find(p => p.code === chosen?.code) || colors[0];
      if (!brushColor || brushColor.code) chooseInk(chosen);
      list(); selection();
    }
    function step(event, end) {
      const pen = event.pointerType === 'pen', strength = pen ? WaxPaint.clamp(event.pressure || 0, 0, 1) : Number($('paper-pressure').value);
      const tiltX = pen ? (event.tiltX || 0) : 0, tiltY = pen ? (event.tiltY || 0) : 0;
      const tilt = Math.min(1, Math.hypot(tiltX, tiltY) / 67);
      const angle = tilt > .05 ? Math.atan2(tiltY, tiltX) : Math.atan2(end.y - active.last.y, end.x - active.last.x);
      const radius = paper().width * Number($('paper-size').value) / 1370 * (.46 + strength * .72);
      // r4 immediate tool position: keep input feedback visible even once
      // no wax is moving; no idle animation/heartbeat or rAF override.
      const cursor = $('paper-cursor'); cursor.hidden = false;
      cursor.style.left = `${100 * end.x / paper().width}%`;
      cursor.style.top = `${100 * end.y / paper().height}%`;
      const began = performance.now();
      const sample = {from: active.last, to: end, settings: {tool: active.tool === 'paper-knife' ? 'knife' : active.tool,
        strength, angle, tilt, radius: radius * (active.tool === 'brush' ? 1 : 1.55), dry: false}};
      ordered(() => pipeline.sample(sample));
      if (metrics) { metrics.simulation.push(performance.now() - began); metrics.simulationCount++; if (metrics.simulation.length > 2000) metrics.simulation.shift(); }
      active.last = end; schedulePaper();
    }
    for (const [name, canvas] of Object.entries(surfaces)) {
      canvas.addEventListener('pointerdown', event => {
        if (active || pickActive || (event.button != null && event.button !== 0)) return;
        event.preventDefault();
        const at = paperPoint(event);
        if (tool === 'pick') {
          canvas.setPointerCapture(event.pointerId);
          pickActive = {id: event.pointerId, name};
          preview(canvas, PickLoupe.point(canvas, event)); return;
        }
        if (tool === 'brush' && !brushColor) { tell('请先选一支可用颜色。'); return; }
        const choice = inkChoice;
        ordered(() => pipeline.request({type: 'begin', hex: choice?.hex}));
        $('palette-undo').disabled = false;
        canvas.setPointerCapture(event.pointerId);
        const last = at;
        active = {id: event.pointerId, name, tool, last};
        step(event, last);
      });
      canvas.addEventListener('pointermove', event => {
        if (tool === 'pick') {
          if (pickActive ? pickActive.id === event.pointerId && pickActive.name === name : event.pointerType !== 'touch') {
            preview(canvas, PickLoupe.point(canvas, event));
          }
          return;
        }
        if (!active || active.id !== event.pointerId || active.name !== name) return;
        event.preventDefault();
        const events = event.getCoalescedEvents?.() || [];
        for (const sample of events.length ? events : [event]) step(sample, paperPoint(sample));
      });
      canvas.addEventListener('pointerup', event => {
        if (pickActive?.id === event.pointerId && pickActive.name === name) {
          pickActive = null; takeColor(canvas, PickLoupe.point(canvas, event), '白纸'); return;
        }
        if (!active || active.id !== event.pointerId || active.name !== name) return;
        const end = paperPoint(event);
        if (Math.hypot(end.x - active.last.x, end.y - active.last.y) >= .5) step(event, end);
        finish();
      });
      for (const type of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(type, event => {
        if (pickActive?.id === event.pointerId && pickActive.name === name) { pickActive = null; loupe.hide(); }
        if (active?.id === event.pointerId && active.name === name) finish();
      });
      canvas.addEventListener('pointerleave', () => { if (!pickActive) loupe.hide({boundary: true}); });
      canvas.addEventListener('blur', () => { if (!pickActive) loupe.hide(); });
    }
    function paperPoint(event) {
      const c = surfaces.paper, rect = c.getBoundingClientRect();
      return {x: WaxPaint.clamp((event.clientX - rect.left) * paper().width / rect.width, 0, paper().width - .001),
        y: WaxPaint.clamp((event.clientY - rect.top) * paper().height / rect.height, 0, paper().height - .001)};
    }
    for (const name of ['brush', 'smudge', 'paper-knife', 'pick']) $('tool-' + name).onclick = () => setTool(name);
    $('paint-search').addEventListener('input', list);
    $('paint-show-all').onclick = () => { shelfRecipe = null; $('paint-colors').scrollTop = 0; list(); };
    $('palette-undo').onclick = () => {
      finish();
      ordered(() => pipeline.request({type: 'undo'}, snapshot => {
        if (snapshot) { save(snapshot); if (pipeline.worker) schedulePaper(); else draw(); tell('已撤销一步。'); }
      }));
    };
    $('palette-clear').onclick = () => {
      finish();
      ordered(() => pipeline.request({type: 'clear'}, snapshot => {
        if (snapshot) save(snapshot);
        if (pipeline.worker) schedulePaper(); else draw();
        tell('白纸已清空；可撤销。');
      }));
    };
    $('pick-recipe').onclick = () => { if (picked) onTarget(picked.rgb.slice(), picked.source); };
    let paperRestored = false;
    try {
      const paper = localStorage.getItem(paperKey);
      if (paper !== null) {
        const wax = JSON.parse(paper);
        if (!wax) throw new Error('本地白纸数据无效');
        model.restore({...model.palette.encode(), wax}); paperRestored = true;
      }
    } catch { $('palette-storage-warning').textContent = '上次白纸没有读出；本次从空白开始。'; }
    if (!paperRestored) {
      try {
        // Migrate pre-v2 paper marks only; retired surface data stays untouched.
        const legacy = localStorage.getItem('kuelox-palette-v1');
        if (legacy !== null) {
          model.restore(JSON.parse(legacy)); model.palette = new PaintPalette.Palette();
          $('palette-storage-warning').textContent = '已从旧存档恢复白纸笔画；下次编辑后会保存为新版白纸存档。';
        }
      } catch { $('palette-storage-warning').textContent = '上次白纸没有读出；本次从空白开始。'; }
    }
    pipeline = new PaperPipeline.Pipeline({studio: model, onChange: schedulePaper,
      onError: message => { $('palette-storage-warning').textContent = message; }});
    // Diagnostics only in explicit check mode, not an application state escape.
    if (metrics) {
      metrics.pipeline = pipeline;
      metrics.settled = () => new Promise(resolve => ordered(() => pipeline.request({type: 'barrier'}, resolve)));
    }
    draw(); setTool('brush');
    function saveForUnload() {
      finish();
      try { save(pipeline.snapshotForUnload()); }
      catch (error) { $('palette-storage-warning').textContent = error.message; }
    }
    root.addEventListener?.('pagehide', event => {
      pageHidden = true;
      saveForUnload();
      pickActive = null; previewId++; loupe.hide();
      root.cancelAnimationFrame(drawFrame); drawFrame = 0;
      if (!event?.persisted) pipeline.dispose();
    });
    root.addEventListener?.('pageshow', event => {
      if (event.persisted) { pageHidden = false; schedulePaper(); }
    });
    const beforeUnload = event => {
      if (!active && !reading && !pipeline.busy) return;
      saveForUnload();
      // Keep the existing unsaved-work prompt, but persistence is synchronous:
      // script navigation / a browser declining the prompt is safe as well.
      event.preventDefault(); event.returnValue = '';
    };
    root.addEventListener?.('beforeunload', beforeUnload);
    root.addEventListener?.('scroll', () => { if (!pickActive) loupe.hide(); }, true);
    root.addEventListener?.('blur', () => { finish(); pickActive = null; previewId++; loupe.hide(); });
    return {updateColors, usePaint};
  }
  root.PaletteUI = {mount};
})(globalThis);
