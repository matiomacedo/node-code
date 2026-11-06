#!/usr/bin/env node
'use strict';
// Runs as an async hook on every matched tool call. Must stay cheap and must
// never affect Claude: it swallows every error and always exits 0.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { list, pickServer, defaultDataDir } = require('../server/registry');
const { extract } = require('../server/hook-payload');
const { realpathOfDeepestExisting } = require('../server/repo-index');

const POST_TIMEOUT_MS = 500;
const hookAt = performance.timeOrigin;

// Other agents name themselves with --agent; their payloads are mapped to Claude
// Code's shape first. Without it, this is Claude Code's hook.
const ADAPTERS = { copilot: '../adapters/copilot', opencode: '../adapters/opencode' };
const flagAt = process.argv.indexOf('--agent');
const agent = flagAt >= 0 ? process.argv[flagAt + 1] : null;

function send(server, body) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.port,
      path: '/hook',
      method: 'POST',
      timeout: POST_TIMEOUT_MS,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.hookToken}`, 'content-length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('timeout', () => req.destroy());
    req.on('error', resolve);
    req.end(body);
  });
}

async function main(text) {
  if (agent && !Object.hasOwn(ADAPTERS, agent)) return;
  // Claude Code's hook also reaches servers started with `node-code start`, so one
  // map can show every agent.
  const dataDirs = agent ? [defaultDataDir()] : [process.env.CLAUDE_PLUGIN_DATA, defaultDataDir()];
  const servers = dataDirs.filter(Boolean).flatMap((dir) => list(dir));
  if (!servers.length) return;
  let raw = JSON.parse(text);
  if (agent) raw = require(ADAPTERS[agent]).toClaude(raw, { pathExists: fs.existsSync });
  const msg = extract(raw, { pathExists: fs.existsSync });
  const cwd = msg.cwd || process.cwd();
  const candidates = [msg.filePath, msg.searchPath, ...(msg.changed?.files || []), cwd]
    .filter(Boolean)
    .map((p) => realpathOfDeepestExisting(path.resolve(cwd, p)));
  const server = pickServer(servers, candidates);
  if (server) await send(server, JSON.stringify({ hookAt, msg }));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  main(input).catch(() => {}).finally(() => process.exit(0));
});
process.stdin.on('error', () => process.exit(0));
