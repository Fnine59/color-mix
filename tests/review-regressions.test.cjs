const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');

test('public tracked text has no private paths or browser session identifiers; benchmark diagnoses missing metrics before clearing', async () => {
  const session = new RegExp('(?:Ego\\s+)?Space\\s*\\*?\\*?\\d+|\\[p\\d+\\s+"|Ego[^\\n]*\\bp\\d+\\b|(?:任务空间|Ego\\s*空间)\\s+\\d+|(?<![0-9A-Za-z])\\d+/p\\d+(?![0-9A-Za-z])');
  for (const prefix of ['Space', '任务空间', 'Ego 空间'])
    assert(session.test(prefix + ' ' + 45), `privacy detects ${prefix}`);
  assert(session.test('`' + 12 + '/p' + 3 + '`'), 'privacy detects compact identifiers');
  assert(!session.test('version12' + '/p' + '3build'), 'compact identifiers have token boundaries');
  const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
  for (const file of files.filter(f => /\.(md|json|txt|js|cjs|html|css|sh)$/.test(f))) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    // Construct patterns to avoid embedding the forbidden examples in this test.
    const privatePath = new RegExp('/(?:data\\d+/)?' + 'home/[^/\\s]+/');
    assert(!privatePath.test(text), file);
    assert(!session.test(text), file);
    assert(!/https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/.test(text), file);
  }
  let touched = false;
  const script = fs.readFileSync(path.join(__dirname, '../scripts/paper-smudge-bench.js'), 'utf8');
  for (const helpers of [undefined, {metrics: null, clear() { touched = true; }}]) {
    const context = {window: {smudgeEvidence: helpers && {helpers}}};
    await assert.rejects(vm.runInNewContext(script, context), /\?check=1.*画布未清空/);
  }
  assert.equal(touched, false);
});

const S = require('../site/soft-smudge.js'), Baseline = require('./helpers/wax-r4-baseline.cjs');
const {Studio, decodePaper} = require('../site/paper-studio.js');
const M = require('../site/color-math.js');
const inks = ['#F4EC65','#2063AD'];
function line(board, tool, start, end, strength, size, hex, each = () => {}) {
  const radius = board.width * size / 1370 * (.46 + strength * .72) * (tool === 'brush' ? 1 : 1.55);
  const settings = {tool, radius, strength, strokeId: board.beginStroke(), dry: false,
    pigment: hex && board.pigments.color(hex), angle: Math.atan2(end[1]-start[1],end[0]-start[0])};
  let last = {x:start[0],y:start[1]};
  if(tool === 'brush') board.stroke(last,last,{...settings,angle:0});
  for(let k=1;k<=32;k++) {
    const next={x:start[0]+(end[0]-start[0])*k/32,y:start[1]+(end[1]-start[1])*k/32};
    board.stroke(last,next,settings);last=next;each(k);
  }
}
function vertical(board, xs, strength, size) {
  xs.forEach((x,n)=>line(board,'brush',[x,80],[x,194],strength,size,inks[n]));
}
function pixel(board,x,y) {const out=new Uint8ClampedArray(3);board.writeFlat(board.at(x,y),out);return [...out];}
const delta=(a,b)=>M.deltaE2000(M.rgbToLab(a),M.rgbToLab(b));

