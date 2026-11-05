'use strict';
const { stripComments, all, unique } = require('./strip');

const INCLUDE = /^[ \t]*#[ \t]*include[ \t]*([<"])([^>"\n]+)[>"]/gm;
// Unindented definitions only: a body opening on the same or the next line.
const FUNCTION = /^(?!(?:if|for|while|switch|return|else|do)\b)([A-Za-z_][\w \t*&:<>,]*?[\s*&])([A-Za-z_]\w*(?:::[A-Za-z_~]\w*)*)[ \t]*\([^;{}]*\)[^;{}]*\{/gm;
const TYPE = /^(?:typedef[ \t]+)?(?:template[ \t]*<[^>]*>[ \t]*)?(struct|class|enum(?:[ \t]+class)?|union)[ \t]+([A-Za-z_]\w*)[^;\n(]*(?:\{|$)/gm;
const TYPEDEF = /^typedef\b[^;{]*?([A-Za-z_]\w*)[ \t]*;/gm;
// `typedef struct {...} Name;` on one line or several (the closing brace at column 0).
const TYPEDEF_BODY = /^typedef\b[^;{]*\{[^{}]*\}[ \t]*([A-Za-z_]\w*)[ \t]*;|^}[ \t]*([A-Za-z_]\w*)[ \t]*;/gm;
const DEFINE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm;

function parse(source) {
  const text = stripComments(source);
  const imports = unique([...text.matchAll(INCLUDE)].map((m) => `${m[1]}${m[2]}`))
    .map((key) => ({ spec: key.slice(1), system: key[0] === '<' }));
  const functions = [...text.matchAll(FUNCTION)];
  const exported = functions.filter((m) => !/\bstatic\b/.test(m[1])).map((m) => m[2]);
  const types = [...all(TYPE, text, 2), ...all(TYPEDEF, text), ...[...text.matchAll(TYPEDEF_BODY)].map((m) => m[1] || m[2])];
  const symbols = unique([...functions.map((m) => m[2]), ...types, ...all(DEFINE, text)]);
  return { imports, exports: unique([...exported, ...types]), symbols };
}

module.exports = { parse };
