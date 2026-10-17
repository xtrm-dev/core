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
  test("sets the session name and tells the operator", async () => {
    const { pi, currentName } = fakePi();
    const { ctx, notified } = fakeCtx();
    let patchedPid: number | null = null;
    const result = await commands.runRename(pi, "field-coordinator", ctx, {
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
    expect(notified[0].message).toContain("This session is coordinator [own-se]");
    expect(notified[0].message).toContain("worker-one [sess-a]");
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
});
