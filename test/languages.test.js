'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parserFor } = require('../parsers/registry');

const parse = (file, src) => parserFor(file).parse(src);
const specs = (file, src) => parse(file, src).imports.map((i) => i.spec);

// A ctx like the indexer's, built from a file list and parse results.
function ctx(files, extra = {}) {
  const dirs = new Map();
  const names = new Map();
  for (const f of files) {
    dirs.set(path.posix.dirname(f), [...(dirs.get(path.posix.dirname(f)) || []), f]);
    names.set(path.posix.basename(f), [...(names.get(path.posix.basename(f)) || []), f]);
  }
  const pkgs = extra.pkgs || {};
  return {
    has: (f) => files.includes(f),
    project: { goModules: [], psr4: [], ...extra.project },
    filesIn: (d) => dirs.get(d) || [],
    named: (b) => names.get(b) || [],
    declared: (p) => Object.keys(pkgs).filter((f) => pkgs[f] === p),
  };
}
const resolve = (from, imp, c) => parserFor(from).resolve(imp, from, c);

test('C/C++: includes, comments, exports and resolution', () => {
  const src = `#include <stdio.h>
#include "util.h"
// #include "nope.h"
/* #include "nope2.h" */
#  include "../lib/core.h"
static int helper(int x) { return x; }
int api_call(const char *s)
{
  return 0;
}
typedef struct point { int x; } Point;
#define MAX 3
`;
  const p = parse('src/main.c', src);
  assert.deepEqual(p.imports, [{ spec: 'stdio.h', system: true }, { spec: 'util.h', system: false }, { spec: '../lib/core.h', system: false }]);
  assert.ok(p.exports.includes('api_call') && !p.exports.includes('helper'));
  assert.ok(p.symbols.includes('helper') && p.symbols.includes('Point') && p.symbols.includes('MAX'));

  const c = ctx(['src/main.c', 'src/util.h', 'lib/core.h', 'include/proj/api.hpp', 'third/a/x.h', 'third/b/x.h']);
  assert.deepEqual(resolve('src/main.c', { spec: 'util.h' }, c), ['src/util.h']);
  assert.deepEqual(resolve('src/main.c', { spec: '../lib/core.h' }, c), ['lib/core.h']);
  assert.deepEqual(resolve('src/main.c', { spec: 'proj/api.hpp', system: true }, c), ['include/proj/api.hpp']);
  assert.deepEqual(resolve('src/main.c', { spec: 'stdio.h', system: true }, c), []);
  assert.deepEqual(resolve('src/main.c', { spec: 'x.h' }, c), [], 'ambiguous suffix match stays unresolved');
  assert.deepEqual(resolve('src/main.c', { spec: 'a/x.h' }, c), ['third/a/x.h']);
});

test('Go: imports, raw strings, exports and module resolution', () => {
  const src = 'package main\n\nimport "fmt"\nimport (\n\t"example.com/app/internal/db"\n\tlog "example.com/app/pkg/log"\n\t// "example.com/app/nope"\n)\n' +
    'var s = `\nimport "fake"\n`\nfunc Run() {}\nfunc (s *Srv) Serve() {}\nfunc helper() {}\ntype (\n\tConfig struct{}\n\tinner int\n)\n';
  const p = parse('cmd/main.go', src);
  assert.deepEqual(p.imports.map((i) => i.spec), ['fmt', 'example.com/app/internal/db', 'example.com/app/pkg/log']);
  assert.deepEqual(p.exports.sort(), ['Config', 'Run', 'Serve']);
  assert.ok(p.symbols.includes('helper') && p.symbols.includes('inner'));

  const c = ctx(['go.mod', 'internal/db/db.go', 'internal/db/conn.go', 'internal/db/db_test.go', 'tools/go.mod', 'tools/gen/gen.go'],
    { project: { goModules: [{ dir: 'tools', module: 'example.com/app/tools' }, { dir: '.', module: 'example.com/app' }] } });
  assert.deepEqual(resolve('cmd/main.go', { spec: 'example.com/app/internal/db' }, c), ['internal/db/conn.go', 'internal/db/db.go']);
  assert.deepEqual(resolve('cmd/main.go', { spec: 'example.com/app/tools/gen' }, c), ['tools/gen/gen.go']);
  assert.deepEqual(resolve('cmd/main.go', { spec: 'fmt' }, c), []);
});

