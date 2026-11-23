'use strict';
// Maps Ana tool events to Claude Code's shape. The plugin in ana/node-code sends
// { phase: 'before' | 'after', directory, session, id, tool, args, result?, created? },
// built from Ana's tool.execute.before / tool.execute.after plugin hooks; args keep
// only paths, patterns and commands. Captured by running Ana's own tools through
// the plugin; see test/fixtures/ana-payloads.jsonl.
// - Paths are relative to directory, or absolute.
// - Grep and glob return plain text: grep prints "path:line:text" from the
//   project root, glob prints "[F] path  (N bytes)" relative to metadata.base_dir.
// - A shell command that exits non-zero is reported as a failure.

const path = require('node:path');
const { matchedFiles } = require('./copilot');

const TOOL_NAMES = {
  read_file: 'Read', edit_file: 'Edit', multi_edit: 'Edit', edit_symbol: 'Edit', notebook_edit: 'NotebookEdit',
  write_file: 'Write', grep: 'Grep', glob: 'Glob', shell_command: 'Bash', shell_start: 'Bash', rename_file: 'Edit',
};
const GLOB_FILE = /^\s*\[F\] (.+?) {2}\(\d+ bytes\)$/gm;
const MAX_MATCHED = 100; // extract keeps no more than this

function globFiles(text, baseDir) {
  return [...text.matchAll(GLOB_FILE)].slice(0, MAX_MATCHED).map((m) => path.join(baseDir || '', m[1]));
}

function hookEvent(raw) {
  if (raw.phase === 'before') return { hook_event_name: 'PreToolUse' };
  if (raw.result?.success) return { hook_event_name: 'PostToolUse' };
  return { hook_event_name: 'PostToolUseFailure', error: raw.result?.error || 'failed' };
}

function toolFields(raw, finished, pathExists) {
  const args = raw.args || {};
  const text = typeof raw.result?.output === 'string' ? raw.result.output : '';
  switch (raw.tool) {
    case 'grep':
      return { tool_input: { pattern: args.pattern, path: args.path },
        tool_response: text && { filenames: matchedFiles(text, raw.directory, pathExists) } };
    case 'glob':
      return { tool_input: { pattern: args.pattern, path: args.path },
        tool_response: text && { filenames: globFiles(text, raw.result.metadata?.base_dir) } };
    case 'shell_command':
    case 'shell_start':
      return { tool_input: { command: args.command } };
    case 'rename_file': {
      const dest = args.destination;
      return { tool_input: { file_path: dest }, tool_response: finished && {
        type: 'create', bashEditDiff: { changedFiles: [dest], files: [{ filePath: dest, created: true }] } } };
    }
    case 'write_file':
      return { tool_input: { file_path: args.path }, tool_response: finished && { type: raw.created ? 'create' : 'update' } };
    default:
      return { tool_input: TOOL_NAMES[raw.tool] ? { file_path: args.path } : {} };
  }
}

function toClaude(raw, { pathExists = () => false } = {}) {
  const hook = hookEvent(raw);
  return {
    session_id: raw.session,
    tool_use_id: raw.id,
    cwd: raw.directory,
    tool_name: TOOL_NAMES[raw.tool] ?? raw.tool,
    ...hook,
    ...toolFields(raw, hook.hook_event_name === 'PostToolUse', pathExists),
  };
}

module.exports = { toClaude };
