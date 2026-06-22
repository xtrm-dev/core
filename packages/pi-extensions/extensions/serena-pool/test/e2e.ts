#!/usr/bin/env -S npx tsx
/**
 * E2E driver for serena-pool. Exercises the state machine without Pi.
 *
 * Usage:
 *   DEBUG=serena-pool npx tsx extensions/serena-pool/test/e2e.ts
 *   DEBUG=serena-pool bun extensions/serena-pool/test/e2e.ts
 *
 * Requires: `uvx` on PATH (the real Serena spawn path is exercised).
 *
 * Six scenarios:
 *   1. cold start         — clean slate → spawn, port listens, state written
 *   2. warm reuse         — second call → same pid, same state
 *   3. dead recovery      — kill Serena → next call spawns fresh
 *   4. synthetic orphans  — fake state pointing at a detached `sleep` group
 *                           with dead leader → cleanup kills group members
 *   5. concurrent spawn   — 5 parallel calls → exactly one Serena alive
 *   6. cwd-race           — stale ctx.cwd (parent repo) vs live process.cwd()
 *                           (linked worktree) → daemon binds to the worktree,
 *                           no orphan against the parent. Uses real
 *                           `git worktree add`.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import registerSerenaPool, {
  ensureSerenaForRoot,
  STATE_DIR,
  __internals as I,
  type PoolState,
} from "../index.ts";

let testsPassed = 0;
let testsFailed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    testsPassed++;
  } else {
    console.log(`  ✗ ${msg}`);
    testsFailed++;
  }
}

function header(name: string): void {
  console.log(`\n── ${name} ──`);
}

function cleanState(): void {
  if (!existsSync(STATE_DIR)) return;
  for (const f of readdirSync(STATE_DIR)) {
    try { rmSync(join(STATE_DIR, f), { force: true }); } catch { /* ignore */ }
  }
}

function killSerenaForPort(port: number): void {
  const state = I.readState(port);
  if (!state) return;
  try { process.kill(-state.pgid, "SIGKILL"); } catch { /* ignore */ }
  try { process.kill(state.pid, "SIGKILL"); } catch { /* ignore */ }
  I.removeState(port);
}

function preflight(): boolean {
  const uvx = spawnSync("which", ["uvx"], { encoding: "utf8" });
  if (uvx.status !== 0 || !uvx.stdout.trim()) {
    console.error("✗ uvx not on PATH — install uv first: https://docs.astral.sh/uv/");
    return false;
  }
  console.log(`✓ uvx: ${uvx.stdout.trim()}`);
  return true;
}

