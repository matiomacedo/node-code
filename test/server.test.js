'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const registry = require('../server/registry');

const PLUGIN = path.join(__dirname, '..');

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-srv-')));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-data-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.ts'), "import { b } from './b';\nexport const a = 1;\n");
  fs.writeFileSync(path.join(root, 'src/b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(root, 'src/a.test.ts'), "import './a';\n");
  const out = execFileSync('node', [path.join(PLUGIN, 'scripts/ctl.js'), 'start', '--data', data, '--cwd', root, '--no-open']).toString();
  const entry = registry.read(data, root);
  return { root, data, out, entry };
}

function hook(ctx, payload) {
  return new Promise((resolve) => {
    const p = spawn('node', [path.join(PLUGIN, 'scripts/hook.js')], { env: { ...process.env, CLAUDE_PLUGIN_DATA: ctx.data } });
    p.on('exit', resolve);
    p.stdin.end(JSON.stringify(payload));
  });
}

function req(entry, urlPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: entry.port, path: urlPath, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    r.on('error', reject);
    r.end();
  });
}

// Minimal SSE reader: `next(predicate)` resolves with the first matching event.
function sse(entry) {
  const queue = [];
  let waiter = null;
  const check = () => {
    if (!waiter) return;
    const i = queue.findIndex(waiter.pred);
    if (i >= 0) { const [m] = queue.splice(i, 1); const w = waiter; waiter = null; w.resolve(m); }
  };
  const r = http.get({ host: '127.0.0.1', port: entry.port, path: `/api/events?t=${entry.viewerToken}` }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = block.match(/^event: (.+)$/m);
        const d = block.match(/^data: (.+)$/m);
        if (ev && d) queue.push({ event: ev[1], data: JSON.parse(d[1]) });
      }
      check();
    });
  });
  r.on('error', () => {});
  return {
    next: (pred) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; queue=${JSON.stringify(queue).slice(0, 500)}`)), 5000);
      waiter = { pred, resolve: (m) => { clearTimeout(t); resolve(m); } };
      check();
    }),
    close: () => r.destroy(),
  };
}

const base = (ctx, over) => ({ session_id: 's1', cwd: ctx.root, tool_use_id: `t${Math.random()}`, ...over });
const isActivity = (pred) => (m) => m.event === 'activity' && pred(m.data);

test('server end to end through the real hook script', async (t) => {
  const ctx = setup();
  const { entry } = ctx;
  t.after(() => execFileSync('node', [path.join(PLUGIN, 'scripts/ctl.js'), 'stop', '--data', ctx.data, '--cwd', ctx.root]));
  assert.match(ctx.out, /started/);

  await t.test('start is idempotent', () => {
    const again = execFileSync('node', [path.join(PLUGIN, 'scripts/ctl.js'), 'start', '--data', ctx.data, '--cwd', ctx.root, '--no-open']).toString();
    assert.match(again, /already running/);
    assert.equal(registry.read(ctx.data, ctx.root).port, entry.port);
  });

  await t.test('registry file is private', () => {
    const dir = path.join(ctx.data, 'servers');
    const mode = fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  await t.test('security: rejects foreign Host, foreign Origin and missing tokens', async () => {
    const api = `/api/file?id=src/a.ts&t=${entry.viewerToken}`;
    assert.equal((await req(entry, api)).status, 200);
    assert.equal((await req(entry, api, { headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await req(entry, api, { headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await req(entry, '/api/file?id=src/a.ts')).status, 401);
    assert.equal((await req(entry, '/api/events')).status, 401);
    assert.equal((await req(entry, '/hook', { method: 'POST' })).status, 401);
    assert.equal((await req(entry, '/health')).status, 401);
    assert.equal((await req(entry, '/shutdown', { method: 'POST' })).status, 401);
  });

  await t.test('an unparsable request path gets a 400 and the server survives', async () => {
    assert.equal((await req(entry, '//')).status, 400);
    const auth = { authorization: `Bearer ${entry.hookToken}` };
    assert.equal((await req(entry, '/health', { headers: auth })).status, 200);
  });

  await t.test('file detail never reads outside the index', async () => {
    const t1 = entry.viewerToken;
    assert.equal((await req(entry, `/api/file?t=${t1}&id=../../../../etc/passwd`)).status, 404);
    assert.equal((await req(entry, `/api/file?t=${t1}&id=/etc/passwd`)).status, 404);
  });

  await t.test('page is served with a CSP', async () => {
    const r = await req(entry, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  });

  const stream = sse(entry);
  t.after(() => stream.close());

  await t.test('snapshot lists the repo files', async () => {
    const { data } = await stream.next((m) => m.event === 'snapshot');
    assert.deepEqual(data.files.map((f) => f[0]).sort(), ['src/a.test.ts', 'src/a.ts', 'src/b.ts']);
    assert.equal(data.repo, path.basename(ctx.root));
  });

  await t.test('Read: Pre then Post reach the page and count once', async () => {
    const id = 'read1';
    const file_path = path.join(ctx.root, 'src/a.ts');
    await hook(ctx, base(ctx, { tool_use_id: id, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path } }));
    const pre = await stream.next(isActivity((d) => d.entry.id === id));
    assert.equal(pre.data.pulses[0].status, 'reading');
    assert.equal(pre.data.pulses[0].path, 'src/a.ts');
    await hook(ctx, base(ctx, { tool_use_id: id, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path }, tool_response: { type: 'text' } }));
    const post = await stream.next(isActivity((d) => d.entry.id === id));
    assert.equal(post.data.entry.verb, 'Read');
    assert.equal(post.data.stats['src/a.ts'].reads, 1);
  });

  await t.test('Write with type create adds a node, then a Created pulse', async () => {
    fs.writeFileSync(path.join(ctx.root, 'src/new.ts'), "import './b';\n");
    await hook(ctx, base(ctx, { tool_use_id: 'w1', hook_event_name: 'PostToolUse', tool_name: 'Write',
      tool_input: { file_path: path.join(ctx.root, 'src/new.ts'), content: 'secret-content' }, tool_response: { type: 'create', filePath: 'x' } }));
    const tree = await stream.next((m) => m.event === 'tree');
    assert.deepEqual(tree.data.added.map((a) => a[0]), ['src/new.ts']);
    const a = await stream.next(isActivity((d) => d.entry.id === 'w1'));
    assert.equal(a.data.entry.verb, 'Created');
    assert.equal(a.data.pulses[0].status, 'created');
    assert.ok(!JSON.stringify(a.data).includes('secret-content'));
  });

  await t.test('a write to an ignored path gets no node and is feed-only', async () => {
    fs.mkdirSync(path.join(ctx.root, 'node_modules'));
    fs.writeFileSync(path.join(ctx.root, 'node_modules/x.js'), '');
    await hook(ctx, base(ctx, { tool_use_id: 'w2', hook_event_name: 'PostToolUse', tool_name: 'Write',
      tool_input: { file_path: path.join(ctx.root, 'node_modules/x.js') }, tool_response: { type: 'create' } }));
    const a = await stream.next(isActivity((d) => d.entry.id === 'w2'));
    assert.deepEqual(a.data.pulses, []);
  });

  await t.test('files created and changed by Bash are found by the rescan', async () => {
    fs.writeFileSync(path.join(ctx.root, 'src/bash.txt'), 'x');
    fs.appendFileSync(path.join(ctx.root, 'src/b.ts'), '// changed\n');
    await hook(ctx, base(ctx, { tool_use_id: 'b1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'do things' }, tool_response: { stdout: '' } }));
    const tree = await stream.next((m) => m.event === 'tree');
    assert.deepEqual(tree.data.added.map((a) => a[0]), ['src/bash.txt']);
    const a = await stream.next(isActivity((d) => d.entry.id === 'b1' && d.pulses.length > 0));
    assert.deepEqual(a.data.pulses.sort((x, y) => x.path.localeCompare(y.path)), [
      { path: 'src/b.ts', status: 'editing' }, { path: 'src/bash.txt', status: 'created' },
    ]);
  });

  await t.test('files deleted by Bash disappear', async () => {
    fs.unlinkSync(path.join(ctx.root, 'src/bash.txt'));
    await hook(ctx, base(ctx, { tool_use_id: 'b2', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'rm' }, error: 'x' }));
    const tree = await stream.next((m) => m.event === 'tree' && m.data.removed.length);
    assert.deepEqual(tree.data.removed, ['src/bash.txt']);
  });

  await t.test('failed tool on a file pulses failed', async () => {
    await hook(ctx, base(ctx, { tool_use_id: 'f1', hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_input: { file_path: path.join(ctx.root, 'src/a.ts') }, error: 'no match' }));
    const a = await stream.next(isActivity((d) => d.entry.id === 'f1'));
    assert.equal(a.data.pulses[0].status, 'failed');
    assert.equal(a.data.entry.error, 'no match');
  });

  await t.test('file detail reports imports, imported-by, exports, tests and stats', async () => {
    await new Promise((resolve) => {
      const tick = async () => {
        const d = JSON.parse((await req(entry, `/api/file?id=src/b.ts&t=${entry.viewerToken}`)).body);
        if (d.importedBy.includes('src/a.ts') && d.importedBy.includes('src/new.ts')) resolve();
        else setTimeout(tick, 25);
      };
      tick();
    });
    const a = JSON.parse((await req(entry, `/api/file?id=src/a.ts&t=${entry.viewerToken}`)).body);
    assert.deepEqual(a.imports, [{ spec: './b', targets: ['src/b.ts'] }]);
    assert.deepEqual(a.exports, ['a']);
    assert.deepEqual(a.tests, ['src/a.test.ts']);
    assert.equal(a.language, 'TypeScript');
    assert.equal(a.stats.reads, 1);
    assert.equal(a.stats.fails, 1);
  });

  await t.test('heat reset keeps session stats', async () => {
    const r = await req(entry, `/api/heat/reset?t=${entry.viewerToken}`, { method: 'POST' });
    assert.equal(r.status, 200);
    await stream.next((m) => m.event === 'heat-reset');
    const a = JSON.parse((await req(entry, `/api/file?id=src/a.ts&t=${entry.viewerToken}`)).body);
    assert.equal(a.stats.heat, 0);
    assert.equal(a.stats.reads, 1);
  });
});

test('hook exits 0 with no server, no data dir, and on malformed input', async () => {
  const run = (env, input) => new Promise((resolve) => {
    const p = spawn('node', [path.join(PLUGIN, 'scripts/hook.js')], { env: { ...process.env, ...env } });
    p.on('exit', resolve);
    p.stdin.end(input);
  });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-empty-'));
  assert.equal(await run({ CLAUDE_PLUGIN_DATA: empty }, '{}'), 0);
  assert.equal(await run({ CLAUDE_PLUGIN_DATA: '' }, '{}'), 0);
  registry.write(empty, { root: empty, port: 1, hookToken: 'x' });
  assert.equal(await run({ CLAUDE_PLUGIN_DATA: empty }, 'not json'), 0);
  assert.equal(await run({ CLAUDE_PLUGIN_DATA: empty }, JSON.stringify({ cwd: empty, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })), 0);
});

test('the hook posts no content fragments to the server', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-frag-')));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-frag-data-'));
  fs.writeFileSync(path.join(root, 'real.ts'), 'x');
  const bodies = [];
  const fake = http.createServer((q, s) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => { bodies.push(b); s.end('{}'); });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());
  registry.write(data, { root, port: fake.address().port, pid: 1, hookToken: 'x' });
  const ctx = { data };
  await hook(ctx, { hook_event_name: 'PostToolUse', tool_name: 'Write', cwd: root, tool_use_id: 'w',
    tool_input: { file_path: path.join(root, 'n.txt'), content: 'SECRET_A:1' }, tool_response: { type: 'create', content: 'SECRET_A:1' } });
  await hook(ctx, { hook_event_name: 'PostToolUse', tool_name: 'Grep', cwd: root, tool_use_id: 'g', tool_input: { pattern: 'x' },
    tool_response: { mode: 'content', filenames: [], content: 'SECRET_B:12345\nreal.ts:1:x' } });
  assert.equal(bodies.length, 2);
  assert.ok(!bodies.join('').includes('SECRET_'), bodies.join(''));
  assert.deepEqual(JSON.parse(bodies[1]).msg.matched, ['real.ts']);
});

test('removeOwned leaves an entry written by another server', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-own-'));
  registry.write(data, { root: '/r', pid: 111 });
  registry.removeOwned(data, '/r', 222);
  assert.equal(registry.read(data, '/r').pid, 111);
  registry.removeOwned(data, '/r', 111);
  assert.equal(registry.read(data, '/r'), null);
});

test('an orphaned server exiting does not remove the live server entry', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-orph-')));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-orph-data-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  const boot = async () => {
    const before = registry.read(data, root)?.pid;
    const p = spawn('node', [path.join(PLUGIN, 'server/main.js'), '--root', root, '--data', data], { stdio: 'ignore' });
    const exited = new Promise((r) => p.on('exit', r));
    while (registry.read(data, root)?.pid !== p.pid) await new Promise((r) => setTimeout(r, 20));
    assert.notEqual(before, p.pid);
    return { p, exited };
  };
  const a = await boot();
  const b = await boot();
  a.p.kill('SIGTERM');
  await a.exited;
  assert.equal(registry.read(data, root).pid, b.p.pid);
  b.p.kill('SIGTERM');
  await b.exited;
  assert.equal(registry.read(data, root), null);
});

test('start waits for a live but busy server instead of launching a second one', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-busy-')));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-busy-data-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  // A live pid with a dead port: the wait must time out, then fall through to a launch.
  registry.write(data, { root, port: 1, pid: process.pid, hookToken: 'x', viewerToken: 'y' });
  const started = Date.now();
  const out = execFileSync('node', [path.join(PLUGIN, 'scripts/ctl.js'), 'start', '--data', data, '--cwd', root, '--no-open']).toString();
  assert.ok(Date.now() - started >= 2000, 'waited for the busy server first');
  assert.match(out, /started/);
  execFileSync('node', [path.join(PLUGIN, 'scripts/ctl.js'), 'stop', '--data', data, '--cwd', root]);
});

test('pickServer prefers the first path in a repo, and the deepest root', () => {
  const s = [{ root: '/a' }, { root: '/a/b' }, { root: '/c' }];
  assert.equal(registry.pickServer(s, ['/a/b/f', '/c']).root, '/a/b');
  assert.equal(registry.pickServer(s, ['/z/f', '/c/x']).root, '/c');
  assert.equal(registry.pickServer(s, ['/ab/f']), null);
});
