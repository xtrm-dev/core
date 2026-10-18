/**
 * Intercom end-to-end suite through the shared event module (CORE-2438 I7).
 *
 * Every test runs the real agent host and the real extension code
 * in-process: Pi to Pi, Pi to Claude, Claude to Pi, and the
 * specialist-dispatch regression (SPECIALISTS-4301). Claude legs use a
 * scratch Claude socket and sessions dir, as I3's tests do; the live Claude
 * binary stays opt-in (claude-transport.live.test.ts). No test messages a
 * real session.
 *
 * Each leg asserts both renderings: the model envelope (D1-D3, no ANSI, D2
 * provenance, operator preview stays out of it) and the operator card (D4)
 * through the renderer's own width-aware render path.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const { default: intercomExtension, resolveIntercomCard } = await import("./index.ts");
const sendmessage = await import("./sendmessage.ts");
const { fetchPiSessions } = await import("./roster.ts");
const claudeAdapter = await import("./claude-transport/index.ts");
const transport = await import("./claude-transport/transport.ts");
const claudeRegistry = await import("./claude-transport/registry.ts");
const { startAgentHost } = await import("../../../../cli/src/core/agent-host.ts");

type Handler = (event: unknown, ctx: unknown) => unknown;
type Renderer = (message: unknown, options: unknown, theme: unknown) => unknown;

const until = async (check: () => boolean, ms = 8000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

function tagTheme(mode: string) {
  return {
    fg: (token: string, text: string) => `<${mode}:${token}>${text}</${mode}:${token}>`,
    bold: (text: string) => `<${mode}:bold>${text}</${mode}:bold>`,
  };
}

function visible(lines: string | string[]): string[] {
  const all = Array.isArray(lines) ? lines : lines.split("\n");
  // eslint-disable-next-line no-control-regex
  return all.map((l) => l.replace(/<[^>]+>/g, "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
}

/** Full fake Pi surface: everything intercomExtension touches at registration. */
function fullFakePi(sessionName: string) {
  const handlers = new Map<string, Handler[]>();
  const sentCustom: Array<{ message: unknown; options?: unknown }> = [];
  const tools: Record<string, { execute: (...args: never[]) => Promise<never> }> = {};
  const renderers = new Map<string, Renderer>();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    sendUserMessage: () => {},
    sendMessage(message: unknown, options?: unknown) {
      sentCustom.push({ message, options });
    },
    getSessionName: () => sessionName,
    getSettings: () => ({}),
    getThinkingLevel: () => "medium",
    getAllTools: () => [],
    registerTool: (tool: { name: string }) => {
      tools[tool.name] = tool as never;
    },
    registerCommand: () => {},
    setSessionName: () => {},
    registerMessageRenderer: (type: string, fn: Renderer) => {
      renderers.set(type, fn);
    },
  };
  const fire = (name: string, event: unknown, ctx: unknown) => {
    for (const handler of handlers.get(name) ?? []) handler({ type: name, ...(event as object) }, ctx);
  };
  return { pi: pi as never, tools, renderers, sentCustom, fire };
}

