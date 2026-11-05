'use strict';
const path = require('node:path');
const { firstFile } = require('./common');

// Class names go through composer.json's PSR-4 map; include paths are tried
// beside the file and from the repo root (PHP's real base is the working dir).
function resolvePhp({ spec, dirRelative, namespace }, fromFile, { has, project }) {
  if (namespace) {
    for (const { prefix, dirs } of project.psr4) {
      if (!spec.startsWith(prefix)) continue;
      const rest = `${spec.slice(prefix.length).replaceAll('\\', '/')}.php`;
      const hit = firstFile(dirs.map((d) => path.posix.join(d, rest)), has);
      if (hit.length) return hit;
    }
    return [];
  }
  const here = path.posix.dirname(fromFile);
  if (dirRelative) return firstFile([path.posix.join(here, spec)], has);
  if (spec.startsWith('/')) return [];
  return firstFile([path.posix.join(here, spec), spec], has);
}

module.exports = { resolvePhp };
