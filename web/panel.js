// File detail side panel. All repo text goes through textContent.
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium', hour12: false });

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Line numbers on the new side that git reports as added or changed.
function changedLines(hunks) {
  const out = new Set();
  for (const h of hunks) {
    let n = h.newStart;
    for (const l of h.lines) {
      if (l.op === '+') out.add(n);
      if (l.op !== '-') n++;
    }
  }
  return out;
}

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  if (h) return `${h} h ${m} min`;
  return m ? `${m} min ${s % 60} s` : `${s} s`;
}

function counts(h) {
  const parts = [];
  if (h.reads) parts.push(`${h.reads} read`);
  if (h.edits) parts.push(`${h.edits} edited`);
  if (h.fails) parts.push(`${h.fails} failed`);
  return ` ${parts.join(', ')}`;
}

export class Panel {
  constructor(root, body, close, { onJump, onClose, onFindPath, onBlastHighlight, onClearPath }) {
    this.views = new Map(); // path -> 'file' | 'changes', the tab the user picked.
    this.root = root;
    this.body = body;
    this.onJump = onJump;
    this.onClose = onClose;
    this.onFindPath = onFindPath;
    this.onBlastHighlight = onBlastHighlight;
    this.onClearPath = onClearPath;
    // Set by the app for the selected file and drawn by render():
    // blast: null | {loading} | {data, on, expanded}; path: null | {to, steps}.
    this.extras = { blast: null, path: null };
    close.addEventListener('click', () => this.onClose());
    root.addEventListener('transitionend', () => {
      if (!root.classList.contains('open')) root.hidden = true;
    });
  }

  open() {
    this.root.hidden = false;
    // A frame between unhide and transform, so the slide actually animates.
    requestAnimationFrame(() => this.root.classList.add('open'));
  }

  close() {
    this.root.classList.remove('open');
  }

  jump(path) {
    return el('button', { type: 'button', textContent: path, onclick: () => this.onJump(path) });
  }

  section(title, count, content, swatch) {
    const heading = el('h3', {}, title);
    if (swatch) heading.prepend(el('span', { className: 'swatch', style: `background:${swatch}` }));
    if (count !== null) heading.append(el('span', { className: 'n', textContent: String(count) }));
    return el('section', {}, heading, content);
  }

  fileView(text, marked) {
    const pre = el('pre', { className: 'code' });
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    lines.forEach((line, i) => {
      const row = el('div', { className: marked(i + 1) ? 'line add' : 'line', textContent: line || ' ' });
      row.dataset.n = i + 1;
      pre.append(row);
    });
    return pre;
  }

  changesView(hunks) {
    const pre = el('pre', { className: 'code diff' });
    for (const h of hunks) {
      pre.append(el('div', { className: 'hunk', textContent: `Line ${h.newStart}` }));
      let n = h.newStart;
      for (const l of h.lines) {
        const row = el('div', { className: l.op === '+' ? 'line add' : l.op === '-' ? 'line del' : 'line', textContent: l.text || ' ' });
        row.dataset.n = l.op === '-' ? '-' : n;
        if (l.op !== '-') n++;
        pre.append(row);
      }
    }
    return pre;
  }

  contents(path, src) {
    if (src === undefined) return el('p', { className: 'note', textContent: 'Loading.' });
    if (!src) return el('p', { className: 'note', textContent: 'Could not read this file.' });
    if (src.binary) return el('p', { className: 'note', textContent: 'Binary file, not shown.' });
    const diff = src.diff;
    const hunks = diff?.hunks || [];
    const notes = [];
    if (!diff) notes.push('No git history here, so changes cannot be shown.');
    else if (diff.untracked) notes.push('New file, not tracked by git yet. Every line counts as added.');
    else if (!hunks.length) notes.push('No changes since the last commit.');
    if (src.truncated) notes.push('Showing the first 512 KB.');

    const changed = changedLines(hunks);
    const marked = diff?.untracked ? () => true : (n) => changed.has(n);
    let view = this.views.get(path) || (hunks.length ? 'changes' : 'file');
    if (!hunks.length) view = 'file';
    const box = el('div', { className: 'contents' });
    if (hunks.length) {
      const tab = (name, label) => el('button', {
        type: 'button', textContent: label, className: view === name ? 'tab on' : 'tab',
        onclick: () => { this.views.set(path, name); box.replaceWith(this.contents(path, src)); },
      });
      const added = hunks.reduce((k, h) => k + h.lines.filter((l) => l.op === '+').length, 0);
      const removed = hunks.reduce((k, h) => k + h.lines.filter((l) => l.op === '-').length, 0);
      box.append(el('div', { className: 'tabs' }, tab('changes', 'Changes'), tab('file', 'File'),
        el('span', { className: 'stat add', textContent: `+${added}` }), el('span', { className: 'stat del', textContent: `-${removed}` })));
    }
    for (const n of notes) box.append(el('p', { className: 'note', textContent: n }));
    box.append(view === 'changes' ? this.changesView(hunks) : this.fileView(src.text, marked));
    return box;
  }

