/**
 * Agent-host self-healing (CORE-2467 A+B): probe, bounded background
 * ensure, single-flight, loud failure. Never spawns real processes:
 * the spawn seam is always stubbed.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ensure = await import("./host-ensure.ts");

beforeEach(() => {
  ensure.__resetHostEnsureState();
});

async function liveSocket(): Promise<{ dir: string; sock: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "host-ensure-"));
  const sock = path.join(dir, "agent-host.sock");
  const server = net.createServer(() => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => resolve());
  });
  return { dir, sock, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("probeAgentHostSocket", () => {
  test("true on a listening socket, false on a dead path", async () => {
    const live = await liveSocket();
    try {
      expect(await ensure.probeAgentHostSocket(live.sock, 500)).toBe(true);
      expect(await ensure.probeAgentHostSocket(path.join(live.dir, "missing.sock"), 500)).toBe(false);
    } finally {
      await live.close();
      rmSync(live.dir, { recursive: true, force: true });
    }
  });
});

describe("monitorAgentHostSession", () => {
  test("a healthy socket never spawns", async () => {
    const live = await liveSocket();
    try {
      let calls = 0;
      const notified: string[] = [];
      ensure.monitorAgentHostSession(
        { notify: (line) => notified.push(line) },
        { enabled: true, socketPath: live.sock, runEnsure: async () => ({ ok: ++calls > 0, detail: "" }) },
      );
      await sleep(50);
      expect(calls).toBe(0);
      expect(notified).toEqual([]);
    } finally {
      await live.close();
      rmSync(live.dir, { recursive: true, force: true });
    }
  });

  test("concurrent starts single-flight: one spawn", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "host-ensure-flight-"));
    const sock = path.join(dir, "agent-host.sock");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const notified: string[] = [];
    try {
      const runEnsure = async () => {
        calls += 1;
        await gate;
        return { ok: false, detail: "boom" };
      };
      ensure.monitorAgentHostSession({ notify: (l) => notified.push(l) }, { enabled: true, socketPath: sock, runEnsure });
      ensure.monitorAgentHostSession({ notify: (l) => notified.push(l) }, { enabled: true, socketPath: sock, runEnsure });
      await sleep(30);
      expect(calls).toBe(1);
      release();
      await sleep(50);
      expect(calls).toBe(1);
      expect(notified).toHaveLength(1);
      expect(notified[0]).toMatch(/xt host ensure/);
    } finally {
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spawn failure warns loudly once, then retries on the next start", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "host-ensure-fail-"));
    const sock = path.join(dir, "agent-host.sock");
    let calls = 0;
    const notified: string[] = [];
    try {
      const opts = {
        enabled: true,
        socketPath: sock,
        runEnsure: async () => ({ ok: false, detail: `nope-${++calls}` }),
      };
      ensure.monitorAgentHostSession({ notify: (l) => notified.push(l) }, opts);
      await sleep(50);
      ensure.monitorAgentHostSession({ notify: (l) => notified.push(l) }, opts);
      await sleep(50);
      expect(calls).toBe(2);
      expect(notified).toHaveLength(1);
      expect(notified[0]).toMatch(/agent host is not running/);
      expect(notified[0]).toContain("nope-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a spawn that heals the socket stays silent", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "host-ensure-heal-"));
    const sock = path.join(dir, "agent-host.sock");
    const notified: string[] = [];
    let server: net.Server | null = null;
    try {
      const runEnsure = async () => {
        server = net.createServer(() => {});
        await new Promise<void>((resolve, reject) => {
          server!.once("error", reject);
          server!.listen(sock, () => resolve());
        });
        return { ok: true, detail: "started" };
      };
      ensure.monitorAgentHostSession({ notify: (l) => notified.push(l) }, { enabled: true, socketPath: sock, runEnsure });
      await sleep(100);
      expect(notified).toEqual([]);
      // Healthy now: further starts never spawn again.
      let calls = 0;
      ensure.monitorAgentHostSession({ notify: (l) => notified.push(l) }, { enabled: true, socketPath: sock, runEnsure: async () => ({ ok: ++calls > 0, detail: "" }) });
      await sleep(50);
      expect(calls).toBe(0);
    } finally {
      if (server) await new Promise((r) => (server as net.Server).close(() => r(undefined)));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("disabled is a no-op and the default command is xt host ensure", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "host-ensure-off-"));
    const sock = path.join(dir, "agent-host.sock");
    const seen: string[][] = [];
    try {
      ensure.monitorAgentHostSession({ notify: () => {} }, { socketPath: sock, runEnsure: async () => ({ ok: true, detail: "" }) });
      await sleep(30);
      let seenTimeout = 0;
      ensure.monitorAgentHostSession(
        { notify: () => {} },
        {
          enabled: true,
          socketPath: sock,
          runEnsure: async (command, timeoutMs) => {
            seen.push(command);
            seenTimeout = timeoutMs;
            return { ok: false, detail: "x" };
          },
        },
      );
      await sleep(50);
      expect(seen).toEqual([["xt", "host", "ensure"]]);
      expect(seenTimeout).toBe(20000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("self-heal re-arms after the first healthy probe (CORE-2554 E3)", () => {
  test("a host that dies after a healthy start is ensured again once re-armed", async () => {
    const live = await liveSocket();
    let calls = 0;
    const runEnsure = async () => {
      calls += 1;
      return { ok: false, detail: "down" };
    };
    try {
      ensure.monitorAgentHostSession({ notify: () => {} }, { enabled: true, socketPath: live.sock, runEnsure });
      await sleep(50);
      expect(calls).toBe(0);
      await live.close();
      // Inside the recheck window and not re-armed: no probe, no spawn.
      ensure.monitorAgentHostSession({ notify: () => {} }, { enabled: true, socketPath: live.sock, runEnsure });
      await sleep(50);
      expect(calls).toBe(0);
      // The bridge lost its connection: re-armed, the next call ensures.
      ensure.rearmAgentHostEnsure();
      ensure.monitorAgentHostSession({ notify: () => {} }, { enabled: true, socketPath: live.sock, runEnsure });
      await sleep(100);
      expect(calls).toBe(1);
    } finally {
      rmSync(live.dir, { recursive: true, force: true });
    }
  });

  test("the ensure spawn drops session identity", () => {
    expect(ensure.ensureSpawnEnv({ PATH: "/usr/bin", HOME: "/h", SUBSTRATE_HOLDER: "w", XTRM_SESSION_NAME: "s", TMUX_PANE: "%1" })).toEqual({ PATH: "/usr/bin", HOME: "/h" });
  });
});
