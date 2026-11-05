// Canvas 2D renderer. Glows are pre-rendered sprites because shadowBlur is far
// too slow at 2,000 nodes; every node is one or two drawImage calls.
const PULSE_MS = 1900;
const BORN_MS = 750;
const MAX_LABELS = 110;
const FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const SPRITE = 96;
const GLOW_RATIO = 3.2; // Sprite half-size relative to node radius.
const FIT_UNTIL_ALPHA = 0.06; // Stop auto-fitting once the first layout has cooled to this.
const GRID_SPAN = 1 << 16; // Grid cells per row in the numeric hit-grid key.

const COLORS = {
  folder: '#8d82d6', file: '#6283bd', more: '#5a5a78',
  reading: '#5cb6ff', editing: '#f2bb63', created: '#62dcab', failed: '#f26d80',
};
const IMPORTS = 'rgba(92,182,255,0.75)';
const IMPORTED_BY = 'rgba(192,140,240,0.75)';

function makeSprite(color, { core }) {
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE;
  const g = c.getContext('2d');
  const mid = SPRITE / 2;
  const coreR = mid / GLOW_RATIO;
  const glow = g.createRadialGradient(mid, mid, core ? coreR * 0.6 : 0, mid, mid, mid);
  glow.addColorStop(0, `${color}${core ? '55' : 'cc'}`);
  glow.addColorStop(0.45, `${color}${core ? '16' : '44'}`);
  glow.addColorStop(1, `${color}00`);
  g.fillStyle = glow;
  g.fillRect(0, 0, SPRITE, SPRITE);
  if (core) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(mid, mid, coreR, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.nodes = [];
    this.links = [];
    this.indexOf = new Map();
    this.pos = new Float32Array(0);
    this.cam = { x: 0, y: 0, k: 1 };
    this.autoFit = true;
    this.heatVisible = true;
    this.heatOf = () => 0;
    this.pulses = new Map();
    this.born = new Map();
    this.hover = null;
    this.selected = null;
    this.deps = { out: [], in: [] };
    this.neighbours = null;
    this.focus = null;
    this.simActive = false;
    this.dirty = true;
    this.frameRequested = false;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.sprites = {};
    for (const [name, color] of Object.entries(COLORS)) {
      this.sprites[name] = { core: makeSprite(color, { core: true }), glow: makeSprite(color, { core: false }) };
    }
    this.frameTimes = new URLSearchParams(location.search).has('perf') ? [] : null;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
    if (!this.frameRequested) {
      this.frameRequested = true;
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  // The node list and its positions change together when the worker confirms
  // the new generation, so indices can never point at the wrong node.
  applyPositions(graph, pos, idle, alpha = 0) {
    if (graph.nodes !== this.nodes) {
      this.nodes = graph.nodes;
      this.links = graph.links;
      this.indexOf = new Map(graph.nodes.map((n, i) => [n.id, i]));
      this.refreshNeighbours();
    }
    this.pos = pos;
    this.simActive = !idle;
    // With ambient motion the layout never fully stops, so the camera must stop
    // following it once it has cooled, or the view would drift forever.
    if (alpha < FIT_UNTIL_ALPHA) this.fitSettled = true;
    this.gridValid = false;
    this.invalidate();
  }

  radius(n) {
    const base = n.r;
    if (!this.heatVisible) return base;
    const h = this.heatOf(n.id);
    return h ? base * Math.min(2.6, 1 + 0.38 * Math.log2(1 + h)) : base;
  }

  pulse(id, status) {
    if (status === 'idle' || !this.indexOf.has(id)) return false;
    this.pulses.set(id, { status, t0: performance.now() });
    this.invalidate();
    return true;
  }

  markBorn(id) {
    if (!this.reducedMotion) this.born.set(id, performance.now());
  }

  setSelection(id, deps = { out: [], in: [] }) {
    this.selected = id;
    this.deps = deps;
    this.refreshNeighbours();
    this.invalidate();
  }

  refreshNeighbours() {
    if (!this.selected || !this.indexOf.has(this.selected)) { this.neighbours = null; return; }
    const set = new Set([this.selected, ...this.deps.out, ...this.deps.in]);
    const sel = this.indexOf.get(this.selected);
    for (const [s, t] of this.links) {
      if (s === sel) set.add(this.nodes[t].id);
      if (t === sel) set.add(this.nodes[s].id);
    }
    this.neighbours = set;
  }

  focusOn(id) {
    this.autoFit = false;
    const now = performance.now();
    // The node may not exist until the worker returns the new graph, so wait for
    // it a little before giving up.
    this.focus = { id, until: now + (this.reducedMotion ? 0 : 900), giveUpAt: now + 3000 };
    this.invalidate();
  }

  // Camera ---------------------------------------------------------------
  toWorld(sx, sy) {
    return { x: (sx - this.w / 2) / this.cam.k + this.cam.x, y: (sy - this.h / 2) / this.cam.k + this.cam.y };
  }

  toScreen(x, y) {
    return { x: (x - this.cam.x) * this.cam.k + this.w / 2, y: (y - this.cam.y) * this.cam.k + this.h / 2 };
  }

  panBy(dx, dy) {
    this.autoFit = false;
    this.focus = null;
    this.cam.x -= dx / this.cam.k;
    this.cam.y -= dy / this.cam.k;
    this.invalidate();
  }

  zoomAt(sx, sy, factor) {
    this.autoFit = false;
    this.focus = null;
    const before = this.toWorld(sx, sy);
    this.cam.k = Math.max(0.05, Math.min(8, this.cam.k * factor));
    const after = this.toWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.invalidate();
  }

  // Keeps the settling graph framed until the user takes over the camera.
  fitStep() {
    const n = this.nodes.length;
    if (!n || this.pos.length < n * 2) return;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = this.pos[i * 2]; const y = this.pos[i * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = 90;
    const availW = Math.max(100, this.w - 340 - pad * 2); // Leave the feed clear.
    const availH = Math.max(100, this.h - pad * 2);
    const k = Math.min(1.8, availW / Math.max(1, maxX - minX), availH / Math.max(1, maxY - minY));
    const cx = (minX + maxX) / 2 + 170 / k;
    const cy = (minY + maxY) / 2;
    const ease = this.reducedMotion ? 1 : 0.12;
    this.cam.k += (k - this.cam.k) * ease;
    this.cam.x += (cx - this.cam.x) * ease;
    this.cam.y += (cy - this.cam.y) * ease;
    this.fitting = Math.abs(k - this.cam.k) > 0.002 || Math.abs(cx - this.cam.x) > 0.3 || Math.abs(cy - this.cam.y) > 0.3;
  }

  focusStep(now) {
    const i = this.indexOf.get(this.focus.id);
    if (i === undefined) {
      if (now > this.focus.giveUpAt) this.focus = null;
      return;
    }
    if (now > this.focus.until) {
      this.centerNow(i);
      this.focus = null;
      return;
    }
    const k = Math.max(this.cam.k, 1.5);
    this.cam.k += (k - this.cam.k) * 0.14;
    this.cam.x += (this.pos[i * 2] - this.cam.x) * 0.14;
    this.cam.y += (this.pos[i * 2 + 1] - this.cam.y) * 0.14;
  }

  centerNow(i) {
    this.cam.x = this.pos[i * 2];
    this.cam.y = this.pos[i * 2 + 1];
    this.cam.k = Math.max(this.cam.k, 1.5);
  }

  // Hit testing ----------------------------------------------------------
  buildGrid() {
    const CELL = 32;
    this.grid = new Map();
    this.cell = CELL;
    for (let i = 0; i < this.nodes.length; i++) {
      const key = this.cellKey(Math.floor(this.pos[i * 2] / CELL), Math.floor(this.pos[i * 2 + 1] / CELL));
      let bucket = this.grid.get(key);
      if (!bucket) this.grid.set(key, (bucket = []));
      bucket.push(i);
    }
    this.gridValid = true;
  }

  cellKey(gx, gy) {
    return (gx + GRID_SPAN / 2) * GRID_SPAN + (gy + GRID_SPAN / 2);
  }

  nodeAt(sx, sy) {
    if (!this.gridValid) this.buildGrid();
    const { x, y } = this.toWorld(sx, sy);
    const slop = 6 / this.cam.k;
    const reach = Math.ceil((30 + slop) / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best = null;
    let bestD = Infinity;
    for (let gx = cx - reach; gx <= cx + reach; gx++) {
      for (let gy = cy - reach; gy <= cy + reach; gy++) {
        const bucket = this.grid.get(this.cellKey(gx, gy));
        if (!bucket) continue;
        for (const i of bucket) {
          const d = Math.hypot(this.pos[i * 2] - x, this.pos[i * 2 + 1] - y);
          const r = this.radius(this.nodes[i]) + slop;
          if (d < r && d < bestD) { best = this.nodes[i]; bestD = d; }
        }
      }
    }
    return best;
  }

  // Drawing --------------------------------------------------------------
  frame() {
    this.frameRequested = false;
    const started = performance.now();
    this.dirty = false;
    this.pruneBorn(started);
    if (this.focus) this.focusStep(started);
    else if (this.autoFit) {
      this.fitStep();
      if (this.fitSettled) this.autoFit = false;
    }
    this.draw(started);
    if (this.frameTimes) {
      this.frameTimes.push(performance.now() - started);
      if (this.frameTimes.length > 5000) this.frameTimes.shift();
    }
    // Layout updates request their own frame in applyPositions, so a running
    // simulation alone does not keep this loop spinning.
    const moving = this.pulses.size || this.born.size || this.focus || (this.autoFit && this.fitting);
    if (moving || this.dirty) this.invalidate();
  }

  // Runs before drawing, because culled or removed nodes are never drawn and
  // would otherwise keep the render loop alive forever.
  pruneBorn(now) {
    for (const [id, at] of this.born) {
      if (now - at >= BORN_MS || !this.indexOf.has(id)) this.born.delete(id);
    }
  }

  draw(now) {
    const { ctx, dpr, cam } = this;
    const n = this.nodes.length;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!n || this.pos.length < n * 2) return;

    const tx = dpr * (this.w / 2 - cam.x * cam.k);
    const ty = dpr * (this.h / 2 - cam.y * cam.k);
    ctx.setTransform(dpr * cam.k, 0, 0, dpr * cam.k, tx, ty);

    const view = this.worldViewport();
    this.drawEdges();
    this.drawDeps();
    this.drawNodes(now, view);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawLabels(now, view);
  }

  worldViewport() {
    const m = 60 / this.cam.k;
    const a = this.toWorld(0, 0);
    const b = this.toWorld(this.w, this.h);
    return { x0: a.x - m, y0: a.y - m, x1: b.x + m, y1: b.y + m };
  }

  drawEdges() {
    const { ctx, pos, links, cam } = this;
    ctx.lineWidth = 0.8 / Math.max(cam.k, 0.35);
    ctx.strokeStyle = this.neighbours ? 'rgba(140,140,190,0.07)' : 'rgba(140,140,190,0.19)';
    ctx.beginPath();
    for (let e = 0; e < links.length; e++) {
      const s = links[e][0] * 2;
      const t = links[e][1] * 2;
      const ax = pos[s]; const ay = pos[s + 1]; const bx = pos[t]; const by = pos[t + 1];
      // A slight bow; the sign alternates so sibling edges fan out rather than stack.
      const bow = e % 2 ? 0.1 : -0.1;
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo((ax + bx) / 2 - (by - ay) * bow, (ay + by) / 2 + (bx - ax) * bow, bx, by);
    }
    ctx.stroke();

    if (this.neighbours && this.indexOf.has(this.selected)) {
      const sel = this.indexOf.get(this.selected);
      ctx.strokeStyle = 'rgba(190,190,235,0.5)';
      ctx.beginPath();
      for (let e = 0; e < links.length; e++) {
        const [si, ti] = links[e];
        if (si !== sel && ti !== sel) continue;
        const bow = e % 2 ? 0.1 : -0.1;
        const ax = pos[si * 2]; const ay = pos[si * 2 + 1]; const bx = pos[ti * 2]; const by = pos[ti * 2 + 1];
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo((ax + bx) / 2 - (by - ay) * bow, (ay + by) / 2 + (bx - ax) * bow, bx, by);
      }
      ctx.stroke();
    }
  }

  // Dependency edges appear only for the selected node.
  drawDeps() {
    const sel = this.indexOf.get(this.selected);
    if (sel === undefined) return;
    const { ctx, pos, cam } = this;
    const sx = pos[sel * 2]; const sy = pos[sel * 2 + 1];
    ctx.lineWidth = 1.1 / Math.max(cam.k, 0.4);
    const line = (ids, color, bow) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const id of ids) {
        const i = this.indexOf.get(id);
        if (i === undefined || i === sel) continue;
        const bx = pos[i * 2]; const by = pos[i * 2 + 1];
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo((sx + bx) / 2 - (by - sy) * bow, (sy + by) / 2 + (bx - sx) * bow, bx, by);
      }
      ctx.stroke();
    };
    line(this.deps.out, IMPORTS, 0.16);
    line(this.deps.in, IMPORTED_BY, -0.16);
  }

  drawNodes(now, view) {
    const { ctx, nodes, pos, sprites } = this;
    const dimmed = this.neighbours;
    for (let i = 0; i < nodes.length; i++) {
      const x = pos[i * 2]; const y = pos[i * 2 + 1];
      if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) continue;
      const n = nodes[i];
      let r = this.radius(n);
      let alpha = dimmed && !dimmed.has(n.id) ? 0.22 : n.kind === 'folder' ? 0.95 : 0.8;

      const bornAt = this.born.get(n.id);
      if (bornAt !== undefined) {
        const eased = 1 - (1 - Math.min(1, (now - bornAt) / BORN_MS)) ** 3;
        r *= eased;
        alpha *= eased;
      }

      const set = sprites[n.kind];
      if (this.heatVisible) {
        const h = this.heatOf(n.id);
        if (h) {
          const R = r * GLOW_RATIO * 1.5;
          ctx.globalAlpha = Math.min(0.85, 0.16 + 0.17 * Math.log2(1 + h)) * (dimmed && !dimmed.has(n.id) ? 0.3 : 1);
          ctx.drawImage(set.glow, x - R, y - R, R * 2, R * 2);
        }
      }
      const R = r * GLOW_RATIO;
      ctx.globalAlpha = alpha;
      ctx.drawImage(set.core, x - R, y - R, R * 2, R * 2);
    }
    ctx.globalAlpha = 1;
    this.drawPulses(now);
    this.drawMarks();
  }

  drawPulses(now) {
    const { ctx, pos, sprites } = this;
    for (const [id, p] of this.pulses) {
      const i = this.indexOf.get(id);
      const t = (now - p.t0) / PULSE_MS;
      if (i === undefined || t >= 1) { this.pulses.delete(id); continue; }
      const x = pos[i * 2]; const y = pos[i * 2 + 1];
      // Small nodes still need a pulse that can be seen at fit zoom.
      const r = Math.max(this.radius(this.nodes[i]), 4.5 / this.cam.k);
      const rise = Math.min(1, t * 9);
      const fade = (1 - t) ** 2.2;
      const set = sprites[p.status];
      const G = r * GLOW_RATIO * (1.7 + 0.5 * Math.sin(t * Math.PI));
      ctx.globalAlpha = rise * fade;
      ctx.drawImage(set.glow, x - G, y - G, G * 2, G * 2);
      const C = r * GLOW_RATIO * 1.12;
      ctx.drawImage(set.core, x - C, y - C, C * 2, C * 2);
      if (!this.reducedMotion) {
        ctx.globalAlpha = 0.55 * (1 - t) ** 3;
        ctx.strokeStyle = COLORS[p.status];
        ctx.lineWidth = 1 / Math.max(this.cam.k, 0.5);
        ctx.beginPath();
        ctx.arc(x, y, r * (1.3 + t * 5), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  drawMarks() {
    const { ctx, pos, cam } = this;
    for (const [id, color] of [[this.selected, 'rgba(235,235,250,0.9)'], [this.hover, 'rgba(235,235,250,0.45)']]) {
      const i = this.indexOf.get(id);
      if (i === undefined) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1 / Math.max(cam.k, 0.5);
      ctx.beginPath();
      ctx.arc(pos[i * 2], pos[i * 2 + 1], this.radius(this.nodes[i]) + 3 / Math.max(cam.k, 0.6), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // The zoom at which a node earns a permanent label.
  labelZoom(n) {
    if (n.kind !== 'folder') return 1.9;
    return n.id.includes('/') ? 1.15 : 0.35;
  }

  // Labels stay off until zoomed in, and those that would collide are dropped.
  drawLabels(now, view) {
    const { ctx, nodes, pos, cam } = this;
    const taken = new Set();
    let drawn = 0;
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    const place = (i, color) => {
      const n = nodes[i];
      const s = this.toScreen(pos[i * 2], pos[i * 2 + 1]);
      const lx = s.x + this.radius(n) * cam.k + 5;
      const key0 = Math.floor(s.y / 13);
      const span = Math.ceil((n.name.length * 6) / 40);
      const col = Math.floor(lx / 40);
      for (let c = col; c <= col + span; c++) {
        if (taken.has(`${c},${key0}`)) return false;
      }
      for (let c = col; c <= col + span; c++) taken.add(`${c},${key0}`);
      ctx.fillStyle = color;
      ctx.fillText(n.name || this.rootName || '', lx, s.y);
      drawn++;
      return true;
    };
    for (const id of this.pulses.keys()) {
      const i = this.indexOf.get(id);
      if (i !== undefined) place(i, 'rgba(235,235,250,0.92)');
    }
    for (const id of [this.selected, ...this.deps.out, ...this.deps.in]) {
      const i = this.indexOf.get(id);
      if (i !== undefined && !this.pulses.has(id)) place(i, 'rgba(225,225,245,0.85)');
    }
    if (this.neighbours) return;
    for (let i = 0; i < nodes.length && drawn < MAX_LABELS; i++) {
      const n = nodes[i];
      if (cam.k < this.labelZoom(n) || this.pulses.has(n.id)) continue;
      const x = pos[i * 2]; const y = pos[i * 2 + 1];
      if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) continue;
      place(i, 'rgba(190,190,210,0.62)');
    }
  }
}
