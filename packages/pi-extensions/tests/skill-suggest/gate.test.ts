import { describe, expect, it } from "bun:test";
import { evaluateGate, gateTerms } from "../../extensions/skill-suggest/index.ts";

const strong = { would_follow_documented_procedure: 0.9, prose_suffices: 0.1, asks_about_the_tooling: 0.05 };

describe("CORE-2366: missing evidence can no longer raise the gate", () => {
  it("a classifier that answered nothing does not fire", () => {
    // THE logged defect: three omitted nouls used to mean [0, 1, 1] -> 0.67, a
    // confident fire on total silence.
    const v = evaluateGate({ nouls: {}, confidence: 0.9, noneConfidence: 0.05, hasEntry: true });
    expect(v.fire).toBe(false);
    expect(v.reason).toBe("missing-positive-noul");
  });

  it("a missing NEGATING noul is imputed neutral, not maximal", () => {
    const withMissingNegator = { would_follow_documented_procedure: 0.9, prose_suffices: 0.1 };
    const { terms } = gateTerms(withMissingNegator);
    // prose_suffices is present -> 0.9; asks_about_the_tooling missing -> 0.5,
    // NOT the 1.0 the old `?? 0` default produced.
    expect(terms).toEqual([0.9, 0.9, 0.5]);
  });

  it("keeps a genuine negative able to veto", () => {
    // Imputing neutral must not neuter the gate: a real prose_suffices still counts.
    const v = evaluateGate({
      nouls: { would_follow_documented_procedure: 0.9, prose_suffices: 1.0, asks_about_the_tooling: 1.0 },
      confidence: 0.9,
      noneConfidence: 0.05,
      hasEntry: true,
    });
    expect(v.fire).toBe(false);
    expect(v.reason).toBe("vetoed-by-negators");
  });

  it("still fires when only one negator objects", () => {
    const v = evaluateGate({
      nouls: { would_follow_documented_procedure: 0.9, prose_suffices: 1.0, asks_about_the_tooling: 0.2 },
      confidence: 0.8,
      noneConfidence: 0.1,
      hasEntry: true,
    });
    expect(v.fire).toBe(true);
  });
});

describe("CORE-2366: confidence is required at BOTH seams", () => {
  it("rejects a near-zero-confidence pick behind a healthy gate", () => {
    const v = evaluateGate({ nouls: strong, confidence: 0.04, noneConfidence: 0.01, hasEntry: true });
    expect(v.fire).toBe(false);
    expect(v.reason).toBe("below-fits");
  });

  it("rejects a missing confidence rather than treating it as fine", () => {
    const v = evaluateGate({ nouls: strong, confidence: null, noneConfidence: 0.01, hasEntry: true });
    expect(v.fire).toBe(false);
    expect(v.reason).toBe("missing-confidence");
  });

  it("fires when the evidence is genuinely there", () => {
    const v = evaluateGate({ nouls: strong, confidence: 0.8, noneConfidence: 0.1, hasEntry: true });
    expect(v.fire).toBe(true);
    expect(v.reason).toBe("fire");
  });
});

describe("CORE-2366: the winner must beat `none`", () => {
  it("rejects a winner that barely clears the absolute bar but trails none", () => {
    const v = evaluateGate({ nouls: strong, confidence: 0.32, noneConfidence: 0.31, hasEntry: true });
    expect(v.fire).toBe(false);
    expect(v.reason).toBe("below-none-margin");
  });

  it("fires when the winner is meaningfully ahead of none", () => {
    const v = evaluateGate({ nouls: strong, confidence: 0.6, noneConfidence: 0.2, hasEntry: true });
    expect(v.fire).toBe(true);
  });

  it("does not invent a margin when none was not scored", () => {
    const v = evaluateGate({ nouls: strong, confidence: 0.35, noneConfidence: null, hasEntry: true });
    expect(v.fire).toBe(true);
  });
});

describe("CORE-2366: abstention is its own outcome, not `none`", () => {
  it("every refusal carries a distinct reason", () => {
    const reasons = new Set([
      evaluateGate({ nouls: {}, confidence: 0.9, noneConfidence: 0.1, hasEntry: true }).reason,
      evaluateGate({ nouls: strong, confidence: 0.05, noneConfidence: 0.0, hasEntry: true }).reason,
      evaluateGate({ nouls: strong, confidence: 0.9, noneConfidence: 0.89, hasEntry: true }).reason,
      evaluateGate({ nouls: strong, confidence: 0.9, noneConfidence: 0.1, hasEntry: false }).reason,
    ]);
    expect(reasons.size).toBe(4);
    expect(reasons.has("fire")).toBe(false);
  });

  it("an unknown entry is not treated as the none answer", () => {
    const v = evaluateGate({ nouls: strong, confidence: 0.9, noneConfidence: 0.1, hasEntry: false });
    expect(v.reason).toBe("unknown-entry");
  });
});
