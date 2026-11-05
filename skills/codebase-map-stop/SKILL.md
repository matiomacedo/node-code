---
description: Stop the node-code graph server for this repository.
disable-model-invocation: true
allowed-tools: Bash(node *scripts/ctl.js*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.js" stop --data "${CLAUDE_PLUGIN_DATA}"`

Show the user the line above and nothing else. Do not run any tools.
