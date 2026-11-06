import { Tree } from '/tree.js';
import { Renderer } from '/render.js';
import { Feed } from '/feed.js';
import { Panel } from '/panel.js';
import { SearchBox, fileFilter, topExtensions } from '/search.js';
import { Timeline, heatAt, eventsBetween, statsFrom, trailPaths } from '/timeline.js';
import { THEMES } from '/theme.js';

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t');
const api = (p) => `${p}${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;

const tree = new Tree();
const canvas = $('graph');
const renderer = new Renderer(canvas);
renderer.heatOf = (id) => tree.heatOf(id);
const worker = new Worker('/sim.worker.js');

let gen = 0;
let graph = { nodes: [], links: [] };
const generations = new Map();
let selected = null;
let truncated = false;
let clockOffset = 0;
let startedAt = Date.now();
const known = new Set();

const baseRadius = (n) => {
  if (n.kind === 'more') return 3;
  if (n.kind === 'file') return 2.6;
  if (n.parent === null) return 7.5;
  return n.expanded ? 4.6 : Math.min(11, 4.6 + 0.85 * Math.log2(1 + n.count));
};

// Rebuilds the visible graph and hands it to the layout worker.
function rebuildGraph() {
  const { nodes, links } = tree.visible();
  const fan = new Array(nodes.length).fill(0);
  for (const [s] of links) fan[s]++;
  nodes.forEach((n, i) => { n.r = baseRadius(n); n.fan = fan[i]; });
  graph = { nodes, links };
  const isFirst = known.size === 0;
  gen++;
  generations.set(gen, graph);
  worker.postMessage({
    type: 'graph',
    gen,
    first: isFirst,
    nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, r: n.r, fan: n.fan, parent: n.parent })),
    links,
  });
  for (const n of nodes) {
    if (known.has(n.id)) continue;
    known.add(n.id);
    if (!isFirst) renderer.markBorn(n.id);
  }
  updateHeader();
  refreshDeps();
  refreshOverlays();
}

worker.onmessage = ({ data }) => {
  const g = generations.get(data.gen);
  if (!g) return;
  for (const old of generations.keys()) if (old < data.gen) generations.delete(old);
  renderer.applyPositions(g, data.pos, data.idle, data.alpha);
  pendingPulses.splice(0).forEach(([path, status]) => pulsePath(path, status));
};

const pendingPulses = [];
function pulsePath(path, status) {
  const id = tree.nearestVisible(path);
  if (!renderer.pulse(id, status)) pendingPulses.push([path, status]);
  if (pendingPulses.length > 200) pendingPulses.length = 0;
}

function updateHeader() {
  const nodeCount = graph.nodes.length;
  const files = tree.files.size;
  const shown = graph.nodes.filter((n) => n.kind === 'file').length;
  const note = truncated ? ', first 100,000 files only'
    : shown < files ? `, ${files.toLocaleString()} files in repo` : '';
  metaCounts = `${nodeCount.toLocaleString()} nodes${note}`;
  renderMeta();
}
let metaCounts = '';

function renderMeta() {
  const s = Math.max(0, Math.floor((Date.now() + clockOffset - startedAt) / 1000));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(hh ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  $('meta').textContent = `${metaCounts}, session ${hh ? `${hh}:` : ''}${mm}:${ss}`;
}
setInterval(renderMeta, 1000);

// Feed ------------------------------------------------------------------
const feed = new Feed($('feed-list'), $('feed-empty'), { onFocus: (path) => jumpTo(path) });

// Detail panel ----------------------------------------------------------
const panel = new Panel($('panel'), $('panel-body'), $('panel-close'), {
  onJump: (path) => jumpTo(path),
  onClose: () => select(null),
  onFindPath: (path) => search.open('path', `Path from ${path.slice(path.lastIndexOf('/') + 1)} to…`),
  onBlastHighlight: (on) => {
    if (panel.extras.blast) panel.extras.blast.on = on;
    rerenderPanel();
    refreshOverlays();
  },
  onClearPath: () => clearPath(),
});
let detail = null;
let summaryOpen = false;

async function getJSON(p) {
  try {
    const res = await fetch(api(p));
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function rerenderPanel() {
  if (!detail || detail.path !== selected) return;
  panel.render(detail, source && source.id === selected ? source.data : undefined);
}

// Dependents change only when the index does, so they are fetched once per
// selection and again after each index.
let blastStale = false;
async function loadBlast(id) {
  const keep = panel.extras.blast && panel.extras.blast.id === id ? panel.extras.blast : null;
  if (keep && !blastStale) return;
  blastStale = false;
  if (!keep) panel.extras.blast = { id, loading: true, on: false, expanded: false };
  const data = await getJSON(`/api/blast?id=${encodeURIComponent(id)}`);
  if (selected !== id || !panel.extras.blast || panel.extras.blast.id !== id) return;
  panel.extras.blast = data ? { id, data, on: panel.extras.blast.on, expanded: panel.extras.blast.expanded } : null;
  rerenderPanel();
  refreshOverlays();
}

async function showPath(from, to) {
  const res = await getJSON(`/api/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  if (selected !== from || !res) return;
  panel.extras.path = { to, steps: res.path };
  rerenderPanel();
  refreshOverlays();
}

