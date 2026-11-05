'use strict';
// Dependency parsing off the main thread, so it can never delay hook handling.
const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { parserFor } = require('../parsers/registry');
const { loadTsconfigPaths } = require('../resolvers/javascript');
const { MAX_SIZE } = require('./source');

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

// Project files some resolvers need: every go.mod's module path, and the
// composer.json PSR-4 map.
function readProject() {
  const goModules = [];
  for (const rel of known) {
    if (path.posix.basename(rel) !== 'go.mod') continue;
    try {
      const m = fs.readFileSync(path.join(root, rel), 'utf8').match(/^module\s+(\S+)/m);
      if (m) goModules.push({ dir: path.posix.dirname(rel), module: m[1] });
    } catch { /* unreadable go.mod: skip */ }
  }
  goModules.sort((a, b) => b.module.length - a.module.length);
  let psr4 = [];
  try {
    const { autoload = {}, 'autoload-dev': dev = {} } = JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf8'));
    psr4 = Object.entries({ ...dev['psr-4'], ...autoload['psr-4'] })
      .map(([prefix, dirs]) => ({ prefix, dirs: [].concat(dirs) }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
  } catch { /* no composer.json */ }
  return { goModules, psr4 };
}

const group = (entries) => {
  const map = new Map();
  for (const [key, value] of entries) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
};

const MAX_TARGETS = 50; // One `using System.X` or big Go package must not flood the graph.

// Resolved targets are recomputed every time: a new file can satisfy an import
// that was unresolved before.
let project = null; // Re-read only when a go.mod or composer.json changes.
let fileMaps = null; // Rebuilt only when files are added or removed.

function resolved(tsconfig) {
  project ??= readProject();
  fileMaps ??= {
    dirs: group([...known].map((f) => [path.posix.dirname(f), f])),
    names: group([...known].map((f) => [path.posix.basename(f), f])),
  };
  const { dirs, names } = fileMaps;
  const packages = group([...parsed].filter(([, p]) => p.pkg).map(([rel, p]) => [p.pkg, rel]));
  const ctx = {
    has: (f) => known.has(f),
    tsconfig,
    project,
    filesIn: (dir) => dirs.get(dir) || [],
    named: (base) => names.get(base) || [],
    declared: (pkg) => packages.get(pkg) || [],
  };
  const out = {};
  for (const [rel, p] of parsed) {
    const parser = parserFor(rel);
    out[rel] = {
      imports: p.imports.map((imp) => ({ spec: imp.spec, targets: parser.resolve(imp, rel, ctx).slice(0, MAX_TARGETS) })),
      exports: p.exports,
      symbols: p.symbols,
    };
  }
  return out;
}

const PROJECT_FILES = new Set(['go.mod', 'composer.json']);

parentPort.on('message', ({ added = [], removed = [], changed = [] }) => {
  if (added.length || removed.length) fileMaps = null;
  if ([...added, ...removed, ...changed].some((f) => PROJECT_FILES.has(path.posix.basename(f)))) project = null;
  for (const rel of removed) { known.delete(rel); parsed.delete(rel); }
  for (const rel of added) known.add(rel);
  for (const rel of [...added, ...changed]) parseFile(rel);
  parentPort.postMessage(resolved(readTsconfig()));
});
