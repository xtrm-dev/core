import { describe, expect, it } from "bun:test";
import { parseFrontmatter, extractReferenceSummary, discoverRoster, resetRosterCache } from "../extensions/skill-suggest/roster.ts";
import { contextBlock } from "../extensions/substrate-suggest/catalog.ts";

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
