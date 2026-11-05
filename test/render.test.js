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
