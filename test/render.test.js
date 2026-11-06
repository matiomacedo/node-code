'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// The renderer needs a browser only for drawing, so drawing calls are no-ops here.
const noop = () => {};
const fakeCtx = () => new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : () => ({ addColorStop: noop })),
  set: (t, k, v) => { t[k] = v; return true; },
});
let queued = [];
Object.assign(globalThis, {
  document: { createElement: () => ({ getContext: fakeCtx }) },
  matchMedia: () => ({ matches: false }),
  addEventListener: noop,
  requestAnimationFrame: (cb) => { queued.push(cb); return queued.length; },
  devicePixelRatio: 1,
  innerWidth: 1000,
  innerHeight: 800,
});
Object.defineProperty(globalThis, 'location', { value: { search: '' }, configurable: true });

let Renderer;
test.before(async () => { ({ Renderer } = await import('../web/render.js')); });

function make() {
  queued = [];
  const r = new Renderer({ getContext: fakeCtx });
  r.autoFit = false;
  return r;
}
const runFrame = () => {
  const cbs = queued;
  queued = [];
  for (const cb of cbs) cb(0);
};
const node = (id) => ({ id, kind: 'file', name: id, r: 3, parent: null });
const show = (r, ids, xy, { idle = true, alpha = 0 } = {}) => {
  const nodes = ids.map(node);
  r.applyPositions({ nodes, links: [] }, Float32Array.from(xy), idle, alpha);
};

test('an expired appear animation on an off-screen node ends and the render loop stops', () => {
  const r = make();
  show(r, ['far'], [100000, 100000]);
  r.born.set('far', performance.now() - 5000);
  runFrame();
  assert.equal(r.born.size, 0);
  assert.equal(queued.length, 0, 'no further frames requested');
});

test('an appear animation for a node that was removed ends and the render loop stops', () => {
  const r = make();
  show(r, ['here'], [0, 0]);
  r.born.set('gone', performance.now());
  runFrame();
  assert.equal(r.born.size, 0);
  assert.equal(queued.length, 0);
});

test('an appear animation still running on an on-screen node keeps drawing', () => {
  const r = make();
  show(r, ['here'], [0, 0]);
  r.born.set('here', performance.now());
  runFrame();
  assert.equal(r.born.size, 1);
  assert.equal(queued.length, 1);
});

test('a jump to a node the worker has not returned yet lands when it arrives', () => {
  const r = make();
  show(r, ['a'], [0, 0]);
  r.focusOn('later');
  runFrame();
  assert.ok(r.focus, 'focus survives a frame without the target');
  show(r, ['a', 'later'], [0, 0, 500, 300]);
  r.focus.until = 0;
  runFrame();
  assert.equal(r.focus, null);
  assert.equal(r.cam.x, 500);
  assert.equal(r.cam.y, 300);
});

test('a jump to a node that never arrives gives up and the render loop stops', () => {
  const r = make();
  show(r, ['a'], [0, 0]);
  r.focusOn('never');
  r.focus.giveUpAt = 0;
  runFrame();
  assert.equal(r.focus, null);
  assert.equal(queued.length, 0);
});

test('auto-fit stops once the first layout has cooled, so ambient motion cannot keep moving the camera', () => {
  const r = make();
  r.autoFit = true;
  show(r, ['a', 'b'], [0, 0, 100, 100], { idle: false, alpha: 0.5 });
  runFrame();
  assert.equal(r.autoFit, true, 'still fitting while the layout is hot');
  show(r, ['a', 'b'], [0, 0, 100, 100], { idle: false, alpha: 0.03 });
  runFrame();
  assert.equal(r.autoFit, false);
});

test('a running layout redraws only when new positions arrive', () => {
  const r = make();
  show(r, ['a'], [0, 0], { idle: false, alpha: 0.03 });
  runFrame();
  assert.equal(queued.length, 0, 'no frame until the worker sends positions');
  show(r, ['a'], [1, 1], { idle: false, alpha: 0.03 });
  assert.equal(queued.length, 1);
});

test('hover lookups rebuild the hit grid at most once per position update', () => {
  const r = make();
  let builds = 0;
  const build = r.buildGrid.bind(r);
  r.buildGrid = () => { builds++; build(); };
  show(r, ['a'], [0, 0]);
  r.nodeAt(500, 400);
  r.nodeAt(501, 400);
  assert.equal(builds, 1);
  show(r, ['a'], [5, 0]);
  r.nodeAt(500, 400);
  assert.equal(builds, 2);
  assert.equal(r.nodeAt(505, 400)?.id, 'a');
});

// Overlays and themes -------------------------------------------------------
let THEMES; let SPRITE_KEYS; let resolveIds; let dimMask;
test.before(async () => {
  ({ THEMES, SPRITE_KEYS } = await import('../web/theme.js'));
  ({ resolveIds, dimMask } = await import('../web/render.js'));
});

