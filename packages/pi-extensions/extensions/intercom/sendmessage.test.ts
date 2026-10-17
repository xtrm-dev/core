import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({ VERSION: "1.0.0-test" }));

const sendmessage = await import("./sendmessage.ts");
const { intercomWaiting } = await import("./waiting.ts");

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools: Record<string, any> = {};
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerTool: (def: any) => {
      tools[def.name] = def;
    },
    registerCommand: () => {},
    getSessionName: () => "coordinator",
    getSettings: () => ({}),
  };
  const fire = (name: string, event: any, ctx: any) => {
    for (const handler of handlers.get(name) ?? []) handler({ type: name, ...event }, ctx);
  };
  return { pi: pi as any, tools, fire };
}

function fakeCtx(sessionId: string) {
  return {
    sessionManager: { getSessionId: () => sessionId },
  } as any;
}

function piSummary(sessionId: string, name: string, state = "settled") {
  return {
    sessionId,
    provider: "pi",
    state,
    name,
    cwd: "/tmp/x",
    extensionConnected: true,
    capabilities: ["prompt"],
    startedAt: Date.now() - 1000,
    lastActivityAt: Date.now(),
  } as any;
}

function claudePeer(name: string, sock: string, sessionId = `claude-${name}`) {
  return { name, sessionId, sock, cwd: "/tmp/x", status: "idle", kind: "interactive" } as any;
}

function baseDeps(overrides: Record<string, any> = {}) {
  const posted: any[] = [];
  return {
    deps: {
      fetchPi: async () => [piSummary("s-bob", "bob")],
      fetchClaude: async () => [],
      postWake: async (req: any) => {
        posted.push(req);
        return { messageId: req.messageId ?? "m-sent", state: "delivered" };
      },
      wakeStatus: async (messageId: string) => ({ messageId, state: "delivered" }),
      sendClaude: async () => ({ outcome: "delivered" as const }),
      settleWaitMs: 20,
      now: () => 1_000_000,
      randomId: () => "m-test-1",
      ...overrides,
    },
    posted,
  };
}

function register(deps: any) {
  sendmessage.__resetSendMessageState();
  intercomWaiting.setPendingAsks(0);
  intercomWaiting.setUndelivered(0);
  const { pi, tools, fire } = fakePi();
  sendmessage.registerSendMessageTool(pi, deps);
  const tool = tools.SendMessage;
  expect(tool).toBeTruthy();
  return { pi, tool, fire };
}

describe("SendMessage params (CORE-2436 I5)", () => {
  test("the tool is model-only and named SendMessage", async () => {
    const { tool } = register(baseDeps().deps);
    expect(tool.name).toBe("SendMessage");
    expect(tool.exposure).toBe("model-only");
  });

  test("missing to/message/cancel is an error, never a send", async () => {
    const { deps } = baseDeps();
    const { tool } = register(deps);
    const r1 = await tool.execute("c1", { message: "hi" }, undefined, undefined, fakeCtx("s-me"));
    expect(r1.isError).toBe(true);
    const r2 = await tool.execute("c2", { to: "bob" }, undefined, undefined, fakeCtx("s-me"));
    expect(r2.isError).toBe(true);
    const r3 = await tool.execute("c3", { to: "   ", message: "hi" }, undefined, undefined, fakeCtx("s-me"));
    expect(r3.isError).toBe(true);
  });

  test("an empty message is an error", async () => {
    const { deps } = baseDeps();
    const { tool } = register(deps);
    const r = await tool.execute("c1", { to: "bob", message: "  " }, undefined, undefined, fakeCtx("s-me"));
    expect(r.isError).toBe(true);
    expect(String(r.content[0].text)).toMatch(/message/i);
  });
});

