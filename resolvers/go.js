'use strict';
const path = require('node:path');

// A package path inside a module in this repo maps to that folder's .go files.
function resolveGo({ spec }, fromFile, { project, filesIn }) {
  for (const { dir, module } of project.goModules) {
    if (spec !== module && !spec.startsWith(`${module}/`)) continue;
    const pkgDir = path.posix.join(dir, spec.slice(module.length));
    return filesIn(pkgDir === '' ? '.' : pkgDir)
      .filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
      .sort();
  }
  return [];
}

module.exports = { resolveGo };
