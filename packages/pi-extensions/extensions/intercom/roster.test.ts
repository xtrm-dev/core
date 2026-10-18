import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({ VERSION: "1.0.0-test" }));

const roster = await import("./roster.ts");

const HOUR = 3_600_000;
const NOW = 1_786_000_000_000;

// Golden refs: first 6 hex of sha256(sessionId). Opaque by design: our refs
// do not equal Claude Code's own refs.
const OWN_REF = "8ce996"; // own-session-id-123456
const PI_REF = "6a9f3e"; // sess-abc123def456
const CLAUDE_REF = "0f8ec3"; // claude-session-9

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

function claudePeer(overrides: Record<string, unknown> = {}) {
  return {
    name: "helper",
    sessionId: "claude-session-9",
    sock: "/tmp/cc.sock",
    cwd: "/tmp/c",
    status: "idle",
    kind: "interactive",
    tmux: "xtrm-rc:@27.%29",
    startedAt: NOW - 2 * HOUR,
    ...overrides,
  } as any;
}

describe("session refs (opaque hashes, not id prefixes)", () => {
  test("refs are 6 hex characters and stable", () => {
    expect(roster.sessionRef("sess-abc123def456")).toBe(PI_REF);
    expect(roster.sessionRef("sess-abc123def456")).toMatch(/^[0-9a-f]{6}$/);
  });

  test("UUIDv7 ids started 1 ms apart get different refs", () => {
    const a = roster.sessionRef("0193e5c2-1a2b-7c3d-8e4f-5a6b7c8d9e0f");
    const b = roster.sessionRef("0193e5c2-1a2b-7c3d-8e4f-5a6b7c8d9e10");
    expect(a).toBe("0cd491");
    expect(b).toBe("3ef929");
    expect(a).not.toBe(b);
  });
});

describe("ListAgents row format (CORE-2435 I4, Claude Code parity)", () => {
  test("own header matches Claude Code's exact words, own name first", () => {
    const text = roster.buildListAgentsText({ sessionId: "own-session-id-123456", name: "coordinator" }, [], NOW);
    const [first] = text.split("\n");
    expect(first).toBe(
      `This session is coordinator [${OWN_REF}] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).`,
    );
  });

  test("peer rows copy Claude Code's row shape: name [ref] · kind · state · tmux · started", () => {
    const text = roster.buildListAgentsText(
      { sessionId: "own-session-id-123456", name: "coordinator" },
      [roster.piRosterRow(piSummary(), NOW)],
      NOW,
    );
    const lines = text.split("\n");
    expect(lines[1]).toBe("Peer sessions (1):");
    expect(lines[2]).toBe(`  worker-one [${PI_REF}]  ·  pi  ·  idle  ·  tmux xtrm-rc:%29  ·  started 3h ago`);
  });

  test("a Claude peer row reads its tmux locator verbatim, in Claude's shape", () => {
    const text = roster.buildListAgentsText(
      { sessionId: "own-session-id-123456", name: "coordinator" },
      [roster.claudeRosterRow(claudePeer(), NOW)],
      NOW,
    );
    expect(text.split("\n")[2]).toBe(
      `  helper [${CLAUDE_REF}]  ·  interactive  ·  idle  ·  tmux xtrm-rc:@27.%29  ·  started 2h ago`,
    );
  });

  test("rows without a tmux locator omit the where segment: never the cwd", () => {
    const piRow = roster.formatRosterRow(roster.piRosterRow(piSummary({ tmux: undefined }), NOW), NOW);
    expect(piRow).toBe(`  worker-one [${PI_REF}]  ·  pi  ·  idle  ·  started 3h ago`);
    expect(piRow).not.toContain("/tmp/work");
    const claudeRow = roster.formatRosterRow(roster.claudeRosterRow(claudePeer({ tmux: undefined }), NOW), NOW);
    expect(claudeRow).toBe(`  helper [${CLAUDE_REF}]  ·  interactive  ·  idle  ·  started 2h ago`);
    expect(claudeRow).not.toContain("/tmp/c");
  });

  test("empty roster still prints the header with a zero count", () => {
    const text = roster.buildListAgentsText({ sessionId: "own-session-id-123456", name: "coordinator" }, [], NOW);
    expect(text).toBe(
      `This session is coordinator [${OWN_REF}] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).\n` +
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

describe("only live Pi sessions list (history_only and failed stay out)", () => {
  test.each([["working"], ["waiting_for_input"], ["settled"]])("%s lists", (state) => {
    const built = roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [piSummary({ sessionId: "sess-live-1", state })],
      claudePeers: [],
      now: NOW,
    });
    expect(built.peers).toHaveLength(1);
    expect(built.entries).toHaveLength(1);
  });

  test.each([["history_only"], ["failed"]])("%s lists nowhere: not a row, not a resolver entry", (state) => {
    const built = roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [piSummary({ sessionId: "sess-dead-1", name: "ghost", state })],
      claudePeers: [],
      now: NOW,
    });
    expect(built.peers).toEqual([]);
    expect(built.entries).toEqual([]);
    expect(built.text).toContain("Peer sessions (0):");
  });
});

describe("one session lists once across both sources (host row wins)", () => {
  test("a Pi session with a Claude entry appears once, and R7 resolves it", () => {
    const built = roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [piSummary()],
      claudePeers: [
        claudePeer({ sessionId: "sess-abc123def456", name: "worker-one", sock: "/run/cc.sock", tmux: undefined }),
      ],
      now: NOW,
    });
    expect(built.peers).toHaveLength(1);
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]).toMatchObject({ kind: "pi", sessionId: "sess-abc123def456" });
    expect(built.peers[0]).toMatchObject({ ref: PI_REF });
    expect(() => roster.resolveRosterTarget(built.entries, "worker-one")).not.toThrow();
    expect(roster.resolveRosterTarget(built.entries, "worker-one")).toMatchObject({ target: { kind: "pi" } });
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

  test("a Pi row without a name uses a session fallback, never empty", () => {
    const row = roster.piRosterRow(piSummary({ name: undefined }), NOW);
    expect(row.name).toBe(`session ${PI_REF}`);
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
    expect(miss.candidates).toEqual(["worker-one (Pi session)", "worker-two (Pi session)", "worker-one (Claude session)"]);
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
    expect(lines[0]).toMatch(new RegExp(`^This session is coordinator \\[${OWN_REF}\\]`));
    expect(lines[1]).toBe("Peer sessions (1):");
    expect(lines[2]).toContain(`worker-one [${PI_REF}]`);
    expect(result.isError).toBeFalsy();
  });

  test("without the real session id the tool fails instead of listing self as a peer", async () => {
    const { pi, tools } = fakePi();
    roster.registerListAgentsTool(pi, {
      fetchPi: async () => [piSummary()],
      fetchClaude: async () => [],
    });
    const result = await tools.ListAgents.execute("call-1", {}, undefined, undefined, {});
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).toMatch(/needs the current session id/);
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
