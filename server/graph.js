'use strict';
// Pure analysis over the import graph built in App.onIndexed: deps maps a file
// to its parse record ({imports: [{targets}]}), importedBy maps a file to the
// Set of files importing it.
const { isTestFile } = require('./related');

const MAX_DEPENDENTS = 2000;
const TOP_HUBS = 15;

function importsOf(deps, rel) {
  const out = new Set();
  for (const { targets } of deps.get(rel)?.imports || []) for (const t of targets) out.add(t);
  return out;
}

// Everything that imports rel directly (depth 1) or through other files.
function dependents(rel, importedBy, max = MAX_DEPENDENTS) {
  const seen = new Set([rel]);
  const out = [];
  let frontier = [rel];
  for (let depth = 1; frontier.length; depth++) {
    const next = [];
    for (const f of frontier) {
      for (const p of importedBy.get(f) || []) {
        if (seen.has(p)) continue;
        if (out.length >= max) return { dependents: out, truncated: true };
        seen.add(p);
        out.push({ path: p, depth });
        next.push(p);
      }
    }
    frontier = next;
  }
  return { dependents: out, truncated: false };
}

// Shortest chain between two files following import edges either way. Each hop
// says whether the previous file imports it or is imported by it.
function shortestPath(from, to, deps, importedBy) {
  const prev = new Map([[from, null]]);
  let frontier = [from];
  while (frontier.length && !prev.has(to)) {
    const next = [];
    for (const f of frontier) {
      const hops = [
        ...[...importsOf(deps, f)].map((p) => [p, 'imports']),
        ...[...(importedBy.get(f) || [])].map((p) => [p, 'importedBy']),
      ];
      for (const [p, dir] of hops) {
        if (prev.has(p)) continue;
        prev.set(p, { from: f, dir });
        next.push(p);
      }
    }
    frontier = next;
  }
  if (!prev.has(to)) return null;
  const out = [];
  for (let p = to; p !== from; p = prev.get(p).from) out.unshift({ path: p, dir: prev.get(p).dir });
  out.unshift({ path: from, dir: null });
  return out;
}

// Tarjan's strongly connected components, iterative so a long import chain in a
// big repo cannot overflow the call stack. Only groups of 2+ files are cycles.
function cycles(deps) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  const visit = (v, work) => {
    index.set(v, index.size);
    low.set(v, index.get(v));
    stack.push(v);
    onStack.add(v);
    work.push({ v, edges: [...importsOf(deps, v)], i: 0 });
  };
  for (const start of deps.keys()) {
    if (index.has(start)) continue;
    const work = [];
    visit(start, work);
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.i < frame.edges.length) {
        const w = frame.edges[frame.i++];
        if (!index.has(w)) visit(w, work);
        else if (onStack.has(w)) low.set(frame.v, Math.min(low.get(frame.v), index.get(w)));
        continue;
      }
      work.pop();
      const { v } = frame;
      if (work.length) {
        const u = work[work.length - 1].v;
        low.set(u, Math.min(low.get(u), low.get(v)));
      }
      if (low.get(v) !== index.get(v)) continue;
      const scc = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1) out.push(scc.sort());
    }
  }
  return out.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

// files limits results to what is still in the index.
function insights(deps, importedBy, files) {
  const hubs = [...importedBy]
    .filter(([p, by]) => files.has(p) && by.size)
    .map(([p, by]) => ({ path: p, count: by.size }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, TOP_HUBS);
  // Only parsed files are in deps, so a file in an unsupported language is
  // never reported as an orphan.
  const orphans = [...deps.keys()]
    .filter((p) => files.has(p) && !isTestFile(p) && !importsOf(deps, p).size && !importedBy.get(p)?.size)
    .sort();
  return { cycles: cycles(deps), hubs, orphans };
}

module.exports = { dependents, shortestPath, cycles, insights };
