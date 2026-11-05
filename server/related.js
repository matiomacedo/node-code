'use strict';
const path = require('node:path');

const TEST_NAME = /(?:\.(?:test|spec)\.[^.]+$|^test_.*\.py$|_test\.py$)/;
const TEST_DIR = /(?:^|\/)(?:__tests__)\//;

const isTestFile = (rel) => TEST_NAME.test(path.posix.basename(rel)) || TEST_DIR.test(rel);

// Stem shared between a source file and its tests: login.test.ts -> login.
function testStem(rel) {
  const name = path.posix.basename(rel);
  return name
    .replace(/\.(?:test|spec)(?=\.[^.]+$)/, '')
    .replace(/^test_(?=.*\.py$)/, '')
    .replace(/_test(?=\.py$)/, '')
    .replace(/\.[^.]+$/, '');
}

function relatedTests(rel, files) {
  if (isTestFile(rel)) return [];
  const stem = testStem(rel);
  const out = [];
  for (const f of files) {
    if (f !== rel && isTestFile(f) && testStem(f) === stem) out.push(f);
  }
  return out;
}

module.exports = { relatedTests };
