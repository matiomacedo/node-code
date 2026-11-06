'use strict';
// Maps GitHub Copilot CLI hook payloads to Claude Code's shape. The hooks use the
// PascalCase event names (PreToolUse...), for which Copilot already sends Claude's
// field names, tool names and tool_use_id. Captured from Copilot CLI 1.0.107; see
// test/fixtures/copilot-payloads.jsonl. What still differs:
// - Read takes `path`; Grep and Glob take `paths`, of which only the first is shown.
// - Edit is apply_patch: tool_input is the patch text, which may touch several files.
// - Grep and Glob return plain text, and Grep lines have no line numbers.
// - A shell command that exits non-zero is still reported as a success.

const path = require('node:path');
const { editFromPatch } = require('./patch');

const EXIT_CODE = /<shellId: [^>]* completed with exit code (\d+)>\s*$/;
const MAX_MATCHED = 100; // extract keeps no more than this

// Grep prints "path:text" and Glob prints one path per line. Only prefixes that
// exist as files are kept, so text from a matched line is never taken for a path.
function matchedFiles(text, cwd, pathExists) {
  const exists = (p) => Boolean(p) && pathExists(path.resolve(cwd || '.', p));
  const found = new Set();
  for (const line of text.split('\n')) {
    if (found.size >= MAX_MATCHED) break;
    const candidate = exists(line) ? line : line.slice(0, Math.max(line.indexOf(':'), 0));
    if (exists(candidate)) found.add(candidate);
  }
  return [...found];
}

function failedExit(text) {
  const m = EXIT_CODE.exec(text);
  return m && m[1] !== '0' ? `exit code ${m[1]}: ${text}` : null;
}

function toClaude(raw, { pathExists = () => false } = {}) {
  const { tool_result: result, ...out } = raw;
  const text = typeof result?.text_result_for_llm === 'string' ? result.text_result_for_llm : '';
  const input = raw.tool_input;
  if (typeof input === 'string') return { ...out, ...editFromPatch(input, { finished: result?.result_type === 'success' }) };
  if (!input || typeof input !== 'object') return out;

  switch (raw.tool_name) {
    case 'Grep':
    case 'Glob':
      out.tool_input = { ...input, path: Array.isArray(input.paths) ? input.paths[0] : input.paths };
      if (text) out.tool_response = { filenames: matchedFiles(text, raw.cwd, pathExists) };
      return out;
    case 'Bash': {
      const error = raw.hook_event_name === 'PostToolUse' && failedExit(text);
      return error ? { ...out, hook_event_name: 'PostToolUseFailure', error } : out;
    }
    default:
      if (input.file_path === undefined && typeof input.path === 'string') out.tool_input = { ...input, file_path: input.path };
      return out;
  }
}

module.exports = { toClaude };
