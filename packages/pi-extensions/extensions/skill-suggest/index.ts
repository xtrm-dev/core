/**
 * skill-suggest — the Jev skill-suggestion pattern (aitmpl productivity/
 * jev-skill-suggestion) ported natively to pi, over the curated XTRM skill
 * packs.
 *
 * What it does at each user prompt (the `input` seam, before the turn):
 *   1. Roster: curated skills AND their nested references (the doctrine
 *      depth agents never open — engineering-quality/references/
 *      causal-debugging.md et al.), descriptions extracted from frontmatter
 *      and first headings.
 *   2. Jev, two calls (CORE-2564, see judge()): rank a wide BM25 list and ask
 *      the gate nouls, then reread the top three documents with their text and
 *      ask whether each fits. A fitted score over the answers decides; under
 *      its threshold -> nothing.
 *   3. On a hit: the prompt is transformed with a bounded `<skill_relevance>`
 *      block pointing at the doc path (the model reads it), ignore-if-not-fits
 *      (the mod's cookbook wording). A display-only house card shows the
 *      operator what was injected.
 *
 * And at each agent_end (the intention seam): the AGENT decides things no
 * user prompt ever names — "let me debug this", "I'll review the diff".
 * The same decision runs over the agent's final message and turn
 * evidence; a hit injects the doctrine as a followUp message the model
 * reads at its next turn, with the same house card for the operator.
 *
 * Phase 1 (this build) keeps the skill listing visible — conservative mode.
 * Withholding the listing via disable-model-invocation frontmatter waits for
 * eval evidence from the decision log.
 *
 * Fail-open everywhere: any error means the prompt passes through untouched.
 * The typed /skill:<name> command always works, suggested or not.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildRetrievalIndex, loadServices, shortlist, type RetrievalIndex, type ServiceRecord, type ShortlistQuery } from "../../shared/shortlist.ts";
import { contextBlock, parseContextBlock, resolveSuggestionMessage, stripEndPeriod, suggestionFacts, tintSuggestionGlyph } from "../../shared/suggest.ts";
import { registerEventRenderer } from "../../shared/event.ts";
import { classify, primeApiKey, readApiKey, type ClassifierFailure, type Question, type RegistryLike } from "../../shared/suggest.ts";
import { createJsonlLog } from "../../shared/jsonl-log.ts";
import { currentEpoch, detach, DELIVERY, notePrompt, noteRunStart, propose, resetSession } from "../../shared/suggest-pipeline.ts";
import { discoverRoster, headingsOf, repoRootOf, resetRosterCache, type RosterEntry } from "./roster.ts";

/**
 * The retrieval index, built off the hot path (CORE-2533): a handler reads the
 * current index or none and never waits for a build. A stale index keeps
 * serving while its replacement builds in the background.
 */
const INDEX_TTL_MS = 5 * 60_000;
let indexState: { cwd: string; at: number; index: RetrievalIndex<RosterEntry> } | null = null;
let indexBuild: Promise<void> | null = null;

export function currentIndex(cwd: string, now = Date.now()): RetrievalIndex<RosterEntry> | null {
  const fresh = indexState && indexState.cwd === cwd && now - indexState.at < INDEX_TTL_MS;
  if (!fresh && !indexBuild) void rebuildIndex(cwd);
  return indexState && indexState.cwd === cwd ? indexState.index : null;
}

export function rebuildIndex(cwd: string): Promise<void> {
  if (indexBuild) return indexBuild;
  indexBuild = (async () => {
    try {
      const repoRoot = await repoRootOf(cwd);
      const [entries, services] = await Promise.all([discoverRoster(cwd), loadServices(repoRoot)]);
      indexState = { cwd, at: Date.now(), index: buildRetrievalIndex(entries, services, repoRoot, cwd) };
    } catch {
      /* fail-open: the seams skip while no index exists */
    } finally {
      indexBuild = null;
    }
  })();
  return indexBuild;
}

/**
 * The index for `cwd`, waiting for an in-flight or first build. Only detached
 * classification calls this (CORE-2549): a session's first prompt must not be
 * dropped because the build started at session_start has not finished.
 */
export async function readyIndex(cwd: string): Promise<RetrievalIndex<RosterEntry> | null> {
  const now = currentIndex(cwd);
  if (now) return now;
  await rebuildIndex(cwd);
  return indexState && indexState.cwd === cwd ? indexState.index : null;
}

export function resetIndex(): void {
  indexState = null;
  indexBuild = null;
  resetRosterCache();
}

/**
 * The classifier's choice criteria: the shortlist plus an explicit `none`.
 *
 * CORE-2553: Jev never sees ids, so each criterion names its document, and a
 * reference names the skill it belongs to with that skill's first sentence.
 * A reference's own summary is often a launch instruction ("Read this file at
 * launch…") that says nothing about when it applies. `none` lists what does
 * not call for a procedure instead of one generic sentence.
 */
