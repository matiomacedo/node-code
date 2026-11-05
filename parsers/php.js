'use strict';
const { stripComments, unique } = require('./strip');

const INCLUDE = /\b(?:require|include)(?:_once)?\b[ \t(]*(__DIR__[ \t]*\.[ \t]*)?['"]([^'"\n]+)['"]/g;
const USE = /^[ \t]*use[ \t]+(?:function[ \t]+|const[ \t]+)?\\?([\w\\]+?)\\?(?:\{([^}]*)\})?[ \t]*(?:as[ \t]+\w+[ \t]*)?[;,]/gm;
const DECL = /^[ \t]*(?:(?:abstract|final|readonly)[ \t]+)*(?:class|interface|trait|enum)[ \t]+([A-Za-z_]\w*)|^function[ \t]+&?([A-Za-z_]\w*)/gm;

function parse(source) {
  const text = stripComments(source, { hash: true });
  const imports = [];
  for (const m of text.matchAll(INCLUDE)) imports.push({ spec: m[2], dirRelative: Boolean(m[1]) });
  for (const m of text.matchAll(USE)) {
    if (!m[2]) imports.push({ spec: m[1], namespace: true });
    else {
      for (const part of m[2].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name) imports.push({ spec: `${m[1]}\\${name}`, namespace: true });
      }
    }
  }
  const symbols = unique([...text.matchAll(DECL)].map((m) => m[1] || m[2]));
  return { imports: [...new Map(imports.map((i) => [i.spec, i])).values()], exports: symbols, symbols };
}

module.exports = { parse };
