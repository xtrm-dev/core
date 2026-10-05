import { describe, expect, it } from "bun:test";
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

describe("CORE-2367: the card signals a suggestion, it does not claim a load", () => {
  const SRC = "../../extensions/skill-suggest/index.ts";

  it("uses advisory present-tense wording, never a completed load", async () => {
    const src = await Bun.file(new URL(SRC, import.meta.url)).text();
    expect(src).toContain("consider loading /skill:");
    expect(src).not.toContain("skill loaded /skill:");
  });

  it("names a reference by pack plus leaf, never by its full path", async () => {
    const src = await Bun.file(new URL(SRC, import.meta.url)).text();
    expect(src).toContain("reference to read · ${entry.skill}/${leafName(entry.id)}");
  });

  it("opens the body with the /skill: load hint Pi actually resolves", async () => {
    const src = await Bun.file(new URL(SRC, import.meta.url)).text();
    expect(src).toContain("Load this skill: /skill:${entry.skill}");
  });

  it("no longer discards the doctrine block at agent_end", async () => {
    const src = await Bun.file(new URL(SRC, import.meta.url)).text();
    // The bug: a block was built, then only the rendered card was sent, so the
    // model received nothing from the intention seam.
    const seam = src.slice(src.indexOf('seam: "agent_end"') - 4000);
    expect(seam).toContain("content: block");
    expect(seam).not.toMatch(/const block = doctrineBlock\([^;]+;\s*(?:logDecision[\s\S]{0,400}?)?content: formatSuggestionCard/);
  });
});

describe("CORE-2367: the header carries no dangling placeholder", () => {
  it("omits the separator when there is no real ref", async () => {
    const { formatSuggestionCard } = await import("../../extensions/substrate-suggest/catalog.ts");
    const verb = {
      id: "skill_suggest",
      action: "consider loading /skill:planning",
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
