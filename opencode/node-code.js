// node-code plugin for OpenCode. Copy this file to ~/.config/opencode/plugins/
// (or a project's .opencode/plugins/). It needs the global node-code command:
//   npm install -g github:matiomacedo/node-code
// Each tool event is piped to `node-code hook --agent opencode`, which maps it and
// sends it to the graph server for this repository, if one is running. This must
// never affect OpenCode, so every failure is ignored.
import { spawn } from "node:child_process";

function send(phase, directory, event) {
  try {
    // On Windows npm installs node-code as a .cmd file, which only a shell can run.
    const child = spawn("node-code", ["hook", "--agent", "opencode"], {
      stdio: ["pipe", "ignore", "ignore"], detached: true, windowsHide: true, shell: process.platform === "win32",
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ phase, directory, event }));
    child.unref();
  } catch {}
}

export default {
  id: "node-code",
  async setup(ctx) {
    const directory = ctx.location.directory;
    await ctx.tool.hook("execute.before", (event) => send("before", directory, event));
    await ctx.tool.hook("execute.after", (event) => send("after", directory, event));
  },
};
