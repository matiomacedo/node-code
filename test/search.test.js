'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let fuzzyMatch, rankPaths, extOf, topExtensions, fileFilter;
test.before(async () => { ({ fuzzyMatch, rankPaths, extOf, topExtensions, fileFilter } = await import('../web/search.js')); });

test('fuzzyMatch needs every query character in order, ignoring case', () => {
  assert.ok(fuzzyMatch('APJ', 'web/app.js'));
  assert.equal(fuzzyMatch('jpa', 'web/app.js'), null);
  assert.equal(fuzzyMatch('', 'web/app.js'), null);
  assert.equal(fuzzyMatch('xyz', 'web/app.js'), null);
});

test('fuzzyMatch returns the matched positions', () => {
  const m = fuzzyMatch('app', 'web/app.js');
  assert.deepEqual(m.positions, [4, 5, 6]);
});

test('a file name match ranks above the same letters spread over folders', () => {
  const ranked = rankPaths('tree', ['test/render/each/eval.js', 'web/tree.js', 'tools/really/empty/eggs.ts']).map((h) => h.path);
  assert.equal(ranked[0], 'web/tree.js');
});

test('an exact file name beats a longer name that starts with it', () => {
  const ranked = rankPaths('app.js', ['web/apple.js', 'web/app.js']).map((h) => h.path);
  assert.deepEqual(ranked, ['web/app.js', 'web/apple.js']);
});

test('rankPaths keeps only the best results up to the limit', () => {
  const paths = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
  assert.equal(rankPaths('file', paths).length, 20);
  assert.equal(rankPaths('file', paths, 5).length, 5);
  assert.deepEqual(rankPaths('zzz', paths), []);
});

test('extOf reads the last extension and ignores dotfiles', () => {
  assert.equal(extOf('a/b/c.test.TS'), 'ts');
  assert.equal(extOf('a/.env'), '');
  assert.equal(extOf('Makefile'), '');
  assert.equal(extOf('a.b/c'), '');
});

test('topExtensions orders by count and caps the list', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts', 'd.js', 'e.js', 'f.md', 'Makefile'];
  assert.deepEqual(topExtensions(paths), ['ts', 'js', 'md']);
  assert.deepEqual(topExtensions(paths, 2), ['ts', 'js']);
});

test('fileFilter is null when nothing filters', () => {
  assert.equal(fileFilter({}), null);
});

test('fileFilter combines extension and status', () => {
  const stats = new Map([
    ['a.ts', { reads: 1, edits: 0, fails: 0 }],
    ['b.ts', { reads: 0, edits: 2, fails: 0 }],
    ['c.js', { reads: 0, edits: 0, fails: 1 }],
  ]);
  const keep = (opts) => ['a.ts', 'b.ts', 'c.js', 'd.ts'].filter(fileFilter({ stats, ...opts }));
  assert.deepEqual(keep({ exts: new Set(['ts']) }), ['a.ts', 'b.ts', 'd.ts']);
  assert.deepEqual(keep({ status: 'touched' }), ['a.ts', 'b.ts', 'c.js']);
  assert.deepEqual(keep({ status: 'read' }), ['a.ts']);
  assert.deepEqual(keep({ status: 'edited', exts: new Set(['ts']) }), ['b.ts']);
  assert.deepEqual(keep({ status: 'failed' }), ['c.js']);
  assert.deepEqual(keep({ scoped: true }), ['a.ts', 'b.ts', 'c.js']);
});
