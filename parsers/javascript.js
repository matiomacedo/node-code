'use strict';

// Blanks comments and template text, keeping quoted strings because import
// specifiers live in them. Regex literals are not recognised, which only
// matters when one contains a quote or comment marker.
function stripNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
    } else if (c === '"' || c === "'") {
      const start = i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      out += src.slice(start, i);
    } else if (c === '`') {
      i++;
      while (i < n && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;
      i++;
      out += '``';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const STATIC_IMPORT = /^[ \t]*import\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"\n]+)['"]/gm;
const RE_EXPORT = /^[ \t]*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s+['"]([^'"\n]+)['"]/gm;
const CALL_IMPORT = /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

const DECL = '(?:async\\s+)?(?:function\\*?|class|interface|enum|type|const|let|var)';
const EXPORT_DECL = new RegExp(`^[ \\t]*export\\s+(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?${DECL}\\s+([A-Za-z_$][\\w$]*)`, 'gm');
const EXPORT_LIST = /^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/gm;
const CJS_EXPORT = /^[ \t]*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm;
const CJS_OBJECT = /^[ \t]*module\.exports\s*=\s*\{([^}]*)\}/gm;
const TOP_DECL = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?${DECL}\\s+([A-Za-z_$][\\w$]*)`, 'gm');

const all = (re, text) => [...text.matchAll(re)].map((m) => m[1]);

function parse(source) {
  const text = stripNoise(source);
  const imports = [...new Set([...all(STATIC_IMPORT, text), ...all(RE_EXPORT, text), ...all(CALL_IMPORT, text)])]
    .map((spec) => ({ spec }));
  const listed = all(EXPORT_LIST, text).flatMap((body) => body.split(',')
    .map((part) => part.trim().split(/\s+as\s+/).at(-1).trim())
    .filter(Boolean));
  const cjsObject = all(CJS_OBJECT, text).flatMap((body) => body.split(',')
    .map((part) => part.trim().split(/[:\s(]/)[0])
    .filter(Boolean));
  const exports = [...new Set([...all(EXPORT_DECL, text), ...listed, ...all(CJS_EXPORT, text), ...cjsObject])];
  const symbols = [...new Set(all(TOP_DECL, text))];
  return { imports, exports, symbols };
}

module.exports = { parse };
