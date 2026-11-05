'use strict';
const { stripComments, unique } = require('./strip');

const REQUIRE = /^[ \t]*(require_relative|require|load)[ \t(]+['"]([^'"\n]+)['"]/gm;
const DEFS = /^(?:class|module)[ \t]+([A-Z][\w:]*)|^def[ \t]+(?:self\.)?([A-Za-z_][\w?!=]*)/gm;

function parse(source) {
  const text = stripComments(source.replace(/^=begin\b[\s\S]*?^=end\b/gm, ''), { line: false, hash: true });
  const imports = [...new Map([...text.matchAll(REQUIRE)].map((m) => [m[2], { spec: m[2], relative: m[1] === 'require_relative' }])).values()];
  const symbols = unique([...text.matchAll(DEFS)].map((m) => m[1] || m[2]));
  return { imports, exports: symbols, symbols };
}

module.exports = { parse };
