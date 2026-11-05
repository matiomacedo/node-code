import { Tree } from '/tree.js';
import { Renderer } from '/render.js';
import { Feed } from '/feed.js';
import { Panel } from '/panel.js';

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
});
let detail = null;

async function loadDetail(id) {
  let res;
  try { res = await fetch(api(`/api/file?id=${encodeURIComponent(id)}`)); } catch { return; }
  if (selected !== id) return;
  if (!res.ok) { panel.showGone(id); detail = null; refreshDeps(); return; }
  detail = await res.json();
  if (selected !== id) return;
  panel.render(detail);
  refreshDeps();
}

function refreshDeps() {
  if (!selected) return;
  const targets = detail && detail.path === selected ? detail : null;
  const out = targets ? targets.imports.flatMap((i) => i.targets).map((t) => tree.nearestVisible(t)) : [];
  const incoming = targets ? targets.importedBy.map((t) => tree.nearestVisible(t)) : [];
  renderer.setSelection(selected, { out, in: incoming });
}

function select(id) {
  selected = id;
  detail = null;
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

function setStats(stats) {
  for (const [p, s] of Object.entries(stats)) tree.setHeat(p, s.heat);
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
  tree.clearHeat();
  setStats(d.touches);
  feed.reset(d.feed);
  rebuildGraph();
  if (selected) loadDetail(selected);
});

stream.addEventListener('tree', (e) => {
  const { added, removed } = JSON.parse(e.data);
  for (const [p, size] of added) tree.addFile(p, size);
  for (const p of removed) {
    tree.removeFile(p);
    if (selected === p) loadDetail(p);
  }
  rebuildGraph();
});

stream.addEventListener('activity', (e) => {
  const { entry, pulses, stats, hookAt } = JSON.parse(e.data);
  feed.upsert(entry);
  setStats(stats);
  for (const p of pulses) pulsePath(p.path, p.status);
  if (Object.keys(stats).length) renderer.invalidate();
  if (selected && (selected in stats || entry.paths.includes(selected))) loadDetail(selected);
  if (window.__ncSeen) window.__ncSeen.push({ id: entry.id, verb: entry.verb, pulses, at: Date.now(), hookAt });
});

stream.addEventListener('index', () => { if (selected) loadDetail(selected); });

stream.addEventListener('heat-reset', () => {
  tree.clearHeat();
  renderer.invalidate();
  if (selected) loadDetail(selected);
});

// Controls --------------------------------------------------------------
$('heat-toggle').addEventListener('click', (e) => {
  renderer.heatVisible = !renderer.heatVisible;
  e.target.textContent = renderer.heatVisible ? 'Hide heat' : 'Show heat';
  renderer.invalidate();
});
$('heat-reset').addEventListener('click', () => fetch(api('/api/heat/reset'), { method: 'POST' }));
$('feed-toggle').addEventListener('click', (e) => {
  const closed = $('feed').classList.toggle('closed');
  e.target.textContent = closed ? 'Show activity' : 'Hide activity';
  e.target.setAttribute('aria-expanded', String(!closed));
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
addEventListener('keydown', (e) => { if (e.key === 'Escape' && selected) select(null); });

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
