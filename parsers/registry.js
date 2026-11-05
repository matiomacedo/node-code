'use strict';
const path = require('node:path');
const javascript = require('./javascript');
const python = require('./python');
const c = require('./c');
const go = require('./go');
const rust = require('./rust');
const jvm = require('./jvm');
const csharp = require('./csharp');
const ruby = require('./ruby');
const php = require('./php');
const shell = require('./shell');
const css = require('./css');
const html = require('./html');
const sfc = require('./sfc');
const { resolveJs } = require('../resolvers/javascript');
const { resolvePython } = require('../resolvers/python');
const { resolveC } = require('../resolvers/c');
const { resolveGo } = require('../resolvers/go');
const { resolveRust } = require('../resolvers/rust');
const { byPackage } = require('../resolvers/declared');
const { resolveRuby } = require('../resolvers/ruby');
const { resolvePhp } = require('../resolvers/php');
const { resolveShell } = require('../resolvers/shell');
const { resolveCss } = require('../resolvers/css');
const { resolveHtml } = require('../resolvers/html');

// To add a language, register {language, parse, resolve} for its extensions.
// parse(source)                  -> {imports: [{spec, ...}], exports: [], symbols: [], pkg?}
//   Each import is passed back to resolve as is; only spec is shown in the page.
//   pkg is the file's declared package or namespace, for ctx.declared.
// resolve(imp, fromFile, ctx)    -> array of repo-relative files
//   ctx = {has(rel), tsconfig, project: {goModules, psr4}, filesIn(dir),
//          named(basename), declared(pkg)}
const parsers = new Map();

function register(extensions, parser) {
  for (const ext of extensions) parsers.set(ext, parser);
}

const js = (language) => ({ language, parse: javascript.parse, resolve: resolveJs });
register(['.js', '.jsx', '.mjs', '.cjs'], js('JavaScript'));
register(['.ts', '.tsx', '.mts', '.cts'], js('TypeScript'));
register(['.py', '.pyi'], { language: 'Python', parse: python.parse, resolve: resolvePython });
register(['.c'], { language: 'C', parse: c.parse, resolve: resolveC });
register(['.h'], { language: 'C/C++ header', parse: c.parse, resolve: resolveC });
register(['.cc', '.cpp', '.cxx', '.c++'], { language: 'C++', parse: c.parse, resolve: resolveC });
register(['.hh', '.hpp', '.hxx', '.h++'], { language: 'C++ header', parse: c.parse, resolve: resolveC });
register(['.go'], { language: 'Go', parse: go.parse, resolve: resolveGo });
register(['.rs'], { language: 'Rust', parse: rust.parse, resolve: resolveRust });
const jvmResolve = byPackage(['.java', '.kt', '.kts', '.scala']);
register(['.java'], { language: 'Java', parse: jvm.parse, resolve: jvmResolve });
register(['.kt', '.kts'], { language: 'Kotlin', parse: jvm.parse, resolve: jvmResolve });
register(['.scala'], { language: 'Scala', parse: jvm.parse, resolve: jvmResolve });
register(['.cs'], { language: 'C#', parse: csharp.parse, resolve: byPackage(['.cs']) });
register(['.rb'], { language: 'Ruby', parse: ruby.parse, resolve: resolveRuby });
register(['.php'], { language: 'PHP', parse: php.parse, resolve: resolvePhp });
register(['.sh', '.bash', '.zsh'], { language: 'Shell', parse: shell.parse, resolve: resolveShell });
register(['.css'], { language: 'CSS', parse: css.parse, resolve: resolveCss });
register(['.scss'], { language: 'SCSS', parse: css.parse, resolve: resolveCss });
register(['.less'], { language: 'Less', parse: css.parse, resolve: resolveCss });
register(['.html', '.htm'], { language: 'HTML', parse: html.parse, resolve: resolveHtml });
register(['.vue'], { language: 'Vue', parse: sfc.parse, resolve: resolveJs });
register(['.svelte'], { language: 'Svelte', parse: sfc.parse, resolve: resolveJs });

// Display names for files without a parser.
const LANGUAGES = {
  '.swift': 'Swift', '.sass': 'Sass', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML', '.md': 'Markdown',
  '.mdx': 'MDX', '.sql': 'SQL', '.ipynb': 'Jupyter Notebook', '.xml': 'XML', '.txt': 'Text',
};

const extOf = (rel) => path.posix.extname(rel).toLowerCase();
const parserFor = (rel) => parsers.get(extOf(rel)) || null;
const languageOf = (rel) => parserFor(rel)?.language || LANGUAGES[extOf(rel)] || 'Unknown';

module.exports = { register, parserFor, languageOf };
