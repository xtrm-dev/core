import "./isolate-logs.ts"; // CORE-2535: keep production decision logs untouched
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
  stripEndPeriod,
  SKILL_ACCENT,
  SUBSTRATE_ACCENT,
} from "../extensions/substrate-suggest/catalog.ts";
import { parseAnswerPayload, questionShape, pickClassifiers, classifyViaRegistry } from "../extensions/substrate-suggest/jev.ts";
import { waitCommitment, isMonitorSetter, isEditor, isProvenanceReader, provenanceDutyVerb, waitGuardVerb, partitionTracked, trackedEditedFiles, buildProvenanceEvidence, buildProvenanceSteer, repoRoot, createRepoRootResolver, createProvenanceSteerGate, runProvenanceSteer } from "../extensions/substrate-suggest/duties.ts";
import substrateSuggestExtension from "../extensions/substrate-suggest/index.ts";

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

  it("no claim on a claimable issue draws a claim suggestion (CORE-2361)", () => {
    expect(evaluateDeterministic(snap({ claim: null }), {})).toBe("claim_start");
  });

  it("no claim on a draft revision draws an attest suggestion", () => {
    expect(evaluateDeterministic(snap({ claim: null, readinessState: "draft" }), {})).toBe("attest_ready");
  });

  it("no claim on a blocked issue stays silent — the claim cannot be taken", () => {
    expect(evaluateDeterministic(snap({ claim: null, readinessState: "blocked" }), {})).toBeNull();
  });

  it("unclaimed but inactive stays silent", () => {
    expect(evaluateDeterministic(snap({ claim: null, turnWasActive: false }), {})).toBeNull();
  });

  it("the wider sb surface is on the Jev roster (CORE-2361)", () => {
    const ids = jevRoster().map((r) => r.id);
    for (const id of ["issue_note", "defer_work", "dep_relate", "provenance_receipt", "resume_capsule"]) {
      expect(ids).toContain(id);
    }
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

describe("service-knowledge pack discovery", () => {
  it("reads a repo-local pack and does not answer for another repo from cache", async () => {
    const mod = await import("../extensions/substrate-suggest/duties.ts");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const repoWithPack = (entries: string[]): string => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sk-pack-"));
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      const pack = path.join(root, ".xtrm", "skills", "svc", "service-knowledge");
      fs.mkdirSync(pack, { recursive: true });
      for (const id of entries) {
        fs.mkdirSync(path.join(pack, "services", id), { recursive: true });
        fs.writeFileSync(path.join(pack, "services", id, "SKILL.md"), `# ${id}\n`);
      }
      fs.writeFileSync(
        path.join(pack, "service-registry.json"),
        JSON.stringify({
          services: Object.fromEntries(
            entries.map((id) => [id, { description: `${id} service knowledge` }]),
          ),
        }),
      );
      return root;
    };

    const a = repoWithPack(["alpha"]);
    const b = repoWithPack(["beta", "gamma"]);
    try {
      const discoverIds = async (repo: string) => (await mod.discoverSkillPacks(repo)).flatMap((p) => p.entries).map((e) => e.id);
      mod.resetRosterCache();
      expect(await discoverIds(a)).toEqual(["alpha"]);
      // No reset: the cache must be keyed by repo, not a single slot that answers for
      // whichever repo was scanned first.
      expect(await discoverIds(b)).toEqual(["beta", "gamma"]);
      expect(await discoverIds(a)).toEqual(["alpha"]);
      // A service whose skill file is missing must not become a card: the instruction
      // would name a path the agent cannot read.
      const withGap = repoWithPack(["present"]);
      fs.writeFileSync(
        path.join(withGap, ".xtrm", "skills", "svc", "service-knowledge", "service-registry.json"),
        JSON.stringify({ services: { present: { description: "has a skill" }, ghost: { description: "no skill file" } } }),
      );
      mod.resetRosterCache();
      const ids = await discoverIds(withGap);
      expect(ids).toEqual(["present"]);
      fs.rmSync(withGap, { recursive: true, force: true });
    } finally {
      for (const dir of [a, b]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wake card", () => {
  const verb = CATALOG.find((v) => v.id === "journal_decision")!;

  it("bands the header text in the substrate accent and leaves the dot and body unbanded", () => {
    const card = formatSuggestionCard({ verb, ref: "CORE-9", confidence: 0.72, revision: 3 });
    const plain = formatSuggestionPlain({ verb, ref: "CORE-9", confidence: 0.72, revision: 3 });
    const [head, ...body] = plain.split("\n");

    // dot first, white, then the accent band begins at the header text
    expect(head.startsWith("●")).toBe(true);
    expect(card).toContain("\x1b[1m●\x1b[22m");
    expect(head).toContain("sb journal append");
    expect(head).toContain("CORE-9");

    // accent + dark foreground + bold, on the header only
    const banded = card.split("\n")[0];
    expect(banded).toContain("\x1b[48;2;255;112;52m");
    expect(banded).toContain("\x1b[38;2;24;20;16m");
    expect(banded).toContain("\x1b[1m");
    for (const line of card.split("\n").slice(1)) {
      expect(line).not.toContain("\x1b[48;2;255;112;52m");
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


describe("CORE-2348 card polish", () => {
  const base = CATALOG.find((v) => v.id === "journal_decision")!;
  const dotted = { ...base, oneLine: "Turn intent into dispatchable contracts." };
  it("strips the trailing period before the facts trailer", () => {
    expect(stripEndPeriod("Ends with a period.")).toBe("Ends with a period");
    expect(stripEndPeriod("No period")).toBe("No period");
    const plain = formatSuggestionPlain({ verb: dotted, ref: "CORE-1", confidence: 0.66, compact: true });
    expect(plain).not.toContain("contracts.  jev_confidence");
    expect(plain).toContain("contracts  jev_confidence: 0.66");
    expect(plain.split("\n")[0]).not.toContain("· —");
  });
  it("bands substrate orange by default and skill blue on request", () => {
    const sub = formatSuggestionCard({ verb: base, ref: "CORE-9", confidence: 0.72 });
    expect(sub.split("\n")[0]).toContain("\x1b[48;2;255;112;52m");
    const skill = formatSuggestionCard({ verb: dotted, ref: "—", confidence: 0.66, compact: true }, SKILL_ACCENT);
    expect(skill.split("\n")[0]).toContain("\x1b[48;2;0;103;188m");
    expect(SUBSTRATE_ACCENT).toEqual([255, 112, 52]);
  });
});

describe("CORE-2348 non-compact trailer", () => {
  it("never ends the body with a period before facts", () => {
    const v = waitGuardVerb();
    const plain = formatSuggestionPlain({ verb: v, ref: "—", confidence: 0.87 });
    const last = plain.split("\n").pop()!;
    expect(last).not.toMatch(/\.\s{2}/);
    expect(last).toMatch(/[^.]  jev_confidence/);
  });
});

describe("wait-guard monitor setters (CORE-2443 M1 first-party surface)", () => {
  it("treats first-party background and waiting sends as wake seams", () => {
    expect(isMonitorSetter("BashBackground", { command: "npm test" }, undefined)).toBe(true);
    expect(isMonitorSetter("Monitor", { command: "npm test" }, undefined)).toBe(true);
    expect(isMonitorSetter("SendMessage", { to: "w", message: "hi", expect_reply: true }, undefined)).toBe(true);
    expect(isMonitorSetter("SendMessage", { to: "w", message: "hi", notify_when_idle: true }, undefined)).toBe(true);
    expect(isMonitorSetter("Bash", { run_in_background: true }, undefined)).toBe(true);
  });
  it("rejects one-way sends and the retired tool names", () => {
    expect(isMonitorSetter("SendMessage", { to: "w", message: "hi" }, undefined)).toBe(false);
    expect(isMonitorSetter("bg_run", { command: "x" }, undefined)).toBe(false);
    expect(isMonitorSetter("bg_delegate", { command: "x" }, undefined)).toBe(false);
    expect(isMonitorSetter("process", { command: "x" }, undefined)).toBe(false);
    expect(isMonitorSetter("intercom", { action: "send" }, undefined)).toBe(false);
  });
  it("keeps shell parking idioms and rejects foreground poll loops", () => {
    expect(isMonitorSetter("bash", { command: "make watch &" }, undefined)).toBe(true);
    expect(isMonitorSetter("bash", { command: "nohup ./srv &" }, undefined)).toBe(true);
    expect(isMonitorSetter("bash", { command: "sleep 60; check" }, undefined)).toBe(false);
    expect(isMonitorSetter("bash", {}, undefined)).toBe(false);
  });
});

describe("provenance steer gates", () => {
  it("partitionTracked splits on the injected check; unknown means untracked", () => {
    const r = partitionTracked(["a.ts", "b.ts", "c.ts"], (f) => f !== "b.ts");
    expect(r.tracked).toEqual(["a.ts", "c.ts"]);
    expect(r.untracked).toEqual(["b.ts"]);
    expect(partitionTracked([], () => true)).toEqual({ tracked: [], untracked: [] });
  });

  it("trackedEditedFiles keeps only git-tracked paths (temp repo)", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/prov-gate-${Date.now()}`;
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    fs.writeFileSync(`${dir}/tracked.ts`, "export const a = 1;\n");
    fs.writeFileSync(`${dir}/new.ts`, "export const b = 2;\n");
    execFileSync("git", ["add", "tracked.ts"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "seed tracked history"], { cwd: dir });
    expect(await trackedEditedFiles([`${dir}/tracked.ts`, `${dir}/new.ts`], dir)).toEqual([`${dir}/tracked.ts`]);
    expect(await trackedEditedFiles([`${dir}/new.ts`], dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("trackedEditedFiles stays silent outside a repo", async () => {
    expect(await trackedEditedFiles(["/tmp/ocr-shim/shim.js"], "/tmp")).toEqual([]);
  });

  it("buildProvenanceEvidence carries diffstat, last touch, and next commands", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/prov-ev-${Date.now()}`;
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    fs.writeFileSync(`${dir}/f.ts`, "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "seed the why"], { cwd: dir });
    fs.writeFileSync(`${dir}/f.ts`, "export const a = 2;\n");
    const body = await buildProvenanceEvidence([`${dir}/f.ts`], dir);
    expect(body).toMatch(/1 insertion/);
    expect(body).toMatch(/seed the why/);
    expect(body).toMatch(/git log -p --follow/);
    expect(body.length).toBeLessThanOrEqual(2000);
    // CORE-2546: the same git calls give the operator's card; the agent's text is unchanged.
    const steer = await buildProvenanceSteer([`${dir}/f.ts`], dir);
    expect(steer.text).toBe(body);
    expect(steer.text).not.toContain("\x1b");
    expect(steer.card).toMatchObject({ identity: "provenance unread", summary: "1 file changed without reading its history", tint: "substrate" });
    expect(steer.card.reason).toMatch(/Behavior changed/);
    expect(steer.card.body?.[0]).toMatch(/^f\.ts {2}last [0-9a-f]+ \d{4}-\d{2}-\d{2} seed the why$/);
    expect(steer.card.body?.at(-1)).toBe("+1 -1  ·  next: git log -p --follow -- …/f.ts");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("provenance steer ordering (CORE-2406)", () => {
  it("a gate-blocked steer marks nothing, so it retries in-turn", async () => {
    const cooldowns: Cooldowns = {};
    const steered: string[] = [];
    let calls = 0;
    const attempt = () =>
      runProvenanceSteer({
        files: ["a.ts"],
        steered,
        cooldowns,
        threshold: 0.3,
        classify: async () => {
          calls++;
          return null;
        },
        deliver: () => {
          throw new Error("must not deliver a gated steer");
        },
      });
    expect(await attempt()).toBe("gated");
    expect(steered).toEqual([]);
    expect(await attempt()).toBe("gated");
    expect(calls).toBe(2);
  });

  it("marks files only on delivery, then cools down", async () => {
    const cooldowns: Cooldowns = {};
    const steered: string[] = [];
    const delivered: Array<{ files: string[]; model: string | null }> = [];
    const opts = {
      files: ["a.ts"],
      steered,
      cooldowns,
      threshold: 0.3,
      classify: async () => ({ mean: 1, model: "m" }),
      deliver: (fs: string[], model: string | null) => {
        delivered.push({ files: fs, model });
      },
    };
    expect(await runProvenanceSteer(opts)).toBe("delivered");
    expect(steered).toEqual(["a.ts"]);
    expect(delivered).toEqual([{ files: ["a.ts"], model: "m" }]);
    expect(await runProvenanceSteer(opts)).toBe("cooled");
    expect(delivered).toHaveLength(1);
  });

  it("repoRoot resolves the git toplevel from a nested dir, and falls back outside a repo (hermetic temp repo)", async () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const fs = require("node:fs") as typeof import("node:fs");
    const outer = fs.mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/prov-root-`);
    const dir = `${outer}/repo`;
    const nested = `${dir}/packages`;
    fs.mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    const top = fs.realpathSync(dir);
    expect(await repoRoot(dir)).toBe(top);
    expect(await repoRoot(nested)).toBe(top);
    // Not a repo: the launch directory is the only thing left to return.
    const outside = `${outer}/outside`;
    fs.mkdirSync(outside, { recursive: true });
    expect(await repoRoot(outside)).toBe(outside);
    fs.rmSync(outer, { recursive: true, force: true });
  });

  it("repoRoot is resolved once per session, not once per steer (CORE-2406)", async () => {
    let calls = 0;
    const resolve = createRepoRootResolver(() => {
      calls += 1;
      return "/repo";
    });
    expect(await resolve.ready()).toBe("/repo");
    expect(resolve()).toBe("/repo");
    expect(resolve()).toBe("/repo");
    expect(calls).toBe(1);
  });

  it("an in-flight guard makes two concurrent steers share one Jev call (CORE-2406)", async () => {
    const cooldowns: Cooldowns = {};
    const steered: string[] = [];
    const gate = createProvenanceSteerGate();
    let calls = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const opts = {
      files: ["a.ts"],
      steered,
      cooldowns,
      threshold: 0.3,
      gate,
      classify: async () => {
        calls += 1;
        await held;
        return { mean: 1, model: "m" };
      },
      deliver: () => {},
    };
    const first = runProvenanceSteer(opts);
    const second = runProvenanceSteer(opts);
    release();
    expect(await second).toBe("inFlight");
    expect(await first).toBe("delivered");
    expect(calls).toBe(1);
    expect(steered).toEqual(["a.ts"]);
  });
});

describe("extension wiring (CORE-2406)", () => {
  it("attaches the provenance steer to the real tool_result event", async () => {
    type Handler = (event: never, ctx?: never) => unknown;
    const registered = new Map<string, Handler[]>();
    const pi = {
      getFlag: () => false,
      on: (name: string, handler: Handler) => {
        registered.set(name, [...(registered.get(name) ?? []), handler]);
        return () => {};
      },
      registerMessageRenderer: () => {},
      sendMessage: () => {},
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    };
    substrateSuggestExtension(pi as never);
    // A typo or rename here leaves the handler attached to nothing and the
    // steer silently dead, so the real event names are pinned.
    expect([...registered.keys()].sort()).toEqual(["agent_end", "agent_start", "session_before_compact", "session_start", "tool_call", "tool_result"]);
    const handler = registered.get("tool_result")?.[0];
    expect(typeof handler).toBe("function");
    // A real-shaped edit result rides this event; the handler accepts it.
    await handler!({ type: "tool_result", toolName: "edit", input: { path: "x.ts" }, args: {}, content: [] } as never);
  });
});

describe("turnEvidence reads pi's real message shapes (CORE-2547)", () => {
  it("a toolCall block marks an active turn; tool output stays out of the excerpt", async () => {
    const { turnEvidence } = await import("../extensions/substrate-suggest/index.ts");
    const ev = turnEvidence([
      { role: "assistant", content: [{ type: "text", text: "Running the suite." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] },
      { role: "toolResult", content: [{ type: "text", text: "noisy output" }], isError: false },
    ], 0);
    expect(ev.wasActive).toBe(true);
    expect(ev.lastAssistant).toBe("Running the suite.");
    expect(ev.excerpt).not.toContain("noisy output");
  });

  it("an erroring toolResult marks an active turn even without a write-class call", async () => {
    const { turnEvidence } = await import("../extensions/substrate-suggest/index.ts");
    const ev = turnEvidence([
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", content: [{ type: "text", text: "ENOENT" }], isError: true },
    ], 0);
    expect(ev.wasActive).toBe(true);
  });

  it("a read-only, text-free turn is not active", async () => {
    const { turnEvidence } = await import("../extensions/substrate-suggest/index.ts");
    const ev = turnEvidence([
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", content: [{ type: "text", text: "ok" }], isError: false },
    ], 0);
    expect(ev.wasActive).toBe(false);
  });
});
