import { describe, expect, it } from "bun:test";
import {
  CATALOG,
  evaluateDeterministic,
  cooldownAllows,
  applyCooldown,
  resetCooldowns,
  formatSuggestionCard,
  formatSuggestionPlain,
  jevRoster,
  cooldownKey,
  type StateSnapshot,
  type Cooldowns,
} from "../extensions/substrate-suggest/catalog.ts";
import { parseAnswerPayload, questionShape, pickClassifiers, classifyViaRegistry } from "../extensions/substrate-suggest/jev.ts";
import { waitCommitment, isMonitorSetter, isEditor, isProvenanceReader, provenanceDutyVerb } from "../extensions/substrate-suggest/duties.ts";

function snap(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    now: 1_000_000,
    ref: "CORE-1",
    lifecycleState: "open",
    claim: { holder: "dawid", expiresAt: 1_000_000 + 30 * 60_000 },
    readinessState: null,
    lastCheckpointSeq: 0,
    journalSeq: 0,
    latestKind: null,
    turnWasActive: true,
    ...overrides,
  };
}

describe("catalog", () => {
  it("has unique verb ids and bounded one-liners", () => {
    const ids = CATALOG.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of CATALOG) {
      expect(v.oneLine.length).toBeGreaterThan(10);
      expect(v.oneLine.length).toBeLessThan(120);
    }
  });

  it("jev roster only contains semantic verbs", () => {
    const roster = jevRoster();
    expect(roster.length).toBeGreaterThan(0);
    for (const r of roster) expect(r.oneLine).toBeTruthy();
  });
});

describe("deterministic triggers", () => {
  it("is silent without a bound ref or on terminal issues", () => {
    expect(evaluateDeterministic(snap({ ref: null }), {})).toBeNull();
    expect(evaluateDeterministic(snap({ lifecycleState: "done" }), {})).toBeNull();
  });

  it("is silent on idle turns", () => {
    expect(evaluateDeterministic(snap({ turnWasActive: false }), {})).toBeNull();
  });

  it("claim expiry outranks everything", () => {
    const s = snap({ claim: { holder: "dawid", expiresAt: 1_000_000 + 60_000 }, latestKind: "result", journalSeq: 20 });
    expect(evaluateDeterministic(s, {})).toBe("claim_renew");
  });

  it("a journaled result with a live claim suggests close", () => {
    const s = snap({ latestKind: "result", readinessState: "ready" });
    // readinessState null means dispatchable in the snapshot; emulate drift-free close case:
    const out = evaluateDeterministic({ ...s, readinessState: null }, {});
    expect(out).toBe("close_due");
  });

  it("readiness drift suggests a contract revision", () => {
    const s = snap({ readinessState: "draft" });
    expect(evaluateDeterministic(s, {})).toBe("revise_contract");
  });

  it("a healthy claimed READY issue is not drift", () => {
    const s = snap({ readinessState: "claimed" });
    expect(evaluateDeterministic(s, {})).toEqual({ kind: "semantic" });
  });

  it("blockers are not drift", () => {
    const s = snap({ readinessState: "blocked" });
    expect(evaluateDeterministic(s, {})).toEqual({ kind: "semantic" });
  });

  it("uncheckpointed backlog suggests a checkpoint", () => {
    const s = snap({ journalSeq: 9, lastCheckpointSeq: 1 });
    expect(evaluateDeterministic(s, {})).toBe("checkpoint");
  });

  it("ordinary active work defers to the semantic stage", () => {
    expect(evaluateDeterministic(snap(), {})).toEqual({ kind: "semantic" });
  });

  it("no claim means no suggestions", () => {
    expect(evaluateDeterministic(snap({ claim: null }), {})).toBeNull();
  });
});

describe("cooldowns", () => {
  it("blocks a repeat inside the window and resets fully", () => {
    const cd: Cooldowns = {};
    const verb = CATALOG.find((v) => v.id === "checkpoint")!;
    applyCooldown(cd, "CORE-1", verb);
    expect(cooldownAllows(cd, "CORE-1", verb.id, Date.now() + 1000, verb)).toBe(false);
    resetCooldowns(cd);
    expect(cooldownAllows(cd, "CORE-1", verb.id, Date.now(), verb)).toBe(true);
  });

  it("cooldown keys are issue-scoped", () => {
    expect(cooldownKey("CORE-1", "checkpoint")).not.toBe(cooldownKey("CORE-2", "checkpoint"));
  });
});

describe("wake card", () => {
  const verb = CATALOG.find((v) => v.id === "journal_decision")!;

  it("renders a dot header and an indented gold block with jev_confidence", () => {
    const card = formatSuggestionCard({ verb, ref: "CORE-9", confidence: 0.72, revision: 3 });
    const plain = formatSuggestionPlain({ verb, ref: "CORE-9", confidence: 0.72, revision: 3 });
    const lines = plain.split("\n");
    // dot on its own header row, like a tool row — white, out of the block
    expect(lines[0].startsWith("●")).toBe(true);
    expect(card).toContain("\x1b[1m●\x1b[22m");
    expect(card).not.toContain("\x1b[38;2;141;127;232m\x1b[1m●");
    expect(lines[0]).toContain("sb journal append");
    expect(lines[0]).toContain("CORE-9");
    // gold background + contrasting foreground + bold evidence
    expect(card).toContain("\x1b[48;2;201;162;39m");
    expect(card).toContain("\x1b[38;2;24;20;16m");
    expect(card).toContain("\x1b[1msubstrate_journal_append\x1b[22m");
    // confidence is labelled by its actual name
    expect(plain).toContain("jev_confidence: 0.72");
    expect(plain).toContain("rev 3");
    // indented rows of one width, no box furniture
    for (const row of lines.slice(1)) expect(row.startsWith("  ")).toBe(true);
    expect(new Set(lines.slice(1).map((l) => [...l].length)).size).toBe(1);
    expect(plain).not.toMatch(/[╭╰│]/);
  });

  it("high severity keeps the ! glyph", () => {
    const high = CATALOG.find((v) => v.id === "claim_renew")!;
    const card = formatSuggestionPlain({ verb: high, ref: "CORE-9" });
    expect(card).toContain("!");
    expect(card).not.toContain("●");
  });

  it("plain form carries no ANSI escapes", () => {
    const plain = formatSuggestionPlain({ verb, ref: "CORE-9" });
    expect(plain).not.toMatch(/\x1b\[/);
    expect(plain).toContain("CORE-9");
  });

  it("wraps long instructions instead of overflowing", () => {
    const long = { ...verb, instruction: () => "x ".repeat(200) };
    const plain = formatSuggestionPlain({ verb: long, ref: "CORE-9" });
    const widths = new Set(plain.split("\n").slice(1).map((l) => [...l].length));
    expect(widths.size).toBe(1);
    expect(Math.max(...[...widths])).toBeLessThanOrEqual(90);
  });
});

