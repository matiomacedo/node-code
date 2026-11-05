'use strict';
const { stripComments, all, unique } = require('./strip');

const SINGLE = /^import[ \t]+(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm;
const BLOCK = /^import[ \t]*\(([^)]*)\)/gm;
const IN_BLOCK = /^[ \t]*(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm;
const FUNC = /^func[ \t]+(?:\([^)]*\)[ \t]*)?([A-Za-z_]\w*)/gm;
const DECL = /^(?:type|var|const)[ \t]+([A-Za-z_]\w*)/gm;
const GROUP = /^(?:type|var|const)[ \t]*\(([\s\S]*?)^\)/gm;

// Names declared at the group's own level, skipping struct fields and
// continuation lines inside braces or parentheses.
function groupNames(body) {
  const names = [];
  let depth = 0;
  for (const line of body.split('\n')) {
    const m = depth === 0 && line.match(/^[ \t]+([A-Za-z_]\w*)/);
    if (m) names.push(m[1]);
    for (const ch of line) {
      if (ch === '{' || ch === '(') depth++;
      else if (ch === '}' || ch === ')') depth--;
    }
  }
  return names;
}

function parse(source) {
  const text = stripComments(source, { single: false, backtick: true });
  const specs = [...all(SINGLE, text), ...all(BLOCK, text).flatMap((body) => all(IN_BLOCK, body))];
  const symbols = unique([...all(FUNC, text), ...all(DECL, text), ...all(GROUP, text).flatMap(groupNames)]);
  return {
    imports: unique(specs).map((spec) => ({ spec })),
    exports: symbols.filter((s) => /^[A-Z]/.test(s)),
    symbols,
  };
}

module.exports = { parse };
