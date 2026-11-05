'use strict';
const path = require('node:path');

const SOURCE_ROOTS = ['', 'src'];

function moduleFile(base, has) {
  for (const f of [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`]) if (has(f)) return f;
  return null;
}

function resolveIn(dir, dotted, names, has) {
  const base = path.posix.join(dir, ...(dotted ? dotted.split('.') : []));
  const out = [];
  const own = dotted ? moduleFile(base, has) : null;
  if (own) out.push(own);
  for (const name of names) {
    const sub = moduleFile(path.posix.join(base, name), has);
    if (sub && !out.includes(sub)) out.push(sub);
  }
  return out;
}

function resolvePython({ spec, names = [] }, fromFile, { has }) {
  const here = path.posix.dirname(fromFile);
  const dots = spec.match(/^\.*/)[0].length;
  if (dots) {
    let dir = here;
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    return resolveIn(dir, spec.slice(dots), names, has);
  }
  for (const root of [...SOURCE_ROOTS, here]) {
    const hit = resolveIn(root, spec, names, has);
    if (hit.length) return hit;
  }
  return [];
}

module.exports = { resolvePython };
