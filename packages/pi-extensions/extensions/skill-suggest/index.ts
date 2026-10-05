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
 *   2. Jev, two-stage: gate nouls on the request (would a careful expert
 *      follow a documented procedure? could prose alone suffice?) then one
 *      Choice over the roster. Best fit under threshold -> nothing.
 *   3. On a hit: the prompt is transformed with a bounded `<skill_relevance>`
 *      block pointing at the doc path (the model reads it), ignore-if-not-fits
 *      (the mod's cookbook wording). A display-only house card shows the
 *      operator what was injected.
 *
 * And at each agent_end (the intention seam): the AGENT decides things no
 * user prompt ever names — "let me debug this", "I'll review the diff".
 * The same two-stage Jev runs over the agent's final message and turn
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
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { contextBlock, formatSuggestionCard, parseContextBlock, renderCardBox, type VerbSpec } from "../substrate-suggest/catalog.ts";
import { classifyViaRegistry, systemOne, readApiKey, type Question, type RegistryLike } from "../substrate-suggest/jev.ts";
import { discoverRoster, resetRosterCache, type RosterEntry } from "./roster.ts";

/**
 * Which seam delivers a decision, for every situation a session can be in.
 *
 * The bug this encodes: submitting decided a doctrine, then the turn made no
 * tool call, and the block was dropped. Keep this table honest — a new
 * situation needs a row, not a hope.
 */
export type DeliverySeam = "tool_result" | "agent_end_flush" | "agent_end_decision" | "none";
export interface Situation {
  /** The operator submitted a prompt this turn. */
  prompted: boolean;
  /** Submit produced a decision that is still pending. */
  pending: boolean;
  /** The turn has at least one tool call. */
  usedTool: boolean;
  /** The turn ended with agent activity worth judging. */
  activeTurn: boolean;
}

export function deliverySeam(s: Situation): DeliverySeam {
  if (s.pending) return s.usedTool ? "tool_result" : "agent_end_flush";
  if (!s.prompted && s.activeTurn) return "agent_end_decision"; // unprompted: judge the turn itself
  if (s.prompted && s.activeTurn) return "agent_end_decision";
  return "none";
}

/** Decided at submit, delivered at the first ordered boundary in the turn. */
interface PendingDoctrine {
  entry: RosterEntry;
  block: string;
  confidence: number | null;
}

/** The last extension context seen, so the input handler can reach the session. */
let latestCtx: unknown = null;

/** Minimal read-only slice of ReadonlySessionManager that we depend on. */
interface ReadonlySessionManagerLike {
  getEntries?: () => unknown[];
  buildSessionProjection?: (entries: unknown[], leafId?: string | null) => { messages?: unknown[] };
}

const CUSTOM_TYPE = "skill_suggestion";
const LOG_DIR = join(homedir(), ".xtrm", "skill-suggest");
const LOG_FILE = join(LOG_DIR, "log.jsonl");

/**
 * The gate, as one pure function (CORE-2366).
 *
 * The defect: every noul defaulted to 0, so a NEGATING noul contributed
 * 1.0 - the strongest possible vote to fire. A classifier that answered
 * nothing scored 0.5 and cleared a 0.3 bar. Missing evidence was the
 * strongest evidence there was.
 *
 * The fix is asymmetric, and deliberately NOT blanket fail-closed: Jev
 * degrades partially under timeout and fallback, so abstaining on every
 * partial answer would starve legitimate weak signal and trade a visible
 * error for an invisible one.
 *   - a missing POSITIVE noul has no evidence, so the gate fails;
 *   - a missing NEGATING noul is imputed NEUTRAL (0.5), never maximal.
 */
export function gateTerms(nouls: Record<string, number | null | undefined>): {
  terms: number[];
  abstain: string | null;
} {
  const terms: number[] = [];
  let abstain: string | null = null;

  // Positive noul: absent evidence cannot support firing.
  const positive = nouls["would_follow_documented_procedure"];
  if (typeof positive !== "number") {
    abstain = "missing-positive-noul";
    terms.push(0);
  } else {
    terms.push(positive);
  }

  // Negating nouls: absent evidence is neutral, not maximal.
  for (const key of ["prose_suffices", "asks_about_the_tooling"] as const) {
    const raw = nouls[key];
    terms.push(typeof raw === "number" ? 1 - raw : 0.5);
  }

  return { terms, abstain };
}

/** Would this entry be suggested? The reason is returned so it can be logged. */
export function evaluateGate(input: {
  nouls: Record<string, number | null | undefined>;
  confidence: number | null;
  noneConfidence?: number | null;
  hasEntry: boolean;
}): { fire: boolean; gateMean: number; reason: string } {
  const { terms, abstain } = gateTerms(input.nouls);
  const gateMean = terms.reduce((a, b) => a + b, 0) / terms.length;

  if (abstain) return { fire: false, gateMean, reason: abstain };

  // A mean hides a unanimous veto. With a strong positive (1.0) and BOTH negators
  // maxed (0.0 each) the mean lands exactly on GATE_THRESHOLD, so a strict `<`
  // comparison let "prose fully suffices AND this is pure tooling chatter" fire.
  // Two independent negators at their extreme outrank one positive; a mean cannot
  // express that, so it is stated explicitly.
  const proseMax = input.nouls["prose_suffices"] ?? 0;
  const toolingMax = input.nouls["asks_about_the_tooling"] ?? 0;
  if (proseMax >= 0.9 && toolingMax >= 0.9) {
    return { fire: false, gateMean, reason: "vetoed-by-negators" };
  }

  if (gateMean < GATE_THRESHOLD) return { fire: false, gateMean, reason: "below-gate" };
  if (!input.hasEntry) return { fire: false, gateMean, reason: "unknown-entry" };

  // The agent_end seam had NO confidence sub-gate at all, so a near-zero pick with
  // a healthy gate injected there by design. Both seams require it now.
  const confidence = input.confidence;
  if (typeof confidence !== "number") return { fire: false, gateMean, reason: "missing-confidence" };
  if (confidence < FITS_THRESHOLD) return { fire: false, gateMean, reason: "below-fits" };

  // Confidence alone is insufficient: the winner must BEAT the explicit `none`
  // option, not merely clear an absolute bar. `none` is otherwise just another
  // entry in the choice, so a weak winner fires against nothing.
  const none = input.noneConfidence;
  if (typeof none === "number" && confidence - none < NONE_MARGIN) {
    return { fire: false, gateMean, reason: "below-none-margin" };
  }

  return { fire: true, gateMean, reason: "fire" };
}

const GATE_THRESHOLD = 0.3; // mean of gate nouls under this -> nothing
const FITS_THRESHOLD = 0.3; // winner's own confidence under this -> nothing (both seams, CORE-2366)
const NONE_MARGIN = 0.05; // the winner must BEAT `none`, not merely clear a bar
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

function logDecision(row: Record<string, unknown>): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${JSON.stringify(row)}\n`);
  } catch {
    /* logging is best-effort */
  }
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
 * let me verify". Cursor-based so consecutive turns do not double-count.
 * Mirrors substrate-suggest's turnEvidence.
 */
export function turnEvidence(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
  fromIdx: number,
): TurnEvidence {
  const parts: string[] = [];
  const editedFiles: string[] = [];
  let lastAssistant = "";
  let wasActive = false;
  let errored = false;
  for (let i = Math.max(0, fromIdx); i < messages.length; i++) {
    const m = messages[i];
    const content = Array.isArray(m?.content) ? (m!.content as Array<Record<string, unknown>>) : [];
    for (const p of content) {
      const type = p?.["type"];
      if (type === "text" && typeof p["text"] === "string") {
        const text = p["text"];
        if (m?.role === "assistant") lastAssistant = text;
        if (text.trim()) parts.push(`${m?.role ?? "?"}: ${text.slice(0, 1200)}`);
      } else if (type === "tool_call") {
        const name = String(p["toolName"] ?? p["name"] ?? "");
        wasActive = true;
        if (/^(edit|write|apply_patch|multi_edit)$/.test(name)) {
          const path = (p["input"] ?? p["args"] ?? {}) as Record<string, unknown>;
          const file = ["file_path", "filePath", "path", "file"].map((k) => path[k]).find((v) => typeof v === "string");
          if (typeof file === "string" && !editedFiles.includes(file)) editedFiles.push(file);
        }
        parts.push(`tool: ${name}`);
      } else if (type === "tool_result" || type === "tool_error") {
        wasActive = true;
        errored = true;
        parts.push(`tool_error: ${String(p["toolName"] ?? "").slice(0, 40)}`);
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

/** Shared Jev runner for both seams: Pi-native classifier first, REST second. */
async function askJev(
  registry: RegistryLike | null,
  state: Record<string, unknown>,
  questions: Record<string, Question>,
) {
  let result = registry ? await classifyViaRegistry(registry, state, questions) : null;
  if (!result) result = await systemOne(state, questions);
  return result;
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

/** The last segment of a path-shaped id: the document a human would name. */
function leafName(id: string): string {
  const parts = id.split("/").filter(Boolean);
  return parts[parts.length - 1] || id;
}

/**
 * CORE-2367: signal a suggestion to LOAD, never assert a load that did not happen.
 * The header names the artefact in human terms - pack/skill plus the leaf name - and the
 * path goes in the body, where a reader can act on it. A live render showed a header
 * carrying `service-knowledge/services/infrastructure-platform/references/production-deploy-runbook`,
 * which is a filesystem location doing a header's job.
 */
function skillVerb(entry: RosterEntry, confidence: number | null): VerbSpec {
  return {
    id: "skill_suggest",
    action:
      entry.level === "skill"
        ? `consider loading /skill:${entry.skill}`
        : `reference to read · ${entry.skill}/${leafName(entry.id)}`,
    oneLine: entry.description,
    instruction: () =>
      `Load /skill:${entry.skill} or read ${entry.path}; apply what fits. Ignore this if it does not fit.`,
    severity: "normal",
    cooldownMin: COOLDOWN_MIN,
    source: "jev",
  };
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
  const out: string[] = [];
  for (const line of md.split("\n")) {
    // H2/H3 only: the H1 is the document title, not a place to look.
    const m = /^#{2,3}\s+(.{1,80}?)\s*$/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
    if (out.length >= max) break;
  }
  return out;
}

/** Sections for the entry's own file, or [] when it cannot be read. */
function sectionsFor(entry: RosterEntry): string[] {
  try {
    return routerSections(readFileSync(entry.path, "utf-8"));
  } catch {
    return [];
  }
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
  const sections = sectionsFor(entry);
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
      // ranked on, restored for the reader.
      `\x1b[3m${entry.description}\x1b[23m`,
    ].filter(Boolean).join("\n"),
  });
}

export default function skillSuggestExtension(pi: ExtensionAPI): void {
  const off = () =>
    pi.getFlag("no-skill-suggest") === true ||
    (process.env["SKILL_SUGGEST"] ?? "").toLowerCase() === "off";

  const cooldowns: Record<string, number> = {};
  /** Advances per turn so consecutive turns do not double-count evidence. */
  let messageCursor = 0;
  /** Set by the input seam, consumed by the first tool_result of the turn. */
  let pending: PendingDoctrine | null = null;
  /** CORE-2367: the outstanding suggestion whose file read we are waiting on. */
  let readWatch: ReadWatch | null = null;
  let lastSuggestedId: string | null = null;
  const READ_WINDOW_TURNS = 2;
  const cooldownOk = (id: string, now: number) => (cooldowns[id] === undefined || now >= cooldowns[id]);
  const cooldownSet = (id: string) => { cooldowns[id] = Date.now() + COOLDOWN_MIN * 60_000; };

  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(CUSTOM_TYPE, (message: { content?: unknown }) => {
      const content = typeof message?.content === "string" ? message.content : "";
      return {
        dispose: () => {},
        invalidate: () => {},
        render: () => {
          // The message body is the model-visible labelled block; the operator
          // gets a compact card parsed from it. Drawing the raw XML in a box
          // clipped the frame and buried the operator's prompt.
          const meta = parseContextBlock(String(content));
          if (!meta) return renderCardBox(String(content)).split("\n");
          return formatSuggestionCard({
            verb: {
              id: "skill_suggest",
              // CORE-2361: header states the target — /skill:<name> for a
              // skill, the doc id for a nested reference.
              action:
                meta.kind === "agent-settlement"
                  ? "result settled"
                  : meta.level === "reference"
                    ? `reference to read · ${meta.source ?? "—"}`
                    : `consider loading /skill:${meta.skill ?? meta.source ?? "—"}`,
              oneLine: meta.body ?? "",
              instruction: () => "",
              severity: "normal",
              cooldownMin: COOLDOWN_MIN,
              source: "jev",
            },
            ref: "—",
            confidence: meta.confidence,
            compact: true,
          })
            .split("\n");
        },
      };
    });
  }

  const handler = async (event: { text?: string }, ctx?: { modelRegistry?: unknown; sessionManager?: unknown }) => {
    latestCtx = ctx;
    if (off()) return { action: "continue" } as const;
    const prompt = typeof event?.text === "string" ? event.text : "";
    if (prompt.startsWith("/")) return { action: "continue" } as const; // commands decide for themselves
    if (isControlNudge(prompt)) return { action: "continue" } as const; // "continue" carries no task signal
    if (prompt.trim().length < 12) return { action: "continue" } as const;

    const registry = ((ctx as unknown as { modelRegistry?: RegistryLike } | undefined)?.modelRegistry ?? null);
    if (!registry && !readApiKey()) return { action: "continue" } as const;

    const roster = discoverRoster(process.cwd());
    if (roster.length === 0) return { action: "continue" } as const;

    try {
      const questions: Record<string, Question> = {
        skill: {
          type: "choice",
          instructions:
            "Pick the single skill or reference document a careful expert would follow for this request, or none. Base it only on the request and the provided descriptions.",
          criteria: Object.fromEntries([
            ...roster.map((r) => [r.id, r.description]),
            ["none", "No documented procedure adds value; general expertise suffices."],
          ]),
        },
        would_follow_documented_procedure: {
          type: "noul",
          instructions: "Would a careful expert consult a specific documented procedure or set of commands here, rather than answer from general understanding?",
        },
        prose_suffices: {
          type: "noul",
          instructions: "Could a knowledgeable generalist fully satisfy this request in prose, with no tools and no access to the user's files? (Counts against suggesting.)",
        },
        asks_about_the_tooling: {
          type: "noul",
          instructions: "Is the request a question ABOUT this assistant, its extensions, its skills, prompts, cards or output — i.e. meta/tooling talk rather than a task that doctrine should govern? (Counts against suggesting.)",
        },
      };
      const state = {
        request: prompt.slice(0, 2000),
        recent_conversation: recentContext(prompt),
        cwd: process.cwd(),
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), INJECT_TIMEOUT_MS);
      let result: Awaited<ReturnType<typeof classifyViaRegistry>> = null;
      try {
        result = (await Promise.race([
          (async () => {
            let r = registry ? await classifyViaRegistry(registry, state, questions) : null;
            if (!r) r = await systemOne(state, questions);
            return r;
          })(),
          new Promise<null>((resolve) => { controller.signal.addEventListener("abort", () => resolve(null)); }),
        ]));
      } finally {
        clearTimeout(timer);
      }
      if (!result) return { action: "continue" } as const;

      const pick = result.choice.choice;
      const entry = roster.find((r) => r.id === pick);
      const verdict = evaluateGate({
        nouls: result.nouls,
        confidence: result.choice.confidence,
        noneConfidence: result.choice.probabilities?.["none"] ?? null,
        hasEntry: Boolean(entry),
      });
      const gateMean = verdict.gateMean;
      // Log every evaluation — negatives are the tuning signal. An ABSTAIN is
      // recorded distinctly from a genuine `none` answer: collapsing the two
      // reintroduces this defect in a new shape, because both would otherwise
      // read as "the classifier considered and declined".
      const noneConfidence = result.choice.probabilities?.["none"] ?? null;
      logDecision({
        ts: new Date().toISOString(),
        seam: "input",
        pick: pick ?? "none",
        outcome: verdict.fire ? "fire" : "abstain",
        reason: verdict.reason,
        gate: Number(gateMean.toFixed(3)),
        confidence: result.choice.confidence,
        noneConfidence,
        injected: verdict.fire,
        prompt_chars: prompt.length,
      });
      if (!verdict.fire || !entry) return { action: "continue" } as const;

      // One card per prompt, per catalog id.
      if (!cooldownOk(entry.id, Date.now())) return { action: "continue" } as const;
      cooldownSet(entry.id);

      const block = doctrineBlock(entry, `the current request`, result.choice.confidence, result.model);

      // Decide here (the prompt is the signal), deliver at the first ordered
      // boundary inside the turn. The prompt is never mutated: a transform
      // echoes into the operator's input line, and sendMessage here races the
      // in-flight turn ("Agent is already processing") and displaced the
      // operator's prompt outright.
      pending = { entry, block, confidence: result.choice.confidence };
      readWatch = { id: entry.id, path: entry.path, turnsLeft: READ_WINDOW_TURNS };
      lastSuggestedId = entry.id;
      logDecision({ ts: new Date().toISOString(), seam: "input", pick: entry.id, injected: true, delivery: "deferred-to-tool-result" });

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
    const e = event as { toolName?: string; args?: unknown };
    const path = readPathOf(String(e.toolName ?? ""), e.args);
    if (!path || !readWatch) return;
    const next = watchRead(readWatch, path, false);
    readWatch = next.watch;
    if (next.read) {
      logDecision({
        ts: new Date().toISOString(),
        seam: "read_after_suggest",
        pick: readWatch?.id ?? lastSuggestedId,
        outcome: "read",
        path,
      });
    }
  });

  // Delivery: the first tool_result of the turn is the first ordered point
  // inside the turn, and the card is a context-bearing custom message, so the
  // agent reads it. No inline copy: a block appended to tool output renders as
  // raw XML in the transcript — exactly what the operator should not wade
  // through.
  pi.on("tool_result", () => {
    if (!pending || off()) return undefined;
    // The table decides, so it is not a test-only spec: this seam asserts its
    // own row, and a change there stops delivery instead of drifting.
    if (deliverySeam({ prompted: true, pending: true, usedTool: true, activeTurn: true }) !== "tool_result") return undefined;
    const item = pending;
    pending = null;
    logDecision({ ts: new Date().toISOString(), seam: "tool_result", pick: item.entry.id, injected: true, confidence: item.confidence });
    pi.sendMessage(
      {
        customType: CUSTOM_TYPE,
        content: item.block,
        display: true,
        details: { skill: item.entry.id, level: item.entry.level, seam: "tool_result" },
      },
      { deliverAs: "followUp", triggerTurn: false },
    );
    return undefined;
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
  const runAgentEnd = async (event: unknown, ctx: unknown): Promise<void> => {
    try {
      if (off()) return;
      pending = null; // already flushed, or superseded by a fresh decision
      const messages = (event as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      const turn = turnEvidence(messages, messageCursor);
      messageCursor = turn.nextIdx;
      const { lastAssistant, wasActive } = turn;
      if (!lastAssistant || !wasActive) return;
      const registry = ((ctx as unknown as { modelRegistry?: RegistryLike } | undefined)?.modelRegistry ?? null);
      if (!registry && !readApiKey()) return;
      const roster = discoverRoster(process.cwd());
      if (roster.length === 0) return;

      const result = await askJev(registry, {
        agent_final_message: lastAssistant.slice(0, 1500),
        working_turn_excerpt: turn.excerpt.slice(0, 6000),
        edited_files: turn.editedFiles.slice(0, 8),
        turn_had_error: turn.errored,
      }, {
        skill: {
          type: "choice",
          instructions: "The agent just ended a working turn stating its intention. Pick the single skill or reference document its stated next step most needs, or none.",
          criteria: Object.fromEntries([
            ...roster.map((r) => [r.id, r.description]),
            ["none", "No documented procedure adds value to the stated next step."],
          ]),
        },
        would_follow_documented_procedure: { type: "noul", instructions: "For the stated next step, would a careful expert follow a specific documented procedure rather than improvise?" },
        prose_suffices: { type: "noul", instructions: "Is the stated next step purely mechanical or narrative, needing no doctrine? (Counts against suggesting.)" },
      } as Record<string, Question>);
      if (!result) return;
      const pick = result.choice.choice;
      const entry = roster.find((r) => r.id === pick);
      const verdict = evaluateGate({
        nouls: result.nouls,
        confidence: result.choice.confidence,
        noneConfidence: result.choice.probabilities?.["none"] ?? null,
        hasEntry: Boolean(entry),
      });
      if (!verdict.fire || !entry) {
        logDecision({
          ts: new Date().toISOString(),
          seam: "agent_end",
          pick: pick ?? "none",
          outcome: "abstain",
          reason: verdict.reason,
          gate: Number(verdict.gateMean.toFixed(3)),
          confidence: result.choice.confidence,
          noneConfidence: result.choice.probabilities?.["none"] ?? null,
        });
        return;
      }
      readWatch = { id: entry.id, path: entry.path, turnsLeft: READ_WINDOW_TURNS };
      lastSuggestedId = entry.id;
      if (!cooldownOk(entry.id, Date.now())) return;
      cooldownSet(entry.id);

      // CORE-2367: this block used to be built and DISCARDED, so the intention
      // seam showed the operator a card while sending the model nothing at all -
      // which is why "the agent never reads it" looked like disobedience rather
      // than the delivery that actually happened. Both audiences get it now.
      const block = doctrineBlock(entry, `your stated next step`, result.choice.confidence, result.model);
      logDecision({ ts: new Date().toISOString(), seam: "agent_end", pick: entry.id, injected: true, confidence: result.choice.confidence, gate: Number(verdict.gateMean.toFixed(3)) });
      // The renderer draws the card from the labelled block's fields, so the model
      // receives the doctrine and the operator still sees the house card.
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: block,
          display: true,
          details: { skill: entry.id, level: entry.level, seam: "agent_end" },
        },
        { deliverAs: "followUp", triggerTurn: false },
      );
    } catch {
      /* fail-open: a suggestion extension must never break a session */
    }
  };

  // Coverage: a turn with no tool call would otherwise drop what submit
  // decided, so agent_end flushes it before its own decision runs.
  pi.on("agent_end", async (event: unknown, ctx: unknown) => {
    if (pending && deliverySeam({ prompted: true, pending: true, usedTool: false, activeTurn: true }) === "agent_end_flush") {
      const item = pending;
      pending = null;
      logDecision({ ts: new Date().toISOString(), seam: "agent_end_flush", pick: item.entry.id, injected: true, confidence: item.confidence });
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: item.block,
          display: true,
          details: { skill: item.entry.id, level: item.entry.level, seam: "agent_end_flush" },
        },
        { deliverAs: "followUp", triggerTurn: false },
      );
    }
    return runAgentEnd(event, ctx);
  });

  // Reload the roster when packs change on disk (cheap: cache TTL governs).
  if (typeof pi.on === "function") {
    pi.on("session_start", () => resetRosterCache());
  }
}
