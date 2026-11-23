"""node-code plugin for Ana. Install it with `node-code install-ana`, which copies
it to $ANA_HOME/plugins/node-code with a command.json naming node and the hook by
absolute path: Ana.app starts its backend with the bare macOS PATH.

Each file, search and shell tool call is piped to `node-code hook --agent ana`,
which maps it and sends it to the graph server for this repository, if one is
running. What leaves Ana: paths, search patterns, commands, grep/glob results,
the first 300 characters of a failed call's error, and only the exit code of a
failed shell command. This must never affect Ana, so every failure is ignored
and nothing is awaited on the tool's path.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
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
SHELL_TOOLS = {"shell_command", "shell_start"}
# Ana passes the args the before hook returns on to the after hook, and keeps
# "_" args out of the model's view, hooks and MCP calls: they pair the two.
ID_ARG = "_node_code_id"
CREATED_ARG = "_node_code_created"
EXIT_CODE = re.compile(r"Exit code: -?\d+")
MAX_TEXT = 300
MAX_OUTPUT = 200_000


def public_args(tool: str, args: dict[str, Any]) -> dict[str, str]:
    keys = (*ARG_KEYS, "source") if tool == "rename_file" else ARG_KEYS
    return {k: str(args[k]) for k in keys if args.get(k) is not None}


def error_text(tool: str, error: str) -> str:
    # A shell error is the command's whole stdout and stderr, which may hold file
    # contents: only its exit code is sent.
    if tool in SHELL_TOOLS and error:
        codes = EXIT_CODE.findall(error)
        return codes[-1] if codes else "failed"
    return error[:MAX_TEXT]


def result_fields(tool: str, result: Any) -> dict[str, Any]:  # noqa: ANN401
    metadata = getattr(result, "metadata", None) or {}
    out: dict[str, Any] = {
        "success": bool(getattr(result, "success", False)),
        "error": error_text(tool, str(getattr(result, "error", "") or "")),
        "metadata": {k: str(metadata[k]) for k in ("path", "base_dir") if k in metadata},
    }
    if tool in SEARCH_TOOLS:
        out["output"] = str(getattr(result, "output", ""))[:MAX_OUTPUT]
    return out


def hook_command() -> list[str] | None:
    """From command.json beside this file, else `node-code` on PATH."""
    with contextlib.suppress(Exception):
        command = json.loads((Path(__file__).parent / "command.json").read_text("utf-8"))["command"]
        if isinstance(command, list) and command and all(isinstance(c, str) for c in command):
            return command
    found = shutil.which("node-code")
    return [found, "hook", "--agent", "ana"] if found else None


class NodeCodePlugin(AnaPlugin):
    def __init__(self) -> None:
        self._tasks: set[asyncio.Task[None]] = set()
        self._command = hook_command()

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
                self._send(self._payload("before", tool_name, args, call_id))
                marked = {**args, ID_ARG: call_id}
                if tool_name == "write_file":
                    marked[CREATED_ARG] = not self._exists(args)
                return marked
        return args

    async def on_tool_execute_after(
        self, tool_name: str, args: dict[str, Any], result: object
    ) -> None:
        with contextlib.suppress(Exception):
            if tool_name not in TOOLS:
                return
            call_id = str(args.get(ID_ARG) or uuid.uuid4().hex)
            payload = self._payload("after", tool_name, args, call_id)
            payload["result"] = result_fields(tool_name, result)
            if tool_name == "write_file":
                payload["created"] = bool(args.get(CREATED_ARG))
            self._send(payload)

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
    async def _pipe(command: list[str], data: bytes) -> None:
        with contextlib.suppress(Exception):
            proc = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.communicate(data)
