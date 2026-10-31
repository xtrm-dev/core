/**
 * CORE-2535: replay labelled real suggestion situations through skill-suggest's
 * full decision path (input seam and agent_end seam) over the recorded roster.
 *
 * Offline, a stub classifier stands in for Jev: it records the criteria it is
 * shown and picks the shortlist's rank-1 candidate, so the measures are those
 * code owns — candidate cap, shortlist recall, ranking, deterministic skips and
 * whether the working turn reaches the classifier. Live, the real classifier
 * answers (no stub) and the decision log is the record.
 *
 * CORE-2564: a located row replays what pi delivered: the working turn as
 * recorded (turns.jsonl.gz: the run's messages, tool output dropped, trimmed
 * to what turnEvidence reads) and
 * the conversation before the prompt (prior.json), served through a session
 * manager stub so the input seam sees it the way production does.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { materialize, type RosterFixture } from "./materialize.ts";

export type Label = "FIT" | "PARTIAL" | "MISS" | "NO-SUGGESTION";
export interface CorpusRow {
  id: string;
  origin: string;
  repo: string;
  prompt: string;
  turn_calls: Array<{ name: string; arg: string }>;
  turn_text: string;
  fired: string[];
  label: Label;
  expected: string[];
  why: string;
  /** The prompt was the first user message of its session (a dispatched task when injected). */
  opens_session: boolean;
}

export interface SeamOutcome {
  /** The classifier was asked (a deterministic skip did not stop the row). */
  reached: boolean;
  criteria: number;
  candidates: string[];
  /** What the decision path would deliver: stub rank-1, or live gate pass. */
  pick: string | null;
}
export interface RowOutcome {
  row: CorpusRow;
  input: SeamOutcome;
  agentEnd: SeamOutcome | null;
}

const DIR = new URL(".", import.meta.url).pathname;
export function loadCorpus(): CorpusRow[] {
  return readFileSync(join(DIR, "corpus.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
export function loadFixture(): RosterFixture {
  return JSON.parse(readFileSync(join(DIR, "roster.json"), "utf8"));
}
let turns: Record<string, unknown[]> | null = null;
/** The recorded working turn of each located row (pi message shape, scrubbed). */
export function loadTurns(): Record<string, unknown[]> {
  turns ??= Object.fromEntries(
    gunzipSync(readFileSync(join(DIR, "turns.jsonl.gz"))).toString("utf8").split("\n").filter(Boolean).map((l) => {
      const r = JSON.parse(l) as { id: string; messages: unknown[] };
      return [r.id, r.messages];
    }),
  );
  return turns;
}
let prior: Record<string, Array<[string, string]>> | null = null;
/** The last six text turns before each located prompt, as [role, text]. */
export function loadPrior(): Record<string, Array<[string, string]>> {
  prior ??= JSON.parse(readFileSync(join(DIR, "prior.json"), "utf8"));
  return prior!;
}

/** Origins whose text was injected by a peer or coordinator (pi source "extension"). */
export const CONTROL_ORIGINS = new Set(["control_injected", "injected_fire"]);
export const isServiceId = (id: string) => /(^|\/)services\//.test(id);

function stubRegistry(calls: Array<{ id: string; criteria: string[] }>) {
  return {
    getAvailableOfType: async () => [{ id: "jev-replay-stub", provider: "typesafe" }],
    classify: async (_m: unknown, req: { questions: Record<string, { type: string; criteria?: Record<string, string> }> }) => {
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (q.type === "choice") {
          const keys = Object.keys(q.criteria ?? {});
          calls.push({ id, criteria: keys });
          const pick = keys.find((k) => k !== "none") ?? "none";
          answers[id] = { type: "choice", choice: pick, probabilities: { [pick]: 0.8, none: 0.1 }, confidence: 0.8 };
        } else {
          answers[id] = { type: "bool", probability: id === "prose_suffices" ? 0.05 : 0.9 };
        }
      }
      return { stopReason: "stop", answers, model: "typesafe/jev-replay-stub" };
    },
  };
}

/**
 * The input event pi delivered for a stored prompt. xtrm-ui (registered after
 * skill-suggest) prefixes interactive prompts with "› " and leaves
 * extension-sourced text alone, so the marker recovers the source and
 * skill-suggest saw the raw text. A stored `<skill name="x">` body was typed as
 * `/skill:x`.
 */
export function inputEvent(prompt: string): { text: string; source: "interactive" | "extension" } {
  if (prompt.startsWith("› ")) return { text: prompt.slice(2), source: "interactive" };
  const skill = /^<skill name="([^"]+)"/.exec(prompt);
  if (skill) return { text: `/skill:${skill[1]}`, source: "interactive" };
  if (/^[/!]/.test(prompt)) return { text: prompt, source: "interactive" };
  return { text: prompt, source: "extension" };
}

