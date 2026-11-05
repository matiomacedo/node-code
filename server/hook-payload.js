'use strict';
// Reduces a raw hook payload to the fields the server needs. File contents and
// successful tool output are dropped. Kept: paths, the search pattern, and the
// first 300 characters of a Bash command and of a failed call's error message.
// tool_response shapes for Grep and Glob are undocumented; these were captured
// from Claude Code 2.1.318 (see test/fixtures/hook-payloads.jsonl).
const path = require('node:path');

const MAX_TEXT = 300;
const MAX_MATCHED = 100;

const clip = (s) => (typeof s === 'string' ? s.slice(0, MAX_TEXT) : undefined);

const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

// pathExists, when given, filters names parsed out of Grep content. A search of a
// single file prints lines without a path prefix, so "KEY:123" in the file would
// otherwise look like a file name.
function matchedFiles(raw, pathExists) {
  const res = raw.tool_response;
  if (!SEARCH_TOOLS.has(raw.tool_name) || !res || typeof res !== 'object') return undefined;
  if (Array.isArray(res.filenames) && res.filenames.length) return res.filenames.slice(0, MAX_MATCHED);
  if (typeof res.content !== 'string') return undefined;
  const found = new Set();
  // Grep content and count modes prefix each line with "path:line:" or "path:count".
  for (const m of res.content.matchAll(/^([^:\n]+):\d+(?::|-|$)/gm)) {
    if (pathExists && !pathExists(path.resolve(raw.cwd || '.', m[1]))) continue;
    found.add(m[1]);
    if (found.size >= MAX_MATCHED) break;
  }
  return found.size ? [...found] : undefined;
}

function changedFiles(res) {
  const diff = res && res.bashEditDiff;
  if (!diff || !Array.isArray(diff.changedFiles)) return undefined;
  const files = Array.isArray(diff.files) ? diff.files : [];
  return {
    files: diff.changedFiles,
    created: files.filter((f) => f && f.created).map((f) => f.filePath),
  };
}

function extract(raw, { pathExists } = {}) {
  const input = raw.tool_input || {};
  const res = raw.tool_response;
  return {
    event: raw.hook_event_name,
    tool: raw.tool_name,
    id: raw.tool_use_id,
    session: raw.session_id,
    agent: raw.agent_id,
    agentType: raw.agent_type,
    cwd: raw.cwd,
    filePath: input.file_path || input.notebook_path,
    searchPath: input.path,
    pattern: clip(input.pattern),
    command: clip(input.command),
    created: Boolean(res && res.type === 'create'),
    matched: matchedFiles(raw, pathExists),
    changed: changedFiles(res),
    error: clip(raw.error),
    interrupt: raw.is_interrupt === true,
    durationMs: raw.duration_ms,
  };
}

module.exports = { extract };