function clearPath() {
  if (!panel.extras.path) return;
  panel.extras.path = null;
  rerenderPanel();
  refreshOverlays();
}

async function openSummary() {
  if (selected) select(null);
  summaryOpen = true;
  panel.open();
  panel.renderSummary(null);
  const s = filters.session ? `?session=${encodeURIComponent(filters.session)}` : '';
  const data = await getJSON(`/api/summary${s}`);
  if (!summaryOpen || selected) return;
  panel.renderSummary(data, !data);
}

async function loadDetail(id) {
  let res;
  try { res = await fetch(api(`/api/file?id=${encodeURIComponent(id)}`)); } catch { return; }
  if (selected !== id) return;
  if (!res.ok) { panel.showGone(id); detail = null; refreshDeps(); return; }
  detail = await res.json();
  if (selected !== id) return;
  if (!detail.indexing) loadBlast(id);
  // Contents and diff cost a disk read and git runs, so they are fetched only
  // when the file is opened or its size or mtime moved, whoever changed it.
  const stamp = `${detail.mtimeMs}:${detail.size}`;
  const fresh = source && source.id === id && source.stamp === stamp;
  panel.render(detail, fresh ? source.data : undefined);
  refreshDeps();
  if (!fresh) loadSource(id, stamp);
}

let source = null; // {id, stamp, data}; data is undefined while loading.

async function loadSource(id, stamp) {
  const mine = { id, stamp, data: undefined };
  source = mine;
  try {
    const res = await fetch(api(`/api/source?id=${encodeURIComponent(id)}`));
    mine.data = res.ok ? await res.json() : null;
  } catch {
    mine.data = null;
  }
  if (source !== mine || selected !== id || !detail || detail.path !== id) return;
  panel.render(detail, mine.data);
}

function refreshDeps() {
  if (!selected) return;
  const targets = detail && detail.path === selected ? detail : null;
  const out = targets ? targets.imports.flatMap((i) => i.targets).map((t) => tree.nearestVisible(t)) : [];
  const incoming = targets ? targets.importedBy.map((t) => tree.nearestVisible(t)) : [];
  renderer.setSelection(selected, { out, in: incoming });
}

function select(id) {
  if (id !== selected) {
    panel.extras = { blast: null, path: null };
    if (search.isOpen && search.mode === 'path') search.close();
  }
  selected = id;
  detail = null;
  summaryOpen = false;
  refreshOverlays();
  if (id) {
    panel.open();
    renderer.setSelection(id);
    loadDetail(id);
  } else {
    panel.close();
    renderer.setSelection(null);
  }
}

function jumpTo(path) {
  if (!tree.files.has(path) && !tree.folders.has(path)) return;
  const before = tree.nearestVisible(path);
  tree.reveal(path);
  if (before !== path) rebuildGraph();
  renderer.focusOn(path);
  if (tree.files.has(path)) select(path);
  else if (selected) select(null);
}

// Server stream ---------------------------------------------------------
const stream = new EventSource(api('/api/events'));
const notice = (text) => {
  $('notice').hidden = !text;
  $('notice').textContent = text || '';
};

stream.addEventListener('open', () => notice(''));
stream.addEventListener('error', () => {
  notice(stream.readyState === EventSource.CLOSED
    ? 'The server has stopped. Run /node-code:codebase-map to start it again.'
    : 'Lost connection to the server. Retrying.');
});

