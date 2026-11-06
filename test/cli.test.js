'use strict';
// The entry points other agents use: the node-code bin, --agent on the hook,
// and the data directory used when Claude Code's is not set.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const registry = require('../server/registry');

const PLUGIN = path.join(__dirname, '..');
const BIN = path.join(PLUGIN, 'scripts/node-code.js');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function envWith(vars) {
  const env = { ...process.env, ...vars };
  delete env.CLAUDE_PLUGIN_DATA;
  return env;
}

function runHook(args, env, input) {
  return new Promise((resolve) => {
    const p = spawn('node', [path.join(PLUGIN, 'scripts/hook.js'), ...args], { env });
    p.on('exit', resolve);
    p.stdin.end(input);
  });
}

// A stand-in server that records every hook POST it receives.
async function fakeServer(t, data, root) {
  const bodies = [];
  const srv = http.createServer((q, s) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => { bodies.push(JSON.parse(b)); s.end('{}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  registry.write(data, { root, port: srv.address().port, hookToken: 'x' });
  return bodies;
}

test('defaultDataDir is NODE_CODE_DATA when set, else ~/.node-code', () => {
  const saved = process.env.NODE_CODE_DATA;
  try {
    process.env.NODE_CODE_DATA = '/x/y';
    assert.equal(registry.defaultDataDir(), '/x/y');
    delete process.env.NODE_CODE_DATA;
    assert.equal(registry.defaultDataDir(), path.join(os.homedir(), '.node-code'));
  } finally {
    if (saved === undefined) delete process.env.NODE_CODE_DATA;
    else process.env.NODE_CODE_DATA = saved;
  }
});

test('the bin starts and stops a server in NODE_CODE_DATA when no other data dir is given', () => {
  const root = tmp('nc-cli-');
  const data = tmp('nc-cli-data-');
  fs.writeFileSync(path.join(root, 'a.js'), 'x');
  const env = envWith({ NODE_CODE_DATA: data });
  const out = execFileSync('node', [BIN, 'start', '--cwd', root, '--no-open'], { env }).toString();
  assert.match(out, /started/);
  assert.equal(registry.read(data, root).root, root);
  execFileSync('node', [BIN, 'stop', '--cwd', root], { env });
  assert.equal(registry.read(data, root), null);
});

test('start with an empty --data refuses, as before, instead of using NODE_CODE_DATA', () => {
  const root = tmp('nc-emptydata-');
  const data = tmp('nc-emptydata-data-');
  const out = execFileSync('node', [path.join(PLUGIN, 'scripts/ctl.js'), 'start', '--data', '', '--cwd', root, '--no-open'],
    { env: envWith({ NODE_CODE_DATA: data }) }).toString();
  assert.match(out, /data directory not available/);
  assert.equal(registry.read(data, root), null);
});

// Claude Code's hook also reaches servers started with `node-code start`, so one
// map can show every agent.
test('without --agent the hook also reaches a server in NODE_CODE_DATA', async (t) => {
  const root = tmp('nc-noagent-');
  const data = tmp('nc-noagent-data-');
  const bodies = await fakeServer(t, data, root);
  const payload = { cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${root}/a.js` } };
  assert.equal(await runHook([], envWith({ NODE_CODE_DATA: data }), JSON.stringify(payload)), 0);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].msg.filePath, `${root}/a.js`);
});

test('without --agent the hook still reaches a server in CLAUDE_PLUGIN_DATA when NODE_CODE_DATA has none', async (t) => {
  const root = tmp('nc-claude-');
  const claudeData = tmp('nc-claude-data-');
  const bodies = await fakeServer(t, claudeData, root);
  const payload = { cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${root}/a.js` } };
  const env = { ...envWith({ NODE_CODE_DATA: tmp('nc-claude-empty-') }), CLAUDE_PLUGIN_DATA: claudeData };
  assert.equal(await runHook([], env, JSON.stringify(payload)), 0);
  assert.equal(bodies.length, 1);
});

test('--agent copilot maps the payload and posts it to the server in NODE_CODE_DATA', async (t) => {
  const root = tmp('nc-copilot-');
  const data = tmp('nc-copilot-data-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.js'), 'x');
  const bodies = await fakeServer(t, data, root);
  const payload = { hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_use_id: 'call_1',
    tool_name: 'Read', tool_input: { path: `${root}/src/a.js` } };
  assert.equal(await runHook(['--agent', 'copilot'], envWith({ NODE_CODE_DATA: data }), JSON.stringify(payload)), 0);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].msg.tool, 'Read');
  assert.equal(bodies[0].msg.filePath, `${root}/src/a.js`);
});