test('two-color transport preserves r4 every input prefix, each layer, moved/received decisions and connected tapered tails', () => {
  const a=new S.Surface(448,274,[248,239,220],new S.Pigments());
  const b=new Baseline.Surface(448,274,[248,239,220],new Baseline.Pigments());
  vertical(a,[208,240],.95,45);vertical(b,[208,240],.95,45);
  const original=a.mass.slice();
  for(const [start,end] of [[[150,137],[290,137]],[[290,137],[325,137]]]) {
    // Record baseline prefixes; compare immediately after each actual input.
    const prefixes=[];
    line(b,'smudge',start,end,.95,45,null,()=>prefixes.push(Object.fromEntries(
      ['mass','bottomMass','topMass','tail','moved','receivedBottom','receivedTop'].map(key=>[key,b[key].slice()]))));
    line(a,'smudge',start,end,.95,45,null,k=>{
      for(const key of Object.keys(prefixes[k-1])) assert.deepEqual(a[key],prefixes[k-1][key],`${key} prefix ${k}`);
      const seen=new Set(),queue=[];
      original.forEach((mass,i)=>{if(mass&&a.mass[i]){seen.add(i);queue.push(i);}});
      for(let n=0;n<queue.length;n++) {
        const i=queue[n],x=i%448,y=Math.floor(i/448);
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
          if(x+dx<0||x+dx>=448||y+dy<0||y+dy>=274)continue;
          const j=i+dy*448+dx;if(a.mass[j]&&!seen.has(j)){seen.add(j);queue.push(j);}
        }
      }
      a.mass.forEach((mass,i)=>{if(mass&&!original[i])assert(seen.has(i),`detached ${i}`);});
    });
  }
  assert(a.tail.some((tail,i)=>tail&&a.mass[i]<4),'has real gradual thin ends');
  // The same third push must land in the same r4 layers after a reload OR
  // undo. Use a fresh pigment registry for reload, the existing one for undo.
  for (const route of ['live', 'reload', 'undo']) {
    let studio = new Studio();
    const base = new Baseline.Surface(448,274,[248,239,220],new Baseline.Pigments());
    for (const board of [studio.paper, base]) {
      vertical(board,[208,240],.95,45);
      for (const [start,end] of [[[150,137],[325,137]],[[325,138],[150,138]]])
        line(board,'smudge',start,end,.95,45);
    }
    if (route === 'reload') {
      const saved = JSON.parse(JSON.stringify(studio.encode()));
      studio = new Studio(); studio.restore(saved);
    } else if (route === 'undo') {
      studio.begin(); studio.paper.add(0, studio.pigments.color(inks[0]), 40); studio.commit();
      assert(studio.undo());
    }
    const prefixes = [];
    line(base,'smudge',[150,137],[330,137],.95,45,null,()=>prefixes.push(Object.fromEntries(
      ['mass','bottomMass','topMass','tail'].map(key=>[key,base[key].slice()]))));
    line(studio.paper,'smudge',[150,137],[330,137],.95,45,null,k=>{
      for (const key of Object.keys(prefixes[k-1]))
        assert.deepEqual(studio.paper[key], prefixes[k-1][key], `${route} ${key} prefix ${k}`);
    });
  }
  // Preserve the pre-normalisation r4 key: a 49-unit rounding sum is not a
  // fresh 48-unit quantisation of those shares.
  const pigments = new S.Pigments(), mixed = pigments.transport.mix({[inks[0]]: 1, [inks[1]]: 95});
  assert.equal(mixed.key.split(',').reduce((sum,entry)=>sum+Number(entry.split('/')[1]),0),49);
  assert.equal(pigments.restoreState(mixed.shares,mixed.key),mixed);
  assert.throws(()=>pigments.restoreState(mixed.shares,'invalid'));
  for (const mode of ['mixture eviction', 'two same-key coats', 'pair-held evicted result', 'pair eviction']) {
    const live = new Studio();
    const base = new Baseline.Surface(448,274,[248,239,220],new Baseline.Pigments());
    for (const board of [live.paper, base]) {
      vertical(board,mode==='two same-key coats'?[208]:[208,240],.95,45);
      if (mode!=='two same-key coats') for (const [start,end] of [[[150,137],[325,137]],[[325,138],[150,138]]])
        line(board,'smudge',start,end,.95,45);
      const register = board.pigments.transport || board.pigments;
      for (let n=0;n<3200;n++) {
        const color=board.pigments.color('#'+(0x20d000+n).toString(16));
        board.pigments.state?.(color);
      }
      assert(!register.mixtures.has(inks[0]+'/48'),'real mixture cache eviction happened');
      if (mode==='two same-key coats')
        line(board,'brush',[240,80],[240,194],.95,45,inks[0]);
      if (mode==='pair eviction') {
        const added=register.color(inks[1]), original=register.color(inks[0]);
        while (register.pairs.size<10000) {
          const unique={...original,id:register.nextId++};
          register.blend(unique,added,.5);
        }
        register.blend({...original,id:register.nextId++},added,.5);
        assert.equal(register.pairs.size,1,'real 10000-entry pair cache eviction happened');
      } else if (mode==='pair-held evicted result') {
        assert(register.pairs.size>0);
        assert([...register.pairs.values()].some(state=>register.mixtures.get(state.key)!==state),
          'pair cache still returns an evicted identity');
      }
    }
    const saved=JSON.parse(JSON.stringify(live.encode())),cold=new Studio();cold.restore(saved);
    // The prior slash-key snapshots still load; rewriting is lossless and
    // changes only the numeric pair tuple representation.
    const oldPairs=JSON.parse(JSON.stringify(saved));
    const flatPairs=oldPairs.wax.transport.pairs;
    delete oldPairs.wax.transport.pairStride;
    for (const stringKeys of [false,true]) {
      oldPairs.wax.transport.pairs=Array.from({length:flatPairs.length/4},(_,n)=>{
        const entry=flatPairs.slice(n*4,n*4+4);
        return stringKeys?[entry.slice(0,3).join('/'),entry[3]]:entry;
      });
      const legacyPairs=new Studio();legacyPairs.restore(oldPairs);
      assert.deepEqual(legacyPairs.encode(),saved);
    }
    const undo=new Studio();undo.restore(saved);undo.begin();
    undo.paper.add(0,undo.pigments.color('#DE609E'),40);undo.commit();assert(undo.undo());
    for (const restored of [cold,undo]) {
      const original=live.pigments.transport, register=restored.pigments.transport;
      assert.deepEqual([...register.mixtures].map(([key,state])=>[key,state.id]),
        [...original.mixtures].map(([key,state])=>[key,state.id]),`${mode} active cache identities`);
      assert.deepEqual([...register.pairs].map(([key,state])=>[key,state.id]),
        [...original.pairs].map(([key,state])=>[key,state.id]),`${mode} pair result identities`);
      assert.equal(register.nextId,original.nextId);
    }
    const prefixes=[];
    line(base,'smudge',[150,137],[330,137],.95,45,null,()=>prefixes.push({
      ...Object.fromEntries(['mass','bottomMass','topMass','tail'].map(key=>[key,base[key].slice()])),
      wasMoved:base.moved.map(id=>Number(id===base.strokeId)),
      incomingBottom:base.receivedBottom.map((mass,i)=>base.receivedId[i]===base.strokeId?mass:0),
      incomingTop:base.receivedTop.map((mass,i)=>base.receivedId[i]===base.strokeId?mass:0),
    }));
    for (const [route, board] of [['live',live.paper],['reload',cold.paper],['undo',undo.paper]]) {
      line(board,'smudge',[150,137],[330,137],.95,45,null,k=>{
        for (const key of ['mass','bottomMass','topMass','tail'])
          assert.deepEqual(board[key],prefixes[k-1][key],`${mode} ${route} ${key} prefix ${k}`);
        assert.deepEqual(board.moved.map(id=>Number(id===board.strokeId)),prefixes[k-1].wasMoved);
        for (const [key, expected] of [['receivedBottom','incomingBottom'],['receivedTop','incomingTop']])
          assert.deepEqual(board[key].map((mass,i)=>board.receivedId[i]===board.strokeId?mass:0),prefixes[k-1][expected]);
      });
    }
  }
  // Re-select the same displayed color after transport cache eviction, at the
  // SAME coat position. Every new brush stroke must behave like r4, not just
  // direct pushing of already stamped coats.
  for (const route of ['live', 'reload', 'undo']) {
    let studio=new Studio();
    const base=new Baseline.Surface(448,274,[248,239,220],new Baseline.Pigments());
    for (const board of [studio.paper,base]) {
      line(board,'brush',[400,190],[400,230],.95,45,inks[0]);
      const register=board.pigments.transport||board.pigments;
      for(let n=0;n<3200;n++)register.color('#'+(0x20d000+n).toString(16));
      assert(!register.mixtures.has(inks[0]+'/48'));
    }
    if(route==='reload') {
      const saved=JSON.parse(JSON.stringify(studio.encode()));
      studio=new Studio();studio.restore(saved);
    } else if(route==='undo') {
      studio.begin();line(studio.paper,'brush',[380,40],[420,40],.95,45,'#D19DBB');studio.commit();
      assert(studio.undo());
    }
    for(const [tool,start,end]of [['brush',[400,190],[400,230]],['smudge',[378,212],[435,212]]]) {
      const prefixes=[];
      line(base,tool,start,end,.95,45,tool==='brush'?inks[0]:undefined,
        ()=>prefixes.push(Object.fromEntries(['mass','bottomMass','topMass','tail'].map(k=>[k,base[k].slice()]))));
      line(studio.paper,tool,start,end,.95,45,tool==='brush'?inks[0]:undefined,k=>{
        for(const key of Object.keys(prefixes[k-1]))
          assert.deepEqual(studio.paper[key],prefixes[k-1][key],`same-color follow-on ${route} ${tool} ${key} prefix ${k}`);
      });
      if(tool==='brush')assert(studio.paper.topMass[studio.paper.at(400,212)]>0,'evicted same-color pen creates r4 top coat');
    }
  }
});