describe("SendMessage to Pi sessions (CORE-2436 I5)", () => {
  test("send to an idle session wakes it: exact session id in the wake request", async () => {
    const { deps, posted } = baseDeps();
    const { tool } = register(deps);
    const r = await tool.execute("c1", { to: "bob", message: "hello" }, undefined, undefined, fakeCtx("s-me"));
    expect(r.isError).toBeFalsy();
    expect(String(r.content[0].text)).toContain("Delivered to bob");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      participant: "s-bob",
      payloadRef: "hello",
      messageId: "m-test-1",
      from: "coordinator",
      fromSessionId: "s-me",
    });
  });

  test("send to a busy session reports queued as the last known state", async () => {
    const { deps } = baseDeps({
      fetchPi: async () => [piSummary("s-bob", "bob", "working")],
      postWake: async (req: any) => ({ messageId: "m-q", state: "queued" }),
      wakeStatus: async (messageId: string) => ({ messageId, state: "queued" }),
    });
    const { tool } = register(deps);
    const r = await tool.execute("c1", { to: "bob", message: "hello" }, undefined, undefined, fakeCtx("s-me"));
    expect(String(r.content[0].text)).toMatch(/queued/);
  });

  test("a queued send that settles reports the settled state", async () => {
    let calls = 0;
    const { deps } = baseDeps({
      postWake: async (req: any) => ({ messageId: "m-q", state: "queued" }),
      wakeStatus: async (messageId: string) => (++calls >= 2 ? { messageId, state: "delivered" } : { messageId, state: "queued" }),
    });
    const { tool } = register(deps);
    const r = await tool.execute("c1", { to: "bob", message: "hello" }, undefined, undefined, fakeCtx("s-me"));
    expect(String(r.content[0].text)).toContain("Delivered to bob");
  });

  test("unknown target names candidates, never sends", async () => {
    const { deps, posted } = baseDeps();
    const { tool } = register(deps);
    const r = await tool.execute("c1", { to: "nobody", message: "hi" }, undefined, undefined, fakeCtx("s-me"));
    expect(r.isError).toBe(true);
    expect(String(r.content[0].text)).toMatch(/no live session matches "nobody"/);
    expect(String(r.content[0].text)).toContain("bob");
    expect(posted).toHaveLength(0);
  });

  test("ambiguous names are an error naming every candidate", async () => {
    const { deps } = baseDeps({
      fetchPi: async () => [piSummary("s-1", "dup"), piSummary("s-2", "dup")],
    });
    const { tool } = register(deps);
    const r = await tool.execute("c1", { to: "dup", message: "hi" }, undefined, undefined, fakeCtx("s-me"));
    expect(r.isError).toBe(true);
    expect(String(r.content[0].text)).toMatch(/ambiguous session "dup"/);
  });

  test("held produces the bracketed delivery notice", async () => {
    const { deps } = baseDeps({
      postWake: async (req: any) => ({ messageId: "m-h", state: "held" }),
    });
    const { tool } = register(deps);
    const r = await tool.execute("c1", { to: "bob", message: "hi" }, undefined, undefined, fakeCtx("s-me"));
    const text = String(r.content[0].text);
    expect(text).toContain("[Cross-session delivery notice]");
    expect(text).toMatch(/held/);
    expect(text).not.toMatch(/\u001b/);
  });

  test("refused and undelivered produce bracketed notices and feed the waiting store", async () => {
    const { deps } = baseDeps({
      postWake: async (req: any) => ({ messageId: "m-u", state: "undelivered" }),
    });
    const { tool } = register(deps);
    const r = await tool.execute("c1", { to: "bob", message: "hi" }, undefined, undefined, fakeCtx("s-me"));
    expect(String(r.content[0].text)).toContain("[Cross-session delivery notice]");
    expect(intercomWaiting.getUndelivered()).toBe(1);
    expect(intercomWaiting.total()).toBe(1);
  });

  test("a later delivery to the same target clears its undelivered count", async () => {
    let state: string = "undelivered";
    const { deps } = baseDeps({
      postWake: async (req: any) => ({ messageId: "m-x", state: state }),
    });
    const { tool } = register(deps);
    await tool.execute("c1", { to: "bob", message: "hi" }, undefined, undefined, fakeCtx("s-me"));
    expect(intercomWaiting.getUndelivered()).toBe(1);
    state = "delivered";
    await tool.execute("c2", { to: "bob", message: "again" }, undefined, undefined, fakeCtx("s-me"));
    expect(intercomWaiting.getUndelivered()).toBe(0);
    expect(intercomWaiting.total()).toBe(0);
  });

  test("reply_to threads the reply onto the original message", async () => {
    const { deps, posted } = baseDeps();
    const { tool } = register(deps);
    await tool.execute("c1", { to: "bob", message: "got it", reply_to: "m-orig" }, undefined, undefined, fakeCtx("s-me"));
    expect(posted[0]).toMatchObject({ replyTo: "m-orig" });
  });

  test("notify_when_idle rides the wake and is confirmed in the result", async () => {
    const { deps, posted } = baseDeps();
    const { tool } = register(deps);
    const r = await tool.execute(
      "c1",
      { to: "bob", message: "hi", notify_when_idle: true },
      undefined,
      undefined,
      fakeCtx("s-me"),
    );
    expect(posted[0]).toMatchObject({ notifyWhenIdle: true });
    expect(String(r.content[0].text)).toMatch(/idle notice/);
  });
});