/**
 * The working turn as pi sends it: the run's messages, starting with the
 * prompt. A located row replays its recorded turn; a row whose turn was not
 * found replays its stored calls and last text.
 */
export function workingTurn(row: CorpusRow): unknown[] {
  const recorded = loadTurns()[row.id];
  if (recorded) return recorded.length ? [{ role: "user", content: [{ type: "text", text: inputEvent(row.prompt).text }] }, ...recorded] : [];
  if (!row.turn_text || row.turn_calls.length === 0) return [];
  const content = [
    ...row.turn_calls.map((c, i) => ({
      type: "toolCall",
      id: `r${i}`,
      name: c.name,
      arguments: c.name === "bash" ? { command: c.arg } : { path: c.arg },
    })),
  ];
  return [
    { role: "assistant", content },
    ...row.turn_calls.map((c, i) => ({ role: "toolResult", toolCallId: `r${i}`, toolName: c.name, content: [{ type: "text", text: "ok" }], isError: false })),
    { role: "assistant", content: [{ type: "text", text: row.turn_text }] },
  ];
}

type Handler = (e: unknown, c?: unknown) => unknown;
function boot(ext: (pi: never) => void) {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    getFlag: () => false,
    on: (name: string, fn: Handler) => {
      (handlers[name] ??= []).push(fn);
      return () => {};
    },
    sendMessage: () => {},
    registerMessageRenderer: () => {},
  };
  ext(pi as never);
  const fire = async (name: string, e: unknown, c?: unknown) => {
    for (const h of handlers[name] ?? []) await h(e, c);
  };
  return { fire };
}

