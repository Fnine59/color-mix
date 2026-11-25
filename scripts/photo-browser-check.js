// Acceptance-only browser probes. Inject into the owned preview page via CDP;
// this file is not referenced by the product and performs no network requests.
(() => {
  const $ = id => document.getElementById(id), records = [], targets = [];
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...rest) {
    if (message.target) targets.push([...message.target]);
    return post.call(this, message, ...rest);
  };
  const rect = element => element.getBoundingClientRect().toJSON();
  const rgba = (c, x, y) => [...c.getContext('2d').getImageData(x, y, 1, 1).data];
  const tick = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  function position(x, y) {
    const c = $('photo'), r = c.getBoundingClientRect();
    return {x: r.left + (x + .5) * r.width / c.width, y: r.top + (y + .5) * r.height / c.height};
  }
  function point(clientX, clientY) { return PhotoView.point($('photo'), {clientX, clientY}); }
  function observe(x, y) {
    const at = point(x, y), center = rgba($('photo-loupe-canvas'), 5, 5).slice(0, 3);
    const rgb = rgba($('photo'), at.x, at.y).slice(0, 3);
    return {at: {x: at.x, y: at.y}, rgb, center, hex: $('photo-loupe-hex').textContent,
      loupeVisible: !$('photo-loupe').hidden, loupe: rect($('photo-loupe')), finger: {x, y}};
  }
  function savePreview(x, y) {
    const observation = observe(x, y);
    assert(observation.loupeVisible, 'loupe must be visible');
    assert(JSON.stringify(observation.rgb) === JSON.stringify(observation.center), 'loupe center must equal exact pixel');
    assert(observation.hex === ColorMath.rgbToHex(observation.rgb).toUpperCase(), 'loupe HEX must equal RGB');
    records.push({type: 'preview', ...observation}); return observation;
  }
  async function savePick(x, y) {
    await tick();
    const at = point(x, y), rgb = rgba($('photo'), at.x, at.y).slice(0, 3), hex = ColorMath.rgbToHex(rgb).toUpperCase();
    assert($('target-hex').textContent === hex, 'target must equal exact released pixel');
    assert(JSON.stringify(targets.at(-1)) === JSON.stringify(rgb), 'solver must receive exact released RGB');
    records.push({type:'pick', at:{x:at.x,y:at.y}, rgb, hex, solver:targets.at(-1), zoom:$('photo-zoom-value').textContent});
    return records.at(-1);
  }
  function gesture(type, x, y, id = 71) {
    $('photo').dispatchEvent(new PointerEvent(type, {bubbles:true, pointerId:id, pointerType:'touch', clientX:x, clientY:y, button:0}));
  }
  async function average() {
    const c = $('photo'), s = $('image-stage').getBoundingClientRect(), r = c.getBoundingClientRect();
    const left=Math.max(s.left+2,r.left+2),top=Math.max(s.top+2,r.top+2),right=Math.min(s.right-2,r.right-2),bottom=Math.min(s.bottom-2,r.bottom-2);
    const start={x:left+(right-left)*.35,y:top+(bottom-top)*.35},end={x:left+(right-left)*.7,y:top+(bottom-top)*.7};
    const a=point(start.x,start.y),b=point(end.x,end.y);
    $('photo-average').click();gesture('pointerdown',start.x,start.y);gesture('pointermove',end.x,end.y);
    const selection=rect($('selection'));
    const region={x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x)+1,height:Math.abs(a.y-b.y)+1};
    // border-box selection should match the actual pixel region, including stage border.
    assert(Math.abs(selection.left-(r.left+region.x*r.width/c.width))<.02,'average box left alignment');
    assert(Math.abs(selection.top-(r.top+region.y*r.height/c.height))<.02,'average box top alignment');
    assert(Math.abs(selection.width-region.width*r.width/c.width)<.02,'average box width alignment');
    const rgb=ColorMath.averagePixels(c.getContext('2d').getImageData(region.x,region.y,region.width,region.height).data);
    gesture('pointerup',end.x,end.y);await tick();
    assert(JSON.stringify(targets.at(-1))===JSON.stringify(rgb),'average solver RGB');
    $('photo-pick').click(); records.push({type:'average',region,selection,rgb,zoom:$('photo-zoom-value').textContent});return records.at(-1);
  }
  window.PhotoCheck={records,targets,tick,position,point,observe,savePreview,savePick,average,
    report:()=>({records,recipeCards:document.querySelectorAll('.recipe').length,errors:$('photo-error').textContent})};
})();
