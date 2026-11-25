const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCanvas} = require('@napi-rs/canvas');
const {Studio} = require('../site/paper-studio.js');
const W = require('../site/wax-paper.js'), baseline = require('./helpers/wax-r4-baseline.cjs');
const R = require('../site/recipe.js'), data = require('../site/data/kuelox.json');
global.Recipe = R;
const paint = code => data.colors.find(p => p.code === code);
test('ported r4 brush/knife and transport match 1759772 on each prefix and all three strengths', () => {
  for (const strength of [.2, .55, .95]) {
    const a = new W.Surface(160,100,[248,239,220],new W.Pigments());
    const b = new baseline.Surface(160,100,[248,239,220],new baseline.Pigments());
    for (const [tool, hex] of [['brush',paint('704').hex],['brush',paint('644').hex],['smudge',null],['knife',null]]) {
      for (const board of [a,b]) {
        const settings = {tool,radius:16,strength,angle:0,tilt:0,dry:false,strokeId:board.beginStroke(),
          pigment:hex ? board.pigments.color(hex) : null};
        board.stroke({x:40,y:50},{x:100,y:50},settings);
      }
      for (const field of ['mass','bottomMass','topMass','tail','field']) assert.deepEqual(a[field],b[field]);
      assert.deepEqual(a.cells.map(p=>p?.shares),b.cells.map(p=>p?.shares));
    }
  }
});
test('studio persists new layered paper exactly, undo covers paper/tray and old canvas migrates', () => {
  const s = new Studio(), paper = s.paper, yellow = s.pigments.color(paint('704').hex);
  s.begin(); paper.stroke({x:80,y:100},{x:300,y:100},{tool:'brush',pigment:yellow,radius:25,strength:.55,angle:0,strokeId:paper.beginStroke()});
  s.commit(); const saved = JSON.parse(JSON.stringify(s.encode()));
  const restored = new Studio(); restored.restore(saved); assert.deepEqual(restored.encode(), saved);
  s.begin(); s.squeeze(paint('644'),160,180); s.commit(); s.clear();
  assert(s.undo()); assert(s.undo()); assert.deepEqual(s.encode(), saved);
  assert(s.undo()); assert.equal(s.encode().wax.count,0);
  const old = {v:1,cells:[],paper:[[0,0x2063ad]],texture:[[0,2]]};
  restored.restore(old);
  assert(restored.paper.cells.some(p=>p?.rgb.join(',')==='34,101,175'));
  assert.equal(restored.encode().paper.length,0);
  const before = restored.encode(); assert.throws(()=>restored.restore({...saved,wax:{v:1,width:448,height:274,cells:[[0,null,-1,null,0,0]]}}));
  assert.deepEqual(restored.encode(),before); // Atomic invalid restore.
});
test('tray squeeze and knife render unchanged behind new studio wrapper', () => {
  const {Palette} = require('../site/palette.js'), original = new Palette(), s = new Studio();
  for(const model of [original,s]) {model.squeeze(paint('644'),160,180);model.squeeze(paint('704'),300,180);model.knife({x:160,y:180},{x:300,y:180},new Set());}
  assert.deepEqual(s.palette.encode(),original.encode());
  const a=createCanvas(720,420).getContext('2d'),b=createCanvas(720,420).getContext('2d');
  s.renderPalette(a);original.renderPalette(b);assert.deepEqual(a.getImageData(0,0,720,420).data,b.getImageData(0,0,720,420).data);
});