  render(d, src) {
    const slash = d.path.lastIndexOf('/');
    const head = [el('h2', { textContent: d.path.slice(slash + 1) })];
    if (slash >= 0) head.push(el('p', { className: 'dir', textContent: d.path.slice(0, slash) }));

    const meta = el('dl');
    const pair = (k, v) => meta.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
    pair('Language', d.language);
    pair('Size', size(d.size));
    pair('Modified', dateFormat.format(d.mtimeMs));

    const s = d.stats || { reads: 0, edits: 0, fails: 0 };
    const session = el('dl');
    const sPair = (k, v) => session.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
    sPair('Read', `${s.reads} ${s.reads === 1 ? 'time' : 'times'}`);
    sPair('Edited', `${s.edits} ${s.edits === 1 ? 'time' : 'times'}`);
    if (s.fails) sPair('Failed', `${s.fails} ${s.fails === 1 ? 'time' : 'times'}`);
    sPair('Last touch', d.stats ? timeFormat.format(d.stats.last) : 'Not touched this session');

    const importList = el('ul');
    for (const imp of d.imports) {
      if (imp.targets.length) for (const t of imp.targets) importList.append(el('li', {}, this.jump(t)));
      else importList.append(el('li', { className: 'external', textContent: imp.spec }));
    }
    const importedList = el('ul');
    for (const p of d.importedBy) importedList.append(el('li', {}, this.jump(p)));

    const waiting = () => el('p', { className: 'note', textContent: 'Indexing the repo.' });
    const none = (text) => el('p', { className: 'note', textContent: text });
    const parts = [
      ...head,
      el('div', { className: 'actions' }, el('button', { type: 'button', textContent: 'Find path to…', onclick: () => this.onFindPath(d.path) })),
      meta,
      this.section('Session', null, session),
    ];
    if (this.extras.path) parts.push(this.pathSection(this.extras.path));
    parts.push(
      this.section('Imports', d.imports.length, d.indexing ? waiting() : d.imports.length ? importList : none('No imports found.'), 'var(--imports)'),
      this.section('Imported by', d.importedBy.length, d.indexing ? waiting() : d.importedBy.length ? importedList : none('Nothing in this repo imports it.'), 'var(--imported-by)'),
    );
    if (d.indexing) parts.push(this.section('Affected if changed', null, waiting()));
    else if (this.extras.blast) parts.push(this.blastSection(d, this.extras.blast));
    const tokens = (list) => el('div', { className: 'tokens' }, ...list.slice(0, 60).map((t) => el('span', { textContent: t })));
    if (d.exports.length) parts.push(this.section('Exports', d.exports.length, tokens(d.exports)));
    const internal = d.symbols.filter((x) => !d.exports.includes(x));
    if (internal.length) parts.push(this.section('Other top-level symbols', internal.length, tokens(internal)));
    if (d.tests.length) {
      parts.push(this.section('Related tests', d.tests.length, el('ul', {}, ...d.tests.map((t) => el('li', {}, this.jump(t))))));
    }
    parts.push(this.section('Contents', null, this.contents(d.path, src)));
    const scroll = this.root.scrollTop;
    this.body.replaceChildren(...parts);
    this.root.scrollTop = scroll;
  }

  pathSection({ to, steps }) {
    const clear = el('button', { type: 'button', className: 'aside', textContent: 'Clear', onclick: () => this.onClearPath() });
    let content;
    if (!steps) content = el('p', { className: 'note', textContent: 'No chain of imports connects these files.' });
    else {
      content = el('ol', { className: 'steps' }, ...steps.map((s) => el('li', {},
        s.dir ? el('span', { className: 'dir-label', textContent: s.dir === 'imports' ? 'imports' : 'is imported by' }) : '',
        this.jump(s.path))));
    }
    const section = this.section(`Path to ${to.slice(to.lastIndexOf('/') + 1)}`, steps ? steps.length - 1 : null, content, 'var(--t-path)');
    section.querySelector('h3').append(clear);
    return section;
  }

