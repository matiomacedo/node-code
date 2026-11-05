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

export class Panel {
  constructor(root, body, close, { onJump, onClose }) {
    this.root = root;
    this.body = body;
    this.onJump = onJump;
    this.onClose = onClose;
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

  render(d) {
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
      meta,
      this.section('Session', null, session),
      this.section('Imports', d.imports.length, d.indexing ? waiting() : d.imports.length ? importList : none('No imports found.'), 'var(--imports)'),
      this.section('Imported by', d.importedBy.length, d.indexing ? waiting() : d.importedBy.length ? importedList : none('Nothing in this repo imports it.'), 'var(--imported-by)'),
    ];
    const tokens = (list) => el('div', { className: 'tokens' }, ...list.slice(0, 60).map((t) => el('span', { textContent: t })));
    if (d.exports.length) parts.push(this.section('Exports', d.exports.length, tokens(d.exports)));
    const internal = d.symbols.filter((x) => !d.exports.includes(x));
    if (internal.length) parts.push(this.section('Other top-level symbols', internal.length, tokens(internal)));
    if (d.tests.length) {
      parts.push(this.section('Related tests', d.tests.length, el('ul', {}, ...d.tests.map((t) => el('li', {}, this.jump(t))))));
    }
    const scroll = this.root.scrollTop;
    this.body.replaceChildren(...parts);
    this.root.scrollTop = scroll;
  }

  showGone(path) {
    this.body.replaceChildren(el('h2', { textContent: path }), el('p', { className: 'note', textContent: 'This file no longer exists.' }));
  }
}
