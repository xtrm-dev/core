import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("R7 exact-name resolution (CORE-2435 I4, MMD-2538: ref/uds/prefix arms)", () => {
  const entries = [
    { kind: "pi", sessionId: "sess-aaa111", name: "worker-one" },
    { kind: "pi", sessionId: "sess-bbb222", name: "worker-two" },
    { kind: "claude", sessionId: "claude-ccc", name: "worker-one", sock: "/run/cc.sock" },
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

  test("a shared name prefix throws naming every candidate, never a guess", () => {
    expect(() => roster.resolveRosterTarget(entries, "worker-")).toThrow(/ambiguous session "worker-"/);
    expect(() => roster.resolveRosterTarget(entries, "worker-")).toThrow(/sess-aaa111/);
    expect(() => roster.resolveRosterTarget(entries, "worker-")).toThrow(/sess-bbb222/);
  });

  test("an input matching nothing is a miss listing every candidate with ref and leg", () => {
    const miss = roster.resolveRosterTarget(entries, "zzz-no-such-peer");
    expect(miss.target).toBeUndefined();
    expect(miss.error).toMatch(/no live session matches "zzz-no-such-peer"/);
    const refOf = (id: string) => roster.sessionRef(id);
    expect(miss.candidates).toEqual([
      `worker-one [${refOf("sess-aaa111")}] (Pi session)`,
      `worker-two [${refOf("sess-bbb222")}] (Pi session)`,
      `worker-one [${refOf("claude-ccc")}] (Claude session)`,
    ]);
  });

  test("a uds: socket address resolves the Claude peer that owns it", () => {
    expect(roster.resolveRosterTarget(entries, "uds:/run/cc.sock")).toMatchObject({
      target: { sessionId: "claude-ccc" },
    });
  });

  test("a uds: socket with no owner is a miss, never a guess", () => {
    const miss = roster.resolveRosterTarget(entries, "uds:/run/nobody.sock");
    expect(miss.target).toBeUndefined();
    expect(miss.error).toMatch(/no live session matches/);
    expect(miss.candidates).toHaveLength(3);
  });

  test("a uds: address resolves a Pi shadow relay socket", () => {
    const shadowed = [{ kind: "pi", sessionId: "sess-aaa111", name: "worker-one", shadowSock: "/run/shadow.sock" }] as any;
    expect(roster.resolveRosterTarget(shadowed, "uds:/run/shadow.sock")).toMatchObject({
      target: { kind: "pi", sessionId: "sess-aaa111" },
    });
  });

  test("the 6-hex ref ListAgents prints resolves exactly", () => {
    const ref = roster.sessionRef("sess-bbb222");
    expect(ref).toMatch(/^[0-9a-f]{6}$/);
    expect(roster.resolveRosterTarget(entries, ref)).toMatchObject({ target: { sessionId: "sess-bbb222" } });
    const claudeRef = roster.sessionRef("claude-ccc");
    expect(roster.resolveRosterTarget(entries, claudeRef)).toMatchObject({ target: { sessionId: "claude-ccc" } });
  });

  test("a unique 4+ char prefix resolves: name, session id and ref", () => {
    expect(roster.resolveRosterTarget(entries, "worker-two")).toMatchObject({ target: { sessionId: "sess-bbb222" } });
    expect(roster.resolveRosterTarget(entries, "sess-bbb")).toMatchObject({ target: { sessionId: "sess-bbb222" } });
    const ref = roster.sessionRef("sess-bbb222");
    expect(roster.resolveRosterTarget(entries, ref.slice(0, 4))).toMatchObject({ target: { sessionId: "sess-bbb222" } });
  });

  test("a 3-char input never prefix-resolves: too short stays a miss", () => {
    const miss = roster.resolveRosterTarget(entries, "ses");
    expect(miss.target).toBeUndefined();
    expect(miss.error).toMatch(/no live session matches/);
  });

  test("four same-name live peers across legs and counterparties refuse ambiguity", () => {
    const four = [
      { kind: "pi", sessionId: "sess-dup-1", name: "agent" },
      { kind: "pi", sessionId: "sess-dup-2", name: "agent" },
      { kind: "claude", sessionId: "claude-dup-3", name: "agent", sock: "/run/a.sock" },
      // A different counterparty under the same name still refuses: no silent pick.
      { kind: "pi", sessionId: "sess-other-4", name: "agent" },
    ] as any;
    expect(() => roster.resolveRosterTarget(four, "agent")).toThrow(/ambiguous session "agent"/);
    for (const id of ["sess-dup-1", "sess-dup-2", "claude-dup-3", "sess-other-4"]) {
      expect(() => roster.resolveRosterTarget(four, "agent")).toThrow(new RegExp(id.replace(/-/g, "-")));
    }
    // ...but each is still reachable by its own full session id.
    expect(roster.resolveRosterTarget(four, "sess-dup-1")).toMatchObject({ target: { sessionId: "sess-dup-1" } });
    expect(roster.resolveRosterTarget(four, "sess-other-4")).toMatchObject({ target: { sessionId: "sess-other-4" } });
    expect(roster.resolveRosterTarget(four, "uds:/run/a.sock")).toMatchObject({ target: { sessionId: "claude-dup-3" } });
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

  test("a down Pi registry degrades to a partial Claude roster with a warning (CORE-2498)", async () => {
    const { pi, tools } = fakePi();
    roster.registerListAgentsTool(pi, {
      fetchPi: async () => {
        throw new Error("could not reach the agent host registry (GET /v1/sessions failed twice)");
      },
      fetchClaude: async () => [],
    });
    const result = await tools.ListAgents.execute("call-1", {}, undefined, undefined, {
      sessionManager: { getSessionId: () => "own-session-id-123456" },
    });
    expect(result.isError).toBeFalsy();
    expect(String(result.content[0].text)).toMatch(/Pi registry unreachable/);
    expect(String(result.content[0].text)).toMatch(/Pi leg omitted/);
    expect(result.details).toMatchObject({ error: true });
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

describe("shadow sockets and recent-Pi memo (CORE-2470)", () => {
  const SID = "sess-shadow-1";
  const live = (now: number) =>
    roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [piSummary({ sessionId: SID, name: "worker-shadow" })],
      claudePeers: [],
      now,
    });
  const lagged = (now: number) =>
    roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [],
      claudePeers: [claudePeer({ sessionId: SID, name: "worker-shadow", sock: "/run/shadow.sock" })],
      now,
    });

  test("dual-listed session: one Pi entry carrying the shadow socket", () => {
    roster.__resetRecentPi();
    const built = roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [piSummary({ sessionId: SID, name: "worker-shadow" })],
      claudePeers: [claudePeer({ sessionId: SID, name: "worker-shadow", sock: "/run/shadow.sock" })],
      now: NOW,
    });
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]).toMatchObject({ kind: "pi", sessionId: SID, shadowSock: "/run/shadow.sock" });
  });

  test("registry lag: memoized Pi id resolves as Pi with the shadow relay", () => {
    roster.__resetRecentPi();
    live(NOW);
    const built = lagged(NOW + 60_000);
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]).toMatchObject({ kind: "pi", sessionId: SID, shadowSock: "/run/shadow.sock" });
    expect(roster.resolveRosterTarget(built.entries, "worker-shadow")).toMatchObject({ target: { kind: "pi" } });
  });

  test("expired memo: shadow lists as Claude again", () => {
    roster.__resetRecentPi();
    live(NOW);
    const built = lagged(NOW + roster.RECENT_PI_TTL_MS + 1);
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]).toMatchObject({ kind: "claude", sessionId: SID });
    expect(built.entries[0]).not.toHaveProperty("shadowSock");
  });

  test("unknown Claude ids still list as Claude, never Pi", () => {
    roster.__resetRecentPi();
    live(NOW);
    const built = roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [],
      claudePeers: [claudePeer({ sessionId: "claude-fresh-1", name: "stranger", sock: "/run/other.sock" })],
      now: NOW + 60_000,
    });
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]).toMatchObject({ kind: "claude", sessionId: "claude-fresh-1" });
    expect(built.entries[0]).not.toHaveProperty("shadowSock");
  });
});