  blastSection(d, b) {
    const title = 'Affected if changed';
    if (b.loading) return this.section(title, null, el('p', { className: 'note', textContent: 'Loading.' }), 'var(--t-blast)');
    const deps = b.data.dependents;
    if (!deps.length) return this.section(title, 0, el('p', { className: 'note', textContent: 'Nothing depends on this file.' }), 'var(--t-blast)');
    const box = el('div');
    const byDepth = new Map();
    for (const x of deps) {
      if (!byDepth.has(x.depth)) byDepth.set(x.depth, []);
      byDepth.get(x.depth).push(x.path);
    }
    let room = b.expanded ? Infinity : 30;
    let shown = 0;
    for (const depth of [...byDepth.keys()].sort((a, c) => a - c)) {
      if (room <= 0) break;
      const paths = byDepth.get(depth).slice(0, room);
      box.append(el('p', { className: 'depth', textContent: `${depth === 1 ? 'Direct' : `Depth ${depth}`} (${byDepth.get(depth).length})` }));
      box.append(el('ul', {}, ...paths.map((p) => el('li', {}, this.jump(p)))));
      room -= paths.length;
      shown += paths.length;
    }
    const hidden = shown < deps.length;
    if (hidden || b.data.truncated) {
      const more = b.data.truncated ? 'Stopped at 2,000 files.' : '';
      if (hidden) {
        box.append(el('button', {
          type: 'button', className: 'more', textContent: `Show all ${deps.length.toLocaleString()}`,
          onclick: () => { b.expanded = true; box.parentNode.replaceWith(this.blastSection(d, b)); },
        }));
      }
      if (more) box.append(el('p', { className: 'note', textContent: more }));
    }
    const toggle = el('button', {
      type: 'button', className: b.on ? 'aside on' : 'aside', textContent: 'Highlight',
      onclick: () => this.onBlastHighlight(!b.on),
    });
    toggle.setAttribute('aria-pressed', String(!!b.on));
    const section = this.section(title, `${deps.length.toLocaleString()}${b.data.truncated ? '+' : ''}`, box, 'var(--t-blast)');
    section.querySelector('h3').append(toggle);
    return section;
  }

  // The session review. s is /api/summary, or null while loading or on error.
  renderSummary(s, failed = false) {
    const head = el('h2', { textContent: 'Session summary' });
    if (!s) {
      this.body.replaceChildren(head, el('p', { className: 'note', textContent: failed ? 'Could not load the summary.' : 'Loading.' }));
      return;
    }
    const parts = [head, el('p', { className: 'dir', textContent: s.session ? `Session ${String(s.session).slice(0, 8)}` : 'All sessions' })];
    const meta = el('dl');
    const pair = (k, v) => meta.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
    pair('Duration', duration(s.durationMs));
    pair('Calls', String(s.calls));
    pair('Read', String(s.counts.read));
    pair('Edited', String(s.counts.edited));
    pair('Created', String(s.counts.created));
    pair('Failed', String(s.counts.failed));
    parts.push(meta);

    const list = (items, row) => el('ul', {}, ...items.map((x) => el('li', {}, ...row(x))));
    const changes = (p) => el('button', {
      type: 'button', textContent: p,
      onclick: () => { this.views.set(p, 'changes'); this.onJump(p); },
    });
    const add = (title, items, row, empty, swatch) => {
      parts.push(this.section(title, items.length, items.length ? list(items, row) : el('p', { className: 'note', textContent: empty }), swatch));
    };
    add('Hotspots', s.hotspots, (h) => [this.jump(h.path), el('span', { className: 'count', textContent: counts(h) })], 'Nothing touched yet.');
    add('Edited', s.edited, (p) => [changes(p)], 'No files edited.', 'var(--editing)');
    if (s.created.length) add('Created', s.created, (p) => [changes(p)], '', 'var(--created)');
    add('Edited without reading first', s.editedWithoutRead, (p) => [changes(p)], 'Every edited file was read first.');
    add('Unread dependents', s.unreadDependents, (u) => [this.jump(u.path), el('span', { className: 'count', textContent: ' of ' }), this.jump(u.of)],
      'Every importer of an edited file was read.');
    add('Failed calls', s.failedCalls, (f) => [
      el('span', { className: 'count', textContent: `${timeFormat.format(f.ts)} ` }),
      el('span', { className: 'failed-label', textContent: f.label }),
      ...(f.error ? [el('p', { className: 'note', textContent: f.error })] : []),
    ], 'No calls failed.', 'var(--failed)');
    this.body.replaceChildren(...parts);
  }

  showGone(path) {
    this.body.replaceChildren(el('h2', { textContent: path }), el('p', { className: 'note', textContent: 'This file no longer exists.' }));
  }
}
