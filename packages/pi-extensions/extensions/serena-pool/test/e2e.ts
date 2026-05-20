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
 * Five scenarios:
 *   1. cold start         — clean slate → spawn, port listens, state written
 *   2. warm reuse         — second call → same pid, same state
 *   3. dead recovery      — kill Serena → next call spawns fresh
 *   4. synthetic orphans  — fake state pointing at a detached `sleep` group
 *                           with dead leader → cleanup kills group members
 *   5. concurrent spawn   — 5 parallel calls → exactly one Serena alive
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
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

async function main(): Promise<void> {
  console.log("serena-pool e2e driver\n");
  if (!preflight()) process.exit(2);

  const tests = [
    test1_coldStart,
    test2_warmReuse,
    test3_deadDaemonRecovery,
    test4_syntheticOrphanCleanup,
    test5_concurrentSpawn,
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
