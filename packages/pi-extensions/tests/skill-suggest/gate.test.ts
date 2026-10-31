import "../isolate-logs.ts"; // CORE-2535: keep production decision logs untouched
import { describe, expect, it } from "bun:test";
import { criteriaOf, decisionFeatures, decisionScore, NONE_CRITERION, rankedIds, SCORE_MODEL } from "../../extensions/skill-suggest/index.ts";

/** A decision with strong evidence for the top-ranked document. */
const strong = {
  skillNone: 0.05,
  wide: { a: 0.7, b: 0.2, c: 0.1 },
  nouls: { starts_governed_task: 0.9, prose_suffices: 0.1, n_named: 0.8 },
  winner: "a",
  fits: { a: 0.9, b: 0.3, c: 0.1 },
};
const scoreOf = (seam: "input" | "agent_end", d: Parameters<typeof decisionFeatures>[0]) => decisionScore(seam, decisionFeatures(d));

describe("CORE-2564: the fitted score decides", () => {
  it("fires at both seams when the evidence is genuinely there", () => {
    for (const seam of ["input", "agent_end"] as const) {
      expect(scoreOf(seam, strong).score!).toBeGreaterThanOrEqual(SCORE_MODEL[seam].threshold);
    }
  });
  it("does not fire when the reread document does not fit", () => {
    const weak = { ...strong, fits: { a: 0.05, b: 0.05, c: 0.05 } };
    for (const seam of ["input", "agent_end"] as const) {
      expect(scoreOf(seam, weak).score!).toBeLessThan(SCORE_MODEL[seam].threshold);
    }
  });
  it("does not fire at input when the narrow choice puts its weight on none", () => {
    expect(scoreOf("input", { ...strong, skillNone: 0.95 }).score!).toBeLessThan(SCORE_MODEL.input.threshold);
  });
  it("ranks by probability and keeps the answer's order on ties", () => {
    expect(rankedIds({ x: 0, y: 0.5, z: 0, w: 0.5 })).toEqual(["y", "w", "x", "z"]);
  });
});

describe("CORE-2366: missing evidence never fires", () => {
  it("a classifier that answered nothing abstains instead of scoring", () => {
    const v = scoreOf("input", { skillNone: null, wide: {}, nouls: {}, winner: null, fits: {} });
    expect(v.score).toBeNull();
    expect(v.missing).not.toBeNull();
  });
  it("each missing answer is named", () => {
    expect(scoreOf("agent_end", { ...strong, fits: {} }).missing).toBe("fits_win");
    expect(scoreOf("agent_end", { ...strong, nouls: { prose_suffices: 0.1 } }).missing).toBe("task");
    expect(scoreOf("input", { ...strong, skillNone: null }).missing).toBe("skill_none_inv");
    expect(scoreOf("input", { ...strong, nouls: { starts_governed_task: 0.9, prose_suffices: 0.1 } }).missing).toBe("n_named");
  });
  it("a winner the reread did not score abstains", () => {
    expect(scoreOf("agent_end", { ...strong, winner: "z" }).missing).toBe("fits_win");
  });
  it("the agent_end seam does not need the input-only answers", () => {
    expect(scoreOf("agent_end", { ...strong, skillNone: null, nouls: { starts_governed_task: 0.9, prose_suffices: 0.1 } }).missing).toBeNull();
  });
});

describe("CORE-2553: criteria name the document and, for a reference, its skill", () => {
  const skill = { id: "pc", skill: "pc", level: "skill", name: "programme-coordination", description: "Coordinate a programme of workers. Long tail.", path: "", headings: [] } as const;
  const ref = { id: "pc/workers", skill: "pc", level: "reference", name: "Workers", description: "Read this file at launch.", path: "", headings: [] } as const;
  it("prefixes a reference with its skill's first sentence and lists what none covers", () => {
    const c = criteriaOf([ref, skill], { entries: [skill, ref] });
    expect(c["pc/workers"]).toBe("Workers (part of pc: Coordinate a programme of workers.) — Read this file at launch.");
    expect(c["pc"]).toBe("programme-coordination: Coordinate a programme of workers. Long tail.");
    expect(c["none"]).toBe(NONE_CRITERION);
  });
  it("describes a service by its registry entry, and its docs as part of that service (CORE-2555)", () => {
    const head = { id: "sk/services/api", skill: "sk", level: "reference", name: "api", description: "Documentation authority: origin/master", path: "", headings: [] } as const;
    const doc = { id: "sk/services/api/references/runbook", skill: "sk", level: "reference", name: "Runbook", description: "Restart steps.", path: "", headings: [] } as const;
    const svc = { id: "api", name: "API Gateway", description: "Use when the gateway returns 5xx.", container: null, territory: [], skillPath: "" };
    const c = criteriaOf([head, doc], { entries: [head, doc], serviceOf: new Map([[head.id, svc], [doc.id, svc]]), serviceSkill: new Map([["api", head.id]]) });
    expect(c["sk/services/api"]).toBe("API Gateway service: Use when the gateway returns 5xx.");
    expect(c["sk/services/api/references/runbook"]).toBe("Runbook (part of the API Gateway service) — Restart steps.");
  });
});
