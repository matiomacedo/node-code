'use strict';
const { unique } = require('./strip');

// A # starts a comment only at the start of a word.
const stripComments = (src) => src.replace(/(^|[ \t;])#.*$/gm, '$1');

const SOURCE = /(?:^|&&|\|\||;|\bthen|\bdo|\belse)[ \t]*(?:source|\.)[ \t]+((?:"[^"\n]*(?:"[^"\n]*"[^"\n]*)*"|'[^'\n]*'|[^\s;|&])+)/gm;
const FUNC = /^[ \t]*(?:function[ \t]+([\w:.-]+)|([\w:.-]+)[ \t]*\(\)[ \t]*\{?)/gm;

function parse(source) {
  const text = stripComments(source);
  const imports = unique([...text.matchAll(SOURCE)].map((m) => m[1].replace(/["']/g, ''))).map((spec) => ({ spec }));
  const symbols = unique([...text.matchAll(FUNC)].map((m) => m[1] || m[2]));
  return { imports, exports: symbols, symbols };
}

module.exports = { parse };
