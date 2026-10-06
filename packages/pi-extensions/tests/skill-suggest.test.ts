import { describe, expect, it } from "bun:test";
import { parseFrontmatter, extractReferenceSummary, discoverRoster, resetRosterCache } from "../extensions/skill-suggest/roster.ts";
import { conversationContext, isControlNudge, turnEvidence } from "../extensions/skill-suggest/index.ts";
import { contextBlock, formatSuggestionPlain, parseContextBlock } from "../extensions/substrate-suggest/catalog.ts";

describe("roster parsing", () => {
  it("parses folded and inline frontmatter descriptions", () => {
    const folded = parseFrontmatter("---\nname: eq\ndescription: >-\n  Causal debugging,\n  regression tracing.\n---\n\n# body");
    expect(folded.name).toBe("eq");
    expect(folded.description).toBe("Causal debugging, regression tracing.");
    const inline = parseFrontmatter("---\nname: x\ndescription: short\n---\n");
    expect(inline.description).toBe("short");
  });

  it("extracts reference summaries from heading + first paragraph", () => {
    const { name, description } = extractReferenceSummary("# Causal Debugging\n\nUse for bugs, regressions, crashes, unexpected output, failing tests.\n\n## Next\nMore.");
    expect(name).toBe("Causal Debugging");
    expect(description).toContain("Use for bugs, regressions");
  });

  it("discovers the curated pack two-tier from the repo worktree", () => {
    resetRosterCache();
    const roster = discoverRoster(process.cwd());
    expect(roster.length).toBeGreaterThan(20);
    const skills = roster.filter((r) => r.level === "skill");
    const refs = roster.filter((r) => r.level === "reference");
    expect(skills.length).toBeGreaterThan(5);
    expect(refs.length).toBeGreaterThan(skills.length); // doctrine depth dominates
    const causal = roster.find((r) => r.id === "engineering-quality/causal-debugging");
    expect(causal).toBeDefined();
    expect(causal!.description.toLowerCase()).toContain("bug");
    // every reference carries its parent skill
    for (const r of refs) expect(r.skill.length).toBeGreaterThan(0);
  });
});

describe("labelled injected context", () => {
  it("labels doctrine blocks with kind, source, author and confidence", () => {
    const block = contextBlock("skill-doctrine", {
      about: "the current request",
      source: "engineering-quality/causal-debugging",
      model: "jev-1.13-free",
      confidence: 0.38,
      body: "pointer",
    });
    expect(block).toContain('<xtrm_context kind="skill-doctrine"');
    expect(block).toContain('source="engineering-quality/causal-debugging"');
    expect(block).toContain('by="jev-1.13-free"');
    expect(block).toContain('confidence="0.38"');
    expect(block).toContain("Injected context, not the operator's words:");
    expect(block).toContain("</xtrm_context>");
  });

  it("settlements use the same convention", () => {
    const block = contextBlock("agent-settlement", { source: "sync-docs@CORE-2350", body: "docs merged" });
    expect(block).toContain('kind="agent-settlement"');
    expect(block).toContain('source="sync-docs@CORE-2350"');
  });
});

describe("input seam decides, never mutates", () => {
  it("returns continue and defers delivery to the first tool_result", async () => {
    // Anchor the probe to this file: the suite runs from two directories.
    const src = await Bun.file(new URL("../extensions/skill-suggest/index.ts", import.meta.url)).text();
    expect(src).toContain("deferred-to-tool-result");
    expect(src).toContain("pending = { entry, block, confidence: result.choice.confidence }");
    // No prompt mutation anywhere in the file, and no wake at submit.
    expect(src).not.toContain('action: "transform"');
    const deliver = src.slice(src.indexOf('pi.on("tool_result"'), src.indexOf('pi.on("tool_result"') + 1200);
    expect(deliver).toContain("triggerTurn: false");
    expect(deliver).not.toContain("triggerTurn: true");
  });

  it("restores the skill description, italic and period-stripped, at the end of the block", async () => {
    const src = await Bun.file(new URL("../extensions/skill-suggest/index.ts", import.meta.url)).text();
    expect(src).toContain("\\x1b[3m${stripEndPeriod(entry.description)}\\x1b[23m");
  });
});

