import "../isolate-logs.ts";
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRetrievalIndex } from "../../shared/shortlist.ts";

/**
 * CORE-2594 extraction proof. judge() moved from the Pi extension into shared/.
 * This test drives it with a scripted classifier and compares, byte for byte,
 * the Jev payloads (stage 1 and stage 2) and the Judgement for every skip path.
 * golden/judge.golden.json was captured from the pre-extraction code
 * (GOLDEN_JUDGE_MODULE=../../extensions/skill-suggest/index.ts GOLDEN_WRITE=1).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "golden", "docs");
const GOLDEN = join(HERE, "golden", "judge.golden.json");
// Offline and deterministic: a fake key so the REST fallback never reads the real key file,
// and a fetch that always fails so no scenario can reach the network or spend Jev tokens.
process.env["TYPESAFE_API_KEY"] = "golden-test-key-not-real";
const realFetch = globalThis.fetch;
const fetchCalls: string[] = [];
globalThis.fetch = (async (url: unknown) => { fetchCalls.push(String(url)); throw new Error("offline"); }) as typeof fetch;
const MODULE = process.env["GOLDEN_JUDGE_MODULE"] ?? "../../shared/judge.ts";
const { judge, SCORE_MODEL } = (await import(MODULE)) as { judge: (...a: any[]) => Promise<any>; SCORE_MODEL: Record<string, { threshold: number }> };

const entry = (id: string, skill: string, level: "skill" | "reference", name: string, description: string, file: string) => ({
  id, skill, level, name, description, path: join(FX, file), headings: [] as string[],
});
const ENTRIES = [
  entry("engineering-quality", "engineering-quality", "skill", "engineering-quality", "Debug, review, test and verify changes. Use for regressions.", "debug.md"),
  entry("engineering-quality/causal-debugging.md", "engineering-quality", "reference", "causal-debugging", "Read this file at launch for debugging regressions.", "debug.md"),
  entry("releasing", "releasing", "skill", "releasing", "Release process: changelog tag, registry, publish.", "release.md"),
  entry("review-pipeline", "review-pipeline", "skill", "review-pipeline", "Debug and review the release pipeline after a regression; covers triage, bisecting the failing change, reading the logs, and writing the regression test that proves the fix.", "debug.md"),
  entry("deploy-pipeline", "deploy-pipeline", "skill", "deploy-pipeline", "Deploy the release pipeline; debug a failed regression run.", "release.md"),
  entry("quality-gates", "quality-gates", "skill", "quality-gates", "Run quality gates on a release; debug a regression in a gate.", "debug.md"),
  entry("missing-doc", "misc", "skill", "missing-doc", "A debugging helper whose file does not exist.", "absent.md"),
];
const index = buildRetrievalIndex(ENTRIES, [], "/fx", "/fx");
const query = { text: "debug the regression in the release pipeline", files: [] as string[] };

type Answers = Record<string, Record<string, unknown>>;
const choice = (c: string, probabilities: Record<string, number>) => ({ type: "choice", choice: c, probabilities, confidence: probabilities[c] ?? null });
const bool = (p: number) => ({ type: "bool", probability: p });

/** A scripted registry: `script(call, questions)` returns the answers or throws. */
function registry(script: (call: number, q: Record<string, any>) => Answers | "error") {
  const calls: Array<{ state: unknown; questions: unknown }> = [];
  return {
    calls,
    reg: {
      getAvailableOfType: async () => [{ provider: "typesafe", id: "jev-1.14.0" }],
      classify: async (_m: unknown, ctx: { state: unknown; questions: Record<string, any> }) => {
        calls.push({ state: ctx.state, questions: ctx.questions });
        const a = script(calls.length, ctx.questions);
        return a === "error" ? { stopReason: "error", errorMessage: "x" } : { answers: a, model: "jev-1.14.0", usage: { input: 10, output: 5 } };
      },
    },
  };
}
const stage1 = (q: Record<string, any>, o: { skillNone?: number; wideTop?: string; wide?: Record<string, number>; task?: number; prose?: number; named?: number } = {}): Answers => {
  const ids = Object.keys(q["wide"].criteria);
  const wide = o.wide ?? Object.fromEntries(ids.map((id) => [id, id === (o.wideTop ?? ids[0]) ? 0.7 : 0.3 / Math.max(1, ids.length - 1)]));
  const a: Answers = { wide: choice(o.wideTop ?? ids[0]!, wide), starts_governed_task: bool(o.task ?? 0.9), prose_suffices: bool(o.prose ?? 0.1) };
  if (q["skill"]) a["skill"] = choice(Object.keys(q["skill"].criteria)[0]!, { ...Object.fromEntries(Object.keys(q["skill"].criteria).map((k) => [k, 0.1])), none: o.skillNone ?? 0.05 });
  if (q["n_named"]) a["n_named"] = bool(o.named ?? 0.8);
  return a;
};
const stage2 = (q: Record<string, any>, o: { winner?: string; fits?: number; drop?: string } = {}): Answers => {
  const ids = Object.keys(q["rr_wide"].criteria);
  const a: Answers = { rr_wide: choice(o.winner ?? ids[0]!, Object.fromEntries(ids.map((id) => [id, id === (o.winner ?? ids[0]) ? 0.8 : 0.1]))) };
  ids.forEach((_, i) => { a[`fits::${i}`] = bool(o.fits ?? 0.9); });
  if (o.drop) delete a[o.drop];
  return a;
};

