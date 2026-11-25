const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCanvas} = require('@napi-rs/canvas');
const S = require('../site/soft-smudge.js'), W = require('../site/wax-paper.js');
const {flat} = require('../site/wax-render.js'), M = require('../site/color-math.js'), R = require('../site/recipe.js');
const data = require('../site/data/kuelox.json');
const paints = ['704', '644'].map(code => data.colors.find(p => p.code === code));
const expected = R.mix(paints, [1,1]), de = (a,b) => M.deltaE2000(M.rgbToLab(a),M.rgbToLab(b));
function blocks(Type = S, layered = false) {
  const p = new Type.Pigments(), b = new Type.Surface(448,274,[248,239,220],p), inks = paints.map(c => p.color(c.hex));
  for (let y=80;y<=190;y++) for(let x=100;x<=348;x++) {
    b.add(b.at(x,y),inks[layered?0:x<224?0:1],40);
    if(layered) b.add(b.at(x,y),inks[1],40);
  }
  return b;
}
function rub(b, passes=8, strength=.55) {
  for(let pass=0;pass<passes;pass++) {
    const settings={tool:'smudge',radius:48,strength,strokeId:b.beginStroke()};
    const start=pass%2?300:148,end=pass%2?148:300; let last={x:start,y:137};
    for(let k=1;k<=32;k++) {
      const next={x:start+(end-start)*k/32,y:137}; b.stroke(last,next,settings);last=next;
    }
  }
}
function stats(b) {
  let neighbor=0, holes=0, isolated=0;
  const canvas=createCanvas(b.width,b.height);flat(canvas,b).draw();
  const rgb=(x,y)=>Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data).slice(0,3);
  for(let y=131;y<=143;y++) for(let x=208;x<=240;x++) {
    if(!b.cells[b.at(x,y)]) holes++;
    const pairs=[[x+1,y],[x,y+1]], neighbors=[[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
    for(const [nx,ny] of pairs) neighbor=Math.max(neighbor,de(rgb(x,y),rgb(nx,ny)));
    if(neighbors.every(([nx,ny])=>de(rgb(x,y),rgb(nx,ny))>2)) isolated++;
  }
  return {maxNeighborDE:neighbor,holes,isolated,center:rgb(224,137),centerDE:de(rgb(224,137),expected)};
}
test('adjacent 704/644: eight medium passes yield smooth spectral transition, no isolated or paper cells', () => {
  const b=blocks();rub(b);const result=stats(b);
  console.log('soft-smudge measured:',JSON.stringify(result));
  assert.deepEqual(expected,[96,179,119]);
  assert(result.maxNeighborDE<1.5,JSON.stringify(result));
  assert.equal(result.holes,0);assert.equal(result.isolated,0);
  assert(result.centerDE<2,JSON.stringify(result));
  const c=b.cells[b.at(224,137)];
  assert.deepEqual(c.rgb,R.mix(c.shares.map(([hex])=>({hex})),c.shares.map(([,weight])=>weight)));
});
test('overlaid real coats actually mix; repeated and heavy rubbing homogenize faster than light', () => {
  const overlay=blocks(S,true);rub(overlay,4);
  assert(de(overlay.cells[overlay.at(224,137)].rgb,expected)<2);
  const light=blocks(), medium=blocks(),heavy=blocks();
  rub(light,4,.2);rub(medium,4,.55);rub(heavy,4,.95);
  assert.equal(light.cells[light.at(224,137)].shares.length,2);
  assert(stats(heavy).maxNeighborDE<stats(light).maxNeighborDE);
  assert(stats(heavy).maxNeighborDE<stats(medium).maxNeighborDE);
  rub(medium,8,.55);assert(stats(medium).maxNeighborDE<1);
});
test('all-prefix smudge is contact local; single-color r4 tail mass/path and knife unchanged', () => {
  const b=blocks(), before=b.cells.map(c=>c?.rgb.join(',')), masses=b.mass.slice();
  const settings={tool:'smudge',radius:24,strength:.55,strokeId:b.beginStroke()};
  const point={x:224,y:137};b.stroke(point,{x:230,y:137},settings);
  for(let i=0;i<b.cells.length;i++)if(before[i]!==b.cells[i]?.rgb.join(',')){
    const x=i%b.width,y=Math.floor(i/b.width);
    assert(Math.hypot(Math.max(224-x,0,x-230),y-137)<=24);
  }
  assert(Math.abs(b.mass.reduce((s,n)=>s+n,0)-masses.reduce((s,n)=>s+n,0))<.01);
  const a=new S.Surface(160,100,[248,239,220],new S.Pigments()),c=new W.Surface(160,100,[248,239,220],new W.Pigments());
  for(const board of [a,c]) {
    for(let y=30;y<=70;y++)for(let x=20;x<75;x++)board.add(board.at(x,y),board.pigments.color(paints[0].hex),40);
    board.stroke({x:55,y:50},{x:130,y:50},{tool:'smudge',radius:20,strength:.95,strokeId:board.beginStroke()});
    board.stroke({x:50,y:40},{x:50,y:65},{tool:'knife',radius:12,strength:.55,strokeId:board.beginStroke()});
  }
  for(const key of ['mass','bottomMass','topMass','tail','field'])assert.deepEqual(a[key],c[key]);
  assert.deepEqual(a.cells.map(c=>c?.rgb),c.cells.map(c=>c?.rgb));
});
test('sparse/dense input shares arc-length resampling, rubbed paper saves and restores smooth pixels', () => {
  const a=blocks(),b=blocks();
  for(const [board,n] of [[a,4],[b,64]]) {
    const settings={tool:'smudge',radius:48,strength:.55,strokeId:board.beginStroke()};let last={x:148,y:137};
    for(let k=1;k<=n;k++){const next={x:148+152*k/n,y:137};board.stroke(last,next,settings);last=next;}
  }
  assert.deepEqual(a.cells.map(p=>p?.rgb),b.cells.map(p=>p?.rgb));
  const {Studio}=require('../site/paper-studio.js'),s=new Studio();s.paper=a;
  const value=JSON.parse(JSON.stringify(s.encode())),restored=new Studio();restored.restore(value);
  assert.deepEqual(restored.encode(),value);
  const ca=createCanvas(448,274),cb=createCanvas(448,274);flat(ca,a).draw();flat(cb,restored.paper).draw();
  assert.deepEqual(ca.getContext('2d').getImageData(0,0,448,274).data,cb.getContext('2d').getImageData(0,0,448,274).data);
});
test('actual subclass brush coverage/knife are r4-identical across pressure, tilt, and input routes', () => {
  const Baseline = require('./helpers/wax-r4-baseline.cjs');
  for (const strength of [.2,.55,.95]) for (const tilt of [0,.8]) {
    const boards = [S,Baseline].map(Type => new Type.Surface(160,100,[248,239,220],new Type.Pigments()));
    for (const b of boards) {
      for (const code of [0,1,0]) b.stroke({x:22,y:45},{x:130,y:60},
        {tool:'brush',pigment:b.pigments.color(paints[code].hex),radius:13,strength,tilt,angle:.3,strokeId:b.beginStroke()});
      for (let k=0;k<3;k++) b.stroke({x:80,y:20},{x:90,y:85},
        {tool:'knife',radius:12,strength,strokeId:b.beginStroke()});
    }
    for (const key of ['mass','bottomMass','topMass','tail','field']) assert.deepEqual(boards[0][key],boards[1][key]);
    assert.deepEqual(boards[0].cells.map(c=>c?.rgb),boards[1].cells.map(c=>c?.rgb));
    const pixels=boards.map(b=>{const c=createCanvas(160,100);flat(c,b).draw();return c.getContext('2d').getImageData(0,0,160,100).data;});
    assert.deepEqual(pixels[0],pixels[1]);
  }
});
test('mixed wax tails stay connected and total mass/contact footprint stays r4 at every input prefix', () => {
  const b=blocks(),baseline=blocks(W),original=b.mass.slice(),total=b.mass.reduce((s,n)=>s+n,0);
  const settings={tool:'smudge',radius:35,strength:.95,strokeId:b.beginStroke()};
  const baseSettings={...settings,strokeId:baseline.beginStroke()};
  let last={x:310,y:137};
  for (let k=1;k<=12;k++) {
    const next={x:310+k*7,y:137};b.stroke(last,next,settings);baseline.stroke(last,next,baseSettings);last=next;
    for (const key of ['mass','bottomMass','topMass','tail']) assert.deepEqual(b[key],baseline[key]);
    assert(Math.abs(b.mass.reduce((s,n)=>s+n,0)-total)<.02);
    const seen=new Uint8Array(b.mass.length),queue=[];
    original.forEach((v,i)=>{if(v&&b.mass[i]){seen[i]=1;queue.push(i);}});
    for(let n=0;n<queue.length;n++) {
      const i=queue[n],x=i%b.width,y=Math.floor(i/b.width);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        if(x+dx<0||x+dx>=b.width||y+dy<0||y+dy>=b.height)continue;
        const j=(y+dy)*b.width+x+dx;if(b.mass[j]&&!seen[j]){seen[j]=1;queue.push(j);}
      }
    }
    b.mass.forEach((v,i)=>{if(v&&!original[i])assert(seen[i],`detached tail ${i}`);});
  }
});
