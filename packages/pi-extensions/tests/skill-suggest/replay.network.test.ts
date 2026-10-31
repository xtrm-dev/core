/**
 * CORE-2535: the replay against live Jev. Opt-in — runs only with
 * SKILL_SUGGEST_REPLAY_LIVE=1 and TYPESAFE_API_KEY set; otherwise every test
 * skips. Reports precision (fires naming an expected entry) and the fire rate
 * on rows labelled NO-SUGGESTION.
 */
import "../isolate-logs.ts"; // CORE-2535: keep production decision logs untouched
import { describe, expect, it } from "bun:test";
import { loadCorpus, replay, score } from "./replay/evaluate.ts";

const live = process.env["SKILL_SUGGEST_REPLAY_LIVE"] === "1" && Boolean(process.env["TYPESAFE_API_KEY"]);

describe.skipIf(!live)("live replay against Jev (network)", () => {
  it("reports precision and false-fire rate over the labelled corpus", async () => {
    const outcomes = await replay(loadCorpus(), { live: true });
    const m = score(outcomes);
    const quiet = outcomes.filter((o) => o.row.label === "NO-SUGGESTION");
    const falseFire = quiet.filter((o) => o.input.pick || o.agentEnd?.pick).length / Math.max(1, quiet.length);
    console.log(`[replay:live] ${JSON.stringify({ ...m, no_suggestion_rows: quiet.length, false_fire_rate: falseFire })}`);
    expect(m.criteria_max).toBeLessThanOrEqual(240);
    expect(m.fires).toBeGreaterThan(0);
  }, 900_000);
});
