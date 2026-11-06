'use strict';

const VERBS = {
  read: ['Reading', 'Read'],
  search: ['Searching', 'Searched'],
  edit: ['Editing', 'Edited'],
  bash: ['Running', 'Ran'],
  other: ['Using', 'Used'],
};
const ACTION_STATUS = { read: 'reading', edit: 'editing', create: 'created' };
const STATUS_RANK = ['idle', 'reading', 'editing', 'created', 'failed'];
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const THRASH_EDITS = 5;
const THRASH_WINDOW_MS = 10 * 60 * 1000;
const REPEAT_FAILS = 3;
const MAX_ALERTS = 20;
const TOP_HOTSPOTS = 10;
const MAX_UNREAD_DEPENDENTS = 50;

function strongest(statuses) {
  return statuses.reduce((a, b) => (STATUS_RANK.indexOf(b) > STATUS_RANK.indexOf(a) ? b : a), 'idle');
}

// Tool call lifecycle, feed and per-node session stats. Async hooks have no
// documented ordering, so a Post may overtake its Pre: each call is tracked by
// tool_use_id and a finished call ignores anything that arrives later.
class ActivityState {
  constructor({ pendingTtlMs = 120000, maxFeed = 500, maxCalls = 5000, maxHistory = 20000 } = {}) {
    this.pendingTtlMs = pendingTtlMs;
    this.maxFeed = maxFeed;
    this.maxCalls = maxCalls;
    this.maxHistory = maxHistory;
    this.events = []; // Trimmed in batches; read through the history getter.
    this.alerts = [];
    this.recentEdits = new Map(); // path -> edit times inside the thrash window
    this.thrashing = new Set();
    this.failStreaks = new Map(); // session -> {label, count}
    this.calls = new Map();
    this.pending = new Map();
    this.feed = [];
    this.touches = new Map();
  }

  apply(ev, now) {
    let call = this.calls.get(ev.id);
    if (call && !call.entry.pending && !call.entry.expired) return null;
    if (call && ev.phase === 'start') return null;
    if (!call) call = this.open(ev, now);

    const entry = call.entry;
    const active = ev.phase === 'start';
    const interrupted = ev.phase === 'interrupt';
    const failed = ev.phase === 'fail';
    const targets = interrupted ? [] : ev.targets;

    entry.pending = active;
    entry.expired = false;
    entry.label = ev.label;
    if (ev.error) entry.error = ev.error;
    if (targets.length || !active) entry.paths = (interrupted ? ev.targets : targets).map((t) => t.path);
    entry.status = failed ? 'failed' : strongest(targets.map((t) => ACTION_STATUS[t.action]));
    entry.verb = this.verb(ev, targets, active, failed, interrupted);

    if (active) this.pending.set(ev.id, now);
    else {
      this.pending.delete(ev.id);
      entry.endedAt = now;
      this.count(call, targets, failed, now);
    }
    const touched = targets.filter((t) => t.heat).map((t) => t.path);
    const pulses = targets.map((t) => ({ path: t.path, status: failed ? 'failed' : ACTION_STATUS[t.action] }));
    if (active) return { entry, pulses, touched: [], alerts: [] };
    const event = this.record(entry, entry.status, entry.paths, pulses, touched, now);
    return { entry, pulses, touched, event, alerts: [...this.checkThrash(event), ...this.checkRepeatFail(event)] };
  }

  // The run history: one event per finished call and one per rescan attribution.
  record(entry, status, paths, pulses, touched, now) {
    const { id, session, agent, kind, tool, label, error } = entry;
    const event = { ts: now, id, session, agent, kind, tool, label, status, paths: [...paths], pulses, touched, error };
    this.events.push(event);
    // Dropping the oldest one at a time would shift the whole array per call.
    if (this.events.length >= 2 * this.maxHistory) this.events.splice(0, this.events.length - this.maxHistory);
    return event;
  }

  get history() {
    const n = this.events.length - this.maxHistory;
    return n > 0 ? this.events.slice(n) : this.events;
  }