test('Rust: mod and use, nested groups, pub items', () => {
  const src = "mod config;\npub mod net;\n// mod nope;\nuse crate::net::{tcp::Conn, self};\nuse super::util as u;\nuse std::io;\nfn lifetime<'a>(x: &'a str) {}\npub struct Server;\nfn private() {}\npub(crate) fn shared() {}\n";
  const p = parse('src/main.rs', src);
  assert.deepEqual(specs('src/main.rs', src), ['mod config', 'mod net', 'crate::net::tcp::Conn', 'crate::net', 'super::util', 'std::io']);
  assert.deepEqual(p.exports.sort(), ['Server', 'net', 'shared']);
  assert.ok(p.symbols.includes('private') && p.symbols.includes('config'));

  const c = ctx(['src/main.rs', 'src/config.rs', 'src/net/mod.rs', 'src/net/tcp.rs', 'src/net/udp.rs', 'src/util.rs']);
  assert.deepEqual(resolve('src/main.rs', { spec: 'mod config', mod: 'config' }, c), ['src/config.rs']);
  assert.deepEqual(resolve('src/main.rs', { spec: 'mod net', mod: 'net' }, c), ['src/net/mod.rs']);
  assert.deepEqual(resolve('src/net/mod.rs', { spec: 'mod tcp', mod: 'tcp' }, c), ['src/net/tcp.rs']);
  assert.deepEqual(resolve('src/main.rs', { spec: 'crate::net::tcp::Conn' }, c), ['src/net/tcp.rs']);
  assert.deepEqual(resolve('src/net/tcp.rs', { spec: 'crate::util' }, c), ['src/util.rs']);
  assert.deepEqual(resolve('src/net/tcp.rs', { spec: 'super::udp' }, c), ['src/net/udp.rs']);
  assert.deepEqual(resolve('src/net/tcp.rs', { spec: 'super::Thing' }, c), ['src/net/mod.rs']);
  assert.deepEqual(resolve('src/net/tcp.rs', { spec: 'crate::Thing' }, c), ['src/main.rs']);
  assert.deepEqual(resolve('src/main.rs', { spec: 'std::io' }, c), []);
});

test('Java, Kotlin and Scala: package index resolution', () => {
  const java = parse('src/com/a/App.java', 'package com.a;\nimport com.b.Util;\nimport static com.b.Util.helper;\nimport com.c.*;\n// import com.x.Nope;\npublic class App {}\nclass Hidden {}\n');
  assert.equal(java.pkg, 'com.a');
  assert.deepEqual(java.imports.map((i) => i.spec), ['com.b.Util', 'com.b.Util.helper', 'com.c.*']);
  assert.deepEqual(java.exports, ['App', 'Hidden']);
  const kt = parse('a.kt', 'package com.k\nimport com.b.Util as U\nfun top() {}\nprivate fun hidden() {}\ndata class D(val x: Int)\n');
  assert.deepEqual(kt.imports.map((i) => i.spec), ['com.b.Util']);
  assert.deepEqual(kt.exports, ['top', 'D']);
  const scala = parse('a.scala', 'package com.s\nimport com.b.{Util, Other => O}\nimport com.c._\nobject Main\n');
  assert.deepEqual(scala.imports.map((i) => i.spec), ['com.b.Util', 'com.b.Other', 'com.c.*']);

  const files = ['src/com/a/App.java', 'lib/com/b/Util.java', 'lib/com/b/Other.kt', 'x/C1.java', 'x/C2.java', 'cs/Util.cs'];
  const c = ctx(files, { pkgs: { 'lib/com/b/Util.java': 'com.b', 'lib/com/b/Other.kt': 'com.b', 'x/C1.java': 'com.c', 'x/C2.java': 'com.c', 'cs/Util.cs': 'com.b' } });
  assert.deepEqual(resolve('src/com/a/App.java', { spec: 'com.b.Util' }, c), ['lib/com/b/Util.java']);
  assert.deepEqual(resolve('src/com/a/App.java', { spec: 'com.b.Util.helper' }, c), ['lib/com/b/Util.java']);
  assert.deepEqual(resolve('src/com/a/App.java', { spec: 'com.c.*' }, c), ['x/C1.java', 'x/C2.java']);
  assert.deepEqual(resolve('a.scala', { spec: 'com.b.Other' }, c), ['lib/com/b/Other.kt']);
});