// Heat, history and replay ------------------------------------------------
// Session stats per file are kept here, so the heat source can switch back to
// them and the status filter can read them.
const sessionStats = new Map();
let heatSource = 'session'; // or 'git'
let gitHeat = null;
let history = { startedAt: Date.now(), events: [], sessions: [], agents: [] };
// While replaying, live activity waits here and is applied on return to Live.
const buffered = [];

function setStats(stats) {
  for (const [p, s] of Object.entries(stats)) {
    sessionStats.set(p, s);
    if (heatSource === 'session' && timeline.live) tree.setHeat(p, s.heat);
  }
}

// Puts the heat of the current source into the tree: the replay at the
// scrubbed time, git history, or this server run's session stats.
function applyHeat() {
  tree.clearHeat();
  if (!timeline.live) for (const [p, n] of heatAt(history.events, timeline.t)) tree.setHeat(p, n);
  else if (heatSource === 'git' && gitHeat) for (const [p, n] of Object.entries(gitHeat)) tree.setHeat(p, n);
  else for (const [p, s] of sessionStats) tree.setHeat(p, s.heat);
  renderer.invalidate();
}

let historyTimer = 0;
async function loadHistory() {
  clearTimeout(historyTimer);
  const h = await getJSON('/api/history');
  if (!h) return;
  history = h;
  scopedCache = null;
  timeline.setStart(h.startedAt);
  renderSelects();
  if (filters.session || filters.agent) { refreshFeedFilter(); refreshOverlays(); }
}
const scheduleHistory = () => { clearTimeout(historyTimer); historyTimer = setTimeout(loadHistory, 1500); };

function onTimeline({ live, t, prev, playing }) {
  if (live) {
    replaying = false;
    for (const [type, d] of buffered.splice(0)) {
      if (type === 'snapshot') applySnapshotActivity(d);
      else if (type === 'activity') applyActivity(d);
      else resetSessionHeat();
    }
    applyHeat();
    refreshFeedFilter();
    refreshOverlays();
    return;
  }
  if (!replaying) {
    replaying = true;
    // The page's copy may lag the server; replay what the server has now.
    loadHistory().then(() => {
      if (timeline.live) return;
      applyHeat();
      refreshFeedFilter();
      if (trailOn) refreshOverlays();
    });
  }
  const crossed = playing && t > prev ? eventsBetween(history.events, prev, t) : null;
  if (crossed) {
    if (!crossed.length) return;
    for (const ev of crossed) {
      for (const p of ev.touched || []) tree.setHeat(p, (tree.heat.get(p) || 0) + 1);
      for (const p of ev.pulses || []) pulsePath(p.path, p.status);
    }
    renderer.invalidate();
  } else applyHeat();
  refreshFeedFilter();
  if (trailOn) refreshOverlays();
}
let replaying = false;

const timeline = new Timeline(
  { live: $('tl-live'), play: $('tl-play'), speed: $('tl-speed'), slider: $('tl-slider'), label: $('tl-label') },
  { now: () => Date.now() + clockOffset, onChange: onTimeline },
);

// Filters ---------------------------------------------------------------
const filters = { exts: new Set(), status: 'all', session: '', agent: '' };
let scopedCache = null;

const filterActive = () => filters.exts.size > 0 || filters.status !== 'all' || !!filters.session || !!filters.agent;

// A path predicate for the extension and status filters. With a session or
// agent chosen, stats come from that slice of the history; scoped also keeps
// only files that slice touched (the graph wants that, the feed does not).
function pathFilter(scoped) {
  const sliced = !!(filters.session || filters.agent);
  let stats = sessionStats;
  if (sliced) {
    const key = `${filters.session}\n${filters.agent}`;
    if (!scopedCache || scopedCache.key !== key) scopedCache = { key, stats: statsFrom(history.events, filters) };
    stats = scopedCache.stats;
  }
  return fileFilter({ exts: filters.exts, status: filters.status, stats, scoped: scoped && sliced });
}