// A context that records the alpha each node sprite is drawn with.
const recordingCtx = (log) => () => new Proxy({ globalAlpha: 1 }, {
  get: (t, k) => {
    if (k === 'drawImage') return () => log.push(t.globalAlpha);
    return k in t ? t[k] : () => ({ addColorStop: noop });
  },
  set: (t, k, v) => { t[k] = v; return true; },
});

test('both themes define the same keys, including every key the app relies on', () => {
  const required = ['bg', 'edge', 'edgeDim', 'label', 'labelDim', 'folder', 'file', 'more', 'reading', 'editing',
    'created', 'failed', 'imports', 'importedBy', 'selected', 'hover', 'blast', 'path', 'cycles', 'hubs', 'orphans', 'trail'];
  assert.deepEqual(Object.keys(THEMES.light).sort(), Object.keys(THEMES.dark).sort());
  for (const k of required) assert.ok(k in THEMES.dark, k);
  for (const name of ['dark', 'light']) {
    for (const k of SPRITE_KEYS) assert.match(THEMES[name][k], /^#[0-9a-f]{6}$/, `${name}.${k} must be 6-digit hex`);
  }
});

test('the dark theme keeps the original palette', () => {
  const d = THEMES.dark;
  assert.equal(d.bg, '#0a0a12');
  assert.equal(d.glow, 1);
  assert.deepEqual([d.folder, d.file, d.more, d.reading, d.editing, d.created, d.failed],
    ['#8d82d6', '#6283bd', '#5a5a78', '#5cb6ff', '#f2bb63', '#62dcab', '#f26d80']);
  assert.equal(d.imports, 'rgba(92,182,255,0.75)');
  assert.equal(d.importedBy, 'rgba(192,140,240,0.75)');
});

test('resolveIds keeps input order and drops ids that are not in the graph', () => {
  const indexOf = new Map([['a', 0], ['b', 1], ['c', 2]]);
  assert.deepEqual([...resolveIds(indexOf, ['c', 'x', 'a'])], [2, 0]);
  assert.deepEqual([...dimMask([node('a'), node('b')], new Set(['b', 'z']))], [0, 1]);
});

test('overlays given before their nodes exist attach once the graph arrives', () => {
  const r = make();
  show(r, ['a'], [0, 0]);
  r.setHighlight('path', ['a', 'b']);
  r.setTrail(['b', 'a']);
  r.setDim(new Set(['b']));
  assert.deepEqual([...r.highlights.get('path').idx], [0]);
  assert.deepEqual([...r.dimMask], [0]);
  show(r, ['b', 'a'], [0, 0, 10, 10]);
  assert.deepEqual([...r.highlights.get('path').idx], [1, 0]);
  assert.deepEqual([...r.trailIdx], [0, 1]);
  assert.deepEqual([...r.dimMask], [1, 0]);
  runFrame();
  assert.equal(queued.length, 0, 'static overlays do not keep the loop running');
});

test('clearing overlays removes them and requests a redraw', () => {
  const r = make();
  show(r, ['a'], [0, 0]);
  r.setHighlight('blast', ['a'], '#ff0000');
  r.setHighlight('hubs', ['a']);
  runFrame();
  r.setHighlight('blast', null);
  assert.equal(queued.length, 1);
  assert.deepEqual([...r.highlights.keys()], ['hubs']);
  r.setDim(null);
  r.setTrail(null);
  assert.equal(r.dimMask, null);
  assert.equal(r.trailIdx, null);
});

test('dimmed nodes draw faintly while kept nodes keep their normal alpha', () => {
  const log = [];
  queued = [];
  const r = new Renderer({ getContext: recordingCtx(log) });
  r.autoFit = false;
  r.heatVisible = false;
  show(r, ['keep', 'fade'], [0, 0, 10, 0]);
  r.setDim(new Set(['keep']));
  runFrame();
  assert.deepEqual(log, [0.8, 0.15]);
});

test('switching theme rebuilds sprites and unknown names fall back to dark', () => {
  const r = make();
  const before = r.sprites.file;
  r.setTheme('light');
  assert.equal(r.themeName, 'light');
  assert.notEqual(r.sprites.file, before);
  r.setTheme('neon');
  assert.equal(r.themeName, 'dark');
});

test('PNG export renders offscreen at 2x and leaves the live canvas alone', async () => {
  const r = make();
  show(r, ['a', 'b'], [0, 0, 10, 10]);
  r.setHighlight('path', ['a', 'b']);
  r.setTrail(['a', 'b']);
  const live = { canvas: r.canvas, ctx: r.ctx, dpr: r.dpr };
  const create = document.createElement;
  let off;
  document.createElement = () => (off = { getContext: fakeCtx, toBlob: (cb) => cb('blob') });
  try {
    assert.equal(await r.exportPNG(), 'blob');
  } finally {
    document.createElement = create;
  }
  assert.equal(off.width, 2000);
  assert.equal(off.height, 1600);
  assert.deepEqual({ canvas: r.canvas, ctx: r.ctx, dpr: r.dpr }, live);
});
