#!/usr/bin/env node
'use strict';
// Installs the Ana plugin into $ANA_HOME/plugins/node-code (default ~/.ana).
// command.json records absolute paths to node and the hook, because Ana.app
// starts its backend with the bare macOS PATH, where neither may be found.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const anaHome = process.env.ANA_HOME || path.join(os.homedir(), '.ana');
const dir = path.join(anaHome, 'plugins', 'node-code');
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'ana', 'node-code', '__init__.py'), path.join(dir, '__init__.py'));
const command = [process.execPath, path.join(__dirname, 'hook.js'), '--agent', 'ana'];
fs.writeFileSync(path.join(dir, 'command.json'), `${JSON.stringify({ command }, null, 2)}\n`);
console.log(`Installed the node-code plugin in ${dir}. Restart Ana's backend to load it.`);
