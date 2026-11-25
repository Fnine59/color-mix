// Transform only the displayed photo. Every sampler reads the untouched canvas
// through its actual transformed DOM rectangle (including fractional CSS pixels).
(function (root) {
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function point(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return {x: clamp(Math.floor((event.clientX - rect.left) * canvas.width / rect.width), 0, canvas.width - 1),
      y: clamp(Math.floor((event.clientY - rect.top) * canvas.height / rect.height), 0, canvas.height - 1),
      screenX: event.clientX, screenY: event.clientY};
  }
  function contains(canvas, stage, event) {
    const photo = canvas.getBoundingClientRect(), frame = stage.getBoundingClientRect();
    const left = stage.clientLeft || 0, top = stage.clientTop || 0;
    // client/offset sizes are integer-rounded; retain the DOMRect's fractional
    // layout remainder so a subpixel border strip is not treated as photo.
    const width = stage.clientWidth == null ? frame.width - 2 * left
      : stage.clientWidth + (stage.offsetWidth == null ? 0 : frame.width - stage.offsetWidth);
    const height = stage.clientHeight == null ? frame.height - 2 * top
      : stage.clientHeight + (stage.offsetHeight == null ? 0 : frame.height - stage.offsetHeight);
    const x = event.clientX - frame.left - left, y = event.clientY - frame.top - top;
    if (event.clientX < photo.left || event.clientX >= photo.left + photo.width ||
        event.clientY < photo.top || event.clientY >= photo.top + photo.height ||
        x < 0 || x >= width || y < 0 || y >= height) return false;
    // overflow:hidden clips at the rounded padding edge, not the border box.
    const style = root.getComputedStyle?.(stage);
    if (!style) return true;
    const radius = value => {
      const parts = (value || '0').split(/\s+/);
      const length = (part, size) => parseFloat(part) * (part.endsWith('%') ? size / 100 : 1);
      return [length(parts[0], frame.width), length(parts[1] || parts[0], frame.height)];
    };
    const corners = [style.borderTopLeftRadius, style.borderTopRightRadius,
      style.borderBottomRightRadius, style.borderBottomLeftRadius].map(radius);
    // CSS scales overlapping outer radii together before deriving inner radii.
    const factor = Math.min(1, frame.width / (corners[0][0] + corners[1][0]),
      frame.width / (corners[3][0] + corners[2][0]), frame.height / (corners[0][1] + corners[3][1]),
      frame.height / (corners[1][1] + corners[2][1]));
    const right = parseFloat(style.borderRightWidth) || left, bottom = parseFloat(style.borderBottomWidth) || top;
    const edges = [[x, y, left, top], [width - x, y, right, top],
      [width - x, height - y, right, bottom], [x, height - y, left, bottom]];
    return corners.every(([outerX, outerY], i) => {
      const [dx, dy, borderX, borderY] = edges[i];
      const rx = Math.max(0, outerX * factor - borderX), ry = Math.max(0, outerY * factor - borderY);
      return !rx || !ry || dx >= rx || dy >= ry || ((dx - rx) / rx) ** 2 + ((dy - ry) / ry) ** 2 <= 1;
    });
  }
  function mount(canvas, stage, onChange) {
    let zoom = 1, x = 0, y = 0;
    function bounds() {
      const photo = canvas.getBoundingClientRect(), viewport = stage.getBoundingClientRect();
      return {x: Math.max(0, (photo.width - (stage.clientWidth || viewport.width)) / 2),
        y: Math.max(0, (photo.height - (stage.clientHeight || viewport.height)) / 2)};
    }
    function draw() {
      canvas.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
      const limit = bounds();
      x = clamp(x, -limit.x, limit.x); y = clamp(y, -limit.y, limit.y);
      canvas.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
      onChange?.({zoom, x, y});
    }
    function snapshot() { return {zoom, x, y, rect: canvas.getBoundingClientRect()}; }
    function setZoom(next, anchor, start = snapshot()) {
      zoom = clamp(next, 1, 5);
      const factor = zoom / start.zoom;
      const center = {x: start.rect.left + start.rect.width / 2, y: start.rect.top + start.rect.height / 2};
      const at = anchor || center;
      x = start.x + (at.x - center.x) * (1 - factor);
      y = start.y + (at.y - center.y) * (1 - factor);
      draw();
    }
    function pan(dx, dy, start = snapshot()) { x = start.x + dx; y = start.y + dy; draw(); }
    function pinch(start, from, to) {
      setZoom(start.zoom * to.distance / from.distance, from, start);
      // Do not clamp the anchored zoom before adding the two-finger translation.
      const factor = zoom / start.zoom;
      x = start.x + (from.x - (start.rect.left + start.rect.width / 2)) * (1 - factor) + to.x - from.x;
      y = start.y + (from.y - (start.rect.top + start.rect.height / 2)) * (1 - factor) + to.y - from.y;
      draw();
    }
    function reset() { zoom = 1; x = y = 0; draw(); }
    return {snapshot, setZoom, pan, pinch, reset, refresh: draw};
  }
  function pair(events) {
    const [a, b] = events;
    return {x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2,
      distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY))};
  }
  root.PhotoView = {point, contains, mount, pair};
})(globalThis);
