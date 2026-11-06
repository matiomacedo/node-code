'use strict';
// Maps OpenCode tool events to Claude Code's shape. The plugin in opencode/
// sends { phase: 'before' | 'after', directory, event }, where event is what
// OpenCode's v2 plugin API passes to ctx.tool.hook("execute.before" / "execute.after").
// Captured from OpenCode 2.2.5; see test/fixtures/opencode-payloads.jsonl.
// Paths are relative to directory. A shell command that exits non-zero still
// completes, so its exit code decides failure.

const { editFromPatch } = require('./patch');

const TOOL_NAMES = { read: 'Read', edit: 'Edit', write: 'Write', grep: 'Grep', glob: 'Glob', shell: 'Bash', bash: 'Bash' };

function hookEvent(phase, event) {
  if (phase === 'before') return { hook_event_name: 'PreToolUse' };
  if (event.status === 'error') return { hook_event_name: 'PostToolUseFailure', error: event.error?.message };
  const exit = event.result?.output?.exit;
  if (TOOL_NAMES[event.tool] === 'Bash' && Number.isInteger(exit) && exit !== 0) {
    return { hook_event_name: 'PostToolUseFailure', error: `exit code ${exit}: ${event.result.output.output ?? ''}` };
  }
  return { hook_event_name: 'PostToolUse' };
}

function toolFields(event, finished) {
  const input = event.input || {};
  const output = event.result?.output;
  switch (event.tool) {
    case 'patch':
      return editFromPatch(String(input.patchText ?? ''), { finished });
    case 'read':
    case 'edit':
      return { tool_input: { file_path: input.path } };
    case 'write':
      return { tool_input: { file_path: input.path }, tool_response: output && { type: output.existed === false ? 'create' : 'update' } };
    case 'grep':
      return { tool_input: { pattern: input.pattern, path: input.path },
        tool_response: Array.isArray(output) && { filenames: [...new Set(output.map((m) => m.entry?.path).filter(Boolean))] } };
    case 'glob':
      return { tool_input: { pattern: input.pattern, path: input.path },
        tool_response: Array.isArray(output) && { filenames: output.map((m) => m.path).filter(Boolean) } };
    case 'shell':
    case 'bash':
      return { tool_input: { command: input.command } };
    default:
      return { tool_input: {} };
  }
}

function toClaude({ phase, directory, event = {} }) {
  const hook = hookEvent(phase, event);
  return {
    session_id: event.sessionID,
    tool_use_id: event.id,
    cwd: directory,
    tool_name: TOOL_NAMES[event.tool] ?? event.tool,
    ...hook,
    ...toolFields(event, hook.hook_event_name === 'PostToolUse'),
  };
}

module.exports = { toClaude };
