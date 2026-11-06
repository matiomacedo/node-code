#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const registry = require('../server/registry');
const { findRoot } = require('../server/scan');
const { version } = require('../package.json');

const START_TIMEOUT_MS = 8000;
const BUSY_WAIT_MS = 3000;

function request(entry, method, urlPath) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: entry.port, path: urlPath, method, timeout: 1000,
      headers: { authorization: `Bearer ${entry.hookToken}` },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

const health = (entry) => request(entry, 'GET', '/health');
const pageUrl = (e) => `http://127.0.0.1:${e.port}/?t=${e.viewerToken}`;

async function alive(dataDir, root) {
  const entry = registry.read(dataDir, root);
  if (!entry) return null;
  // Checks the authenticated endpoint, because a pid or port may have been reused.
  const h = await health(entry);
  return h && h.root === root ? { entry, h } : null;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// A registered server whose process is alive may just be busy: wait for it
// briefly rather than start a second server for the same repo.
async function waitForBusy(dataDir, root) {
  const entry = registry.read(dataDir, root);
  if (!entry || !pidAlive(entry.pid)) return null;
  const deadline = Date.now() + BUSY_WAIT_MS;
  while (Date.now() < deadline) {
    const up = await alive(dataDir, root);
    if (up) return up;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function launch(dataDir, root) {
  registry.remove(dataDir, root);
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, '../server/main.js'), '--root', root, '--data', dataDir], {
    detached: true,
    stdio: ['ignore', log, log], // No inherited pipes: the skill's shell must not wait on this.
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const up = await alive(dataDir, root);
    if (up) return up;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  spawnSync(cmd, args, { stdio: 'ignore' });
}

async function start(dataDir, root, noOpen) {
  let up = (await alive(dataDir, root)) || (await waitForBusy(dataDir, root));
  if (up && up.h.version !== version) {
    await request(up.entry, 'POST', '/shutdown');
    up = null;
  }
  const reused = Boolean(up);
  if (!up) up = await launch(dataDir, root);
  if (!up) {
    console.log(`node-code: server failed to start; see ${path.join(dataDir, 'server.log')}`);
    process.exitCode = 0;
    return;
  }
  const url = pageUrl(up.entry);
  if (!noOpen && up.h.clients === 0) openBrowser(url);
  console.log(`node-code ${reused ? 'already running' : 'started'} for ${path.basename(root)}: ${url}`);
}

async function stop(dataDir, root) {
  const up = await alive(dataDir, root);
  if (!up) {
    registry.remove(dataDir, root);
    console.log(`node-code: no server running for ${path.basename(root)}`);
    return;
  }
  await request(up.entry, 'POST', '/shutdown');
  console.log(`node-code: stopped server for ${path.basename(root)}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  // The Claude Code skills pass --data "${CLAUDE_PLUGIN_DATA}"; if that is empty, the
  // hooks have no registry either, so a server started elsewhere would get no activity.
  if (rest.includes('--data') && !flag('--data')) { console.log('node-code: plugin data directory not available'); return; }
  const dataDir = flag('--data') || process.env.CLAUDE_PLUGIN_DATA || registry.defaultDataDir();
  const root = findRoot(flag('--cwd') || process.cwd());
  if (cmd === 'start') await start(dataDir, root, rest.includes('--no-open'));
  else if (cmd === 'stop') await stop(dataDir, root);
  else console.log('usage: node-code start|stop [--data <dir>]');
}

main();