function refreshFeedFilter() {
  const match = pathFilter(false);
  const { session, agent } = filters;
  const { live, t } = timeline;
  if (!match && !session && !agent && live) { feed.setFilter(null); return; }
  feed.setFilter((e) => (!session || e.session === session) && (!agent || e.agent === agent)
    && (live || e.ts <= t) && (!match || e.paths.some(match)));
}

function onFiltersChanged() {
  $('f-clear').hidden = !filterActive();
  refreshFeedFilter();
  refreshOverlays();
  if (summaryOpen) openSummary();
}

function renderChips() {
  const exts = topExtensions(tree.files.keys());
  for (const e of filters.exts) if (!exts.includes(e)) exts.push(e);
  const box = $('ext-chips');
  if (box.dataset.exts === exts.join(' ')) return;
  box.dataset.exts = exts.join(' ');
  box.replaceChildren(...exts.map((ext) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = `.${ext}`;
    b.setAttribute('aria-pressed', String(filters.exts.has(ext)));
    b.addEventListener('click', () => {
      if (filters.exts.has(ext)) filters.exts.delete(ext);
      else filters.exts.add(ext);
      b.setAttribute('aria-pressed', String(filters.exts.has(ext)));
      onFiltersChanged();
    });
    return b;
  }));
}

function fillSelect(sel, all, values, name, current) {
  const opts = [new Option(all, '')];
  for (const v of values) opts.push(new Option(name(v), v));
  if (current && !values.includes(current)) opts.push(new Option(name(current), current));
  sel.replaceChildren(...opts);
  sel.value = current;
}

function renderSelects() {
  fillSelect($('f-session'), 'All sessions', history.sessions, (s) => `Session ${String(s).slice(0, 8)}`, filters.session);
  fillSelect($('f-agent'), 'All agents', history.agents, (a) => a, filters.agent);
  $('f-session').hidden = history.sessions.length < 2 && !filters.session;
  $('f-agent').hidden = !history.agents.length && !filters.agent;
}

for (const [id, key] of [['f-status', 'status'], ['f-session', 'session'], ['f-agent', 'agent']]) {
  $(id).addEventListener('change', (e) => { filters[key] = e.target.value; onFiltersChanged(); });
}
$('f-clear').addEventListener('click', () => {
  Object.assign(filters, { exts: new Set(), status: 'all', session: '', agent: '' });
  $('f-status').value = 'all';
  renderSelects();
  $('ext-chips').dataset.exts = '';
  renderChips();
  onFiltersChanged();
});

// Overlays --------------------------------------------------------------
let insightsOn = false;
let insights = null;
let trailOn = false;

const posixDir = (p) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
};

// The node a path shows as: itself, or its closest visible folder.
function visibleFor(path, shown) {
  if (shown.has(path)) return path;
  let p = path;
  while (p !== '.') {
    p = posixDir(p);
    if (shown.has(p)) return p;
  }
  return '.';
}

// Highlights, trail and dimming all hold node ids, which change whenever the
// visible tree does, so they are all recomputed here from their paths.
function refreshOverlays() {
  const shown = new Set(graph.nodes.map((n) => n.id));
  const bright = new Set(selected ? [visibleFor(selected, shown)] : []);
  const unique = (paths) => [...new Set(paths.map((p) => visibleFor(p, shown)))];
  const chain = (paths) => paths.map((p) => visibleFor(p, shown)).filter((id, i, a) => id !== a[i - 1]);
  const set = (name, ids) => {
    renderer.setHighlight(name, ids);
    if (ids) for (const id of ids) bright.add(id);
  };
  const { blast, path } = panel.extras;
  set('blast', blast && blast.on && blast.data ? unique(blast.data.dependents.map((d) => d.path)) : null);
  set('path', path && path.steps ? chain(path.steps.map((s) => s.path)) : null);
  set('cycles', insights ? unique(insights.cycles.flat()) : null);
  set('hubs', insights ? unique(insights.hubs.map((h) => h.path)) : null);
  set('orphans', insights ? unique(insights.orphans) : null);
  const trail = trailOn ? chain(trailPaths(feed.visibleEntries(), (p) => tree.files.has(p))) : null;
  renderer.setTrail(trail && trail.length ? trail : null);
  if (trail) for (const id of trail) bright.add(id);

  const match = pathFilter(true);
  if (!match) { renderer.setDim(null); return; }
  // A folder stays bright when anything under it matches.
  for (const p of tree.files.keys()) {
    if (!match(p)) continue;
    let id = visibleFor(p, shown);
    while (!bright.has(id)) {
      bright.add(id);
      if (id === '.') break;
      id = posixDir(id);
    }
  }
  renderer.setDim(bright);
}

