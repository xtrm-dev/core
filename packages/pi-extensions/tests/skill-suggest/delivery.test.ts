import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPipeline, settle } from "../../shared/suggest-pipeline.ts";

// ---- behavioural harness: drive the registered handlers of a real extension instance ----

type Handler = (event: unknown, ctx?: unknown) => unknown;
interface Sent { content: string; details: Record<string, unknown> }

// Redirect the extension's decision log away from the operator's real one.
const LOG_DIR = mkdtempSync(join(tmpdir(), "skill-suggest-log-"));
process.env["SKILL_SUGGEST_LOG_DIR"] = LOG_DIR;
afterAll(() => rmSync(LOG_DIR, { recursive: true, force: true }));
const LOG_PATH = join(LOG_DIR, "log.jsonl");
// Rows are appended asynchronously (CORE-2534): drain the queue before reading.
const flushLog = async () => (await import("../../extensions/skill-suggest/index.ts")).flushDecisionLog();
const readLogSize = async () => (await flushLog(), existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0);
const readLogSince = async (size: number): Promise<Array<Record<string, unknown>>> =>
  (await flushLog(), readFileSync(LOG_PATH, "utf8").slice(size).split("\n").filter(Boolean).map((l) => JSON.parse(l)));

const CLASSIFIER_ANSWERS = {
  skill: { type: "choice", choice: "demo-skill", probabilities: { "demo-skill": 0.9, none: 0.1 }, confidence: 0.9 },
  would_follow_documented_procedure: { type: "bool", probability: 0.9 },
  prose_suffices: { type: "bool", probability: 0.1 },
  starts_governed_task: { type: "bool", probability: 0.9 },
};
const stubRegistry = {
  getAvailableOfType: async () => [{ id: "jev-test", provider: "typesafe" }],
  classify: async () => ({ stopReason: "stop", answers: CLASSIFIER_ANSWERS, model: "typesafe/jev-test" }),
};

const WORKING_TURN = {
  messages: [{
    role: "assistant",
    content: [{ type: "text", text: "Next I will follow the demo procedure." }, { type: "toolCall", id: "c1", name: "edit", arguments: { path: "a.ts" } }],
  }, { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "ok" }], isError: false }],
};

