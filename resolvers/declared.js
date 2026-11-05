'use strict';
// Resolves package or namespace imports through ctx.declared, the index of each
// parsed file's package. `family` keeps Java packages and C# namespaces apart.
const path = require('node:path');

const stem = (f) => path.posix.basename(f).replace(/\.[^.]+$/, '');

function byPackage(family) {
  const ours = (f) => family.includes(path.posix.extname(f));
  return function resolveDeclared({ spec, wildcard }, fromFile, { declared }) {
    const name = spec.replace(/\.\*$/, '');
    if (spec.endsWith('.*') || wildcard) return declared(name).filter(ours).filter((f) => f !== fromFile).sort();
    // a.b.C, a.b.C.member or a.b.C.Inner: try the longest package first.
    const parts = name.split('.');
    for (let i = parts.length - 1; i >= 1; i--) {
      const hit = declared(parts.slice(0, i).join('.')).filter(ours).filter((f) => stem(f) === parts[i]);
      if (hit.length) return hit.sort();
    }
    return [];
  };
}

module.exports = { byPackage };
