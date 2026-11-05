'use strict';

// Blanks comments so their text cannot look like code, keeping string literals
// because import paths live in them. Newlines are kept so `^` anchors still work.
//   line:     treat // as a line comment (default true)
//   hash:     treat # as a line comment
//   single:   ' starts a string (false for Rust, where 'a is a lifetime)
//   backtick: blank `...` raw strings (Go)
function stripComments(src, { line = true, hash = false, single = true, backtick = false } = {}) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if ((line && c === '/' && d === '/') || (hash && c === '#')) {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
    } else if (c === '"' || (single && c === "'")) {
      const start = i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      out += src.slice(start, i);
    } else if (backtick && c === '`') {
      const end = src.indexOf('`', i + 1);
      const stop = end < 0 ? n : end + 1;
      out += src.slice(i, stop).replace(/[^\n]/g, '') + '``';
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const all = (re, text, group = 1) => [...text.matchAll(re)].map((m) => m[group]);
const unique = (list) => [...new Set(list)];

module.exports = { stripComments, all, unique };
