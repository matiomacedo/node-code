// Force layout off the main thread, so a hot simulation cannot drop frames.
importScripts('/vendor/d3-dispatch.min.js', '/vendor/d3-quadtree.min.js', '/vendor/d3-timer.min.js', '/vendor/d3-force.min.js', '/flow.js');
/* global d3, flowAt */

const known = new Map();
let nodes = [];
let gen = 0;
let running = false;
let motion = false;
let lastFlowAt = 0;

// Ambient motion. A warm simulation alone sits at equilibrium, so a smooth
// field that changes over time (web/flow.js) nudges nodes; nearby nodes get
// similar nudges and drift together. The other forces keep the shape.
const WARM_ALPHA = 0.03;
const HOT_ALPHA = 0.06; // Above this the layout is still settling, not just flowing.
const FLOW_PER_SECOND = 3.4; // Velocity added per second of real time.
const HOT_TICK_MS = 8;
const AMBIENT_TICK_MS = 33; // About 30 updates a second is smooth for slow drift.

function flow() {
  if (!motion) return;
  const now = performance.now();
  // Scaled by real elapsed time, so the drift speed is the same at any tick rate.
  const dt = Math.min(0.1, (now - (lastFlowAt || now)) / 1000);
  lastFlowAt = now;
  const strength = FLOW_PER_SECOND * dt;
  for (const n of nodes) {
    if (n.fx != null) continue;
    const [fx, fy] = flowAt(n.x, n.y, now / 1000, n.seed);
    n.vx += strength * fx;
    n.vy += strength * fy;
  }
}

const linkForce = d3.forceLink().id((n) => n.id)
  .distance((l) => (l.target.kind === 'folder' ? 44 + 22 * Math.min(l.target.fan, 8) / 8 : 16 + Math.min(l.source.fan, 40) * 0.45))
  .strength((l) => (l.target.kind === 'folder' ? 0.5 : 0.9));
const sim = d3.forceSimulation()
  .stop()
  .alphaDecay(0.022)
  .velocityDecay(0.42)
  .force('charge', d3.forceManyBody().theta(0.95).distanceMax(420)
    .strength((n) => (n.kind === 'folder' ? -130 : -16)))
  .force('link', linkForce)
  .force('collide', d3.forceCollide((n) => n.r + 1.5).iterations(1))
  .force('x', d3.forceX(0).strength(0.022))
  .force('y', d3.forceY(0).strength(0.022))
  .force('flow', flow);

function seed(node, parent) {
  if (!parent) { node.x = 0; node.y = 0; return; }
  // New folders grow outward from their grandparent, which avoids most tangles.
  const grand = known.get(parent.parentId);
  let dx = grand ? parent.x - grand.x : 0;
  let dy = grand ? parent.y - grand.y : 0;
  const len = Math.hypot(dx, dy) || 1;
  const angle = Math.random() * Math.PI * 2;
  const reach = node.kind === 'folder' ? 40 : 14;
  dx = dx / len * 0.8 + Math.cos(angle);
  dy = dy / len * 0.8 + Math.sin(angle);
  node.x = parent.x + dx * reach;
  node.y = parent.y + dy * reach;
}

function post(idle) {
  const pos = new Float32Array(nodes.length * 2);
  for (let i = 0; i < nodes.length; i++) {
    pos[i * 2] = nodes[i].x;
    pos[i * 2 + 1] = nodes[i].y;
  }
  self.postMessage({ gen, pos, idle, alpha: sim.alpha() }, [pos.buffer]);
}

function loop() {
  if (!motion && sim.alpha() < sim.alphaMin()) {
    running = false;
    post(true);
    return;
  }
  sim.tick();
  post(false);
  setTimeout(loop, motion && sim.alpha() < HOT_ALPHA ? AMBIENT_TICK_MS : HOT_TICK_MS);
}

function kick(alpha) {
  sim.alpha(Math.max(sim.alpha(), alpha));
  if (!running) { running = true; loop(); }
}

function setGraph(msg) {
  gen = msg.gen;
  const next = new Map();
  let added = 0;
  nodes = msg.nodes.map((n) => {
    let node = known.get(n.id);
    if (!node) {
      // A small per-node offset keeps the flow from moving whole groups in lockstep.
      node = { id: n.id, seed: Math.random() * 0.8 };
      added++;
    }
    node.kind = n.kind;
    node.r = n.r;
    node.fan = n.fan;
    node.parentId = n.parent;
    next.set(n.id, node);
    if (node.x === undefined) {
      known.set(n.id, node);
      seed(node, n.parent === null ? null : known.get(n.parent));
    }
    return node;
  });
  known.clear();
  for (const [k, v] of next) known.set(k, v);
  sim.nodes(nodes);
  linkForce.links(msg.links.map(([s, t]) => ({ source: nodes[s], target: nodes[t] })));
  // A full layout is hot; one new file only nudges its neighbourhood.
  const fresh = msg.first ? 1 : Math.min(0.28, 0.06 + added * 0.004);
  if (added || msg.first) kick(fresh);
  else if (!running) post(sim.alpha() < sim.alphaMin());
}

const byId = (id) => known.get(id);

self.onmessage = ({ data: m }) => {
  if (m.type === 'graph') setGraph(m);
  else if (m.type === 'drag') {
    const n = byId(m.id);
    if (!n) return;
    n.fx = m.x;
    n.fy = m.y;
    kick(0.12);
  } else if (m.type === 'motion') {
    motion = m.on;
    lastFlowAt = 0;
    sim.alphaTarget(motion ? WARM_ALPHA : 0);
    if (motion) kick(WARM_ALPHA);
  } else if (m.type === 'release') {
    const n = byId(m.id);
    if (n) { n.fx = null; n.fy = null; }
  }
};
