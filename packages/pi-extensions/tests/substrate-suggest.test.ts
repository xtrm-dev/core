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

  it("renders a dim-purple box with an italic, highlighted interior", () => {
    const card = formatSuggestionCard({ verb, ref: "CORE-9", confidence: 0.72, revision: 3 });
    const plain = formatSuggestionPlain({ verb, ref: "CORE-9", confidence: 0.72, revision: 3 });
    const lines = plain.split("\n");
    // top border (with the ● title) … bottom border, at least one content row
    expect(lines[0]).toMatch(/^╭─ ● suggestion ─+╮$/);
    expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/);
    // every interior row is boxed and the content is present
    const interior = lines.slice(1, -1);
    for (const row of interior) expect(row.startsWith("│")).toBe(true);
    const body = interior.join("\n");
    expect(body).toContain("sb journal append");
    expect(body).toContain("CORE-9");
    expect(body).toContain("Ignore this if it does not fit");
    expect(body).toContain("jev 0.72");
    expect(body).toContain("rev 3");
    // interior rows share one width, so the right edge aligns
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
    // dim purple strokes and italic interior, highlighted tokens in the render
    expect(card).toContain("\x1b[2m\x1b[38;2;141;127;232m│");
    expect(card).toContain("\x1b[3m");
    expect(card).toContain("\x1b[38;2;213;120;255m\x1b[1m");
  });

  it("wraps long instructions instead of overflowing the box", () => {
    const long = { ...verb, instruction: () => "x ".repeat(120) };
    const plain = formatSuggestionPlain({ verb: long, ref: "CORE-9" });
    const widths = new Set(plain.split("\n").map((l) => [...l].length));
    expect(widths.size).toBe(1);
    expect(Math.max(...[...widths])).toBeLessThanOrEqual(98);
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

});

describe("jev payload tolerance", () => {
  it("parses choice and noul answers in both number and boolean shapes", () => {
    const a = parseAnswerPayload({ type: "choice", choice: "journal_decision", probabilities: { journal_decision: 0.7 }, confidence: 0.7 });
    expect(a.choice?.choice).toBe("journal_decision");
    const b = parseAnswerPayload({ type: "noul", noul: true });
    expect(b.noul).toBe(1);
    const c = parseAnswerPayload({ type: "noul", noul: 0.4 });
    expect(c.noul).toBe(0.4);
    const d = parseAnswerPayload(null);
    expect(d).toEqual({});
  });

  it("question shapes stay in the neutral dict contract", () => {
    const q = questionShape("noul", "Did this turn matter?");
    expect(q).toEqual({ type: "noul", instructions: "Did this turn matter?" });
  });
});

describe("registry classifier path", () => {
  it("orders jev candidates: typesafe first, paid before free, non-jev dropped", () => {
    const models = [
      { provider: "opencode", id: "jev-1.13-free" },
      { provider: "some-other", id: "sentiment-x" },
      { provider: "opencode", id: "jev-1.13" },
      { provider: "typesafe", id: "jev-latest" },
    ];
    expect(pickClassifiers(models)).toEqual([
      { provider: "typesafe", id: "jev-latest" },
      { provider: "opencode", id: "jev-1.13" },
      { provider: "opencode", id: "jev-1.13-free" },
    ]);
    expect(pickClassifiers([{ provider: "a", id: "b" }])).toEqual([]);
  });

  it("falls through an errored candidate to the next", async () => {
    const tried: string[] = [];
    const registry = {
      getAvailableOfType: async () => [{ provider: "opencode", id: "jev-1.13" }, { provider: "opencode", id: "jev-1.13-free" }],
      classify: async (m: { id: string }) => {
        tried.push(m.id);
        if (m.id === "jev-1.13") return { answers: {}, stopReason: "error", errorMessage: "402 funds" };
        return {
          answers: {
            journal_kind: { type: "choice", choice: "journal_finding", probabilities: { journal_finding: 0.75 }, confidence: 0.5 },
            material_event: { type: "bool", probability: 0.71 },
          },
          stopReason: "stop",
        };
      },
    };
    const result = await classifyViaRegistry(registry, {}, {
      journal_kind: { type: "choice", instructions: "pick", criteria: { journal_finding: "fact" } },
      material_event: { type: "noul", instructions: "material?" },
    });
    expect(tried).toEqual(["jev-1.13", "jev-1.13-free"]);
    expect(result?.choice.choice).toBe("journal_finding");
    expect(result?.model).toBe("opencode/jev-1.13-free");
  });

  it("maps registry bool answers onto nouls and never rejects", async () => {
    const registry = {
      getAvailableOfType: async () => [{ provider: "opencode", id: "jev-1.13" }],
      classify: async (_m: unknown, ctx: { state: Record<string, unknown>; questions: Record<string, unknown> }) => {
        expect(ctx.state["issue_ref"]).toBe("CORE-1");
        expect(ctx.questions["material_event"]).toMatchObject({ type: "bool" });
        expect(ctx.questions["journal_kind"]).toMatchObject({ type: "choice" });
        return {
          answers: {
            journal_kind: { type: "choice", choice: "journal_finding", probabilities: { journal_finding: 0.8 }, confidence: 0.8 },
            material_event: { type: "bool", probability: 0.9 },
            prose_would_suffice: { type: "bool", probability: 0.2 },
          },
          stopReason: "stop",
          model: "jev-1.13",
        };
      },
    };
    const questions = {
      journal_kind: { type: "choice" as const, instructions: "pick", criteria: { journal_finding: "a fact" } },
      material_event: { type: "noul" as const, instructions: "material?" },
      prose_would_suffice: { type: "noul" as const, instructions: "forgettable?" },
    };
    const result = await classifyViaRegistry(registry, { issue_ref: "CORE-1" }, questions);
    expect(result?.choice.choice).toBe("journal_finding");
    expect(result?.nouls["material_event"]).toBe(0.9);
    expect(result?.model).toBe("jev-1.13");
  });

  it("returns null on error stopReason", async () => {
    const registry = {
      getAvailableOfType: async () => [{ provider: "opencode", id: "jev-1.13" }],
      classify: async () => ({ answers: {}, stopReason: "error" }),
    };
    expect(await classifyViaRegistry(registry, {}, {})).toBeNull();
  });
});

