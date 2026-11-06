'use strict';
// File contents and the uncommitted diff against git HEAD for the detail panel.
// Everything runs locally: the file is read from disk and git is run with
// execFile (no shell), with external diff drivers and fsmonitor disabled.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_SIZE = 512 * 1024;
const BINARY_SNIFF = 8192;
const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;

function git(root, args, { timeout = GIT_TIMEOUT_MS, maxBuffer = GIT_MAX_BUFFER } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '--literal-pathspecs', ...args], {
      cwd: root, timeout, maxBuffer, windowsHide: true,
    }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// Parses `git diff` output into hunks of {op, text} lines.
function parseUnifiedDiff(text) {
  const hunks = [];
  let hunk = null;
  for (const line of text.split('\n')) {
    const head = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (head) {
      hunk = { oldStart: Number(head[1]), newStart: Number(head[2]), lines: [] };
      hunks.push(hunk);
    } else if (hunk && (line[0] === ' ' || line[0] === '+' || line[0] === '-')) {
      hunk.lines.push({ op: line[0], text: line.slice(1) });
    }
  }
  return hunks;
}

// Returns null outside a git repo or before the first commit.
async function diffAgainstHead(root, rel) {
  if ((await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])) === null) return null;
  if ((await git(root, ['ls-files', '--error-unmatch', '--', rel])) === null) return { untracked: true, hunks: [] };
  const out = await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--', rel]);
  return out === null ? null : { untracked: false, hunks: parseUnifiedDiff(out) };
}

// The index proves the path was a regular file when scanned; it may have been
// swapped for a symlink since, so the real path must still be inside the repo.
async function readSource(root, rel) {
  const [realRoot, abs] = await Promise.all([fs.realpath(root), fs.realpath(path.join(root, rel))]);
  if (!abs.startsWith(realRoot + path.sep)) throw new Error('outside the repo');
  const handle = await fs.open(abs, 'r');
  let buf;
  let size;
  try {
    size = (await handle.stat()).size;
    buf = Buffer.alloc(Math.min(size, MAX_SIZE));
    await handle.read(buf, 0, buf.length, 0);
  } finally {
    await handle.close();
  }
  if (buf.subarray(0, BINARY_SNIFF).includes(0)) return { text: null, binary: true, truncated: false, diff: null };
  return {
    text: buf.toString('utf8'),
    binary: false,
    truncated: size > MAX_SIZE,
    diff: await diffAgainstHead(root, rel),
  };
}

module.exports = { readSource, parseUnifiedDiff, git, MAX_SIZE };
