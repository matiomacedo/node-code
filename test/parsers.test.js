'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parserFor, languageOf } = require('../parsers/registry');
const js = require('../parsers/javascript');
const py = require('../parsers/python');
const { resolveJs, loadTsconfigPaths } = require('../resolvers/javascript');
const { resolvePython } = require('../resolvers/python');
const { relatedTests } = require('../server/related');

const specs = (src) => js.parse(src).imports.map((i) => i.spec);
const ctx = (files, extra = {}) => ({ has: (f) => files.includes(f), ...extra });

test('registry finds parsers by extension and languages for display', () => {
  assert.equal(parserFor('a/b.tsx').language, 'TypeScript');
  assert.equal(parserFor('a/b.py').language, 'Python');
  assert.equal(parserFor('a/b.rs').language, 'Rust');
  assert.equal(parserFor('a/b.swift'), null);
  assert.equal(languageOf('a/b.swift'), 'Swift');
  assert.equal(languageOf('a/b.zzz'), 'Unknown');
});

test('JS: finds ESM, re-export, side-effect, require and dynamic imports', () => {
  const src = `
    import a from './a';
    import { b, c as d } from "./b";
    import {
      e,
    } from './e';
    import './side';
    export * from './re';
    export { x } from './re2';
    const r = require('./r');
    const l = await import('./lazy');
    import type { T } from './types';
  `;
  assert.deepEqual(specs(src).sort(), ['./a', './b', './e', './lazy', './r', './re', './re2', './side', './types']);
});

test('JS: ignores imports in comments and template text', () => {
  const src = "// import a from './a'\n/* import b from './b' */\nconst s = `\nimport c from './c'\n`;\nimport d from './d';";
  assert.deepEqual(specs(src), ['./d']);
});

test('JS: a URL string does not start a comment', () => {
  assert.deepEqual(specs("const u = 'http://x.y';\nimport a from './a';"), ['./a']);
});

test('JS: lists exports and top-level symbols', () => {
  const src = `
    export function f() {}
    export default class K {}
    export const v = 1, w = 2;
    export type T = string;
    const a = 1, b = 2;
    export { a, b as bee };
    function hidden() { function inner() {} }
  `.replace(/^ {4}/gm, '');
  const { exports: ex, symbols } = js.parse(src);
  assert.deepEqual(ex.sort(), ['K', 'T', 'a', 'bee', 'f', 'v'].sort());
  assert.ok(symbols.includes('hidden'));
  assert.ok(!symbols.includes('inner'));
});

test('JS: finds CommonJS exports', () => {
  assert.deepEqual(js.parse('exports.a = 1;\nmodule.exports.b = 2;').exports, ['a', 'b']);
  assert.deepEqual(js.parse('module.exports = { c, d: 1 };').exports, ['c', 'd']);
});

test('Python: finds imports including multi-line and relative forms', () => {
  const src = `
import os, sys as system
import a.b.c
from . import sibling, other as o
from ..pkg.mod import (
    one,
    two as deux,  # comment
)
from x import *
"""
import fake
"""
# import nope
  `;
  const got = py.parse(src).imports;
  assert.deepEqual(got.map((i) => i.spec), ['os', 'sys', 'a.b.c', '.', '..pkg.mod', 'x']);
  assert.deepEqual(got.find((i) => i.spec === '.').names, ['sibling', 'other']);
  assert.deepEqual(got.find((i) => i.spec === '..pkg.mod').names, ['one', 'two']);
});

test('Python: repeated imports of one module merge into one record', () => {
  const { imports } = py.parse('from .errs import A\nfrom .errs import B\nimport os\nimport os\n');
  assert.deepEqual(imports, [{ spec: '.errs', names: ['A', 'B'] }, { spec: 'os' }]);
});

test('Python: top-level symbols, and exports honour __all__', () => {
  const plain = py.parse('def f():\n    def g(): pass\nasync def h(): pass\nclass K: pass\n_private = 1\nVALUE = 2\ndef _p(): pass\n');
  assert.deepEqual(plain.symbols, ['f', 'h', 'K', '_private', 'VALUE', '_p']);
  assert.deepEqual(plain.exports, ['f', 'h', 'K', 'VALUE']);
  assert.deepEqual(py.parse('__all__ = ["a", "b"]\ndef a(): pass\ndef c(): pass\n').exports, ['a', 'b']);
});