test('C#: usings resolve to every file in the namespace', () => {
  const p = parse('App.cs', 'using System;\nusing Acme.Core;\nusing static Acme.Util.Strings;\nusing Alias = Acme.Util.Strings;\nusing (var x = Make()) {}\nnamespace Acme.App;\npublic sealed class App {}\ninternal class Inner {}\n');
  assert.equal(p.pkg, 'Acme.App');
  assert.deepEqual(p.imports, [{ spec: 'System', wildcard: true }, { spec: 'Acme.Core', wildcard: true }, { spec: 'Acme.Util.Strings' }]);
  assert.deepEqual(p.exports, ['App']);
  const c = ctx(['Core/A.cs', 'Core/B.cs', 'Util/Strings.cs', 'Core/A.java'],
    { pkgs: { 'Core/A.cs': 'Acme.Core', 'Core/B.cs': 'Acme.Core', 'Util/Strings.cs': 'Acme.Util', 'Core/A.java': 'Acme.Core' } });
  assert.deepEqual(resolve('App.cs', { spec: 'Acme.Core', wildcard: true }, c), ['Core/A.cs', 'Core/B.cs']);
  assert.deepEqual(resolve('App.cs', { spec: 'Acme.Util.Strings' }, c), ['Util/Strings.cs']);
  assert.deepEqual(resolve('App.cs', { spec: 'System', wildcard: true }, c), []);
});

test('Ruby: require_relative, require through lib/, interpolation is not a comment', () => {
  const p = parse('app/main.rb', "require 'json'\nrequire_relative '../lib/helper'\nrequire \"mygem/core\"\n# require 'nope'\n=begin\nrequire 'nope2'\n=end\nx = \"#{y}\"\nclass App\nend\ndef self.run; end\n");
  assert.deepEqual(p.imports.map((i) => i.spec), ['json', '../lib/helper', 'mygem/core']);
  assert.deepEqual(p.symbols, ['App', 'run']);
  const c = ctx(['lib/helper.rb', 'lib/mygem/core.rb']);
  assert.deepEqual(resolve('app/main.rb', { spec: '../lib/helper', relative: true }, c), ['lib/helper.rb']);
  assert.deepEqual(resolve('app/main.rb', { spec: 'mygem/core' }, c), ['lib/mygem/core.rb']);
  assert.deepEqual(resolve('app/main.rb', { spec: 'json' }, c), []);
});

