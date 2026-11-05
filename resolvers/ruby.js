'use strict';
const path = require('node:path');
const { firstFile } = require('./common');

const withRb = (p) => (p.endsWith('.rb') ? [p] : [`${p}.rb`, p]);

function resolveRuby({ spec, relative }, fromFile, { has }) {
  const here = path.posix.dirname(fromFile);
  const bases = relative ? [path.posix.join(here, spec)] : [path.posix.join('lib', spec), spec, path.posix.join(here, spec)];
  return firstFile(bases.flatMap(withRb), has);
}

module.exports = { resolveRuby };