describe("fetch retry on transport failure (CORE-2470)", () => {
  async function stubServer(onRequest: (n: number, req: any, res: any) => void) {
    const { createServer } = await import("node:http");
    let hits = 0;
    const server = createServer((req: any, res: any) => {
      hits += 1;
      onRequest(hits, req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, port: (server.address() as any).port, hits: () => hits };
  }
  const payloadFor = (id: string) => JSON.stringify({ kind: "session_list", sessions: [piSummary({ sessionId: id, name: "steady" })] });

  test("a dropped first connection retries once and still lists", async () => {
    const { server, port, hits } = await stubServer((n, req, res) => {
      if (n === 1) {
        (req.socket as any)?.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payloadFor("sess-retry-1"));
    });
    try {
      const sessions = await roster.fetchPiSessions({ address: "127.0.0.1", port, timeoutMs: 2000 });
      expect(hits()).toBe(2);
      expect(sessions.some((s: any) => s.sessionId === "sess-retry-1")).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test("a persistent failure throws fail-closed after exactly one retry, never a silent empty", async () => {
    const { server, port, hits } = await stubServer((n, req) => {
      (req.socket as any)?.destroy();
    });
    try {
      await expect(roster.fetchPiSessions({ address: "127.0.0.1", port, timeoutMs: 500 })).rejects.toThrow(/agent host registry/);
      expect(hits()).toBe(2);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test("consecutive total failures stay loud: the roster never flaps to a partial list", async () => {
    const { server, port } = await stubServer((n, req) => {
      (req.socket as any)?.destroy();
    });
    try {
      // Every attempt throws: no call ever resolves a silent [] that would
      // flip Pi peers to their Claude shadow and back (MMD-2538 flap).
      for (let i = 0; i < 3; i += 1) {
        await expect(roster.fetchPiSessions({ address: "127.0.0.1", port, timeoutMs: 500 })).rejects.toThrow(/agent host registry/);
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("provider-aware leg classification (CORE-2479)", () => {
  function hostClaudeSummary(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: "sess-claude-1",
      provider: "claude",
      state: "settled",
      name: "xu82",
      cwd: "/tmp/x",
      tmux: { session: "xtrm-rc", paneId: "%77" },
      extensionConnected: false,
      capabilities: [],
      startedAt: NOW - 3 * HOUR,
      lastActivityAt: NOW - 60_000,
      ...overrides,
    } as any;
  }

  test("piRosterRow names the leg from the provider, never assuming Pi", () => {
    expect(roster.piRosterRow(piSummary({ provider: "pi" }), NOW).kind).toBe("pi");
    expect(roster.piRosterRow(piSummary({ provider: "claude" }), NOW).kind).toBe("claude");
    expect(roster.piRosterRow(piSummary({ provider: "codex" }), NOW).kind).toBe("claude");
  });

  test("a host Claude session lists as Claude, never Pi", () => {
    roster.__resetRecentPi();
    const built = roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [hostClaudeSummary()],
      claudePeers: [],
      now: NOW,
    });
    expect(built.peers).toHaveLength(1);
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]).toMatchObject({ kind: "claude", sessionId: "sess-claude-1" });
    expect(built.peers[0]).toMatchObject({
      kind: "claude",
      ref: roster.sessionRef("sess-claude-1"),
      where: "tmux xtrm-rc:%77",
    });
    expect(roster.resolveRosterTarget(built.entries, "xu82")).toMatchObject({ target: { kind: "claude" } });
  });

  test("dual registration (host Claude + live socket, same session) lists once on the live leg", () => {
    roster.__resetRecentPi();
    const built = roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [hostClaudeSummary()],
      claudePeers: [claudePeer({ sessionId: "sess-claude-1", name: "xu82", sock: "/run/xu82.sock" })],
      now: NOW,
    });
    expect(built.peers).toHaveLength(1);
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]).toMatchObject({ kind: "claude", sessionId: "sess-claude-1" });
    // Same ref on both registrations: the socket row carries the session hash, so no R7 ambiguity.
    expect(built.peers[0].ref).toBe(roster.sessionRef("sess-claude-1"));
    expect(roster.resolveRosterTarget(built.entries, "xu82")).toMatchObject({ target: { kind: "claude" } });
    // CORE-2488: the live socket must ride the dual-registered entry. Dropping
    // it left us-on-a-host-record addressable by name only, so a uds: address
    // that the peer itself reports was refused in under a second.
    expect(built.entries[0].sock).toBe("/run/xu82.sock");
    expect(roster.resolveRosterTarget(built.entries, "uds:/run/xu82.sock")).toMatchObject({
      target: { kind: "claude", sessionId: "sess-claude-1" },
    });
  });

  test("a Pi entry carries extensionConnected for disconnected-extension routing", () => {
    roster.__resetRecentPi();
    const built = roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [piSummary({ sessionId: "sess-pi-down", extensionConnected: false })],
      claudePeers: [claudePeer({ sessionId: "sess-pi-down", name: "worker-one", sock: "/run/shadow.sock" })],
      now: NOW,
    });
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]).toMatchObject({
      kind: "pi",
      sessionId: "sess-pi-down",
      extensionConnected: false,
      shadowSock: "/run/shadow.sock",
    });
  });

  test("a Claude host record never memoizes as Pi across registry lag", () => {
    roster.__resetRecentPi();
    // Live window: only the Claude host record is present, no socket yet.
    roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [hostClaudeSummary()],
      claudePeers: [],
      now: NOW,
    });
    // Lag window: the host record drops while the live socket appears.
    const built = roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [],
      claudePeers: [claudePeer({ sessionId: "sess-claude-1", name: "xu82", sock: "/run/xu82.sock" })],
      now: NOW + 60_000,
    });
    expect(built.entries).toHaveLength(1);
    expect(built.entries[0]).toMatchObject({ kind: "claude", sessionId: "sess-claude-1" });
    expect(built.entries[0]).not.toHaveProperty("shadowSock");
    expect(roster.resolveRosterTarget(built.entries, "xu82")).toMatchObject({ target: { kind: "claude" } });
  });

  test.each([["failed"], ["history_only"]])("a %s host Claude record stays out of the roster", (state) => {
    roster.__resetRecentPi();
    const built = roster.buildRoster({
      ownSessionId: "own-session-id-123456",
      piSessions: [hostClaudeSummary({ sessionId: "sess-dead-claude", name: "ghost-claude", state })],
      claudePeers: [],
      now: NOW,
    });
    expect(built.peers).toEqual([]);
    expect(built.entries).toEqual([]);
  });
});

