'use strict';
// Vue and Svelte single-file components: the JS parser over the <script> blocks.
const javascript = require('./javascript');

const SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

function parse(source) {
  const scripts = [...source.replace(/<!--[\s\S]*?-->/g, '').matchAll(SCRIPT)].map((m) => m[1]).join('\n');
  return javascript.parse(scripts);
}

module.exports = { parse };