test('PHP: includes and PSR-4 use statements', () => {
  const src = "<?php\nnamespace App;\nuse App\\Models\\User;\nuse App\\Http\\{Request, Response as R};\n# require 'nope.php';\nrequire_once __DIR__ . '/../bootstrap.php';\ninclude 'views/head.php';\n$f = function () use ($x) {};\nfinal class Controller {}\nfunction helper() {}\n";
  const p = parse('src/Ctl.php', src);
  assert.deepEqual(p.imports.map((i) => i.spec), ['/../bootstrap.php', 'views/head.php', 'App\\Models\\User', 'App\\Http\\Request', 'App\\Http\\Response']);
  assert.deepEqual(p.symbols, ['Controller', 'helper']);
  const c = ctx(['bootstrap.php', 'src/views/head.php', 'src/Models/User.php', 'src/Http/Request.php'],
    { project: { psr4: [{ prefix: 'App\\', dirs: ['src/'] }] } });
  const by = (spec) => p.imports.find((i) => i.spec === spec);
  assert.deepEqual(resolve('src/Ctl.php', by('/../bootstrap.php'), c), ['bootstrap.php']);
  assert.deepEqual(resolve('src/Ctl.php', by('views/head.php'), c), ['src/views/head.php']);
  assert.deepEqual(resolve('src/Ctl.php', by('App\\Models\\User'), c), ['src/Models/User.php']);
  assert.deepEqual(resolve('src/Ctl.php', by('App\\Http\\Request'), c), ['src/Http/Request.php']);
});

test('Shell: source and dot, script-relative variables, functions', () => {
  const p = parse('bin/run.sh', 'source "$(dirname "$0")/lib.sh"\n. ./common.sh # and a comment\necho "#not" $#\n# source nope.sh\n[ -f x ] && source "${HERE}/opt.sh"\ndeploy() {\n}\nfunction clean {\n}\n');
  assert.deepEqual(p.imports.map((i) => i.spec), ['$(dirname $0)/lib.sh', './common.sh', '${HERE}/opt.sh']);
  assert.deepEqual(p.symbols, ['deploy', 'clean']);
  const c = ctx(['bin/lib.sh', 'bin/common.sh', 'bin/opt.sh']);
  for (const imp of p.imports) assert.equal(resolve('bin/run.sh', imp, c).length, 1, imp.spec);
  assert.deepEqual(resolve('bin/run.sh', { spec: '$HOME/.rc' }, c), []);
});

test('CSS/SCSS: @import, @use, partials, url() and externals', () => {
  const p = parse('styles/main.scss', "@use 'sass:math';\n@use 'base';\n@import url(\"reset.css\"), 'theme/colors';\n/* @import 'nope'; */\n@import 'https://fonts.example/x.css';\n.a { background: url(http://x/y.png); }\n");
  assert.deepEqual(p.imports.map((i) => [i.spec, i.external]), [['sass:math', true], ['base', false], ['reset.css', false], ['theme/colors', false], ['https://fonts.example/x.css', true]]);
  const c = ctx(['styles/_base.scss', 'styles/reset.css', 'styles/theme/colors/_index.scss']);
  assert.deepEqual(p.imports.map((i) => resolve('styles/main.scss', i, c)), [[], ['styles/_base.scss'], ['styles/reset.css'], ['styles/theme/colors/_index.scss'], []]);
});

test('HTML: local scripts and stylesheets', () => {
  const p = parse('web/index.html', '<link rel="stylesheet" href="/style.css">\n<!-- <script src="old.js"></script> -->\n<script type="module" src="./app.js?v=2"></script>\n<script src="https://cdn.example/x.js"></script>\n<link rel="icon" href="data:,">\n');
  assert.deepEqual(p.imports.map((i) => i.spec), ['/style.css', './app.js']);
  const c = ctx(['web/style.css', 'web/app.js']);
  assert.deepEqual(p.imports.map((i) => resolve('web/index.html', i, c)), [['web/style.css'], ['web/app.js']]);
});

test('Vue and Svelte: imports come from the script blocks', () => {
  const src = '<template><div>import x from "./nope"</div></template>\n<script setup lang="ts">\nimport Child from "./Child.vue";\nimport { api } from "../api";\n</script>\n';
  assert.deepEqual(specs('src/App.vue', src), ['./Child.vue', '../api']);
  assert.deepEqual(specs('src/App.svelte', '<script>\n  import Btn from "./Btn.svelte";\n</script>\n<button/>'), ['./Btn.svelte']);
  const c = ctx(['src/Child.vue', 'api.ts']);
  assert.deepEqual(resolve('src/App.vue', { spec: './Child.vue' }, c), ['src/Child.vue']);
});