describe("roster miss trace (CORE-2488 phase 1)", () => {
  function captureTraceFile(): { lines: () => string[]; stderr: () => unknown[]; restore: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "intercom-roster-trace-"));
    const file = join(dir, "intercom-trace.log");
    const prevFile = process.env["INTERCOM_TRACE_FILE"];
    const prevSession = process.env["XTRM_SESSION_ID"];
    process.env["INTERCOM_TRACE_FILE"] = file;
    process.env["XTRM_SESSION_ID"] = "sess-test-trace";
    const errors: unknown[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(line);
    });
    const read = (): string[] => {
      try {
        return readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
      } catch {
        return [];
      }
    };
    return {
      lines: read,
      stderr: () => errors,
      restore: () => {
        spy.mockRestore();
        if (prevFile === undefined) delete process.env["INTERCOM_TRACE_FILE"];
        else process.env["INTERCOM_TRACE_FILE"] = prevFile;
        if (prevSession === undefined) delete process.env["XTRM_SESSION_ID"];
        else process.env["XTRM_SESSION_ID"] = prevSession;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  test("a miss traces the attempted key and the entry count", () => {
    const cap = captureTraceFile();
    let lines: string[] = [];
    try {
      roster.resolveRosterTarget(
        [
          { kind: "pi", sessionId: "sess-abc123def456", name: "worker-one" },
          { kind: "claude", sessionId: "claude-session-9", name: "claude-nine", sock: "/run/cc-socks/9.sock", live: true },
        ],
        "zzz-no-such-peer",
      );
      lines = cap.lines();
    } finally {
      cap.restore();
    }
    expect(cap.stderr()).toEqual([]);
    expect(lines[0]).toBe("[intercom-trace] roster.miss key=zzz-no-such-peer entries=2 session=sess-test-trace");
  });

  test("a uds: miss names the closest Claude candidates with sock, sessionId and live", () => {
    const cap = captureTraceFile();
    let lines: string[] = [];
    try {
      roster.resolveRosterTarget(
        [
          // The failure shape: proved live, no socket on the entry.
          { kind: "claude", sessionId: "claude-session-9", name: "xu82", live: true },
          { kind: "claude", sessionId: "claude-session-7", name: "live-peer", sock: "/run/cc-socks/7.sock", sockSource: "claude-session-json:messagingSocketPath", live: true },
        ],
        "uds:/run/cc-socks/3058484.sock",
      );
      lines = cap.lines();
    } finally {
      cap.restore();
    }
    expect(cap.stderr()).toEqual([]);
    const candidates = lines.filter((line) => line.startsWith("[intercom-trace] roster.miss.candidate "));
    expect(candidates.length).toBeGreaterThan(0);
    const noSocket = candidates.find((line) => line.includes("name=xu82"));
    expect(noSocket).toBeTruthy();
    expect(noSocket).toContain("sock=none");
    expect(noSocket).toContain("live=true");
    expect(noSocket).toContain("sessionId=claude-session-9");
    const withSocket = candidates.find((line) => line.includes("name=live-peer"));
    expect(withSocket).toContain("sock=/run/cc-socks/7.sock");
    expect(withSocket).toContain("sockSource=claude-session-json:messagingSocketPath");
  });
});