test('real light adjacent/overlaid strokes rubbed along/across have no enclosed paper holes; optical sealing is local and leaves free tails alone', () => {
  for(const strength of [.55,.2])for(const layered of [false,true])for(const across of [false,true]) {
    const board=new Studio().paper;
    vertical(board,layered?[224,224]:strength===.2?[217,231]:[215.5,232.5],.2,45);
    const baseline = new Baseline.Surface(448,274,[248,239,220],new Baseline.Pigments());
    vertical(baseline,layered?[224,224]:strength===.2?[217,231]:[215.5,232.5],.2,45);
    const ends=across?[[200,137],[248,137]]:[[224,90],[224,183]];
    for(let pass=0;pass<8;pass++) {
      line(board,'smudge',ends[pass%2],ends[1-pass%2],strength,45);
      line(baseline,'smudge',ends[pass%2],ends[1-pass%2],strength,45);
      for (const key of ['mass','bottomMass','topMass','tail']) assert.deepEqual(board[key],baseline[key]);
    }
    const roi=across?[211,237,133,141]:[220,228,107,167];
    let inspected=0;
    for(let y=roi[2];y<=roi[3];y++)for(let x=roi[0];x<=roi[1];x++) {
      const i=board.at(x,y),ns=[i-1,i+1,i-448,i+448];
      if(!ns.every(j=>board.mass[j]>=4&&!board.tail[j]))continue;
      inspected++;
      assert(board.mass[i]>0 || board.poreCovered(i),`uncovered zero-wax hole ${strength}/${layered}/${across} ${x},${y}`);
      const min=Math.min(...ns.map(j=>delta(pixel(board,x,y),pixel(board,j%448,Math.floor(j/448)))));
      assert(min<2,`isolated paper appearance ${layered}/${across} ${x},${y}: ${min}`);
    }
    assert(inspected>20);
    if(strength===.55&&!layered&&!across) assert.equal(delta(pixel(board,222,157),pixel(board,221,157)),0);
    const radius=448*45/1370*(.46+strength*.72)*1.55;
    board.sealed.forEach((v,i)=>{if(v || board.pores[i]){
      const x=i%448,y=Math.floor(i/448);
      const distance=across?Math.hypot(Math.max(200-x,0,x-248),y-137)
        :Math.hypot(x-224,Math.max(90-y,0,y-183));
      assert(distance<radius,'pore sealing stays in actual UI contact disk');
    }});
    const snapshot = new Studio(); snapshot.paper=board;
    const restored=new Studio();restored.restore(JSON.parse(JSON.stringify(snapshot.encode())));
    for (const key of ['mass','bottomMass','topMass','tail']) assert.deepEqual(restored.paper[key],board[key]);
    if(strength===.2&&!layered&&!across) {
      const i=board.at(221,109),neighbors=[i-1,i+1,i-448,i+448];
      assert.equal(board.mass[i],0,'real light-rub pore must have zero physical wax');
      assert(board.pores[i]);assert(board.poreCovered(i));
      assert(neighbors.every(j=>board.mass[j]>20 && board.soft[j]===1 && !board.tail[j]));
      assert(delta(board.rgbAt(221,109),[96,179,119])<2);
      assert.deepEqual(pixel(board,221,109),board.rgbAt(221,109));
      assert.deepEqual(restored.paper.rgbAt(221,109),board.rgbAt(221,109));
      assert.deepEqual(pixel(restored.paper,221,109),pixel(board,221,109));
      board.remove(i-1,board.topMass[i-1],true);board.remove(i-1,board.bottomMass[i-1],false);
      assert(!board.poreCovered(i));assert.deepEqual(board.rgbAt(221,109),board.ground);
    }
    if(strength===.55&&!layered&&!across) {
      const i=board.at(222,157);assert(board.poreCovered(i));
      // Once a neighboring coat is removed, this is a free thin end again.
      board.remove(i-1,board.topMass[i-1],true);board.remove(i-1,board.bottomMass[i-1],false);
      assert(!board.poreCovered(i));assert(delta(pixel(board,222,157),board.cells[i].rgb)>10);
    }
  }
});

