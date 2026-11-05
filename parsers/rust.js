'use strict';
const { stripComments, all, unique } = require('./strip');

const VIS = '(?:pub(?:\\([^)]*\\))?[ \\t]+)';
const MOD = new RegExp(`^[ \\t]*${VIS}?mod[ \\t]+([A-Za-z_]\\w*)[ \\t]*;`, 'gm');
const USE = new RegExp(`^[ \\t]*${VIS}?use[ \\t]+([^;]+);`, 'gm');
const ITEM = '(?:(?:async|const|unsafe|extern(?:[ \\t]+"[^"]*")?)[ \\t]+)*(?:fn|struct|enum|trait|type|const|static|mod|union|macro_rules!)[ \\t]+([A-Za-z_]\\w*)';
const TOP_ITEM = new RegExp(`^(${VIS})?${ITEM}`, 'gm');

// Expands `a::{b, c::{d, e}}` into ['a::b', 'a::c::d', 'a::c::e'].
function expand(tree) {
  const t = tree.replace(/\s+as\s+\w+/g, '').replace(/\s+/g, '');
  const open = t.indexOf('{');
  if (open < 0) return [t.replace(/(?:::\*)?$/, '')];
  const prefix = t.slice(0, open);
  const inner = t.slice(open + 1, t.lastIndexOf('}'));
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= inner.length; i++) {
    const c = inner[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if ((c === ',' && depth === 0) || i === inner.length) {
      if (i > start) parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  return parts.flatMap((p) => expand(p).map((x) => (x === 'self' ? prefix.replace(/::$/, '') : prefix + x)));
}

function parse(source) {
  const text = stripComments(source, { single: false });
  const mods = all(MOD, text).map((name) => ({ spec: `mod ${name}`, mod: name }));
  const uses = unique(all(USE, text).flatMap(expand)).filter(Boolean).map((spec) => ({ spec }));
  const items = [...text.matchAll(TOP_ITEM)];
  return {
    imports: [...mods, ...uses],
    exports: unique(items.filter((m) => m[1]).map((m) => m[2])),
    symbols: unique(items.map((m) => m[2])),
  };
}

module.exports = { parse, expand };
