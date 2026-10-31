/**
 * CORE-2553/CORE-2555: the decision gate over recorded Jev answers.
 * answers.jsonl holds what live Jev answered (2026-10-31, jev-1.14.0) for every
 * replayed decision of the current question set; replaying it is
 * deterministic and offline.
 *
 * Two measures. The corpus labels name one or two expected entries, so a
 * useful pick of a neighbouring document counts as wrong there. judgements.jsonl
 * holds a blind second opinion (a Sonnet judge that saw the moment and the
 * suggestion, not the label or which version made it) on every suggestion any
 * measured version fired: yes, partly or no.
 */
import "../isolate-logs.ts"; // CORE-2535: keep production decision logs untouched
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCorpus, replay, score } from "./replay/evaluate.ts";
import { cannedRegistry, loadAnswers } from "./replay/record.ts";

const verdicts = new Map<string, string>(
  readFileSync(join(import.meta.dir, "replay", "judgements.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((j: { decision: string; verdict: string }) => [j.decision, j.verdict]),
);

/**
 * CORE-2564, 2026-10-31: 600 rows (150 earlier + 450 seeded unbiased real
 * prompts), recorded live with the CORE-2564 peer-relay skip. Measured:
 * label precision 40/88 = 0.455, false fires 18/403 = 0.045, judged useful
 * 55/88 = 0.625, judged not useful 7/88 = 0.080. Three live runs averaged
 * 0.62 useful / 0.10 not useful with a spread under 0.015. On the earlier 150
 * rows alone useful was 0.72; the unbiased sample is the harder, truer
 * measure. Floors sit two or three suggestions from the measured values; a
 * fire the judge never saw counts as not useful.
 */
const FLOORS = { precision: 0.43, false_fire_max: 0.055, right_fires: 38, useful: 0.6, not_useful_max: 0.11 } as const;

describe("CORE-2553: the gate over recorded answers", () => {
  it("fires rarely on turns that need nothing and mostly suggests something useful", async () => {
    const answers = loadAnswers();
    const outcomes = await replay(loadCorpus(), { registry: (row, seam) => cannedRegistry(answers, row, seam) });
    const m = score(outcomes);
    const quiet = outcomes.filter((o) => o.row.label === "NO-SUGGESTION");
    const falseFire = quiet.filter((o) => o.input.pick || o.agentEnd?.pick).length / quiet.length;
    const fires = outcomes.flatMap((o) =>
      (
        [
          ["input", o.input.pick],
          ["agent_end", o.agentEnd?.pick],
        ] as const
      )
        .filter(([, p]) => p)
        .map(([seam, p]) => ({ row: o.row, key: `${o.row.id}|${seam}|${p}`, pick: p! })),
    );
    const right = fires.filter((f) => f.row.expected.includes(f.pick)).length;
    const verdictOf = (k: string) => verdicts.get(k) ?? "no";
    const useful = fires.filter((f) => verdictOf(f.key) === "yes").length / fires.length;
    const notUseful = fires.filter((f) => verdictOf(f.key) === "no").length / fires.length;
    console.log(`[replay:answers] ${JSON.stringify({ precision: m.precision, fires: m.fires, right, false_fire_rate: falseFire, useful, not_useful: notUseful })}`);
    expect(m.precision).toBeGreaterThanOrEqual(FLOORS.precision);
    expect(falseFire).toBeLessThanOrEqual(FLOORS.false_fire_max);
    expect(right).toBeGreaterThanOrEqual(FLOORS.right_fires);
    expect(useful).toBeGreaterThanOrEqual(FLOORS.useful);
    expect(notUseful).toBeLessThanOrEqual(FLOORS.not_useful_max);
  }, 120_000);
});
