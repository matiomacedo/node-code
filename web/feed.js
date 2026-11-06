// The activity feed. Newest entries go on top, so nothing needs auto-scrolling.
const MAX_ROWS = 500;
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export class Feed {
  constructor(list, empty, { onFocus }) {
    this.list = list;
    this.empty = empty;
    this.onFocus = onFocus;
    this.rows = new Map();
    this.alerts = new Map(); // entry id -> alert text, kept for rows that arrive later.
    this.filter = null;
    this.waiting = empty.textContent;
  }

  reset(entries) {
    this.list.textContent = '';
    this.rows.clear();
    this.alerts.clear();
    for (const e of entries) this.upsert(e);
    this.updateEmpty();
  }

  // Hides rows the predicate rejects; null shows every row. Rows stay in place.
  setFilter(fn) {
    this.filter = fn;
    for (const row of this.rows.values()) row.li.hidden = fn ? !fn(row.entry) : false;
    this.updateEmpty();
  }

  updateEmpty() {
    const shown = [...this.rows.values()].some((r) => !r.li.hidden);
    this.empty.hidden = shown;
    this.empty.textContent = this.rows.size ? 'No activity matches.' : this.waiting;
  }

  // Entries oldest first, only those the filter shows.
  visibleEntries() {
    const out = [];
    for (const row of this.rows.values()) if (!row.li.hidden) out.push(row.entry);
    return out;
  }

  mark(entryId, text) {
    if (!entryId) return;
    this.alerts.set(entryId, text);
    if (this.alerts.size > 100) this.alerts.delete(this.alerts.keys().next().value);
    const row = this.rows.get(entryId);
    if (row) this.fill(row, row.entry);
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
    row.li.hidden = this.filter ? !this.filter(entry) : false;
    this.updateEmpty();
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
    const impact = document.createElement('span');
    impact.className = 'impact';
    const row = { li, body, verb, label, text, who, impact, paths: [], entry };
    body.addEventListener('click', () => { if (row.paths.length) this.onFocus(row.paths[row.paths.length - 1]); });
    return row;
  }

  fill(row, e) {
    row.entry = e;
    row.paths = e.paths;
    const alert = this.alerts.get(e.id);
    // Paths are most useful from the end, commands from the start.
    const keepEnd = e.kind === 'read' || e.kind === 'edit';
    row.body.className = `entry ${e.status}${e.pending ? ' pending' : ''}${keepEnd ? ' keep-end' : ''}${alert ? ' alerted' : ''}`;
    row.body.disabled = !e.paths.length;
    row.body.style.cursor = e.paths.length ? 'pointer' : 'default';
    row.verb.textContent = e.verb;
    row.text.textContent = e.label;
    row.body.title = [alert, e.label, e.error, e.session && `Session ${String(e.session).slice(0, 8)}`].filter(Boolean).join('\n');
    if (e.agent) {
      row.who.textContent = e.agent;
      row.body.append(row.who);
    } else row.who.remove();
    if (e.impact > 0) {
      row.impact.textContent = `→ ${e.impact}`;
      row.impact.title = `${e.impact} ${e.impact === 1 ? 'file depends' : 'files depend'} on this`;
      row.body.append(row.impact);
    } else row.impact.remove();
  }
}
