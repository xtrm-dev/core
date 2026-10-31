/**
 * CORE-2550: the wait-guard fired on waits that need no monitor. Fixtures are
 * the final messages of fires sampled from real transcripts (2026-10-29 audit);
 * the classifier is faked to say "yes, fire" so only the deterministic
 * precondition and the AND gate decide.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFacts, waitGate, waitPrecondition } from "../extensions/substrate-suggest/duties.ts";

process.env["SUBSTRATE_SUGGEST_LOG_DIR"] = mkdtempSync(join(tmpdir(), "substrate-suggest-log-"));
const substrateSuggest = await import("../extensions/substrate-suggest/index.ts");
const { resetPipeline, settle } = await import("../shared/suggest-pipeline.ts");

const SUBAGENTS = "The subagents are running in the background. I will be notified when they complete. Let me wait for the notifications.";
const OPERATOR = "`REPORT.md` now carries the corrected line references; every number the coordinator spot-checked is unchanged. Idle, waiting for a write-scope issue in `prj_core` if the operator approves P0-1..P0-3.";
const REPORT = "Rejected #950-triple and MMD-2462-reparent as blockers (pre-execution checks), downgraded MMD-2215.1 to conditional. Context kept low: all checks ran in subagents; this session only assembled their verified outputs.";
const CI_WAIT = "Pushed the fix to the branch. I'll wait for the CI pipeline to finish before merging.";

async function fire(finalMessage: string, toolName = "bash", nouls = { wait_warranted: 0.9, monitor_would_help: 0.9 }, kind = "background_monitor") {
  resetPipeline();
  const handlers = new Map<string, Array<(e: unknown, c?: unknown) => unknown>>();
  const sent: Array<{ content?: unknown; details?: { verb?: string } }> = [];
  const pi = {
    getFlag: () => false,
    on: (name: string, h: (e: unknown, c?: unknown) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
      return () => {};
    },
    registerMessageRenderer: () => {},
    sendMessage: (m: { content?: unknown; details?: { verb?: string } }) => sent.push(m),
  };
  substrateSuggest.default(pi as never);
  const registry = {
    getAvailableOfType: async () => [{ provider: "typesafe", id: "jev-fake" }],
    classify: async (_m: unknown, req: { questions: Record<string, { type: string }> }) => {
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        answers[id] = q.type === "choice"
          ? { type: "choice", choice: kind, probabilities: { [kind]: 1 }, confidence: 0.9 }
          : { type: "bool", probability: (nouls as Record<string, number>)[id] ?? 0.5 };
      }
      return { answers, stopReason: "stop", model: "fake-jev" };
    },
  };
  for (const h of handlers.get("tool_call") ?? []) h({ toolName, input: {} });
  const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: toolName, arguments: {} }, { type: "text", text: finalMessage }] }];
  for (const h of handlers.get("agent_end") ?? []) await h({ messages }, { modelRegistry: registry, cwd: "/tmp" });
  await settle(); // classification runs detached (CORE-2549)
  return sent.filter((m) => m.details?.verb === "wait_guard" || String(m.content ?? "").includes("monitor"));
}

describe("wait-guard precondition (pure)", () => {
  it("a harness-notified wait is covered", () => {
    expect(waitPrecondition(waitFacts(SUBAGENTS, { notifyingRecently: false, monitorSet: false }))).toBe("notification_pending");
  });
  it("waiting on the operator is not an external wait", () => {
    const facts = waitFacts(OPERATOR, { notifyingRecently: false, monitorSet: false });
    expect(facts.waitsOnOperator).toBe(true);
    expect(waitPrecondition(facts)).not.toBeNull();
    // Named external target + operator continuation: still not a monitor case.
    expect(waitPrecondition(waitFacts("I'll wait for the deploy, once you approve the window.", { notifyingRecently: false, monitorSet: false }))).toBe("waits_on_operator");
  });
  it("a finished report waits for nothing", () => {
    expect(waitPrecondition(waitFacts(REPORT, { notifyingRecently: false, monitorSet: false }))).toBe("no_external_target");
  });
  it("a CI wait with nothing watching holds", () => {
    expect(waitPrecondition(waitFacts(CI_WAIT, { notifyingRecently: false, monitorSet: false }))).toBeNull();
  });
  it("recent notifying work covers the wait even when the text does not say so", () => {
    expect(waitPrecondition(waitFacts(CI_WAIT, { notifyingRecently: true, monitorSet: false }))).toBe("notification_pending");
  });
});

describe("wait-guard gate (pure)", () => {
  it("a none pick refuses even with both nouls high", () => {
    expect(waitGate({ waitWarranted: 0.95, monitorWouldHelp: 0.95, monitorKind: "none" })).toBe("monitor_kind_none");
  });
  it("one high noul alone no longer fires (the old mean did)", () => {
    // Old gate: (0 + 0.7) / 2 = 0.35 >= 0.3 fired.
    expect(waitGate({ waitWarranted: 0, monitorWouldHelp: 0.7, monitorKind: "timer" })).toBe("wait_not_warranted");
  });
  it("both yes and a real monitor kind fires", () => {
    expect(waitGate({ waitWarranted: 0.8, monitorWouldHelp: 0.7, monitorKind: "background_monitor" })).toBeNull();
  });
});

describe("wait-guard end to end with a classifier that always says fire", () => {
  it("the three sampled no-monitor messages stay silent", async () => {
    expect(await fire(SUBAGENTS)).toHaveLength(0);
    expect(await fire(OPERATOR)).toHaveLength(0);
    expect(await fire(REPORT)).toHaveLength(0);
  });
  it("a subagent dispatch this turn covers a plain CI wait", async () => {
    expect(await fire(CI_WAIT, "subagent")).toHaveLength(0);
  });
  it("a CI wait with no monitor still fires", async () => {
    expect((await fire(CI_WAIT)).length).toBeGreaterThan(0);
  });
  it("a none pick stays silent", async () => {
    expect(await fire(CI_WAIT, "bash", { wait_warranted: 0.9, monitor_would_help: 0.9 }, "none")).toHaveLength(0);
  });
});