test('JS resolver: extensions, index files and .js to .ts', () => {
  const c = ctx(['src/a.ts', 'src/lib/index.tsx', 'src/m.ts', 'src/plain.js', 'src/style.css']);
  assert.deepEqual(resolveJs({ spec: './a' }, 'src/x.ts', c), ['src/a.ts']);
  assert.deepEqual(resolveJs({ spec: './lib' }, 'src/x.ts', c), ['src/lib/index.tsx']);
  assert.deepEqual(resolveJs({ spec: './m.js' }, 'src/x.ts', c), ['src/m.ts']);
  assert.deepEqual(resolveJs({ spec: './plain.js' }, 'src/x.ts', c), ['src/plain.js']);
  assert.deepEqual(resolveJs({ spec: './style.css' }, 'src/x.ts', c), ['src/style.css']);
  assert.deepEqual(resolveJs({ spec: '../src/a' }, 'src/d/../x.ts', c), ['src/a.ts']);
});

test('JS resolver: directory imports that reach the repo root or end in a slash', () => {
  const root = ctx(['index.js', 'test/a.test.js', 'a.js']);
  assert.deepEqual(resolveJs({ spec: '..' }, 'test/a.test.js', root), ['index.js']);
  assert.deepEqual(resolveJs({ spec: '.' }, 'a.js', root), ['index.js']);
  assert.deepEqual(resolveJs({ spec: '../' }, 'src/a/b.js', ctx(['src/index.js', 'src/a/b.js'])), ['src/index.js']);
  assert.deepEqual(resolveJs({ spec: './' }, 'src/b.js', ctx(['src/index.ts'])), ['src/index.ts']);
});

test('JS resolver: packages stay unresolved, escapes outside the repo too', () => {
  const c = ctx(['react.ts']);
  assert.deepEqual(resolveJs({ spec: 'react' }, 'a.ts', c), []);
  assert.deepEqual(resolveJs({ spec: '../../etc' }, 'a.ts', c), []);
});

test('JS resolver: tsconfig paths and baseUrl', () => {
  const tsconfig = loadTsconfigPaths(`{
    // comment
    "compilerOptions": { "baseUrl": "./src", "paths": { "@/*": ["*"], "~lib": ["lib/main"], }, },
  }`);
  const c = ctx(['src/ui/b.ts', 'src/lib/main.ts', 'src/direct.ts'], { tsconfig });
  assert.deepEqual(resolveJs({ spec: '@/ui/b' }, 'x.ts', c), ['src/ui/b.ts']);
  assert.deepEqual(resolveJs({ spec: '~lib' }, 'x.ts', c), ['src/lib/main.ts']);
  assert.deepEqual(resolveJs({ spec: 'direct' }, 'x.ts', c), ['src/direct.ts']);
});

test('Python resolver: absolute, package init, src layout and sibling scripts', () => {
  const c = ctx(['a/b.py', 'pkg/__init__.py', 'src/lib/core.py', 'tools/run.py', 'tools/helper.py']);
  assert.deepEqual(resolvePython({ spec: 'a.b' }, 'x.py', c), ['a/b.py']);
  assert.deepEqual(resolvePython({ spec: 'pkg' }, 'x.py', c), ['pkg/__init__.py']);
  assert.deepEqual(resolvePython({ spec: 'lib.core' }, 'x.py', c), ['src/lib/core.py']);
  assert.deepEqual(resolvePython({ spec: 'helper' }, 'tools/run.py', c), ['tools/helper.py']);
  assert.deepEqual(resolvePython({ spec: 'os' }, 'x.py', c), []);
});

test('Python resolver: relative imports and submodule names', () => {
  const c = ctx(['p/q/m.py', 'p/q/sib.py', 'p/other.py', 'p/__init__.py', 'p/sub/__init__.py', 'p/sub/leaf.py']);
  assert.deepEqual(resolvePython({ spec: '.', names: ['sib'] }, 'p/q/m.py', c), ['p/q/sib.py']);
  assert.deepEqual(resolvePython({ spec: '..other', names: ['x'] }, 'p/q/m.py', c), ['p/other.py']);
  assert.deepEqual(resolvePython({ spec: 'p.sub', names: ['leaf'] }, 'x.py', c).sort(), ['p/sub/__init__.py', 'p/sub/leaf.py']);
});

test('relatedTests finds tests by naming convention', () => {
  const files = ['src/auth/login.ts', 'src/auth/login.test.ts', 'src/auth/__tests__/login.tsx', 'test/login.spec.ts',
    'other/login2.test.ts', 'app/core.py', 'tests/test_core.py', 'app/core_test.py'];
  assert.deepEqual(relatedTests('src/auth/login.ts', files).sort(),
    ['src/auth/__tests__/login.tsx', 'src/auth/login.test.ts', 'test/login.spec.ts']);
  assert.deepEqual(relatedTests('app/core.py', files).sort(), ['app/core_test.py', 'tests/test_core.py']);
  assert.deepEqual(relatedTests('src/auth/login.test.ts', files), []);
});
