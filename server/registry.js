'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const serversDir = (dataDir) => path.join(dataDir, 'servers');
const entryPath = (dataDir, root) =>
  path.join(serversDir(dataDir), `${crypto.createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`);

function write(dataDir, entry) {
  fs.mkdirSync(serversDir(dataDir), { recursive: true, mode: 0o700 });
  const target = entryPath(dataDir, entry.root);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function read(dataDir, root) {
  try {
    return JSON.parse(fs.readFileSync(entryPath(dataDir, root), 'utf8'));
  } catch {
    return null;
  }
}

function remove(dataDir, root) {
  fs.rmSync(entryPath(dataDir, root), { force: true });
}

// Removes the entry only if this process wrote it, so an orphaned server
// shutting down cannot unregister the live one.
function removeOwned(dataDir, root, pid) {
  if (read(dataDir, root)?.pid === pid) remove(dataDir, root);
}

function list(dataDir) {
  let names;
  try { names = fs.readdirSync(serversDir(dataDir)); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(serversDir(dataDir), name), 'utf8'))); } catch { /* being replaced */ }
  }
  return out;
}

// The first candidate path inside a registered repo decides; nested repos go to
// the deepest root.
function pickServer(servers, candidates) {
  for (const p of candidates) {
    const inside = servers.filter((s) => p === s.root || p.startsWith(s.root + path.sep));
    if (inside.length) return inside.reduce((a, b) => (b.root.length > a.root.length ? b : a));
  }
  return null;
}

module.exports = { write, read, remove, removeOwned, list, pickServer };
