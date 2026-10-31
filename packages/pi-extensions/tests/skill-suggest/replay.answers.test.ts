/**
 * CORE-2553/CORE-2555/CORE-2564: the decision over recorded Jev answers.
 * answers.jsonl holds what live Jev answered (2026-10-31, jev-1.14.0) to both
 * stages of every replayed decision, reduced to the answers the decision reads;
 * replaying it is deterministic and offline.
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
 * CORE-2564, 2026-11-01: the two-stage decision with the fitted score, over
 * the faithful replay (recorded turns and preceding conversation), recording
 * run 1 of 3. Measured: label precision 51/94 = 0.543, false fires 19/403 =
 * 0.047, judged useful 60/94 = 0.638, judged not useful 12/94 = 0.128. The
 * previous gate over the same answers: precision 0.39, false fires 0.05,
 * useful 0.51, not useful 0.14. Three runs agree within 0.02. Floors sit two or
 * three suggestions from the measured values; a fire the judge never saw
 * counts as not useful.
 */
const FLOORS = { precision: 0.52, false_fire_max: 0.055, right_fires: 48, useful: 0.6, not_useful_max: 0.15 } as const;

describe("CORE-2553/CORE-2564: the decision over recorded answers", () => {
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