export function criteriaOf(
  candidates: RosterEntry[],
  index: { entries: readonly RosterEntry[]; serviceOf?: ReadonlyMap<string, ServiceRecord>; serviceSkill?: ReadonlyMap<string, string> },
): Record<string, string> {
  const skills = new Map(index.entries.filter((e) => e.level === "skill").map((e) => [e.skill, e]));
  const firstSentence = (s: string) => (s.split(/(?<=[.;])\s/)[0] ?? "").slice(0, 140);
  const criterion = (e: RosterEntry) => {
    // CORE-2555: a service's SKILL.md often has no frontmatter; the registry
    // description is written to say when the service applies.
    const svc = index.serviceOf?.get(e.id);
    if (svc && index.serviceSkill?.get(svc.id) === e.id && svc.description) return `${svc.name} service: ${svc.description}`;
    if (svc && index.serviceSkill?.get(svc.id) !== e.id) return `${e.name} (part of the ${svc.name} service) — ${e.description}`;
    if (e.level === "skill") return `${e.name}: ${e.description}`;
    const parent = skills.get(e.skill);
    return `${e.name} (part of ${e.skill}${parent ? `: ${firstSentence(parent.description)}` : ""}) — ${e.description}`;
  };
  return Object.fromEntries([...candidates.map((e) => [e.id, criterion(e)]), ["none", NONE_CRITERION]]);
}

export const NONE_CRITERION =
  "No listed procedure governs this: narration or a status report, a reply or relay to another agent, a decision the operator states, a question answered from the conversation, or work only sharing a topic or keyword with a listed procedure.";

/** The last extension context seen, so the input handler can reach the session. */
let latestCtx: unknown = null;

/** Minimal read-only slice of ReadonlySessionManager that we depend on. */
interface ReadonlySessionManagerLike {
  getEntries?: () => unknown[];
  buildSessionProjection?: (entries: unknown[], leafId?: string | null) => { messages?: unknown[] };
}

const CUSTOM_TYPE = "skill_suggestion";
// Resolved per call so tests can redirect the log (SKILL_SUGGEST_LOG_DIR) after import.
const logDir = (): string => process.env["SKILL_SUGGEST_LOG_DIR"] ?? join(homedir(), ".xtrm", "skill-suggest");

/**
 * The decision (CORE-2564): two Jev calls and one fitted score.
 *
 * Stage 1 ranks a wide BM25 list (120 candidates, 100 characters each, no
 * `none`) and asks the gate nouls; at the input seam it also keeps the
 * 24-candidate choice with `none`, whose weight on `none` was the best single
 * signal there. Stage 2 rereads the three best-ranked documents with their full
 * description and the opening of their body, picks one, and asks one `fits`
 * noul per document. The vendor recipe (TypeSafe skill_suggestion cookbook)
 * has the same two stages.
 *
 * A per-seam logistic score over those answers decides. It replaced a chain of
 * hand-set thresholds (CORE-2366/2553) whose confidence gate separated right
 * picks from quiet turns no better than chance. Fitted on the seeded train half
 * of the 600-row replay (3 live runs, jev-1.14.0), scored on the held-out half:
 * label precision 0.32 -> 0.48, false fires 0.063 -> 0.042, wanted rows with a
 * right pick 0.13 -> 0.20.
 *
 * Missing evidence never fires (CORE-2366): an answer the score needs that is
 * absent abstains, with the missing feature as the reason.
 */
export type Seam = "input" | "agent_end";
export const WIDE_MAX = 120;
const WIDE_TEXT = 100;
const RERANK_TOP = 3;
const BODY_CHARS = 700;
const oneLine = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

export const SCORE_MODEL: Record<Seam, { intercept: number; weights: Record<string, number>; threshold: number }> = {
  input: {
    intercept: -4.220655,
    weights: { fits_win: 1.809604, wide_p1: 1.646026, skill_none_inv: 2.636992, task: 0.426932, n_named: 0.685306, prose_inv: -1.365487 },
    threshold: 0.35,
  },
  agent_end: {
    intercept: -6.120762,
    weights: { fits_win: 3.286472, wide_p1: 2.247342, task: 0.950195, prose_inv: 0.826815, fits_max: 2.640259 },
    threshold: 0.55,
  },
};

/** CORE-2553: the task noul, asked at both seams. */
const TASK_NOUL =
  "Does the request (or the agent's stated next step) start a concrete piece of work, such as debugging, reviewing, releasing, deploying, planning, coordinating workers or operating a named service, rather than chat, a status check, a decision the operator states, or a reply to another agent?";
const PROSE_NOUL: Record<Seam, string> = {
  input: "Could a knowledgeable generalist fully satisfy this request in prose, with no tools and no access to the user's files? (Counts against suggesting.)",
  agent_end: "Is the stated next step purely mechanical or narrative, needing no doctrine? (Counts against suggesting.)",
};
const NAMED_NOUL = "Does the request name a specific tool, service, command, workflow or documented procedure to use?";
const SKILL_INSTRUCTIONS =
  "Pick the single skill or reference document whose stated use applies to the task this request starts, so that following it would change what the agent does next; otherwise pick none. A procedure that only shares a topic or keyword does not apply. Base it only on the request and the provided descriptions.";
