'use strict';

// Blanks comments and string bodies so their text cannot look like code.
function stripNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      const start = i;
      i += q.length;
      while (i < n && !src.startsWith(q, i) && (triple || src[i] !== '\n')) i += src[i] === '\\' ? 2 : 1;
      i += q.length;
      // Keep strings on one line (needed by __all__); triple-quoted ones go.
      out += triple ? '""' : src.slice(start, i);
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const IMPORT = /^[ \t]*import[ \t]+([^\n]+)/gm;
const FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm;
const TOP_DEF = /^(?:async[ \t]+def|def|class)[ \t]+([A-Za-z_]\w*)|^([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)/gm;
const DUNDER_ALL = /^__all__[ \t]*(?::[^=\n]+)?=[ \t]*[[(]([^\])]*)[\])]/m;

const firstWords = (body) => body.replace(/[()\\]/g, ' ').split(',')
  .map((p) => p.trim().split(/\s+/)[0])
  .filter(Boolean);

function parse(source) {
  const text = stripNoise(source);
  const found = [];
  for (const m of text.matchAll(IMPORT)) {
    for (const spec of firstWords(m[1])) found.push({ at: m.index, spec });
  }
  for (const m of text.matchAll(FROM)) {
    const names = firstWords(m[2]).filter((n) => n !== '*');
    found.push({ at: m.index, spec: m[1], names });
  }
  found.sort((a, b) => a.at - b.at);
  const bySpec = new Map();
  for (const { spec, names } of found) {
    const record = bySpec.get(spec);
    if (!record) bySpec.set(spec, names ? { spec, names } : { spec });
    else if (names) record.names = [...new Set([...(record.names || []), ...names])];
  }
  const imports = [...bySpec.values()];

  const symbols = [...new Set([...text.matchAll(TOP_DEF)].map((m) => m[1] || m[2]))].filter((s) => s !== '__all__');
  const declared = text.match(DUNDER_ALL);
  const exports = declared
    ? [...declared[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
    : symbols.filter((s) => !s.startsWith('_'));
  return { imports, exports, symbols };
}

module.exports = { parse };
