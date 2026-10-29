/**
 * CORE-2549: both suggest extensions classify off pi's critical path through
 * one arbiter — handlers return at once, one delivery per run across both,
 * stale answers dropped.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILL_LOG = mkdtempSync(join(tmpdir(), "pipeline-skill-log-"));
const SUBSTRATE_LOG = mkdtempSync(join(tmpdir(), "pipeline-substrate-log-"));
process.env["SKILL_SUGGEST_LOG_DIR"] = SKILL_LOG;
process.env["SUBSTRATE_SUGGEST_LOG_DIR"] = SUBSTRATE_LOG;
afterAll(() => {
  rmSync(SKILL_LOG, { recursive: true, force: true });
  rmSync(SUBSTRATE_LOG, { recursive: true, force: true });
});

const pipeline = await import("../shared/suggest-pipeline.ts");
const skill = await import("../extensions/skill-suggest/index.ts");
const substrate = await import("../extensions/substrate-suggest/index.ts");

type Handler = (e: unknown, c?: unknown) => unknown;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A registry that answers "fire" for every question set, after `delayMs`. */
function firingRegistry(delayMs: number) {
  return {
    getAvailableOfType: async () => [{ id: "jev-test", provider: "typesafe" }],
    classify: async (_m: unknown, req: { questions: Record<string, { type: string; criteria?: Record<string, string> }> }) => {
      await sleep(delayMs);
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (q.type === "choice") {
          const keys = Object.keys(q.criteria ?? {});
          const pick = keys.includes("background_monitor") ? "background_monitor" : keys.find((k) => k !== "none") ?? "none";
          answers[id] = { type: "choice", choice: pick, probabilities: { [pick]: 0.9, none: 0.05 }, confidence: 0.9 };
        } else {
          const low = ["prose_suffices", "asks_about_the_tooling", "service_specific", "prose_would_suffice"].includes(id);
          answers[id] = { type: "bool", probability: low ? 0.05 : 0.95 };
        }
      }
      return { stopReason: "stop", answers, model: "typesafe/jev-test" };
    },
  };
}

function boot(ext: (pi: never) => void) {
  const handlers: Record<string, Handler[]> = {};
  const sent: Array<{ customType?: string }> = [];
  const pi = {
    getFlag: () => false,
    on: (name: string, fn: Handler) => {
      (handlers[name] ??= []).push(fn);
      return () => {};
    },
    sendMessage: (m: { customType?: string }) => sent.push(m),
    registerMessageRenderer: () => {},
  };
  ext(pi as never);
  return { handlers, sent };
}

const WORKING_TURN = {
  messages: [
    { role: "assistant", content: [{ type: "text", text: "Next I will follow the demo procedure, then I'll wait for the CI pipeline to finish." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "git push" } }] },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false },
  ],
};

const readLog = (dir: string) =>
  existsSync(join(dir, "log.jsonl")) ? readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

let repo: string;
let prevCwd: string;
beforeEach(async () => {
  pipeline.resetPipeline();
  prevCwd = process.cwd();
  repo = mkdtempSync(join(tmpdir(), "pipeline-repo-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".xtrm", "skills", "demo-skill"), { recursive: true });
  writeFileSync(join(repo, ".xtrm", "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: Demo procedure for deploy work.\n---\n# Demo\n## Step one\n");
  process.chdir(repo);
  skill.resetIndex();
  await skill.rebuildIndex(repo);
});
afterEach(async () => {
  await pipeline.settle();
  process.chdir(prevCwd);
  rmSync(repo, { recursive: true, force: true });
});

describe("handlers never wait for Jev", () => {
  it("skill-suggest input and agent_end return in under 5 ms with Jev taking 2 s", async () => {
    const { handlers } = boot(skill.default as never);
    const ctx = { modelRegistry: firingRegistry(2000) };
    let t = performance.now();
    await handlers["input"]![0]!({ text: "follow the demo procedure for this deploy" }, ctx);
    expect(performance.now() - t).toBeLessThan(5);
    t = performance.now();
    await handlers["agent_end"]![0]!(WORKING_TURN, ctx);
    expect(performance.now() - t).toBeLessThan(5);
  });

  it("substrate-suggest agent_end returns in under 5 ms with Jev taking 2 s", async () => {
    const { handlers } = boot(substrate.default as never);
    const t = performance.now();
    await handlers["agent_end"]![0]!(WORKING_TURN, { modelRegistry: firingRegistry(2000), cwd: repo });
    expect(performance.now() - t).toBeLessThan(5);
  });
});

describe("one delivery per run across both extensions", () => {
  it("two extensions proposing in one run deliver once", async () => {
    const a = boot(skill.default as never);
    const b = boot(substrate.default as never);
    const ctx = { modelRegistry: firingRegistry(10), cwd: repo };
    for (const h of [...(a.handlers["agent_start"] ?? []), ...(b.handlers["agent_start"] ?? [])]) h({});
    await a.handlers["agent_end"]![0]!(WORKING_TURN, ctx);
    await b.handlers["agent_end"]![0]!(WORKING_TURN, ctx);
    await pipeline.settle();
    await skill.flushDecisionLog();
    await substrate.flushDecisionLog();
    expect(a.sent.length + b.sent.length).toBe(1);
    const refused = [...readLog(SKILL_LOG), ...readLog(SUBSTRATE_LOG)].filter((r) => r.reason === "turn_taken" || r.gate === "arbiter:turn_taken");
    expect(refused.length).toBeGreaterThanOrEqual(1);
  });

  it("a new run opens the slot again", () => {
    const deliveries: string[] = [];
    expect(pipeline.propose({ epoch: pipeline.currentEpoch(), key: "a", deliver: () => deliveries.push("a") })).toBe("delivered");
    expect(pipeline.propose({ epoch: pipeline.currentEpoch(), key: "b", deliver: () => deliveries.push("b") })).toBe("turn_taken");
    pipeline.noteRunStart();
    expect(pipeline.propose({ epoch: pipeline.currentEpoch(), key: "b", deliver: () => deliveries.push("b") })).toBe("delivered");
    pipeline.noteRunStart();
    expect(pipeline.propose({ epoch: pipeline.currentEpoch(), key: "a", deliver: () => deliveries.push("a2") })).toBe("duplicate");
    expect(deliveries).toEqual(["a", "b"]);
  });
});

describe("stale answers are dropped", () => {
  it("an answer that lands after a newer prompt is dropped and logged as stale", async () => {
    const { handlers, sent } = boot(skill.default as never);
    const slow = { modelRegistry: firingRegistry(150) };
    await handlers["input"]![0]!({ text: "follow the demo procedure for this deploy" }, slow);
    await sleep(20);
    // The operator moves on before the first answer lands.
    await handlers["input"]![0]!({ text: "/clear" }, slow);
    await pipeline.settle();
    await skill.flushDecisionLog();
    expect(sent).toHaveLength(0);
    expect(readLog(SKILL_LOG).some((r) => r.seam === "input" && r.reason === "stale")).toBe(true);
  });
});
