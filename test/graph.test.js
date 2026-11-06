'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dependents, shortestPath, cycles, insights } = require('../server/graph');

// Builds deps and importedBy the way App.onIndexed does from {file: [targets]}.
function graphOf(edges) {
  const deps = new Map();
  const importedBy = new Map();
  for (const [rel, targets] of Object.entries(edges)) {
    deps.set(rel, { imports: targets.map((t) => ({ spec: t, targets: [t] })) });
    for (const t of targets) {
      if (!importedBy.has(t)) importedBy.set(t, new Set());
      importedBy.get(t).add(rel);
    }
  }
  return { deps, importedBy };
}

test('dependents lists transitive importers with their depth', () => {
  const { importedBy } = graphOf({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'], 'd.ts': ['c.ts'], 'c.ts': [] });
  const out = dependents('c.ts', importedBy);
  assert.deepEqual(out.dependents.sort((x, y) => x.path.localeCompare(y.path)), [
    { path: 'a.ts', depth: 2 }, { path: 'b.ts', depth: 1 }, { path: 'd.ts', depth: 1 },
  ]);
  assert.equal(out.truncated, false);
});

test('dependents stops at the cap and survives cycles', () => {
  const { importedBy } = graphOf({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'], 'c.ts': ['a.ts'] });
  assert.deepEqual(dependents('a.ts', importedBy).dependents.map((d) => d.path).sort(), ['b.ts', 'c.ts']);
  const capped = dependents('a.ts', importedBy, 1);
  assert.equal(capped.dependents.length, 1);
  assert.equal(capped.truncated, true);
});

test('cycles finds groups of two or more and ignores self-imports', () => {
  const { deps } = graphOf({
    'a.ts': ['b.ts'], 'b.ts': ['c.ts'], 'c.ts': ['a.ts'],
    'x.ts': ['y.ts'], 'y.ts': ['x.ts'],
    'self.ts': ['self.ts'], 'leaf.ts': ['a.ts'],
  });
  assert.deepEqual(cycles(deps), [['a.ts', 'b.ts', 'c.ts'], ['x.ts', 'y.ts']]);
});

test('cycles handles a long chain without overflowing the stack', () => {
  const edges = {};
  const n = 50000;
  for (let i = 0; i < n; i++) edges[`f${i}`] = [`f${(i + 1) % n}`];
  assert.equal(cycles(graphOf(edges).deps)[0].length, n);
});

test('shortestPath follows import edges both ways and marks each hop', () => {
  const { deps, importedBy } = graphOf({ 'a.ts': ['b.ts'], 'c.ts': ['b.ts'], 'c2.ts': ['c.ts'] });
  assert.deepEqual(shortestPath('a.ts', 'c2.ts', deps, importedBy), [
    { path: 'a.ts', dir: null },
    { path: 'b.ts', dir: 'imports' },
    { path: 'c.ts', dir: 'importedBy' },
    { path: 'c2.ts', dir: 'importedBy' },
  ]);
  assert.deepEqual(shortestPath('b.ts', 'a.ts', deps, importedBy), [{ path: 'b.ts', dir: null }, { path: 'a.ts', dir: 'importedBy' }]);
  assert.deepEqual(shortestPath('a.ts', 'a.ts', deps, importedBy), [{ path: 'a.ts', dir: null }]);
});

test('shortestPath returns null when the files are not connected', () => {
  const { deps, importedBy } = graphOf({ 'a.ts': ['b.ts'], 'x.ts': [] });
  assert.equal(shortestPath('a.ts', 'x.ts', deps, importedBy), null);
});

test('insights ranks hubs and lists orphans, leaving out tests and unindexed files', () => {
  const { deps, importedBy } = graphOf({
    'a.ts': ['hub.ts'], 'b.ts': ['hub.ts', 'small.ts'], 'hub.ts': [], 'small.ts': [],
    'lonely.ts': [], 'lonely.test.ts': [], 'gone.ts': [],
  });
  const files = new Set(['a.ts', 'b.ts', 'hub.ts', 'small.ts', 'lonely.ts', 'lonely.test.ts', 'readme.md']);
  const out = insights(deps, importedBy, files);
  assert.deepEqual(out.hubs, [{ path: 'hub.ts', count: 2 }, { path: 'small.ts', count: 1 }]);
  assert.deepEqual(out.orphans, ['lonely.ts']);
  assert.deepEqual(out.cycles, []);
});
