'use strict';
const path = require('node:path');

const PHASE = { PreToolUse: 'start', PostToolUse: 'end', PostToolUseFailure: 'fail' };
const READ_ONLY = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', 'nl', 'bat']);
const SHELL_WRITES = /[>;&`]|\$\(/;

function target(index, p, cwd, action, heat) {
  const { kind, rel } = index.resolve(p, cwd);
  return kind ? { path: rel, action, heat } : null;
}

// A file that does not exist yet has no node, so show the work on its folder.
function fileEditTargets(msg, index, phase) {
  const { rel, kind } = index.resolve(msg.filePath, msg.cwd);
  if (rel === null) return [];
  if (kind) return [{ path: rel, action: phase === 'end' && msg.created ? 'create' : 'edit', heat: true }];
  if (phase !== 'start') return [];
  const parent = index.kindOf(path.posix.dirname(rel)) ? path.posix.dirname(rel) : null;
  return parent ? [{ path: parent, action: 'edit', heat: false }] : [];
}

function searchTargets(msg, index) {
  const found = [];
  if (msg.searchPath) found.push(target(index, msg.searchPath, msg.cwd, 'read', false));
  for (const f of msg.matched || []) found.push(target(index, f, msg.cwd, 'read', false));
  return found.filter(Boolean);
}

function bashReadTargets(command, cwd, index) {
  if (!command || SHELL_WRITES.test(command)) return [];
  const words = command.split('|')[0].trim().split(/\s+/);
  const isSedPrint = words[0] === 'sed' && words[1] === '-n';
  if (!READ_ONLY.has(words[0]) && !isSedPrint) return [];
  return words.slice(1)
    .filter((w) => !w.startsWith('-'))
    .map((w) => index.resolve(w, cwd))
    .filter((r) => r.kind === 'file')
    .map((r) => ({ path: r.rel, action: 'read', heat: false }));
}

function bashTargets(msg, index) {
  if (!msg.changed) return bashReadTargets(msg.command, msg.cwd, index);
  const created = new Set(msg.changed.created);
  return msg.changed.files
    .map((f) => target(index, f, msg.cwd, created.has(f) ? 'create' : 'edit', true))
    .filter(Boolean);
}

function fileLabel(msg, index) {
  const { rel } = index.resolve(msg.filePath, msg.cwd);
  return rel ?? msg.filePath;
}

function describe(msg, index) {
  switch (msg.tool) {
    case 'Read': {
      const t = target(index, msg.filePath, msg.cwd, 'read', true);
      return { kind: 'read', targets: t ? [t] : [], label: fileLabel(msg, index) };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { kind: 'edit', targets: fileEditTargets(msg, index, PHASE[msg.event]), label: fileLabel(msg, index) };
    case 'Grep':
    case 'Glob': {
      const where = msg.searchPath ? index.resolve(msg.searchPath, msg.cwd).rel ?? msg.searchPath : null;
      return {
        kind: 'search',
        targets: searchTargets(msg, index),
        label: where ? `"${msg.pattern}" in ${where}` : `"${msg.pattern}"`,
      };
    }
    case 'Bash':
      return { kind: 'bash', targets: bashTargets(msg, index), label: msg.command || '' };
    default:
      return { kind: 'other', targets: [], label: msg.tool };
  }
}

// Turns an extracted hook message into a repo-relative activity event.
function normalize(msg, index) {
  let phase = PHASE[msg.event];
  if (phase === 'fail' && msg.interrupt) phase = 'interrupt';
  return {
    id: msg.id,
    phase,
    tool: msg.tool,
    session: msg.session,
    agent: msg.agentType || msg.agent,
    error: msg.error,
    ...describe(msg, index),
  };
}

module.exports = { normalize };
