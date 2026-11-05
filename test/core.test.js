'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extract } = require('../server/hook-payload');
const { RepoIndex } = require('../server/repo-index');
const { normalize } = require('../server/normalize');
const { ActivityState } = require('../server/state');

const fixtures = fs.readFileSync(path.join(__dirname, 'fixtures/hook-payloads.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const find = (event, tool, pred = () => true) =>
  fixtures.find((p) => p.hook_event_name === event && p.tool_name === tool && pred(p));

function repo() {
  const index = new RepoIndex('/repo');
  for (const f of ['src/a.ts', 'src/b.py', 'n.ipynb']) index.add(f, { size: 1, mtimeMs: 1 });
  return index;
}
const norm = (raw, index = repo()) => normalize(extract(raw), index);

test('extract keeps no file content or tool output', () => {
  for (const raw of fixtures) {
    const text = JSON.stringify(extract(raw));
    assert.ok(!text.includes('export const a = 1'), raw.tool_name);
    assert.ok(!text.includes('def f(): pass'), raw.tool_name);
  }
});

test('extract truncates long Bash commands and errors', () => {
  const m = extract({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'x', cwd: '/repo',
    tool_input: { command: 'a'.repeat(5000) }, error: 'e'.repeat(5000), is_interrupt: true });
  assert.ok(m.command.length <= 300);
  assert.ok(m.error.length <= 300);
  assert.equal(m.interrupt, true);
});

test('extract reads NotebookEdit notebook_path as the file path', () => {
  const m = extract(find('PostToolUse', 'NotebookEdit'));
  assert.equal(m.filePath, '/repo/n.ipynb');
});

test('extract takes Glob matches from filenames', () => {
  assert.deepEqual(extract(find('PostToolUse', 'Glob')).matched, ['src/b.py']);
});

test('extract takes Grep content-mode matches from line prefixes', () => {
  assert.deepEqual(extract(find('PostToolUse', 'Grep')).matched, ['src/a.ts']);
});

test('extract caps matched files at 100', () => {
  const filenames = Array.from({ length: 500 }, (_, i) => `f${i}`);
  const m = extract({ hook_event_name: 'PostToolUse', tool_name: 'Glob', tool_input: {}, tool_response: { filenames } });
  assert.equal(m.matched.length, 100);
});

test('extract flags Write with type create', () => {
  assert.equal(extract(find('PostToolUse', 'Write')).created, true);
});

test('extract reads documented bashEditDiff fields', () => {
  const m = extract({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' },
    tool_response: { bashEditDiff: { changedFiles: ['/repo/a', '/repo/b'], files: [{ filePath: '/repo/b', created: true, hunks: [] }] } } });
  assert.deepEqual(m.changed, { files: ['/repo/a', '/repo/b'], created: ['/repo/b'] });
});

test('a Write whose content looks like grep output sends no fragments of it', () => {
  const m = extract({ hook_event_name: 'PostToolUse', tool_name: 'Write', cwd: '/repo', tool_input: { file_path: '/repo/x' },
    tool_response: { type: 'create', content: 'API_KEY:12345\nhost:8080:secret' } });
  assert.equal(m.matched, undefined);
  assert.ok(!JSON.stringify(m).includes('API_KEY'));
});

test('Grep content lines that are not real paths are dropped when existence can be checked', () => {
  const raw = { hook_event_name: 'PostToolUse', tool_name: 'Grep', cwd: '/repo', tool_input: { pattern: 'x' },
    tool_response: { mode: 'content', filenames: [], content: 'API_KEY:12345\nsrc/a.ts:1:x' } };
  const m = extract(raw, { pathExists: (p) => p === '/repo/src/a.ts' });
  assert.deepEqual(m.matched, ['src/a.ts']);
});

test('Pre Read pulses the file as reading without counting', () => {
  const ev = norm(find('PreToolUse', 'Read'));
  assert.equal(ev.phase, 'start');
  assert.deepEqual(ev.targets, [{ path: 'src/a.ts', action: 'read', heat: true }]);
  assert.equal(ev.label, 'src/a.ts');
});

test('Post Write to a new file is a create action', () => {
  const index = repo();
  index.add('src/new.ts', { size: 1, mtimeMs: 1 });
  const ev = norm(find('PostToolUse', 'Write'), index);
  assert.deepEqual(ev.targets, [{ path: 'src/new.ts', action: 'create', heat: true }]);
});

test('Pre Write to a not-yet-existing file targets its parent folder without heat', () => {
  const ev = norm(find('PreToolUse', 'Write'));
  assert.deepEqual(ev.targets, [{ path: 'src', action: 'edit', heat: false }]);
  assert.equal(ev.label, 'src/new.ts');
});

test('Grep targets its folder and matched files, adding no heat', () => {
  const ev = norm(find('PostToolUse', 'Grep'));
  assert.deepEqual(ev.targets, [
    { path: 'src', action: 'read', heat: false },
    { path: 'src/a.ts', action: 'read', heat: false },
  ]);
  assert.match(ev.label, /export/);
});

test('Glob resolves relative matches against cwd', () => {
  const ev = norm(find('PostToolUse', 'Glob'));
  assert.deepEqual(ev.targets.map((t) => t.path), ['src/b.py']);
});

test('read-only Bash lights known files without heat', () => {
  const ev = norm(find('PreToolUse', 'Bash', (p) => p.tool_input.command === 'cat src/b.py'));
  assert.equal(ev.kind, 'bash');
  assert.deepEqual(ev.targets, [{ path: 'src/b.py', action: 'read', heat: false }]);
});

test('mutating Bash never reports a read', () => {
  const raw = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/repo', tool_use_id: 'r', tool_input: { command: 'rm src/a.ts' } };
  assert.deepEqual(norm(raw).targets, []);
});

test('read-only Bash with output redirection reports nothing', () => {
  const raw = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/repo', tool_use_id: 'r', tool_input: { command: 'cat src/a.ts > src/b.py' } };
  assert.deepEqual(norm(raw).targets, []);
});

test('Bash bashEditDiff changed files become edit targets', () => {
  const raw = { hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: '/repo', tool_use_id: 'r', tool_input: { command: 'x' },
    tool_response: { bashEditDiff: { changedFiles: ['/repo/src/a.ts'] } } };
  assert.deepEqual(norm(raw).targets, [{ path: 'src/a.ts', action: 'edit', heat: true }]);
});

test('paths outside the repo produce a feed-only event', () => {
  const raw = { hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: '/repo', tool_use_id: 'o', tool_input: { file_path: '/etc/hosts' } };
  const ev = norm(raw);
  assert.deepEqual(ev.targets, []);
  assert.equal(ev.label, '/etc/hosts');
});

test('case-insensitive filesystem path maps to the canonical node', () => {
  const raw = { hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: '/repo', tool_use_id: 'c', tool_input: { file_path: '/repo/SRC/A.ts' } };
  assert.equal(norm(raw).targets[0].path, 'src/a.ts');
});

test('failure events map to the fail phase, interrupts to interrupt', () => {
  assert.equal(norm(find('PostToolUseFailure', 'Read', () => true)).phase, 'fail');
  const raw = { ...find('PostToolUseFailure', 'Bash'), is_interrupt: true };
  assert.equal(norm(raw).phase, 'interrupt');
});

test('subagent calls carry the agent id', () => {
  assert.ok(norm(find('PreToolUse', 'Read', (p) => p.agent_id)).agent);
});

function ev(over) {
  return { id: 't1', phase: 'start', tool: 'Read', kind: 'read', session: 's', label: 'src/a.ts',
    targets: [{ path: 'src/a.ts', action: 'read', heat: true }], ...over };
}

test('Pre then Post counts one read and finishes the feed entry', () => {
  const s = new ActivityState();
  const a = s.apply(ev(), 100);
  assert.equal(a.entry.verb, 'Reading');
  assert.deepEqual(a.pulses, [{ path: 'src/a.ts', status: 'reading' }]);
  assert.equal(s.stats('src/a.ts'), undefined);
  const b = s.apply(ev({ phase: 'end' }), 200);
  assert.equal(b.entry.verb, 'Read');
  assert.equal(b.entry.pending, false);
  assert.equal(s.stats('src/a.ts').reads, 1);
  assert.equal(s.stats('src/a.ts').last, 200);
  assert.equal(s.snapshot().feed.length, 1);
});

test('a Pre arriving after its Post is ignored', () => {
  const s = new ActivityState();
  s.apply(ev({ phase: 'end' }), 200);
  assert.equal(s.apply(ev(), 210), null);
  assert.equal(s.stats('src/a.ts').reads, 1);
  assert.equal(s.snapshot().feed[0].verb, 'Read');
});

test('a duplicate Post does not count twice', () => {
  const s = new ActivityState();
  s.apply(ev({ phase: 'end' }), 200);
  assert.equal(s.apply(ev({ phase: 'end' }), 210), null);
  assert.equal(s.stats('src/a.ts').reads, 1);
});

test('edit and create use their own status colors', () => {
  const s = new ActivityState();
  const e = s.apply(ev({ id: 'e', tool: 'Edit', kind: 'edit', phase: 'end', targets: [{ path: 'f', action: 'edit', heat: true }] }), 1);
  assert.equal(e.entry.verb, 'Edited');
  assert.equal(e.pulses[0].status, 'editing');
  const c = s.apply(ev({ id: 'c', tool: 'Write', kind: 'edit', phase: 'end', targets: [{ path: 'g', action: 'create', heat: true }] }), 2);
  assert.equal(c.entry.verb, 'Created');
  assert.equal(c.pulses[0].status, 'created');
  assert.equal(s.stats('g').edits, 1);
});

test('failed calls pulse failed and do not count as reads', () => {
  const s = new ActivityState();
  const f = s.apply(ev({ phase: 'fail', error: 'nope' }), 5);
  assert.equal(f.entry.status, 'failed');
  assert.equal(f.entry.verb, 'Failed');
  assert.equal(f.pulses[0].status, 'failed');
  assert.equal(s.stats('src/a.ts').reads, 0);
  assert.equal(s.stats('src/a.ts').fails, 1);
});

test('interrupted calls return to idle without a failure', () => {
  const s = new ActivityState();
  s.apply(ev(), 1);
  const i = s.apply(ev({ phase: 'interrupt' }), 2);
  assert.equal(i.entry.status, 'idle');
  assert.deepEqual(i.pulses, []);
  assert.equal(s.stats('src/a.ts'), undefined);
});

test('heat false targets pulse but leave heat untouched', () => {
  const s = new ActivityState();
  s.apply(ev({ phase: 'end', targets: [{ path: 'f', action: 'read', heat: false }] }), 1);
  assert.equal(s.stats('f'), undefined);
});

test('a denied call with no Post expires, and a late Post still resolves it', () => {
  const s = new ActivityState({ pendingTtlMs: 1000 });
  s.apply(ev(), 0);
  assert.deepEqual(s.sweep(500), []);
  const [expired] = s.sweep(1500);
  assert.equal(expired.pending, false);
  assert.equal(expired.verb, 'Did not finish');
  assert.deepEqual(s.sweep(3000), []);
  assert.equal(s.apply(ev({ phase: 'end' }), 4000).entry.verb, 'Read');
  assert.equal(s.stats('src/a.ts').reads, 1);
});

test('attribute adds rescan-found changes to a finished Bash entry', () => {
  const s = new ActivityState();
  s.apply(ev({ id: 'b', tool: 'Bash', kind: 'bash', phase: 'end', label: 'touch x', targets: [] }), 1);
  const out = s.attribute('b', { edited: ['a'], created: ['x'] }, 2);
  assert.deepEqual(out.pulses, [{ path: 'a', status: 'editing' }, { path: 'x', status: 'created' }]);
  assert.equal(s.stats('a').edits, 1);
  assert.deepEqual(out.entry.paths, ['a', 'x']);
  assert.equal(out.entry.status, 'created');
});

test('attribute skips files Bash already counted through bashEditDiff', () => {
  const s = new ActivityState();
  s.apply(ev({ id: 'b', tool: 'Bash', kind: 'bash', phase: 'end', targets: [{ path: 'a', action: 'edit', heat: true }] }), 1);
  assert.equal(s.attribute('b', { edited: ['a'], created: [] }, 2), null);
  assert.equal(s.stats('a').edits, 1);
});

test('resetHeat zeroes heat but keeps session stats', () => {
  const s = new ActivityState();
  s.apply(ev({ phase: 'end' }), 1);
  assert.equal(s.stats('src/a.ts').heat, 1);
  s.resetHeat();
  assert.equal(s.stats('src/a.ts').heat, 0);
  assert.equal(s.stats('src/a.ts').reads, 1);
});

test('feed and call history stay bounded', () => {
  const s = new ActivityState({ maxFeed: 10, maxCalls: 20 });
  for (let i = 0; i < 100; i++) s.apply(ev({ id: `i${i}`, phase: 'end' }), i);
  assert.equal(s.snapshot().feed.length, 10);
  assert.equal(s.snapshot().feed.at(-1).id, 'i99');
});
