'use strict';
const path = require('node:path');
const { firstFile } = require('./common');

const EXTS = ['.scss', '.sass', '.less', '.css'];

// Sass looks for partials (_name.scss) and index files as well as the plain name.
function variants(base) {
  const dir = path.posix.dirname(base);
  const name = path.posix.basename(base);
  const out = [base];
  for (const ext of EXTS) out.push(base + ext, path.posix.join(dir, `_${name}${ext}`));
  for (const ext of EXTS) out.push(path.posix.join(base, `_index${ext}`), path.posix.join(base, `index${ext}`));
  return out;
}

function resolveCss({ spec, external }, fromFile, { has }) {
  if (external) return [];
  const clean = spec.replace(/[?#].*$/, '');
  const base = clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(fromFile), clean);
  return firstFile(variants(base), has);
}

module.exports = { resolveCss };
