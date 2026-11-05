'use strict';
const { stripComments, unique } = require('./strip');

const AT_RULE = /@(?:import|use|forward)\b([^;]+);/g;
const PATHS = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)|['"]([^'"\n]+)['"]/g;
const EXTERNAL = /^(?:[a-z]+:|\/\/|~)/i; // http:, sass:, //cdn, ~package

function parse(source) {
  // `//` is not touched: it would eat unquoted url(http://...) in plain CSS.
  const text = stripComments(source, { line: false });
  const specs = [];
  for (const m of text.matchAll(AT_RULE)) {
    // `@use "x" with ($k: "v")` and `@forward "x" show/hide ...`: only what precedes is a path.
    const target = m[1].split(/\s(?:with|as|show|hide)\b/)[0];
    for (const p of target.matchAll(PATHS)) specs.push(p[1] || p[2]);
  }
  return { imports: unique(specs).map((spec) => ({ spec, external: EXTERNAL.test(spec) })), exports: [], symbols: [] };
}

module.exports = { parse };