function sessionCtx(sessionId: string, idle = true) {
  return {
    cwd: "/tmp/e2e",
    hasUI: false,
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl` },
    isIdle: () => idle,
    abort: () => {},
  } as never;
}

function renderCard(
  renderers: Map<string, Renderer>,
  type: string,
  message: unknown,
  width: number,
): string[] {
  const renderer = renderers.get(type) as unknown as (
    message: unknown,
    options: unknown,
    theme: unknown,
  ) => { render: (width: number) => string[] };
  if (!renderer) throw new Error(`no renderer for ${type}`);
  return visible(renderer(message, {}, tagTheme("dark")).render(width));
}

describe("event end-to-end through the shared module (CORE-2438 I7)", () => {
  test(
    "Pi to Pi: a real SendMessage delivers, and the receiver card previews it",
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "i7-e2e-pipi-"));
      const host = await startAgentHost({
        socketPath: path.join(dir, "host.sock"),
        infoPath: path.join(dir, "host.json"),
        log: () => {},
      });
      try {
        sendmessage.__resetSendMessageState();
        const receiver = fullFakePi("e2ebob");
        intercomExtension(receiver.pi, {
          socketPath: host.info.socket,
          exec: async () => "",
          env: {},
          claudeTransportEnabled: false,
        });
        const rctx = sessionCtx("s-e2e-bob");
        receiver.fire("session_start", { reason: "startup" }, rctx);
        await until(() => host.registry.list().length === 1);
        receiver.fire("agent_start", {}, rctx);

        const sender = fullFakePi("coordinator");
        let n = 0;
        sendmessage.registerSendMessageTool(sender.pi, {
          infoPath: path.join(dir, "host.json"),
          fetchPi: () => fetchPiSessions({ address: host.info.address, port: host.info.port }),
          fetchClaude: async () => [],
          randomId: () => `m-e2e-${++n}`,
        });
        const tool = sender.tools.SendMessage as unknown as {
          execute: (...args: never[]) => Promise<{ content: Array<{ text: string }> }>;
        };
        const senderCtx = {
          cwd: "/tmp/e2e",
          sessionManager: { getSessionId: () => "s-e2e-sender" },
        } as never;
        const r = await tool.execute("c1", { to: "e2ebob", message: "hello e2e" }, undefined, undefined, senderCtx);
        expect(String(r.content[0].text)).toContain("Delivered to Pi session e2ebob");

        const injected = receiver.sentCustom.filter(
          (s) => (s.message as { customType?: string })?.customType === "intercom_message",
        );
        expect(injected).toHaveLength(1);
        const content = String((injected[0].message as { content?: unknown })?.content ?? "");
        expect(content).toContain("hello e2e");
        expect(content).toContain("Injected context, not the operator's words.");
        expect(content).not.toMatch(/\u001b/);
        expect(content).not.toContain("› Message");

        const lines = renderCard(receiver.renderers, "intercom_message", injected[0].message, 80);
        expect(lines[0]).toBe("● @coordinator delivered");
        expect(lines[1]).toBe("  › Message from @coordinator: hello e2e  m-e2e-1");
      } finally {
        await host.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "Pi to Claude: the real transport delivers to a scratch peer and maps its receipt",
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "i7-e2e-piclaude-"));
      // The fake peer needs a live foreign pid: our own pid is self-excluded
      // from the roster, and a dead pid fails the pid-reuse guard.
      const sleeper = (await import("node:child_process")).spawn("sleep", ["120"]);
      const peerPid = sleeper.pid as number;
      const sessionsDir = path.join(dir, "sessions");
      const peerDir = path.join(dir, "peers");
      await import("node:fs").then((fs) => {
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.mkdirSync(peerDir, { recursive: true });
      });
      const piSock = path.join(dir, "pi.sock");
      const peerSock = path.join(dir, "cass.sock");
      const got: Array<{ messageId: string; body: string }> = [];
      const peer = await transport.bindClaudeTransportSocket(peerSock, {
        onUserMessage: (msg) => {
          got.push({ messageId: msg.messageId, body: msg.body });
          void transport.ackClaudeMessage(piSock, "delivered", { origMessageId: msg.messageId });
        },
      });
      try {
        writeFileSync(
          path.join(peerDir, `${peerPid}.json`),
          JSON.stringify({
            pid: peerPid,
            name: "cass",
            status: "idle",
            cwd: "/tmp",
            messagingSocketPath: peerSock,
          }),
        );
        sendmessage.__resetSendMessageState();
        const sender = fullFakePi("coordinator");
        claudeAdapter.default(sender.pi, { socketPath: piSock, sessionsDir, enabled: true });
        sender.fire("session_start", { reason: "startup" }, sessionCtx("s-e2e-pi"));
        await until(() => existsSync(piSock));
        sendmessage.registerSendMessageTool(sender.pi, {
          fetchPi: async () => [],
          fetchClaude: () => claudeRegistry.listClaudeSessions({ sessionsDir: peerDir }),
          claudeTransportEnabled: true,
          randomId: (() => {
            let n = 0;
            return () => `m-e2e-c${++n}`;
          })(),
        });
        const tool = sender.tools.SendMessage as unknown as {
          execute: (...args: never[]) => Promise<{ content: Array<{ text: string }> }>;
        };
        const senderCtx = {
          cwd: "/tmp/e2e",
          sessionManager: { getSessionId: () => "s-e2e-sender" },
        } as never;
        const r = await tool.execute("c1", { to: "cass", message: "hello claude" }, undefined, undefined, senderCtx);
        expect(String(r.content[0].text)).toContain("Delivered to Claude session cass");
        expect(got).toHaveLength(1);
        expect(got[0].body).toContain("hello claude");
        expect(String(r.content[0].text)).not.toMatch(/\u001b/);
      } finally {
        try {
          sleeper.kill();
        } catch {
          /* already gone */
        }
        await peer.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "Claude to Pi: a scratch peer frame injects, acks delivered, and cards",
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "i7-e2e-claudepi-"));
      const host = await startAgentHost({
        socketPath: path.join(dir, "host.sock"),
        infoPath: path.join(dir, "host.json"),
        log: () => {},
      });
      const piSock = path.join(dir, "pi.sock");
      try {
        sendmessage.__resetSendMessageState();
        const receiver = fullFakePi("e2ebob");
        intercomExtension(receiver.pi, {
          socketPath: host.info.socket,
          exec: async () => "",
          env: {},
          claudeSocketPath: piSock,
          claudeSessionsDir: dir,
          claudeTransportEnabled: true,
        });
        const rctx = sessionCtx("s-e2e-c2p");
        receiver.fire("session_start", { reason: "startup" }, rctx);
        await until(() => host.registry.list().length === 1);

        const acked: string[] = [];
        const sink = await transport.bindClaudeTransportSocket(path.join(dir, "sink.sock"), {
          onReceipt: (receipt) => {
            if (receipt.origMessageId) acked.push(`${receipt.status}:${receipt.origMessageId}`);
          },
        });
        try {
          await transport.sendToClaudeSession({
            sock: piSock,
            body: "hello from claude",
            from: `uds:${path.join(dir, "sink.sock")}`,
            fromName: "cass",
            messageId: "m-c2p-1",
          });
          await until(() => receiver.sentCustom.length >= 1);
          const injected = receiver.sentCustom[0].message as { customType?: string; content?: unknown };
          expect(injected.customType).toBe("intercom_message");
          const content = String(injected.content ?? "");
          expect(content).toContain("hello from claude");
          expect(content).toContain("Injected context, not the operator's words.");
          await until(() => acked.length >= 1);
          expect(acked).toEqual(["delivered:m-c2p-1"]);

          const lines = renderCard(receiver.renderers, "intercom_message", injected, 80);
          expect(lines[0]).toBe("● @cass delivered");
          expect(lines[1]).toBe("  › Message from @cass: hello from claude  m-c2p-1");
        } finally {
          await sink.close();
        }
        receiver.fire("session_shutdown", { reason: "quit" }, rctx);
      } finally {
        await host.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "specialist dispatch keeps the parent listener: the parent still receives and cards (SPECIALISTS-4301)",
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "i7-e2e-spec-"));
      const host = await startAgentHost({
        socketPath: path.join(dir, "host.sock"),
        infoPath: path.join(dir, "host.json"),
        log: () => {},
      });
      try {
        sendmessage.__resetSendMessageState();
        const pi = fullFakePi("parent");
        intercomExtension(pi.pi, {
          socketPath: host.info.socket,
          exec: async () => "",
          env: {},
          claudeTransportEnabled: false,
        });
        const parent = sessionCtx("s-parent");
        const child = sessionCtx("s-child");
        pi.fire("session_start", { reason: "startup" }, parent);
        await until(() => host.registry.list().length === 1);
        pi.fire("session_start", { reason: "startup" }, child);
        await until(() => host.registry.list().length === 2);
        pi.fire("session_shutdown", { reason: "quit" }, child);
        await until(() => host.registry.list().length === 1);

        const wake = host.registry.wake("s-parent", "CORE-2438");
        expect(wake.messageId).toBeTruthy();
        await until(() => host.registry.wakeStatus(wake.messageId)?.state === "delivered");
        const injected = pi.sentCustom.filter(
          (s) => (s.message as { customType?: string })?.customType === "intercom_message",
        );
        expect(injected).toHaveLength(1);
        expect(resolveIntercomCard(injected[0].message)).toMatchObject({ kind: "message", state: "delivered" });
        const lines = renderCard(pi.renderers, "intercom_message", injected[0].message, 120);
        expect(lines[0][0]).toBe("●");
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
        pi.fire("session_shutdown", { reason: "quit" }, parent);
      } finally {
        await host.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
