/**
 * substrate-suggest — Jev-gated "what to update and when" suggestions for
 * Substrate, as a Pi extension.
 *
 * Pattern credit: the Jev skill-suggestion mod (aitmpl productivity/
 * jev-skill-suggestion). Instead of ranking installed skills per prompt,
 * this extension ranks the sb verb surface (see catalog.ts) against what
 * just happened, and delivers at most ONE suggestion per agent turn as a
 * specialists-style railed wake card:
 *
 *   │ ◆ sb journal append · CORE-2295 · kind=decision
 *   │ Record the course you just chose: … Ignore this if it does not fit. · jev 0.72
 *
 * Binding is fully in-session and automatic — the operator never exports
 * SUBSTRATE_ISSUE_REF. The bound issue resolves, in order:
 *   1. a claim this session observed (substrate_issue_claim tool call,
 *      `sb issue claim <ref>` bash, or specialist_dispatch issue_ref);
 *   2. the most recent issue ref the session touched through any
 *      substrate_* tool, specialist tool, or `sb … <REF>` command;
 *   3. the unique live claim in the checkout's bound Substrate project
 *      (discoverRepository → repository binding → claim scan, 60s cached;
 *      a live claim is current by TTL definition);
 *   4. SUBSTRATE_ISSUE_REF / SUBSTRATE_ISSUE env (compat only).
 *
 * Lightness contract (the "absolute best way"):
 *   - Zero work on the keystroke/prompt path. One fire-and-forget async
 *     decision at agent_end, after the reply is already rendered.
 *   - Deterministic gate first: point reads over in-process Substrate
 *     services (SQLite WAL). Most turns cost zero model calls.
 *   - Jev runs ONLY for the semantic journal-kind pick, on the turn delta
 *     (bounded excerpt), Pi's native classifier API first (credentials are
 *     Pi's own — auth.json providers, e.g. opencode zen jev), direct REST
 *     second, 2.5s abort; any failure degrades to deterministic-only.
 *     Fail-open everywhere — a suggestion extension must never break a
 *     session.
 *   - Cooldowns per (issue, verb); reset on compaction or claim change.
 *
 * Authority contract: suggestions are advisory text only. The claim gate
 * (owned by @jaggerxtrm/substrate) stays the only blocking authority.
 * Jev never authorizes CLAIM/CLOSE/DELETE — deterministic rules decide
 * those verbs, and even then the card only suggests the command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  VERB_BY_ID,
  evaluateDeterministic,
  cooldownAllows,
  applyCooldown,
  resetCooldowns,
  jevRoster,
  formatSuggestionCard,
  TERMINAL_LIFECYCLE,
  type Cooldowns,
  type StateSnapshot,
  type VerbId,
  type VerbSpec,
} from "./catalog.ts";
import { systemOne, classifyViaRegistry, readApiKey, type Question, type RegistryLike } from "./jev.ts";
import {
  discoverSkillPacks,
  isMonitorSetter,
  skillVerb,
  territoryHit,
  waitCommitment,
  waitGuardVerb,
  type SkillEntry,
} from "./duties.ts";
import { evaluateToolNudge, newCounters, observeTool, type ToolCounters } from "./toolnudge.ts";

const CUSTOM_TYPE = "substrate_suggestion";
const LOG_DIR = join(homedir(), ".xtrm", "substrate-suggest");
const LOG_FILE = join(LOG_DIR, "log.jsonl");

const GATE_THRESHOLD = 0.3; // mean of gate nouls under this -> nothing
const FITS_THRESHOLD = 0.3; // best verify noul under this -> drop the pick
const CLAIM_SCAN_TTL_MS = 60_000;

/** Source-level dedupe for skill suggestions: any card silences the source for a while. */
const SKILL_SOURCE_VERB: VerbSpec = {
  id: "skill_suggest",
  action: "consider skill",
  oneLine: "A service-knowledge expert skill fits the working turn.",
  instruction: () => "",
  severity: "normal",
  cooldownMin: 15,
  source: "jev",
};

const REF_RE = /\b([A-Z][A-Z0-9]{1,15}-\d+)\b/;

