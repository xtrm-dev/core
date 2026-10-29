import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverySeam, type Situation } from "../../extensions/skill-suggest/index.ts";

const at = (o: Partial<Situation>): Situation => ({ prompted: false, pending: false, usedTool: false, activeTurn: false, ...o });

describe("delivery covers every situation", () => {
  it("prompted turn with tools delivers inline at the first tool_result", () => {
    expect(deliverySeam(at({ prompted: true, pending: true, usedTool: true }))).toBe("tool_result");
  });

  it("prompted turn WITHOUT tools still delivers — the regression that dropped a block", () => {
    expect(deliverySeam(at({ prompted: true, pending: true, usedTool: false }))).toBe("agent_end_flush");
  });

  it("unprompted turn (autonomous continue, resume) is judged at the boundary", () => {
    expect(deliverySeam(at({ prompted: false, pending: false, usedTool: true, activeTurn: true }))).toBe("agent_end_decision");
    expect(deliverySeam(at({ prompted: false, usedTool: false, activeTurn: true }))).toBe("agent_end_decision");
  });

  it("prompted turn that already delivered falls through to the boundary decision", () => {
    expect(deliverySeam(at({ prompted: true, pending: false, usedTool: true, activeTurn: true }))).toBe("agent_end_decision");
  });

  it("idle turns deliver nothing", () => {
    expect(deliverySeam(at({}))).toBe("none");
    expect(deliverySeam(at({ prompted: true, activeTurn: false }))).toBe("none");
  });
});

// ---- behavioural harness: drive the registered handlers of a real extension instance ----

type Handler = (event: unknown, ctx?: unknown) => unknown;
interface Sent { content: string; details: Record<string, unknown> }

// Redirect the extension's decision log away from the operator's real one.
const LOG_DIR = mkdtempSync(join(tmpdir(), "skill-suggest-log-"));
process.env["SKILL_SUGGEST_LOG_DIR"] = LOG_DIR;
afterAll(() => rmSync(LOG_DIR, { recursive: true, force: true }));
const LOG_PATH = join(LOG_DIR, "log.jsonl");
const readLogSize = () => (existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0);
const readLogSince = (size: number): Array<Record<string, unknown>> =>
  readFileSync(LOG_PATH, "utf8").slice(size).split("\n").filter(Boolean).map((l) => JSON.parse(l));

const CLASSIFIER_ANSWERS = {
  skill: { type: "choice", choice: "demo-skill", probabilities: { "demo-skill": 0.9, none: 0.1 }, confidence: 0.9 },
  would_follow_documented_procedure: { type: "bool", probability: 0.9 },
  prose_suffices: { type: "bool", probability: 0.1 },
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
  const sent: Sent[] = [];
  let renderer: ((m: { content?: unknown }) => { render: () => string[] }) | null = null;
  const pi = {
    getFlag: () => false,
    on: (name: string, fn: Handler) => { handlers[name] = fn; },
    sendMessage: (m: Sent) => { sent.push(m); },
    registerMessageRenderer: (_t: string, fn: typeof renderer) => { renderer = fn; },
  };
  const { default: ext } = await import("../../extensions/skill-suggest/index.ts");
  ext(pi as never);
  const ctx = { modelRegistry: stubRegistry };
  return { handlers, sent, ctx, render: (m: Sent) => (renderer ? renderer(m).render().join("\n") : "") };
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
    const before = readLogSize();
    await handlers["agent_end"]!(WORKING_TURN, ctx);
    const skillPath = join(repo, ".xtrm", "skills", "demo-skill", "SKILL.md");
    handlers["tool_call"]!({ toolName: "read", input: { path: skillPath } });
    const rows = readLogSince(before).filter((r) => r["seam"] === "read_after_suggest");
    expect(rows.map((r) => r["outcome"])).toEqual(["read"]);
    expect(rows[0]!["pick"]).toBe("demo-skill");
  });

  it("logs 'expired' once the window of turns passes with no read", async () => {
    const { handlers, ctx } = await boot();
    const before = readLogSize();
    await handlers["agent_end"]!(WORKING_TURN, ctx); // arms the watch
    await handlers["agent_end"]!({ messages: [] }, ctx); // turn 1 after
    expect(readLogSince(before).some((r) => r["outcome"] === "expired")).toBe(false);
    await handlers["agent_end"]!({ messages: [] }, ctx); // turn 2 after: window over
    const expired = readLogSince(before).filter((r) => r["outcome"] === "expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]!["pick"]).toBe("demo-skill");
    // A read after expiry is no longer credited.
    handlers["tool_call"]!({ toolName: "read", input: { path: join(repo, ".xtrm", "skills", "demo-skill", "SKILL.md") } });
    expect(readLogSince(before).some((r) => r["outcome"] === "read")).toBe(false);
  });

  it("a cooldown-suppressed suggestion arms no watch", async () => {
    const { handlers, ctx } = await boot();
    await handlers["agent_end"]!(WORKING_TURN, ctx); // fires, arms, sets cooldown
    await handlers["agent_end"]!({ messages: [] }, ctx);
    await handlers["agent_end"]!({ messages: [] }, ctx); // watch expires
    const before = readLogSize();
    await handlers["agent_end"]!(WORKING_TURN, ctx); // same id within cooldown: suppressed
    await handlers["agent_end"]!({ messages: [] }, ctx);
    await handlers["agent_end"]!({ messages: [] }, ctx);
    expect(readLogSince(before).filter((r) => r["outcome"] === "expired")).toHaveLength(0);
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