async function loadInsights() {
  const d = await getJSON('/api/insights');
  if (!insightsOn) return;
  insights = d;
  const legend = $('insights-legend');
  legend.hidden = !d;
  if (d) {
    $('ins-cycles').textContent = `In an import cycle (${d.cycles.reduce((n, c) => n + c.length, 0)})`;
    $('ins-hubs').textContent = `Most imported (${d.hubs.length})`;
    $('ins-orphans').textContent = `Unconnected (${d.orphans.length})`;
    legend.title = d.indexing ? 'Still indexing, so this may be incomplete.' : '';
  }
  refreshOverlays();
}

// Server stream handlers --------------------------------------------------
function applySnapshotActivity(d) {
  sessionStats.clear();
  for (const [p, s] of Object.entries(d.touches)) sessionStats.set(p, s);
  feed.reset(d.feed);
  for (const a of d.alerts || []) feed.mark(a.entryId, alertText(a));
  applyHeat();
}

stream.addEventListener('snapshot', (e) => {
  const d = JSON.parse(e.data);
  clockOffset = d.now - Date.now();
  startedAt = d.startedAt;
  truncated = d.truncated;
  document.title = `${d.repo} graph`;
  $('repo').textContent = d.repo;
  renderer.rootName = d.repo;
  tree.setFiles(d.files);
  if (timeline.live) applySnapshotActivity(d);
  else buffered.push(['snapshot', d]);
  renderChips();
  refreshFeedFilter();
  rebuildGraph();
  if (selected) loadDetail(selected);
  loadHistory();
});

stream.addEventListener('tree', (e) => {
  const { added, removed } = JSON.parse(e.data);
  for (const [p, size] of added) tree.addFile(p, size);
  for (const p of removed) {
    tree.removeFile(p);
    if (selected === p) loadDetail(p);
  }
  renderChips();
  rebuildGraph();
});

function applyActivity({ entry, pulses, stats }) {
  feed.upsert(entry);
  setStats(stats);
  for (const p of pulses) pulsePath(p.path, p.status);
  const counted = Object.keys(stats).length > 0;
  if (counted) renderer.invalidate();
  if (trailOn || (counted && filters.status !== 'all')) refreshOverlays();
  if (selected && (selected in stats || entry.paths.includes(selected))) loadDetail(selected);
  const isNew = (entry.session && !history.sessions.includes(entry.session)) || (entry.agent && !history.agents.includes(entry.agent));
  if (isNew || ((filters.session || filters.agent) && counted)) scheduleHistory();
}

stream.addEventListener('activity', (e) => {
  const data = JSON.parse(e.data);
  if (timeline.live) applyActivity(data);
  else buffered.push(['activity', data]);
  if (window.__ncSeen) window.__ncSeen.push({ id: data.entry.id, verb: data.entry.verb, pulses: data.pulses, at: Date.now(), hookAt: data.hookAt });
});

stream.addEventListener('index', () => {
  blastStale = true;
  if (selected) loadDetail(selected);
  if (insightsOn) loadInsights();
});

function resetSessionHeat() {
  for (const s of sessionStats.values()) s.heat = 0;
  applyHeat();
}

stream.addEventListener('heat-reset', () => {
  if (timeline.live) resetSessionHeat();
  else buffered.push(['heat-reset']);
  if (selected) loadDetail(selected);
});

function alertText(a) {
  if (a.kind === 'thrash') return `${a.path} edited ${a.count} times in 10 minutes`;
  return `"${a.label}" failed ${a.count} times in a row`;
}

