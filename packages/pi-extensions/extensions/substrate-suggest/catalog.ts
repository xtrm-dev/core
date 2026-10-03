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
  | "provenance_unread";

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

  if (s.claim && s.claim.expiresAt - s.now < TUNING.claimExpiryWindowMs) return "claim_renew";

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

// ── Wake-card chrome (no rail; a colored dot glyph + two plain lines) ───────

const DOT = "\x1b[38;2;141;127;232m●\x1b[0m"; // the rail's purple, as a glyph
const DIM = (t: string) => `\x1b[2m${t}\x1b[22m`;
const BOLD = (t: string) => `\x1b[1m${t}\x1b[22m`;
const ITALIC_DIM = (t: string) => `\x1b[2m\x1b[3m${t}\x1b[23m\x1b[22m`;
const WARN = (t: string) => `\x1b[33m${t}\x1b[0m`;

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export interface SuggestionCard {
  verb: VerbSpec;
  ref: string;
  /** Deterministic rules carry no confidence; Jev picks do. */
  confidence?: number | null;
  revision?: number | null;
}

export function formatSuggestionCard(c: SuggestionCard): string {
  const glyph = c.verb.severity === "high" ? WARN("!") : DOT;
  const header = [`${glyph} ${BOLD(c.verb.action)}`, DIM(c.ref)].join(` ${DIM("·")} `);
  const facts = [
    c.confidence != null ? DIM(`jev ${c.confidence.toFixed(2)}`) : null,
    c.revision != null ? DIM(`rev ${c.revision}`) : null,
  ]
    .filter(Boolean)
    .join(` ${DIM("·")} `);
  const instr = `${ITALIC_DIM(c.verb.instruction(c.ref))} Ignore this if it does not fit what actually happened.`;
  const tail = facts ? ` ${DIM("·")} ${facts}` : "";
  return [header, `${instr}${tail}`].join("\n");
}

/** Model-visible plain text (what lands in the transcript strip/exports). */
export function formatSuggestionPlain(c: SuggestionCard): string {
  return stripAnsi(formatSuggestionCard(c));
}
