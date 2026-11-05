'use strict';
const path = require('node:path');
const { firstFile } = require('./common');

// A root-absolute /x is tried from the repo root, then from the page's own
// folder, which is often what a dev server serves as its root.
function resolveHtml({ spec }, fromFile, { has }) {
  const here = path.posix.dirname(fromFile);
  if (!spec.startsWith('/')) return firstFile([path.posix.join(here, spec)], has);
  return firstFile([spec.slice(1), path.posix.join(here, spec.slice(1))], has);
}

module.exports = { resolveHtml };
