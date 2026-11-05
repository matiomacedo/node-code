'use strict';
const { stripComments, unique } = require('./strip');

const NAMESPACE = /^[ \t]*namespace[ \t]+([\w.]+)/m;
// `using X;`, `global using X;`, `using static X.Y;`, `using A = X.Y;`. Not `using (...)` or `using var`.
const USING = /^[ \t]*(?:global[ \t]+)?using[ \t]+(static[ \t]+)?(?:(\w+)[ \t]*=[ \t]*)?([\w.]+)[ \t]*;/gm;
const TYPE = /^[ \t]*((?:(?:public|internal|private|protected|static|abstract|sealed|partial|readonly|ref|unsafe|file|new)[ \t]+)*)(?:class|interface|struct|enum|record(?:[ \t]+(?:class|struct))?)[ \t]+([A-Za-z_]\w*)/gm;

function parse(source) {
  const text = stripComments(source);
  const imports = [];
  for (const m of text.matchAll(USING)) {
    if (m[3] === 'var') continue;
    // Plain usings name a namespace; static and alias usings usually name a type.
    imports.push(m[1] || m[2] ? { spec: m[3] } : { spec: m[3], wildcard: true });
  }
  const types = [...text.matchAll(TYPE)];
  return {
    imports: [...new Map(imports.map((i) => [i.spec, i])).values()],
    exports: unique(types.filter((m) => /\bpublic\b/.test(m[1])).map((m) => m[2])),
    symbols: unique(types.map((m) => m[2])),
    pkg: text.match(NAMESPACE)?.[1] || '',
  };
}

module.exports = { parse };