  alert(a) {
    this.alerts.push(a);
    if (this.alerts.length > MAX_ALERTS) this.alerts.shift();
    return a;
  }

  // Fires once per file; it can fire again only after the window has dropped
  // below the threshold.
  checkThrash(event) {
    const out = [];
    const heat = new Set(event.touched);
    for (const { path, status } of event.pulses) {
      if (!heat.has(path) || (status !== 'editing' && status !== 'created')) continue;
      const times = (this.recentEdits.get(path) || []).filter((t) => event.ts - t < THRASH_WINDOW_MS);
      if (times.length < THRASH_EDITS) this.thrashing.delete(path);
      times.push(event.ts);
      this.recentEdits.set(path, times);
      if (times.length < THRASH_EDITS || this.thrashing.has(path)) continue;
      this.thrashing.add(path);
      out.push(this.alert({ kind: 'thrash', path, count: times.length, session: event.session, ts: event.ts, entryId: event.id }));
    }
    return out;
  }

  // Counts consecutive failures of one Bash command per session. Any other
  // outcome of a Bash call in that session starts the count again.
  checkRepeatFail(event) {
    if (event.kind !== 'bash') return [];
    const streak = this.failStreaks.get(event.session);
    if (event.status !== 'failed') {
      this.failStreaks.delete(event.session);
      return [];
    }
    if (!streak || streak.label !== event.label) {
      this.failStreaks.set(event.session, { label: event.label, count: 1 });
      return [];
    }
    streak.count++;
    if (streak.count !== REPEAT_FAILS) return [];
    return [this.alert({ kind: 'repeat-fail', label: event.label, count: streak.count, session: event.session, ts: event.ts, entryId: event.id })];
  }

  verb(ev, targets, active, failed, interrupted) {
    if (failed) return 'Failed';
    if (interrupted) return 'Interrupted';
    const [running, done] = VERBS[ev.kind] || VERBS.other;
    if (active) return running;
    return targets.some((t) => t.action === 'create') && ev.kind === 'edit' ? 'Created' : done;
  }

  open(ev, now) {
    const entry = {
      id: ev.id,
      ts: now,
      tool: ev.tool,
      kind: ev.kind,
      session: ev.session,
      agent: ev.agent,
      label: ev.label,
      paths: [],
      status: 'idle',
      verb: '',
      pending: true,
    };
    const call = { entry, counted: new Set() };
    this.calls.set(ev.id, call);
    this.feed.push(entry);
    if (this.feed.length > this.maxFeed) this.feed.shift();
    if (this.calls.size > this.maxCalls) this.calls.delete(this.calls.keys().next().value);
    return call;
  }

  count(call, targets, failed, now) {
    for (const t of targets) {
      if (!t.heat) continue;
      call.counted.add(t.path);
      const s = this.touch(t.path, now);
      if (failed) s.fails++;
      else if (t.action === 'read') s.reads++;
      else s.edits++;
    }
  }

  touch(path, now) {
    let s = this.touches.get(path);
    if (!s) this.touches.set(path, (s = { reads: 0, edits: 0, fails: 0, heat: 0, last: now }));
    s.heat++;
    s.last = now;
    return s;
  }

  // Calls with a Pre and no Post, such as a denied permission prompt, must not
  // read as in progress forever. A late Post can still resolve them.
  sweep(now) {
    // Forget files with no edit inside the thrash window, so this stays small.
    for (const [path, times] of this.recentEdits) {
      if (now - times[times.length - 1] < THRASH_WINDOW_MS) continue;
      this.recentEdits.delete(path);
      this.thrashing.delete(path);
    }
    const expired = [];
    for (const [id, startedAt] of this.pending) {
      if (now - startedAt < this.pendingTtlMs) continue;
      this.pending.delete(id);
      const { entry } = this.calls.get(id) || {};
      if (!entry) continue;
      entry.pending = false;
      entry.expired = true;
      entry.verb = 'Did not finish';
      expired.push(entry);
    }
    return expired;
  }

