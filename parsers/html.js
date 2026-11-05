'use strict';
const { unique } = require('./strip');

const TAG = /<(?:script|link)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi;
const LOCAL = (p) => !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(p);

function parse(source) {
  const text = source.replace(/<!--[\s\S]*?-->/g, '');
  const specs = unique([...text.matchAll(TAG)].map((m) => m[1].replace(/[?#].*$/, ''))).filter((p) => p && LOCAL(p));
  return { imports: specs.map((spec) => ({ spec })), exports: [], symbols: [] };
}

module.exports = { parse };
