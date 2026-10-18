import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

mock.module("@earendil-works/pi-coding-agent", () => ({ VERSION: "1.0.0-test" }));

const { createAgentHostBridge, repositoryFromRemote } = await import("./index.ts");
const { startAgentHost } = await import("../../../../cli/src/core/agent-host.ts");
const { __resetHostEnsureState } = await import("./host-ensure.ts");

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ content: unknown; options?: unknown }> = [];
  const sentCustom: Array<{ message: unknown; options?: unknown }> = [];
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    sendUserMessage(content: unknown, options?: unknown) {
      sent.push({ content, options });
    },
    sendMessage(message: unknown, options?: unknown) {
      sentCustom.push({ message, options });
    },
    getSessionName: () => "probe",
    thinkingLevel: "medium",
    getThinkingLevel(this: { thinkingLevel: string }) {
      return this.thinkingLevel;
    },
    getAllTools: () => [
      { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin", scope: "temporary", origin: "top-level" } },
      {
        name: "mcp__x__y",
        namespace: { name: "mcp__x", description: "x server" },
        sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" },
      },
    ],
  };
  const fire = (name: string, event: any, ctx: any) => {
    for (const handler of handlers.get(name) ?? []) handler({ type: name, ...event }, ctx);
  };
  return { pi: pi as any, sent, sentCustom, fire, handlers, setThinking: (level: string) => (pi.thinkingLevel = level) };
}

