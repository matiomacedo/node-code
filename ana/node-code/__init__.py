"""node-code plugin for Ana. Copy this folder to ~/.ana/plugins/; it needs the
global node-code command (npm install -g github:matiomacedo/node-code).

Each file, search and shell tool call is piped to `node-code hook --agent ana`,
which maps it and sends it to the graph server for this repository, if one is
running. Only paths, search patterns, commands, errors and grep/glob results
leave Ana, never file contents. This must never affect Ana, so every failure is
ignored and nothing is awaited on the tool's path.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import shutil
import uuid
from pathlib import Path
from typing import Any

from ana.plugin.base import AnaPlugin, PluginHook, PluginManifest

TOOLS = {
    "read_file",
    "edit_file",
    "multi_edit",
    "edit_symbol",
    "notebook_edit",
    "write_file",
    "grep",
    "glob",
    "shell_command",
    "shell_start",
    "rename_file",
    "delete_file",
}
# notebook_edit's `source` is cell text, so `source` is kept for rename_file only.
ARG_KEYS = ("path", "destination", "pattern", "command")
SEARCH_TOOLS = {"grep", "glob"}
MAX_TEXT = 300
MAX_OUTPUT = 200_000
MAX_PENDING = 1000


def public_args(tool: str, args: dict[str, Any]) -> dict[str, str]:
    keys = (*ARG_KEYS, "source") if tool == "rename_file" else ARG_KEYS
    return {k: str(args[k]) for k in keys if args.get(k) is not None}


def result_fields(tool: str, result: Any) -> dict[str, Any]:  # noqa: ANN401
    metadata = getattr(result, "metadata", None) or {}
    out: dict[str, Any] = {
        "success": bool(getattr(result, "success", False)),
        "error": str(getattr(result, "error", "") or "")[:MAX_TEXT],
        "metadata": {k: str(metadata[k]) for k in ("path", "base_dir") if k in metadata},
    }
    if tool in SEARCH_TOOLS:
        out["output"] = str(getattr(result, "output", ""))[:MAX_OUTPUT]
    return out


class NodeCodePlugin(AnaPlugin):
    def __init__(self) -> None:
        self._pending: dict[str, tuple[str, bool]] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._command = shutil.which("node-code")

    def manifest(self) -> PluginManifest:
        return PluginManifest(
            name="node-code",
            version="0.3.3",
            description="Shows Ana's file activity in the node-code graph",
            hooks=[PluginHook.TOOL_EXECUTE_BEFORE, PluginHook.TOOL_EXECUTE_AFTER],
        )

    async def on_tool_execute_before(self, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
        with contextlib.suppress(Exception):
            if tool_name in TOOLS:
                call_id = uuid.uuid4().hex
                existed = self._exists(args) if tool_name == "write_file" else True
                # A call blocked by a user hook, or whose tool raised, gets no after
                # hook. A retry with the same args replaces it, so it pairs with its
                # own start, and the oldest of those abandoned calls is dropped first.
                key = self._key(tool_name, args)
                self._pending.pop(key, None)
                if len(self._pending) >= MAX_PENDING:
                    self._pending.pop(next(iter(self._pending)))
                self._pending[key] = (call_id, existed)
                self._send(self._payload("before", tool_name, args, call_id))
        return args

    async def on_tool_execute_after(
        self, tool_name: str, args: dict[str, Any], result: object
    ) -> None:
        with contextlib.suppress(Exception):
            if tool_name not in TOOLS:
                return
            # The before and after hooks get the same args, which pair them; a call
            # whose before was missed gets an id of its own.
            call_id, existed = self._pending.pop(
                self._key(tool_name, args), (uuid.uuid4().hex, True)
            )
            payload = self._payload("after", tool_name, args, call_id)
            payload["result"] = result_fields(tool_name, result)
            if tool_name == "write_file":
                payload["created"] = not existed
            self._send(payload)

    @staticmethod
    def _key(tool: str, args: dict[str, Any]) -> str:
        return json.dumps(
            [str(args.get("_session_id", "")), tool, public_args(tool, args)], sort_keys=True
        )

    @staticmethod
    def _exists(args: dict[str, Any]) -> bool:
        return (Path(str(args.get("_project_dir") or ".")) / str(args.get("path", ""))).exists()

    @staticmethod
    def _payload(phase: str, tool: str, args: dict[str, Any], call_id: str) -> dict[str, Any]:
        return {
            "phase": phase,
            "directory": str(args.get("_project_dir") or ""),
            "session": str(args.get("_session_id") or ""),
            "id": call_id,
            "tool": tool,
            "args": public_args(tool, args),
        }

    def _send(self, payload: dict[str, Any]) -> None:
        if self._command is None:
            return
        task = asyncio.get_running_loop().create_task(
            self._pipe(self._command, json.dumps(payload).encode())
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    @staticmethod
    async def _pipe(command: str, data: bytes) -> None:
        with contextlib.suppress(Exception):
            proc = await asyncio.create_subprocess_exec(
                command,
                "hook",
                "--agent",
                "ana",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.communicate(data)