describe("wait-guard", () => {
  // Live-fire miss on 2026-10-03: the agent sleep-polled CI checks for four
  // turns and the guard never fired. These are that session's real final
  // messages — positives must all trigger, negatives must stay silent.
  const positives = [
    "All 6 pass; only Gitleaks is pending — the saturated queue the peer warned about. Waiting for it:",
    "Waiting on the #698 (docs) watcher — it'll wake me, and then I ping the peer.",
    "when both land",
    "once it merges, I cut the release",
    "I'll wait for CI",
    "let's wait for the deploy",
  ];
  const negatives = [
    "Status: both merges now run as background watchers that wake me on completion.",
    "Merging origin/main --no-edit now:",
    "The merge completed; notification woke me.",
  ];
  it("triggers on real wait-commitment phrasings (incl. pronoun targets)", () => {
    for (const t of positives) expect(waitCommitment(t)).toBe(true);
  });
  it("stays silent on active work and monitored narration", () => {
    for (const t of negatives) expect(waitCommitment(t)).toBe(false);
  });
  it("backgrounded wake seams set the monitor, foreground sleeps do not", () => {
    const t = (c: unknown) => ({ command: c });
    expect(isMonitorSetter("bash", t("bg_run 'watcher' /tmp/loop"), {})).toBe(true);
    expect(isMonitorSetter("bash", t("gh run watch 123 &"), {})).toBe(true);
    expect(isMonitorSetter("bash", t("nohup ./poll.sh &"), {})).toBe(true);
    expect(isMonitorSetter("bash", t("sleep infinity"), {})).toBe(true);
    expect(isMonitorSetter("intercom", { action: "ask" }, {})).toBe(true);
    // The 2026-10-03 misclassification: a timed foreground flex-sleep poll
    // masqueraded as a monitor and suppressed the guard.
    expect(isMonitorSetter("bash", t("sleep 45; gh pr view 697 …"), {})).toBe(false);
    expect(isMonitorSetter("bash", t("while true; do check; sleep 60; done"), {})).toBe(false);
  });
});

describe("provenance duty", () => {
  it("counts file-editing tools, not compute invocations", () => {
    expect(isEditor("edit")).toBe(true);
    expect(isEditor("write")).toBe(true);
    expect(isEditor("python")).toBe(false); // compute is too frequent to gate
    expect(isEditor("read")).toBe(false);
  });
  it("recognizes provenance consultation in tools and commands", () => {
    expect(isProvenanceReader("bash", { command: "git log --oneline -- src/x.ts" }, {})).toBe(true);
    expect(isProvenanceReader("bash", { command: "node change-provenance.mjs --repo . --path x" }, {})).toBe(true);
    expect(isProvenanceReader("gitnexus_context", { name: "f" }, {})).toBe(true);
    const e = { code: "preflight(repo, 'src/x.ts')" };
    expect(isProvenanceReader("python", {}, e as any)).toBe(true);
    expect(isProvenanceReader("python", {}, { code: "print(1+1)" })).toBe(false);
  });
  it("names the first edited file in the instruction", () => {
    const v = provenanceDutyVerb(["src/a/long.ts", "src/b.ts"]);
    expect(v.id).toBe("provenance_unread");
    expect(v.instruction()).toContain("long.ts");
    expect(v.instruction()).toContain("preflight");
  });
});
