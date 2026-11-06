#!/usr/bin/env node
'use strict';
// The global command for agents other than Claude Code:
//   node-code start|stop [--cwd <dir>] [--no-open]
//   node-code hook --agent <name>   (reads the agent's hook payload on stdin)
if (process.argv[2] === 'hook') require('./hook');
else require('./ctl');
