// Which folders and files are on screen. Pure logic, no DOM.
const posixDir = (p) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
};
const baseName = (p) => (p === '.' ? '' : p.slice(p.lastIndexOf('/') + 1));

export class Tree {
  constructor({ budget = 2000, initialBudget = 1500, page = 200 } = {}) {
    this.budget = budget;
    this.initialBudget = initialBudget;
    this.page = page;
    this.reset();
    this.expanded = new Set(['.']);
    this.seen = new Set();
    this.lastUsed = new Map();
    this.clock = 0;
    this.pages = new Map();
    this.revealed = new Set();
  }

  reset() {
    this.files = new Map();
    this.folders = new Map([['.', this.newFolder('.', null)]]);
    this.heat = new Map();
    this.rolled = new Map();
  }

  newFolder(path, parent) {
    return { path, parent, name: baseName(path), subfolders: new Set(), files: new Set(), count: 0 };
  }

  setFiles(list) {
    const hadFolders = this.seen.size > 0;
    const previousHeat = this.heat;
    this.reset();
    for (const [p, size] of list) this.insert(p, size);
    for (const [p, h] of previousHeat) if (this.files.has(p)) this.setHeat(p, h);
    if (!hadFolders) this.applyDefaultExpansion();
    else for (const p of this.folders.keys()) if (!this.seen.has(p)) this.expanded.add(p);
    for (const p of this.folders.keys()) this.seen.add(p);
    this.enforceBudget(new Set());
  }

  insert(path, size) {
    if (this.files.has(path)) { this.files.get(path).size = size; return; }
    const dir = this.ensureFolder(posixDir(path));
    dir.files.add(path);
    this.files.set(path, { path, size, parent: dir.path });
    for (let f = dir; f; f = this.folders.get(f.parent)) f.count++;
  }

  ensureFolder(path) {
    let f = this.folders.get(path);
    if (f) return f;
    const parent = this.ensureFolder(posixDir(path));
    f = this.newFolder(path, parent.path);
    this.folders.set(path, f);
    parent.subfolders.add(path);
    return f;
  }

  addFile(path, size) {
    const before = new Set(this.folders.keys());
    this.insert(path, size);
    for (const p of this.folders.keys()) {
      if (!before.has(p)) { this.expanded.add(p); this.seen.add(p); }
    }
    this.revealed.add(path);
    this.enforceBudget(this.ancestors(path));
  }

  removeFile(path) {
    const file = this.files.get(path);
    if (!file) return;
    this.setHeat(path, 0);
    this.files.delete(path);
    this.revealed.delete(path);
    let f = this.folders.get(file.parent);
    f.files.delete(path);
    for (let a = f; a; a = this.folders.get(a.parent)) a.count--;
    while (f.parent && f.count === 0) {
      const parent = this.folders.get(f.parent);
      parent.subfolders.delete(f.path);
      this.folders.delete(f.path);
      this.expanded.delete(f.path);
      this.seen.delete(f.path);
      f = parent;
    }
  }

  // Breadth first, so shallow structure stays and deep folders start collapsed.
  applyDefaultExpansion() {
    this.expanded = new Set(['.']);
    let used = 1;
    const queue = ['.'];
    while (queue.length) {
      const f = this.folders.get(queue.shift());
      const cost = this.shownCost(f);
      if (f.path !== '.' && used + cost > this.initialBudget) continue;
      used += cost;
      this.expanded.add(f.path);
      queue.push(...[...f.subfolders].sort());
    }
  }

  shownCost(f) {
    const limit = this.pages.get(f.path) || this.page;
    return f.subfolders.size + Math.min(f.files.size, limit) + (f.files.size > limit ? 1 : 0);
  }

  touch(path) {
    this.lastUsed.set(path, ++this.clock);
  }

  expand(path) {
    if (!this.folders.has(path)) return;
    this.expanded.add(path);
    this.touch(path);
    this.enforceBudget(this.ancestors(path));
  }

  collapse(path) {
    if (path !== '.') this.expanded.delete(path);
  }

  toggle(path) {
    if (this.expanded.has(path)) this.collapse(path);
    else this.expand(path);
  }

  showMore(path) {
    this.pages.set(path, (this.pages.get(path) || this.page) + this.page);
    this.touch(path);
    this.enforceBudget(this.ancestors(path));
  }

