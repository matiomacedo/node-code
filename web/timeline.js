// Session replay. The functions over history events are pure; Timeline is the
// bottom scrubber and only touches the DOM when constructed.

// Index of the first event later than t. Events are in time order.
export function indexAfter(events, t) {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].ts <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Heat at time t: how often each path was touched up to and including t.
export function heatAt(events, t) {
  const heat = new Map();
  const end = indexAfter(events, t);
  for (let i = 0; i < end; i++) {
    for (const p of events[i].touched || []) heat.set(p, (heat.get(p) || 0) + 1);
  }
  return heat;
}

// Events with t0 < ts <= t1.
export function eventsBetween(events, t0, t1) {
  if (t1 <= t0) return [];
  return events.slice(indexAfter(events, t0), indexAfter(events, t1));
}

const COUNTS = { reading: 'reads', editing: 'edits', created: 'edits', failed: 'fails' };

// Per-file read/edit/fail counts from the events of one session and/or agent,
// counting only touched paths, the same way the server counts its stats.
export function statsFrom(events, { session = '', agent = '' } = {}) {
  const stats = new Map();
  for (const e of events) {
    if (session && e.session !== session) continue;
    if (agent && e.agent !== agent) continue;
    const touched = new Set(e.touched || []);
    for (const { path, status } of e.pulses || []) {
      const key = COUNTS[status];
      if (!key || !touched.has(path)) continue;
      let s = stats.get(path);
      if (!s) stats.set(path, (s = { reads: 0, edits: 0, fails: 0 }));
      s[key]++;
    }
  }
  return stats;
}

// The last `limit` distinct paths visited, oldest first. entries are feed
// entries oldest first; within an entry its last path counts as the latest.
export function trailPaths(entries, isFile, limit = 30) {
  const seen = new Set();
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const paths = entries[i].paths || [];
    for (let k = paths.length - 1; k >= 0 && out.length < limit; k--) {
      const p = paths[k];
      if (seen.has(p) || !isFile(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out.reverse();
}

const SPEEDS = [1, 10, 50];
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const SLIDER_MAX = 1000;

// Live, paused at t, or playing from t. onChange({live, t, prev, playing})
// runs on every move; prev is the time before the move.
export class Timeline {
  constructor({ live, play, speed, slider, label }, { now, onChange }) {
    this.els = { live, play, speed, slider, label };
    this.now = now;
    this.onChange = onChange;
    this.start = now();
    this.live = true;
    this.playing = false;
    this.t = this.start;
    this.speedIndex = 0;
    this.frame = 0;
    slider.max = String(SLIDER_MAX);
    slider.addEventListener('input', () => {
      this.playing = false;
      this.seek(this.timeAt(Number(slider.value)));
    });
    live.addEventListener('click', () => this.goLive());
    play.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    speed.addEventListener('click', () => {
      this.speedIndex = (this.speedIndex + 1) % SPEEDS.length;
      this.render();
    });
    setInterval(() => this.render(), 1000);
    this.render();
  }

  setStart(start) {
    this.start = start;
    this.render();
  }

  timeAt(v) {
    const end = this.now();
    return this.start + ((end - this.start) * v) / SLIDER_MAX;
  }

  seek(t) {
    const prev = this.live ? this.now() : this.t;
    this.live = false;
    this.t = Math.max(this.start, Math.min(this.now(), t));
    this.render();
    this.onChange({ live: false, t: this.t, prev, playing: this.playing });
  }

  play() {
    if (this.live) {
      this.live = false;
      this.t = this.start;
      this.onChange({ live: false, t: this.t, prev: this.t, playing: false });
    }
    this.playing = true;
    let last = performance.now();
    const step = (at) => {
      if (!this.playing) return;
      const next = this.t + (at - last) * SPEEDS[this.speedIndex];
      last = at;
      if (next >= this.now()) { this.goLive(); return; }
      this.seek(next);
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
    this.render();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.frame);
    this.render();
  }

  goLive() {
    this.playing = false;
    cancelAnimationFrame(this.frame);
    if (this.live) return;
    const prev = this.t;
    this.live = true;
    this.render();
    this.onChange({ live: true, t: this.now(), prev, playing: false });
  }

  render() {
    const { live, play, speed, slider, label } = this.els;
    const end = this.now();
    const span = Math.max(1, end - this.start);
    slider.value = String(this.live ? SLIDER_MAX : Math.round(((this.t - this.start) / span) * SLIDER_MAX));
    live.classList.toggle('on', this.live);
    live.setAttribute('aria-pressed', String(this.live));
    play.textContent = this.playing ? 'Pause' : 'Play';
    speed.textContent = `${SPEEDS[this.speedIndex]}×`;
    if (this.live) {
      label.textContent = 'Live';
      return;
    }
    const behind = Math.round((end - this.t) / 1000);
    const m = Math.floor(behind / 60);
    label.textContent = `${clock.format(this.t)}, ${m ? `${m} min ` : ''}${behind % 60} s ago`;
  }
}
