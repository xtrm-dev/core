import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({ VERSION: "1.0.0-test" }));

const commands = await import("./commands.ts");

const HOUR = 3_600_000;
const NOW = 1_786_000_000_000;

function fakeCtx(overrides: Record<string, unknown> = {}) {
  const notified: Array<{ message: string; type?: string }> = [];
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/work",
    sessionManager: { getSessionId: () => "own-session-id-123456" },
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => notified.push({ message, type }),
      input: async () => undefined,
      custom: async () => undefined,
    },
    ...overrides,
  };
  return { ctx, notified };
}

function fakePi(name = "coordinator") {
  let sessionName: string | undefined = name;
  const cmds: Record<string, any> = {};
  return {
    pi: {
      registerCommand: (cmd: string, options: any) => {
        cmds[cmd] = options;
      },
      getSessionName: () => sessionName,
      setSessionName: (next: string) => {
        sessionName = next;
      },
    } as any,
    cmds,
    currentName: () => sessionName,
  };
}

describe("/rename (CORE-2435 I4, replaces pi-intercom /alias)", () => {
  // Every rename test injects its roster sources: the defaults would read
  // the live agent host and the live Claude registry.
  const emptyRoster = { fetchPi: async () => [], fetchClaude: async () => [] };
  test("sets the session name and tells the operator", async () => {
    const { pi, currentName } = fakePi();
    const { ctx, notified } = fakeCtx();
    let patchedPid: number | null = null;
    const result = await commands.runRename(pi, "field-coordinator", ctx, {
      ...emptyRoster,
      updateName: async (pid: number, patch: { name: string }) => {
        patchedPid = pid;
      },
    });
    expect(result).toMatchObject({ ok: true, name: "field-coordinator" });
    expect(currentName()).toBe("field-coordinator");
    expect(patchedPid).toBe(process.pid);
    expect(notified.at(-1)?.message).toContain("field-coordinator");
  });

  test("the rename reaches the registry the roster reads (Claude entry patched)", async () => {
    const { pi } = fakePi();
    const { ctx } = fakeCtx();
    const patches: Array<{ pid: number; patch: { name: string } }> = [];
    await commands.runRename(pi, "renamed", ctx, {
      ...emptyRoster,
      updateName: async (pid: number, patch: { name: string }) => {
        patches.push({ pid, patch });
      },
    });
    expect(patches).toEqual([{ pid: process.pid, patch: { name: "renamed" } }]);
  });

  test("empty args print usage with the current name, never rename to blank", async () => {
    const { pi, currentName } = fakePi("coordinator");
    const { ctx, notified } = fakeCtx();
    const result = await commands.runRename(pi, "   ", ctx, {});
    expect(result.ok).toBe(false);
    expect(currentName()).toBe("coordinator");
    expect(notified.at(-1)?.message).toContain("coordinator");
  });

  test("a name another live session has is refused R7-style, before anything renames", async () => {
    const { pi, currentName } = fakePi("coordinator");
    const { ctx, notified } = fakeCtx();
    let patched = false;
    const result = await commands.runRename(pi, "worker-one", ctx, {
      fetchPi: async () => [
        {
          sessionId: "sess-other-1",
          provider: "pi",
          state: "settled",
          name: "worker-one",
          cwd: "/tmp/o",
          extensionConnected: true,
          capabilities: [],
        } as any,
      ],
      fetchClaude: async () => [],
      updateName: async () => {
        patched = true;
      },
    });
    expect(result).toMatchObject({ ok: false, error: "taken" });
    expect(currentName()).toBe("coordinator");
    expect(patched).toBe(false);
    expect(notified.at(-1)?.message).toMatch(/already taken.*sess-other-1/);
  });

  test("renaming to the own current name is a no-op, never taken", async () => {
    const { pi, currentName } = fakePi("coordinator");
    const { ctx } = fakeCtx();
    const result = await commands.runRename(pi, "coordinator", ctx, {
      ...emptyRoster,
      updateName: async () => {},
    });
    expect(result).toMatchObject({ ok: true, name: "coordinator" });
    expect(currentName()).toBe("coordinator");
  });

  test("the Claude entry patch honours sessionsDir, not only the default path", async () => {
    const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import("node:fs");
    const os = (await import("node:os")).default;
    const path = (await import("node:path")).default;
    const dir = mkdtempSync(path.join(os.tmpdir(), "xtrm-rename-dir-"));
    try {
      const entry = path.join(dir, `${process.pid}.json`);
      writeFileSync(
        entry,
        JSON.stringify({ pid: process.pid, name: "old", status: "idle", messagingSocketPath: "/tmp/x.sock", version: "intercom 0.1.0" }),
      );
      const { pi } = fakePi("coordinator");
      const { ctx } = fakeCtx();
      const result = await commands.runRename(pi, "renamed", ctx, { ...emptyRoster, sessionsDir: dir });
      expect(result).toMatchObject({ ok: true, name: "renamed" });
      expect(JSON.parse(readFileSync(entry, "utf8")).name).toBe("renamed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the renamed name reaches the roster through the agent host (session_info_changed to identity)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = (await import("node:os")).default;
    const path = (await import("node:path")).default;
    const { startAgentHost } = await import("../../../../cli/src/core/agent-host.ts");
    const { createAgentHostBridge } = await import("../xtrm-agent-host/index.ts");
    const { fetchPiSessions } = await import("./roster.ts");
    const dir = mkdtempSync(path.join(os.tmpdir(), "xtrm-rename-host-"));
    const host = await startAgentHost({ socketPath: path.join(dir, "host.sock"), infoPath: path.join(dir, "host.json"), log: () => {} });
    const until = async (check: () => boolean, ms = 8000) => {
      const start = Date.now();
      while (!check()) {
        if (Date.now() - start > ms) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    try {
      type Handler = (event: any, ctx: any) => unknown;
      const handlers = new Map<string, Handler[]>();
      let sessionName = "coordinator";
      const pi: any = {
        on: (name: string, handler: Handler) => {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
          return () => {};
        },
        sendUserMessage: () => {},
        sendMessage: () => {},
        getSessionName: () => sessionName,
        setSessionName: (next: string) => {
          sessionName = next;
        },
        getSettings: () => ({}),
        getThinkingLevel: () => "medium",
        getAllTools: () => [],
      };
      const fire = (name: string, event: any, ctx: any) => {
        for (const handler of handlers.get(name) ?? []) handler({ type: name, ...event }, ctx);
      };
      const sessionId = "sess-rename-e2e-1";
      const ctx: any = {
        cwd: "/tmp/work",
        hasUI: true,
        ui: { notify: () => {} },
        sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl` },
        isIdle: () => true,
        abort: () => {},
        model: { provider: "p", id: "m", contextWindow: 100000 } as any,
        getContextUsage: () => ({ tokens: 1, contextWindow: 100000, percent: 1 }),
      };
      const livePi = () => fetchPiSessions({ address: host.info.address, port: host.info.port, timeoutMs: 2000 });
      const bridge = createAgentHostBridge(pi, { socketPath: host.info.socket, exec: async () => "", env: {} });
      bridge.register();
      fire("session_start", { reason: "startup" }, ctx);
      await until(() => host.registry.list().length === 1);
      // The rename lands in the host registry through session_info_changed.
      const result = await commands.runRename(pi, "field-coordinator", ctx, {
        fetchPi: livePi,
        fetchClaude: async () => [],
        updateName: async () => {},
      });
      expect(result).toMatchObject({ ok: true, name: "field-coordinator" });
      fire("session_info_changed", { name: "field-coordinator" }, ctx);
      await until(() => host.registry.detail(sessionId)?.identity?.sessionName === "field-coordinator");
      // And the roster the model tool reads shows the new name.
      await until(async () => (await livePi()).some((s: any) => s.name === "field-coordinator"));
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("registers /rename and never /alias", () => {
    const { pi, cmds } = fakePi();
    commands.registerIntercomCommands(pi, {});
    expect(cmds.rename).toBeTruthy();
    expect(cmds.intercom).toBeTruthy();
    expect(cmds.alias).toBeUndefined();
    expect(cmds["intercom-pool"]).toBeUndefined();
    expect(cmds.handover).toBeUndefined();
  });
});

describe("/intercom roster overlay (CORE-2435 I4)", () => {
  const peers = [
    {
      sessionId: "sess-abc123def456",
      provider: "pi",
      state: "settled",
      name: "worker-one",
      cwd: "/tmp/work",
      extensionConnected: true,
      capabilities: [],
      startedAt: NOW - 3 * HOUR,
      lastActivityAt: NOW - 60_000,
    } as any,
  ];

  test("opens a roster overlay in TUI mode", async () => {
    const { pi } = fakePi();
    let overlaySeen = false;
    const { ctx } = fakeCtx({
      ui: {
        notify: () => {},
        custom: async (_factory: any, options: any) => {
          overlaySeen = true;
          expect(options?.overlay).toBe(true);
          return undefined;
        },
      },
    });
    await commands.runIntercom(pi, ctx, { fetchPi: async () => peers, fetchClaude: async () => [], now: NOW });
    expect(overlaySeen).toBe(true);
  });

  test("without a TUI, notifies the roster text instead of opening an overlay", async () => {
    const { pi } = fakePi();
    const { ctx, notified } = fakeCtx({ mode: "print", hasUI: false });
    await commands.runIntercom(pi, ctx, { fetchPi: async () => peers, fetchClaude: async () => [], now: NOW });
    expect(notified.length).toBe(1);
    expect(notified[0].message).toContain("This session is coordinator [8ce996]");
    expect(notified[0].message).toContain("worker-one [6a9f3e]");
  });

  test("without a session id the command fails loudly instead of listing self as a peer", async () => {
    const { pi } = fakePi();
    let overlaySeen = false;
    const { ctx, notified } = fakeCtx({
      sessionManager: undefined,
      ui: {
        notify: (message: string, type?: string) => notified.push({ message, type } as any),
        custom: async () => {
          overlaySeen = true;
          return undefined;
        },
      },
    });
    await commands.runIntercom(pi, ctx, { fetchPi: async () => peers, fetchClaude: async () => [], now: NOW });
    expect(overlaySeen).toBe(false);
    expect(notified.length).toBe(1);
    expect(notified[0].message).toMatch(/needs the current session id/);
  });

  test("the overlay renders the roster rows and closes on escape", async () => {
    const overlay = new commands.IntercomRosterOverlay({
      lines: ["This session is coordinator [own-se] — mine.", "Peer sessions (1):", "  worker-one [sess-a]  ·  interactive  ·  idle"],
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
      close: () => {},
    });
    const rendered = overlay.render(80).join("\n");
    expect(rendered).toContain("intercom");
    expect(rendered).toContain("worker-one [sess-a]");
    let closed = false;
    const closable = new commands.IntercomRosterOverlay({
      lines: [],
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
      close: () => {
        closed = true;
      },
    });
    closable.handleInput("\u001b");
    expect(closed).toBe(true);
  });

  test("arrow keys scroll without closing", async () => {
    let closed = false;
    const overlay = new commands.IntercomRosterOverlay({
      lines: Array.from({ length: 30 }, (_, i) => `  peer-${i} [abcdef]  ·  interactive  ·  idle`),
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
      close: () => {
        closed = true;
      },
    });
    overlay.handleInput("\u001b[A");
    overlay.handleInput("\u001b[B");
    overlay.handleInput("x-unhandled");
    expect(closed).toBe(false);
    expect(overlay.render(80).join("\n")).toContain("peer-0 [abcdef]");
  });
});
