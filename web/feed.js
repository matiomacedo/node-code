// The activity feed. Newest entries go on top, so nothing needs auto-scrolling.
const MAX_ROWS = 500;
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export class Feed {
  constructor(list, empty, { onFocus }) {
    this.list = list;
    this.empty = empty;
    this.onFocus = onFocus;
    this.rows = new Map();
  }

  reset(entries) {
    this.list.textContent = '';
    this.rows.clear();
    for (const e of entries) this.upsert(e);
    this.empty.hidden = this.rows.size > 0;
  }

  upsert(entry) {
    let row = this.rows.get(entry.id);
    if (!row) {
      row = this.createRow(entry);
      this.rows.set(entry.id, row);
      this.list.prepend(row.li);
      if (this.rows.size > MAX_ROWS) {
        const [oldestId, oldest] = this.rows.entries().next().value;
        oldest.li.remove();
        this.rows.delete(oldestId);
      }
    }
    this.fill(row, entry);
    this.empty.hidden = true;
  }

  createRow(entry) {
    const li = document.createElement('li');
    const body = document.createElement('button');
    body.type = 'button';
    const time = document.createElement('time');
    const verb = document.createElement('span');
    verb.className = 'verb';
    const label = document.createElement('span');
    label.className = 'label';
    const text = document.createElement('bdi');
    label.append(text);
    const who = document.createElement('span');
    who.className = 'who';
    body.append(time, verb, label);
    li.append(body);
    time.dateTime = new Date(entry.ts).toISOString();
    time.textContent = clock.format(entry.ts);
    const row = { li, body, verb, label, text, who, paths: [] };
    body.addEventListener('click', () => { if (row.paths.length) this.onFocus(row.paths[row.paths.length - 1]); });
    return row;
  }

  fill(row, e) {
    row.paths = e.paths;
    // Paths are most useful from the end, commands from the start.
    const keepEnd = e.kind === 'read' || e.kind === 'edit';
    row.body.className = `entry ${e.status}${e.pending ? ' pending' : ''}${keepEnd ? ' keep-end' : ''}`;
    row.body.disabled = !e.paths.length;
    row.body.style.cursor = e.paths.length ? 'pointer' : 'default';
    row.verb.textContent = e.verb;
    row.text.textContent = e.label;
    row.body.title = [e.label, e.error, e.session && `Session ${String(e.session).slice(0, 8)}`].filter(Boolean).join('\n');
    if (e.agent) {
      row.who.textContent = e.agent;
      row.body.append(row.who);
    } else row.who.remove();
  }
}
