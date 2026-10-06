/**
 * Shared classifier + catalog foundation for suggestion extensions.
 *
 * This module is the single owner of the Jev classifier client and the
 * suggestion-card/catalog surface. Both substrate-suggest and skill-suggest
 * import from here; substrate-suggest's old jev.ts and catalog.ts are now
 * thin compatibility re-exports.
 *
 * Extracted from substrate-suggest as part of CORE-2345.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

// ═════════════════════════════════════════════════════════════════════════════
// Jev classifier surface
// ═════════════════════════════════════════════════════════════════════════════

export const DEFAULT_MODEL = "jev-latest";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 2500;

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

export interface JevChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | null;
}

export interface JevResult {
  choice: JevChoiceAnswer;
  nouls: Record<string, number>;
  model: string | null;
  usage: { input_tokens?: number; output_tokens?: number } | null;
  latencyMs: number;
}

export function readApiKey(): string | null {
  const env = process.env["TYPESAFE_API_KEY"];
  if (env && env.trim()) return env.trim();
  try {
    const raw = readFileSync(join(homedir(), ".secrets", "typesafe_api_key.txt"), "utf8").trim();
    // File holds TYPESAFE_API_KEY=<key> or a bare key.
    const value = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : raw;
    return value.trim() || null;
  } catch {
    return null;
  }
}

export interface ClassifierModelLike {
  provider: string;
  id: string;
}

export interface RegistryLike {
  getAvailableOfType(type: string, provider?: string): Promise<readonly unknown[]>;
  classify(
    model: unknown,
    context: { state: Record<string, unknown>; questions: Record<string, unknown> },
    options?: unknown,
  ): Promise<{
    answers?: Record<string, Record<string, unknown>>;
    stopReason?: string;
    errorMessage?: string;
    usage?: { input?: number; output?: number };
    model?: string;
  }>;
}

/** Jev candidates in preference order: paid jev first (better calibration), free fallback. */
export function pickClassifiers(models: readonly unknown[]): ClassifierModelLike[] {
  const jev = models.filter((m) => /jev/i.test(String((m as { id?: unknown })?.id ?? "")));
  jev.sort((a, b) => {
    const pa = String((a as { provider?: unknown })?.provider ?? "") === "typesafe" ? 0 : 1;
    const pb = String((b as { provider?: unknown })?.provider ?? "") === "typesafe" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    // Paid before free within the same provider: a 402 on the paid id
    // falls through to the free id; the reverse would silently cost nothing
    // but also calibrate worse.
    const fa = /free/i.test(String((a as { id?: unknown })?.id ?? "")) ? 1 : 0;
    const fb = /free/i.test(String((b as { id?: unknown })?.id ?? "")) ? 1 : 0;
    return fa - fb;
  });
  return jev as ClassifierModelLike[];
}

/** Pi-native path: the same credentials and gateways codemode uses. Never rejects. */
export async function classifyViaRegistry(
  registry: RegistryLike,
  state: Record<string, unknown>,
  questions: Record<string, Question>,
): Promise<JevResult | null> {
  try {
    const models = await registry.getAvailableOfType("classifier");
    const candidates = pickClassifiers(models);
    if (candidates.length === 0) return null;
    const mapped: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "choice") mapped[id] = { type: "choice", instructions: q.instructions, criteria: q.criteria };
      else
        mapped[id] = {
          type: "bool",
          instructions: q.instructions,
          criteria: { true: "The answer is yes.", false: "The answer is no." },
        };
    }
    let res: Awaited<ReturnType<RegistryLike["classify"]>> | null = null;
    let used: ClassifierModelLike | null = null;
    // First success wins; an errored candidate (e.g. 402 funds) falls
    // through to the next — the answer is never taken from a failed call.
    for (const candidate of candidates) {
      const attempt = await registry.classify(candidate, { state, questions: mapped });
      if (attempt && attempt.stopReason !== "error" && attempt.stopReason !== "aborted" && attempt.answers) {
        res = attempt;
        used = candidate;
        break;
      }
    }
    if (!res || !used) return null;
    const answers = res.answers;
    if (!answers) return null;
    const choiceRaw = Object.values(answers).find((a) => a?.["type"] === "choice");
    if (!choiceRaw) return null;
    const choice: JevChoiceAnswer = {
      choice: String(choiceRaw["choice"] ?? ""),
      probabilities: Object.fromEntries(
        Object.entries((choiceRaw["probabilities"] ?? {}) as Record<string, unknown>).map(([k, v]) => [k, toNumber(v)]),
      ),
      confidence: typeof choiceRaw["confidence"] === "number" ? choiceRaw["confidence"] : null,
    };
    if (!choice.choice) return null;
    const nouls: Record<string, number> = {};
    for (const [id, a] of Object.entries(answers)) {
      if (a?.["type"] === "bool") nouls[id] = toNumber(a["probability"]);
    }
    return {
      choice,
      nouls,
      model: res.model ?? `${used.provider}/${used.id}`,
      usage: res.usage ? { input_tokens: res.usage.input, output_tokens: res.usage.output } : null,
      latencyMs: 0,
    };
  } catch {
    return null;
  }
}

function toNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function parseAnswer(raw: unknown): { choice?: JevChoiceAnswer; noul?: number } {
  return parseAnswerPayload(raw);
}

/** Tolerant answer parser, exported for tests. Accepts number and boolean nouls. */
export function parseAnswerPayload(raw: unknown): { choice?: JevChoiceAnswer; noul?: number } {
  if (raw === null || typeof raw !== "object") return {};
  const a = raw as Record<string, unknown>;
  const type = a["type"];
  if (type === "noul" || (a["noul"] !== undefined && a["choice"] === undefined)) {
    return { noul: toNumber(a["noul"]) };
  }
  if (type === "choice" || a["choice"] !== undefined) {
    const probs =
      a["probabilities"] !== null && typeof a["probabilities"] === "object"
        ? Object.fromEntries(Object.entries(a["probabilities"] as Record<string, unknown>).map(([k, v]) => [k, toNumber(v)]))
        : {};
    return {
      choice: {
        choice: String(a["choice"] ?? ""),
        probabilities: probs,
        confidence: typeof a["confidence"] === "number" ? a["confidence"] : null,
      },
    };
  }
  return {};
}

export async function systemOne(
  state: Record<string, unknown>,
  questions: Record<string, Question>,
  opts: { apiKey?: string | null; model?: string; timeoutMs?: number } = {},
): Promise<JevResult | null> {
  const key = opts.apiKey !== undefined ? opts.apiKey : readApiKey();
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model ?? DEFAULT_MODEL, state, questions }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const answers = body["answers"];
    if (answers === null || typeof answers !== "object") return null;
    const parsed = Object.values(answers as Record<string, unknown>).map(parseAnswer);
    const choice = parsed.find((p) => p.choice)?.choice;
    if (!choice || !choice.choice) return null;
    const nouls: Record<string, number> = {};
    for (const [id, raw] of Object.entries(answers as Record<string, unknown>)) {
      const p = parseAnswer(raw);
      if (p.noul !== undefined) nouls[id] = p.noul;
    }
    const usage = (body["usage"] ?? null) as Record<string, unknown> | null;
    return {
      choice,
      nouls,
      model: typeof body["model"] === "string" ? body["model"] : null,
      usage: usage ? { input_tokens: Number(usage["input_tokens"]), output_tokens: Number(usage["output_tokens"]) } : null,
      latencyMs: Date.now() - started,
    };
  } catch {
    return null; // network, timeout, bad JSON — fail open
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded dir read so a missing/odd secrets dir never throws at import time. */
export function secretsDirOk(): boolean {
  try {
    readdirSync(join(homedir(), ".secrets"));
    return true;
  } catch {
    return false;
  }
}

/** Neutral question-dict builder, exported for tests (shape contract only). */
export function questionShape(type: "noul" | "choice", instructions: string, criteria?: Record<string, string>): Question {
  const q: Question = { type, instructions } as Question;
  if (criteria) (q as { criteria?: Record<string, string> }).criteria = criteria;
  return q;
}

// ═════════════════════════════════════════════════════════════════════════════
// Catalog / suggestion-card surface
// ═════════════════════════════════════════════════════════════════════════════

export type Severity = "high" | "normal";

export type VerbId =
  | "claim_renew"
  | "claim_start"
  | "attest_ready"
  | "close_due"
  | "revise_contract"
  | "checkpoint"
  | "journal_decision"
  | "journal_finding"
  | "journal_blocker"
  | "journal_milestone"
  | "journal_handoff"
  | "journal_result"
  // Duty sources beyond the sb surface (duties.ts, toolnudge.ts) share the
  // cooldown machinery.
  | "wait_guard"
  | "skill_suggest"
  | "tool_nudge"
  | "provenance_unread"
  // CORE-2361: the wider sb surface — sb help offers far more than the
  // journal kinds; surface the parts a working turn plausibly warrants.
  | "issue_note"
  | "defer_work"
  | "dep_relate"
  | "provenance_receipt"
  | "resume_capsule";

export interface VerbSpec {
  id: VerbId;
  /** The sb-facing action, e.g. "sb journal append · kind=decision". */
  action: string;
  /** One-line description — the only text a ranking model ever sees. */
  oneLine: string;
  /** Instruction line for the wake card. */
  instruction: (ref: string) => string;
  severity: Severity;
  /** Cooldown in minutes per (issue, verb) after one suggestion. */
  cooldownMin: number;
  /** How the verb is chosen: rule over durable state, or the Jev pick. */
  source: "deterministic" | "jev";
}

export const CATALOG: readonly VerbSpec[] = [
  {
    id: "claim_start",
    action: "sb issue claim",
    oneLine: "Active work on an unclaimed issue; claim it before continuing.",
    instruction: (ref) => `Claim before continuing: sb issue claim ${ref} --holder <holder>.`,
    severity: "high",
    cooldownMin: 15,
    source: "deterministic",
  },
  {
    id: "attest_ready",
    action: "sb issue attest",
    oneLine: "The draft contract must be attested ready before it can be claimed.",
    instruction: (ref) => `Attest readiness first: sb issue attest ${ref} --outcome ready --policy <policy> --attested-by <you>, then claim.`,
    severity: "normal",
    cooldownMin: 20,
    source: "deterministic",
  },
  {
    id: "claim_renew",
    action: "sb issue claim · renew",
    oneLine: "The live claim on this issue is about to expire; renew or release it.",
    instruction: (ref) => `Renew the claim you still hold: sb issue claim ${ref} --holder <holder>, or release it if the work ended.`,
    severity: "high",
    cooldownMin: 10,
    source: "deterministic",
  },
  {
    id: "close_due",
    action: "sb issue close",
    oneLine: "A bounded result was journaled and evidence exists; close the issue with cited refs.",
    instruction: (ref) => `Close with the evidence: sb issue close ${ref} --outcome completed --reason "…" --result <ref> --receipt <ref>.`,
    severity: "high",
    cooldownMin: 30,
    source: "deterministic",
  },
  {
    id: "revise_contract",
    action: "sb issue edit + attest",
    oneLine: "Work drifted from the attested contract revision; revise through planning and re-attest.",
    instruction: (ref) => `Stop and revise the contract: sb issue edit ${ref} (new revision), then attest readiness again before continuing.`,
    severity: "high",
    cooldownMin: 30,
    source: "deterministic",
  },
  {
    id: "checkpoint",
    action: "sb journal checkpoint",
    oneLine: "Enough uncheckpointed journal activity has accumulated; write a resumability boundary.",
    instruction: (ref) => `Checkpoint now: sb journal checkpoint ${ref} — mechanical state commits before any summarizer runs.`,
    severity: "normal",
    cooldownMin: 20,
    source: "deterministic",
  },
  {
    id: "journal_decision",
    action: "sb journal append · kind=decision",
    oneLine: "A course was chosen with rationale; record it as a decision.",
    instruction: (ref) => `Append the decision: substrate_journal_append ${ref} kind=decision with the chosen course and rationale.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev",
  },
  {
    id: "journal_finding",
    action: "sb journal append · kind=finding",
    oneLine: "A material discovered fact appeared; record it as a finding.",
    instruction: (ref) => `Append the finding: substrate_journal_append ${ref} kind=finding with the discovered fact.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev",
  },
  {
    id: "journal_blocker",
    action: "sb journal append · kind=blocker",
    oneLine: "An unresolved condition is preventing progress; record it as a blocker.",
    instruction: (ref) => `Append the blocker: substrate_journal_append ${ref} kind=blocker, then relate it if it blocks another issue.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev",
  },
  {
    id: "journal_milestone",
    action: "sb journal append · kind=milestone",
    oneLine: "A meaningful execution boundary was reached; record it as a milestone.",
    instruction: (ref) => `Append the milestone: substrate_journal_append ${ref} kind=milestone naming the boundary reached.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev",
  },
  {
    id: "journal_handoff",
    action: "sb journal append · kind=handoff",
    oneLine: "Work is being handed to another participant; record bounded continuation state.",
    instruction: (ref) => `Append the handoff: substrate_journal_append ${ref} kind=handoff with the continuation state the next worker needs.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev",
  },
  {
    id: "journal_result",
    action: "sb journal append · kind=result",
    oneLine: "A bounded settlement was produced; record it as a result, not a progress note.",
    instruction: (ref) => `Append the bounded result: substrate_journal_append ${ref} kind=result with summary/outcome and artifact refs.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev",
  },
  {
    id: "issue_note",
    action: "sb issue note",
    oneLine: "A bounded clarification about the contract surfaced; record it as a note.",
    instruction: (ref) => `Record the note: sb issue note ${ref} "<clarification>" — notes are continuity, never contract changes.`,
    severity: "normal",
    cooldownMin: 20,
    source: "jev",
  },
  {
    id: "defer_work",
    action: "sb issue defer",
    oneLine: "Work should pause past this cycle; defer the issue with a reason.",
    instruction: (ref) => `Defer deliberately: sb issue defer ${ref} --reason "<why>" — a deferred issue leaves the ready pool cleanly.`,
    severity: "normal",
    cooldownMin: 30,
    source: "jev",
  },
  {
    id: "dep_relate",
    action: "sb issue relate",
    oneLine: "A dependency or relation between issues surfaced; link them so the board knows.",
    instruction: (ref) => `Relate the issues: sb issue relate ${ref} <other> — dependency-aware scheduling needs the edge.`,
    severity: "normal",
    cooldownMin: 30,
    source: "jev",
  },
  {
    id: "provenance_receipt",
    action: "sb provenance receipt",
    oneLine: "External evidence arrived (CI run, published artifact, review); bind a receipt.",
    instruction: (ref) => `Bind the evidence: sb provenance receipt ${ref} --kind <kind> --ref <external ref> — closure cites receipts.`,
    severity: "normal",
    cooldownMin: 30,
    source: "jev",
  },
  {
    id: "resume_capsule",
    action: "sb issue resume",
    oneLine: "Continuing earlier work; read the Resume Capsule, not the compacted transcript.",
    instruction: (ref) => `Resume properly: sb issue resume ${ref} — revision + checkpoint + Journal delta + claim state, the durable state.`,
    severity: "normal",
    cooldownMin: 20,
    source: "jev",
  },
];

export const VERB_BY_ID: ReadonlyMap<VerbId, VerbSpec> = new Map(CATALOG.map((v) => [v.id, v]));

/** The Jev-rankable roster: id + one-line description, nothing else. */
export function jevRoster(): Array<{ id: VerbId; oneLine: string }> {
  return CATALOG.filter((v) => v.source === "jev").map(({ id, oneLine }) => ({ id, oneLine }));
}

// ── Deterministic trigger inputs (a snapshot of durable state) ──────────────

export interface StateSnapshot {
  now: number;
  /** Bound issue ref (SUBSTRATE_ISSUE_REF or live-claim lookup); null = idle. */
  ref: string | null;
  lifecycleState: string | null;
  /** null when no live claim. */
  claim: { holder: string; expiresAt: number } | null;
  /** Lifecycle != terminal, but the current revision is not dispatchable. */
  readinessState: string | null;
  /** Sequence of the latest checkpoint/compaction entry; 0 when none. */
  lastCheckpointSeq: number;
  /** Current highest journal sequence; 0 when empty. */
  journalSeq: number;
  /** Kind of the newest journal entry, when one exists. */
  latestKind: string | null;
  /** This turn mutated files or ran commands. */
  turnWasActive: boolean;
}

export const TERMINAL_LIFECYCLE = new Set(["done", "cancelled", "archived"]);

/** Tunables — the mod's thresholds, adapted. */
export const TUNING = {
  claimExpiryWindowMs: 5 * 60 * 1000,
  entriesSinceCheckpoint: 8,
  checkpointAgeMs: 20 * 60 * 1000,
} as const;

export type Cooldowns = Record<string, number>; // `${issueId}:${verbId}` -> ms epoch when reusable

export function cooldownKey(ref: string, id: VerbId): string {
  return `${ref}:${id}`;
}

/**
 * Pure deterministic evaluation. Returns the single due verb, or null.
 * Deterministic rules outrank the Jev stage; when only the semantic
 * category remains, returns { kind: "semantic" } so the caller can run
 * the Jev pick. Order matters — first match wins.
 */
export function evaluateDeterministic(s: StateSnapshot, cooldowns: Cooldowns): VerbId | { kind: "semantic" } | null {
  if (!s.ref || !s.lifecycleState || TERMINAL_LIFECYCLE.has(s.lifecycleState)) return null;

  // Idle turns never nudge: suggestions ride real work.
  if (!s.turnWasActive) return null;

  // CORE-2361: unclaimed work. Active work on a bound, non-terminal issue
  // with no live claim draws a claim suggestion (or an attest suggestion
  // when the contract revision is still draft — claiming a draft is not
  // possible). Other non-dispatchable readiness (blocked etc.) stays silent:
  // the claim cannot be taken and the contract is fine.
  if (!s.claim) {
    if (s.readinessState === "draft") return "attest_ready";
    if (s.readinessState == null) return "claim_start";
    return null;
  }

  if (s.claim.expiresAt - s.now < TUNING.claimExpiryWindowMs) return "claim_renew";

  if (s.claim && s.latestKind === "result") return "close_due";

  // Drift = work under a claim on a contract that was never attested ready
  // for this revision. A healthy claimed READY issue shows state "claimed"
  // (derived view), and "blocked" is blockers, not drift.
  if (s.claim && s.readinessState === "draft") return "revise_contract";

  const sinceCp = s.journalSeq - s.lastCheckpointSeq;
  if (s.claim && (sinceCp >= TUNING.entriesSinceCheckpoint || (s.lastCheckpointSeq === 0 && s.journalSeq > 0))) {
    return "checkpoint";
  }

  // Uncheckpointed-but-under-threshold activity with edits and no journal
  // movement this session: a semantic journal-kind pick is warranted.
  if (s.claim && s.turnWasActive) return { kind: "semantic" };
  return null;
}

export function cooldownAllows(cd: Cooldowns, ref: string, id: VerbId, now: number, spec: VerbSpec): boolean {
  const until = cd[cooldownKey(ref, id)];
  return until === undefined || now >= until;
}

export function applyCooldown(cd: Cooldowns, ref: string, spec: VerbSpec): void {
  cd[cooldownKey(ref, spec.id)] = Date.now() + spec.cooldownMin * 60 * 1000;
}

/** All cooldowns reset on compaction or a claim-holder change. */
export function resetCooldowns(cd: Cooldowns): void {
  for (const k of Object.keys(cd)) delete cd[k];
}

// ── Wake-card chrome: purple dot on a tool row, indented gold block ─────────

const PURPLE = "\x1b[38;2;141;127;232m";
/** Header-band accents per suggester (operator directive, CORE-2348). */
export const SKILL_ACCENT = [0, 103, 188] as const; // 0067BC blue
/** Header-band accents per suggester (operator directive, CORE-2348). */
export const SUBSTRATE_ACCENT = [255, 112, 52] as const; // FF7034 bright orange
export type CardAccent = readonly [number, number, number];
const FG = [24, 20, 16] as const;
const bandOn = (bg: CardAccent) => `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m\x1b[38;2;${FG[0]};${FG[1]};${FG[2]}m`;
const BAND_OFF = "\x1b[49m\x1b[39m";
const DOT = "\x1b[1m●\x1b[22m"; // white, out of the gold block
const WARN = "\x1b[33m!\x1b[0m";
const WHITE = (t: string) => `\x1b[37m${t}\x1b[39m`;
const DIM = (t: string) => `\x1b[2m${t}\x1b[22m`;
const INDENT = "  ";
const CARD_MIN = 44;
const CARD_MAX = 88;
const CONF_LABEL = "jev_confidence";

const stripAnsi = (v: string) => v.replace(/\x1b\[[0-9;]*m/g, "");

/** Accent background, dark foreground. Used for the header band only. */
function paint(text: string, bold = false, bg: CardAccent = SUBSTRATE_ACCENT): string {
  return `${bandOn(bg)}${bold ? "\x1b[1m" : ""}${text}${bold ? "\x1b[22m" : ""}${BAND_OFF}`;
}

/** Body text: italic on the normal background — no gold, no box. */
function italic(text: string): string {
  return `\x1b[3m${text}\x1b[23m`;
}

interface Row {
  plain: string;
  ansi: string;
}

/** Wrap plain text to the interior width. */
function wrapPlain(plain: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of plain.split(" ")) {
    if ((cur + " " + w).trim().length > max) {
      out.push(cur.trim());
      cur = w;
    } else cur += " " + w;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [""];
}

/**
 * A dot, then the header on an accent band with a dark bold foreground, then the
 * body italic on the normal background. Only the header text carries the band —
 * the dot and everything below it stay unbanded.
 */
function goldCard(glyph: string, header: string, rows: string[], facts: string | null, bg: CardAccent = SUBSTRATE_ACCENT): string {
  const head = paint(header, true, bg);
  const lines = rows.map((r, i) => {
    const last = i === rows.length - 1;
    const tail = last && facts ? `  ${DIM(facts)}` : "";
    return `${INDENT}${italic(r)}${tail}`;
  });
  return [`${glyph} ${head}`, ...lines].join("\n");
}

/** Fields an operator card needs from a labelled <xtrm_context> block. */
export interface ContextBlockMeta {
  kind: string | null;
  source: string | null;
  /** The loadable skill command target (CORE-2361): /skill:<name>. */
  skill: string | null;
  /** "skill" | "reference" — what the reader should do with the block. */
  level: string | null;
  about: string | null;
  model: string | null;
  confidence: number | null;
  body: string | null;
}

const ATTR_RE = /(\w+)="([^"]*)"/g;

