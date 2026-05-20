/**
 * serena-pool — shared Serena daemon per repo root with ownership-based cleanup
 *
 * On session_start:
 *   1. Resolve repo root from cwd → deterministic port via hash.
 *   2. If a Serena is already listening on that port → reuse it, set SERENA_MCP_PORT.
 *   3. Otherwise acquire a per-port file lock and:
 *        - Read the recorded state (pid, pgid, startTime, instanceId) from /tmp.
 *        - If the previously-recorded Serena process is dead → kill its process
 *          group (SIGTERM then SIGKILL) to reap orphaned LSP children.
 *        - Spawn a fresh Serena (detached → new process group, pgid == pid).
 *        - Persist new state to /tmp.
 *        - Wait until the port answers, then release the lock.
 *
 * pi-serena-tools reads SERENA_MCP_PORT lazily and reuses the daemon; its
 * own stopServer() is a no-op because it never held the child handle.
 *
 * Orphan cleanup is by process-group ownership only — never by path matching.
 * We only signal processes whose pgid matches the recorded pgid AND whose
 * controlling Serena is verifiably dead (pid+startTime check). Process-group
 * kills are bounded to ours, so editor LSPs / tests / hooks are never touched.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, execFileSync } from "node:child_process";
import { connect } from "node:net";
import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const POOL_PORT_MIN = 40000;
const POOL_PORT_RANGE = 5000; // ports 40000–44999
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 300;
const LOCK_TIMEOUT_MS = 10_000;
const ORPHAN_TERM_GRACE_MS = 2_000;

const STATE_DIR = join(tmpdir(), "serena-pool");

type PoolState = {
  pid: number;
  pgid: number;
  startTime: string | null;
  instanceId: string;
  projectRoot: string;
  port: number;
  spawnedAt: number;
};

function hashToPort(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0;
  }
  return POOL_PORT_MIN + (h % POOL_PORT_RANGE);
}

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function stateFilePath(port: number): string {
  return join(STATE_DIR, `pool-${port}.json`);
}

function lockFilePath(port: number): string {
  return join(STATE_DIR, `pool-${port}.lock`);
}

function getRepoRoot(cwd: string): string {
  let root = cwd;
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) root = out;
  } catch {
    /* not a git repo — use cwd */
  }
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true; // exists, just not signalable by us
    return false;
  }
}

