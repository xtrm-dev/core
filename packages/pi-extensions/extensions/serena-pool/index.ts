/**
 * serena-pool — shared Serena daemon per repo root
 *
 * Sets SERENA_MCP_PORT to a deterministic port derived from the git root before
 * pi-serena-tools session_start fires. If no Serena server is already listening
 * on that port, spawns one (detached, persists after session ends).
 *
 * pi-serena-tools reads SERENA_MCP_PORT lazily in resolveSerenaPort(), finds the
 * server already running, skips its own spawn, and stopServer() is a no-op since
 * it never held serverProcess. No patches to pi-serena-tools needed.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { execSync } from "node:child_process";

const POOL_PORT_MIN = 40000;
const POOL_PORT_RANGE = 5000; // 40000–44999
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 300;

function hashToPort(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0;
  }
  return POOL_PORT_MIN + (h % POOL_PORT_RANGE);
}

function getRepoRoot(cwd: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port: number): Promise<boolean> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

async function ensureSerenaRunning(projectRoot: string, port: number): Promise<void> {
  if (await isPortListening(port)) return;

  const proc = spawn(
    "uvx",
    [
      "--from", "git+https://github.com/oraios/serena",
      "serena", "start-mcp-server",
      "--transport", "streamable-http",
      "--port", String(port),
      "--project", projectRoot,
      "--context", "agent",
    ],
    {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: "ignore",
      detached: true,
    },
  );
  proc.unref();

  const ready = await waitForPort(port);
  if (!ready) {
    console.warn(`[serena-pool] Serena did not start on port ${port} within ${STARTUP_TIMEOUT_MS}ms`);
  }
}

export default function registerSerenaPool(pi: ExtensionAPI) {
  pi.on("session_start", async (_event: unknown, ctx: any) => {
    const cwd: string = ctx?.cwd ?? process.cwd();
    const projectRoot = getRepoRoot(cwd);
    const port = hashToPort(projectRoot);

    try {
      await ensureSerenaRunning(projectRoot, port);
      process.env.SERENA_MCP_PORT = String(port);
    } catch (err) {
      console.warn("[serena-pool] Error ensuring Serena running:", err);
    }
  });

  // session_shutdown intentionally absent — server persists as daemon across sessions.
  // Kill manually with: kill $(lsof -ti:PORT) or pkill -f "serena start-mcp-server"
}
