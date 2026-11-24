/**
 * agentes-runner: connects this computer to an squadchat organization
 * (ADR 0025). Bundled to one file for Node.js 22+ and Bun:
 *   bun build apps/server/runner/main.ts --target=node --banner '#!/usr/bin/env node' --outfile apps/web/dist/runner/agentes-runner.mjs
 * or compiled to one executable for the desktop app (ADR 0036), no runtime needed:
 *   bun build --compile --target=bun-darwin-arm64 apps/server/runner/main.ts --outfile agentes-runner
 */
import path from "node:path";
import { flagString, type Parsed, parseArgs } from "./args";
import { expandHome, runnerHome } from "./config";

async function main(argv: string[]): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  // One home per organization (the desktop app passes its own); child processes inherit it.
  const home = flagString(p, "home");
  if (home) process.env.AGENTES_RUNNER_HOME = expandHome(home);
  const [command] = p.positional;
  if (command === "mcp" && !p.flags.has("help") && !p.flags.has("version")) {
    // Fast-path: `mcp` runs inside every CLI turn/relay and skips loading daemon, desktop and setup modules.
    const { MCP_TOKEN_FILE, mcpSocketPath, runMcpRelay, runMcpServer } = await import("./mcp");
    const runId =
      flagString(p, "run") ?? (flagString(p, "task") ? undefined : process.env.AGENTES_MCP_RUN || undefined);
    const taskId = runId ?? flagString(p, "task");
    if (!taskId || !/^[a-zA-Z0-9-]{8,64}$/.test(taskId)) {
      console.error("Usage: agentes-runner mcp --task <taskId> | --run <runId>");
      return 1;
    }
    if (p.flags.has("relay")) {
      const { AGENTES_MCP_SOCKET: socketPath, AGENTES_MCP_TOKEN: token } = process.env;
      if (!socketPath || !token) return 1;
      return runMcpRelay({ taskId, socketPath, token });
    }
    return runMcpServer({
      taskId,
      socketPath: process.env.AGENTES_MCP_SOCKET || mcpSocketPath(runnerHome()),
      token: process.env.AGENTES_MCP_TOKEN || null,
      ...(runId ? {} : { tokenFile: path.join(runnerHome(), "tasks", taskId, MCP_TOKEN_FILE) }),
    });
  }
  const { runCli } = await import("./cli");
  return runCli(argv);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`(home: ${runnerHome()})`);
    process.exit(1);
  },
);
