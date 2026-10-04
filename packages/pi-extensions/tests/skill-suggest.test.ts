import { describe, expect, it } from "bun:test";
import { parseFrontmatter, extractReferenceSummary, discoverRoster, resetRosterCache } from "../extensions/skill-suggest/roster.ts";
import { conversationContext } from "../extensions/skill-suggest/index.ts";
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

describe("input seam delivery", () => {
  it("uses the ordered prompt transform and emits no card", async () => {
    // Anchor the probe to this file, not the cwd: the suite runs from both.
    const src = await Bun.file(new URL("../extensions/skill-suggest/index.ts", import.meta.url)).text();
    const at = src.indexOf('delivery: "prompt-transform"');
    const seam = src.slice(at - 2000, at + 200);
    // Ordered delivery: the transform is the only race-free path at input.
    expect(seam).toContain('action: "transform"');
    // No second channel at this seam — the block in the prompt is the delivery,
    // so the operator never sees the doctrine twice.
    expect(seam).not.toContain("pi.sendMessage(");
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

  it("renders a framed one-row card with no raw XML", () => {
    const meta = parseContextBlock(block)!;
    const card = formatSuggestionPlain({
      verb: { id: "skill_suggest", action: `skill loaded · ${meta.source}`, oneLine: meta.body!, instruction: () => "", severity: "normal", cooldownMin: 30, source: "jev" },
      ref: "—",
      confidence: meta.confidence,
      compact: true,
    });
    const lines = card.split("\n");
    expect(lines).toHaveLength(3);
    expect(card).toContain("skill loaded · engineering-quality/causal-debugging");
    expect(card).not.toContain("xtrm_context");
    expect(new Set(lines.map((l) => [...l].length)).size).toBe(1);
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
