'use strict';
const path = require('node:path');
const { firstFile } = require('./common');

const ROOT_FILES = ['lib.rs', 'main.rs', 'mod.rs', 'build.rs'];
const CRATE_DIRS = ['tests', 'examples', 'benches'];

// Integration tests, examples, benches and src/bin/*.rs are each their own
// crate root, so their child modules sit beside them.
function isRootFile(file) {
  const dir = path.posix.dirname(file);
  if (ROOT_FILES.includes(path.posix.basename(file))) return true;
  return CRATE_DIRS.includes(path.posix.basename(dir)) || dir === 'src/bin' || dir.endsWith('/src/bin');
}

// The folder holding a module's child modules: foo.rs -> foo/, a root -> its folder.
function childDir(file) {
  const dir = path.posix.dirname(file);
  return isRootFile(file) ? dir : path.posix.join(dir, path.posix.basename(file).slice(0, -3));
}

const moduleFile = (dir, has) => firstFile([`${dir}.rs`, `${dir}/mod.rs`, `${dir}/lib.rs`, `${dir}/main.rs`], has)[0];

function crateRoot(file, has) {
  if (isRootFile(file) && path.posix.basename(file) !== 'mod.rs') return path.posix.dirname(file);
  for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
    if (has(path.posix.join(dir, 'lib.rs')) || has(path.posix.join(dir, 'main.rs'))) return dir;
    if (dir === '.') return null;
  }
}

// Follows path segments from dir while they name module files; the deepest one wins.
function walk(dir, segments, has) {
  let best = null;
  for (const seg of segments) {
    const hit = firstFile([path.posix.join(dir, `${seg}.rs`), path.posix.join(dir, seg, 'mod.rs')], has)[0];
    if (!hit) break;
    best = hit;
    dir = path.posix.join(dir, seg);
  }
  return best;
}

function resolveRust({ spec, mod }, fromFile, { has }) {
  const here = childDir(fromFile);
  if (mod) return firstFile([path.posix.join(here, `${mod}.rs`), path.posix.join(here, mod, 'mod.rs')], has);
  const segments = spec.split('::');
  let start;
  if (segments[0] === 'crate') {
    start = crateRoot(fromFile, has);
    segments.shift();
  } else if (segments[0] === 'self' || segments[0] === 'super') {
    start = here;
    if (segments[0] === 'self') segments.shift();
    while (segments[0] === 'super') { start = path.posix.dirname(start); segments.shift(); }
  } else {
    // A bare path is a child module of this one or of the crate root, or external.
    const local = walk(here, segments, has);
    if (local) return [local];
    const root = crateRoot(fromFile, has);
    const fromRoot = root === null ? null : walk(root, segments, has);
    return fromRoot ? [fromRoot] : [];
  }
  if (start === null) return [];
  const hit = walk(start, segments, has) || moduleFile(start, has);
  return hit && hit !== fromFile ? [hit] : [];
}

module.exports = { resolveRust };