const MAX_TOASTS = 4;
stream.addEventListener('alert', (e) => {
  const a = JSON.parse(e.data);
  feed.mark(a.entryId, alertText(a));
  const box = $('toasts');
  const toast = document.createElement('div');
  toast.className = `toast ${a.kind}`;
  toast.setAttribute('role', 'status');
  const title = document.createElement('strong');
  title.textContent = a.kind === 'thrash' ? 'Same file, many edits' : 'Same command keeps failing';
  const text = document.createElement(a.path ? 'button' : 'p');
  text.className = 'text';
  text.textContent = alertText(a);
  if (a.path) {
    text.type = 'button';
    text.addEventListener('click', () => jumpTo(a.path));
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', () => toast.remove());
  toast.append(title, text, close);
  box.append(toast);
  while (box.children.length > MAX_TOASTS) box.firstElementChild.remove();
});

// Controls --------------------------------------------------------------
$('heat-toggle').addEventListener('click', (e) => {
  renderer.heatVisible = !renderer.heatVisible;
  e.target.textContent = renderer.heatVisible ? 'Hide heat' : 'Show heat';
  renderer.invalidate();
});
$('heat-reset').addEventListener('click', () => fetch(api('/api/heat/reset'), { method: 'POST' }));
$('heat-source').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (heatSource === 'git') heatSource = 'session';
  else {
    const g = await getJSON('/api/git-heat');
    if (!g || !g.available) {
      btn.textContent = 'No git history';
      return;
    }
    gitHeat = g.counts;
    heatSource = 'git';
  }
  btn.textContent = heatSource === 'git' ? 'Heat: git, 90 days' : 'Heat: this session';
  btn.setAttribute('aria-pressed', String(heatSource === 'git'));
  applyHeat();
});
$('feed-toggle').addEventListener('click', (e) => {
  const closed = $('feed').classList.toggle('closed');
  e.target.textContent = closed ? 'Show activity' : 'Hide activity';
  e.target.setAttribute('aria-expanded', String(!closed));
});
$('insights-toggle').addEventListener('click', (e) => {
  insightsOn = !insightsOn;
  e.currentTarget.setAttribute('aria-pressed', String(insightsOn));
  if (insightsOn) loadInsights();
  else {
    insights = null;
    $('insights-legend').hidden = true;
    refreshOverlays();
  }
});
$('trail-toggle').addEventListener('click', (e) => {
  trailOn = !trailOn;
  e.currentTarget.setAttribute('aria-pressed', String(trailOn));
  refreshOverlays();
});
$('summary-open').addEventListener('click', () => openSummary());
$('search-open').addEventListener('click', () => search.open());

