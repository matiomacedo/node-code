'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { App } = require('../server/main');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function setup(t, files = { 'a.ts': 'a', 'b.ts': 'b' }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-app-')));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-app-data-'));
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text);
  const app = new App(root, data);
  await app.init();
  t.after(() => { clearTimeout(app.syncTimer); clearTimeout(app.rescanTimer); return app.worker.terminate(); });
  return { app, root };
}

const copy = (m) => new Map([...m].map(([k, v]) => [k, { ...v }]));
const client = () => {
  const writes = [];
  return { writes, write: (s) => writes.push(s), writeHead() {}, end() {} };
};
const events = (c, name) => c.writes.filter((w) => w.startsWith(`event: ${name}\n`))
  .map((w) => JSON.parse(w.slice(w.indexOf('data: ') + 6)));

const finishedBash = (app, id) => app.state.apply({ id, phase: 'end', tool: 'Bash', kind: 'bash', session: 's', label: 'x', targets: [] }, 1);

test('a file created while a scan runs is not removed by the stale result', async (t) => {
  const { app, root } = await setup(t);
  const stale = copy(app.index.files);
  const scan = deferred();
  app.scan = () => scan.promise;
  const running = app.rescan();
  fs.writeFileSync(path.join(root, 'new.ts'), 'n');
  await app.refreshFile(path.join(root, 'new.ts'), root);
  scan.resolve({ files: stale });
  await running;
  assert.ok(app.index.files.has('new.ts'));
});

test('an edit made while a scan runs is not credited to Bash or rolled back', async (t) => {
  const { app, root } = await setup(t);
  finishedBash(app, 'b1');
  app.lastBash = 'b1';
  const stale = copy(app.index.files);
  const scan = deferred();
  app.scan = () => scan.promise;
  const running = app.rescan();
  fs.writeFileSync(path.join(root, 'a.ts'), 'edited and longer');
  await app.refreshFile(path.join(root, 'a.ts'), root);
  const fresh = app.index.files.get('a.ts').size;
  scan.resolve({ files: stale });
  await running;
  assert.equal(app.state.stats('a.ts'), undefined);
  assert.equal(app.index.files.get('a.ts').size, fresh);
});

test('changes outside the scan window are still found', async (t) => {
  const { app, root } = await setup(t);
  finishedBash(app, 'b1');
  app.lastBash = 'b1';
  fs.writeFileSync(path.join(root, 'a.ts'), 'changed by bash');
  await app.rescan();
  assert.equal(app.state.stats('a.ts').edits, 1);
});

test('a branch switch that only modifies files records no edits', async (t) => {
  const files = {};
  for (let i = 0; i < 300; i++) files[`f${i}.ts`] = 'x';
  const { app } = await setup(t, files);
  finishedBash(app, 'b1');
  app.lastBash = 'b1';
  const c = client();
  app.clients.add(c);
  const next = copy(app.index.files);
  for (const m of next.values()) m.mtimeMs += 1000;
  app.scan = async () => ({ files: next });
  await app.rescan();
  assert.equal(app.state.stats('f0.ts'), undefined);
  assert.equal(events(c, 'activity').length, 0);
  assert.equal(app.index.files.get('f0.ts').mtimeMs, next.get('f0.ts').mtimeMs);
});

test('a page connected during the first scan gets its snapshot when the scan ends', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-app-')));
  fs.writeFileSync(path.join(root, 'a.ts'), 'a');
  const app = new App(root, fs.mkdtempSync(path.join(os.tmpdir(), 'nc-app-data-')));
  t.after(() => { clearTimeout(app.syncTimer); return app.worker.terminate(); });
  const scan = deferred();
  const realScan = app.scan;
  app.scan = () => scan.promise;
  const booting = app.init();
  const c = client();
  app.addClient({ on() {} }, c);
  assert.equal(events(c, 'snapshot').length, 0);
  scan.resolve(await realScan({}));
  await booting;
  assert.deepEqual(events(c, 'snapshot')[0].files.map((f) => f[0]), ['a.ts']);
});

test('Bash finishing during the first scan does not credit the whole repo to it', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-app-')));
  fs.writeFileSync(path.join(root, 'a.ts'), 'a');
  const app = new App(root, fs.mkdtempSync(path.join(os.tmpdir(), 'nc-app-data-')));
  t.after(() => { clearTimeout(app.syncTimer); clearTimeout(app.rescanTimer); return app.worker.terminate(); });
  const scan = deferred();
  const realScan = app.scan;
  app.scan = () => scan.promise;
  const booting = app.init();
  await app.onHook({ event: 'PostToolUse', tool: 'Bash', id: 'b', cwd: root, command: 'x' }, 1);
  await app.rescan();
  scan.resolve(await realScan({}));
  await booting;
  assert.equal(app.state.stats('a.ts'), undefined);
});

test('a truncated rescan keeps files beyond the cap that still exist, and drops deleted ones', async (t) => {
  const { app, root } = await setup(t);
  fs.writeFileSync(path.join(root, 'new.ts'), 'n');
  await app.refreshFile(path.join(root, 'new.ts'), root);
  fs.unlinkSync(path.join(root, 'b.ts'));
  // The capped listing contains neither file.
  const capped = new Map([['a.ts', { ...app.index.files.get('a.ts') }]]);
  app.scan = async () => ({ files: capped, truncated: true });
  await app.rescan();
  assert.ok(app.index.files.has('new.ts'), 'beyond the cap but on disk');
  assert.ok(!app.index.files.has('b.ts'), 'deleted from disk');
  assert.equal(app.truncated, true);
});
