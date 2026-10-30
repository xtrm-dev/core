/**
 * CORE-2553: the decision gate over recorded Jev answers. answers.jsonl holds
 * what live Jev answered (2026-10-30, jev-1.14.0) for every replayed decision
 * of the CORE-2553 question set; replaying it is deterministic and offline.
 * The floors sit one corpus row under the measured values.
 */
import "../isolate-logs.ts"; // CORE-2535: keep production decision logs untouched
import { describe, expect, it } from "bun:test";
import { loadCorpus, replay, score } from "./replay/evaluate.ts";
import { cannedRegistry, loadAnswers } from "./replay/record.ts";

/** Measured on 2026-10-30: precision 20/35 = 0.571, false fires 3/79 = 0.038, 20 right fires. */
const FLOORS = { precision: 0.54, false_fire_max: 0.06, right_fires: 19 } as const;

describe("CORE-2553: the gate over recorded answers", () => {
  it("fires rarely on turns that need nothing and mostly names an expected entry", async () => {
    const answers = loadAnswers();
    const outcomes = await replay(loadCorpus(), { registry: (row, seam) => cannedRegistry(answers, row, seam) });
    const m = score(outcomes);
    const quiet = outcomes.filter((o) => o.row.label === "NO-SUGGESTION");
    const falseFire = quiet.filter((o) => o.input.pick || o.agentEnd?.pick).length / quiet.length;
    const right = outcomes.flatMap((o) => [o.input.pick, o.agentEnd?.pick].filter((p) => p && o.row.expected.includes(p))).length;
    console.log(`[replay:answers] ${JSON.stringify({ precision: m.precision, fires: m.fires, right, false_fire_rate: falseFire })}`);
    expect(m.precision).toBeGreaterThanOrEqual(FLOORS.precision);
    expect(falseFire).toBeLessThanOrEqual(FLOORS.false_fire_max);
    expect(right).toBeGreaterThanOrEqual(FLOORS.right_fires);
  }, 120_000);
});