$('export-png').addEventListener('click', async () => {
  let blob;
  try { blob = await renderer.exportPNG(); } catch { return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${$('repo').textContent || 'repo'}-graph.png`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Theme: auto follows the system, remembered per browser like motion.
const THEME_KEY = 'node-code:theme';
const THEME_MODES = ['auto', 'light', 'dark'];
let themeMode = (() => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (THEME_MODES.includes(saved)) return saved;
  } catch { /* storage unavailable: use the default */ }
  return 'auto';
})();
const lightQuery = matchMedia('(prefers-color-scheme: light)');

function applyTheme() {
  const resolved = themeMode === 'auto' ? (lightQuery.matches ? 'light' : 'dark') : themeMode;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  renderer.setTheme(resolved);
  // Overlay colors come from the canvas palette so the legend matches the rings.
  for (const k of ['blast', 'path', 'cycles', 'hubs', 'orphans', 'trail']) root.style.setProperty(`--t-${k}`, THEMES[resolved][k]);
  $('theme-toggle').textContent = `Theme: ${themeMode}`;
}
$('theme-toggle').addEventListener('click', () => {
  themeMode = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
  try { localStorage.setItem(THEME_KEY, themeMode); } catch { /* not remembered */ }
  applyTheme();
});
lightQuery.addEventListener('change', () => { if (themeMode === 'auto') applyTheme(); });
applyTheme();

// Search ----------------------------------------------------------------
const search = new SearchBox($('search'), $('search-input'), $('search-title'), $('search-results'), {
  paths: () => tree.files.keys(),
  onPick: (path, mode) => {
    if (mode === 'path' && selected) showPath(selected, path);
    else jumpTo(path);
  },
});

// Ambient motion: on unless paused, remembered per browser. It also stops while
// the tab is hidden so the layout worker isn't computing for nobody.
const MOTION_KEY = 'node-code:motion';
let motionOn = (() => {
  try {
    const saved = localStorage.getItem(MOTION_KEY);
    if (saved !== null) return saved === 'on';
  } catch { /* storage unavailable: use the default */ }
  return !matchMedia('(prefers-reduced-motion: reduce)').matches;
})();

function applyMotion() {
  worker.postMessage({ type: 'motion', on: motionOn && !document.hidden });
  $('motion-toggle').textContent = motionOn ? 'Pause motion' : 'Resume motion';
}
$('motion-toggle').addEventListener('click', () => {
  motionOn = !motionOn;
  try { localStorage.setItem(MOTION_KEY, motionOn ? 'on' : 'off'); } catch { /* not remembered */ }
  applyMotion();
});
document.addEventListener('visibilitychange', applyMotion);
applyMotion();
addEventListener('keydown', (e) => {
  if (search.isOpen) {
    if (e.key === 'Escape') search.close();
    return;
  }
  const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]');
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey) {
    e.preventDefault();
    search.open();
  } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    search.open();
  } else if (e.key === 'Escape' && (selected || summaryOpen)) select(null);
});

// Pointer: pan, zoom, drag, hover, click --------------------------------
const tooltip = $('tooltip');
const CLICK_SLOP = 4;
let drag = null;

function nodeTitle(n) {
  if (n.kind === 'folder') return `${n.id === '.' ? $('repo').textContent : n.id} (${n.count.toLocaleString()} ${n.count === 1 ? 'file' : 'files'})`;
  if (n.kind === 'more') return `Show ${n.count.toLocaleString()} more files`;
  return n.id;
}

function setHover(n, x, y) {
  const id = n ? n.id : null;
  canvas.style.cursor = drag && drag.moved ? 'grabbing' : n ? 'pointer' : 'grab';
  if (renderer.hover !== id) { renderer.hover = id; renderer.invalidate(); }
  if (!n) { tooltip.hidden = true; return; }
  tooltip.hidden = false;
  tooltip.textContent = nodeTitle(n);
  const flip = x > innerWidth - 300;
  tooltip.style.left = flip ? 'auto' : `${x + 12}px`;
  tooltip.style.right = flip ? `${innerWidth - x + 12}px` : 'auto';
  tooltip.style.top = `${y + 12}px`;
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const n = renderer.nodeAt(e.clientX, e.clientY);
  drag = { node: n, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false };
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    setHover(renderer.nodeAt(e.clientX, e.clientY), e.clientX, e.clientY);
    return;
  }
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < CLICK_SLOP) return;
  drag.moved = true;
  tooltip.hidden = true;
  canvas.style.cursor = 'grabbing';
  if (drag.node) {
    const w = renderer.toWorld(e.clientX, e.clientY);
    worker.postMessage({ type: 'drag', id: drag.node.id, x: w.x, y: w.y });
    renderer.autoFit = false;
  } else renderer.panBy(e.clientX - drag.x, e.clientY - drag.y);
  drag.x = e.clientX;
  drag.y = e.clientY;
});

canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  const { node, moved } = drag;
  drag = null;
  if (moved) {
    if (node) worker.postMessage({ type: 'release', id: node.id });
    return;
  }
  if (!node) { if (selected) select(null); return; }
  if (node.kind === 'file') select(node.id === selected ? null : node.id);
  else if (node.kind === 'folder') {
    if (node.id !== '.') { tree.toggle(node.id); rebuildGraph(); }
  } else {
    tree.showMore(node.parent);
    rebuildGraph();
  }
});

// The system can cancel a pointer mid-drag (a gesture, switching apps); without
// this the node would stay pinned and the next move would keep dragging.
function cancelDrag() {
  if (!drag) return;
  if (drag.node && drag.moved) worker.postMessage({ type: 'release', id: drag.node.id });
  drag = null;
  canvas.style.cursor = 'grab';
}
canvas.addEventListener('pointercancel', cancelDrag);
canvas.addEventListener('lostpointercapture', cancelDrag);

canvas.addEventListener('pointerleave', () => setHover(null));

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // Pinch arrives as ctrl+wheel with small deltas; scale it up to feel the same.
  const speed = e.ctrlKey ? 0.012 : 0.0016;
  renderer.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * speed));
  tooltip.hidden = true;
}, { passive: false });

if (renderer.frameTimes) window.__nc = { renderer, tree, pulsePath, worker, rebuildGraph };
if (new URLSearchParams(location.search).has('perf')) window.__ncSeen = [];
