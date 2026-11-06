#!/usr/bin/env node
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const registry = require('./registry');
const { RepoIndex } = require('./repo-index');
const { normalize } = require('./normalize');
const { ActivityState } = require('./state');
const { scanRepo, diffScans, acceptsFile, statFile } = require('./scan');
const { createHandler } = require('./routes');
const { relatedTests } = require('./related');
const { readSource, git } = require('./source');
const graph = require('./graph');
const { languageOf } = require('../parsers/registry');
const { version } = require('../package.json');

const HEARTBEAT_MS = 15000;
const SWEEP_MS = 5000;
const POLL_MS = 30000;
const RESCAN_DEBOUNCE_MS = 150;
const INDEX_DEBOUNCE_MS = 100;
const IDLE_CHECK_MS = 60000;
const IDLE_EXIT_MS = 30 * 60 * 1000;
const BULK_CHANGE = 200; // Above this (a branch switch, say) send a fresh snapshot, not deltas.
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const GIT_HEAT_TIMEOUT_MS = 15000;
const GIT_HEAT_MAX_BUFFER = 32 * 1024 * 1024;
const GIT_HEAT_ARGS = ['-c', 'core.quotepath=false', 'log', '--since=90.days', '--max-count=500', '--name-only', '--relative', '--format='];

class App {
  constructor(root, dataDir) {
    this.root = root;
    this.dataDir = dataDir;
    this.index = new RepoIndex(root);
    this.state = new ActivityState();
    this.clients = new Set();
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.sniffed = new Map();
    this.deps = new Map();
    this.importedBy = new Map();
    this.indexing = true;
    this.pendingSync = { added: [], removed: [], changed: [] };
    this.scanning = false;
    this.scanAgain = false;
    this.lastBash = null;
    this.truncated = false;
    this.ready = false;
    this.changedDuringScan = new Set();
    this.scan = (opts) => scanRepo(root, opts);
  }

  // The server is already listening while this runs, so a slow first scan never
  // looks like a dead server to /codebase-map.
  async init() {
    this.worker = new Worker(path.join(__dirname, 'indexer.worker.js'), { workerData: { root: this.root } });
    this.worker.on('message', (records) => this.onIndexed(records));
    this.worker.on('error', (err) => console.error('indexer', err));
    const { files, truncated } = await this.scan({ sniffed: this.sniffed });
    this.truncated = truncated;
    for (const [rel, meta] of files) this.index.add(rel, meta);
    this.worker.postMessage({ added: [...files.keys()] });
    this.ready = true;
    this.broadcast('snapshot', this.snapshot());
  }

  // Adds or updates a file in the index outside a scan. A scan already running
  // will not see the change, so applyScan must leave this path alone.
  indexFile(rel, meta) {
    if (this.scanning) this.changedDuringScan.add(rel);
    return this.index.add(rel, meta);
  }

  onIndexed(records) {
    this.deps = new Map(Object.entries(records));
    const importedBy = new Map();
    for (const [rel, rec] of this.deps) {
      for (const { targets } of rec.imports) {
        for (const t of targets) {
          if (!importedBy.has(t)) importedBy.set(t, new Set());
          importedBy.get(t).add(rel);
        }
      }
    }
    this.importedBy = importedBy;
    this.insightsCache = null;
    this.indexing = false;
    this.broadcast('index', { ready: true });
  }

