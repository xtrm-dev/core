/**
 * CORE-2535: offline replay evaluation over labelled real suggestion
 * situations (tests/skill-suggest/replay/corpus.jsonl, built from pi
 * transcripts of the 2026-10-29 audit). Floors are the agreed regression
 * gates; FLOORS documents how each was set.
 */
import "../isolate-logs.ts"; // CORE-2535: keep production decision logs untouched
import { describe, expect, it } from "bun:test";
import { CONTROL_ORIGINS, isServiceId, loadCorpus, loadFixture, replay, score, type Metrics } from "./replay/evaluate.ts";

const corpus = loadCorpus();
const fixture = loadFixture();

/**
 * Reset 2026-10-31 (CORE-2564) when the corpus grew from 150 to 600 rows: 450
 * rows are a seeded, unbiased sample of real prompts, so these are lower than
 * the 150-row values (recall 0.746, service 0.923), not a regression. Measured:
 * recall 143/197 = 0.726, service recall 56/65 = 0.862, top-1 76/197 = 0.386,
 * agent_end reach 1.0, criteria max 25. Floors sit two or three rows below.
 * Hard caps are contract values.
 */
export const FLOORS = {
  criteria_max: 240, // AgentRun core cap; the API rejects more than 255
  recall_shortlist: 0.71, // 140/197
  service_recall_shortlist: 0.83, // 54/65
  top1: 0.37, // 73/197
  control_reach_max: 0.1,
  agent_end_reach: 0.95,
} as const;

describe("replay corpus", () => {
  it("has at least 120 labelled rows, each with a valid label and roster ids", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(120);
    for (const row of corpus) {
      expect(["FIT", "PARTIAL", "MISS", "NO-SUGGESTION"]).toContain(row.label);
      const ids = new Set(fixture.repos[row.repo]?.ids ?? []);
      for (const id of row.expected) expect(ids.has(id)).toBe(true);
      if (row.label === "NO-SUGGESTION") expect(row.expected).toHaveLength(0);
      else expect(row.expected.length).toBeGreaterThan(0);
    }
  });

  it("keeps every mercury service prompt of the audit, service rows and controls", () => {
    expect(corpus.filter((r) => r.origin === "audit_service_prompt").length).toBeGreaterThanOrEqual(15);
    expect(corpus.filter((r) => r.expected.some(isServiceId)).length).toBeGreaterThanOrEqual(15);
    expect(corpus.filter((r) => CONTROL_ORIGINS.has(r.origin)).length).toBeGreaterThanOrEqual(20);
    expect(corpus.filter((r) => r.origin === "control_trivial").length).toBeGreaterThanOrEqual(15);
  });

  it("stores bounded, scrubbed excerpts only", () => {
    const text = JSON.stringify(corpus) + JSON.stringify(fixture);
    expect(text).not.toMatch(/\/home\/dawid|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/);
    for (const row of corpus) {
      expect(row.prompt.length).toBeLessThanOrEqual(600);
      expect(row.turn_text.length).toBeLessThanOrEqual(400);
    }
  });
});

describe("offline replay through the full decision path", () => {
  let metrics: Metrics;
  it("replays every row", async () => {
    metrics = score(await replay(corpus));
    console.log(`[replay] ${JSON.stringify(metrics)}`);
    expect(metrics.rows).toBe(corpus.length);
  }, 120_000);

  it("never shows the classifier more than 240 criteria", () => {
    expect(metrics.criteria_max).toBeLessThanOrEqual(FLOORS.criteria_max);
  });
  it("puts the expected entry in front of the classifier", () => {
    expect(metrics.recall_shortlist).toBeGreaterThanOrEqual(FLOORS.recall_shortlist);
    expect(metrics.service_recall_shortlist).toBeGreaterThanOrEqual(FLOORS.service_recall_shortlist);
  });
  it("ranks the expected entry first often enough", () => {
    expect(metrics.top1).toBeGreaterThanOrEqual(FLOORS.top1);
  });
  it("keeps injected peer text away from the input classifier", () => {
    expect(metrics.control_reach).toBeLessThanOrEqual(FLOORS.control_reach_max);
  });
  it("lets the working turn reach the classifier at agent_end", () => {
    expect(metrics.agent_end_reach).toBeGreaterThanOrEqual(FLOORS.agent_end_reach);
  });
});
