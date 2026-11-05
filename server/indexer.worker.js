'use strict';
// Dependency parsing off the main thread, so it can never delay hook handling.
const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { parserFor } = require('../parsers/registry');
const { loadTsconfigPaths } = require('../resolvers/javascript');

const MAX_SIZE = 512 * 1024;
const MIN_NEWLINE_WITHIN = 8192; // A longer first line means minified: skip it.

const { root } = workerData;
const known = new Set();
const parsed = new Map();

function readTsconfig() {
  try { return loadTsconfigPaths(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')); } catch { return null; }
}

function parseFile(rel) {
  const parser = parserFor(rel);
  if (!parser) return;
  try {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).size > MAX_SIZE) { parsed.delete(rel); return; }
    const source = fs.readFileSync(abs, 'utf8');
    if (source.length > MIN_NEWLINE_WITHIN && !source.slice(0, MIN_NEWLINE_WITHIN).includes('\n')) {
      parsed.delete(rel);
      return;
    }
    parsed.set(rel, parser.parse(source));
  } catch {
    parsed.delete(rel);
  }
}

// Resolved targets are recomputed every time: a new file can satisfy an import
// that was unresolved before.
function resolved(tsconfig) {
  const ctx = { has: (f) => known.has(f), tsconfig };
  const out = {};
  for (const [rel, p] of parsed) {
    const parser = parserFor(rel);
    out[rel] = {
      imports: p.imports.map((imp) => ({ spec: imp.spec, targets: parser.resolve(imp, rel, ctx) })),
      exports: p.exports,
      symbols: p.symbols,
    };
  }
  return out;
}

parentPort.on('message', ({ added = [], removed = [], changed = [] }) => {
  for (const rel of removed) { known.delete(rel); parsed.delete(rel); }
  for (const rel of added) known.add(rel);
  for (const rel of [...added, ...changed]) parseFile(rel);
  parentPort.postMessage(resolved(readTsconfig()));
});