test('--agent opencode maps the plugin event and posts it to the server in NODE_CODE_DATA', async (t) => {
  const root = tmp('nc-opencode-');
  const data = tmp('nc-opencode-data-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.js'), 'x');
  const bodies = await fakeServer(t, data, root);
  const payload = { phase: 'before', directory: root, event: { tool: 'read', sessionID: 's', id: 'call_1', input: { path: 'src/a.js' } } };
  assert.equal(await runHook(['--agent', 'opencode'], envWith({ NODE_CODE_DATA: data }), JSON.stringify(payload)), 0);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].msg.tool, 'Read');
  assert.equal(bodies[0].msg.filePath, 'src/a.js');
});

test('an unknown --agent is a no-op that exits 0', async (t) => {
  const root = tmp('nc-bogus-');
  const data = tmp('nc-bogus-data-');
  const bodies = await fakeServer(t, data, root);
  const payload = { cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${root}/a.js` } };
  assert.equal(await runHook(['--agent', 'bogus'], envWith({ NODE_CODE_DATA: data }), JSON.stringify(payload)), 0);
  assert.equal(bodies.length, 0);
});

// The OpenCode plugin, run with a stand-in for OpenCode's plugin context and a
// stand-in node-code command on PATH.
async function loadPlugin(t, binDir) {
  const savedPath = process.env.PATH;
  process.env.PATH = binDir;
  t.after(() => { process.env.PATH = savedPath; });
  const plugin = (await import(path.join(PLUGIN, 'opencode/node-code.js'))).default;
  const hooks = {};
  await plugin.setup({ location: { directory: '/repo' }, tool: { hook: async (name, fn) => { hooks[name] = fn; } } });
  return hooks;
}

test('the OpenCode plugin pipes each tool event to `node-code hook --agent opencode`', async (t) => {
  const bin = tmp('nc-bin-');
  const out = path.join(bin, 'out.jsonl');
  fs.writeFileSync(path.join(bin, 'node-code'),
    `#!${process.execPath}\nlet s='';process.stdin.on('data',c=>s+=c).on('end',()=>require('fs').appendFileSync(${JSON.stringify(out)},JSON.stringify({args:process.argv.slice(2),stdin:JSON.parse(s)})+'\\n'));\n`, { mode: 0o755 });
  const hooks = await loadPlugin(t, bin);
  const event = { tool: 'read', id: 'c1', input: { path: 'a.js' } };
  hooks['execute.before'](event);
  hooks['execute.after']({ ...event, status: 'completed' });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (!fs.existsSync(out) || fs.readFileSync(out, 'utf8').trim().split('\n').length < 2)) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .sort((a, b) => a.stdin.phase.localeCompare(b.stdin.phase));
  assert.deepEqual(lines[0], { args: ['hook', '--agent', 'opencode'], stdin: { phase: 'after', directory: '/repo', event: { ...event, status: 'completed' } } });
  assert.deepEqual(lines[1].stdin, { phase: 'before', directory: '/repo', event });
});

test('the OpenCode plugin does not throw when node-code is not installed', async (t) => {
  const hooks = await loadPlugin(t, tmp('nc-nobin-'));
  assert.doesNotThrow(() => hooks['execute.before']({ tool: 'read', id: 'c1', input: {} }));
  await new Promise((r) => setTimeout(r, 100)); // let the spawn error arrive
});
