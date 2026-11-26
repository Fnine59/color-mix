const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '../site/style.css'), 'utf8');

const media = '@media(max-width:800px)';
const container = '@container(max-width:740px)';
const firefox = '@supports not selector(::-webkit-scrollbar)';
const contexts = [[], [media], [container], [media, container]];
const queryKey = query => query.trim().replace(/\s+/g, ' ')
  .replace(/\s*([():])\s*/g, '$1');

// Split lists/declarations without splitting commas in functions or quoted text.
function split(text, separator) {
  const parts = [];
  let start = 0, depth = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === separator && !depth) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}
const valueKey = value => value.trim().replace(/\s+/g, ' ')
  .replace(/\s*,\s*/g, ',').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');

// Keep qualified rules in source order, including repeated grouping blocks.
// This is a contract parser for the site's simple selectors, not a CSSOM/DOM.
function rules(source = css) {
  const result = [];
  function visit(text, parents = []) {
    const pattern = /([^{}]+)\{/g;
    let match;
    while ((match = pattern.exec(text))) {
      const selector = match[1].trim();
      let end = pattern.lastIndex, depth = 1, quote = '';
      while (depth && end < text.length) {
        const char = text[end];
        if (quote) {
          if (char === '\\') end++;
          else if (char === quote) quote = '';
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '{') depth++;
        else if (char === '}') depth--;
        end++;
      }
      assert.equal(depth, 0, 'balanced CSS blocks');
      const body = text.slice(pattern.lastIndex, end - 1);
      if (selector.startsWith('@')) visit(body, [...parents, queryKey(selector)]);
      else {
        const declarations = split(body, ';').map(declaration => {
          const colon = declaration.indexOf(':');
          assert.ok(colon > 0, `valid declaration: ${declaration}`);
          const property = declaration.slice(0, colon).trim().toLowerCase();
          const raw = declaration.slice(colon + 1).trim();
          const important = /!\s*important\s*$/i.test(raw);
          return {property, value: valueKey(raw.replace(/!\s*important\s*$/i, '')), important};
        });
        result.push({selectors: split(selector, ',').map(value => value.replace(/\s+/g, ' ')),
          declarations, parents});
      }
      pattern.lastIndex = end;
    }
  }
  visit(source.replace(/\/\*[\s\S]*?\*\//g, ''));
  return result;
}

// Enumerate matching base selectors for the protected compound/descendant/state
// selectors. These are matches on the SAME element, not inherited properties.
function matchingSelectors(selector) {
  const bases = {
    '.settings-body .palette-list': ['.palette-list'],
    '.paint-colors.recipe-colors': ['.paint-colors', '.recipe-colors'],
    '.paint-workspace canvas': ['canvas'],
    '.paint-colors button': ['button'],
    '.paint-colors.recipe-colors button span:last-child': ['.paint-colors button span:last-child'],
    'button:focus-visible': ['button'],
    'input:focus-visible': ['input'],
  };
  const thumb = selector.replace(/:(?:hover|active)$/, '');
  return [...(selector.includes('::') ? [] : ['*']), ...(bases[selector] || []),
    ...(thumb !== selector ? [thumb] : []), selector];
}

function specificity(selector) {
  let types = 0, classes = 0, ids = 0;
  const rest = selector.replace(/::[\w-]+/g, () => { types++; return ''; })
    .replace(/#[\w-]+/g, () => { ids++; return ''; })
    .replace(/\.[\w-]+|:[\w-]+|\[[^\]]+\]/g, () => { classes++; return ''; });
  types += (rest.match(/[a-z][\w-]*/gi) || []).length;
  return ids * 100 + classes * 10 + types;
}

// Expand the shorthands used by protected properties so a later shorthand OR
// longhand cannot leave a stale "correct" declaration in the result.
function expand(property, value) {
  const out = {[property]: value};
  const words = value.split(' ');
  const box = (prefix, suffix = '') => {
    const [a, b = a, c = a, d = b] = words;
    for (const [side, part] of [['top', a], ['right', b], ['bottom', c], ['left', d]])
      out[`${prefix}-${side}${suffix}`] = part;
  };
  if (property === 'padding' || property === 'margin') box(property);
  if (property === 'border-radius') {
    const [a, b = a, c = a, d = b] = words;
    for (const [corner, part] of [['top-left', a], ['top-right', b], ['bottom-right', c], ['bottom-left', d]])
      out[`border-${corner}-radius`] = part;
  }
  if (property === 'overflow' || property === 'overscroll-behavior') {
    out[property + '-x'] = words[0];
    out[property + '-y'] = words[1] || words[0];
  }
  if (property === 'scroll-padding-block') {
    out['scroll-padding-block-start'] = words[0];
    out['scroll-padding-block-end'] = words[1] || words[0];
  }
  if (property === 'background') out['background-color'] = value;
  if (/^border-(width|style|color)$/.test(property)) box('border', '-' + property.slice(7));
  if (property === 'border' || /^border-(top|right|bottom|left)$/.test(property)) {
    const sides = property === 'border' ? ['top', 'right', 'bottom', 'left'] : [property.slice(7)];
    for (const side of sides) {
      out[`border-${side}-width`] = words[0];
      out[`border-${side}-style`] = words[1] || 'none';
      out[`border-${side}-color`] = words.slice(2).join(' ') || 'currentcolor';
    }
  }
  if (property === 'outline') {
    out['outline-width'] = words[0];
    out['outline-style'] = words[1] || 'none';
    out['outline-color'] = words.slice(2).join(' ') || 'currentcolor';
  }
  return out;
}

function cascade(parsed, selector, active = []) {
  const matches = matchingSelectors(selector);
  const enabled = active.map(queryKey);
  const winners = new Map();
  for (const rule of parsed) {
    if (!rule.parents.every(parent => enabled.includes(parent))) continue;
    const selectors = rule.selectors.filter(candidate => matches.includes(candidate));
    if (!selectors.length) continue;
    const rank = Math.max(...selectors.map(specificity));
    for (const {property, value, important} of rule.declarations) {
      for (const [longhand, expanded] of Object.entries(expand(property, value))) {
        const previous = winners.get(longhand);
        if (!previous || Number(important) > Number(previous.important) ||
            (important === previous.important && rank >= previous.rank))
          winners.set(longhand, {value: expanded, important, rank});
      }
    }
  }
  return Object.fromEntries([...winners].map(([property, declaration]) => [property, declaration.value]));
}

function expectValues(parsed, selector, active, expected) {
  const actual = cascade(parsed, selector, active);
  for (const [property, value] of Object.entries(expected))
    assert.equal(actual[property], value, `${active.join(' + ') || 'desktop'} ${selector} ${property}`);
  return actual;
}
function expectRadius(parsed, selector, active, radius) {
  expectValues(parsed, selector, active, Object.fromEntries(
    ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map(corner => [`border-${corner}-radius`, radius])));
}

function checkScrollbars(parsed) {
  for (const active of contexts) for (const list of ['.paint-colors', '.palette-list']) {
    expectValues(parsed, list + '::-webkit-scrollbar', active, {width: '6px', height: '6px'});
    for (const suffix of ['track', 'corner'])
      expectValues(parsed, `${list}::-webkit-scrollbar-${suffix}`, active, {'background-color': 'transparent'});
    for (const [state, alpha] of [['', '.20'], [':hover', '.38'], [':active', '.55']]) {
      const thumb = list + '::-webkit-scrollbar-thumb' + state;
      expectValues(parsed, thumb, active, {'background-color': `rgba(50,94,69,${alpha})`});
      expectRadius(parsed, thumb, active, '999px');
    }
    expectValues(parsed, list + '::-webkit-scrollbar-button', active, {display: 'none', width: '0', height: '0'});
  }
}

function checkFallback(parsed) {
  const standard = parsed.filter(rule => rule.declarations.some(({property}) =>
    property === 'scrollbar-width' || property === 'scrollbar-color'));
  assert.ok(standard.length, 'Firefox fallback exists');
  for (const rule of standard) {
    assert.deepEqual(rule.parents, [queryKey(firefox)], 'standard scrollbar properties must be Firefox-only');
    assert.ok(rule.selectors.every(selector => ['.paint-colors', '.palette-list'].includes(selector)),
      'fallback targets only color lists');
  }
  for (const active of contexts) for (const selector of ['.paint-colors', '.palette-list'])
    expectValues(parsed, selector, [...active, firefox], {
      'scrollbar-width': 'thin', 'scrollbar-color': 'rgba(50,94,69,.20) transparent',
    });
}

function checkEnclosures(parsed) {
  for (const active of contexts) {
    for (const selector of ['.paint-colors', '.paint-colors.recipe-colors', '.palette-list', '.settings-body .palette-list']) {
      expectValues(parsed, selector, active, {
        'overflow-y': 'auto', 'overflow-x': 'hidden',
        'overscroll-behavior-x': 'contain', 'overscroll-behavior-y': 'contain',
        'scroll-padding-block-start': '8px', 'scroll-padding-block-end': '8px',
        'background-color': '#fafbf8',
      });
      for (const side of ['top', 'right', 'bottom', 'left'])
        expectValues(parsed, selector, active, {
          [`padding-${side}`]: '8px', [`border-${side}-width`]: '1px',
          [`border-${side}-style`]: 'solid', [`border-${side}-color`]: 'var(--line)',
        });
      expectRadius(parsed, selector, active, selector.includes('paint-colors') ? '10px' : '9px');
    }
    expectValues(parsed, '.paint-shelf', active, {display: 'grid', gap: '8px', 'min-width': '0'});
    expectValues(parsed, '#paint-count', active,
      Object.fromEntries(['top', 'right', 'bottom', 'left'].map(side => [`margin-${side}`, '0'])));
  }
}

function checkLayout(parsed) {
  for (const active of contexts) {
    for (const selector of ['.paint-colors', '.paint-colors.recipe-colors']) {
      expectValues(parsed, selector, active, {
        'max-height': active.length ? '170px' : '460px', height: undefined, 'min-height': undefined,
        display: 'grid', gap: '8px',
        'grid-template-columns': active.length ? 'repeat(2,minmax(0,1fr))' : undefined,
      });
    }
    expectValues(parsed, '.palette-list', active, {
      'max-height': active.includes(media) ? '230px' : '260px',
      display: 'grid', 'grid-template-columns': 'repeat(2,minmax(0,1fr))',
    });
    expectValues(parsed, '.settings-body .palette-list', active, {
      'max-height': active.includes(media) ? '230px' : '260px',
      'grid-template-columns': active.length ? 'repeat(2,minmax(0,1fr))' : 'repeat(4,minmax(0,1fr))',
    });
    expectValues(parsed, '.paint-workspace', active, {
      display: 'grid', 'grid-template-columns': active.length ? '1fr' : '190px minmax(0,1fr)',
    });
    expectValues(parsed, '.paint-workspace canvas', active, {'touch-action': 'none'});
    expectValues(parsed, '.paint-colors button', active, {'min-width': '0'});
    expectValues(parsed, '.paint-colors button span:last-child', active, {
      'min-width': '0', 'overflow-x': 'hidden', 'overflow-y': 'hidden',
      'text-overflow': 'ellipsis', 'white-space': 'nowrap',
    });
    expectValues(parsed, '.paint-colors.recipe-colors button span:last-child', active, {
      'min-width': '0', 'overflow-x': 'visible', 'overflow-y': 'visible',
      'white-space': 'normal', 'overflow-wrap': 'anywhere',
    });
  }
}

function checkFocus(parsed) {
  for (const active of contexts) for (const selector of ['button:focus-visible', 'input:focus-visible']) {
    expectValues(parsed, selector, active, {
      'outline-width': '3px', 'outline-style': 'solid', 'outline-color': '#bcb05a', 'outline-offset': '3px',
    });
  }
}

const checks = [
  ['both color lists share final narrow capsule scrollbars, transparent tracks and gentle state feedback', checkScrollbars],
  ['standard scrollbar properties are Firefox-only, never overriding Chrome WebKit styling', checkFallback],
  ['lists contain vertical scrolling, leave focus-ring breathing room and have a soft enclosure', checkEnclosures],
  ['desktop list grows by max-height only; media and container layouts stay compact and two-column', checkLayout],
  ['button and input focus-visible outlines survive the final uncommented cascade', checkFocus],
];
function validateCSS(source) {
  const parsed = rules(source);
  for (const [, check] of checks) check(parsed);
}
for (const [name, check] of checks) test(name, () => check(rules(css)));

test('cascade respects comma lists, declaration order, query order, specificity and important', () => {
  const first = '/* .paint-colors{max-height:1px} */ .paint-colors, .palette-list{max-height:460px;max-height:440px}';
  const narrow = '@media (max-width: 800px){.paint-colors{max-height:170px}}';
  const later = '.paint-colors{max-height:430px}';
  const repeated = '@media(max-width:800px){.paint-colors{max-height:160px;max-height:150px}}';
  assert.equal(cascade(rules(first), '.palette-list')['max-height'], '440px');
  assert.equal(cascade(rules(first + narrow + later), '.paint-colors', [media])['max-height'], '430px');
  assert.equal(cascade(rules(first + narrow + later + repeated), '.paint-colors', [media])['max-height'], '150px');
  assert.equal(cascade(rules(first + narrow + later + repeated), '.paint-colors')['max-height'], '430px');
  const both = `${first}${narrow}@container(max-width:740px){.paint-colors{max-height:140px}}${repeated}`;
  assert.equal(cascade(rules(both), '.paint-colors', [media, container])['max-height'], '150px');
  const specific = '.paint-colors.recipe-colors{max-height:400px}.paint-colors{max-height:460px}';
  assert.equal(cascade(rules(specific), '.paint-colors.recipe-colors')['max-height'], '400px');
  const important = '.paint-colors{max-height:460px!important;max-height:230px}';
  assert.equal(cascade(rules(important), '.paint-colors')['max-height'], '460px');
});

test('validation accepts corrected final declarations rather than rejecting all earlier conflicts', () => {
  validateCSS(css + `
    .paint-colors,.palette-list{overflow-x:auto;overflow-x:hidden}
    .palette-list::-webkit-scrollbar-track{background:#ccc;background:transparent}
    @media(max-width:800px){.paint-colors{max-height:460px;max-height:170px}}
    @container(max-width:740px){.paint-colors{max-height:460px;max-height:170px}}
    .paint-colors::-webkit-scrollbar-thumb{background:rgba(50,94,69,.20)}
    .paint-colors button span:last-child{overflow:hidden}
    button:focus-visible{outline:none;outline:3px solid #bcb05a;outline-offset:3px}
  `);
});

// All mutations stay in memory and run the same complete validator as the real
// stylesheet. Assert the diagnostic too, so unrelated failures cannot mask a
// regression that the intended contract still fails to detect.
const lateMutations = [
  ['desktop max-height', '.paint-colors{max-height:230px}', /max-height/],
  ['top-level height cap after narrow queries', '.paint-colors{max-height:460px}', /max-height/],
  ['fixed height', '.paint-colors{height:460px}', /height/],
  ['minimum height', '.paint-colors{min-height:460px}', /min-height/],
  ['both opaque tracks', '.paint-colors::-webkit-scrollbar-track,.palette-list::-webkit-scrollbar-track{background:#ccc}', /background-color/],
  ['single list horizontal overflow', '.paint-colors{overflow-x:auto}', /overflow-x/],
  ['single opaque track', '.palette-list::-webkit-scrollbar-track{background:#ccc}', /background-color/],
  ['comma list with comments and whitespace', '.paint-colors /* list */, .palette-list{overflow-x:auto}', /overflow-x/],
  ['later declaration in one rule', '.paint-colors{overflow-x:hidden;overflow-x:auto}', /overflow-x/],
  ['overflow shorthand', '.paint-colors{overflow:auto}', /overflow-x/],
  ['background longhand', '.palette-list::-webkit-scrollbar-track{background-color:#ccc}', /background-color/],
  ['recipe fixed height', '.paint-colors.recipe-colors{height:460px}', /height/],
  ['recipe minimum height', '.recipe-colors{min-height:460px}', /min-height/],
  ['recipe max-height', '.paint-colors.recipe-colors{max-height:230px}', /max-height/],
  ['recipe scrolling', '.paint-colors.recipe-colors{overflow-y:hidden}', /overflow-y/],
  ['settings columns', '.settings-body .palette-list{grid-template-columns:1fr}', /grid-template-columns/],
  ['settings horizontal overflow', '.settings-body .palette-list{overflow-x:auto}', /overflow-x/],
  ['palette max-height', '.palette-list{max-height:460px}', /max-height/],
  ['palette padding', '.palette-list{padding-left:0}', /padding-left/],
  ['paint list border', '.paint-colors{border-width:0}', /border-top-width/],
  ['paint list radius', '.paint-colors{border-radius:0}', /border-top-left-radius/],
  ['shelf gap', '.paint-shelf{gap:0}', /gap/],
  ['count margin', '#paint-count{margin:8px}', /margin-top/],
  ['workspace columns', '.paint-workspace{grid-template-columns:1fr}', /grid-template-columns/],
  ['canvas touch action', '.paint-workspace canvas{touch-action:auto}', /touch-action/],
  ['button minimum width', '.paint-colors button{min-width:100px}', /min-width/],
  ['label clipping', '.paint-colors button span:last-child{overflow:visible}', /overflow-x/],
  ['recipe label wrapping', '.paint-colors.recipe-colors button span:last-child{white-space:nowrap}', /white-space/],
  ['button focus outline', 'button:focus-visible{outline:none}', /outline-width/],
  ['input focus outline', 'input:focus-visible{outline:none}', /outline-width/],
  ['focus outline style longhand', 'button:focus-visible{outline-style:none}', /outline-style/],
  ['invisible focus outline color', 'button:focus-visible{outline-color:transparent}', /outline-color/],
  ['focus outline offset', 'input:focus-visible{outline-offset:0}', /outline-offset/],
  ['unguarded standard width', '.paint-colors{scrollbar-width:thin}', /Firefox-only/],
  ['unguarded standard color', '.unrelated{scrollbar-color:red blue}', /Firefox-only/],
  ['wrong supports guard', '@supports(display:grid){.paint-colors{scrollbar-width:thin}}', /Firefox-only/],
  ['late Firefox fallback', `${firefox}{.paint-colors{scrollbar-color:red blue}}`, /scrollbar-color/],
];
for (const [suffix, declarations, diagnostic] of [
  ['', 'width:12px', /width/],
  ['-thumb', 'background:#ccc', /background-color/],
  ['-thumb', 'border-radius:0', /border-top-left-radius/],
  ['-thumb:hover', 'background:#ccc', /background-color/],
  ['-thumb:active', 'background:#ccc', /background-color/],
  ['-button', 'display:block', /display/],
  ['-corner', 'background:#ccc', /background-color/],
]) for (const list of ['.paint-colors', '.palette-list'])
  lateMutations.push([`${list} scrollbar${suffix} ${declarations}`,
    `${list}::-webkit-scrollbar${suffix}{${declarations}}`, diagnostic]);

for (const query of [media, container]) for (const [name, rule, diagnostic] of [
  ['max-height', '.paint-colors{max-height:460px}', /max-height/],
  ['height', '.paint-colors{height:170px}', /height/],
  ['min-height', '.paint-colors{min-height:170px}', /min-height/],
  ['recipe height', '.paint-colors.recipe-colors{height:170px}', /height/],
  ['columns', '.paint-colors{grid-template-columns:1fr}', /grid-template-columns/],
  ['workspace', '.paint-workspace{grid-template-columns:190px minmax(0,1fr)}', /grid-template-columns/],
  ['settings', '.settings-body .palette-list{grid-template-columns:repeat(4,minmax(0,1fr))}', /grid-template-columns/],
  ['track', '.palette-list::-webkit-scrollbar-track{background:#ccc}', /background-color/],
  ['focus', 'input:focus-visible{outline:none}', /outline-width/],
  ['standard width', '.paint-colors{scrollbar-width:thin}', /Firefox-only/],
]) lateMutations.push([`${query} late ${name}`, `${query}{${rule}}`, diagnostic]);

for (const [name, addition, diagnostic] of lateMutations)
  test(`in-memory negative: rejects ${name}`, () => {
    assert.throws(() => validateCSS(css + '\n' + addition), {name: 'AssertionError', message: diagnostic});
  });

const realFocus = 'outline:3px solid #bcb05a;outline-offset:3px';
for (const [name, mutate] of [
  ['focus declarations present only in a comment', source =>
    source.replace(realFocus, 'outline:none') + `\n/* ${realFocus} */`],
  ['focus declarations belong to an unrelated selector', source =>
    source.replace(realFocus, 'outline:none') + `\n.unrelated{${realFocus}}`],
  ['guarded standard properties also nested in a media query', source =>
    source + `\n${media}{${firefox}{.paint-colors{scrollbar-width:thin}}}`],
]) test(`in-memory negative: rejects ${name}`, () => {
  const mutant = mutate(css);
  assert.notEqual(mutant, css, 'mutation must change the source');
  assert.throws(() => validateCSS(mutant), {
    name: 'AssertionError', message: name.startsWith('focus') ? /outline-width/ : /Firefox-only/,
  });
});

test('scrollbar polish remains offline and preserves recipe/show-all/search wiring', () => {
  assert.doesNotMatch(css, /@import|url\s*\(|https?:\/\/|(?:10|192\.168)\.\d+\.\d+\.\d+/i);
  const ui = fs.readFileSync(path.join(__dirname, '../site/palette-ui.js'), 'utf8');
  assert.match(ui, /available = shelfRecipe \? shelfRecipe\.paints : colors/);
  assert.match(ui, /'paint-colors' \+ \(shelfRecipe \? ' recipe-colors' : ''\)/);
  assert.match(ui, /'paint-search'\)\.addEventListener\('input', list\)/);
  assert.match(ui, /'paint-show-all'\)\.onclick = \(\) => \{ shelfRecipe = null/);
});
