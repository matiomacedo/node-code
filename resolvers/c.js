'use strict';
const path = require('node:path');
const { firstFile } = require('./common');

const INCLUDE_DIRS = ['include', 'src', ''];

// Quoted includes look beside the file first; then the usual include folders;
// then, for quoted includes only, any file whose path ends with the spec if
// exactly one does. <string.h> must not bind to a vendored string.h.
function resolveC({ spec, system }, fromFile, { has, named }) {
  const here = path.posix.dirname(fromFile);
  const local = system ? [] : [path.posix.join(here, spec)];
  const hit = firstFile([...local, ...INCLUDE_DIRS.map((d) => path.posix.join(d, spec))], has);
  if (hit.length || system) return hit;
  const tail = `/${spec.replace(/^(\.\.?\/)+/, '')}`;
  const matches = named(path.posix.basename(spec)).filter((f) => `/${f}`.endsWith(tail));
  return matches.length === 1 ? matches : [];
}

module.exports = { resolveC };
