'use strict';
const { stripComments, all, unique } = require('./strip');

const VIS = '(?:pub(?:\\([^)]*\\))?[ \\t]+)';
const MOD = new RegExp(`^[ \\t]*${VIS}?mod[ \\t]+([A-Za-z_]\\w*)[ \\t]*;`, 'gm');
const USE = new RegExp(`^[ \\t]*${VIS}?use[ \\t]+([^;]+);`, 'gm');
const ITEM = '(?:(?:async|const|unsafe|extern(?:[ \\t]+"[^"]*")?)[ \\t]+)*(?:fn|struct|enum|trait|type|const|static|mod|union|macro_rules!)[ \\t]+([A-Za-z_]\\w*)';
const TOP_ITEM = new RegExp(`^(${VIS})?${ITEM}`, 'gm');
const INLINE_MOD = new RegExp(`^[ \\t]*${VIS}?mod[ \\t]+[A-Za-z_]\\w*[ \\t]*\\{`, 'gm');

// The bodies of inline modules (`mod tests { ... }`) as [start, end) offsets, braces matched
// outside string literals.
function inlineBodies(text) {
  const bodies = [];
  for (const m of text.matchAll(INLINE_MOD)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (c === '"') {
        for (i++; i < text.length && text[i] !== '"'; i += text[i] === '\\' ? 2 : 1);
      } else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    bodies.push([start, i]);
  }
  return bodies;
}

// A use path written `depth` inline modules deep, as seen from the file's own module. Each
// leading `super` first climbs out of one inline module, so `super::*` in `mod tests` is the
// file itself. Paths that never leave the file (self::, or too few supers) give null.
function fromFileModule(spec, depth) {
  if (depth === 0) return spec;
  const segments = spec.split('::');
  if (segments[0] === 'self') return null;
  if (segments[0] !== 'super') return spec;
  let supers = 0;
  while (segments[supers] === 'super') supers++;
  if (supers < depth) return null;
  const rest = segments.slice(supers);
  const up = supers - depth;
  return [...(up === 0 ? ['self'] : Array(up).fill('super')), ...rest].join('::');
}

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
  const bodies = inlineBodies(text);
  const depthAt = (offset) => bodies.filter(([start, end]) => start <= offset && offset < end).length;
  const uses = unique(
    [...text.matchAll(USE)].flatMap((m) => expand(m[1]).map((spec) => fromFileModule(spec, depthAt(m.index)))),
  )
    .filter(Boolean)
    .map((spec) => ({ spec }));
  const items = [...text.matchAll(TOP_ITEM)];
  return {
    imports: [...mods, ...uses],
    exports: unique(items.filter((m) => m[1]).map((m) => m[2])),
    symbols: unique(items.map((m) => m[2])),
  };
}

module.exports = { parse, expand };
