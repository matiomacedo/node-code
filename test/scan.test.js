'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scanRepo, findRoot, diffScans, acceptsFile } = require('../server/scan');

function tree(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-scan-')));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}
const git = (root, ...args) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, stdio: 'pipe' });
const names = async (root) => [...(await scanRepo(root)).files.keys()].sort();

const COMMON = {
  'src/a.ts': 'a', 'node_modules/x/i.js': 'x', 'dist/out.js': 'x', 'logo.png': 'x',
  'data.weird': Buffer.from([1, 0, 2]), 'ignored.log': 'x', 'sub/.gitignore': 'secret.txt\n',
  'sub/secret.txt': 'x', 'sub/keep.txt': 'x', '.gitignore': '*.log\n',
};
const EXPECTED = ['.gitignore', 'src/a.ts', 'sub/.gitignore', 'sub/keep.txt'];

test('git repo: respects gitignore and skips deps, build output and binaries', async () => {
  const root = tree(COMMON);
  git(root, 'init', '-q');
  assert.deepEqual(await names(root), EXPECTED);
});

test('non-git folder: walker applies root and nested gitignore the same way', async () => {
  assert.deepEqual(await names(tree(COMMON)), EXPECTED);
});

test('walker supports negation, anchoring, directories and globstar', async () => {
  const root = tree({
    '.gitignore': 'build-*/\n/only-root.txt\n*.tmp\n!keep.tmp\ndocs/**/draft.md\n',
    'build-1/a.txt': 'x', 'only-root.txt': 'x', 'n/only-root.txt': 'x', 'x.tmp': 'x', 'keep.tmp': 'x',
    'docs/a/b/draft.md': 'x', 'docs/a/final.md': 'x',
  });
  assert.deepEqual(await names(root), ['.gitignore', 'docs/a/final.md', 'keep.tmp', 'n/only-root.txt']);
});

test('walker does not follow symlinks', async () => {
  const root = tree({ 'a.txt': 'x' });
  fs.symlinkSync(root, path.join(root, 'loop'));
  assert.deepEqual(await names(root), ['a.txt']);
});

test('git repo: a file deleted from disk but still in the index disappears', async () => {
  const root = tree({ 'a.txt': 'x', 'b.txt': 'x' });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'i');
  fs.unlinkSync(path.join(root, 'b.txt'));
  assert.deepEqual(await names(root), ['a.txt']);
});

test('git repo: untracked non-ignored files are included', async () => {
  const root = tree({ 'a.txt': 'x' });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  fs.writeFileSync(path.join(root, 'new.txt'), 'x');
  assert.deepEqual(await names(root), ['a.txt', 'new.txt']);
});

test('scan records size and mtime', async () => {
  const root = tree({ 'a.txt': 'hello' });
  const meta = (await scanRepo(root)).files.get('a.txt');
  assert.equal(meta.size, 5);
  assert.ok(meta.mtimeMs > 0);
});

test('walker skips an unreadable folder and still lists the rest', async (t) => {
  const root = tree({ 'ok.txt': 'x', 'locked/secret.txt': 'x' });
  fs.chmodSync(path.join(root, 'locked'), 0o000);
  t.after(() => fs.chmodSync(path.join(root, 'locked'), 0o755));
  assert.deepEqual(await names(root), ['ok.txt']);
});

test('binary cache: a binary replaced by text at the same path appears', async () => {
  const root = tree({ 'f.data': Buffer.from([1, 0, 2]) });
  const sniffed = new Map();
  assert.equal((await scanRepo(root, { sniffed })).files.has('f.data'), false);
  fs.writeFileSync(path.join(root, 'f.data'), 'now text, longer than before');
  assert.equal((await scanRepo(root, { sniffed })).files.has('f.data'), true);
});

test('binary cache: text replaced by binary at the same path disappears', async () => {
  const root = tree({ 'f.data': 'text' });
  const sniffed = new Map();
  assert.equal((await scanRepo(root, { sniffed })).files.has('f.data'), true);
  fs.writeFileSync(path.join(root, 'f.data'), Buffer.from([1, 0, 2, 3, 4, 5, 6]));
  assert.equal((await scanRepo(root, { sniffed })).files.has('f.data'), false);
});

test('binary cache: a read error is not remembered as binary', async (t) => {
  const root = tree({ 'f.data': 'text' });
  const file = path.join(root, 'f.data');
  const sniffed = new Map();
  fs.chmodSync(file, 0o000);
  t.after(() => fs.chmodSync(file, 0o644));
  assert.equal((await scanRepo(root, { sniffed })).files.has('f.data'), false);
  fs.chmodSync(file, 0o644);
  assert.equal((await scanRepo(root, { sniffed })).files.has('f.data'), true);
});

test('non-git: a folder whose own .gitignore re-includes a type accepts new files of that type', async () => {
  const root = tree({ 'src/.gitignore': '*\n!*.ts\n', 'src/old.ts': 'x', 'src/skip.js': 'x' });
  fs.writeFileSync(path.join(root, 'src/foo.ts'), 'x');
  assert.equal(await acceptsFile(root, 'src/foo.ts'), true);
  assert.equal(await acceptsFile(root, 'src/skip.js'), false);
  assert.deepEqual(await names(root), ['src/foo.ts', 'src/old.ts']);
});

test('a scan that hits the file cap reports itself truncated, with or without git', async () => {
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, 'x']));
  const plain = tree(files);
  const plainScan = await scanRepo(plain, { maxFiles: 3 });
  assert.equal(plainScan.files.size, 3);
  assert.equal(plainScan.truncated, true);
  const repo = tree(files);
  git(repo, 'init', '-q');
  const gitScan = await scanRepo(repo, { maxFiles: 3 });
  assert.equal(gitScan.files.size, 3);
  assert.equal(gitScan.truncated, true);
  assert.equal((await scanRepo(repo, { maxFiles: 5 })).truncated, false);
});

test('findRoot returns the git toplevel from a subfolder, else the folder itself', () => {
  const root = tree({ 'sub/a.txt': 'x' });
  assert.equal(findRoot(path.join(root, 'sub')), path.join(root, 'sub'));
  git(root, 'init', '-q');
  assert.equal(findRoot(path.join(root, 'sub')), root);
});

test('diffScans reports added, removed and modified', () => {
  const a = new Map([['same', { size: 1, mtimeMs: 1 }], ['gone', { size: 1, mtimeMs: 1 }], ['mod', { size: 1, mtimeMs: 1 }]]);
  const b = new Map([['same', { size: 1, mtimeMs: 1 }], ['mod', { size: 1, mtimeMs: 2 }], ['new', { size: 1, mtimeMs: 1 }]]);
  assert.deepEqual(diffScans(a, b), { added: ['new'], removed: ['gone'], modified: ['mod'] });
});

test('acceptsFile rejects ignored, skipped and binary files, accepts normal ones', async () => {
  const root = tree({ '.gitignore': '*.log\n', 'a.log': 'x', 'a.txt': 'x', 'dist/a.js': 'x', 'b.bin2': Buffer.from([0]) });
  git(root, 'init', '-q');
  assert.equal(await acceptsFile(root, 'a.log'), false);
  assert.equal(await acceptsFile(root, 'dist/a.js'), false);
  assert.equal(await acceptsFile(root, 'b.bin2'), false);
  assert.equal(await acceptsFile(root, 'a.txt'), true);
});
