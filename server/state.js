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

function strongest(statuses) {
  return statuses.reduce((a, b) => (STATUS_RANK.indexOf(b) > STATUS_RANK.indexOf(a) ? b : a), 'idle');
}

// Tool call lifecycle, feed and per-node session stats. Async hooks have no
// documented ordering, so a Post may overtake its Pre: each call is tracked by
// tool_use_id and a finished call ignores anything that arrives later.
class ActivityState {
  constructor({ pendingTtlMs = 120000, maxFeed = 500, maxCalls = 5000 } = {}) {
    this.pendingTtlMs = pendingTtlMs;
    this.maxFeed = maxFeed;
    this.maxCalls = maxCalls;
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
    return { entry, pulses, touched: active ? [] : touched };
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
    return { entry, pulses, touched: targets.map((t) => t.path) };
  }

  stats(path) {
    return this.touches.get(path);
  }

  resetHeat() {
    for (const s of this.touches.values()) s.heat = 0;
  }

  snapshot() {
    return { feed: this.feed, touches: Object.fromEntries(this.touches) };
  }
}

module.exports = { ActivityState };
