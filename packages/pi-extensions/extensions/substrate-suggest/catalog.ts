/**
 * substrate-suggest catalog: the sb verb surface as suggestion candidates,
 * plus the pure trigger/cooldown/format logic. No Pi imports, no I/O —
 * everything here is unit-testable and shared with the Jev stage.
 *
 * Modeled on the Jev skill-suggestion pattern: one bounded catalog with
 * one-line descriptions, deterministic gating before any model call, at
 * most one suggestion per turn, ignore-if-not-fits phrasing.
 */

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
/** Full yellow, deliberately not brilliant: reads as a signal, not a highlighter. */
const BG = [201, 162, 39] as const;
const FG = [24, 20, 16] as const;
const YELLOW_ON = `\x1b[48;2;${BG[0]};${BG[1]};${BG[2]}m\x1b[38;2;${FG[0]};${FG[1]};${FG[2]}m`;
const YELLOW_OFF = "\x1b[49m\x1b[39m";
const DOT = "\x1b[1m●\x1b[22m"; // white, out of the gold block
const WARN = "\x1b[33m!\x1b[0m";
const WHITE = (t: string) => `\x1b[37m${t}\x1b[39m`;
const DIM = (t: string) => `\x1b[2m${t}\x1b[22m`;
const INDENT = "  ";
const CARD_MIN = 44;
const CARD_MAX = 88;
const CONF_LABEL = "jev_confidence";

const stripAnsi = (v: string) => v.replace(/\x1b\[[0-9;]*m/g, "");

/** Gold background, dark foreground. Used for the header band only. */
function paint(text: string, bold = false): string {
  return `${YELLOW_ON}${bold ? "\x1b[1m" : ""}${text}${bold ? "\x1b[22m" : ""}${YELLOW_OFF}`;
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
 * A dot, then the header on a gold band with a dark bold foreground, then the
 * body italic on the normal background. Only the header text carries the gold —
 * the dot and everything below it stay unbanded.
 */
function goldCard(glyph: string, header: string, rows: string[], facts: string | null): string {
  const head = paint(header, true);
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

export function formatSuggestionCard(c: SuggestionCard): string {
  const glyph = c.verb.severity === "high" ? WARN : DOT;
  // CORE-2367: a missing ref must not leave a dangling separator or the `· —`
  // placeholder. Every skill and service card passes ref "—"; the header simply
  // carries nothing when there is nothing to carry.
  const header = c.ref && c.ref !== "—" ? `${c.verb.action} · ${c.ref}` : c.verb.action;
  const parts = [
    c.confidence != null ? `${CONF_LABEL}: ${c.confidence.toFixed(2)}` : null,
    c.revision != null ? `rev ${c.revision}` : null,
  ].filter(Boolean);
  const facts = parts.length ? parts.join(" · ") : null;

  if (c.compact) {
    // FYI: one gold row carrying the summary, nothing more.
    return goldCard(glyph, header, wrapPlain(c.verb.oneLine || c.verb.action, CARD_MAX), facts);
  }
  const instr = `${c.verb.instruction(c.ref).replace(/[.]?$/, "")}. Ignore this if it does not fit what actually happened.`;
  // Reserve the facts room before wrapping so the last row never overruns.
  const factsLen = facts ? [...facts].length + 2 : 0;
  return goldCard(glyph, header, wrapPlain(instr, Math.max(CARD_MIN, CARD_MAX - factsLen)), facts);
}

/** Render arbitrary message content in the house style (renderer fallback). */
export function renderCardBox(content: string): string {
  const [first, ...rest] = content.split("\n");
  const header = first.startsWith("<") ? "context" : first;
  const body = rest.length ? rest.join(" ") : content;
  return goldCard(DOT, header, wrapPlain(body, CARD_MAX), null);
}

/** Model-visible plain text (what lands in the transcript strip/exports). */
export function formatSuggestionPlain(c: SuggestionCard): string {
  return stripAnsi(formatSuggestionCard(c));
}