function logRows(dir: string): Array<Record<string, unknown>> {
  const f = join(dir, "log.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/**
 * Replay every row. `live` drops the stub so the extension calls Jev itself
 * (TYPESAFE_API_KEY); picks then come from the decision log.
 */
export async function replay(
  rows: CorpusRow[],
  opts: { live?: boolean; registry?: (rowId: string, seam: "input" | "agent_end") => unknown } = {},
): Promise<RowOutcome[]> {
  const live = Boolean(opts.live || opts.registry);
  const fixture = loadFixture();
  const world = materialize(fixture);
  const prevHome = process.env["HOME"];
  const prevCwd = process.cwd();
  process.env["HOME"] = world.home;
  // A private log dir per replay: another test file may point the shared one
  // at a directory it deletes afterwards, and live picks are read from the log.
  const prevLogDir = process.env["SKILL_SUGGEST_LOG_DIR"];
  const logDir = mkdtempSync(join(tmpdir(), "skill-replay-log-"));
  process.env["SKILL_SUGGEST_LOG_DIR"] = logDir;
  // Imported late so HOME already points at the recorded roster.
  const skill = await import("../../../extensions/skill-suggest/index.ts");
  const pipeline = await import("../../../shared/suggest-pipeline.ts").catch(() => null);
  const roster = await import("../../../extensions/skill-suggest/roster.ts");
  const ext = skill.default as unknown as (pi: never) => void;
  const settle = async () => {
    await pipeline?.settle?.();
    await (skill as { flushDecisionLog?: () => Promise<void> }).flushDecisionLog?.();
  };
  const out: RowOutcome[] = [];
  try {
    let current = "";
    for (const row of [...rows].sort((a, b) => a.repo.localeCompare(b.repo) || a.id.localeCompare(b.id))) {
      const root = world.repos[row.repo];
      if (!root) throw new Error(`row ${row.id}: no recorded roster for repo ${row.repo}`);
      if (root !== current) {
        process.chdir(root);
        (roster as { resetRosterCache?: () => void }).resetRosterCache?.();
        (skill as { resetIndex?: () => void }).resetIndex?.();
        await (skill as { rebuildIndex?: (cwd: string) => Promise<void> }).rebuildIndex?.(root);
        current = root;
      }
      pipeline?.resetPipeline?.();
      const seams: Record<string, SeamOutcome> = {};
      for (const seam of ["input", "agent_end"] as const) {
        const turn = workingTurn(row);
        if (seam === "agent_end" && turn.length === 0) continue;
        const calls: Array<{ id: string; criteria: string[] }> = [];
        // A caller-supplied registry (recording, or answering from a recording) is a live run.
        const registry = opts.registry ? { modelRegistry: opts.registry(row.id, seam) } : opts.live ? {} : { modelRegistry: stubRegistry(calls) };
        const messages = (loadPrior()[row.id] ?? []).map(([role, text]) => ({ role, content: [{ type: "text", text }] }));
        const ctx = { ...registry, sessionManager: { getEntries: () => [], buildSessionProjection: () => ({ messages }) } };
        const { fire } = boot(ext);
        const before = logRows(logDir).length;
        if (seam === "input") {
          // A prompt later in its session follows earlier input.
          if (!row.opens_session) await fire("input", { text: "/replay-earlier-prompt", source: "interactive" }, ctx);
          await fire("input", inputEvent(row.prompt), ctx);
        }
        else {
          await fire("agent_start", {});
          await fire("agent_end", { messages: turn }, ctx);
        }
        await settle();
        const fresh = logRows(logDir).slice(before).filter((r) => r["seam"] === seam);
        const decided = fresh.find((r) => typeof r["pick"] === "string");
        // The candidates Jev ranks are the wide list; the cap applies to every choice.
        const criteria = calls.find((c) => c.id === "wide")?.criteria ?? [];
        const criteriaMax = Math.max(0, ...calls.map((c) => c.criteria.length));
        const reached = live ? fresh.some((r) => r["jev_ms"] !== undefined) : calls.length > 0;
        const livePick = decided && (decided["outcome"] === "fire" || decided["reason"] === "cooldown" || decided["reason"] === "duplicate" || decided["reason"] === "turn_taken") ? String(decided["pick"]) : null;
        seams[seam] = {
          reached,
          criteria: criteriaMax,
          candidates: criteria.filter((k) => k !== "none"),
          pick: live ? livePick : (criteria.find((k) => k !== "none") ?? null),
        };
      }
      out.push({ row, input: seams["input"]!, agentEnd: seams["agent_end"] ?? null });
    }
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    if (prevLogDir === undefined) delete process.env["SKILL_SUGGEST_LOG_DIR"];
    else process.env["SKILL_SUGGEST_LOG_DIR"] = prevLogDir;
    rmSync(logDir, { recursive: true, force: true });
    (skill as { resetIndex?: () => void }).resetIndex?.();
    (roster as { resetRosterCache?: () => void }).resetRosterCache?.();
    world.cleanup();
  }
  return out;
}

export interface Metrics {
  rows: number;
  criteria_max: number;
  /** Rows that should get a suggestion whose expected entry reached the classifier. */
  recall_shortlist: number;
  /** Same, restricted to rows whose expected entry is a service-knowledge skill. */
  service_recall_shortlist: number;
  service_rows: number;
  /** Rows that should get a suggestion whose rank-1 candidate is an expected entry (ranking quality). */
  top1: number;
  /** Fires naming an expected entry, over every fire. Meaningful live; offline the stub always fires. */
  precision: number;
  fires: number;
  /** Injected rows labelled NO-SUGGESTION whose input reached the classifier. */
  control_reach: number;
  control_rows: number;
  /** Rows with a recorded working turn whose agent_end reached the classifier. */
  agent_end_reach: number;
  agent_end_rows: number;
}

const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);

export function score(outcomes: RowOutcome[]): Metrics {
  let criteriaMax = 0;
  let want = 0, hit = 0, top = 0, svc = 0, svcHit = 0, fires = 0, right = 0, ctl = 0, ctlReach = 0, ae = 0, aeReach = 0;
  for (const { row, input, agentEnd } of outcomes) {
    const seams = [input, ...(agentEnd ? [agentEnd] : [])];
    for (const s of seams) criteriaMax = Math.max(criteriaMax, s.criteria);
    const expected = new Set(row.expected);
    if (row.label !== "NO-SUGGESTION" && expected.size > 0) {
      want++;
      const found = seams.some((s) => s.candidates.some((c) => expected.has(c)));
      if (found) hit++;
      if (seams.some((s) => s.candidates[0] !== undefined && expected.has(s.candidates[0]))) top++;
      if (row.expected.some(isServiceId)) {
        svc++;
        if (found) svcHit++;
      }
    }
    for (const s of seams) {
      if (!s.pick) continue;
      fires++;
      if (expected.has(s.pick)) right++;
    }
    if (CONTROL_ORIGINS.has(row.origin) && row.label === "NO-SUGGESTION") {
      ctl++;
      if (input.reached) ctlReach++;
    }
    if (agentEnd) {
      ae++;
      if (agentEnd.reached) aeReach++;
    }
  }
  return {
    rows: outcomes.length,
    criteria_max: criteriaMax,
    recall_shortlist: ratio(hit, want),
    service_recall_shortlist: ratio(svcHit, svc),
    service_rows: svc,
    top1: ratio(top, want),
    precision: ratio(right, fires),
    fires,
    control_reach: ratio(ctlReach, ctl),
    control_rows: ctl,
    agent_end_reach: ratio(aeReach, ae),
    agent_end_rows: ae,
  };
}
