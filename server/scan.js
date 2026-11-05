'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', 'coverage', '.nyc_output',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.gradle', '.idea', '.terraform',
]);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const BINARY_EXT = new Set(('png jpg jpeg gif webp bmp ico icns tiff avif heic psd ' +
  'mp3 mp4 m4a wav ogg flac mov avi mkv webm ' +
  'zip gz tgz bz2 xz 7z rar tar jar war ear ' +
  'pdf doc docx xls xlsx ppt pptx ' +
  'exe dll so dylib a o obj class pyc pyo wasm bin dat db sqlite sqlite3 ' +
  'woff woff2 ttf otf eot').split(' '));
const SNIFF_BYTES = 512;
const STAT_CONCURRENCY = 64;
const MAX_FILES = 100000;
const MAX_BUFFER = 256 * 1024 * 1024;

function isSkippedPath(rel) {
  const parts = rel.split('/');
  if (SKIP_FILES.has(parts.at(-1))) return true;
  if (parts.slice(0, -1).some((d) => SKIP_DIRS.has(d))) return true;
  return BINARY_EXT.has(path.posix.extname(rel).slice(1).toLowerCase());
}

// true or false, or null when the file could not be read this time.
async function hasNulByte(abs) {
  let fh;
  try {
    fh = await fs.promises.open(abs, 'r');
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(SNIFF_BYTES), 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

function git(root, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, maxBuffer: MAX_BUFFER }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const splitNul = (s) => s.split('\0').filter(Boolean);

async function gitFiles(root) {
  const listed = splitNul(await git(root, ['ls-files', '-co', '--exclude-standard', '-z']));
  const deleted = new Set(splitNul(await git(root, ['ls-files', '-d', '-z'])));
  return [...new Set(listed)].filter((f) => !deleted.has(f));
}

// One gitignore pattern as a regex over paths relative to its file's folder.
function compilePattern(line) {
  let p = line;
  const negate = p.startsWith('!');
  if (negate) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return { negate, dirOnly, regex: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`) };
}

function readGitignore(dir, base) {
  let text;
  try { text = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'); } catch { return null; }
  const rules = text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(compilePattern);
  return rules.length ? { base, rules } : null;
}

// Later rules win; rules in deeper files come later, as in git.
function isIgnored(rel, isDir, scopes) {
  let ignored = false;
  for (const { base, rules } of scopes) {
    const sub = base ? rel.slice(base.length + 1) : rel;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.regex.test(sub)) ignored = !r.negate;
    }
  }
  return ignored;
}

// Async, so a large non-git folder cannot block the server's event loop.
async function walkFiles(root, maxFiles) {
  const out = [];
  const visit = async (dir, rel, scopes) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable folder: skip it, keep the rest of the tree.
    }
    const own = readGitignore(dir, rel);
    const active = own ? [...scopes, own] : scopes;
    for (const e of entries) {
      if (out.length > maxFiles) return; // One past the cap, so the caller can tell it was cut short.
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || e.name === '.git') continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !isIgnored(child, true, active)) await visit(path.join(dir, e.name), child, active);
      } else if (e.isFile() && !isIgnored(child, false, active)) {
        out.push(child);
      }
    }
  };
  await visit(root, '', []);
  return out;
}

async function listFiles(root, maxFiles) {
  try {
    return await gitFiles(root);
  } catch {
    return walkFiles(root, maxFiles); // Not a repo, or git refused it (for example safe.directory).
  }
}

async function statFile(root, rel, sniffed) {
  const abs = path.join(root, rel);
  let st;
  try { st = await fs.promises.lstat(abs); } catch { return null; }
  if (!st.isFile()) return null; // Symlinks and submodule directories have no content node.
  const meta = { size: st.size, mtimeMs: st.mtimeMs };
  const cached = sniffed?.get(rel);
  let binary;
  if (cached && cached.size === meta.size && cached.mtimeMs === meta.mtimeMs) binary = cached.binary;
  else {
    binary = await hasNulByte(abs);
    if (binary === null) return null; // Unreadable now; not remembered, so a later scan retries.
    sniffed?.set(rel, { ...meta, binary });
  }
  return binary ? null : meta;
}

// `sniffed` caches the binary check across rescans, keyed by path and
// invalidated when the file's size or mtime changes.
async function scanRepo(root, { sniffed = new Map(), maxFiles = MAX_FILES } = {}) {
  const listed = (await listFiles(root, maxFiles)).filter((f) => !isSkippedPath(f));
  const truncated = listed.length > maxFiles;
  const rels = truncated ? listed.slice(0, maxFiles) : listed;
  const files = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: STAT_CONCURRENCY }, async () => {
    while (next < rels.length) {
      const rel = rels[next++];
      const meta = await statFile(root, rel, sniffed);
      if (meta) files.set(rel, meta);
    }
  }));
  return { files, truncated };
}

function findRoot(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    return fs.realpathSync(out.toString().trim());
  } catch {
    return fs.realpathSync(cwd);
  }
}

function diffScans(prev, next) {
  const added = [];
  const modified = [];
  for (const [rel, meta] of next) {
    const old = prev.get(rel);
    if (!old) added.push(rel);
    else if (old.mtimeMs !== meta.mtimeMs || old.size !== meta.size) modified.push(rel);
  }
  const removed = [...prev.keys()].filter((rel) => !next.has(rel));
  return { added, removed, modified };
}

// Whether a file Claude just wrote should become a node.
async function acceptsFile(root, rel) {
  if (isSkippedPath(rel)) return false;
  try {
    await git(root, ['check-ignore', '-q', '--', rel]);
    return false; // Exit 0 means ignored.
  } catch (err) {
    if (err.code !== 1) { // Not a git repo: fall back to the walker's rules.
      const scopes = [];
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        const base = parts.slice(0, i).join('/');
        // A folder is judged by its parents' rules only, as walkFiles does;
        // its own .gitignore applies to what is inside it.
        if (i > 0 && isIgnored(base, true, scopes)) return false;
        const s = readGitignore(path.join(root, base), base);
        if (s) scopes.push(s);
      }
      if (isIgnored(rel, false, scopes)) return false;
    }
  }
  return (await statFile(root, rel)) !== null;
}

module.exports = { scanRepo, findRoot, diffScans, acceptsFile, statFile };
