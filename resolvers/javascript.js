'use strict';
const path = require('node:path');

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.json'];
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

function firstExisting(raw, has) {
  const base = raw === '.' ? '' : raw.replace(/\/+$/, '');
  if (!base) {
    for (const ext of EXTENSIONS) if (has(`index${ext}`)) return `index${ext}`;
    return null;
  }
  if (has(base)) return base;
  for (const ext of EXTENSIONS) if (has(base + ext)) return base + ext;
  const declared = path.posix.extname(base);
  for (const ext of JS_TO_TS[declared] || []) {
    const swapped = base.slice(0, -declared.length) + ext;
    if (has(swapped)) return swapped;
  }
  for (const ext of EXTENSIONS) if (has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return null;
}

function aliasCandidates(spec, tsconfig) {
  if (!tsconfig) return [];
  const out = [];
  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    const star = pattern.indexOf('*');
    if (star < 0) {
      if (pattern === spec) out.push(...targets);
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (spec.length >= prefix.length + suffix.length && spec.startsWith(prefix) && spec.endsWith(suffix)) {
      const middle = spec.slice(prefix.length, spec.length - suffix.length);
      out.push(...targets.map((t) => t.replace('*', middle)));
    }
  }
  if (tsconfig.baseUrl) out.push(spec);
  return out.map((t) => path.posix.normalize(path.posix.join(tsconfig.baseUrl || '.', t)));
}

function resolveJs({ spec }, fromFile, { has, tsconfig }) {
  const candidates = spec.startsWith('.')
    ? [path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec))]
    : aliasCandidates(spec, tsconfig);
  for (const base of candidates) {
    if (base.startsWith('..')) continue;
    const hit = firstExisting(base, has);
    if (hit) return [hit];
  }
  return [];
}

function stripJsonc(text) {
  return text
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '')
    .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, close) => str || close);
}

// Reads baseUrl and paths from tsconfig text; returns null if neither is set.
function loadTsconfigPaths(text) {
  try {
    const { baseUrl, paths } = JSON.parse(stripJsonc(text)).compilerOptions || {};
    if (!baseUrl && !paths) return null;
    return { baseUrl: baseUrl ? path.posix.normalize(baseUrl) : '', paths: paths || {} };
  } catch {
    return null;
  }
}

module.exports = { resolveJs, loadTsconfigPaths };
