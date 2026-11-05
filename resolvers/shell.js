'use strict';
const path = require('node:path');
const { firstFile } = require('./common');

// "$DIR/lib.sh", "$(dirname "$0")/lib.sh" and the like are taken to mean the
// script's own folder. Other variables cannot be resolved.
function resolveShell({ spec }, fromFile, { has }) {
  const rel = spec.replace(/^\$(?:\([^)]*\)|\{[^}]*\}|\w+)\//, '');
  if (rel.startsWith('/') || rel.startsWith('~') || rel.includes('$')) return [];
  return firstFile([path.posix.join(path.posix.dirname(fromFile), rel), rel], has);
}

module.exports = { resolveShell };
