'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The set of files shown as nodes, and the mapping from any hook path to a node.
class RepoIndex {
  constructor(root) {
    this.root = root;
    this.files = new Map();
    this.dirs = new Map([['.', 1]]);
    this.lower = new Map();
  }

  add(rel, meta) {
    const isNew = !this.files.has(rel);
    this.files.set(rel, meta);
    if (!isNew) return false;
    this.lower.set(rel.toLowerCase(), rel);
    for (let d = path.posix.dirname(rel); d !== '.'; d = path.posix.dirname(d)) {
      const n = this.dirs.get(d) || 0;
      this.dirs.set(d, n + 1);
      if (!n) this.lower.set(d.toLowerCase(), d);
    }
    return true;
  }

  remove(rel) {
    if (!this.files.delete(rel)) return false;
    this.lower.delete(rel.toLowerCase());
    for (let d = path.posix.dirname(rel); d !== '.'; d = path.posix.dirname(d)) {
      const n = this.dirs.get(d) - 1;
      if (n) this.dirs.set(d, n);
      else { this.dirs.delete(d); this.lower.delete(d.toLowerCase()); }
    }
    return true;
  }

  relative(abs) {
    if (abs === this.root) return '.';
    if (!abs.startsWith(this.root + path.sep)) return null;
    return abs.slice(this.root.length + 1).split(path.sep).join('/');
  }

  // Returns {rel, kind} where rel is null outside the repo and kind is
  // 'file', 'dir', or null for a path in the repo that has no node.
  resolve(p, cwd) {
    const abs = path.resolve(cwd || this.root, p);
    const rel = this.relative(abs) ?? this.relative(realpathOfDeepestExisting(abs));
    if (rel === null) return { rel: null, kind: null };
    const known = this.kindOf(rel);
    if (known) return { rel, kind: known };
    const canonical = this.lower.get(rel.toLowerCase());
    return canonical ? { rel: canonical, kind: this.kindOf(canonical) } : { rel, kind: null };
  }

  kindOf(rel) {
    if (this.files.has(rel)) return 'file';
    return this.dirs.has(rel) ? 'dir' : null;
  }
}

// Handles symlinked prefixes such as macOS /tmp -> /private/tmp, including for
// files that do not exist yet.
function realpathOfDeepestExisting(abs) {
  let dir = abs;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

module.exports = { RepoIndex, realpathOfDeepestExisting };
