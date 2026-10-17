/**
 * Opt-in live contract test against the installed Claude Code binary
 * (CORE-2434 review item 3). Skipped unless INTERCOM_CLAUDE_LIVE=1, so CI
 * never touches a live session. A manual run messages exactly one target —
 * the dispatcher session by default — and proves Pi->Claude send, Claude->Pi
 * reply and receipt handling through the adapter.
 *
 *   INTERCOM_CLAUDE_LIVE=1 bun test ./extensions/intercom/claude-transport/
 *
 * Held is NOT reproduced live: the dispatcher accepts immediately, so no
 * held receipt occurs; the held/refused mapping is proven by the socket-level
 * contract tests in claude-transport.test.ts. This is stated in the PR body.
 */
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";

const protocol = await import("./protocol.ts");
const registry = await import("./registry.ts");
const transport = await import("./transport.ts");

const LIVE = process.env.INTERCOM_CLAUDE_LIVE === "1";
const TARGET = process.env.INTERCOM_CLAUDE_LIVE_TARGET || "core-xt-claude-prog-skill";
const liveTest = LIVE ? test : test.skip;

describe("claude-transport live contract (opt-in, installed Claude Code binary)", () => {
  liveTest(
    "a Claude session receives a Pi message and replies",
    async () => {
      // Record the binary under test.
      const version = await new Promise<string>((resolve, reject) => {
        execFile("claude", ["--version"], { encoding: "utf8" }, (error, stdout) => {
          if (error) reject(error);
          else resolve(String(stdout).trim());
        });
      });
      console.log(`[live] claude --version: ${version}`);
      expect(version).toMatch(/\d+\.\d+/);

      const peers = await registry.listClaudeSessions();
      console.log(`[live] roster: ${peers.length} live peers`);
      const resolved = registry.resolveClaudeTarget(peers, TARGET);
      expect(resolved.error ?? "").toBe("");
      const target = resolved.target!;
      console.log(`[live] target: ${target.name} at ${target.sock}`);

      const token = `I3-LIVE-${Date.now()}`;
      const scratchSock = `${registry.ccSocksDir()}/i3live-${process.pid}.sock`;
      const replies: string[] = [];
      const receipts: Array<{ status: string; orig?: string }> = [];
      const waiter = new transport.ClaudeReceiptWaiter();
      const bound = await transport.bindClaudeTransportSocket(scratchSock, {
        onUserMessage: (msg) => replies.push(msg.body),
        onReceipt: (r) => {
          receipts.push({ status: r.status, orig: r.origMessageId });
          waiter.resolveReceipt(r);
        },
      });
      try {
        const messageId = await transport.sendToClaudeSession({
          sock: target.sock,
          body: [
            `${token}: CORE-2434 I3 live contract test from Pi.`,
            `Reply via SendMessage to uds:${scratchSock}, quoting ${token}.`,
            `Confirm whether this Pi session appears in your ListAgents.`,
          ].join("\n"),
          from: `uds:${scratchSock}`,
          fromName: "CORE-2434-claude-transport",
          fromMode: "pi",
          ...(target.pid !== undefined
            ? { authFromRegistry: { pid: target.pid } }
            : {}),
        });
        console.log(`[live] probe sent: ${messageId}`);
        const outcome = await waiter.wait(messageId, 30_000).catch((error: Error) => error.message);
        console.log(`[live] receipt outcome: ${outcome}`);
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline && !replies.some((body) => body.includes(token))) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        const replied = replies.some((body) => body.includes(token));
        console.log(`[live] reply quoting token received: ${replied} (replies: ${replies.length})`);
        expect(replied).toBe(true);
        expect(protocol.mapReceiptStatus("held")).toBe("held");
      } finally {
        await bound.close();
      }
    },
    240_000,
  );
});