test('scraping empty wax clears smooth state; a save roundtrip between cuts leaves shavings and pixels identical', () => {
  const source=new Studio();vertical(source.paper,[448*.425,448*.575],.95,96);
  const ends=[[148,137],[300,137]];
  for(let pass=0;pass<3;pass++)line(source.paper,'smudge',ends[pass%2],ends[1-pass%2],.55,96);
  for(let pass=0;pass<2;pass++)line(source.paper,'knife',[224,120],[224,154],.95,45);
  source.paper.mass.forEach((mass,i)=>{if(!mass){assert.equal(source.paper.soft[i],0);assert.equal(source.paper.sealed[i],0);}});
  const saved=new Studio();saved.restore(JSON.parse(JSON.stringify(source.encode())));
  for(const board of [source.paper,saved.paper])line(board,'knife',[227,120],[227,154],.95,45);
  for(const key of ['bottomMass','topMass','tail','soft','sealed'])assert.deepEqual(source.paper[key],saved.paper[key]);
  for(let i=0;i<source.paper.cells.length;i++)assert.deepEqual(pixel(source.paper,i%448,Math.floor(i/448)),pixel(saved.paper,i%448,Math.floor(i/448)));
});

test('compact and legacy six/seven saves share pigment limits; many arbitrary colors undo, malformed undo retains history atomically', () => {
  for(const length of [6,7]) {
    const s=new Studio(),entry=[1,[[inks[0],1]],40,null,0,0];if(length===7)entry.push(.5);
    s.restore({v:1,cells:[],paper:[],wax:{v:1,width:448,height:274,cells:[entry]}});
    assert.equal(s.paper.mass[1],40);assert.equal(s.paper.soft[1],length===7?.5:0);
    const saved=JSON.parse(JSON.stringify(s.encode()));const b=new Studio();b.restore(saved);assert.deepEqual(b.encode(),saved);
  }
  for(const count of [238,317,1024,2048,4096]) {
    const s=new Studio(),weights=Object.fromEntries(Array.from({length:count},(_,i)=>['#'+(0x342000+i).toString(16),1]));
    const pigment=s.pigments.fine(weights);assert(pigment.shares.length<=S.MAX_PIGMENTS);assert(pigment.shares.length>0);
    s.paper.add(1,pigment,40);const before=s.encode();s.begin();s.paper.add(2,s.pigments.color(inks[1]),40);s.commit();
    assert(s.undo());assert.deepEqual(s.encode(),before);assert.equal(s.history.length,0);
    const invalid={...before,wax:{...before.wax,data:'!'}};s.history.push(invalid);
    assert.throws(()=>s.undo());assert.equal(s.history.length,1);assert.deepEqual(s.encode(),before);
  }
});
