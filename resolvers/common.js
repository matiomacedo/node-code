'use strict';
const path = require('node:path');

// Normalizes a repo-relative path; null when it leaves the repo.
function inRepo(p) {
  const n = path.posix.normalize(p).replace(/^\.\//, '');
  return n === '..' || n.startsWith('../') || n.startsWith('/') ? null : n;
}

// The first candidate that is a known file, as a one-element list.
function firstFile(candidates, has) {
  for (const c of candidates) {
    const rel = c === null ? null : inRepo(c);
    if (rel && has(rel)) return [rel];
  }
  return [];
}

module.exports = { inRepo, firstFile };
