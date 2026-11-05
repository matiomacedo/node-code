#!/usr/bin/env node
'use strict';
// Runs as an async hook on every matched tool call. Must stay cheap and must
// never affect Claude: it swallows every error and always exits 0.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { list, pickServer } = require('../server/registry');
const { extract } = require('../server/hook-payload');
const { realpathOfDeepestExisting } = require('../server/repo-index');

const POST_TIMEOUT_MS = 500;
const hookAt = performance.timeOrigin;

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
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) return;
  const servers = list(dataDir);
  if (!servers.length) return;
  const msg = extract(JSON.parse(text), { pathExists: fs.existsSync });
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