function fakeCtx(sessionId: string) {
  let idle = true;
  let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined = { tokens: 1000, contextWindow: 100000, percent: 1 };
  const aborts: number[] = [];
  const localDialogs: Array<{ method: string; signal?: AbortSignal; answer: (value: unknown) => void }> = [];
  const pendingLocal = (method: string, opts: any, value: unknown) =>
    new Promise((resolve) => {
      localDialogs.push({ method, signal: opts?.signal, answer: resolve });
      opts?.signal?.addEventListener("abort", () => resolve(value));
    });
  const ctx = {
    cwd: "/tmp/probe",
    hasUI: true,
    ui: {
      select: (_t: string, _o: string[], opts?: any) => pendingLocal("select", opts, undefined),
      confirm: (_t: string, _m: string, opts?: any) => pendingLocal("confirm", opts, false),
      input: (_t: string, _p?: string, opts?: any) => pendingLocal("input", opts, undefined),
    },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl` },
    isIdle: () => idle,
    abort: () => aborts.push(Date.now()),
    model: { provider: "opencode-go", id: "deepseek-v4.1-flash", contextWindow: 100000 } as any,
    getContextUsage: () => usage,
  };
  return { ctx: ctx as any, setIdle: (v: boolean) => (idle = v), setUsage: (u: typeof usage) => (usage = u), aborts, localDialogs };
}

const until = async (check: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("xtrm-agent-host bridge against the XTRM-563 host", () => {
  let dir: string;
  let host: Awaited<ReturnType<typeof startAgentHost>>;
  let frames: any[];
  let hostLog: string[];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "xtrm-agent-host-ext-"));
    hostLog = [];
    host = await startAgentHost({
      socketPath: path.join(dir, "host.sock"),
      infoPath: path.join(dir, "host.json"),
      log: (m) => hostLog.push(m),
    });
    frames = [];
    host.registry.subscribe((f: any) => frames.push(f));
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(sessionId = "s-1", exec: (file: string, args: string[]) => Promise<string> = async () => "") {
    const pi = fakePi();
    const c = fakeCtx(sessionId);
    const bridge = createAgentHostBridge(pi.pi, { socketPath: host.info.socket, exec, env: {} });
    bridge.register();
    pi.fire("session_start", { reason: "startup" }, c.ctx);
    return { ...pi, ...c, bridge };
  }

  test("pushes identity first, then the lifecycle in order, all schema-valid", async () => {
    const s = start();
    await until(() => s.bridge.state === "open" && frames.length >= 2);
    s.fire("before_agent_start", { prompt: "hi", systemPrompt: "SYS", systemPromptOptions: {} }, s.ctx);
    s.fire("agent_start", {}, s.ctx);
    s.fire("turn_start", { turnIndex: 0, timestamp: 1 }, s.ctx);
    s.fire("message_start", { message: { role: "assistant", content: [] } }, s.ctx);
    for (let i = 0; i < 50; i++) {
      s.fire("message_update", { message: { role: "assistant", content: [{ type: "text", text: "x".repeat(i) }] }, assistantMessageEvent: { type: "text_delta", delta: "x", partial: {} } }, s.ctx);
    }
    s.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, s.ctx);
    s.fire("tool_execution_start", { toolCallId: "t1", toolName: "mcp__x__y", args: { a: 1 }, parentToolCallId: "p0" }, s.ctx);
    s.fire("tool_execution_update", { toolCallId: "t1", toolName: "mcp__x__y", args: { a: 1 }, partialResult: "…" }, s.ctx);
    s.fire("tool_execution_end", { toolCallId: "t1", toolName: "mcp__x__y", result: { ok: true }, isError: false }, s.ctx);
    s.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [], messageEntryId: "e1", toolResultEntryIds: [], entries: [], continue: false }, s.ctx);
    s.fire("session_compact", { reason: "threshold", willRetry: false, fromExtension: false, compactionEntry: { id: "c1" } }, s.ctx);
    s.fire("agent_end", { messages: [{ role: "assistant" }] }, s.ctx);
    s.fire("agent_settled", {}, s.ctx);
    await until(() => frames.some((f) => f.payload.type === "agent_settled"));

    const types = frames.map((f) => f.payload.type);
    expect(types[0]).toBe("session_identity");
    expect(types[1]).toBe("session_status");
    expect(types[2]).toBe("session_start");
    expect(types.filter((t) => t === "message_update").length).toBeLessThan(50);
    const lifecycle = types.filter((t) => t !== "message_update");
    expect(lifecycle).toEqual([
      "session_identity", "session_status", "session_start", "before_agent_start", "agent_start", "turn_start", "message_start", "message_end",
      "tool_execution_start", "tool_execution_end", "turn_end", "session_compact", "agent_end", "agent_settled",
    ]);
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
    expect(hostLog.filter((l) => l.includes("rejected"))).toEqual([]);

    const identity = frames[0].payload;
    expect(identity).toMatchObject({ runtime: { name: "pi", version: "1.0.0-test" }, sessionName: "probe", launch: "terminal" });
    expect(identity.capabilities).toContain("extension_ui");
    expect(frames.find((f) => f.payload.type === "before_agent_start").payload).toEqual({ type: "before_agent_start", prompt: "hi", ingress: { origin: "terminal" } });
    const toolStart = frames.find((f) => f.payload.type === "tool_execution_start").payload;
    expect(toolStart.parentToolCallId).toBe("p0");
    expect(toolStart.tool).toEqual({
      sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" },
      namespace: { name: "mcp__x", description: "x server" },
    });
    const lastUpdate = frames.filter((f) => f.payload.type === "message_update").at(-1).payload;
    expect(lastUpdate.message.content[0].text).toBe("x".repeat(49));
    expect(lastUpdate.assistantMessageEvent.partial).toBeUndefined();
    expect(frames.find((f) => f.payload.type === "agent_end").payload.willRetry).toBeUndefined();
    expect(host.registry.list()[0]).toMatchObject({ sessionId: "s-1", state: "settled", frameCount: 1, extensionConnected: true });
  });

  test("reports model, thinking level and context usage, and again only when they change (XTRM-603)", async () => {
    const s = start();
    const statuses = () => frames.filter((f) => f.payload.type === "session_status").map((f) => f.payload);
    await until(() => statuses().length === 1);
    expect(statuses()[0]).toEqual({
      type: "session_status",
      model: "opencode-go/deepseek-v4.1-flash",
      thinkingLevel: "medium",
      contextUsage: { tokens: 1000, contextWindow: 100000 },
    });
    expect(host.registry.list()[0]).toMatchObject({ model: "opencode-go/deepseek-v4.1-flash", thinkingLevel: "medium", contextUsage: { tokens: 1000, contextWindow: 100000 } });

    // Unchanged state sends nothing; a turn that grew the context does.
    s.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, s.ctx);
    s.setUsage({ tokens: 2500.4, contextWindow: 100000, percent: 2.5 });
    s.fire("turn_end", { turnIndex: 1, message: { role: "assistant" }, toolResults: [] }, s.ctx);
    await until(() => statuses().length === 2);
    expect(statuses()[1].contextUsage).toEqual({ tokens: 2500, contextWindow: 100000 });

    // *_select events report the selected value even before ctx reflects it.
    s.fire("model_select", { model: { provider: "opencode-go", id: "glm-5.1" }, previousModel: s.ctx.model, source: "set" }, s.ctx);
    s.fire("thinking_level_select", { level: "high", previousLevel: "medium" }, s.ctx);
    await until(() => statuses().length === 4);
    expect(statuses()[2].model).toBe("opencode-go/glm-5.1");
    expect(statuses()[3]).toMatchObject({ model: "opencode-go/deepseek-v4.1-flash", thinkingLevel: "high" });

    // After compaction Pi cannot estimate tokens: null travels, the summary drops the meter.
    s.setThinking("high");
    s.setUsage({ tokens: null, contextWindow: 100000, percent: null });
    s.fire("session_compact", { reason: "manual", willRetry: false, fromExtension: false }, s.ctx);
    await until(() => statuses().length === 5);
    expect(statuses()[4].contextUsage).toEqual({ tokens: null, contextWindow: 100000 });
    await until(() => host.registry.list()[0]?.contextUsage === undefined);
    expect(hostLog.filter((l) => l.includes("rejected"))).toEqual([]);
  });

  test("resolves repository owner/name from the origin remote and keeps the main repository path (XTRM-603)", async () => {
    const calls: string[][] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (args.includes("rev-parse")) return "/w/core/.xtrm/worktrees/core-x\n/w/core/.git\n";
      if (args.includes("symbolic-ref")) return "xt/x\n";
      if (args.includes("config")) return "remote.upstream.url https://github.com/up/core.git\nremote.origin.url git@github.com:xtrm-dev/core.git\n";
      return "";
    };
    start("s-1", exec);
    await until(() => frames.length >= 1);
    expect(frames[0].payload).toMatchObject({
      worktree: "/w/core/.xtrm/worktrees/core-x",
      repository: "xtrm-dev/core",
      repositoryPath: "/w/core",
      branch: "xt/x",
    });
    expect(host.registry.list()[0]).toMatchObject({ repository: "xtrm-dev/core", repositoryPath: "/w/core" });
  });

  test("keeps the repository path without a remote", async () => {
    start("s-1", async (_file, args) => (args.includes("rev-parse") ? "/w/solo\n/w/solo/.git\n" : args.includes("symbolic-ref") ? "main\n" : ""));
    await until(() => frames.length >= 1);
    expect(frames[0].payload.repositoryPath).toBe("/w/solo");
    expect(frames[0].payload.repository).toBeUndefined();
    expect(frames[0].payload.branch).toBe("main");
  });

  test("a host prompt creates a GUI Frame; busy while working; steer, follow_up and abort route", async () => {
    const s = start();
    await until(() => host.registry.list().length === 1);

    const prompt = await host.registry.submit({ schema: "xtrm.agent-host-api.v1", kind: "submit_request", sessionId: "s-1", command: { type: "prompt", commandId: "c1", message: "do it" } } as any);
    expect(prompt.status).toBe("accepted");
    expect(s.sent).toEqual([{ content: "do it", options: undefined }]);
    s.setIdle(false);
    s.fire("before_agent_start", { prompt: "do it" }, s.ctx);
    s.fire("agent_start", {}, s.ctx);
    await until(() => frames.some((f) => f.payload.type === "agent_start"));
    expect(frames.find((f) => f.payload.type === "before_agent_start").payload.ingress).toEqual({ origin: "gui", commandId: "c1" });
    expect(host.registry.list()[0].state).toBe("working");

    const busy = await host.registry.submit({ schema: "xtrm.agent-host-api.v1", kind: "submit_request", sessionId: "s-1", command: { type: "prompt", commandId: "c2", message: "again" } } as any);
    expect(busy.status).toBe("busy");
    const steer = await host.registry.submit({ schema: "xtrm.agent-host-api.v1", kind: "submit_request", sessionId: "s-1", command: { type: "steer", commandId: "c3", message: "left" } } as any);
    const follow = await host.registry.submit({ schema: "xtrm.agent-host-api.v1", kind: "submit_request", sessionId: "s-1", command: { type: "follow_up", commandId: "c4", message: "then" } } as any);
    const abort = await host.registry.submit({ schema: "xtrm.agent-host-api.v1", kind: "submit_request", sessionId: "s-1", command: { type: "abort", commandId: "c5" } } as any);
    expect([steer.status, follow.status, abort.status]).toEqual(["accepted", "accepted", "accepted"]);
    expect(s.sent.slice(1)).toEqual([
      { content: "left", options: { deliverAs: "steer" } },
      { content: "then", options: { deliverAs: "followUp" } },
    ]);
    expect(s.aborts.length).toBe(1);

    s.fire("agent_end", { messages: [] }, s.ctx);
    s.fire("agent_settled", {}, s.ctx);
    await until(() => host.registry.list()[0].state === "settled");
    expect(frames.filter((f) => f.payload.type === "agent_settled").length).toBe(1);
    expect(host.registry.list()[0].frameCount).toBe(1);
  });

  test("the Pi startup window counts as working: prompt busy, steer/follow_up/abort wait for agent_start, one Frame (XTRM-607)", async () => {
    const s = start();
    await until(() => host.registry.list().length === 1);
    const submit = (command: Record<string, unknown>) =>
      host.registry.submit({ schema: "xtrm.agent-host-api.v1", kind: "submit_request", sessionId: "s-1", command } as any);

    expect((await submit({ type: "prompt", commandId: "c1", message: "do it" })).status).toBe("accepted");
    // Pi 1.0.0 reports isIdle() true from the prompt until agent_start; ctx stays idle here.
    expect((await submit({ type: "steer", commandId: "c2", message: "early" })).status).toBe("accepted");
    s.fire("before_agent_start", { prompt: "do it" }, s.ctx);
    await until(() => frames.some((f) => f.payload.type === "before_agent_start"));
    expect((await submit({ type: "prompt", commandId: "c3", message: "again" })).status).toBe("busy");
    expect((await submit({ type: "follow_up", commandId: "c4", message: "then" })).status).toBe("accepted");
    expect((await submit({ type: "abort", commandId: "c5" })).status).toBe("accepted");
    // Delivered now, Pi would start a second run (second before_agent_start, early agent_settled).
    expect(s.sent).toEqual([{ content: "do it", options: undefined }]);
    expect(s.aborts.length).toBe(0);

    s.setIdle(false);
    s.fire("agent_start", {}, s.ctx);
    expect(s.sent.slice(1)).toEqual([
      { content: "early", options: { deliverAs: "steer" } },
      { content: "then", options: { deliverAs: "followUp" } },
    ]);
    expect(s.aborts.length).toBe(1);

    s.setIdle(true);
    s.fire("agent_end", { messages: [] }, s.ctx);
    s.fire("agent_settled", {}, s.ctx);
    await until(() => host.registry.list()[0].state === "settled");
    expect(frames.filter((f) => f.payload.type === "before_agent_start").length).toBe(1);
    expect(frames.filter((f) => f.payload.type === "agent_settled").length).toBe(1);
    expect(host.registry.list()[0].frameCount).toBe(1);
  });

  test("an extension confirm prompt is answered from the host and the local dialog is dismissed", async () => {
    const s = start();
    await until(() => host.registry.list().length === 1);
    const answer = s.ctx.ui.confirm("Delete?", "really delete", { timeout: 60_000 });
    await until(() => host.registry.list()[0].state === "waiting_for_input");
    const request = frames.find((f) => f.payload.type === "extension_ui_request").payload;
    expect(request).toMatchObject({ method: "confirm", title: "Delete?", message: "really delete", timeout: 60_000 });

    const wrong = await host.registry.submit({ schema: "xtrm.agent-host-api.v1", kind: "submit_request", sessionId: "s-1", command: { type: "extension_ui_response", commandId: "u0", id: request.id, value: "yes" } } as any);
    expect(wrong).toMatchObject({ status: "rejected", reason: "invalid_ui_response" });
    const ok = await host.registry.submit({ schema: "xtrm.agent-host-api.v1", kind: "submit_request", sessionId: "s-1", command: { type: "extension_ui_response", commandId: "u1", id: request.id, confirmed: true } } as any);
    expect(ok.status).toBe("accepted");
    expect(await answer).toBe(true);
    expect(s.localDialogs[0].signal?.aborted).toBe(true);

    const select = s.ctx.ui.select("Pick", ["a", "b"]);
    await until(() => frames.filter((f) => f.payload.type === "extension_ui_request").length === 2);
    const selectId = frames.filter((f) => f.payload.type === "extension_ui_request")[1].payload.id;
    await host.registry.submit({ schema: "xtrm.agent-host-api.v1", kind: "submit_request", sessionId: "s-1", command: { type: "extension_ui_response", commandId: "u2", id: selectId, value: "b" } } as any);
    expect(await select).toBe("b");
  });

  test("a confirm answered in the terminal first emits extension_ui_resolved and clears waiting_for_input (XTRM-574)", async () => {
    const s = start();
    await until(() => host.registry.list().length === 1);
    s.fire("agent_start", {}, s.ctx);
    const answer = s.ctx.ui.confirm("Delete?", "really delete");
    await until(() => host.registry.list()[0].state === "waiting_for_input");
    const request = frames.find((f) => f.payload.type === "extension_ui_request").payload;

    s.localDialogs[0].answer(true);
    expect(await answer).toBe(true);
    await until(() => host.registry.list()[0].state === "working");
    const resolved = frames.filter((f) => f.payload.type === "extension_ui_resolved");
    expect(resolved.map((f) => f.payload)).toEqual([{ type: "extension_ui_resolved", id: request.id, resolvedBy: "local", outcome: "answered" }]);
    expect(frames.at(-1).payload.type).toBe("extension_ui_resolved");

    const late = await host.registry.submit({ schema: "xtrm.agent-host-api.v1", kind: "submit_request", sessionId: "s-1", command: { type: "extension_ui_response", commandId: "u9", id: request.id, confirmed: false } } as any);
    expect(late).toMatchObject({ status: "rejected", reason: "unknown_ui_request" });
  });

  test("every request ends with exactly one extension_ui_resolved: host answer, host cancel, local dismiss, caller abort", async () => {
    const s = start();
    await until(() => host.registry.list().length === 1);
    const requests = () => frames.filter((f) => f.payload.type === "extension_ui_request").map((f) => f.payload.id);
    const respond = (commandId: string, id: string, answer: Record<string, unknown>) =>
      host.registry.submit({ schema: "xtrm.agent-host-api.v1", kind: "submit_request", sessionId: "s-1", command: { type: "extension_ui_response", commandId, id, ...answer } } as any);

    const hostAnswered = s.ctx.ui.select("Pick", ["a", "b"]);
    await until(() => requests().length === 1);
    await respond("r1", requests()[0], { value: "a" });
    expect(await hostAnswered).toBe("a");

    const hostCancelled = s.ctx.ui.input("Name");
    await until(() => requests().length === 2);
    await respond("r2", requests()[1], { cancelled: true });
    expect(await hostCancelled).toBeUndefined();

    const dismissed = s.ctx.ui.select("Pick", ["a", "b"]);
    await until(() => requests().length === 3);
    s.localDialogs[2].answer(undefined);
    expect(await dismissed).toBeUndefined();

    const caller = new AbortController();
    const aborted = s.ctx.ui.confirm("Go?", "now", { signal: caller.signal });
    await until(() => requests().length === 4);
    caller.abort();
    expect(await aborted).toBe(false);

    await until(() => frames.filter((f) => f.payload.type === "extension_ui_resolved").length === 4);
    const resolved = frames.filter((f) => f.payload.type === "extension_ui_resolved").map((f) => f.payload);
    expect(resolved).toEqual([
      { type: "extension_ui_resolved", id: requests()[0], resolvedBy: "host", outcome: "answered" },
      { type: "extension_ui_resolved", id: requests()[1], resolvedBy: "host", outcome: "cancelled" },
      { type: "extension_ui_resolved", id: requests()[2], resolvedBy: "local", outcome: "cancelled" },
      { type: "extension_ui_resolved", id: requests()[3], resolvedBy: "local", outcome: "cancelled" },
    ]);
    expect(host.registry.list()[0].state).toBe("settled");
  });

  test("session_shutdown is sent and removes the session; the ui patch is restored", async () => {
    const s = start();
    await until(() => host.registry.list().length === 1);
    const patched = s.ctx.ui.confirm;
    s.fire("session_shutdown", { reason: "quit" }, s.ctx);
    await until(() => host.registry.list().length === 0);
    expect(s.ctx.ui.confirm).not.toBe(patched);
    // I2: teardown is per session now — the bridge outlives one session's
    // shutdown so sibling sessions keep their listeners; with no live
    // session the seam reads idle instead of closed.
    expect(s.bridge.state).toBe("idle");
  });
});

describe("xtrm-agent-host bridge with a late host", () => {
  test("connects once a host starts and sends identity first", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "xtrm-agent-host-late-"));
    const socketPath = path.join(dir, "host.sock");
    const pi = fakePi();
    const c = fakeCtx("s-late");
    const bridge = createAgentHostBridge(pi.pi, { socketPath, exec: async () => "", env: {} });
    bridge.register();
    pi.fire("session_start", { reason: "startup" }, c.ctx);
    await until(() => bridge.state === "down");
    const host = await startAgentHost({ socketPath, infoPath: path.join(dir, "host.json"), log: () => {} });
    const frames: any[] = [];
    host.registry.subscribe((f: any) => frames.push(f));
    try {
      await until(() => bridge.state === "open" && frames.length > 0, 5000);
      expect(frames[0]).toMatchObject({ seq: 0, sessionId: "s-late", payload: { type: "session_identity" } });
      pi.fire("agent_start", {}, c.ctx);
      await until(() => host.registry.list()[0]?.state === "working");
    } finally {
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("xtrm-agent-host bridge busy rule without host-side guards", () => {
  /** A raw socket peer: commands reach the extension even when the registry would reject them. */
  async function rawHost() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "xtrm-agent-host-raw-"));
    const socketPath = path.join(dir, "host.sock");
    const frames: any[] = [];
    let peer: net.Socket | null = null;
    let buffer = "";
    const server = net.createServer((conn) => {
      peer = conn;
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          frames.push(JSON.parse(buffer.slice(0, nl)));
          buffer = buffer.slice(nl + 1);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const send = (sessionId: string, payload: Record<string, unknown>) =>
      peer!.write(`${JSON.stringify({ schema: "xtrm.agent-command.v1", sessionId, payload })}\n`);
    const resultFor = async (commandId: string) => {
      await until(() => frames.some((f) => f.payload.type === "command_result" && f.payload.commandId === commandId));
      return frames.find((f) => f.payload.type === "command_result" && f.payload.commandId === commandId).payload;
    };
    const close = async () => {
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    };
    return { socketPath, frames, send, resultFor, close };
  }

  test("a prompt between before_agent_start and agent_start is rejected busy while ctx.isIdle() is true", async () => {
    const raw = await rawHost();
    const pi = fakePi();
    const c = fakeCtx("s-raw");
    const bridge = createAgentHostBridge(pi.pi, { socketPath: raw.socketPath, exec: async () => "", env: {} });
    try {
      bridge.register();
      pi.fire("session_start", { reason: "startup" }, c.ctx);
      await until(() => bridge.state === "open" && raw.frames.length >= 2);

      // A terminal prompt: Pi emits before_agent_start and keeps reporting idle until agent_start.
      pi.fire("before_agent_start", { prompt: "typed" }, c.ctx);
      raw.send("s-raw", { type: "prompt", commandId: "p1", message: "gui" });
      expect(await raw.resultFor("p1")).toMatchObject({ status: "rejected", reason: "busy" });
      expect(pi.sent).toEqual([]);

      pi.fire("agent_start", {}, c.ctx);
      pi.fire("agent_settled", {}, c.ctx);
      raw.send("s-raw", { type: "prompt", commandId: "p2", message: "next" });
      expect(await raw.resultFor("p2")).toMatchObject({ status: "accepted" });
      expect(pi.sent).toEqual([{ content: "next", options: undefined }]);

      // A run that never reaches agent_start (Pi preflight failed) stops counting as working after the stale bound.
      raw.send("s-raw", { type: "prompt", commandId: "p3", message: "again" });
      expect(await raw.resultFor("p3")).toMatchObject({ status: "rejected", reason: "busy" });
      setSystemTime(new Date(Date.now() + 61_000));
      raw.send("s-raw", { type: "prompt", commandId: "p4", message: "after failure" });
      expect(await raw.resultFor("p4")).toMatchObject({ status: "accepted" });
    } finally {
      setSystemTime();
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      await raw.close();
    }
  });
});

describe("xtrm-agent-host bridge without a host", () => {
  test("handlers stay silent and cheap; dialogs stay local", async () => {
    const errors: unknown[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    const origWrite = process.stderr.write.bind(process.stderr);
    console.error = (...a: unknown[]) => errors.push(a);
    console.warn = (...a: unknown[]) => errors.push(a);
    (process.stderr as any).write = (chunk: unknown) => (errors.push(chunk), true);
    try {
      const pi = fakePi();
      const c = fakeCtx("s-none");
      const bridge = createAgentHostBridge(pi.pi, { socketPath: path.join(os.tmpdir(), `absent-${process.pid}.sock`), exec: async () => "", env: {} });
      bridge.register();
      pi.fire("session_start", { reason: "startup" }, c.ctx);
      await until(() => bridge.state === "down");

      const message = { role: "assistant", content: [{ type: "text", text: "y".repeat(10_000) }] };
      const t0 = performance.now();
      for (let i = 0; i < 10_000; i++) {
        pi.fire("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "y" } }, c.ctx);
        pi.fire("tool_execution_update", { toolCallId: "t", toolName: "bash", args: {}, partialResult: "z" }, c.ctx);
      }
      const perEventUs = ((performance.now() - t0) * 1000) / 20_000;
      expect(perEventUs).toBeLessThan(20);

      // With no host the proxy returns the local dialog result directly.
      void c.ctx.ui.confirm("t", "m");
      expect(c.localDialogs.length).toBe(1);
      expect(c.localDialogs[0].signal).toBeUndefined();
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      expect(errors).toEqual([]);
      origWrite(`no-host handler cost: ${perEventUs.toFixed(3)} µs/event\n`);
    } finally {
      console.error = origError;
      console.warn = origWarn;
      (process.stderr as any).write = origWrite;
    }
  });
});

describe("repositoryFromRemote", () => {
  test.each([
    ["git@github.com:xtrm-dev/core.git", "xtrm-dev/core"],
    ["github.com:xtrm-dev/core", "xtrm-dev/core"],
    ["https://github.com/xtrm-dev/core.git", "xtrm-dev/core"],
    ["https://user:token@github.com/xtrm-dev/core/", "xtrm-dev/core"],
    ["ssh://git@gitlab.example:2222/group/sub/name.git", "group/sub/name"],
    ["git://example.org/a.b/c_d-e.git", "a.b/c_d-e"],
  ])("%s -> %s", (url, expected) => {
    expect(repositoryFromRemote(url)).toBe(expected);
  });

  test.each(["/srv/git/core.git", "../core", "file:///srv/git/owner/core.git", "https://github.com/core", "ssh://host/~user/core.git", "", "not a url"])(
    "%s has no owner/name",
    (url) => {
      expect(repositoryFromRemote(url)).toBeUndefined();
    },
  );
});

describe("xtrm-agent-host bridge wake contract (CORE-2432)", () => {
  async function rawHost() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "xtrm-agent-host-wake-"));
    const socketPath = path.join(dir, "host.sock");
    const frames: any[] = [];
    let peer: net.Socket | null = null;
    let buffer = "";
    const server = net.createServer((conn) => {
      peer = conn;
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          frames.push(JSON.parse(buffer.slice(0, nl)));
          buffer = buffer.slice(nl + 1);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const send = (sessionId: string, payload: Record<string, unknown>) =>
      peer!.write(`${JSON.stringify({ schema: "xtrm.agent-command.v1", sessionId, payload })}\n`);
    const resultFor = async (commandId: string) => {
      await until(() => frames.some((f) => f.payload.type === "command_result" && f.payload.commandId === commandId));
      return frames.find((f) => f.payload.type === "command_result" && f.payload.commandId === commandId).payload;
    };
    const close = async () => {
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    };
    return { socketPath, frames, send, resultFor, close };
  }

  test("R1 session_identity carries pid and generation", async () => {
    const raw = await rawHost();
    const pi = fakePi();
    const c = fakeCtx("s-wake-r1");
    const bridge = createAgentHostBridge(pi.pi, { socketPath: raw.socketPath, exec: async () => "", env: {} });
    try {
      bridge.register();
      pi.fire("session_start", { reason: "startup" }, c.ctx);
      await until(() => bridge.state === "open" && raw.frames.length >= 1);
      expect(raw.frames[0].payload).toMatchObject({ type: "session_identity", pid: process.pid, generation: 1 });
    } finally {
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      await raw.close();
    }
  });

  test("R3 wake delivers the payload reference and answers accepted", async () => {
    const raw = await rawHost();
    const pi = fakePi();
    const c = fakeCtx("s-wake-r3");
    const bridge = createAgentHostBridge(pi.pi, { socketPath: raw.socketPath, exec: async () => "", env: {} });
    try {
      bridge.register();
      pi.fire("session_start", { reason: "startup" }, c.ctx);
      await until(() => bridge.state === "open" && raw.frames.length >= 2);
      // A started session (first turn ran) takes wakes immediately; the
      // pre-first-turn grace path is covered by the CORE-2436 grace test.
      pi.fire("before_agent_start", { prompt: "typed" }, c.ctx);
      pi.fire("agent_start", {}, c.ctx);
      raw.send("s-wake-r3", { type: "wake", commandId: "w1", messageId: "m1", payloadRef: "CORE-2432" });
      expect(await raw.resultFor("w1")).toMatchObject({ status: "accepted" });
      // I2 delivery: the payload reference injects as customType intercom_message with the
      // D2 provenance line, never as a plain user message; no ANSI escapes reach the model.
      expect(pi.sent).toEqual([]);
      expect(pi.sentCustom).toHaveLength(1);
      expect(pi.sentCustom[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
      const posted = pi.sentCustom[0].message as any;
      expect(posted.customType).toBe("intercom_message");
      expect(String(posted.content)).toContain("CORE-2432");
      expect(String(posted.content)).toContain("Injected context, not the operator's words.");
      expect(String(posted.content)).not.toMatch(/\u001b/);
    } finally {
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      await raw.close();
    }
  });

  test("R5 listener_replaced re-asserts with a bumped generation", async () => {
    const raw = await rawHost();
    const pi = fakePi();
    const c = fakeCtx("s-wake-r5");
    const bridge = createAgentHostBridge(pi.pi, { socketPath: raw.socketPath, exec: async () => "", env: {} });
    try {
      bridge.register();
      pi.fire("session_start", { reason: "startup" }, c.ctx);
      await until(() => bridge.state === "open" && raw.frames.length >= 1);
      raw.send("s-wake-r5", { type: "listener_replaced", commandId: "lr-1", generation: 7, reason: "replaced_by_newer_generation" });
      expect(await raw.resultFor("lr-1")).toMatchObject({ status: "accepted" });
      await until(() => raw.frames.some((f) => f.payload.type === "session_identity" && f.payload.generation === 8));
      const reasserted = raw.frames.filter((f) => f.payload.type === "session_identity").at(-1).payload;
      expect(reasserted).toMatchObject({ pid: process.pid, generation: 8 });
    } finally {
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      await raw.close();
    }
  });
});

describe("xtrm-agent-host bridge replacement and held wakes (CORE-2432 F1/F7)", () => {
  async function rawHost() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "xtrm-agent-host-fup-"));
    const socketPath = path.join(dir, "host.sock");
    const frames: any[] = [];
    let peer: net.Socket | null = null;
    let buffer = "";
    const server = net.createServer((conn) => {
      peer = conn;
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          frames.push(JSON.parse(buffer.slice(0, nl)));
          buffer = buffer.slice(nl + 1);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const send = (sessionId: string, payload: Record<string, unknown>) =>
      peer!.write(`${JSON.stringify({ schema: "xtrm.agent-command.v1", sessionId, payload })}\n`);
    const resultsFor = async (commandId: string) => {
      await until(() => frames.some((f) => f.payload.type === "command_result" && f.payload.commandId === commandId));
      return frames.filter((f) => f.payload.type === "command_result" && f.payload.commandId === commandId).map((f) => f.payload);
    };
    const close = async () => {
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    };
    return { socketPath, frames, send, resultsFor, close };
  }

  test("F1 a replaced listener re-asserts once: the second notice wins no generation", async () => {
    const raw = await rawHost();
    const pi = fakePi();
    const c = fakeCtx("s-fup-f1");
    const bridge = createAgentHostBridge(pi.pi, { socketPath: raw.socketPath, exec: async () => "", env: {} });
    try {
      bridge.register();
      pi.fire("session_start", { reason: "startup" }, c.ctx);
      await until(() => bridge.state === "open" && raw.frames.length >= 1);
      raw.send("s-fup-f1", { type: "listener_replaced", commandId: "lr-1", generation: 7, reason: "replaced_by_newer_generation" });
      expect(await raw.resultsFor("lr-1")).toMatchObject([{ status: "accepted" }]);
      await until(() => raw.frames.some((f) => f.payload.type === "session_identity" && f.payload.generation === 8));
      // A second replacement notice is acknowledged but re-asserts nothing:
      // the ping-pong stops after the single re-assert.
      raw.send("s-fup-f1", { type: "listener_replaced", commandId: "lr-2", generation: 9, reason: "replaced_by_newer_generation" });
      expect(await raw.resultsFor("lr-2")).toMatchObject([{ status: "accepted" }]);
      await new Promise((r) => setTimeout(r, 50));
      expect(raw.frames.filter((f) => f.payload.type === "session_identity" && f.payload.generation > 1)).toHaveLength(1);
    } finally {
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      await raw.close();
    }
  });

  test("CORE-2436 first-turn race: a wake before the first agent_start holds, then flushes without triggerTurn", async () => {
    const raw = await rawHost();
    const pi = fakePi();
    const c = fakeCtx("s-first-turn");
    const bridge = createAgentHostBridge(pi.pi, { socketPath: raw.socketPath, exec: async () => "", env: {} });
    try {
      bridge.register();
      pi.fire("session_start", { reason: "startup" }, c.ctx);
      await until(() => bridge.state === "open" && raw.frames.length >= 1);
      // Pi reports idle during the tool loadout before the first agent_start:
      // the live probe saw a triggerTurn injection here start a second run
      // and fail with "Agent is already processing". The wake must hold.
      expect(c.ctx.isIdle()).toBe(true);
      raw.send("s-first-turn", { type: "wake", commandId: "w1", messageId: "m1", payloadRef: "CORE-2436" });
      expect(await raw.resultsFor("w1")).toMatchObject([{ status: "rejected", reason: "held" }]);
      expect(pi.sentCustom).toEqual([]);
      // The first turn begins: the held wake flushes into the fresh run as a
      // queued followUp (never triggerTurn into a starting run) and is accepted.
      pi.fire("agent_start", {}, c.ctx);
      await until(
        () => raw.frames.filter((f) => f.payload.type === "command_result" && f.payload.commandId === "w1").length >= 2,
      );
      const answers = raw.frames.filter((f) => f.payload.type === "command_result" && f.payload.commandId === "w1").map((f) => f.payload);
      expect(answers.at(-1)).toMatchObject({ status: "accepted" });
      expect(pi.sentCustom).toHaveLength(1);
      expect(pi.sentCustom[0].options).toEqual({ deliverAs: "followUp" });
      expect((pi.sentCustom[0].message as any).customType).toBe("intercom_message");
      expect(String((pi.sentCustom[0].message as any).content)).toContain("CORE-2436");
    } finally {
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      await raw.close();
    }
  });

  test("CORE-2436 grace: an interactive session with no first prompt gets its held wake with triggerTurn after the grace", async () => {
    const raw = await rawHost();
    const pi = fakePi();
    const c = fakeCtx("s-grace");
    const bridge = createAgentHostBridge(pi.pi, {
      socketPath: raw.socketPath,
      exec: async () => "",
      env: {},
      firstTurnGraceMs: 60,
    });
    try {
      bridge.register();
      pi.fire("session_start", { reason: "startup" }, c.ctx);
      await until(() => bridge.state === "open" && raw.frames.length >= 1);
      // No run starts: Pi stays idle at an empty prompt. The wake holds
      // through the grace instead of racing a loadout that never comes.
      expect(c.ctx.isIdle()).toBe(true);
      raw.send("s-grace", { type: "wake", commandId: "w1", messageId: "m1", payloadRef: "CORE-2436" });
      expect(await raw.resultsFor("w1")).toMatchObject([{ status: "rejected", reason: "held" }]);
      expect(pi.sentCustom).toEqual([]);
      // Past the grace with still no run, the session counts as idle: the
      // held wake flushes with triggerTurn, and only then is it accepted.
      // No agent_start ever fired.
      await until(
        () => raw.frames.filter((f) => f.payload.type === "command_result" && f.payload.commandId === "w1").length >= 2,
      );
      const answers = raw.frames.filter((f) => f.payload.type === "command_result" && f.payload.commandId === "w1").map((f) => f.payload);
      expect(answers.at(-1)).toMatchObject({ status: "accepted" });
      expect(pi.sentCustom).toHaveLength(1);
      expect(pi.sentCustom[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
      expect(String((pi.sentCustom[0].message as any).content)).toContain("CORE-2436");
    } finally {
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      await raw.close();
    }
  });

  test("CORE-2438 initial prompt: a wake past the grace holds until before_agent_start, then flushes", async () => {
    const raw = await rawHost();
    const pi = fakePi();
    const c = fakeCtx("s-initial-prompt");
    const bridge = createAgentHostBridge(pi.pi, {
      socketPath: raw.socketPath,
      exec: async () => "",
      env: {},
      firstTurnGraceMs: 60,
      initialPromptPending: true,
    });
    try {
      bridge.register();
      pi.fire("session_start", { reason: "startup" }, c.ctx);
      await until(() => bridge.state === "open" && raw.frames.length >= 1);
      // Past the grace with the initial turn still in startup: the wake
      // must hold (a triggerTurn injection here would race the first turn
      // and fail with "Agent is already processing").
      await new Promise((r) => setTimeout(r, 150));
      raw.send("s-initial-prompt", { type: "wake", commandId: "w1", messageId: "m1", payloadRef: "CORE-2438" });
      expect(await raw.resultsFor("w1")).toMatchObject([{ status: "rejected", reason: "held" }]);
      await new Promise((r) => setTimeout(r, 150));
      expect(pi.sentCustom).toEqual([]);
      // before_agent_start opens the starting window; agent_start flushes
      // the held wake as a queued followUp, never with triggerTurn.
      pi.fire("before_agent_start", { prompt: "initial" }, c.ctx);
      pi.fire("agent_start", {}, c.ctx);
      await until(
        () => raw.frames.filter((f) => f.payload.type === "command_result" && f.payload.commandId === "w1").length >= 2,
      );
      const answers = raw.frames.filter((f) => f.payload.type === "command_result" && f.payload.commandId === "w1").map((f) => f.payload);
      expect(answers.at(-1)).toMatchObject({ status: "accepted" });
      expect(pi.sentCustom).toHaveLength(1);
      expect(pi.sentCustom[0].options).toEqual({ deliverAs: "followUp" });
    } finally {
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      await raw.close();
    }
  });

  test("CORE-2438 initial prompt: only --print/-p counts; flag values never do", async () => {
    const { argvHasInitialPrompt } = await import("./index.ts");
    expect(argvHasInitialPrompt(["pi", "--print", "say ok"])).toBe(true);
    expect(argvHasInitialPrompt(["pi", "-p", "say ok"])).toBe(true);
    expect(argvHasInitialPrompt(["node", "pi.js", "-p", "say ok"])).toBe(true);
    // Review HIGH-1: none of these is a prompt.
    expect(argvHasInitialPrompt(["pi"])).toBe(false);
    expect(argvHasInitialPrompt(["pi", "--model", "some-model"])).toBe(false);
    expect(argvHasInitialPrompt(["pi", "-e", "/abs/ext.ts"])).toBe(false);
    expect(argvHasInitialPrompt(["pi", "--session-dir", "/tmp/x"])).toBe(false);
    expect(argvHasInitialPrompt(["pi", "--append-system-prompt", "be nice and brief"])).toBe(false);
    expect(argvHasInitialPrompt(["pi", "do the thing"])).toBe(false);
    expect(argvHasInitialPrompt(["pi", "@brief.md"])).toBe(false);
    expect(argvHasInitialPrompt(["pi", "/abs/path"])).toBe(false);
  });

  test("CORE-2438 flag-value argv never holds: the wake delivers within the grace", async () => {
    for (const argv of [
      ["pi", "-e", "/abs/ext.ts"],
      ["pi", "--session-dir", "/tmp/x"],
      ["pi", "--append-system-prompt", "be nice and brief"],
    ]) {
      const raw = await rawHost();
      const pi = fakePi();
      const c = fakeCtx(`s-flag-${argv[1].replace(/[^a-z]/g, "")}`);
      const bridge = createAgentHostBridge(pi.pi, {
        socketPath: raw.socketPath,
        exec: async () => "",
        env: {},
        argv,
        firstTurnGraceMs: 60,
      });
      try {
        bridge.register();
        pi.fire("session_start", { reason: "startup" }, c.ctx);
        await until(() => bridge.state === "open" && raw.frames.length >= 1);
        // Past the grace with no prompt pending: idle, no hold, the wake
        // injects at once with triggerTurn.
        await new Promise((r) => setTimeout(r, 150));
        raw.send(c.ctx.sessionManager.getSessionId(), { type: "wake", commandId: "w1", messageId: `m-${argv[1]}`, payloadRef: "CORE-2438" });
        expect(await raw.resultsFor("w1")).toMatchObject([{ status: "accepted" }]);
        expect(pi.sentCustom).toHaveLength(1);
        expect(pi.sentCustom[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
      } finally {
        pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
        await raw.close();
      }
    }
  });

  test("CORE-2438 initial-prompt hold is capped: past the cap the wake flushes with triggerTurn", async () => {
    const raw = await rawHost();
    const pi = fakePi();
    const c = fakeCtx("s-prompt-cap");
    const bridge = createAgentHostBridge(pi.pi, {
      socketPath: raw.socketPath,
      exec: async () => "",
      env: {},
      firstTurnGraceMs: 60,
      initialPromptPending: true,
      initialPromptCapMs: 150,
    });
    try {
      bridge.register();
      pi.fire("session_start", { reason: "startup" }, c.ctx);
      await until(() => bridge.state === "open" && raw.frames.length >= 1);
      // Past the grace the wake holds on the initial-prompt prediction...
      await new Promise((r) => setTimeout(r, 120));
      raw.send("s-prompt-cap", { type: "wake", commandId: "w1", messageId: "m1", payloadRef: "CORE-2438" });
      expect(await raw.resultsFor("w1")).toMatchObject([{ status: "rejected", reason: "held" }]);
      expect(pi.sentCustom).toEqual([]);
      // ...but the cap falls back to the normal grace flush: no agent_start
      // ever fired, yet the wake injects with triggerTurn and is accepted.
      await until(
        () => raw.frames.filter((f) => f.payload.type === "command_result" && f.payload.commandId === "w1").length >= 2,
      );
      const answers = raw.frames.filter((f) => f.payload.type === "command_result" && f.payload.commandId === "w1").map((f) => f.payload);
      expect(answers.at(-1)).toMatchObject({ status: "accepted" });
      expect(pi.sentCustom).toHaveLength(1);
      expect(pi.sentCustom[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    } finally {
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      await raw.close();
    }
  });

  test("F7 a wake received while starting is held, then accepted only when delivered", async () => {
    const raw = await rawHost();
    const pi = fakePi();
    const c = fakeCtx("s-fup-f7");
    const bridge = createAgentHostBridge(pi.pi, { socketPath: raw.socketPath, exec: async () => "", env: {} });
    try {
      bridge.register();
      pi.fire("session_start", { reason: "startup" }, c.ctx);
      await until(() => bridge.state === "open" && raw.frames.length >= 2);
      // A terminal prompt starts a run that has not reached agent_start yet.
      pi.fire("before_agent_start", { prompt: "typed" }, c.ctx);
      raw.send("s-fup-f7", { type: "wake", commandId: "w1", messageId: "m1", payloadRef: "CORE-2432" });
      // Held, not accepted, and nothing delivered into the operator session yet.
      expect(await raw.resultsFor("w1")).toMatchObject([{ status: "rejected", reason: "held" }]);
      expect(pi.sent).toEqual([]);
      // agent_start delivers it as an intercom_message follow-up, and only now is it accepted.
      pi.fire("agent_start", {}, c.ctx);
      await until(
        () => raw.frames.filter((f) => f.payload.type === "command_result" && f.payload.commandId === "w1").length >= 2,
      );
      const answers = raw.frames.filter((f) => f.payload.type === "command_result" && f.payload.commandId === "w1").map((f) => f.payload);
      expect(answers.at(-1)).toMatchObject({ status: "accepted" });
      expect(pi.sent).toEqual([]);
      expect(pi.sentCustom).toHaveLength(1);
      expect(pi.sentCustom[0].options).toEqual({ deliverAs: "followUp" });
      expect((pi.sentCustom[0].message as any).customType).toBe("intercom_message");
    } finally {
      pi.fire("session_shutdown", { reason: "quit" }, c.ctx);
      await raw.close();
    }
  });
});

describe("agent-host self-heal (CORE-2467 A+B)", () => {

  function startWithEnsure(sessionId: string, ensureOpts: any) {
    const pi = fakePi();
    const c = fakeCtx(sessionId);
    const notified: Array<{ line: string; level: string }> = [];
    const ctx = { ...c.ctx, ui: { ...c.ctx.ui, notify: (line: string, level: string) => notified.push({ line, level }) } };
    const bridge = createAgentHostBridge(pi.pi, {
      socketPath: path.join(dirUnused(), "host.sock"),
      exec: async () => "",
      env: {},
      hostEnsure: ensureOpts,
    });
    bridge.register();
    pi.fire("session_start", { reason: "startup" }, ctx);
    return { notified };
  }

  function dirUnused(): string {
    return mkdtempSync(path.join(os.tmpdir(), "xtrm-agent-host-heal-"));
  }

  test("a failed ensure warns loudly with the runbook and never blocks start", async () => {
    __resetHostEnsureState();
    const dir = dirUnused();
    try {
      const t0 = Date.now();
      const { notified } = startWithEnsure("s-heal-fail", {
        socketPath: path.join(dir, "host.sock"),
        runEnsure: async () => ({ ok: false, detail: "spawn refused" }),
      });
      expect(Date.now() - t0).toBeLessThan(2000);
      await until(() => notified.length >= 1);
      expect(notified).toHaveLength(1);
      expect(notified[0].level).toBe("warning");
      expect(notified[0].line).toMatch(/agent host is not running/);
      expect(notified[0].line).toContain("xt host ensure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a healing ensure stays silent", async () => {
    __resetHostEnsureState();
    const dir = dirUnused();
    const sock = path.join(dir, "host.sock");
    let server: net.Server | null = null;
    try {
      const { notified } = startWithEnsure("s-heal-ok", {
        socketPath: sock,
        runEnsure: async () => {
          server = net.createServer(() => {});
          await new Promise<void>((resolve, reject) => {
            server!.once("error", reject);
            server!.listen(sock, () => resolve());
          });
          return { ok: true, detail: "started" };
        },
      });
      await until(() => (server as unknown) !== null);
      await new Promise((r) => setTimeout(r, 100));
      expect(notified).toEqual([]);
    } finally {
      if (server) await new Promise((r) => (server as net.Server).close(() => r(undefined)));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explicit opt-out starts normally with no healing", async () => {
    __resetHostEnsureState();
    const pi = fakePi();
    const c = fakeCtx("s-heal-off");
    const t0 = Date.now();
    const bridge = createAgentHostBridge(pi.pi, {
      socketPath: path.join(dirUnused(), "host.sock"),
      exec: async () => "",
      env: {},
      hostEnsure: false,
    });
    bridge.register();
    pi.fire("session_start", { reason: "startup" }, c.ctx);
    // The start path never waits on healing: a failed or absent ensure
    // cannot slow it, and off means nothing spawns.
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(typeof bridge.state).toBe("string");
  });
});
