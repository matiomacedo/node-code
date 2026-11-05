'use strict';
const path = require('node:path');
const javascript = require('./javascript');
const python = require('./python');
const { resolveJs } = require('../resolvers/javascript');
const { resolvePython } = require('../resolvers/python');

// To add a language, register {language, parse, resolve} for its extensions.
// parse(source)                  -> {imports: [{spec, names?}], exports: [], symbols: []}
// resolve(imp, fromFile, ctx)    -> array of repo-relative files
//   ctx = {has(rel) -> boolean, tsconfig}
const parsers = new Map();

function register(extensions, parser) {
  for (const ext of extensions) parsers.set(ext, parser);
}

const js = (language) => ({ language, parse: javascript.parse, resolve: resolveJs });
register(['.js', '.jsx', '.mjs', '.cjs'], js('JavaScript'));
register(['.ts', '.tsx', '.mts', '.cts'], js('TypeScript'));
register(['.py', '.pyi'], { language: 'Python', parse: python.parse, resolve: resolvePython });

const LANGUAGES = {
  '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.rb': 'Ruby', '.php': 'PHP',
  '.c': 'C', '.h': 'C/C++ header', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++', '.cs': 'C#', '.scala': 'Scala',
  '.sh': 'Shell', '.zsh': 'Shell', '.bash': 'Shell', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML', '.md': 'Markdown', '.mdx': 'MDX',
  '.sql': 'SQL', '.vue': 'Vue', '.svelte': 'Svelte', '.ipynb': 'Jupyter Notebook', '.xml': 'XML', '.txt': 'Text',
};

const extOf = (rel) => path.posix.extname(rel).toLowerCase();
const parserFor = (rel) => parsers.get(extOf(rel)) || null;
const languageOf = (rel) => parserFor(rel)?.language || LANGUAGES[extOf(rel)] || 'Unknown';

module.exports = { register, parserFor, languageOf };