/** Extract bounded turn evidence from finished agent messages. */
function turnEvidence(messages: Array<{ role?: string; content?: unknown }>, fromIdx: number): { excerpt: string; lastAssistant: string; wasActive: boolean; nextIdx: number } {
  const parts: string[] = [];
  let lastAssistant = "";
  let wasActive = false;
  let userText = 0;
  for (let i = fromIdx; i < messages.length; i++) {
    const m = messages[i];
    const content = Array.isArray(m?.content) ? (m!.content as Array<Record<string, unknown>>) : [];
    for (const p of content) {
      if (p?.["type"] === "text" && typeof p["text"] === "string") {
        const role = m?.role ?? "unknown";
        parts.push(`${role}: ${p["text"].slice(0, 2000)}`);
        if (role === "assistant") lastAssistant = p["text"];
        if (role === "user") userText++;
      }
      if (p?.["type"] === "tool_call") {
        const name = String(p["toolName"] ?? p["name"] ?? "");
        if (["edit", "write", "bash", "python", "structured_return"].includes(name)) wasActive = true;
      }
      if (p?.["type"] === "tool_result" && p["isError"] === true) wasActive = true;
    }
  }
  const excerpt = parts.join("\n").slice(0, 8000);
  return { excerpt, lastAssistant: lastAssistant.slice(0, 1500), wasActive: wasActive || userText > 0, nextIdx: messages.length };
}

/** Observe one tool call for issue references the session works on. */
function observeToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): { ref: string | null; isClaim: boolean } {
  const tool = String(name ?? "");
  const argRef = (k: string) => {
    const v = args?.[k];
    return typeof v === "string" && REF_RE.test(v) ? (v.match(REF_RE)?.[1] ?? null) : null;
  };
  if (tool === "substrate_issue_claim") return { ref: argRef("ref"), isClaim: true };
  if (tool.startsWith("substrate_")) return { ref: argRef("ref"), isClaim: false };
  if (tool === "specialist_dispatch") return { ref: argRef("issue_ref"), isClaim: true };
  if (tool === "bash") {
    const cmd = String(args?.["command"] ?? "");
    const m = cmd.match(/\bsb\s+(?:issue|journal|provenance)\s+\S+\s+([A-Z][A-Z0-9]{1,15}-\d+)/);
    const claim = /\bsb\s+issue\s+claim\s+([A-Z][A-Z0-9]{1,15}-\d+)/.exec(cmd);
    return { ref: claim?.[1] ?? m?.[1] ?? null, isClaim: claim !== null };
  }
  return { ref: null, isClaim: false };
}

/** `sb issue create` prints the new locator; capture it from the result text. */
function observeCreateResult(content: Array<Record<string, unknown>> | undefined): string | null {
  const text = (content ?? [])
    .filter((p) => p?.["type"] === "text" && typeof p["text"] === "string")
    .map((p) => p["text"] as string)
    .join("\n");
  return REF_RE.exec(text)?.[1] ?? null;
}

interface SubstrateServices {
  issues: {
    resolveRef(ref: string): { id: string };
    getIssue(id: string): { currentRevision: number; lifecycleState: string; humanRef: string };
    getActiveClaim(id: string): { holder: string; expiresAt: number; acquiredAt: number } | null;
    getReadiness(id: string): { state: string; dispatchable: boolean; reasons: string[] };
    listIssues(projectId: string): Array<{ id: string }>;
  };
  journal: {
    latestCheckpoint(id: string): { sequence: number } | null;
    latest(id: string, opts?: { kind?: string }): { sequence: number; kind: string } | null;
  };
  repos: {
    getBinding(repositoryKey: string): { projectId: string } | null;
  };
  discoverRepository(): { identity: { repositoryKey: string } } | null;
  close(): void;
}

async function openServices(): Promise<SubstrateServices | null> {
  try {
    const substrate = await import("@jaggerxtrm/substrate");
    const dbPath = process.env["SUBSTRATE_DB"] ?? join(homedir(), ".xtrm", "state.db");
    const db = substrate.openSubstrate(dbPath);
    const issues = new substrate.IssueService(db);
    const journal = new substrate.JournalService(db, issues);
    const repos = new substrate.RepositoryService(db);
    return {
      issues: issues as unknown as SubstrateServices["issues"],
      journal: journal as unknown as SubstrateServices["journal"],
      repos: repos as unknown as SubstrateServices["repos"],
      discoverRepository: () => {
        try {
          return substrate.discoverRepository();
        } catch {
          return null;
        }
      },
      close: () => db.close(),
    };
  } catch {
    return null; // substrate absent or DB unreadable -> stay silent
  }
}