const PICK_INSTRUCTIONS: Record<Seam, string> = {
  input: "Which of these documents is the right one for the agent to read before it starts on this request? Judge what each document is for, not shared words.",
  agent_end: "Which of these documents is the right one for the agent to read before its next step? Judge what each document is for, not shared words.",
};
const RERANK_INSTRUCTIONS: Record<Seam, string> = {
  input: "Exactly one of these documents is the right one for the agent to read before it starts on this request. Which one? Read what each actually covers, not just its name.",
  agent_end: "Exactly one of these documents is the right one for the agent to read before its next step. Which one? Read what each actually covers, not just its name.",
};
export function fitsQuestion(seam: Seam, name: string, description: string): string {
  return seam === "input"
    ? `Does the document '${name}' describe how to do the specific work this request asks for? It is described as: ${description}`
    : `Does the document '${name}' describe how to do the agent's next step? It is described as: ${description}`;
}

/** Choice ids, most probable first; ties keep the answer's order. */
export function rankedIds(probabilities: Record<string, number>): string[] {
  return Object.entries(probabilities).sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/** The score's inputs from both stages' answers; null where an answer is absent. */
export function decisionFeatures(a: {
  skillNone: number | null | undefined;
  wide: Record<string, number>;
  nouls: Record<string, number | null | undefined>;
  winner: string | null;
  fits: Record<string, number | null | undefined>;
}): Record<string, number | null> {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const fitsValues = Object.values(a.fits).map(num).filter((v): v is number => v !== null);
  const wideTop = Math.max(...Object.values(a.wide), Number.NEGATIVE_INFINITY);
  const task = num(a.nouls["starts_governed_task"]);
  const prose = num(a.nouls["prose_suffices"]);
  return {
    fits_win: a.winner ? num(a.fits[a.winner]) : null,
    fits_max: fitsValues.length ? Math.max(...fitsValues) : null,
    wide_p1: Number.isFinite(wideTop) ? wideTop : null,
    skill_none_inv: num(a.skillNone) === null ? null : 1 - (a.skillNone as number),
    task,
    prose_inv: prose === null ? null : 1 - prose,
    n_named: num(a.nouls["n_named"]),
  };
}

/** Logistic score for a seam; abstains (score null) when a weighted feature is missing. */
export function decisionScore(seam: Seam, features: Record<string, number | null | undefined>): { score: number | null; missing: string | null } {
  const model = SCORE_MODEL[seam];
  let z = model.intercept;
  for (const [k, w] of Object.entries(model.weights)) {
    const v = features[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return { score: null, missing: k };
    z += w * v;
  }
  return { score: 1 / (1 + Math.exp(-z)), missing: null };
}

/** The opening of a document's body for the rerank criteria; empty when unreadable. */
export async function docOpening(path: string): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return oneLine(text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^#\s.*\n/, ""), BODY_CHARS);
  } catch {
    return "";
  }
}

/** One seam's decision: both Jev stages and the score. Never rejects. */
export type Judgement =
  | { skip: string; failure?: ClassifierFailure; facts: Record<string, unknown> }
  | { skip: null; entry: RosterEntry | null; pick: string | null; score: number | null; reason: string; model: string | null; facts: Record<string, unknown> };

export async function judge(
  seam: Seam,
  registry: RegistryLike | null,
  index: RetrievalIndex<RosterEntry>,
  state: Record<string, unknown>,
  query: ShortlistQuery,
  timeoutMs?: number,
): Promise<Judgement> {
  const sl = shortlist(index, query);
  const wide = shortlist(index, query, WIDE_MAX);
  const facts: Record<string, unknown> = { roster: wide.total, shortlist: sl.candidates.length, wide: wide.candidates.length, dropped: wide.dropped, territory: wide.territoryHits };
  if (wide.candidates.length === 0) return { skip: "no_candidates", facts };
  const full = criteriaOf(wide.candidates, index);
  const q1: Record<string, Question> = {};
  if (seam === "input") q1["skill"] = { type: "choice", instructions: SKILL_INSTRUCTIONS, criteria: criteriaOf(sl.candidates, index) };
  q1["starts_governed_task"] = { type: "noul", instructions: TASK_NOUL };
  q1["prose_suffices"] = { type: "noul", instructions: PROSE_NOUL[seam] };
  q1["wide"] = {
    type: "choice",
    instructions: PICK_INSTRUCTIONS[seam],
    criteria: Object.fromEntries(wide.candidates.map((e) => [e.id, oneLine(full[e.id] ?? e.id, WIDE_TEXT)])),
  };
  if (seam === "input") q1["n_named"] = { type: "noul", instructions: NAMED_NOUL };
  const one = await classify(registry, state, q1, { timeoutMs });
  facts["jev_ms"] = one.ms;
  facts["jev_path"] = one.path;
  if (!one.result) return { skip: `classifier:${one.failure}`, failure: one.failure ?? "transport", facts };
  const wideAnswer = one.result.choices["wide"];
  const byId = new Map(wide.candidates.map((e) => [e.id, e]));
  const top = wideAnswer ? rankedIds(wideAnswer.probabilities).filter((id) => byId.has(id)).slice(0, RERANK_TOP) : [];
  if (!wideAnswer || top.length === 0) return { skip: "classifier:bad_answer", failure: "bad_answer", facts };
  const openings = await Promise.all(top.map((id) => docOpening(byId.get(id)!.path)));
  const q2: Record<string, Question> = {
    rr_wide: { type: "choice", instructions: RERANK_INSTRUCTIONS[seam], criteria: Object.fromEntries(top.map((id, i) => [id, `${full[id]} — ${openings[i]}`])) },
  };
  top.forEach((id, i) => {
    q2[`fits::${i}`] = { type: "noul", instructions: fitsQuestion(seam, byId.get(id)!.name, full[id] ?? "") };
  });
  const two = await classify(registry, state, q2, { timeoutMs });
  facts["jev_ms"] = one.ms + two.ms;
  if (!two.result) return { skip: `classifier:${two.failure}`, failure: two.failure ?? "transport", facts };
  const winner = two.result.choices["rr_wide"]?.choice ?? null;
  const fits = Object.fromEntries(top.map((id, i) => [id, two.result!.nouls[`fits::${i}`]]));
  const skill = one.result.choices["skill"];
  const features = decisionFeatures({
    skillNone: seam === "input" && skill ? (skill.probabilities["none"] ?? 0) : null,
    wide: wideAnswer.probabilities,
    nouls: one.result.nouls,
    winner,
    fits,
  });
  const { score, missing } = decisionScore(seam, features);
  const entry = winner ? (byId.get(winner) ?? null) : null;
  const reason = missing ? `missing-${missing}` : !entry ? "unknown-entry" : (score as number) < SCORE_MODEL[seam].threshold ? "below-score" : "fire";
  facts["score"] = score === null ? null : Number(score.toFixed(3));
  facts["wide_top"] = top;
  facts["features"] = Object.fromEntries(Object.entries(features).map(([k, v]) => [k, v === null ? null : Number(v.toFixed(3))]));
  return { skip: null, entry: reason === "fire" ? entry : null, pick: winner, score, reason, model: two.result.model, facts };
}

const INJECT_TIMEOUT_MS = 2500;

const COOLDOWN_MIN = 30;

/**
 * Bare control nudges ("continue", "go on", "yes") mean resume, not new work:
 * they carry no task context for a doctrine to attach to. Deterministic, so
 * no classifier call is spent on them. Anything with extra words falls
 * through — a real request that happens to start with "continue, check the
 * PR checks" still gets evaluated.
 */
export function isControlNudge(prompt: string): boolean {
  const t = prompt.trim().toLowerCase().replace(/[.!\u2026]+$/, "").replace(/\s+/g, " ");
  if (t.split(" ").length > 3) return false;
  return /^(continue|cont|go on|go ahead|proceed|carry on|keep going|next|yes|yep|yeah|ok|okay|k|do it|go|thanks|thank you|ty|nice|cool|perfect|great)( please| pls| now| then| on)?$/.test(t);
}

/**
 * CORE-2564: a message from another agent typed into this agent's pane
 * arrives with source "interactive", so the CORE-2551 source check misses it.
 * Its head names the sender ("Coordinator 8qox: ...", "fri-coord-b: ...",
 * "thur-coord -> wed2-helper: ...", "From <session>: ...") or carries the
 * intercom marker. On the labelled replay these were a third of the false fires.
 */
export function isPeerRelay(prompt: string): boolean {
  return /^\s*(?:\[cross-agent message\b|Coordinator\b|From\s+\S+|[\w.-]*coord[\w.-]*\s*(?:->|→|:)|\S+\s*(?:->|→)\s*\S+\s*:)/i.test(prompt);
}

// CORE-2534: rows queue in memory and are appended asynchronously.
const decisionLog = createJsonlLog(logDir);
function logDecision(row: Record<string, unknown>): void {
  decisionLog.append(row);
}
/** Wait for queued decision rows to reach disk (tests, shutdown). */
export function flushDecisionLog(): Promise<void> {
  return decisionLog.flush();
}

/** One row for a seam that decided not to classify or not to fire, with its reason. */
function logSkip(seam: string, reason: string, extra: Record<string, unknown> = {}): void {
  logDecision({ ts: new Date().toISOString(), seam, outcome: "skip", reason, ...extra });
}

/**
 * Repeated classifier failures of one class warn the operator once per session
 * (CORE-2534): the 2026-10-21 outage ran eight days with no visible symptom.
 */
const WARN_AFTER_FAILURES = 3;
export function createFailureWatch(warn: (message: string) => void) {
  const streak = new Map<string, number>();
  const warned = new Set<string>();
  return {
    failed(reason: string): void {
      const cls = reason.startsWith("http_") ? "http" : reason;
      const n = (streak.get(cls) ?? 0) + 1;
      streak.set(cls, n);
      if (n >= WARN_AFTER_FAILURES && !warned.has(cls)) {
        warned.add(cls);
        warn(`skill-suggest: the classifier failed ${n} times in a row (${reason}); suggestions are paused until it recovers.`);
      }
    },
    succeeded(): void {
      streak.clear();
    },
  };
}

/**
 * Recent conversation, compressed for the classifier.
 *
 * The input seam sees only the operator's prompt, which is why Jev kept
 * matching doctrine by surface words ("skill", "wait"). The session
 * projection gives the turns around the prompt — compaction-aware, so no
 * reading of this file can drift from what the model actually sees.
 */
export interface TurnEvidence {
  excerpt: string;
  lastAssistant: string;
  wasActive: boolean;
  errored: boolean;
  editedFiles: string[];
  nextIdx: number;
}

/**
 * The whole working turn, not just its last message.
 *
 * Final-message-only under-recalls: the intention often lives in an earlier
 * assistant message, a tool error, or an edited file, and the finale is "done,
 * let me verify".
 * Mirrors substrate-suggest's turnEvidence.
 *
 * Pi's shapes (docs/message-types.md): an assistant tool call is a
 * `{type: "toolCall", name, arguments}` content block; its result is a separate
 * `{role: "toolResult", toolName, isError}` message. Reading invented
 * `tool_call`/`tool_result` blocks left wasActive false on every real turn, so
 * this seam never classified anything (CORE-2547).
 */
export function turnEvidence(
  messages: ReadonlyArray<{ role?: string; content?: unknown; toolName?: unknown; isError?: unknown }>,
  fromIdx: number,
): TurnEvidence {
  const parts: string[] = [];
  const editedFiles: string[] = [];
  let lastAssistant = "";
  let wasActive = false;
  let errored = false;
  for (let i = Math.max(0, fromIdx); i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "toolResult") {
      wasActive = true;
      if (m.isError === true) {
        errored = true;
        parts.push(`tool_error: ${String(m.toolName ?? "").slice(0, 40)}`);
      }
      continue; // tool output is not turn text; it would crowd out the intention
    }
    const content = Array.isArray(m?.content) ? (m!.content as Array<Record<string, unknown>>) : [];
    for (const p of content) {
      const type = p?.["type"];
      if (type === "text" && typeof p["text"] === "string") {
        const text = p["text"];
        if (m?.role === "assistant") lastAssistant = text;
        if (text.trim()) parts.push(`${m?.role ?? "?"}: ${text.slice(0, 1200)}`);
      } else if (type === "toolCall") {
        const name = String(p["name"] ?? "");
        wasActive = true;
        if (/^(edit|write|apply_patch|multi_edit)$/.test(name)) {
          const args = (p["arguments"] ?? {}) as Record<string, unknown>;
          const file = ["path", "file_path", "filePath", "file"].map((k) => args[k]).find((v) => typeof v === "string");
          if (typeof file === "string" && !editedFiles.includes(file)) editedFiles.push(file);
        }
        parts.push(`tool: ${name}`);
      }
    }
  }
  return { excerpt: parts.join("\n").slice(-8000), lastAssistant, wasActive, errored, editedFiles, nextIdx: messages.length };
}

export function conversationContext(
  messages: ReadonlyArray<{ role?: string; content?: unknown }> | undefined,
  maxChars = 1500,
): string {
  if (!messages?.length) return "";
  const turns: string[] = [];
  for (const m of messages) {
    const role = m?.role === "user" ? "operator" : m?.role === "assistant" ? "agent" : null;
    if (!role) continue;
    const parts = Array.isArray(m?.content) ? (m.content as Array<Record<string, unknown>>) : [];
    const text = parts
      .filter((p) => p?.["type"] === "text" && typeof p["text"] === "string")
      .map((p) => String(p["text"]).replace(/\s+/g, " ").trim())
      .join(" ")
      .slice(0, 400);
    if (text) turns.push(`${role}: ${text}`);
  }
  const recent = turns.slice(-6);
  return recent.join("\n").slice(-maxChars);
}


/**
 * Read-after-suggest accounting (CORE-2367).
 *
 * A suggestion that is never read is a working card that changed nothing, and
 * until this existed nothing in the system could tell the two apart. The rule
 * is deliberately narrow: a PATH-IDENTICAL read of the suggested file within
 * N turns. Counting card renders would make the metric agree with itself.
 */
export interface ReadWatch {
  id: string;
  path: string;
  turnsLeft: number;
}

export function watchRead(
  watch: ReadWatch | null,
  readPath: string | null,
  turnBoundary: boolean,
): { watch: ReadWatch | null; read: boolean; expired: boolean } {
  if (!watch) return { watch: null, read: false, expired: false };
  if (readPath && samePath(readPath, watch.path)) {
    return { watch: null, read: true, expired: false };
  }
  if (turnBoundary) {
    const left = watch.turnsLeft - 1;
    if (left <= 0) return { watch: null, read: false, expired: true };
    return { watch: { ...watch, turnsLeft: left }, read: false, expired: false };
  }
  return { watch, read: false, expired: false };
}

/** Path comparison tolerant of relative-vs-absolute and `.` segments. */
export function samePath(a: string, b: string): boolean {
  const norm = (v: string) => {
    try {
      return resolve(v);
    } catch {
      return v;
    }
  };
  return norm(a) === norm(b);
}

/** The path a `read`-shaped tool call targeted, or null. */
export function readPathOf(tool: string, args: unknown): string | null {
  if (tool !== "read" && tool !== "read_file" && tool !== "view") return null;
  const a = (args ?? {}) as { path?: unknown; file_path?: unknown };
  const p = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : null;
  return p;
}

/** A registry-backed entry: the service-knowledge CLI is a valid route to its evidence. */
export function isServiceEntry(entry: { id: string; skill: string }): boolean {
  return entry.id.includes("service-knowledge/") || entry.skill.includes("service-knowledge");
}

/** The labelled doctrine block for a roster hit — one shape for both seams. */
/**
 * The section headings of a skill file, bounded (CORE-2367).
 *
 * A ROUTER, not an excerpt: the source records that "a bounded excerpt
 * duplicated the doc badly", so this deliberately carries structure and no
 * prose. It answers "where do I look" for the price of a readdir-sized scan,
 * and it cannot go stale in the way quoted paragraphs do.
 */
export function routerSections(md: string, max = 12): string[] {
  return headingsOf(md, max);
}

export function doctrineBlock(
  entry: RosterEntry,
  about: string,
  confidence: number | null,
  model: string | null,
): string {
  const lead =
    entry.level === "skill"
      ? `Load this skill: /skill:${entry.skill}. Ignore this if it does not fit what you were asked to do.`
      : `Read: ${entry.path} — nested under /skill:${entry.skill}. Ignore this if it does not fit.`;
  // The router: where to look, not what it says. A service-backed entry also
  // names the CLI, because the registry is queryable and a file read is only
  // one of the two routes to the evidence.
  // Headings were read once, when the index was built: no file IO at delivery.
  const sections = entry.headings ?? [];
  const router = [
    sections.length ? `Sections: ${sections.join(" \u00b7 ")}` : null,
    isServiceEntry(entry)
      ? `Service CLI: service-knowledge index query "<3-5 terms>" --bundle (see service-knowledge --help).`
      : null,
  ].filter(Boolean).join("\n");
  return contextBlock("skill-doctrine", {
    about,
    source: entry.id,
    skill: entry.skill,
    level: entry.level,
    model: model ?? "jev",
    confidence,
    router: router || null,
    body: [
      lead,
      `Its instructions: read ${entry.path} and apply what fits before proceeding.`,
      entry.level === "reference" ? `Nested reference of the ${entry.skill} skill.` : "",
      // What this skill is, in its own words — the description the roster
      // ranked on, restored for the reader. No trailing period (CORE-2348).
      `Description: ${stripEndPeriod(entry.description)}`,
    ].filter(Boolean).join("\n"),
  });
}

export default function skillSuggestExtension(pi: ExtensionAPI): void {
  const off = () =>
    pi.getFlag("no-skill-suggest") === true ||
    (process.env["SKILL_SUGGEST"] ?? "").toLowerCase() === "off";

  const cooldowns: Record<string, number> = {};
  /** Inputs seen this session: an extension-sourced input that opens the session is a dispatched task (CORE-2551). */
  let inputsThisSession = 0;
  /** CORE-2367: the outstanding suggestion whose file read we are waiting on. */
  let readWatch: ReadWatch | null = null;
  /** Files read or edited this session, newest last, bounded: territory evidence for the shortlist. */
  const sessionFiles: string[] = [];
  const noteFile = (path: string) => {
    const i = sessionFiles.indexOf(path);
    if (i >= 0) sessionFiles.splice(i, 1);
    sessionFiles.push(path);
    if (sessionFiles.length > 20) sessionFiles.shift();
  };
  /** Turns AFTER the arming turn in which a read still counts. */
  const READ_WINDOW_TURNS = 2;
  // The input seam arms mid-turn, and that same turn's agent_end ages the watch once,
  // so it gets one extra tick; the agent_end seam arms after the tick already ran.
  const INPUT_SEAM_TURNS = READ_WINDOW_TURNS + 1;
  const cooldownOk = (id: string, now: number) => (cooldowns[id] === undefined || now >= cooldowns[id]);
  const cooldownSet = (id: string) => { cooldowns[id] = Date.now() + COOLDOWN_MIN * 60_000; };

  // The message body is the model-visible labelled block; the operator gets
  // the shared suggestion card parsed from it (CORE-2546): one row on the tool
  // grid, the skill accent on the marker only. A block that does not parse
  // falls back to the content as header plus body lines.
  registerEventRenderer(pi, CUSTOM_TYPE, (message) => {
    const content = typeof (message as { content?: unknown } | null)?.content === "string"
      ? (message as { content: string }).content
      : "";
    const meta = parseContextBlock(content);
    if (!meta) return resolveSuggestionMessage(message, "skill");
    return resolveSuggestionMessage({
      details: {
        card: {
          // CORE-2348: header carries the full load subpath.
          identity:
            meta.kind === "agent-settlement"
              ? "result settled"
              : meta.level === "reference"
                ? `load /skill:${meta.source ?? "—"}`
                : `load /skill:${meta.skill ?? meta.source ?? "—"}/SKILL.md`,
          ...(meta.body ? { summary: stripEndPeriod(meta.body) } : {}),
          ...(suggestionFacts(meta.confidence) ? { facts: suggestionFacts(meta.confidence) } : {}),
          tint: "skill",
        },
      },
    });
  }, {
    tintGlyph: (glyph, details, theme) => tintSuggestionGlyph(glyph, details.tint, theme),
  });

  const failures = createFailureWatch((message) => {
    try {
      (latestCtx as { ui?: { notify?: (m: string, t?: string) => void } } | null)?.ui?.notify?.(message, "warning");
    } catch {
      /* a warning must never break a turn */
    }
  });

  /**
   * Arbitrate and deliver one doctrine block (CORE-2549): at most one
   * suggestion per agent run across both suggest extensions, none stale, none
   * repeated in the session. Exactly one log row either way.
   */
  const offer = (seam: string, entry: RosterEntry, block: string, epoch: number, watchTurns: number, facts: Record<string, unknown>) => {
    const verdict = cooldownOk(entry.id, Date.now())
      ? propose({
          epoch,
          key: `skill:${entry.id}`,
          deliver: () => {
            cooldownSet(entry.id);
            readWatch = { id: entry.id, path: entry.path, turnsLeft: watchTurns };
            // The renderer draws the card from the labelled block's fields, so
            // the model receives the doctrine and the operator sees the card.
            pi.sendMessage(
              { customType: CUSTOM_TYPE, content: block, display: true, details: { skill: entry.id, level: entry.level, seam } },
              DELIVERY,
            );
          },
        })
      : "cooldown";
    const fired = verdict === "delivered";
    logDecision({ ts: new Date().toISOString(), seam, pick: entry.id, outcome: fired ? "fire" : "skip", reason: fired ? "fire" : verdict, injected: fired, ...facts });
  };

  const handler = async (event: { text?: string; source?: string }, ctx?: { modelRegistry?: unknown; sessionManager?: unknown }) => {
    latestCtx = ctx;
    if (off()) return { action: "continue" } as const;
    // A new prompt moves the evidence on: answers still in flight for the
    // previous one become stale (CORE-2549).
    const epoch = notePrompt(event);
    const prompt = typeof event?.text === "string" ? event.text : "";
    // CORE-2551: peer, coordinator and intercom text arrives with source
    // "extension" mid-session; it is not a request to this agent, and the
    // working turn it starts is judged at agent_end. The input that opens a
    // session is the dispatched task itself, so it is judged here.
    const opensSession = inputsThisSession++ === 0;
    if (event?.source === "extension" && !opensSession) return logSkip("input", "injected"), { action: "continue" } as const;
    if (isPeerRelay(prompt) && !opensSession) return logSkip("input", "peer_relay"), { action: "continue" } as const;
    if (prompt.startsWith("/")) return logSkip("input", "command"), { action: "continue" } as const; // commands decide for themselves
    if (isControlNudge(prompt)) return logSkip("input", "control_nudge"), { action: "continue" } as const; // "continue" carries no task signal
    if (prompt.trim().length < 12) return logSkip("input", "too_short"), { action: "continue" } as const;

    const registry = ((ctx as unknown as { modelRegistry?: RegistryLike } | undefined)?.modelRegistry ?? null);
    if (!registry && !readApiKey()) return logSkip("input", "no_key"), { action: "continue" } as const;

    const cwd = process.cwd();
    const context = recentContext(prompt);
    const files = [...sessionFiles];

    try {
      // CORE-2549: pi never waits for the index or Jev. Retrieval and the
      // answer run detached; the answer is arbitrated whenever it lands.
      detach(async () => {
      const index = await readyIndex(cwd);
      if (!index) return logSkip("input", "index_unavailable");
      const state = {
        request: prompt.slice(0, 2000),
        recent_conversation: context,
        cwd,
      };
      const j = await judge("input", registry, index, state, { text: `${prompt}\n${context}`, files }, INJECT_TIMEOUT_MS);
      const facts = { prompt_chars: prompt.length, ...j.facts };
      if (j.skip !== null) {
        if (j.failure) failures.failed(j.failure);
        return logSkip("input", j.skip, facts);
      }
      failures.succeeded();
      // One card per prompt, per catalog id: a fire suppressed by cooldown is
      // logged as such, not as a fire. Every evaluation is logged: negatives
      // are the tuning signal.
      const entry = j.entry;
      if (!entry || !cooldownOk(entry.id, Date.now())) {
        logDecision({ ts: new Date().toISOString(), seam: "input", pick: j.pick ?? "none", outcome: entry ? "skip" : "abstain", reason: entry ? "cooldown" : j.reason, injected: false, ...facts });
        return;
      }
      // The prompt is never mutated: a transform echoes into the operator's
      // input line. The block rides a steer message instead (CORE-2548).
      offer("input", entry, doctrineBlock(entry, `the current request`, j.score, j.model), epoch, INPUT_SEAM_TURNS, facts);
      });
      return { action: "continue" } as const;
    } catch {
      return { action: "continue" } as const; // fail-open: prompt untouched
    }
  };

  // The input seam decides; it never mutates the prompt.
  pi.on("input", handler as never);

  // CORE-2367: did the suggestion actually get read? A path-identical read inside
  // the window counts; nothing else does.
  pi.on("tool_call", (event) => {
    // Pi's ToolCallEvent carries `input`; `args` is the legacy shape.
    const e = event as { toolName?: string; input?: unknown; args?: unknown };
    const tool = String(e.toolName ?? "");
    const input = (e.input ?? e.args ?? {}) as Record<string, unknown>;
    const touched = /^(edit|write|apply_patch|multi_edit)$/.test(tool)
      ? ["path", "file_path", "filePath", "file"].map((k) => input[k]).find((v) => typeof v === "string")
      : null;
    if (typeof touched === "string") noteFile(touched);
    const path = readPathOf(tool, input);
    if (path) noteFile(path);
    if (!path || !readWatch) return;
    const id = readWatch.id;
    const next = watchRead(readWatch, path, false);
    readWatch = next.watch;
    if (next.read) {
      logDecision({ ts: new Date().toISOString(), seam: "read_after_suggest", pick: id, outcome: "read", path });
    }
  });

  // Conversation context for the classifier, read from the session projection
  // (compaction-aware). InputEvent itself carries only the new text, so this
  // is the only way the seam sees what the conversation is actually about.
  function recentContext(prompt: string): string {
    const manager = (latestCtx as { sessionManager?: ReadonlySessionManagerLike } | undefined)?.sessionManager;
    if (!manager) return "";
    try {
      const entries = manager.getEntries?.();
      const projection = manager.buildSessionProjection?.(entries ?? []);
      const messages = projection?.messages as ReadonlyArray<{ role?: string; content?: unknown }> | undefined;
      // The prompt about to be evaluated is already in the projection; drop
      // the duplicate tail so Jev does not read it twice.
      const trimmed = messages?.filter((m) => !(m?.role === "user" && String(Array.isArray(m.content) ? JSON.stringify(m.content) : "").includes(prompt.trim().slice(0, 60))));
      return conversationContext(trimmed ?? messages);
    } catch {
      return "";
    }
  }

  // The intention seam: the agent declares what it is doing in its own final
  // message. Same two-stage Jev over the turn evidence; the doctrine rides
  // into the next turn as a followUp the model reads.
  const runAgentEnd = async (messages: unknown[], turn: TurnEvidence, ctx: unknown, epoch: number): Promise<void> => {
    try {
      const { lastAssistant, wasActive } = turn;
      // An empty boundary (no new messages) is not a decision: no row.
      if (messages.length === 0 || (!lastAssistant && !wasActive)) return;
      if (!lastAssistant || !wasActive) return logSkip("agent_end", "inactive_turn");
      const registry = ((ctx as unknown as { modelRegistry?: RegistryLike } | undefined)?.modelRegistry ?? null);
      if (!registry && !readApiKey()) return logSkip("agent_end", "no_key");
      const index = await readyIndex(process.cwd());
      if (!index) return logSkip("agent_end", "index_unavailable");
      const j = await judge("agent_end", registry, index, {
        agent_final_message: lastAssistant.slice(0, 1500),
        working_turn_excerpt: turn.excerpt.slice(0, 6000),
        edited_files: turn.editedFiles.slice(0, 8),
        turn_had_error: turn.errored,
      }, { text: `${lastAssistant}\n${turn.excerpt}`, files: [...sessionFiles, ...turn.editedFiles] });
      if (j.skip !== null) {
        if (j.failure) failures.failed(j.failure);
        return logSkip("agent_end", j.skip, j.facts);
      }
      failures.succeeded();
      const entry = j.entry;
      if (!entry || !cooldownOk(entry.id, Date.now())) {
        logDecision({ ts: new Date().toISOString(), seam: "agent_end", pick: j.pick ?? "none", outcome: entry ? "skip" : "abstain", reason: entry ? "cooldown" : j.reason, ...j.facts });
        return;
      }
      // CORE-2367: the intention block reaches the model, not only the card.
      offer("agent_end", entry, doctrineBlock(entry, `your stated next step`, j.score, j.model), epoch, READ_WINDOW_TURNS, j.facts);
    } catch {
      /* fail-open: a suggestion extension must never break a session */
    }
  };

  pi.on("agent_start", () => noteRunStart());

  // The intention seam: evidence is read synchronously (cheap, in memory), the
  // classification runs detached (CORE-2549).
  pi.on("agent_end", (event: unknown, ctx: unknown) => {
    // Turn boundary: age the read watch BEFORE this turn's own decision can arm a new one.
    if (readWatch) {
      const id = readWatch.id;
      const next = watchRead(readWatch, null, true);
      readWatch = next.watch;
      if (next.expired) logDecision({ ts: new Date().toISOString(), seam: "read_after_suggest", pick: id, outcome: "expired" });
    }
    if (off()) return;
    const messages = (event as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    // CORE-2564: pi emits the messages this run generated, a new array per
    // run (pi-agent-core agent-loop), so every run is read from its start.
    const turn = turnEvidence(messages, 0);
    const epoch = currentEpoch();
    detach(() => runAgentEnd(messages, turn, ctx, epoch));
  });

  // Reload the roster when packs change on disk (cheap: cache TTL governs).
  if (typeof pi.on === "function") {
    // Build the index as the session starts, off any handler's critical path.
    pi.on("session_start", () => {
      inputsThisSession = 0;
      resetSession();
      resetIndex();
      void rebuildIndex(process.cwd());
      void primeApiKey();
    });
  }
}