let repo: string;
let prevCwd: string;
beforeEach(async () => {
  prevCwd = process.cwd();
  repo = mkdtempSync(join(tmpdir(), "skill-suggest-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".xtrm", "skills", "demo-skill"), { recursive: true });
  writeFileSync(join(repo, ".xtrm", "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: Demo procedure for tests.\n---\n# Demo\n## Step one\n");
  process.chdir(repo);
  (await import("../../extensions/skill-suggest/roster.ts")).resetRosterCache();
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(repo, { recursive: true, force: true });
});

async function boot() {
  const handlers: Record<string, Handler> = {};
  const raw: Record<string, Handler> = {};
  const sent: Sent[] = [];
  let renderer: ((m: { content?: unknown }) => { render: () => string[] }) | null = null;
  const pi = {
    getFlag: () => false,
    // Handlers return before detached classification finishes (CORE-2549):
    // the harness waits for the pipeline to settle after each call.
    on: (name: string, fn: Handler) => { handlers[name] = async (e: unknown, c?: unknown) => { const r = await fn(e, c); await settle(); return r; }; raw[name] = fn; },
    sendMessage: (m: Sent) => { sent.push(m); },
    registerMessageRenderer: (_t: string, fn: typeof renderer) => { renderer = fn; },
  };
  resetPipeline();
  const mod = await import("../../extensions/skill-suggest/index.ts");
  mod.default(pi as never);
  // The index builds off the hot path; a test waits for it the way a session
  // gets it at session_start (CORE-2533).
  mod.resetIndex();
  await mod.rebuildIndex(process.cwd());
  const ctx = { modelRegistry: stubRegistry };
  return { handlers, raw, sent, ctx, render: (m: Sent) => (renderer ? renderer(m).render().join("\n") : "") };
}

describe("CORE-2367: agent_end delivers the doctrine to the model", () => {
  it("sends the <xtrm_context payload as message content, not an empty or card-only body", async () => {
    const { handlers, sent, ctx } = await boot();
    await handlers["agent_end"]!(WORKING_TURN, ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain("<xtrm_context");
    expect(sent[0]!.content).toContain('source="demo-skill"');
    // The opening hint is a /skill: command Pi actually resolves.
    expect(sent[0]!.content).toContain("Load this skill: /skill:demo-skill");
  });

  it("renders an imperative header, never a completed load", async () => {
    const { handlers, sent, ctx, render } = await boot();
    await handlers["agent_end"]!(WORKING_TURN, ctx);
    const card = render(sent[0]!);
    expect(card).toContain("load /skill:demo-skill/SKILL.md");
    expect(card).not.toContain("skill loaded");
  });
});

describe("CORE-2367: read-after-suggest accounting", () => {
  it("counts a real Pi read event ({toolName, input}) of the suggested path", async () => {
    const { handlers, ctx } = await boot();
    const before = await readLogSize();
    await handlers["agent_end"]!(WORKING_TURN, ctx);
    const skillPath = join(repo, ".xtrm", "skills", "demo-skill", "SKILL.md");
    handlers["tool_call"]!({ toolName: "read", input: { path: skillPath } });
    const rows = (await readLogSince(before)).filter((r) => r["seam"] === "read_after_suggest");
    expect(rows.map((r) => r["outcome"])).toEqual(["read"]);
    expect(rows[0]!["pick"]).toBe("demo-skill");
  });

  it("logs 'expired' once the window of turns passes with no read", async () => {
    const { handlers, ctx } = await boot();
    const before = await readLogSize();
    await handlers["agent_end"]!(WORKING_TURN, ctx); // arms the watch
    await handlers["agent_end"]!({ messages: [] }, ctx); // turn 1 after
    expect((await readLogSince(before)).some((r) => r["outcome"] === "expired")).toBe(false);
    await handlers["agent_end"]!({ messages: [] }, ctx); // turn 2 after: window over
    const expired = (await readLogSince(before)).filter((r) => r["outcome"] === "expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]!["pick"]).toBe("demo-skill");
    // A read after expiry is no longer credited.
    handlers["tool_call"]!({ toolName: "read", input: { path: join(repo, ".xtrm", "skills", "demo-skill", "SKILL.md") } });
    expect((await readLogSince(before)).some((r) => r["outcome"] === "read")).toBe(false);
  });

  it("a cooldown-suppressed suggestion arms no watch", async () => {
    const { handlers, ctx } = await boot();
    await handlers["agent_end"]!(WORKING_TURN, ctx); // fires, arms, sets cooldown
    await handlers["agent_end"]!({ messages: [] }, ctx);
    await handlers["agent_end"]!({ messages: [] }, ctx); // watch expires
    const before = await readLogSize();
    await handlers["agent_end"]!(WORKING_TURN, ctx); // same id within cooldown: suppressed
    await handlers["agent_end"]!({ messages: [] }, ctx);
    await handlers["agent_end"]!({ messages: [] }, ctx);
    expect((await readLogSince(before)).filter((r) => r["outcome"] === "expired")).toHaveLength(0);
  });
});

describe("CORE-2533: the classifier never sees more than the shortlist", () => {
  it("a 300-skill roster sends at most 24 criteria plus none, on both seams", async () => {
    for (let i = 0; i < 300; i++) {
      mkdirSync(join(repo, ".xtrm", "skills", `bulk-${i}`), { recursive: true });
      writeFileSync(join(repo, ".xtrm", "skills", `bulk-${i}`, "SKILL.md"), `---\nname: bulk-${i}\ndescription: Demo procedure variant ${i} for deploy work.\n---\n`);
    }
    const sizes: number[] = [];
    const capturing = {
      getAvailableOfType: async () => [{ id: "jev-test", provider: "typesafe" }],
      classify: async (_m: unknown, req: { questions: Record<string, { criteria?: Record<string, string> }> }) => {
        sizes.push(Object.keys(req.questions["skill"]?.criteria ?? {}).length);
        return { stopReason: "stop", answers: CLASSIFIER_ANSWERS, model: "typesafe/jev-test" };
      },
    };
    const { handlers } = await boot();
    await handlers["input"]!({ text: "follow the demo procedure for this deploy" }, { modelRegistry: capturing });
    await handlers["agent_end"]!(WORKING_TURN, { modelRegistry: capturing });
    expect(sizes.length).toBe(2);
    for (const n of sizes) {
      expect(n).toBeGreaterThan(1);
      expect(n).toBeLessThanOrEqual(25);
    }
  });
});

describe("CORE-2551: injected text never reaches the input classifier", () => {
  it("skips mid-session input with source 'extension', logs 'injected', and still judges the working turn", async () => {
    let asked = 0;
    const counting = { ...stubRegistry, classify: async (...a: [unknown, unknown]) => (asked++, stubRegistry.classify(...(a as []))) };
    const { handlers, sent } = await boot();
    await handlers["input"]!({ text: "/earlier", source: "interactive" }, { modelRegistry: counting });
    const before = await readLogSize();
    await handlers["input"]!({ text: "[cross-agent message] follow the demo procedure for this deploy", source: "extension" }, { modelRegistry: counting });
    expect(asked).toBe(0);
    expect((await readLogSince(before)).filter((r) => r["seam"] === "input").map((r) => r["reason"])).toEqual(["injected"]);
    await handlers["agent_end"]!(WORKING_TURN, { modelRegistry: counting });
    expect(asked).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it("an injected task that opens the session is judged (a dispatched worker's request)", async () => {
    let asked = 0;
    const counting = { ...stubRegistry, classify: async () => (asked++, stubRegistry.classify()) };
    const { handlers } = await boot();
    // A fresh instance has seen no input: this one opens the session.
    await handlers["input"]!({ text: "# Task: follow the demo procedure for this deploy", source: "extension" }, { modelRegistry: counting });
    expect(asked).toBe(1);
  });
  it("typed input is still judged", async () => {
    let asked = 0;
    const counting = { ...stubRegistry, classify: async () => (asked++, stubRegistry.classify()) };
    const { handlers } = await boot();
    await handlers["input"]!({ text: "follow the demo procedure for this deploy", source: "interactive" }, { modelRegistry: counting });
    expect(asked).toBe(1);
  });
});

describe("CORE-2564: a peer's message typed into the pane is a relay, not a request", () => {
  it("skips a mid-session interactive relay, logs 'peer_relay', and still judges the working turn", async () => {
    let asked = 0;
    const counting = { ...stubRegistry, classify: async (...a: [unknown, unknown]) => (asked++, stubRegistry.classify(...(a as []))) };
    const { handlers, sent } = await boot();
    await handlers["input"]!({ text: "/earlier", source: "interactive" }, { modelRegistry: counting });
    const before = await readLogSize();
    for (const text of [
      "Coordinator 8qox: follow the demo procedure for this deploy",
      "thur-coord -> wed2-helper: follow the demo procedure for this deploy",
      "fri-coord-b: scope addition, follow the demo procedure for this deploy",
      "From market-data-xt-claude-8qox: follow the demo procedure for this deploy",
    ]) {
      await handlers["input"]!({ text, source: "interactive" }, { modelRegistry: counting });
    }
    expect(asked).toBe(0);
    expect((await readLogSince(before)).filter((r) => r["seam"] === "input").map((r) => r["reason"])).toEqual(["peer_relay", "peer_relay", "peer_relay", "peer_relay"]);
    await handlers["agent_end"]!(WORKING_TURN, { modelRegistry: counting });
    expect(asked).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it("an operator request with a colon is still judged", async () => {
    let asked = 0;
    const counting = { ...stubRegistry, classify: async () => (asked++, stubRegistry.classify()) };
    const { handlers } = await boot();
    await handlers["input"]!({ text: "/earlier", source: "interactive" }, { modelRegistry: counting });
    await handlers["input"]!({ text: "deploy: follow the demo procedure for this deploy", source: "interactive" }, { modelRegistry: counting });
    expect(asked).toBe(1);
  });
});

describe("CORE-2564: agent_end reads each run's own messages", () => {
  it("judges a later, shorter run of the session, not only the first", async () => {
    // pi-agent-core emits agent_end with the messages the run generated, a new
    // array per run; a cursor carried across runs skipped the later ones.
    const states: Array<Record<string, unknown>> = [];
    const capturing = { ...stubRegistry, classify: async (_m: unknown, req: { state: Record<string, unknown> }) => (states.push(req.state), stubRegistry.classify()) };
    const { handlers } = await boot();
    const long = { messages: [...WORKING_TURN.messages, ...WORKING_TURN.messages, ...WORKING_TURN.messages] };
    await handlers["agent_end"]!(long, { modelRegistry: capturing });
    const second = {
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "Second run: next I will follow the demo procedure." }, { type: "toolCall", id: "c2", name: "edit", arguments: { path: "b.ts" } }],
      }, { role: "toolResult", toolCallId: "c2", toolName: "edit", content: [{ type: "text", text: "ok" }], isError: false }],
    };
    await handlers["agent_end"]!(second, { modelRegistry: capturing });
    expect(states).toHaveLength(2);
    expect(String(states[1]!["agent_final_message"])).toContain("Second run");
  });
});

describe("CORE-2532: a session's first prompt is judged while the index still builds", () => {
  it("waits for the index off the handler path instead of skipping as index_warming", async () => {
    let asked = 0;
    const counting = { ...stubRegistry, classify: async () => (asked++, stubRegistry.classify()) };
    const { handlers } = await boot();
    (await import("../../extensions/skill-suggest/index.ts")).resetIndex(); // as at session_start: no index yet
    const before = await readLogSize();
    await handlers["input"]!({ text: "follow the demo procedure for this deploy", source: "interactive" }, { modelRegistry: counting });
    expect(asked).toBe(1);
    expect((await readLogSince(before)).some((r) => r["reason"] === "index_warming")).toBe(false);
  });
});

describe("CORE-2367: the header carries no dangling placeholder", () => {
  it("omits the separator when there is no real ref", async () => {
    const { formatSuggestionCard } = await import("../../extensions/substrate-suggest/catalog.ts");
    const verb = {
      id: "skill_suggest",
      action: "load /skill:planning/SKILL.md",
      oneLine: "Turn intent into durable contracts.",
      instruction: () => "",
      severity: "normal" as const,
      cooldownMin: 30,
      source: "jev" as const,
    };
    const plain = formatSuggestionCard({ verb, ref: "—", confidence: 0.61, compact: true });
    const header = plain.split("\n")[0];
    expect(header).not.toContain("· —");
    expect(header).not.toMatch(/·\s*$/);
    // A real ref is still shown.
    const withRef = formatSuggestionCard({ verb, ref: "CORE-2367", confidence: 0.61, compact: true });
    expect(withRef.split("\n")[0]).toContain("· CORE-2367");
  });
});
