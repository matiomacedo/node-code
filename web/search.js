// Fuzzy file search and the filter rules. The scoring and filters are pure;
// SearchBox is the overlay and only touches the DOM when constructed.

const SEPARATORS = '/._- ';

// Greedy subsequence match in one direction, returning matched positions.
function positionsOf(q, t, fromEnd) {
  const out = new Array(q.length);
  if (fromEnd) {
    let at = t.length;
    for (let i = q.length - 1; i >= 0; i--) {
      at = t.lastIndexOf(q[i], at - 1);
      if (at < 0) return null;
      out[i] = at;
    }
  } else {
    let at = -1;
    for (let i = 0; i < q.length; i++) {
      at = t.indexOf(q[i], at + 1);
      if (at < 0) return null;
      out[i] = at;
    }
  }
  return out;
}

function scorePositions(pos, text, lower, q) {
  const base = text.lastIndexOf('/') + 1;
  let score = 0;
  for (let i = 0; i < pos.length; i++) {
    const p = pos[i];
    score += 1;
    if (i > 0 && p === pos[i - 1] + 1) score += 5;
    else if (i > 0) score -= Math.min(3, 0.1 * (p - pos[i - 1] - 1));
    const prev = text[p - 1];
    if (p === 0 || SEPARATORS.includes(prev) || (prev === prev.toLowerCase() && text[p] !== lower[p])) score += 4;
    if (p >= base) score += 2;
  }
  const name = lower.slice(base);
  if (name === q) score += 20;
  else if (name.startsWith(q)) score += 10;
  return score - 0.02 * text.length;
}

// Scores text against a query when every query character appears in order,
// case-insensitive; null otherwise. Higher is better. Matches in the file
// name, at word starts and in runs score more.
export function fuzzyMatch(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return null;
  const lower = text.toLowerCase();
  let best = null;
  for (const fromEnd of [false, true]) {
    const pos = positionsOf(q, lower, fromEnd);
    if (!pos) return null;
    const score = scorePositions(pos, text, lower, q);
    if (!best || score > best.score) best = { score, positions: pos };
  }
  return best;
}

// The best `limit` paths for a query, best first; ties go to the shorter path.
export function rankPaths(query, paths, limit = 20) {
  const hits = [];
  for (const path of paths) {
    const m = fuzzyMatch(query, path);
    if (m) hits.push({ path, score: m.score, positions: m.positions });
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return hits.slice(0, limit);
}

// Lower-case extension without the dot; '' for none or a dotfile like .env.
export function extOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function topExtensions(paths, n = 8) {
  const counts = new Map();
  for (const p of paths) {
    const e = extOf(p);
    if (e) counts.set(e, (counts.get(e) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([e]) => e);
}

// A predicate over file paths for the filter bar, or null when nothing filters.
// stats maps path -> {reads, edits, fails}; scoped keeps only paths in stats.
export function fileFilter({ exts = new Set(), status = 'all', stats = new Map(), scoped = false }) {
  if (!exts.size && status === 'all' && !scoped) return null;
  return (path) => {
    if (exts.size && !exts.has(extOf(path))) return false;
    const s = stats.get(path);
    if (scoped && !s) return false;
    if (status === 'all') return true;
    if (!s) return false;
    if (status === 'touched') return s.reads + s.edits + s.fails > 0;
    if (status === 'read') return s.reads > 0;
    if (status === 'edited') return s.edits > 0;
    if (status === 'failed') return s.fails > 0;
    return true;
  };
}

// The overlay. mode 'jump' or 'path'; onPick(path, mode) runs on Enter or click.
export class SearchBox {
  constructor(root, input, title, list, { paths, onPick, onClose }) {
    this.root = root;
    this.input = input;
    this.title = title;
    this.list = list;
    this.paths = paths;
    this.onPick = onPick;
    this.onClose = onClose || (() => {});
    this.mode = 'jump';
    this.hits = [];
    this.active = 0;
    input.addEventListener('input', () => this.update());
    input.addEventListener('keydown', (e) => this.key(e));
    root.addEventListener('pointerdown', (e) => { if (e.target === root) this.close(); });
  }

  get isOpen() { return !this.root.hidden; }

  open(mode = 'jump', title = 'Go to file') {
    this.mode = mode;
    this.title.textContent = title;
    this.root.hidden = false;
    this.input.value = '';
    this.update();
    this.input.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.onClose(this.mode);
  }

  update() {
    const q = this.input.value;
    this.hits = q.trim() ? rankPaths(q, this.paths()) : [];
    this.active = 0;
    this.list.textContent = '';
    if (!q.trim()) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = 'Type part of a path. Arrow keys to move, Enter to pick, Esc to close.';
      this.list.append(li);
      return;
    }
    if (!this.hits.length) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = 'No file matches.';
      this.list.append(li);
      return;
    }
    this.hits.forEach((h, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.tabIndex = -1;
      const marks = new Set(h.positions);
      let run = '';
      let runMarked = false;
      const flush = () => {
        if (!run) return;
        if (runMarked) { const m = document.createElement('b'); m.textContent = run; b.append(m); } else b.append(run);
        run = '';
      };
      for (let k = 0; k < h.path.length; k++) {
        const marked = marks.has(k);
        if (marked !== runMarked) { flush(); runMarked = marked; }
        run += h.path[k];
      }
      flush();
      b.addEventListener('pointerenter', () => this.setActive(i));
      b.addEventListener('click', () => this.pick(i));
      li.append(b);
      this.list.append(li);
    });
    this.setActive(0);
  }

  setActive(i) {
    const items = this.list.querySelectorAll('button');
    if (!items.length) return;
    this.active = (i + items.length) % items.length;
    items.forEach((b, k) => b.classList.toggle('on', k === this.active));
    items[this.active].scrollIntoView({ block: 'nearest' });
  }

  pick(i) {
    const hit = this.hits[i];
    if (!hit) return;
    const { mode } = this;
    this.root.hidden = true;
    this.onPick(hit.path, mode);
  }

  key(e) {
    // Keys typed here must not reach the page's own shortcuts.
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); this.setActive(this.active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.setActive(this.active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); this.pick(this.active); }
    else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
  }
}