/** Parse a labelled context block; null when the content is not one. */
export function parseContextBlock(content: string): ContextBlockMeta | null {
  const open = /^<xtrm_context\b([^>]*)>/.exec(content.trim());
  if (!open) return null;
  const meta: ContextBlockMeta = { kind: null, source: null, skill: null, level: null, about: null, model: null, confidence: null, body: null };
  for (const m of open[1].matchAll(ATTR_RE)) {
    if (m[1] === "kind") meta.kind = m[2];
    else if (m[1] === "source") meta.source = m[2];
    else if (m[1] === "skill") meta.skill = m[2];
    else if (m[1] === "level") meta.level = m[2];
    else if (m[1] === "about") meta.about = m[2];
    else if (m[1] === "by") meta.model = m[2];
    else if (m[1] === "confidence") meta.confidence = Number.isFinite(Number(m[2])) ? Number(m[2]) : null;
  }
  const body = content.replace(/^<xtrm_context[^>]*>\n?/, "").replace(/<\/xtrm_context>\s*$/, "");
  const lines = body.split("\n").map((l) => l.trim());
  // The description rides last, in italics. That is the reader-facing summary;
  // the lines above it are model-facing instructions.
  const described = lines.map((l) => /^\x1b\[3m(.+)\x1b\[23m$/.exec(l)?.[1]).find(Boolean);
  const first = lines.find((l) => l.length > 0 && l !== "Injected context, not the operator's words:" && !/^\x1b\[3m/.test(l));
  meta.body = described ?? first ?? null;
  return meta;
}

/**
 * Every block injected into an operator prompt carries its provenance, so
 * injected doctrine, prior-agent output and the operator's own words never
 * blur together. One convention for all injection sources.
 */
export function contextBlock(
  kind: "skill-doctrine" | "agent-settlement" | string,
  meta: { about?: string; source?: string; model?: string; confidence?: number | null; skill?: string; level?: string; body: string },
): string {
  const attrs = [
    `kind="${kind}"`,
    meta.source ? `source="${meta.source}"` : null,
    meta.skill ? `skill="${meta.skill}"` : null,
    meta.level ? `level="${meta.level}"` : null,
    meta.about ? `about="${meta.about}"` : null,
    meta.model ? `by="${meta.model}"` : null,
    meta.confidence != null ? `confidence="${meta.confidence.toFixed(2)}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return [
    `<xtrm_context ${attrs}>`,
    `Injected context, not the operator's words:`,
    meta.body,
    `</xtrm_context>`,
  ].join("\n");
}

export interface SuggestionCard {
  verb: VerbSpec;
  ref: string;
  /** Deterministic rules carry no confidence; Jev picks do. */
  confidence?: number | null;
  revision?: number | null;
  /** FYI card: one row, no instruction body. Duties stay two rows. */
  compact?: boolean;
}

/** Trailing period stripped: descriptions end sentences, the facts trailer must not stutter. */
export function stripEndPeriod(s: string): string {
  return s.replace(/\.+$/, "");
}

export function formatSuggestionCard(c: SuggestionCard, accent: CardAccent = SUBSTRATE_ACCENT): string {
  const glyph = c.verb.severity === "high" ? WARN : DOT;
  const header = `${c.verb.action} · ${c.ref}`;
  const parts = [
    c.confidence != null ? `${CONF_LABEL}: ${c.confidence.toFixed(2)}` : null,
    c.revision != null ? `rev ${c.revision}` : null,
  ].filter(Boolean);
  const facts = parts.length ? parts.join(" · ") : null;

  if (c.compact) {
    // FYI: one accent row carrying the summary, nothing more.
    return goldCard(glyph, header, wrapPlain(stripEndPeriod(c.verb.oneLine || c.verb.action), CARD_MAX), facts, accent);
  }
  const instr = `${c.verb.instruction(c.ref).replace(/[.]?$/, "")}. Ignore this if it does not fit what actually happened.`;
  // Reserve the facts room before wrapping so the last row never overruns.
  const factsLen = facts ? [...facts].length + 2 : 0;
  return goldCard(glyph, header, wrapPlain(instr, Math.max(CARD_MIN, CARD_MAX - factsLen)), facts, accent);
}

/** Render arbitrary message content in the house style (renderer fallback). */
export function renderCardBox(content: string, accent: CardAccent = SUBSTRATE_ACCENT): string {
  const [first, ...rest] = content.split("\n");
  const header = first.startsWith("<") ? "context" : first;
  const body = rest.length ? rest.join(" ") : content;
  return goldCard(DOT, header, wrapPlain(body, CARD_MAX), null, accent);
}

/** Model-visible plain text (what lands in the transcript strip/exports). */
export function formatSuggestionPlain(c: SuggestionCard): string {
  return stripAnsi(formatSuggestionCard(c));
}
