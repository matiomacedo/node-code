'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let Tree;
let visibleIn;
test.before(async () => { ({ Tree, visibleIn } = await import('../web/tree.js')); });

const make = (paths, opts) => {
  const t = new Tree(opts);
  t.setFiles(paths.map((p) => [p, 1]));
  return t;
};
const ids = (t) => t.visible().nodes.map((n) => n.id);

test('small repo: every folder and file is visible, linked to its parent', () => {
  const t = make(['a/b/c.ts', 'a/d.ts', 'e.ts']);
  assert.deepEqual(ids(t).sort(), ['.', 'a', 'a/b', 'a/b/c.ts', 'a/d.ts', 'e.ts'].sort());
  const { nodes, links } = t.visible();
  const edges = links.map(([s, d]) => `${nodes[s].id}>${nodes[d].id}`).sort();
  assert.deepEqual(edges, ['.>a', '.>e.ts', 'a/b>a/b/c.ts', 'a>a/b', 'a>a/d.ts'].sort());
});

test('large repo: default view stays within budget, collapsing deep folders first', () => {
  const paths = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) for (let k = 0; k < 20; k++) paths.push(`d${i}/s${j}/f${k}.ts`);
  const t = make(paths, { budget: 2000, initialBudget: 1500 });
  const { nodes } = t.visible();
  assert.ok(nodes.length <= 1500, `${nodes.length}`);
  assert.ok(nodes.some((n) => n.id === 'd0'));
  const collapsed = nodes.filter((n) => n.kind === 'folder' && !n.expanded);
  assert.ok(collapsed.length > 0);
  assert.equal(collapsed[0].count, 20);
});

test('a folder over the page size shows a "more" node, and showing more grows the page', () => {
  const paths = Array.from({ length: 450 }, (_, i) => `big/f${String(i).padStart(3, '0')}.ts`);
  const t = make(paths, { page: 200 });
  let nodes = t.visible().nodes;
  const more = nodes.find((n) => n.kind === 'more');
  assert.equal(more.count, 250);
  assert.equal(nodes.filter((n) => n.kind === 'file').length, 200);
  t.showMore(more.parent);
  nodes = t.visible().nodes;
  assert.equal(nodes.filter((n) => n.kind === 'file').length, 400);
  assert.equal(nodes.find((n) => n.kind === 'more').count, 50);
});

test('expanding past the budget collapses the least recently used folders', () => {
  const paths = [];
  for (let i = 0; i < 5; i++) for (let k = 0; k < 100; k++) paths.push(`d${i}/f${k}.ts`);
  const t = make(paths, { budget: 250, initialBudget: 10 });
  t.expand('d0');
  t.expand('d1');
  t.expand('d2');
  assert.ok(t.visible().nodes.length <= 250);
  assert.ok(t.expanded.has('d2'), 'newest stays open');
  assert.ok(!t.expanded.has('d0'), 'oldest closes');
});

test('reveal opens every ancestor without closing them to fit the budget', () => {
  const paths = [];
  for (let i = 0; i < 5; i++) for (let k = 0; k < 100; k++) paths.push(`p/d${i}/q/f${k}.ts`);
  const t = make(paths, { budget: 150, initialBudget: 2 });
  t.reveal('p/d3/q/f7.ts');
  assert.ok(ids(t).includes('p/d3/q/f7.ts'));
});

test('reveal makes a file visible even when it is beyond the page', () => {
  const paths = Array.from({ length: 450 }, (_, i) => `big/f${String(i).padStart(3, '0')}.ts`);
  const t = make(paths, { page: 200 });
  assert.ok(!ids(t).includes('big/f400.ts'));
  t.reveal('big/f400.ts');
  assert.ok(ids(t).includes('big/f400.ts'));
});

test('nearestVisible walks up to the closest shown ancestor', () => {
  const t = make(['a/b/c.ts', 'x.ts']);
  t.collapse('a/b');
  assert.equal(t.nearestVisible('a/b/c.ts'), 'a/b');
  t.collapse('a');
  assert.equal(t.nearestVisible('a/b/c.ts'), 'a');
  assert.equal(t.nearestVisible('x.ts'), 'x.ts');
  assert.equal(t.nearestVisible('missing/nope.ts'), '.');
});

test('a collapsed root cannot happen and collapsed folders report descendant counts', () => {
  const t = make(['a/b/c.ts', 'a/d.ts']);
  t.collapse('.');
  assert.ok(t.expanded.has('.'));
  t.collapse('a');
  assert.equal(t.visible().nodes.find((n) => n.id === 'a').count, 2);
});

test('adding and removing files keeps folders in sync and prunes empty ones', () => {
  const t = make(['a/b.ts']);
  t.addFile('n/m/new.ts', 3);
  assert.ok(ids(t).includes('n/m/new.ts'));
  t.removeFile('n/m/new.ts');
  assert.ok(!ids(t).includes('n'));
  assert.ok(!t.folders.has('n/m'));
  t.removeFile('a/b.ts');
  assert.deepEqual(ids(t), ['.']);
});

test('a new file in a folder that was fully open is shown', () => {
  const t = make(['a/b.ts']);
  t.addFile('a/c.ts', 1);
  assert.ok(ids(t).includes('a/c.ts'));
});

test('setFiles keeps the user expansion state', () => {
  const t = make(['a/b.ts', 'c/d.ts']);
  t.collapse('a');
  t.setFiles([['a/b.ts', 1], ['c/d.ts', 1], ['c/e.ts', 1]]);
  assert.ok(!t.expanded.has('a'));
  assert.ok(t.expanded.has('c'));
});

test('heat rolls up to collapsed ancestors', () => {
  const t = make(['a/b/c.ts', 'a/d.ts']);
  t.setHeat('a/b/c.ts', 3);
  t.setHeat('a/d.ts', 2);
  assert.equal(t.heatOf('a/b/c.ts'), 3);
  t.collapse('a');
  assert.equal(t.heatOf('a'), 5);
  t.setHeat('a/d.ts', 0);
  assert.equal(t.heatOf('a'), 3);
  t.clearHeat();
  assert.equal(t.heatOf('a'), 0);
});

test('visibleIn agrees with nearestVisible for the ids visible() returns', () => {
  const t = make(['a/b/c.ts', 'a/b/d.ts', 'a/e.ts', 'f.ts']);
  t.collapse('a/b');
  const shown = new Set(t.visible().nodes.map((n) => n.id));
  for (const p of [...t.files.keys(), ...t.folders.keys()]) assert.equal(visibleIn(p, shown), t.nearestVisible(p), p);
});