function logDecision(row: Record<string, unknown>): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${JSON.stringify(row)}\n`);
  } catch {
    /* logging is best-effort, never load-bearing */
  }
}

/** Shared Jev runner: Pi-native classifier first, direct REST second. */
async function askJev(
  registry: RegistryLike | null,
  state: Record<string, unknown>,
  questions: Record<string, Question>,
) {
  let result = registry ? await classifyViaRegistry(registry, state, questions) : null;
  if (!result) result = await systemOne(state, questions);
  return result;
}

/** The Jev semantic stage: pick one journal kind for the turn, or none. */
async function jevPickKind(
  registry: RegistryLike | null,
  snapshot: StateSnapshot,
  excerpt: string,
): Promise<{ verbId: VerbId; confidence: number | null; model: string | null } | null> {
  const roster = jevRoster();
  const questions: Record<string, Question> = {
    journal_kind: {
      type: "choice",
      instructions:
        "Pick the single Substrate journal kind this working turn most warrants, or none. Base the decision only on the provided state.",
      criteria: Object.fromEntries([...roster.map((r) => [r.id, r.oneLine]), ["none", "No journal entry is warranted for this turn."]]),
    },
    material_event: {
      type: "noul",
      instructions: "Did this turn contain a material execution fact worth preserving across sessions (a choice, discovery, obstacle, boundary, handoff, or settlement), rather than ordinary progress that a checkpoint already covers?",
    },
    prose_would_suffice: {
      type: "noul",
      instructions: "Could this turn's content be safely forgotten once the transcript is compacted, with no future worker needing it? (Counts against suggesting.)",
    },
  };
  const state = {
    issue_ref: snapshot.ref,
    issue_lifecycle: snapshot.lifecycleState,
    latest_journal_kind: snapshot.latestKind,
    entries_since_checkpoint: snapshot.journalSeq - snapshot.lastCheckpointSeq,
    working_turn_excerpt: excerpt.slice(0, 8000),
  };
  // Pi-native classifier first (credentials already configured), REST second.
  const result = await askJev(registry, state, questions);
  if (!result) return null;

  const gate = [result.nouls["material_event"] ?? 0, 1 - (result.nouls["prose_would_suffice"] ?? 0)];
  const gateMean = gate.reduce((a, b) => a + b, 0) / gate.length;
  if (gateMean < GATE_THRESHOLD) return null;

  const pick = result.choice.choice;
  if (pick === "none" || !VERB_BY_ID.has(pick as VerbId)) return null;
  const fits = result.nouls["warrants_kind"];
  if (fits !== undefined && fits < FITS_THRESHOLD) return null;
  return { verbId: pick as VerbId, confidence: result.choice.confidence, model: result.model };
}

export default function substrateSuggestExtension(pi: ExtensionAPI): void {
  const off = () =>
    pi.getFlag("no-substrate-suggest") === true ||
    (process.env["SUBSTRATE_SUGGEST"] ?? "").toLowerCase() === "off";

  // One services handle for the life of the pi process (VALIDATION: mirrors
  // the specialists "one host" rule — never per-turn).
  let servicesPromise: Promise<SubstrateServices | null> | null = null;
  const getServices = () => (servicesPromise ??= openServices());

  const cooldowns: Cooldowns = {};
  let lastClaimHolder: string | null | undefined; // undefined = never seen
  let messageCursor = 0;

  // In-session binding state (auto; no env var required).
  let sessionClaimRef: string | null = null;
  let lastTouchedRef: string | null = null;
  let lastClaimScan = { at: 0, ref: null as string | null };
  let turnMonitorSet = false;
  const counters: ToolCounters = newCounters();

  // Card renderer: no [customType] label, no default card box — the two
  // plain lines ARE the card (dot glyph, no rail).
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(CUSTOM_TYPE, (message: { content?: unknown }) => {
      const content = typeof message?.content === "string" ? message.content : "";
      return {
        dispose: () => {},
        invalidate: () => {},
        render: () => String(content).split("\n"),
      };
    });
  }

  const emit = (verb: VerbSpec, ref: string, opts: { confidence?: number | null; revision?: number | null; source: string; model?: string | null }) => {
    const card = formatSuggestionCard({ verb, ref, confidence: opts.confidence, revision: opts.revision });
    applyCooldown(cooldowns, ref, verb);
    logDecision({
      ts: new Date().toISOString(),
      issue: ref,
      verb: verb.id,
      severity: verb.severity,
      source: opts.source,
      model: opts.model ?? null,
    });
    pi.sendMessage(
      { customType: CUSTOM_TYPE, content: card, display: true, details: { verb: verb.id, ref, severity: verb.severity } },
      // Wake the agent like specialists events do: every suggestion is
      // information for the model. Cooldowns plus self-extinguishing rules
      // (acting on the verb removes its trigger) bound the turn cost.
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  /** The unique live claim in the checkout's bound project (60s cached). */
  const scanForLiveClaim = (svc: SubstrateServices): string | null => {
    const now = Date.now();
    if (now - lastClaimScan.at < CLAIM_SCAN_TTL_MS) return lastClaimScan.ref;
    let found: string | null = null;
    try {
      const repo = svc.discoverRepository();
      const binding = repo ? svc.repos.getBinding(repo.identity.repositoryKey) : null;
      if (binding) {
        const envHolder = process.env["SUBSTRATE_HOLDER"]?.trim() || null;
        const live: Array<{ ref: string; holder: string; acquiredAt: number }> = [];
        for (const issue of svc.issues.listIssues(binding.projectId)) {
          const claim = svc.issues.getActiveClaim(issue.id);
          if (!claim || claim.expiresAt <= now) continue;
          const view = svc.issues.getIssue(issue.id);
          if (TERMINAL_LIFECYCLE.has(view.lifecycleState)) continue;
          live.push({ ref: view.humanRef, holder: claim.holder, acquiredAt: claim.acquiredAt });
        }
        const byHolder = envHolder ? live.filter((c) => c.holder === envHolder) : [];
        const pool = byHolder.length > 0 ? byHolder : live;
        if (pool.length === 1) found = pool[0].ref;
        else if (pool.length > 1) {
          // Ambiguy resolves to the most recently acquired claim: a live TTL
          // means someone renewed it latest.
          found = pool.reduce((a, b) => (b.acquiredAt > a.acquiredAt ? b : a)).ref;
        }
      }
    } catch {
      found = null;
    }
    lastClaimScan = { at: now, ref: found };
    return found;
  };

  /** Resolve the issue this session is working, fully automatically. */
  const resolveBoundRef = (svc: SubstrateServices): string | null => {
    const candidates = [sessionClaimRef, lastTouchedRef, scanForLiveClaim(svc), process.env["SUBSTRATE_ISSUE_REF"]?.trim() || null, process.env["SUBSTRATE_ISSUE"]?.trim() || null];
    for (const ref of candidates) {
      if (!ref) continue;
      try {
        const issue = svc.issues.resolveRef(ref);
        if (!TERMINAL_LIFECYCLE.has(svc.issues.getIssue(issue.id).lifecycleState)) return ref;
      } catch {
        /* unknown ref: try the next source */
      }
    }
    return null;
  };

  // Observe claims and issue refs as the session works — this is what makes
  // binding automatic: the agent claims/touches, the extension remembers.
  pi.on("tool_call", (event) => {
    try {
      const e = event as { toolName?: string; name?: string; args?: Record<string, unknown>; input?: Record<string, unknown> };
      const tool = String(e.toolName ?? e.name ?? "");
      try {
        observeTool(counters, tool, e.args, e.input);
      } catch {
        /* counters are best-effort */
      }
      if (isMonitorSetter(tool, e.args, e.input)) turnMonitorSet = true;
      const { ref, isClaim } = observeToolCall(tool, e.args ?? e.input);
      if (ref) {
        lastTouchedRef = ref;
        if (isClaim) sessionClaimRef = ref;
      }
    } catch {
      /* observation is best-effort */
    }
  });

  pi.on("tool_result", (event) => {
    try {
      const e = event as unknown as {
        input?: Record<string, unknown>;
        content?: Array<Record<string, unknown>>;
        structuredContent?: unknown;
      };
      const cmd = String(e.input?.["command"] ?? "");
      if (/\bsb\s+issue\s+create\b/.test(cmd)) {
        const ref = observeCreateResult(e.content);
        if (ref) {
          lastTouchedRef = ref;
          sessionClaimRef = ref; // the creator session works what it created
        }
        return;
      }
      // specialist_dispatch creates + claims its own Issue: its result carries
      // created_issue_ref. The dispatching session owns that work as surely as
      // a bash claim would — observe it, or in-session binding misses every
      // tool-dispatched activation.
      const dispatch = typeof e.input?.["specialist"] === "string" && (e.input?.["contract"] !== undefined || e.input?.["issue_ref"] !== undefined);
      if (dispatch) {
        const text = (e.content ?? [])
          .filter((p) => p?.["type"] === "text" && typeof p["text"] === "string")
          .map((p) => p["text"] as string)
          .join("\n");
        const ref = /"created_issue_ref"\s*:\s*"([A-Z][A-Z0-9]{1,15}-\d+)"/.exec(text)?.[1] ?? REF_RE.exec(text)?.[1] ?? null;
        if (ref) {
          lastTouchedRef = ref;
          sessionClaimRef = ref;
        }
      }
      // Mid-turn intervention, two layers — tool-nudge first (an inefficient
      // call is the strongest signal), then the service-territory pointer.
      if (!off()) {
        const nudge = evaluateToolNudge(counters, "", e.input ? { command: e.input["command"] } : undefined, e.input);
        if (nudge && cooldownAllows(cooldowns, "nudge", nudge.kind as unknown as VerbId, Date.now(), nudge.verb)) {
          applyCooldown(cooldowns, "nudge", nudge.verb);
          logDecision({ ts: new Date().toISOString(), issue: null, verb: `tool_nudge:${nudge.kind}`, source: "deterministic" });
          const content = [...(e.content ?? [])] as unknown as Array<{ type: string; text: string }>;
          content.push({ type: "text", text: `\x1b[2m[substrate-suggest] ${nudge.verb.instruction("")}\x1b[22m` });
          // The chat card keeps the operator in the loop in the house style;
          // display-only — the inline advisory already informed the agent.
          pi.sendMessage(
            { customType: CUSTOM_TYPE, content: formatSuggestionCard({ verb: nudge.verb, ref: "—" }), display: true, details: { verb: nudge.verb.id, nudge: nudge.kind } },
            { deliverAs: "followUp", triggerTurn: false },
          );
          return { content, structuredContent: e.structuredContent } as never;
        }
        const packs = discoverSkillPacks(process.cwd());
        const hit = packs.length > 0 ? territoryHit(packs, e.input, process.cwd()) : null;
        if (hit) {
          const verb = skillVerb(hit);
          // Per-service scoping: territory:${id} as the ref half of the cooldown key.
          if (cooldownAllows(cooldowns, `territory:${hit.id}`, verb.id, Date.now(), verb)) {
            applyCooldown(cooldowns, `territory:${hit.id}`, verb);
          logDecision({ ts: new Date().toISOString(), issue: null, verb: `skill_inline:${hit.id}`, source: "skill_inline" });
          const content = [...(e.content ?? [])] as unknown as Array<{ type: string; text: string }>;
          content.push({
            type: "text",
            text: `\x1b[2m[substrate-suggest] expert skill: ${hit.skillPath} — ${hit.name}${hit.container ? ` (container ${hit.container})` : ""}. Consider it before going deeper.\x1b[22m`,
          });
          return { content, structuredContent: e.structuredContent } as never;
        }
      }
    }
    } catch {
      /* observation is best-effort */
    }
  });

  pi.on("session_before_compact", () => {
    // Compaction resets the dedupe window, like the mod resets after /clear.
    resetCooldowns(cooldowns);
    messageCursor = 0;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (off()) return;
    const messages = (event as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      const { excerpt, lastAssistant, wasActive, nextIdx } = turnEvidence(messages, messageCursor);
    messageCursor = nextIdx;
    const monitorSet = turnMonitorSet;
    turnMonitorSet = false;

    // Duty 0 — wait-guard. Needs no bound issue and no substrate services:
    // a wait commitment without a monitor is a duty the moment it is spoken.
    if (lastAssistant && waitCommitment(lastAssistant) && !monitorSet) {
      const registry0 = ((ctx as unknown as { modelRegistry?: RegistryLike } | undefined)?.modelRegistry ?? null);
      if (registry0 || readApiKey()) {
        const verb = waitGuardVerb();
        if (cooldownAllows(cooldowns, "wait", verb.id, Date.now(), verb)) {
          const result = await askJev(registry0, {
            final_message: lastAssistant,
            monitor_set_this_turn: monitorSet,
          }, {
            wait_warranted: { type: "noul", instructions: "Is the agent's final message genuinely committing to WAIT for an external event (CI, deploy, review, another agent's reply, a long job) rather than actively working or merely narrating?" },
            monitor_would_help: { type: "noul", instructions: "Would a timer, monitor or durable reminder materially help here, instead of relying on the agent remembering?" },
          } as Record<string, Question>);
          const g = result ? ((result.nouls["wait_warranted"] ?? 0) + (result.nouls["monitor_would_help"] ?? 0)) / 2 : 0;
          if (result && g >= GATE_THRESHOLD) {
            emit(verb, "—", { confidence: result.choice.confidence ?? g, source: "jev", model: result.model });
            return;
          }
        }
      }
    }

    const svc = await getServices();
    if (!svc) return;
    try {
      const ref = resolveBoundRef(svc);
      if (!ref || !wasActive) return;
      const issue = svc.issues.resolveRef(ref);
      const meta = svc.issues.getIssue(issue.id);
      if (TERMINAL_LIFECYCLE.has(meta.lifecycleState)) return;

      const claim = svc.issues.getActiveClaim(issue.id);
      if (lastClaimHolder !== undefined && (claim?.holder ?? null) !== lastClaimHolder) resetCooldowns(cooldowns);
      lastClaimHolder = claim?.holder ?? null;

      const checkpoint = svc.journal.latestCheckpoint(issue.id);
      const latest = svc.journal.latest(issue.id);
      let readinessState: string | null = null;
      const readiness = svc.issues.getReadiness(issue.id);
      if (!readiness.dispatchable) readinessState = readiness.state;

      const snapshot: StateSnapshot = {
        now: Date.now(),
        ref: meta.humanRef ?? ref,
        lifecycleState: meta.lifecycleState,
        claim: claim ? { holder: claim.holder, expiresAt: claim.expiresAt } : null,
        readinessState,
        lastCheckpointSeq: checkpoint?.sequence ?? 0,
        journalSeq: latest?.sequence ?? 0,
        latestKind: latest?.kind ?? null,
        turnWasActive: wasActive,
      };

      const decision = evaluateDeterministic(snapshot, cooldowns);
      if (decision === null || !snapshot.ref) return;

      if (typeof decision === "string") {
        const verb = VERB_BY_ID.get(decision)!;
        if (!cooldownAllows(cooldowns, snapshot.ref, verb.id, snapshot.now, verb)) return;
        emit(verb, snapshot.ref, { source: "deterministic", revision: meta.currentRevision });
        return;
      }

      // Semantic duty chain, one card per turn, most duty first:
      // service skill → journal kind. Wait-guard already ran pre-binding.
      const registry = ((ctx as unknown as { modelRegistry?: RegistryLike } | undefined)?.modelRegistry ?? null);
      if (!registry && !readApiKey()) return;

      const packs = discoverSkillPacks(process.cwd());
      if (packs.length > 0) {
        const all = packs.flatMap((p) => p.entries);
        if (all.length > 0 && cooldownAllows(cooldowns, snapshot.ref, "skill_suggest", snapshot.now, SKILL_SOURCE_VERB)) {
          const result = await askJev(registry, {
            working_turn_excerpt: excerpt.slice(0, 4000),
            issue_ref: snapshot.ref,
            issue_purpose: meta.currentRevision ? undefined : undefined,
          }, {
            service: {
              type: "choice",
              instructions: "Pick the single service whose expert skill the working turn most clearly needs, or none. Base it only on the provided evidence.",
              criteria: Object.fromEntries([
                ...all.map((s) => [s.id, s.description]),
                ["none", "No registered service matches this turn."],
              ]),
            },
            service_specific: { type: "noul", instructions: "Would the picked service's expert skill materially change how the agent proceeds right now?" },
          } as Record<string, Question>);
          const fit = result?.nouls["service_specific"] ?? 0;
          const pick = result?.choice.choice;
          if (result && pick && pick !== "none" && fit >= FITS_THRESHOLD) {
            const entry = all.find((s) => s.id === pick);
            if (entry) {
              const verb = skillVerb(entry);
              if (cooldownAllows(cooldowns, snapshot.ref, verb.id, snapshot.now, verb)) {
                applyCooldown(cooldowns, snapshot.ref, SKILL_SOURCE_VERB);
                emit(verb, snapshot.ref, { confidence: result.choice.confidence ?? fit, revision: meta.currentRevision, source: "jev", model: result.model });
                return;
              }
            }
          }
        }
      }

      // Journal kind last: the ordinary case.
      const pick = await jevPickKind(registry, snapshot, excerpt);
      if (!pick) {
        logDecision({ ts: new Date().toISOString(), issue: snapshot.ref, verb: null, source: "jev", outcome: "none" });
        return;
      }
      const verb = VERB_BY_ID.get(pick.verbId)!;
      if (!cooldownAllows(cooldowns, snapshot.ref, verb.id, snapshot.now, verb)) return;
      emit(verb, snapshot.ref, { confidence: pick.confidence, revision: meta.currentRevision, source: "jev", model: pick.model });
    } catch {
      // Fail-open: a suggestion extension must never surface errors.
    }
  });
}