  // Makes a file visible for a jump from the feed or an import link. The user
  // asked for this node, so it wins over the budget if nothing else can close.
  reveal(path) {
    if (this.folders.has(path)) {
      for (const a of this.ancestors(path)) if (a !== path) this.expand(a);
      return;
    }
    if (!this.files.has(path)) return;
    this.revealed.add(path);
    const protect = this.ancestors(path);
    for (const a of protect) { this.expanded.add(a); this.touch(a); }
    this.enforceBudget(protect);
  }

  ancestors(path) {
    const out = new Set(['.']);
    for (let p = this.files.has(path) ? posixDir(path) : path; p !== '.'; p = posixDir(p)) out.add(p);
    return out;
  }

  enforceBudget(protect) {
    let count = this.visibleCount();
    if (count <= this.budget) return;
    const closable = [...this.expanded]
      .filter((p) => !protect.has(p) && p !== '.')
      .sort((a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0));
    for (const p of closable) {
      if (count <= this.budget) break;
      this.expanded.delete(p);
      count = this.visibleCount();
    }
  }

  visibleCount() {
    let n = 1;
    const walk = (f) => {
      n += this.shownCost(f);
      for (const p of this.revealed) if (this.isBeyondPage(f, p)) n++;
      for (const s of f.subfolders) if (this.expanded.has(s)) walk(this.folders.get(s));
    };
    walk(this.folders.get('.'));
    return n;
  }

  isBeyondPage(f, file) {
    if (!f.files.has(file)) return false;
    return !this.pagedFiles(f).shown.has(file);
  }

  pagedFiles(f) {
    const limit = this.pages.get(f.path) || this.page;
    const sorted = [...f.files].sort();
    return { shown: new Set(sorted.slice(0, limit)), hidden: Math.max(0, sorted.length - limit) };
  }

  visible() {
    const nodes = [];
    const links = [];
    const push = (node, parentIndex) => {
      nodes.push(node);
      if (parentIndex >= 0) links.push([parentIndex, nodes.length - 1]);
      return nodes.length - 1;
    };
    const walk = (f, parentIndex) => {
      const isOpen = this.expanded.has(f.path);
      const me = push({ id: f.path, kind: 'folder', name: f.name, parent: f.parent, expanded: isOpen, count: f.count }, parentIndex);
      if (!isOpen) return;
      for (const s of [...f.subfolders].sort()) walk(this.folders.get(s), me);
      const { shown, hidden } = this.pagedFiles(f);
      for (const p of shown) push({ id: p, kind: 'file', name: baseName(p), parent: f.path }, me);
      let extra = 0;
      for (const p of this.revealed) {
        if (f.files.has(p) && !shown.has(p)) { push({ id: p, kind: 'file', name: baseName(p), parent: f.path }, me); extra++; }
      }
      if (hidden - extra > 0) push({ id: `${f.path}/\0more`, kind: 'more', name: `${hidden - extra} more`, parent: f.path, count: hidden - extra }, me);
    };
    walk(this.folders.get('.'), -1);
    return { nodes, links };
  }

  nearestVisible(path) {
    if (this.files.has(path)) {
      const f = this.folders.get(this.files.get(path).parent);
      if (this.isChainOpen(f.path) && (this.pagedFiles(f).shown.has(path) || this.revealed.has(path))) return path;
    } else if (this.folders.has(path) && this.isChainOpen(posixDir(path))) {
      return path;
    }
    let best = '.';
    const chain = [];
    for (let p = path; p !== '.'; p = posixDir(p)) chain.unshift(p);
    for (const p of chain) {
      if (!this.folders.has(p)) break;
      best = p;
      if (!this.expanded.has(p)) break;
    }
    return best;
  }

  isChainOpen(path) {
    for (let p = path; ; p = posixDir(p)) {
      if (!this.expanded.has(p)) return false;
      if (p === '.') return true;
    }
  }

  setHeat(path, value) {
    const old = this.heat.get(path) || 0;
    if (value) this.heat.set(path, value);
    else this.heat.delete(path);
    const delta = value - old;
    if (!delta || !this.files.has(path)) return;
    for (let p = posixDir(path); ; p = posixDir(p)) {
      this.rolled.set(p, (this.rolled.get(p) || 0) + delta);
      if (p === '.') break;
    }
  }

  clearHeat() {
    this.heat.clear();
    this.rolled.clear();
  }

  // Own heat for a file; the sum of everything inside for a collapsed folder.
  heatOf(id) {
    if (this.files.has(id)) return this.heat.get(id) || 0;
    return this.expanded.has(id) ? 0 : this.rolled.get(id) || 0;
  }
}
