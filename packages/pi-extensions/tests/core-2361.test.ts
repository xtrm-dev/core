import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CORE-2361: suggestor upgrades — full roster coverage (pack-less home
// skills, non-reference docs, dedupe, no truncation), load-path-first cards,
// and the two Jev advisors that could never fire (noul-only question sets
// null out in both client paths).

const { discoverRoster, resetRosterCache } = await import("../extensions/skill-suggest/roster.ts");
const { doctrineBlock } = await import("../extensions/skill-suggest/index.ts");
const { parseContextBlock, contextBlock } = await import("../extensions/substrate-suggest/catalog.ts");

// The advisor chain needs the SDK mocked before the extension module loads.
mock.module("@earendil-works/pi-coding-agent", () => ({
  VERSION: "test",
  isToolCallEventType: (toolName: string, event: any) => event?.toolName === toolName,
  isBashToolResult: (event: any) => event?.toolName === "bash",
  isReadToolResult: (event: any) => event?.toolName === "read",
}));
const substrateSuggest = await import("../extensions/substrate-suggest/index.ts");

beforeEach(() => resetRosterCache());
afterEach(() => resetRosterCache());

describe("roster coverage (CORE-2361)", () => {
  test("pack-less roots: a top-level SKILL.md is discovered as a skill", () => {
    const tmp = mkdtempSync(join(tmpdir(), "roster-home-"));
    try {
      // ~/.agents-style layout: skill directly under the root.
      mkdirSync(join(tmp, ".agents", "skills", "one-skill", "references"), { recursive: true });
      writeFileSync(
        join(tmp, ".agents", "skills", "one-skill", "SKILL.md"),
        "---\nname: One Skill\ndescription: A top-level skill the old pack-only scan never found.\n---\n# One\n",
      );
      writeFileSync(
        join(tmp, ".agents", "skills", "one-skill", "references", "deep.md"),
        "# Deep Reference\n\nA reference with a real paragraph of sufficient length to extract cleanly here.\n",
      );
      const found = discoverRoster(tmp);
      const skill = found.find((e) => e.id === "one-skill");
      expect(skill?.level).toBe("skill");
      expect(skill?.name).toBe("One Skill");
      // Legacy id shape for direct references/*.md survives.
      expect(found.find((e) => e.id === "one-skill/deep")?.level).toBe("reference");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("non-reference docs under a skill dir join the roster with path ids", () => {
    const tmp = mkdtempSync(join(tmpdir(), "roster-agents-"));
    try {
      mkdirSync(join(tmp, ".agents", "skills", "some-skill", "agents"), { recursive: true });
      writeFileSync(
        join(tmp, ".agents", "skills", "some-skill", "SKILL.md"),
        "---\nname: Some\ndescription: Umbrella.\n---\n",
      );
      writeFileSync(
        join(tmp, ".agents", "skills", "some-skill", "agents", "analyzer.md"),
        "# Analyzer\n\nThe analyzer role prompt with a description long enough to be extracted as intended.\n",
      );
      const found = discoverRoster(tmp);
      expect(found.find((e) => e.id === "some-skill/agents/analyzer")?.level).toBe("reference");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the same skill in two roots is deduped, repo-first", () => {
    const tmp = mkdtempSync(join(tmpdir(), "roster-dedupe-"));
    try {
      for (const root of ["repo/.agents/skills/dup-skill", "home/.agents/skills/dup-skill"]) {
        mkdirSync(join(tmp, root), { recursive: true });
        writeFileSync(join(tmp, root, "SKILL.md"), "---\nname: Dup\ndescription: Same skill, two roots.\n---\n");
      }
      // discoverRoster only walks one repo root set; emulate by pointing cwd at
      // a repo-shaped tmp with .git, and rely on ordering: whatever order the
      // roots are scanned in, the id may appear once only.
      mkdirSync(join(tmp, "repo", ".git"), { recursive: true });
      const found = discoverRoster(join(tmp, "repo"));
      expect(found.filter((e) => e.id === "dup-skill").length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the real worktree roster exceeds the old bound of 60 — no truncation", () => {
    const found = discoverRoster(join(import.meta.dir, "../../.."));
    expect(found.length).toBeGreaterThan(60);
    const ids = new Set(found.map((e) => e.id));
    expect(found.length).toBe(ids.size); // bounded list is also unique
  });
});

describe("doctrine block leads with the load target (CORE-2361)", () => {
  const skillEntry = {
    id: "using-xtrm",
    skill: "using-xtrm",
    level: "skill" as const,
    name: "Using XTRM",
    description: "Core operating doctrine.",
    path: ".xtrm/skills/default/using-xtrm/SKILL.md",
  };
  const refEntry = {
    id: "multiplexing/operator-help-patterns",
    skill: "multiplexing",
    level: "reference" as const,
    name: "Operator Help Patterns",
    description: "Inventory and handoff patterns.",
    path: ".xtrm/skills/default/multiplexing/references/operator-help-patterns.md",
  };

  test("a skill hit names /skill:<name> on the first line", () => {
    const block = doctrineBlock(skillEntry, "the current request", 0.8, "fake");
    const first = block.split("\n")[2]; // after open tag + provenance line
    expect(first).toContain("/skill:using-xtrm");
    const meta = parseContextBlock(block);
    expect(meta?.skill).toBe("using-xtrm");
    expect(meta?.level).toBe("skill");
  });

  test("a reference hit names the exact path to read", () => {
    const block = doctrineBlock(refEntry, "the current request", 0.8, "fake");
    const first = block.split("\n")[2];
    expect(first).toContain("Read:");
    expect(first).toContain(refEntry.path);
    const meta = parseContextBlock(block);
    expect(meta?.level).toBe("reference");
    expect(meta?.source).toBe(refEntry.id);
  });

  test("contextBlock round-trips the new skill/level attrs", () => {
    const block = contextBlock("skill-doctrine", { source: "x", skill: "y", level: "reference", body: "b" });
    const meta = parseContextBlock(block);
    expect(meta?.skill).toBe("y");
    expect(meta?.level).toBe("reference");
  });
});

describe("the two silent advisors fire through a fake registry (CORE-2361)", () => {
  // Noul-only question sets can never return non-null from either Jev client
  // path; both duties now carry a mandatory choice question. Drive the full
  // agent_end chain with a fake registry and a wait-shaped final message that
  // the old regex would not have matched.

  type Sent = Array<{ content: unknown; details?: Record<string, unknown> }>;
  const fire = async (messages: unknown[], registry: unknown): Promise<Sent> => {
    const sent: Sent = [];
    const handlers = new Map<string, Array<(e: any, c: any) => unknown>>();
    const pi = {
      on(name: string, handler: (e: any, c: any) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        return () => {};
      },
      registerMessageRenderer: () => {},
      sendMessage: (m: any) => void sent.push(m),
      getFlag: () => false,
    };
    substrateSuggest.default(pi as never);
    const ctx = { modelRegistry: registry, cwd: "/tmp" };
    for (const h of handlers.get("agent_end") ?? []) await h({ messages }, ctx);
    return sent;
  };

  const registryWith = (nouls: Record<string, number>, choice: string) => ({
    getAvailableOfType: async () => [{ provider: "typesafe", id: "jev-fake" }],
    classify: async (_m: unknown, ctx: { questions: Record<string, unknown> }) => {
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(ctx.questions)) {
        const q = ctx.questions[id] as { type: string };
        answers[id] =
          q.type === "choice"
            ? { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 0.9 }
            : { type: "bool", probability: nouls[id] ?? 0.5 };
      }
      return { answers, stopReason: "stop", usage: { input: 1, output: 1 }, model: "fake-jev" };
    },
  });

  test("wait-guard fires on a wait-shaped turn that no regex would match", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", toolName: "bash" },
          { type: "text", text: "Everything is queued on my side; I will simply remain available until the pipeline reports back." },
        ],
      },
    ];
    const sent = await fire(messages as never, registryWith({ wait_warranted: 0.9, monitor_would_help: 0.9 }, "timer"));
    const card = sent.map((s) => String(s.content)).find((c) => c.includes("wait") || c.includes("monitor"));
    expect(card).toBeDefined();
    expect(card).toContain("wait without a monitor");
  });

  test("a low gate stays silent", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", toolName: "bash" },
          { type: "text", text: "I will wait for the pipeline to report back." },
        ],
      },
    ];
    const sent = await fire(messages as never, registryWith({ wait_warranted: 0.05, monitor_would_help: 0.05 }, "none"));
    expect(sent.length).toBe(0);
  });
});
