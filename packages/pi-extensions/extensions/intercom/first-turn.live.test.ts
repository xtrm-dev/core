/**
 * Live first-turn acceptance (CORE-2438 I7): the I5 gap.
 *
 * A real `pi --print` session starts with an initial prompt while a slow
 * before_agent_start hook (registered before intercom, so the bridge has not
 * seen before_agent_start yet) pushes the first turn past the 1.5 s grace. A
 * wake sent into that gap must hold — never inject with triggerTurn into the
 * starting run — and flush at agent_start with no "Agent is already
 * processing" error anywhere.
 *
 * Opt-in: INTERCOM_FIRST_TURN_LIVE=1 (needs the `pi` binary, a ready model,
 * and the built workspace). Skipped loudly otherwise, like the I3 live test
 * and the EOF integration test. Never fakes success.
 */

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LIVE = process.env.INTERCOM_FIRST_TURN_LIVE === "1";
const MODEL = process.env.INTERCOM_FIRST_TURN_MODEL ?? "commandcode/deepseek-v4.1-flash";
const liveTest = LIVE ? test : test.skip;

const { startAgentHost } = await import("../../../../cli/src/core/agent-host.ts");

const until = async (check: () => boolean, ms: number) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("first-turn gap live acceptance (CORE-2438 I7)", () => {
  liveTest(
    "a wake in the session_start-to-first-turn gap holds and delivers without already-processing",
    async () => {
      const piCheck = spawnSync("which", ["pi"], { encoding: "utf-8" });
      expect(piCheck.status).toBe(0);
      const dir = mkdtempSync(path.join(os.tmpdir(), "i7-first-turn-live-"));
      const cacheDir = path.join(os.homedir(), ".cache", "CORE-2438");
      mkdirSync(cacheDir, { recursive: true });
      const host = await startAgentHost({
        socketPath: path.join(dir, "host.sock"),
        infoPath: path.join(dir, "host.json"),
        log: () => {},
      });
      const frames: Array<{ payload: { type?: string; commandId?: string; status?: string; reason?: string } }> = [];
      host.registry.subscribe((f: { payload?: unknown }) => frames.push(f as never));
      let child: ReturnType<typeof spawn> | null = null;
      try {
        // Slow hook FIRST: its before_agent_start handler awaits 3 s before
        // the bridge sees before_agent_start, so the gap outlives the grace.
        writeFileSync(
          path.join(dir, "slow-hook.ts"),
          [
            "export default function slowFirstTurnHook(pi: { on: (event: string, handler: () => Promise<void>) => void }): void {",
            "  pi.on(\"before_agent_start\", async () => {",
            "    await new Promise((r) => setTimeout(r, 3000));",
            "  });",
            "}",
            "",
          ].join("\n"),
        );
        const worktree = path.resolve(import.meta.dir, "../../../..");
        const intercomEntry = path.join(worktree, "packages", "pi-extensions", "extensions", "intercom", "index.ts");
        expect(existsSync(intercomEntry)).toBe(true);
        const sessionDir = path.join(dir, "sessions");
        mkdirSync(sessionDir, { recursive: true });
        const startedAt = Date.now();
        child = spawn(
          "pi",
          [
            "--print",
            "--no-session",
            "--session-dir",
            sessionDir,
            "--model",
            MODEL,
            "--name",
            "e2e-first-turn",
            "-e",
            path.join(dir, "slow-hook.ts"),
            "-e",
            intercomEntry,
            "Reply with exactly the word ok and nothing else.",
          ],
          {
            cwd: dir,
            env: {
              ...process.env,
              XTRM_AGENT_HOST_SOCKET: path.join(dir, "host.sock"),
              NO_COLOR: "1",
              PI_OFFLINE: undefined,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        const exit = new Promise<number>((resolve) => child?.on("close", (code) => resolve(code ?? -1)));

        // The live session registers through the real bridge.
        await until(() => host.registry.list().length >= 1, 60_000);
        const registeredAt = Date.now();
        // Into the gap: past the 1.5 s grace, before the slowed first turn.
        const gapWait = Math.max(0, 2200 - (registeredAt - startedAt));
        await new Promise((r) => setTimeout(r, gapWait));
        const agentStarted = frames.some((f) => f.payload?.type === "agent_start");
        expect(agentStarted).toBe(false);
        // The probe wake carries a real sender so its reply line resolves
        // instead of rendering to="unknown" (CORE-2438 review). Replies
        // route to this worker's holder, not to the dispatcher session.
        const wake = host.registry.wake("e2e-first-turn", "CORE-2438 live first-turn probe", {
          messageId: `m-live-first-turn`,
          from: "CORE-2438-events",
          fromName: "CORE-2438-events",
        });
        // Held first: the bridge has seen no before_agent_start, so the
        // initial-prompt hold (not the starting window) owns the wake.
        await until(
          () =>
            frames.some(
              (f) => f.payload?.type === "command_result" && f.payload?.commandId === wake.messageId,
            ),
          15_000,
        );
        const firstAnswer = frames.find((f) => f.payload?.type === "command_result" && f.payload?.commandId === wake.messageId);
        expect(firstAnswer?.payload?.status).toBe("rejected");
        expect(firstAnswer?.payload?.reason).toBe("held");
        // The slowed first turn starts, flushes the held wake, and the print
        // run exits. The wake settles delivered.
        await until(() => host.registry.wakeStatus(wake.messageId)?.state === "delivered", 90_000);
        const code = await exit;
        const transcript = `exit=${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
        writeFileSync(path.join(cacheDir, "first-turn-live-transcript.txt"), transcript);
        expect(stderr).not.toContain("Agent is already processing");
        expect(stdout).not.toContain("Agent is already processing");
        expect(code).toBe(0);
        const excerpt = transcript.slice(-1500);
        console.log(`[first-turn-live] wake ${wake.messageId} delivered; transcript tail:\n${excerpt}`);
      } finally {
        try {
          child?.kill();
        } catch {
          /* already exited */
        }
        await host.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  test.if(!LIVE)("skipped: set INTERCOM_FIRST_TURN_LIVE=1 to run the live first-turn acceptance", () => {
    expect(true).toBe(true);
  });
});