  // Adds changes found by a rescan after a Bash call finished.
  attribute(id, { edited = [], created = [] }, now) {
    const call = this.calls.get(id);
    if (!call) return null;
    const fresh = (p) => !call.counted.has(p);
    const targets = [
      ...edited.filter(fresh).map((path) => ({ path, action: 'edit', heat: true })),
      ...created.filter(fresh).map((path) => ({ path, action: 'create', heat: true })),
    ];
    if (!targets.length) return null;
    this.count(call, targets, false, now);
    const { entry } = call;
    entry.paths = [...new Set([...entry.paths, ...targets.map((t) => t.path)])];
    const pulses = targets.map((t) => ({ path: t.path, status: ACTION_STATUS[t.action] }));
    entry.status = strongest([entry.status, ...pulses.map((p) => p.status)]);
    const touched = targets.map((t) => t.path);
    const event = this.record(entry, strongest(pulses.map((p) => p.status)), touched, pulses, touched, now);
    return { entry, pulses, touched, event, alerts: this.checkThrash(event) };
  }

  stats(path) {
    return this.touches.get(path);
  }

  resetHeat() {
    for (const s of this.touches.values()) s.heat = 0;
  }

  snapshot() {
    return { feed: this.feed, touches: Object.fromEntries(this.touches), alerts: this.alerts };
  }

  // Review of one session, or of all of them when session is null. importedBy
  // is the reverse import graph, for dependents of changed files.
  summary(session, importedBy) {
    const events = session ? this.history.filter((e) => e.session === session) : this.history;
    const spots = new Map();
    const read = new Set();
    const seen = new Set(); // Any read, edit or create pulse: Claude has looked at or changed it.
    const changed = { editing: new Set(), created: new Set() };
    const readBySession = new Map();
    const editedWithoutRead = new Set();
    const failedCalls = [];
    for (const e of events) {
      if (!readBySession.has(e.session)) readBySession.set(e.session, new Set());
      const sessionReads = readBySession.get(e.session);
      const heat = new Set(e.touched);
      for (const { path, status } of e.pulses) {
        if (status === 'reading' || changed[status]) seen.add(path);
        // A file Claude wrote in full counts as read for later edits.
        if ((status === 'reading' && e.tool === 'Read') || status === 'created') sessionReads.add(path);
        if (status === 'editing' && EDIT_TOOLS.has(e.tool) && !sessionReads.has(path)) editedWithoutRead.add(path);
        if (!heat.has(path)) continue;
        if (!spots.has(path)) spots.set(path, { path, reads: 0, edits: 0, fails: 0 });
        const s = spots.get(path);
        if (status === 'failed') s.fails++;
        else if (status === 'reading') { s.reads++; read.add(path); }
        else if (changed[status]) { s.edits++; changed[status].add(path); }
      }
      if (e.status === 'failed') failedCalls.push({ ts: e.ts, label: e.label, error: e.error ?? null });
    }
    const created = [...changed.created].sort();
    const edited = [...changed.editing].filter((p) => !changed.created.has(p)).sort();
    const unreadDependents = [];
    const listed = new Set();
    for (const file of [...edited, ...created]) {
      for (const p of [...(importedBy.get(file) || [])].sort()) {
        if (seen.has(p) || listed.has(p) || unreadDependents.length >= MAX_UNREAD_DEPENDENTS) continue;
        listed.add(p);
        unreadDependents.push({ path: p, of: file });
      }
    }
    const startedAt = events.length ? events[0].ts : null;
    const endedAt = events.length ? events[events.length - 1].ts : null;
    const total = (s) => s.reads + s.edits + s.fails;
    return {
      session: session || null,
      startedAt,
      endedAt,
      durationMs: events.length ? endedAt - startedAt : 0,
      calls: new Set(events.map((e) => e.id)).size,
      counts: { read: read.size, edited: edited.length, created: created.length, failed: failedCalls.length },
      hotspots: [...spots.values()].sort((a, b) => total(b) - total(a) || a.path.localeCompare(b.path)).slice(0, TOP_HOTSPOTS),
      edited,
      created,
      editedWithoutRead: [...editedWithoutRead].sort(),
      unreadDependents,
      failedCalls,
    };
  }
}

module.exports = { ActivityState };