async function withTestRoot(fn: (root: string, port: number) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "serena-pool-test-"));
  const port = I.hashToPort(root);
  try {
    cleanState();
    await fn(root, port);
  } finally {
    killSerenaForPort(port);
    rmSync(root, { recursive: true, force: true });
  }
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(r.stderr || "").trim()}`);
  }
}

type SessionStartCtx = { cwd?: string };
type SessionStartHandler = (event: unknown, ctx: SessionStartCtx) => Promise<void>;

/** Register the extension against a fake pi and capture its session_start handler. */
function captureSessionStartHandler(): SessionStartHandler {
  let captured: SessionStartHandler | null = null;
  const fakePi = {
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") captured = handler;
    },
  };
  registerSerenaPool(fakePi as never);
  if (!captured) throw new Error("registerSerenaPool did not register a session_start handler");
  return captured;
}

async function test1_coldStart(): Promise<void> {
  header("1. cold start");
  await withTestRoot(async (root, expectedPort) => {
    const port = await ensureSerenaForRoot(root);
    assert(port === expectedPort, `port returned (${port}) === hashToPort(root) (${expectedPort})`);
    assert(port != null && (await I.isPortListening(port)), "port is listening");
    const state = I.readState(port!);
    assert(state != null, "state file written");
    assert(state != null && I.isPidAlive(state.pid), "recorded Serena pid is alive");
    assert(state != null && state.pgid === state.pid, "pgid == pid (detached)");
  });
}

async function test2_warmReuse(): Promise<void> {
  header("2. warm reuse");
  await withTestRoot(async (root) => {
    const port1 = await ensureSerenaForRoot(root);
    const state1 = I.readState(port1!)!;

    const port2 = await ensureSerenaForRoot(root);
    const state2 = I.readState(port2!)!;

    assert(port1 === port2, "same port across calls");
    assert(state1.pid === state2.pid, `same pid (no respawn) — pid=${state1.pid}`);
  });
}

async function test3_deadDaemonRecovery(): Promise<void> {
  header("3. dead-daemon recovery");
  await withTestRoot(async (root) => {
    const port = await ensureSerenaForRoot(root);
    const before = I.readState(port!)!;
    assert(I.isPidAlive(before.pid), `Serena up (pid=${before.pid})`);

    // Kill the whole process group ungracefully
    try { process.kill(-before.pgid, "SIGKILL"); } catch { /* ignore */ }
    try { process.kill(before.pid, "SIGKILL"); } catch { /* ignore */ }
    await sleep(800);
    assert(!I.isPidAlive(before.pid), "Serena killed");
    assert(!(await I.isPortListening(port!)), "port no longer listening");

    const port2 = await ensureSerenaForRoot(root);
    const after = I.readState(port2!)!;
    assert(after.pid !== before.pid, `fresh spawn — new pid=${after.pid}`);
    assert(I.isPidAlive(after.pid), "fresh Serena alive");
    assert(await I.isPortListening(port2!), "port listening again");
  });
}

async function test4_syntheticOrphanCleanup(): Promise<void> {
  header("4. synthetic orphan cleanup");
  await withTestRoot(async (root, port) => {
    // Spawn `bash -c "sleep 9999 & sleep 9999 & wait"` detached so bash is a new
    // group leader (pgid == bash pid). The two sleeps inherit that pgid.
    const fake = spawn(
      "bash",
      ["-c", "sleep 9999 & sleep 9999 & wait"],
      { detached: true, stdio: "ignore" },
    );
    fake.unref();
    if (!fake.pid) throw new Error("could not spawn fake daemon");
    const fakePid = fake.pid;
    const fakePgid = fakePid;
    await sleep(300);

    const orphansBefore = I.findProcessesByPgid(fakePgid);
    assert(orphansBefore.length >= 2, `2+ children in fake pgid before — found ${orphansBefore.length}`);

    // Inject fake state matching this group, then kill the parent bash so
    // children become orphans (reparented to PID 1, pgid retained).
    const fakeStart = I.getProcessStartTime(fakePid);
    const state: PoolState = {
      pid: fakePid, pgid: fakePgid, startTime: fakeStart,
      instanceId: "synthetic-test", projectRoot: root, port,
      spawnedAt: Date.now(),
    };
    I.writeState(state);
    process.kill(fakePid, "SIGKILL");
    await sleep(500);
    assert(!I.isPidAlive(fakePid), "fake daemon killed");
    const stillOrphaned = I.findProcessesByPgid(fakePgid);
    assert(stillOrphaned.length >= 2, `children survived parent death — orphans=${stillOrphaned.length}`);

    // Trigger cleanup via the real code path (spawns a real Serena afterwards).
    await ensureSerenaForRoot(root);
    await sleep(500); // allow SIGTERM/SIGKILL fan-out to land

    const orphansAfter = I.findProcessesByPgid(fakePgid);
    assert(orphansAfter.length === 0, `orphans reaped — remaining=${orphansAfter.length}`);
  });
}

async function test5_concurrentSpawn(): Promise<void> {
  header("5. concurrent spawn");
  await withTestRoot(async (root) => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureSerenaForRoot(root)),
    );
    const unique = new Set(results);
    assert(unique.size === 1, `all 5 calls returned the same port — got ${unique.size} unique`);

    // Count actual Serena processes for this port.
    const port = results[0]!;
    const state = I.readState(port)!;
    assert(I.isPidAlive(state.pid), "one Serena alive");

    // Count actual TCP listeners on the port — uvx spawns a python child, so a
    // command-line pattern match would over-count. Only one process binds LISTEN.
    const ssOut = spawnSync("ss", ["-tlnpH"], { encoding: "utf8" }).stdout;
    const listeners = ssOut.split("\n").filter((l) => l.includes(`:${port} `)).length;
    assert(listeners === 1, `exactly one TCP listener on port ${port} — found ${listeners}`);
  });
}

async function test6_cwdRace(): Promise<void> {
  header("6. cwd-race (stale ctx.cwd resolves to live worktree)");
  // Reproduce KAN-110-A: registerSerenaPool fires session_start with a ctx.cwd
  // captured stale as the parent repo, while pi's LIVE process.cwd() is the
  // linked worktree the session is actually running in. Uses a REAL
  // `git worktree add` (not a bare mkdtemp) so git's worktree semantics are
  // exercised end-to-end.
  const tmpBase = mkdtempSync(join(tmpdir(), "serena-pool-race-"));
  const parent = join(tmpBase, "parent");
  const worktreeAbs = join(tmpBase, "wt");
  mkdirSync(parent, { recursive: true });

  const spawnedPorts: number[] = [];
  const prevCwd = process.cwd();
  const prevEnvPort = process.env.SERENA_MCP_PORT;
  try {
    cleanState();
    git(parent, ["init", "-q"]);
    git(parent, ["config", "user.email", "serena-pool-e2e@xtrm.local"]);
    git(parent, ["config", "user.name", "serena-pool e2e"]);
    git(parent, ["commit", "--allow-empty", "-q", "-m", "init"]);
    // REAL linked worktree — git creates worktreeAbs.
    git(parent, ["worktree", "add", "-q", worktreeAbs]);

    const parentReal = realpathSync(parent);
    const worktreeReal = realpathSync(worktreeAbs);
    const expectedPort = I.hashToPort(worktreeReal);
    const parentPort = I.hashToPort(parentReal);
    spawnedPorts.push(expectedPort, parentPort);
    assert(
      expectedPort !== parentPort,
      `worktree port (${expectedPort}) differs from parent port (${parentPort})`,
    );

    // Simulate the race: pi's LIVE cwd is the worktree (launcher guarantee),
    // but ctx.cwd was captured stale as the parent repo.
    process.chdir(worktreeReal);
    const handler = captureSessionStartHandler();
    await handler({}, { cwd: parentReal });

    const state = I.readState(expectedPort);
    assert(state != null, "state written at the worktree's port (not the parent's)");
    assert(
      state != null && state.projectRoot === worktreeReal,
      `daemon --project === worktree root (got ${state?.projectRoot})`,
    );
    assert(
      state != null && state.projectRoot !== parentReal,
      "daemon --project is NOT the stale parent repo",
    );
    assert(state != null && I.isPidAlive(state.pid), "spawned Serena pid alive");

    // No orphan daemon bound to the stale parent's port.
    const orphan = I.readState(parentPort);
    assert(orphan == null, "no daemon state written against the stale parent port");

    // Env wiring reflects the worktree port.
    assert(
      process.env.SERENA_MCP_PORT === String(expectedPort),
      `SERENA_MCP_PORT wired to worktree port ${expectedPort}`,
    );
  } finally {
    for (const p of spawnedPorts) killSerenaForPort(p);
    try { process.chdir(prevCwd); } catch { /* ignore */ }
    try { git(parent, ["worktree", "remove", "--force", worktreeAbs]); } catch { /* parent may be gone */ }
    rmSync(tmpBase, { recursive: true, force: true });
    if (prevEnvPort === undefined) delete process.env.SERENA_MCP_PORT;
    else process.env.SERENA_MCP_PORT = prevEnvPort;
  }
}

async function main(): Promise<void> {
  console.log("serena-pool e2e driver\n");
  if (!preflight()) process.exit(2);

  const tests = [
    test1_coldStart,
    test2_warmReuse,
    test3_deadDaemonRecovery,
    test4_syntheticOrphanCleanup,
    test5_concurrentSpawn,
    test6_cwdRace,
  ];

  for (const t of tests) {
    try {
      await t();
    } catch (err) {
      console.error(`  ✗ test threw: ${err instanceof Error ? err.message : err}`);
      testsFailed++;
    }
  }

  console.log(`\n────────────────────────────────`);
  console.log(`passed: ${testsPassed}   failed: ${testsFailed}`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(2);
});
