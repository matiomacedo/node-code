'use strict';
// Payloads from other agents, mapped to Claude Code's shape and run through the
// same extract and normalize as Claude's own. Fixtures were captured from real
// sessions; see the header of each adapter for versions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extract } = require('../server/hook-payload');
const { RepoIndex } = require('../server/repo-index');
const { normalize } = require('../server/normalize');
const copilot = require('../adapters/copilot');
const opencode = require('../adapters/opencode');

const load = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));

function repo() {
  const index = new RepoIndex('/repo');
  for (const f of ['src/a.js', 'src/b.js', 'src/c.js']) index.add(f, { size: 1, mtimeMs: 1 });
  return index;
}
const exists = (p) => ['/repo/src/a.js', '/repo/src/b.js', '/repo/src/c.js'].includes(p);
const run = (adapter, raw) => {
  const mapped = adapter.toClaude(raw, { pathExists: exists });
  return mapped && normalize(extract(mapped, { pathExists: exists }), repo());
};
const paths = (ev) => ev.targets.map((t) => `${t.action} ${t.path}`).sort();

test('copilot', async (t) => {
  const fixtures = load('copilot-payloads.jsonl');
  const find = (event, tool, pred = () => true) =>
    fixtures.find((p) => p.hook_event_name === event && p.tool_name === tool && pred(p));
  const ev = (event, tool, pred) => run(copilot, find(event, tool, pred));

  await t.test('a Read pairs its start and end by tool_use_id and reads the file', () => {
    const start = ev('PreToolUse', 'Read');
    const end = ev('PostToolUse', 'Read');
    assert.equal(start.phase, 'start');
    assert.equal(end.phase, 'end');
    assert.equal(start.id, end.id);
    assert.equal(end.kind, 'read');
    assert.deepEqual(paths(end), ['read src/a.js']);
  });

  await t.test('a Grep finds matched files in output lines that have no line numbers', () => {
    const end = ev('PostToolUse', 'Grep');
    assert.equal(end.kind, 'search');
    assert.equal(end.label, '"foo" in .');
    assert.deepEqual(paths(end).filter((p) => p.endsWith('.js')), ['read src/a.js', 'read src/b.js']);
  });

  await t.test('a Glob finds matched files in its output lines', () => {
    const end = ev('PostToolUse', 'Glob');
    assert.deepEqual(paths(end).filter((p) => p.endsWith('.js')), ['read src/a.js', 'read src/b.js']);
  });

  await t.test('an Update File patch is an edit of that file', () => {
    const end = ev('PostToolUse', 'Edit', (p) => p.tool_input.includes('*** Update File'));
    assert.equal(end.kind, 'edit');
    assert.deepEqual(paths(end), ['edit src/a.js']);
  });

  await t.test('an Add File patch is a create of that file', () => {
    const end = ev('PostToolUse', 'Edit', (p) => p.tool_input.includes('*** Add File'));
    assert.deepEqual(paths(end), ['create src/c.js']);
  });

  await t.test('a patch lists every file it adds or updates as changed, so the server refreshes them all', () => {
    const raw = { ...find('PostToolUse', 'Edit'), tool_input:
      '*** Begin Patch\n*** Update File: /repo/src/a.js\n@@\n-x\n+y\n*** Add File: src/c.js\n+z\n*** Delete File: /repo/src/b.js\n*** End Patch\n' };
    const msg = extract(copilot.toClaude(raw));
    assert.equal(msg.filePath, '/repo/src/a.js');
    assert.deepEqual(msg.changed, { files: ['/repo/src/a.js', 'src/c.js'], created: ['src/c.js'] });
  });

  await t.test('a patch leaves deleted files out of the changed list', () => {
    const raw = { ...find('PostToolUse', 'Edit'), tool_input:
      '*** Begin Patch\n*** Delete File: /repo/src/b.js\n*** Update File: /repo/src/a.js\n@@\n-x\n+y\n*** End Patch\n' };
    const msg = extract(copilot.toClaude(raw));
    assert.equal(msg.filePath, '/repo/src/a.js');
    assert.deepEqual(msg.changed, { files: ['/repo/src/a.js'], created: [] });
  });

  await t.test('a patch that only deletes files targets nothing', () => {
    const raw = { ...find('PostToolUse', 'Edit'), tool_input: '*** Begin Patch\n*** Delete File: /repo/src/b.js\n*** End Patch\n' };
    assert.deepEqual(run(copilot, raw).targets, []);
  });

  await t.test('a patch that moves a file creates the new path', () => {
    const raw = { ...find('PostToolUse', 'Edit'), tool_input:
      '*** Begin Patch\n*** Update File: /repo/src/old.js\n*** Move to: /repo/src/c.js\n@@\n-x\n+y\n*** End Patch\n' };
    const msg = extract(copilot.toClaude(raw));
    assert.equal(msg.filePath, '/repo/src/c.js');
    assert.deepEqual(msg.changed, { files: ['/repo/src/c.js'], created: ['/repo/src/c.js'] });
  });

  await t.test('a patch whose result is not a success is not counted as changing files', () => {
    const raw = { ...find('PostToolUse', 'Edit'), tool_result: { result_type: 'failure', text_result_for_llm: 'rejected' } };
    assert.equal(extract(copilot.toClaude(raw)).changed, undefined);
  });

  await t.test('Glob output paths relative to the session cwd are matched', () => {
    const raw = { ...find('PostToolUse', 'Glob'), tool_result: { result_type: 'success', text_result_for_llm: 'src/a.js\nsrc/b.js' } };
    assert.deepEqual(paths(run(copilot, raw)).filter((p) => p.endsWith('.js')), ['read src/a.js', 'read src/b.js']);
  });

  await t.test('a large Grep checks each matched file once, not each output line', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `/repo/src/${i % 2 ? 'a' : 'b'}.js:line ${i}`);
    const raw = { ...find('PostToolUse', 'Grep'), tool_result: { result_type: 'success', text_result_for_llm: lines.join('\n') } };
    let checks = 0;
    const mapped = copilot.toClaude(raw, { pathExists: (p) => { checks += 1; return exists(p); } });
    assert.deepEqual(mapped.tool_response.filenames.sort(), ['/repo/src/a.js', '/repo/src/b.js']);
    assert.ok(checks <= 2, `${checks} existence checks`);
  });

  await t.test('a Grep line with a Windows drive letter keeps the whole path', () => {
    const raw = { ...find('PostToolUse', 'Grep'), tool_result: { result_type: 'success', text_result_for_llm: 'C:\\repo\\src\\a.js:export const foo' } };
    const mapped = copilot.toClaude(raw, { pathExists: (p) => p.endsWith('C:\\repo\\src\\a.js') });
    assert.deepEqual(mapped.tool_response.filenames, ['C:\\repo\\src\\a.js']);
  });

  await t.test('a Grep examines the first 5000 lines of output and no more', () => {
    const junk = Array.from({ length: 4999 }, (_, i) => `/repo/nowhere/${i}.js:x`);
    const lines = [...junk, '/repo/src/a.js:line 5000', '/repo/src/b.js:line 5001'];
    const raw = { ...find('PostToolUse', 'Grep'), tool_result: { result_type: 'success', text_result_for_llm: lines.join('\n') } };
    assert.deepEqual(copilot.toClaude(raw, { pathExists: exists }).tool_response.filenames, ['/repo/src/a.js']);
  });

  await t.test('a Glob result whose file name contains a colon is matched', () => {
    const raw = { ...find('PostToolUse', 'Glob'), tool_result: { result_type: 'success', text_result_for_llm: '/repo/src/a:b.js' } };
    const mapped = copilot.toClaude(raw, { pathExists: (p) => p === '/repo/src/a:b.js' });
    assert.deepEqual(mapped.tool_response.filenames, ['/repo/src/a:b.js']);
  });

  await t.test('a Glob line with a Windows drive letter is matched whole', () => {
    const raw = { ...find('PostToolUse', 'Glob'), tool_result: { result_type: 'success', text_result_for_llm: 'C:\\repo\\src\\a.js' } };
    const mapped = copilot.toClaude(raw, { pathExists: (p) => p.endsWith('C:\\repo\\src\\a.js') });
    assert.deepEqual(mapped.tool_response.filenames, ['C:\\repo\\src\\a.js']);
  });

  await t.test('a Grep given several paths searches in the first', () => {
    const raw = { ...find('PreToolUse', 'Grep'), tool_input: { pattern: 'foo', paths: ['/repo/src', '/repo/test'] } };
    assert.equal(run(copilot, raw).label, '"foo" in src');
  });

  await t.test('a Bash command that exits non-zero is a failure', () => {
    const end = ev('PostToolUse', 'Bash');
    assert.equal(end.kind, 'bash');
    assert.equal(end.phase, 'fail');
    assert.match(end.error, /exit code 1/);
    assert.equal(end.label, 'cat does-not-exist.txt');
  });

  await t.test('a Bash command that exits 0 is not a failure', () => {
    const raw = { ...find('PostToolUse', 'Bash'), tool_result: { result_type: 'success', text_result_for_llm: 'ok\n<shellId: 0 completed with exit code 0>' } };
    assert.equal(run(copilot, raw).phase, 'end');
  });

  await t.test('a failed Read is a failure with its error', () => {
    const end = ev('PostToolUseFailure', 'Read');
    assert.equal(end.phase, 'fail');
    assert.equal(end.error, 'Path does not exist');
  });

  await t.test('no file content or tool output survives', () => {
    for (const raw of fixtures) {
      const text = JSON.stringify(extract(copilot.toClaude(raw)));
      assert.ok(!text.includes('export const'), raw.tool_name);
    }
  });
});

