import { describe, expect, it } from "bun:test";
import {
  contextBlock,
  parseContextBlock,
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

describe("duty gate observability (CORE-2359)", () => {
  it("records the gate outcome for every early return, not only fires", async () => {
    const src = await Bun.file(new URL("../extensions/substrate-suggest/index.ts", import.meta.url)).text();
    // The log must distinguish the gates, or silence is undiagnosable again.
    for (const reason of [
      "services_unavailable",
      "no_bound_issue",
      "turn_inactive",
      "issue_terminal",
      "no_due_duty",
      "cooldown",
    ]) {
      expect(src, reason).toContain(`gate("${reason}"`);
    }
    // no_due_duty must carry the state that explains WHY nothing was due.
    expect(src).toContain("claim_expires_at");
    expect(src).toContain("journal_entries");
  });
});

describe("wake card", () => {
  const verb = CATALOG.find((v) => v.id === "journal_decision")!;

  it("bands the header text in gold and leaves the dot and body unbanded", () => {
    const card = formatSuggestionCard({ verb, ref: "CORE-9", confidence: 0.72, revision: 3 });
    const plain = formatSuggestionPlain({ verb, ref: "CORE-9", confidence: 0.72, revision: 3 });
    const [head, ...body] = plain.split("\n");

    // dot first, white, then the gold band begins at the header text
    expect(head.startsWith("●")).toBe(true);
    expect(card).toContain("\x1b[1m●\x1b[22m");
    expect(head).toContain("sb journal append");
    expect(head).toContain("CORE-9");

    // gold + dark foreground + bold, on the header only
    const banded = card.split("\n")[0];
    expect(banded).toContain("\x1b[48;2;201;162;39m");
    expect(banded).toContain("\x1b[38;2;24;20;16m");
    expect(banded).toContain("\x1b[1m");
    for (const line of card.split("\n").slice(1)) {
      expect(line).not.toContain("\x1b[48;2;201;162;39m");
      expect(line).toContain("\x1b[3m"); // italic, normal background
    }

    // confidence is labelled by its actual name
    expect(plain).toContain("jev_confidence: 0.72");
    expect(plain).toContain("rev 3");
  });

  it("summarises a context block with its italic description, not the first body line", () => {
    const block = contextBlock("skill-doctrine", {
      about: "the current request",
      source: "engineering-quality/causal-debugging",
      model: "jev-1.13-free",
      confidence: 0.61,
      body: [
        "Injected context, not the operator's words:",
        "engineering-quality/causal-debugging \u2014 Use for bugs. Ignore this if it does not fit what actually happened.",
        "Its instructions: read .xtrm/skills/default/engineering-quality/references/causal-debugging.md and apply what fits before proceeding.",
        "Nested reference of the engineering-quality skill.",
        "\u001b[3mUse for bugs, regressions, crashes, unexpected output, failing tests.\u001b[23m",
      ].join("\n"),
    });
    const meta = parseContextBlock(block);
    expect(meta?.body).toBe("Use for bugs, regressions, crashes, unexpected output, failing tests.");
    expect(meta?.confidence).toBe(0.61);
    expect(meta?.source).toBe("engineering-quality/causal-debugging");
  });

  it("wraps long instructions instead of overflowing", () => {
    const long = { ...verb, instruction: () => "x ".repeat(200) };
    const plain = formatSuggestionPlain({ verb: long, ref: "CORE-9" });
    const widths = plain.split("\n").slice(1).map((l) => [...l].length);
    expect(Math.max(...widths)).toBeLessThanOrEqual(90);
  });
});