describe("renderer parses the labelled block into a compact card", () => {
  const block = [
    '<xtrm_context kind="skill-doctrine" source="engineering-quality/causal-debugging" about="the current request" by="jev-1.13-free" confidence="0.59">',
    "Injected context, not the operator's words:",
    "engineering-quality/causal-debugging — Use for bugs, regressions, crashes…",
    "</xtrm_context>",
  ].join("\n");

  it("extracts kind, source and confidence", () => {
    const meta = parseContextBlock(block)!;
    expect(meta.kind).toBe("skill-doctrine");
    expect(meta.source).toBe("engineering-quality/causal-debugging");
    expect(meta.model).toBe("jev-1.13-free");
    expect(meta.confidence).toBeCloseTo(0.59);
    expect(meta.body).toContain("causal-debugging — Use for bugs");
  });

  it("returns null for content that is not a labelled block", () => {
    expect(parseContextBlock("just text")).toBeNull();
    expect(parseContextBlock("")).toBeNull();
  });

  it("renders a compact card with no raw XML", () => {
    const meta = parseContextBlock(block)!;
    const card = formatSuggestionPlain({
      verb: { id: "skill_suggest", action: `skill loaded · ${meta.source}`, oneLine: meta.body!, instruction: () => "", severity: "normal", cooldownMin: 30, source: "jev" },
      ref: "—",
      confidence: meta.confidence,
      compact: true,
    });
    const lines = card.split("\n");
    expect(lines[0].startsWith("●")).toBe(true);
    expect(card).toContain("skill loaded · engineering-quality/causal-debugging");
    expect(card).not.toContain("xtrm_context");
    expect(card).not.toMatch(/[╭╰│]/);
    expect(new Set(lines.slice(1).map((l) => [...l].length)).size).toBe(1);
  });
});

describe("conversation context for the classifier", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "why is the auth test flaky" }] },
    { role: "assistant", content: [{ type: "text", text: "Looking at the trace: the fixture writes then reads." }, { type: "tool_call" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ];

  it("renders recent turns as operator/agent lines, ignoring tool calls", () => {
    const ctx = conversationContext(msgs);
    expect(ctx).toContain("operator: why is the auth test flaky");
    expect(ctx).toContain("agent: Looking at the trace");
    expect(ctx).not.toContain("tool_call");
  });

  it("returns empty when there is no projection (fail-open)", () => {
    expect(conversationContext(undefined)).toBe("");
    expect(conversationContext([])).toBe("");
  });

  it("bounds the context so the classifier stays cheap", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `turn ${i} `.repeat(60) }] }));
    expect(conversationContext(many, 400).length).toBeLessThanOrEqual(400);
  });
});

describe("turn evidence beats final-message-only", () => {
  const turn = [
    { role: "user", content: [{ type: "text", text: "the auth test fails intermittently" }] },
    { role: "assistant", content: [{ type: "text", text: "I suspect the fixture races." }, { type: "tool_call", toolName: "bash", input: { command: "npm test" } }] },
    { role: "assistant", content: [{ type: "tool_result", toolName: "bash" }] },
    { role: "assistant", content: [{ type: "tool_call", toolName: "edit", input: { file_path: "src/auth.ts" } }] },
    { role: "assistant", content: [{ type: "text", text: "Done — verifying now." }] },
  ];

  it("captures activity, errors and edited files the final message hides", () => {
    const ev = turnEvidence(turn, 0);
    expect(ev.lastAssistant).toBe("Done — verifying now.");
    expect(ev.wasActive).toBe(true);
    expect(ev.errored).toBe(true);
    expect(ev.editedFiles).toEqual(["src/auth.ts"]);
    expect(ev.excerpt).toContain("user: the auth test fails intermittently");
    expect(ev.excerpt).toContain("tool: bash");
  });

  it("advances its cursor so consecutive turns do not double-count", () => {
    const first = turnEvidence(turn, 0);
    expect(first.nextIdx).toBe(turn.length);
    const next = turnEvidence([...turn, { role: "assistant", content: [{ type: "text", text: "new turn" }] }], first.nextIdx);
    expect(next.excerpt).toBe("assistant: new turn");
  });

  it("bounds the excerpt", () => {
    const huge = [{ role: "assistant", content: [{ type: "text", text: "x".repeat(5000) }] }];
    expect(turnEvidence(huge, 0).excerpt.length).toBeLessThanOrEqual(8000);
  });
});

describe("list-shaped reference docs", () => {
  it("describes a numbered-step doc by its first step, not by markers", () => {
    const md = ["# Messy run recovery", "", "1. Freeze new work assignment to it. 2. Send one concise native correction stating the violated constraint. 3. If there is a stale Pi inte…"].join("\n");
    const { name, description } = extractReferenceSummary(md);
    expect(name).toBe("Messy run recovery");
    expect(description).toBe("Freeze new work assignment to it.");
  });

  it("describes a bullet doc by its first bullet", () => {
    const md = ["# Native waiting", "", "- Pi short decision uses an intercom ask. - Pi long task uses intercom send. - tmux is the fallback"].join("\n");
    expect(extractReferenceSummary(md).description).toBe("Pi short decision uses an intercom ask.");
  });

  it("leaves prose docs alone", () => {
    const md = ["# Causal debugging", "", "Use for bugs, regressions, crashes, unexpected output, failing tests."].join("\n");
    expect(extractReferenceSummary(md).description).toContain("bugs, regressions");
  });
});