test('opencode', async (t) => {
  const fixtures = load('opencode-payloads.jsonl');
  const find = (phase, tool, pred = () => true) =>
    fixtures.find((p) => p.phase === phase && p.event.tool === tool && pred(p.event));
  const ev = (phase, tool, pred) => run(opencode, find(phase, tool, pred));

  await t.test('a read pairs its start and end by id and reads the file', () => {
    const start = ev('before', 'read');
    const end = ev('after', 'read');
    assert.equal(start.phase, 'start');
    assert.equal(end.phase, 'end');
    assert.equal(start.id, end.id);
    assert.equal(start.session, 'ses_e4cef285fffeYgjn3pDaFU5es5');
    assert.equal(end.kind, 'read');
    assert.deepEqual(paths(end), ['read src/a.js']);
  });

  await t.test('a grep reads the files it matched', () => {
    const end = ev('after', 'grep');
    assert.equal(end.kind, 'search');
    assert.equal(end.label, '"foo"');
    assert.deepEqual(paths(end), ['read src/a.js', 'read src/b.js']);
  });

  await t.test('a glob reads the files it matched', () => {
    assert.deepEqual(paths(ev('after', 'glob')), ['read src/a.js', 'read src/b.js']);
  });

  await t.test('an edit is an edit of its file', () => {
    const end = ev('after', 'edit');
    assert.equal(end.kind, 'edit');
    assert.deepEqual(paths(end), ['edit src/a.js']);
  });

  await t.test('a write of a new file is a create', () => {
    assert.deepEqual(paths(ev('after', 'write')), ['create src/c.js']);
  });

  await t.test('a write over an existing file is an edit', () => {
    const raw = find('after', 'write');
    const over = { ...raw, event: { ...raw.event, result: { output: { ...raw.event.result.output, existed: true } } } };
    assert.deepEqual(paths(run(opencode, over)), ['edit src/c.js']);
  });

  await t.test('a patch is an edit of every file it lists', () => {
    const raw = { phase: 'after', directory: '/repo', event: { tool: 'patch', sessionID: 's', id: 'p1', status: 'completed',
      input: { patchText: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** Add File: src/c.js\n+z\n*** End Patch\n' } } };
    const msg = extract(opencode.toClaude(raw));
    assert.equal(msg.filePath, 'src/a.js');
    assert.deepEqual(msg.changed, { files: ['src/a.js', 'src/c.js'], created: ['src/c.js'] });
  });

  await t.test('a shell command that exits non-zero is a failure', () => {
    const end = ev('after', 'shell');
    assert.equal(end.kind, 'bash');
    assert.equal(end.phase, 'fail');
    assert.match(end.error, /exit code 1/);
    assert.equal(end.label, 'cat does-not-exist.txt');
  });

  await t.test('a patch that failed is not counted as changing files', () => {
    const raw = { phase: 'after', directory: '/repo', event: { tool: 'patch', sessionID: 's', id: 'p2', status: 'error', error: { message: 'no match' },
      input: { patchText: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-x\n+y\n*** End Patch\n' } } };
    const msg = extract(opencode.toClaude(raw));
    assert.equal(msg.changed, undefined);
    assert.equal(msg.error, 'no match');
  });

  await t.test('a bash tool that exits non-zero is a failure too', () => {
    const raw = find('after', 'shell');
    const end = run(opencode, { ...raw, event: { ...raw.event, tool: 'bash' } });
    assert.equal(end.phase, 'fail');
    assert.match(end.error, /exit code 1/);
  });

  await t.test('a tool error is a failure with its message', () => {
    const end = ev('after', 'read', (e) => e.status === 'error');
    assert.equal(end.phase, 'fail');
    assert.equal(end.error, 'File not found: src/missing.js');
  });

  await t.test('no file content or tool output survives', () => {
    for (const raw of fixtures) {
      const text = JSON.stringify(extract(opencode.toClaude(raw)));
      assert.ok(!text.includes('export const'), raw.event.tool);
    }
  });
});
