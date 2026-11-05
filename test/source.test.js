'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readSource, parseUnifiedDiff, MAX_SIZE } = require('../server/source');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });

test('parseUnifiedDiff splits hunks and ignores headers and no-newline markers', () => {
  const out = parseUnifiedDiff([
    'diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x',
    '@@ -1,2 +1,2 @@', ' keep', '-old', '+new', '\\ No newline at end of file',
    '@@ -10 +10,2 @@ fn', ' ctx', '+added', '',
  ].join('\n'));
  assert.deepEqual(out, [
    { oldStart: 1, newStart: 1, lines: [{ op: ' ', text: 'keep' }, { op: '-', text: 'old' }, { op: '+', text: 'new' }] },
    { oldStart: 10, newStart: 10, lines: [{ op: ' ', text: 'ctx' }, { op: '+', text: 'added' }] },
  ]);
});

test('readSource in a git repo: modified, clean, untracked, odd names', async () => {
  const root = tmp('nc-src-git-');
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'clean.txt'), 'same\n');
  fs.writeFileSync(path.join(root, '*.txt'), 'star\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'fresh\n');

  const a = await readSource(root, 'a.txt');
  assert.equal(a.text, 'one\nTWO\n');
  assert.equal(a.diff.untracked, false);
  assert.deepEqual(a.diff.hunks[0].lines.map((l) => l.op + l.text), [' one', '-two', '+TWO']);

  assert.deepEqual((await readSource(root, 'clean.txt')).diff, { untracked: false, hunks: [] });
  assert.deepEqual((await readSource(root, 'new.txt')).diff, { untracked: true, hunks: [] });
  // A literal pathspec: '*.txt' must not match a.txt's changes.
  assert.deepEqual((await readSource(root, '*.txt')).diff.hunks, []);
});

test('readSource outside git, before the first commit, binary and oversized files', async () => {
  const plain = tmp('nc-src-plain-');
  fs.writeFileSync(path.join(plain, 'a.txt'), 'hi');
  assert.deepEqual(await readSource(plain, 'a.txt'), { text: 'hi', binary: false, truncated: false, diff: null });

  const empty = tmp('nc-src-empty-');
  git(empty, 'init', '-q');
  fs.writeFileSync(path.join(empty, 'a.txt'), 'hi');
  assert.equal((await readSource(empty, 'a.txt')).diff, null);

  fs.writeFileSync(path.join(plain, 'b.bin'), Buffer.from([1, 0, 2]));
  const bin = await readSource(plain, 'b.bin');
  assert.equal(bin.binary, true);
  assert.equal(bin.text, null);

  fs.writeFileSync(path.join(plain, 'big.txt'), 'x'.repeat(MAX_SIZE + 10));
  const big = await readSource(plain, 'big.txt');
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, MAX_SIZE);
});

test('readSource refuses a file swapped for a symlink out of the repo', async () => {
  const root = tmp('nc-src-link-');
  const outside = tmp('nc-src-out-');
  fs.writeFileSync(path.join(outside, 'secret'), 'SECRET');
  fs.writeFileSync(path.join(root, 'inside.txt'), 'ok');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'a.txt'));
  fs.symlinkSync(path.join(root, 'inside.txt'), path.join(root, 'b.txt'));
  await assert.rejects(readSource(root, 'a.txt'));
  assert.equal((await readSource(root, 'b.txt')).text, 'ok');
});