/** Linux: /proc/<pid>/stat field 22 (starttime). macOS/other: `ps -o lstart=`. */
function getProcessStartTime(pid: number): string | null {
  if (!pid || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // pid (comm) state ... — comm may contain spaces/parens; split after last ')'
      const lastParen = stat.lastIndexOf(")");
      if (lastParen < 0) return null;
      const fields = stat.slice(lastParen + 2).split(" ");
      // After (comm), fields[0]=state, fields[19]=starttime (clock ticks since boot)
      return fields[19] ?? null;
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Verify that `pid` is alive AND its start time still matches `recorded`. */
function isSameProcess(pid: number, recordedStartTime: string | null): boolean {
  if (!isPidAlive(pid)) return false;
  if (recordedStartTime == null) return true; // we never captured one — trust pid only
  const current = getProcessStartTime(pid);
  return current != null && current === recordedStartTime;
}

/** Enumerate all processes whose pgid matches the given value (excluding us). */
function findProcessesByPgid(pgid: number): Array<{ pid: number; comm: string }> {
  if (!pgid || pgid <= 0) return [];
  try {
    const out = execFileSync("ps", ["-e", "-o", "pid=,pgid=,comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
    const result: Array<{ pid: number; comm: string }> = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const procPgid = Number(m[2]);
      if (procPgid === pgid && pid !== process.pid) {
        result.push({ pid, comm: m[3].trim() });
      }
    }
    return result;
  } catch {
    return [];
  }
}

function tryKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function readState(port: number): PoolState | null {
  try {
    const raw = readFileSync(stateFilePath(port), "utf8");
    const parsed = JSON.parse(raw) as PoolState;
    if (typeof parsed.pid === "number" && typeof parsed.pgid === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeState(state: PoolState): void {
  ensureStateDir();
  const path = stateFilePath(state.port);
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(state, null, 2));
  } finally {
    closeSync(fd);
  }
}

function removeState(port: number): void {
  try {
    unlinkSync(stateFilePath(port));
  } catch {
    /* ignore */
  }
}

type Lock = { release: () => void };

async function acquireLock(port: number, timeoutMs: number): Promise<Lock> {
  ensureStateDir();
  const path = lockFilePath(port);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release: () => {
          try { unlinkSync(path); } catch { /* ignore */ }
        },
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      // Held by someone — check if that someone is still alive
      let heldByPid = 0;
      try { heldByPid = parseInt(readFileSync(path, "utf8").trim(), 10) || 0; } catch { /* ignore */ }
      if (heldByPid > 0 && !isPidAlive(heldByPid)) {
        try { unlinkSync(path); } catch { /* race ok */ }
        continue;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`serena-pool: could not acquire lock ${path} within ${timeoutMs}ms`);
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

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Reap orphaned LSP children left by a dead Serena daemon.
 * Safety: we only signal processes whose pgid matches the recorded one AND
 * whose controlling Serena (pid+startTime) is verifiably dead. The kernel
 * guarantees nothing else can be in that process group unless it was a
 * descendant of our spawned Serena.
 */
async function reapOrphansIfDaemonDead(state: PoolState): Promise<void> {
  if (isSameProcess(state.pid, state.startTime)) return; // daemon still alive — abort
  const candidates = findProcessesByPgid(state.pgid);
  if (candidates.length === 0) return;
  for (const c of candidates) tryKill(c.pid, "SIGTERM");
  await new Promise((r) => setTimeout(r, ORPHAN_TERM_GRACE_MS));
  const stragglers = findProcessesByPgid(state.pgid);
  for (const s of stragglers) tryKill(s.pid, "SIGKILL");
}

async function spawnSerena(projectRoot: string, port: number, instanceId: string): Promise<number> {
  const child = spawn(
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
      env: {
        ...process.env,
        SERENA_POOL_INSTANCE_ID: instanceId,
        SERENA_POOL_ROOT: projectRoot,
        SERENA_POOL_PORT: String(port),
      },
      stdio: "ignore",
      detached: true,
    },
  );
  child.unref();
  if (!child.pid) throw new Error("serena-pool: spawn returned no pid");
  return child.pid;
}

async function ensureSerenaForRoot(projectRoot: string): Promise<number | null> {
  const port = hashToPort(projectRoot);

  // Fast path: someone already serving on this port. Trust it.
  if (await isPortListening(port)) return port;

  const lock = await acquireLock(port, LOCK_TIMEOUT_MS);
  try {
    // Re-check under the lock — another concurrent spawner may have won.
    if (await isPortListening(port)) return port;

    // Reap orphans from a previously-recorded dead daemon, if any.
    const prior = readState(port);
    if (prior) {
      await reapOrphansIfDaemonDead(prior);
      removeState(port);
    }

    // Spawn fresh Serena. Detached → new process group, pgid == pid.
    const instanceId = randomUUID();
    const pid = await spawnSerena(projectRoot, port, instanceId);
    const startTime = getProcessStartTime(pid);
    writeState({
      pid,
      pgid: pid, // detached process is a new group leader
      startTime,
      instanceId,
      projectRoot,
      port,
      spawnedAt: Date.now(),
    });

    const ready = await waitForPort(port, STARTUP_TIMEOUT_MS);
    if (!ready) {
      console.warn(`[serena-pool] Serena did not become healthy on port ${port} within ${STARTUP_TIMEOUT_MS}ms (pid=${pid})`);
      return null;
    }
    return port;
  } finally {
    lock.release();
  }
}

export default function registerSerenaPool(pi: ExtensionAPI) {
  pi.on("session_start", async (_event: unknown, ctx: any) => {
    const cwd: string = ctx?.cwd ?? process.cwd();
    let projectRoot: string;
    try {
      projectRoot = getRepoRoot(cwd);
    } catch (err) {
      console.warn("[serena-pool] failed to resolve repo root:", err);
      return;
    }

    try {
      const port = await ensureSerenaForRoot(projectRoot);
      if (port != null) process.env.SERENA_MCP_PORT = String(port);
    } catch (err) {
      console.warn("[serena-pool] failed to ensure Serena running:", err);
    }
  });

  // No session_shutdown handler — Serena persists as a daemon across sessions.
  // Next session_start that finds the port dead will reap orphans via PGID.
}
