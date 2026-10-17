import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({ VERSION: "1.0.0-test" }));

const roster = await import("./roster.ts");

const HOUR = 3_600_000;
const NOW = 1_786_000_000_000;

function piSummary(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-abc123def456",
    provider: "pi",
    state: "settled",
    name: "worker-one",
    cwd: "/tmp/work",
    tmux: { session: "xtrm-rc", paneId: "%29" },
    extensionConnected: true,
    capabilities: [],
    startedAt: NOW - 3 * HOUR,
    lastActivityAt: NOW - 60_000,
    ...overrides,
  } as any;
}

describe("ListAgents row format (CORE-2435 I4, Claude Code parity)", () => {
  test("own header matches Claude Code's exact words, own name first", () => {
    const text = roster.buildListAgentsText({ sessionId: "own-session-id-123456", name: "coordinator" }, [], NOW);
    const [first] = text.split("\n");
    expect(first).toBe(
      "This session is coordinator [own-se] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).",
    );
  });

  test("peer rows copy Claude Code's row shape: name [ref] · kind · state · where · started", () => {
    const text = roster.buildListAgentsText(
      { sessionId: "own-session-id-123456", name: "coordinator" },
      [roster.piRosterRow(piSummary(), NOW)],
      NOW,
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe("Peer sessions (1):");
    expect(lines[2]).toBe("  worker-one [sess-a]  ·  interactive  ·  idle  ·  tmux xtrm-rc:%29  ·  started 3h ago");
  });

  test("a Claude peer row shares the one roster shape", () => {
    const text = roster.buildListAgentsText(
      { sessionId: "own-session-id-123456", name: "coordinator" },
      [
        roster.claudeRosterRow(
          { name: "helper", sessionId: "claude-session-9", sock: "/tmp/cc.sock", cwd: "/tmp/c", status: "idle", kind: "interactive", startedAt: NOW - 2 * HOUR } as any,
          NOW,
        ),
      ],
      NOW,
    );
    expect(text.split("\n")[2]).toBe("  helper [claude]  ·  interactive  ·  idle  ·  /tmp/c  ·  started 2h ago");
  });

  test("empty roster still prints the header with a zero count", () => {
    const text = roster.buildListAgentsText({ sessionId: "own-session-id-123456", name: "coordinator" }, [], NOW);
    expect(text).toBe(
      "This session is coordinator [own-se] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).\n" +
        "Peer sessions (0):\n" +
        "  No other sessions.",
    );
  });

  test("model text carries no ANSI", () => {
    const text = roster.buildListAgentsText(
      { sessionId: "own-session-id-123456", name: "\u001b[31mcoordinator\u001b[0m" },
      [roster.piRosterRow(piSummary({ name: "\u001b[1mbad" }), NOW)],
      NOW,
    );
    expect(text).not.toMatch(/\u001b/);
    expect(text).toContain("coordinator");
  });

  test("the own session is never listed below the header", () => {
    const built = roster.buildRoster({
      ownSessionId: "sess-abc123def456",
      ownName: "worker-one",
      piSessions: [piSummary()],
      claudePeers: [],
      now: NOW,
    });
    expect(built.peers).toEqual([]);
    expect(built.text).toContain("Peer sessions (0):");
  });
});

describe("Pi session state words (busy/idle/offline)", () => {
  test.each([
    ["working", "busy"],
    ["waiting_for_input", "busy"],
    ["settled", "idle"],
    ["failed", "offline"],
    ["history_only", "offline"],
  ])("%s renders as %s", (state, word) => {
    expect(roster.piSessionStateWord(state)).toBe(word);
  });

  test("a Pi row without tmux falls back to the cwd", () => {
    const row = roster.piRosterRow(piSummary({ tmux: undefined }), NOW);
    expect(roster.formatRosterRow(row, NOW)).toBe(
      "  worker-one [sess-a]  ·  interactive  ·  idle  ·  /tmp/work  ·  started 3h ago",
    );
  });

  test("a Pi row without a name uses a session fallback, never empty", () => {
    const row = roster.piRosterRow(piSummary({ name: undefined }), NOW);
    expect(row.name).toBe("session sess-a");
  });
});

describe("R7 exact-name resolution", () => {
  const entries = [
    { kind: "pi", sessionId: "sess-aaa111", name: "worker-one" },
    { kind: "pi", sessionId: "sess-bbb222", name: "worker-two" },
    { kind: "claude", sessionId: "claude-ccc", name: "worker-one" },
  ] as any;

  test("an exact session id wins over names", () => {
    expect(roster.resolveRosterTarget(entries, "sess-bbb222")).toMatchObject({ target: { name: "worker-two" } });
  });

  test("an exact name with one hit resolves", () => {
    expect(roster.resolveRosterTarget(entries, "worker-two")).toMatchObject({ target: { sessionId: "sess-bbb222" } });
  });

  test("two live sessions under one name throw naming every candidate", () => {
    expect(() => roster.resolveRosterTarget(entries, "worker-one")).toThrow(/ambiguous session "worker-one"/);
    expect(() => roster.resolveRosterTarget(entries, "worker-one")).toThrow(/sess-aaa111/);
    expect(() => roster.resolveRosterTarget(entries, "worker-one")).toThrow(/claude-ccc/);
  });

  test("a name prefix that is not an exact hit is an error, never a guess", () => {
    const miss = roster.resolveRosterTarget(entries, "worker-");
    expect(miss.target).toBeUndefined();
    expect(miss.error).toMatch(/no live session matches "worker-"/);
    expect(miss.candidates).toContain("worker-one");
  });
});

describe("ListAgents tool registration", () => {
  function fakePi() {
    const tools: Record<string, any> = {};
    return {
      pi: {
        registerTool: (def: any) => {
          tools[def.name] = def;
        },
        getSessionName: () => "coordinator",
      } as any,
      tools,
    };
  }

  test("registers a model-only ListAgents tool, never the xtrm-ui names", async () => {
    const { pi, tools } = fakePi();
    roster.registerListAgentsTool(pi, {
      fetchPi: async () => [piSummary()],
      fetchClaude: async () => [],
    });
    expect(tools.ListAgents).toBeTruthy();
    expect(tools.ListAgents.exposure).toBe("model-only");
    for (const owned of ["bash", "read", "edit", "write", "find", "grep", "ls"]) {
      expect(tools[owned]).toBeUndefined();
    }
  });

  test("executing the tool prints own name first, then the peers", async () => {
    const { pi, tools } = fakePi();
    roster.registerListAgentsTool(pi, {
      fetchPi: async () => [piSummary()],
      fetchClaude: async () => [],
    });
    const result = await tools.ListAgents.execute("call-1", {}, undefined, undefined, {
      sessionManager: { getSessionId: () => "own-session-id-123456" },
    });
    const text = String(result.content[0].text);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^This session is coordinator \[own-se\]/);
    expect(lines[1]).toBe("Peer sessions (1):");
    expect(lines[2]).toContain("worker-one [sess-a]");
    expect(result.isError).toBeFalsy();
  });

  test("an unreachable agent host reads as an empty Pi roster, never a throw", async () => {
    const sessions = await roster.fetchPiSessions({ infoPath: "/nonexistent-dir/agent-host.json", timeoutMs: 200 });
    expect(sessions).toEqual([]);
  });

  test("a live agent host round-trips through fetchPiSessions", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = (await import("node:os")).default;
    const path = (await import("node:path")).default;
    const { startAgentHost } = await import("../../../../cli/src/core/agent-host.ts");
    const dir = mkdtempSync(path.join(os.tmpdir(), "xtrm-listagents-live-"));
    const host = await startAgentHost({ socketPath: path.join(dir, "host.sock"), infoPath: path.join(dir, "host.json"), log: () => {} });
    try {
      // No sessions bound yet: the roster is empty but reachable.
      const empty = await roster.fetchPiSessions({ address: host.info.address, port: host.info.port, timeoutMs: 2000 });
      expect(empty).toEqual([]);
      // A non-loopback address is never dialled.
      const refused = await roster.fetchPiSessions({ address: "example.com", port: host.info.port, timeoutMs: 500 });
      expect(refused).toEqual([]);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
