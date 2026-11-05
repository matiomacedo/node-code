---
description: Open a live force-directed graph of this repository in the browser, showing what Claude reads and edits in real time.
disable-model-invocation: true
allowed-tools: Bash(node *scripts/ctl.js*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.js" start --data "${CLAUDE_PLUGIN_DATA}"`

Show the user the line above, including its URL, and nothing else. Do not run any tools.
