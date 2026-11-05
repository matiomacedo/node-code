'use strict';
// Java, Kotlin and Scala: imports name packages and classes, not files, so the
// resolver goes through each file's declared package.
const { stripComments, unique } = require('./strip');

const PACKAGE = /^[ \t]*package[ \t]+([\w.]+)/m;
const IMPORT = /^[ \t]*import[ \t]+(?:static[ \t]+)?(\w+(?:\.\w+)*)(?:\.(\*|_|\{[^}\n]*\}))?/gm;
const MODS = '(?:(?:public|private|protected|internal|abstract|final|sealed|open|data|static|inline|value|enum|annotation|case|implicit|lazy|override|suspend|inner|const)[ \\t]+)*';
const DECL = new RegExp(`^(?:@\\w+(?:\\([^)\\n]*\\))?[ \\t]+)*(${MODS})(?:class|interface|enum|record|object|trait|fun|def|val|var|typealias|@interface)[ \\t]+([A-Za-z_]\\w*)`, 'gm');

function parse(source) {
  const text = stripComments(source);
  const specs = [];
  for (const m of text.matchAll(IMPORT)) {
    if (!m[2]) specs.push(m[1].replace(/\._$/, '.*')); // Scala's `_` is a word character.
    else if (m[2] === '*' || m[2] === '_') specs.push(`${m[1]}.*`);
    else {
      // Scala selectors: {A, B => C, _}
      for (const part of m[2].slice(1, -1).split(',')) {
        const name = part.trim().split(/\s*=>\s*/)[0];
        if (name) specs.push(name === '_' ? `${m[1]}.*` : `${m[1]}.${name}`);
      }
    }
  }
  const decls = [...text.matchAll(DECL)];
  return {
    imports: unique(specs).map((spec) => ({ spec })),
    exports: unique(decls.filter((m) => !/\b(?:private|protected|internal)\b/.test(m[1])).map((m) => m[2])),
    symbols: unique(decls.map((m) => m[2])),
    pkg: text.match(PACKAGE)?.[1] || '',
  };
}

module.exports = { parse };