describe("SendMessage ask/pending/cancel (CORE-2436 I5, D-2)", () => {
  test("an ask returns the reply that arrives with replyTo", async () => {
    const { deps } = baseDeps();
    const { tool } = register(deps);
    const pending = tool.execute(
      "c1",
      { to: "bob", message: "status?", expect_reply: true, timeout_s: 30 },
      undefined,
      undefined,
      fakeCtx("s-me"),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(intercomWaiting.getPendingAsks()).toBe(1);
    sendmessage.__inboundWakeForTests({ messageId: "m-r", ref: "all green", replyTo: "m-test-1", from: "bob" });
    const r = await pending;
    expect(String(r.content[0].text)).toMatch(/Reply from bob/);
    expect(String(r.content[0].text)).toContain("all green");
    expect(intercomWaiting.getPendingAsks()).toBe(0);
  });

  test("an ask times out with the last known state", async () => {
    const { deps } = baseDeps({
      wakeStatus: async (messageId: string) => ({ messageId, state: "delivered" }),
    });
    const { tool } = register(deps);
    const r = await tool.execute(
      "c1",
      { to: "bob", message: "status?", expect_reply: true, timeout_s: 1 },
      undefined,
      undefined,
      fakeCtx("s-me"),
    );
    const text = String(r.content[0].text);
    expect(text).toMatch(/timed out/);
    expect(text).toMatch(/last known state: delivered/);
    expect(intercomWaiting.getPendingAsks()).toBe(0);
  });

  test("cancel removes a pending ask; the waiter reports cancellation", async () => {
    const { deps } = baseDeps();
    const { tool } = register(deps);
    const pending = tool.execute(
      "c1",
      { to: "bob", message: "status?", expect_reply: true, timeout_s: 30 },
      undefined,
      undefined,
      fakeCtx("s-me"),
    );
    await new Promise((r) => setTimeout(r, 10));
    const cancelled = await tool.execute("c2", { cancel: "m-test-1" }, undefined, undefined, fakeCtx("s-me"));
    expect(String(cancelled.content[0].text)).toContain("Cancelled pending ask m-test-1.");
    const r = await pending;
    expect(String(r.content[0].text)).toMatch(/cancelled/);
    expect(intercomWaiting.getPendingAsks()).toBe(0);
  });

  test("cancelling an unknown ask is an error", async () => {
    const { deps } = baseDeps();
    const { tool } = register(deps);
    const r = await tool.execute("c1", { cancel: "m-nope" }, undefined, undefined, fakeCtx("s-me"));
    expect(r.isError).toBe(true);
    expect(String(r.content[0].text)).toMatch(/No pending ask m-nope/);
  });
});

describe("SendMessage to Claude sessions (CORE-2436 I5)", () => {
  test("with the transport off, sending to a Claude session fails loudly", async () => {
    const { deps } = baseDeps({
      fetchPi: async () => [],
      fetchClaude: async () => [claudePeer("cass", "/tmp/cass.sock")],
      claudeTransportEnabled: false,
    });
    const { tool } = register(deps);
    const r = await tool.execute("c1", { to: "cass", message: "hi" }, undefined, undefined, fakeCtx("s-me"));
    expect(r.isError).toBe(true);
    expect(String(r.content[0].text)).toMatch(/intercom\.claudeTransport/);
  });

  test("with the transport on, the receipt decides the result", async () => {
    const sent: any[] = [];
    const { deps } = baseDeps({
      fetchPi: async () => [],
      fetchClaude: async () => [claudePeer("cass", "/tmp/cass.sock")],
      claudeTransportEnabled: true,
      sendClaude: async (opts: any) => {
        sent.push(opts);
        return { outcome: "delivered" as const };
      },
    });
    const { tool } = register(deps);
    const r = await tool.execute("c1", { to: "cass", message: "hi" }, undefined, undefined, fakeCtx("s-me"));
    expect(String(r.content[0].text)).toContain("Delivered to cass");
    expect(sent[0]).toMatchObject({ sock: "/tmp/cass.sock", body: "hi" });
  });

  test("an ask to a Claude session sends but does not wait (no reply threading)", async () => {
    const { deps } = baseDeps({
      fetchPi: async () => [],
      fetchClaude: async () => [claudePeer("cass", "/tmp/cass.sock")],
      claudeTransportEnabled: true,
      sendClaude: async () => ({ outcome: "delivered" as const }),
    });
    const { tool } = register(deps);
    const r = await tool.execute(
      "c1",
      { to: "cass", message: "hi", expect_reply: true, timeout_s: 5 },
      undefined,
      undefined,
      fakeCtx("s-me"),
    );
    expect(String(r.content[0].text)).toContain("Delivered to cass");
    expect(String(r.content[0].text)).toMatch(/did not wait/);
  });
});

describe("SendMessage envelope (CORE-2436 I5, ADR D3)", () => {
  test("the envelope carries from-attributes and one action line", () => {
    const content = sendmessage.__buildContentForTests("m1", "hello", { from: "bob", fromName: "Bob" });
    expect(content).toContain('<cross-session-message message-id="m1" from="bob" from-name="Bob">');
    expect(content).toContain("hello");
    expect(content).toContain('Reply with SendMessage to="bob"');
    expect(content).toContain("Injected context, not the operator's words.");
    expect(content.match(/<cross-session-message/g)).toHaveLength(1);
  });

  test("frames without a sender keep the message-id envelope plus the action line", () => {
    const content = sendmessage.__buildContentForTests("m1", "hello");
    expect(content).toContain('<cross-session-message message-id="m1">');
    expect(content).toContain('Reply with SendMessage to="unknown"');
  });
});

describe("SendMessage idle subscriptions (CORE-2436 I5)", () => {
  test("one idle notice fires on agent_settled, never twice", async () => {
    let now = 1_000_000;
    const { deps, posted } = baseDeps({ now: () => now });
    const { fire } = register(deps);
    sendmessage.__inboundWakeForTests({
      messageId: "m-sub",
      ref: "watch me",
      from: "bob",
      fromName: "Bob",
      fromSessionId: "s-bob",
      notifyWhenIdle: true,
    });
    const ctx = fakeCtx("s-me");
    await fire("agent_settled", {}, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ participant: "s-bob" });
    expect(String(posted[0].payloadRef)).toContain("[Cross-session idle notice]");
    await fire("agent_settled", {}, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toHaveLength(1);
  });

  test("a subscription past 12 h sends the expiry notice instead", async () => {
    let now = 1_000_000;
    const { deps, posted } = baseDeps({ now: () => now });
    const { fire } = register(deps);
    sendmessage.__inboundWakeForTests(
      {
        messageId: "m-sub",
        ref: "watch me",
        from: "bob",
        fromSessionId: "s-bob",
        notifyWhenIdle: true,
      },
      now,
    );
    now += 12 * 3600 * 1000 + 1000;
    await fire("agent_settled", {}, fakeCtx("s-me"));
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toHaveLength(1);
    expect(String(posted[0].payloadRef)).toMatch(/expired after 12 h/);
  });
});

describe("SendMessage live through the agent host (CORE-2436 I5)", () => {
  test("idle delivery, busy followUp-only delivery, and a threaded ask reply", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = (await import("node:os")).default;
    const nodePath = (await import("node:path")).default;
    const { startAgentHost } = await import("../../../../cli/src/core/agent-host.ts");
    const { createAgentHostBridge } = await import("../xtrm-agent-host/index.ts");
    const { fetchPiSessions } = await import("./roster.ts");
    const dir = mkdtempSync(nodePath.join(os.tmpdir(), "xtrm-sendmessage-live-"));
    const host = await startAgentHost({
      socketPath: nodePath.join(dir, "host.sock"),
      infoPath: nodePath.join(dir, "host.json"),
      log: () => {},
    });
    const liveUntil = async (check: () => boolean, ms = 5000) => {
      const start = Date.now();
      while (!check()) {
        if (Date.now() - start > ms) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    try {
      // Receiver: a real bridge binding with an idle/busy switch.
      const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
      const sentCustom: Array<{ message: unknown; options?: unknown }> = [];
      let idle = true;
      const receiverPi = {
        on: (name: string, handler: (event: any, ctx: any) => unknown) => {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
          return () => {};
        },
        sendUserMessage: () => {},
        sendMessage: (message: unknown, options?: unknown) => {
          sentCustom.push({ message, options });
        },
        getSessionName: () => "livebob",
        getSettings: () => ({}),
        getThinkingLevel: () => "medium",
        getAllTools: () => [],
        registerTool: () => {},
        registerCommand: () => {},
        setSessionName: () => {},
      };
      const rctx = {
        cwd: "/tmp/live",
        hasUI: false,
        ui: {},
        sessionManager: { getSessionId: () => "s-live", getSessionFile: () => "/tmp/s-live.jsonl" },
        isIdle: () => idle,
        abort: () => {},
      } as any;
      const rfire = (name: string, event: any, ctx: any) => {
        for (const handler of handlers.get(name) ?? []) handler({ type: name, ...event }, ctx);
      };
      const bridge = createAgentHostBridge(receiverPi as any, {
        socketPath: host.info.socket,
        exec: async () => "",
        env: {},
      });
      bridge.register();
      rfire("session_start", { reason: "startup" }, rctx);
      await liveUntil(() => host.registry.list().length === 1);
      rfire("agent_start", {}, rctx);

      // Sender: the tool in another (unbound) session, over real HTTP.
      sendmessage.__resetSendMessageState();
      const { pi, tools } = fakePi();
      let n = 0;
      sendmessage.registerSendMessageTool(pi, {
        infoPath: nodePath.join(dir, "host.json"),
        fetchPi: () => fetchPiSessions({ address: host.info.address, port: host.info.port }),
        fetchClaude: async () => [],
        randomId: () => `m-live-${++n}`,
      });
      const tool = tools.SendMessage;
      const sender = fakeCtx("s-sender");

      // Idle: the wake injects with triggerTurn and the sender sees delivered.
      const r1 = await tool.execute("c1", { to: "livebob", message: "hello live" }, undefined, undefined, sender);
      expect(String(r1.content[0].text)).toContain("Delivered to livebob");
      const idleInjected = sentCustom.filter((s) => (s.message as any)?.customType === "intercom_message");
      expect(idleInjected).toHaveLength(1);
      expect(idleInjected[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
      expect(String((idleInjected[0].message as any)?.content)).toContain("hello live");
      expect(String((idleInjected[0].message as any)?.content)).toContain('from="coordinator"');

      // The triggered run starts, clearing the startup window.
      rfire("agent_start", {}, rctx);
      // Busy: the same send queues as followUp-only, still accepted.
      idle = false;
      const r2 = await tool.execute("c2", { to: "livebob", message: "while busy" }, undefined, undefined, sender);
      expect(String(r2.content[0].text)).toContain("Delivered to livebob");
      expect(sentCustom).toHaveLength(2);
      expect(sentCustom[1].options).toEqual({ deliverAs: "followUp" });
      idle = true;
      rfire("agent_start", {}, rctx);

      // Ask: the reply threaded by replyTo resolves the waiting ask.
      const pending = tool.execute(
        "c3",
        { to: "livebob", message: "status?", expect_reply: true, timeout_s: 10 },
        undefined,
        undefined,
        sender,
      );
      await new Promise((r) => setTimeout(r, 50));
      host.registry.wake("s-live", "all green", {
        messageId: "m-live-reply",
        replyTo: "m-live-3",
        from: "livebob",
        fromName: "livebob",
        fromSessionId: "s-live",
      });
      const r3 = await pending;
      expect(String(r3.content[0].text)).toMatch(/Reply from livebob/);
      expect(String(r3.content[0].text)).toContain("all green");
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