const SCENARIOS: Record<string, { seam: "input" | "agent_end"; q?: typeof query; script: (c: number, q: Record<string, any>) => Answers | "error"; noRegistry?: boolean }> = {
  "fire-input": { seam: "input", script: (c, q) => (c === 1 ? stage1(q) : stage2(q)) },
  "fire-agent_end": { seam: "agent_end", script: (c, q) => (c === 1 ? stage1(q) : stage2(q)) },
  "below-score": { seam: "input", script: (c, q) => (c === 1 ? stage1(q, { skillNone: 0.95, task: 0.1, named: 0.1, prose: 0.9 }) : stage2(q, { fits: 0.05 })) },
  "missing-fits_win": { seam: "agent_end", script: (c, q) => (c === 1 ? stage1(q) : stage2(q, { winner: "zzz" })) },
  "missing-task": { seam: "agent_end", script: (c, q) => { if (c === 1) { const a = stage1(q); delete a["starts_governed_task"]; return a; } return stage2(q); } },
  "unknown-entry": { seam: "input", script: (c, q) => (c === 1 ? stage1(q) : { ...stage2(q), rr_wide: choice("not-in-list", { "not-in-list": 0.9 }) }) },
  "bad-answer-no-wide": { seam: "input", script: (c, q) => (c === 1 ? ({ starts_governed_task: bool(0.9), skill: choice("none", { none: 1 }) } as Answers) : stage2(q)) },
  "stage1-error": { seam: "input", script: () => "error" },
  "stage2-error": { seam: "input", script: (c, q) => (c === 1 ? stage1(q) : "error") },
  "no-candidates": { seam: "input", q: { text: "zzzz qqqq", files: [] }, script: () => "error" },
  "no-registry": { seam: "input", noRegistry: true, script: () => "error" },
};

async function run(name: string) {
  const s = SCENARIOS[name]!;
  const r = registry(s.script);
  const out = await judge(s.seam, s.noRegistry ? null : r.reg, index, {}, s.q ?? query, 5000);
  // ms are wall time: the payloads and decision are what must not move.
  // Entries carry absolute fixture paths: normalise them so the golden holds on any machine.
  const scrub = (v: any) => JSON.parse(JSON.stringify(v, (k, x) => (k === "jev_ms" ? "<ms>" : x)).split(FX).join("<FX>"));
  return scrub({ judgement: out, payloads: r.calls });
}

process.on("exit", () => { globalThis.fetch = realFetch; });
describe("CORE-2594: judge() payloads and Judgement are unchanged by the extraction", () => {
  const names = Object.keys(SCENARIOS);
  const golden: Record<string, unknown> = existsSync(GOLDEN) && !process.env["GOLDEN_WRITE"] ? JSON.parse(readFileSync(GOLDEN, "utf8")) : {};
  if (process.env["GOLDEN_WRITE"]) {
    it("writes the golden", async () => {
      const all: Record<string, unknown> = {};
      for (const n of names) all[n] = await run(n);
      writeFileSync(GOLDEN, JSON.stringify(all, null, 2) + "\n");
    });
    return;
  }
  for (const n of names) {
    it(n, async () => {
      expect(JSON.stringify(await run(n))).toBe(JSON.stringify(golden[n]));
    });
  }
  it("pins the decision thresholds", () => {
    expect([SCORE_MODEL["input"]!.threshold, SCORE_MODEL["agent_end"]!.threshold]).toEqual([0.35, 0.55]);
  });
  it("never reached the network", () => {
    // Registry-failure scenarios fall through to the REST client, whose fetch is the offline stub.
    expect(fetchCalls.every((u) => u.startsWith("https://api.typesafe.ai/"))).toBe(true);
  });
  it("covers every reachable skip reason", () => {
    const reasons = new Set(names.map((n) => (golden[n] as any).judgement.skip ?? (golden[n] as any).judgement.reason));
    for (const r of ["no_candidates", "classifier:transport", "classifier:bad_answer", "missing-fits_win", "missing-task", "below-score", "fire"]) {
      expect([...reasons].some((x) => String(x).startsWith(r)) || reasons.has(r)).toBe(true);
    }
  });
});