test('review fixes: C system includes, struct-returning functions', () => {
  const c = ctx(['src/a.c', 'third_party/lua/string.h', 'vendor/zlib/zlib.h']);
  assert.deepEqual(resolve('src/a.c', { spec: 'string.h', system: true }, c), []);
  assert.deepEqual(resolve('src/a.c', { spec: 'zlib.h', system: false }, c), ['vendor/zlib/zlib.h']);
  const p = parse('a.c', 'struct node *make_node(int v) {\n  return 0;\n}\nstruct list {\n  int n;\n};\n');
  assert.deepEqual(p.exports.sort(), ['list', 'make_node']);
});

test('review fixes: Rust crate roots in tests/, src/bin/ and examples/', () => {
  const c = ctx(['tests/it.rs', 'tests/common/mod.rs', 'src/bin/tool.rs', 'src/bin/util.rs', 'examples/demo.rs', 'examples/shared.rs', 'src/lib.rs']);
  assert.deepEqual(resolve('tests/it.rs', { spec: 'mod common', mod: 'common' }, c), ['tests/common/mod.rs']);
  assert.deepEqual(resolve('src/bin/tool.rs', { spec: 'mod util', mod: 'util' }, c), ['src/bin/util.rs']);
  assert.deepEqual(resolve('examples/demo.rs', { spec: 'mod shared', mod: 'shared' }, c), ['examples/shared.rs']);
  assert.deepEqual(resolve('tests/it.rs', { spec: 'crate::common::helper' }, c), ['tests/common/mod.rs']);
});

test('review fixes: SCSS with() config is not an import, .sass is not parsed', () => {
  const p = parse('a.scss', '@use "config" with ($primary: "blue", $x: "y");\n@forward "lib" show mixin;\n');
  assert.deepEqual(p.imports.map((i) => i.spec), ['config', 'lib']);
  assert.equal(parserFor('a.sass'), null);
});

test('review fixes: Go group names skip struct fields and continuation lines', () => {
  const p = parse('a.go', 'package a\ntype (\n\tFoo struct {\n\t\tBar int\n\t\tbaz string\n\t}\n\tID int\n)\nvar (\n\tx = f(\n\t\tNotAName,\n\t)\n\tY = 2\n)\n');
  assert.deepEqual(p.symbols.sort(), ['Foo', 'ID', 'Y', 'x']);
});

test('indexer worker re-reads go.mod when it changes and sees new files', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { Worker } = require('node:worker_threads');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-worker-')));
  fs.mkdirSync(path.join(root, 'db'));
  fs.writeFileSync(path.join(root, 'go.mod'), 'module old.example/app\n');
  fs.writeFileSync(path.join(root, 'main.go'), 'package main\nimport "new.example/app/db"\n');
  fs.writeFileSync(path.join(root, 'db/db.go'), 'package db\n');
  const w = new Worker(path.join(__dirname, '../server/indexer.worker.js'), { workerData: { root } });
  t.after(() => w.terminate());
  const send = (msg) => new Promise((r) => { w.once('message', r); w.postMessage(msg); });
  const targets = (rec) => rec['main.go'].imports[0].targets;

  assert.deepEqual(targets(await send({ added: ['go.mod', 'main.go', 'db/db.go'] })), []);
  fs.writeFileSync(path.join(root, 'go.mod'), 'module new.example/app\n');
  assert.deepEqual(targets(await send({ changed: ['go.mod'] })), ['db/db.go']);
  fs.writeFileSync(path.join(root, 'db/conn.go'), 'package db\n');
  assert.deepEqual(targets(await send({ added: ['db/conn.go'] })), ['db/conn.go', 'db/db.go']);
});