  queueSync(kind, rel) {
    this.pendingSync[kind].push(rel);
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      const work = this.pendingSync;
      this.pendingSync = { added: [], removed: [], changed: [] };
      this.worker.postMessage(work);
    }, INDEX_DEBOUNCE_MS);
  }

  async onHook(msg, hookAt) {
    this.lastActivity = Date.now();
    const finished = msg.event === 'PostToolUse';
    if (finished && FILE_TOOLS.has(msg.tool) && msg.filePath) await this.refreshFile(msg.filePath, msg.cwd);
    if (finished && msg.changed) {
      for (const f of msg.changed.files) await this.refreshFile(f, msg.cwd);
    }
    const out = this.state.apply(normalize(msg, this.index), Date.now());
    if (out) this.publish(out, hookAt);
    if (msg.tool === 'Bash' && msg.event !== 'PreToolUse' && this.ready) {
      this.lastBash = msg.id;
      this.scheduleRescan();
    }
  }

  publish({ entry, pulses, touched, event, alerts = [] }, hookAt) {
    const stats = {};
    for (const p of touched) stats[p] = this.state.stats(p);
    // Before the first index the dependents would all read as zero.
    // Counted for the file this call changed, not whatever it listed first:
    // a Bash call may have read one file and edited another.
    const changed = pulses.find((p) => p.status === 'editing' || p.status === 'created');
    if (!this.indexing && changed) entry.impact = graph.dependents(changed.path, this.importedBy).dependents.length;
    // event is the history record, so pages extend their copy without refetching it.
    this.broadcast('activity', { entry, pulses, stats, hookAt, event });
    for (const a of alerts) this.broadcast('alert', a);
  }

  // Keeps the node for a file Claude just changed in sync, creating it if needed.
  async refreshFile(file, cwd) {
    const { rel, kind } = this.index.resolve(file, cwd);
    if (rel === null) return;
    if (kind === 'file') {
      const meta = await statFile(this.root, rel, this.sniffed);
      if (meta) {
        this.indexFile(rel, meta);
        this.queueSync('changed', rel);
      }
      return;
    }
    if (kind === 'dir' || !(await acceptsFile(this.root, rel))) return;
    const meta = await statFile(this.root, rel, this.sniffed);
    if (meta && this.indexFile(rel, meta)) {
      this.queueSync('added', rel);
      if (this.ready) this.broadcast('tree', { added: [[rel, meta.size]], removed: [] });
    }
  }

  scheduleRescan() {
    clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => this.rescan(), RESCAN_DEBOUNCE_MS);
  }

  async rescan() {
    if (!this.ready) return; // The first scan is still running and covers this.
    if (this.scanning) { this.scanAgain = true; return; }
    this.scanning = true;
    this.changedDuringScan.clear();
    const bashId = this.lastBash;
    this.lastBash = null;
    try {
      const { files, truncated } = await this.scan({ sniffed: this.sniffed });
      this.truncated = truncated;
      this.applyScan(files, bashId, truncated);
    } catch (err) {
      console.error('rescan', err);
    } finally {
      this.scanning = false;
      if (this.scanAgain) { this.scanAgain = false; this.scheduleRescan(); }
    }
  }

  applyScan(files, bashId, truncated = false) {
    const fresh = (rel) => !this.changedDuringScan.has(rel);
    // A capped scan omits files past the cap, so absence alone does not mean deleted.
    const gone = (rel) => !truncated || !fs.existsSync(path.join(this.root, rel));
    const diff = diffScans(this.index.files, files);
    const added = diff.added.filter(fresh);
    const removed = diff.removed.filter(fresh).filter(gone);
    const modified = diff.modified.filter(fresh);
    if (!added.length && !removed.length && !modified.length) return;
    for (const rel of removed) {
      this.index.remove(rel);
      this.sniffed.delete(rel);
      this.queueSync('removed', rel);
    }
    for (const rel of [...added, ...modified]) this.index.add(rel, files.get(rel));
    for (const rel of added) this.queueSync('added', rel);
    for (const rel of modified) this.queueSync('changed', rel);

    // A branch switch can modify thousands of files without adding any; that is
    // not Claude editing them, so large changes are never credited to a call.
    const treeChanges = added.length + removed.length;
    if (treeChanges > BULK_CHANGE) this.broadcast('snapshot', this.snapshot());
    else if (treeChanges) {
      this.broadcast('tree', { added: added.map((rel) => [rel, files.get(rel).size]), removed });
    }
    if (bashId && treeChanges + modified.length <= BULK_CHANGE) {
      const out = this.state.attribute(bashId, { edited: modified, created: added }, Date.now());
      if (out) this.publish(out);
    }
  }

  snapshot() {
    return {
      repo: path.basename(this.root),
      startedAt: this.startedAt,
      now: Date.now(),
      files: [...this.index.files].map(([rel, m]) => [rel, m.size]),
      indexing: this.indexing,
      truncated: this.truncated,
      ...this.state.snapshot(),
    };
  }

  // id is looked up in the index and never used to build a filesystem path.
  fileDetail(id) {
    const meta = this.index.files.get(id);
    if (!meta) return null;
    const dep = this.deps.get(id);
    return {
      path: id,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      language: languageOf(id),
      imports: dep?.imports || [],
      importedBy: [...(this.importedBy.get(id) || [])].sort(),
      exports: dep?.exports || [],
      symbols: dep?.symbols || [],
      tests: relatedTests(id, this.index.files.keys()),
      stats: this.state.stats(id) || null,
      indexing: this.indexing,
    };
  }

  // Same rule as fileDetail: id must be a known file; the path comes from the index.
  async fileSource(id) {
    if (!this.index.files.has(id)) return null;
    try { return await readSource(this.root, id); } catch { return null; }
  }

  history() {
    const events = this.state.history;
    const distinct = (key) => [...new Set(events.map((e) => e[key]).filter(Boolean))];
    return { startedAt: this.startedAt, events, sessions: distinct('session'), agents: distinct('agent') };
  }

  // Ids below are looked up in the index and never used to build a path.
  blast(id) {
    if (!this.index.files.has(id)) return null;
    return { path: id, ...graph.dependents(id, this.importedBy) };
  }

  pathBetween(from, to) {
    if (!this.index.files.has(from) || !this.index.files.has(to)) return null;
    return { path: graph.shortestPath(from, to, this.deps, this.importedBy) };
  }

  insights() {
    this.insightsCache ??= graph.insights(this.deps, this.importedBy, this.index.files);
    return { ...this.insightsCache, indexing: this.indexing };
  }

  summary(session) {
    return this.state.summary(session || null, this.importedBy);
  }

  // Commit counts per indexed file over recent history; unavailable outside git.
  async gitHeat() {
    // A busy repo's log of names can pass the panel's diff limits, so it gets its own.
    const out = await git(this.root, GIT_HEAT_ARGS, { timeout: GIT_HEAT_TIMEOUT_MS, maxBuffer: GIT_HEAT_MAX_BUFFER });
    if (out === null) return { available: false, since: '90 days', counts: {} };
    const counts = {};
    for (const line of out.split('\n')) {
      if (this.index.files.has(line)) counts[line] = (counts[line] || 0) + 1;
    }
    return { available: true, since: '90 days', counts };
  }

  resetHeat() {
    this.state.resetHeat();
    this.broadcast('heat-reset', {});
  }

  addClient(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    this.clients.add(res);
    req.on('close', () => { this.clients.delete(res); this.lastActivity = Date.now(); });
    if (this.ready) this.sendTo(res, 'snapshot', this.snapshot()); // Otherwise init sends it.
  }

  sendTo(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event, data) {
    for (const res of this.clients) this.sendTo(res, event, data);
  }

  health() {
    return { root: this.root, version, clients: this.clients.size, pid: process.pid, files: this.index.files.size, ready: this.ready };
  }

  startTimers() {
    const every = (ms, fn) => setInterval(fn, ms).unref();
    every(HEARTBEAT_MS, () => { for (const res of this.clients) res.write(': ping\n\n'); });
    every(SWEEP_MS, () => {
      for (const entry of this.state.sweep(Date.now())) this.broadcast('activity', { entry, pulses: [], stats: {} });
    });
    // Catches background Bash work and changes made outside Claude.
    every(POLL_MS, () => { if (this.clients.size) this.rescan(); });
    every(IDLE_CHECK_MS, () => {
      // A newer server took over this repo, so no hooks will reach this one.
      if (registry.read(this.dataDir, this.root)?.pid !== process.pid) this.shutdown();
      else if (!this.clients.size && Date.now() - this.lastActivity > IDLE_EXIT_MS) this.shutdown();
    });
  }

  shutdown() {
    registry.removeOwned(this.dataDir, this.root, process.pid);
    for (const res of this.clients) res.end();
    process.exit(0);
  }
}

async function main() {
  const argv = process.argv;
  const flag = (name) => argv[argv.indexOf(name) + 1];
  const root = flag('--root');
  const dataDir = flag('--data');
  const app = new App(root, dataDir);
  const tokens = { hookToken: crypto.randomBytes(24).toString('hex'), viewerToken: crypto.randomBytes(24).toString('hex') };
  const server = http.createServer(createHandler(app, tokens, path.join(__dirname, '../web')));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.shutdown());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  registry.write(dataDir, { root, port: server.address().port, pid: process.pid, version, ...tokens });
  app.startTimers();
  try {
    await app.init();
  } catch (err) {
    console.error('initial scan', err);
    app.shutdown();
  }
}

if (require.main === module) main().catch((err) => {
  console.error(err);
  process.exit(1);
});
module.exports = { App };
