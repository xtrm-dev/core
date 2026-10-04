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
import { join } from "node:path";
import { contextBlock, formatSuggestionCard, parseContextBlock, renderCardBox, type VerbSpec } from "../substrate-suggest/catalog.ts";
import { classifyViaRegistry, systemOne, readApiKey, type Question, type RegistryLike } from "../substrate-suggest/jev.ts";
import { discoverRoster, resetRosterCache, type RosterEntry } from "./roster.ts";

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

const GATE_THRESHOLD = 0.3; // mean of gate nouls under this -> nothing
const FITS_THRESHOLD = 0.3; // winner's verify noul under this -> nothing
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

function skillVerb(entry: RosterEntry, confidence: number | null): VerbSpec {
  return {
    id: "skill_suggest",
    action: `skill loaded · ${entry.id}`,
    oneLine: entry.description,
    instruction: () =>
      `Injected from ${entry.path} — follow it for this task if it fits; /skill:${entry.skill} reloads the umbrella.`,
    severity: "normal",
    cooldownMin: COOLDOWN_MIN,
    source: "jev",
  };
}

export default function skillSuggestExtension(pi: ExtensionAPI): void {
  const off = () =>
    pi.getFlag("no-skill-suggest") === true ||
    (process.env["SKILL_SUGGEST"] ?? "").toLowerCase() === "off";

  const cooldowns: Record<string, number> = {};
  /** Advances per turn so consecutive turns do not double-count evidence. */
  let messageCursor = 0;
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
              action: `${meta.kind === "agent-settlement" ? "result settled" : "skill loaded"} · ${meta.source ?? "—"}`,
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

      const gate = [
        (result.nouls["would_follow_documented_procedure"] ?? 0),
        1 - (result.nouls["prose_suffices"] ?? 0),
        1 - (result.nouls["asks_about_the_tooling"] ?? 0),
      ];
      const gateMean = gate.reduce((a, b) => a + b, 0) / gate.length;
      const pick = result.choice.choice;
      const entry = roster.find((r) => r.id === pick);
      // Log every evaluation — negatives are the tuning signal.
      logDecision({
        ts: new Date().toISOString(),
        seam: "input",
        pick: entry?.id ?? pick ?? "none",
        gate: Number(gateMean.toFixed(3)),
        confidence: result.choice.confidence,
        injected: Boolean(entry) && gateMean >= GATE_THRESHOLD,
        prompt_chars: prompt.length,
      });
      if (gateMean < GATE_THRESHOLD || !entry) return { action: "continue" } as const;
      // Sub-gate choice confidence stays silent: a high procedural gate with a
      // barely-confident pick injected wrong doctrine in live use (0.19/0.20 hits).
      if (result.choice.confidence !== null && result.choice.confidence < FITS_THRESHOLD) return { action: "continue" } as const;

      // One card per prompt, per catalog id.
      if (!cooldownOk(entry.id, Date.now())) return { action: "continue" } as const;
      cooldownSet(entry.id);

      const block = contextBlock("skill-doctrine", {
        about: `the current request`,
        source: entry.id,
        model: result.model ?? "jev",
        confidence: result.choice.confidence,
        body: [
          `${entry.id} — ${entry.description.slice(0, 160)}. Ignore this if it does not fit what the user actually asked for.`,
          `Its instructions: read ${entry.path} and apply what fits before proceeding.`,
          entry.level === "reference" ? `Nested reference of the ${entry.skill} skill.` : "",
        ].filter(Boolean).join("\n"),
      });

      // The prompt transform is the only ordered delivery at this seam: a
      // sendMessage here races the in-flight turn ("Agent is already
      // processing") and displaced the operator's own prompt in the TUI.
      // No card is emitted for this seam — the labelled block appended to the
      // prompt is the whole delivery, so nothing is shown twice.
      logDecision({ ts: new Date().toISOString(), seam: "input", pick: entry.id, injected: true, delivery: "prompt-transform" });

      return { action: "transform", text: `${prompt}\n\n${block}` } as const;
    } catch {
      return { action: "continue" } as const; // fail-open: prompt untouched
    }
  };

  // The input seam: transform the prompt before the turn starts.
  pi.on("input", handler as never);

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
  pi.on("agent_end", async (event, ctx) => {
    try {
      if (off()) return;
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
      const gate = [
        (result.nouls["would_follow_documented_procedure"] ?? 0),
        1 - (result.nouls["prose_suffices"] ?? 0),
        1 - (result.nouls["asks_about_the_tooling"] ?? 0),
      ];
      const gateMean = gate.reduce((a, b) => a + b, 0) / gate.length;
      const pick = result.choice.choice;
      const entry = roster.find((r) => r.id === pick);
      if (gateMean < GATE_THRESHOLD || !entry) return;
      if (!cooldownOk(entry.id, Date.now())) return;
      cooldownSet(entry.id);

      // Pointer, not content (input seam parity).
      const block = contextBlock("skill-doctrine", {
        about: `your stated next step`,
        source: entry.id,
        model: result.model ?? "jev",
        confidence: result.choice.confidence,
        body: [
          `${entry.id} — ${entry.description.slice(0, 160)}. Ignore this if it does not fit what you actually plan to do.`,
          `Its instructions: read ${entry.path} and apply what fits before proceeding.`,
          entry.level === "reference" ? `Nested reference of the ${entry.skill} skill.` : "",
        ].filter(Boolean).join("\n"),
      });
      logDecision({ ts: new Date().toISOString(), seam: "agent_end", pick: entry.id, injected: true, confidence: result.choice.confidence, gate: Number(gateMean.toFixed(3)) });
      // One message carries both audiences: the model reads the doctrine
      // block; the operator sees the house card around it.
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: formatSuggestionCard({ verb: skillVerb(entry, result.choice.confidence), ref: "—", confidence: result.choice.confidence, compact: true }),
          display: true,
          details: { skill: entry.id, level: entry.level, seam: "agent_end" },
        },
        { deliverAs: "followUp", triggerTurn: false },
      );
    } catch {
      /* fail-open: a suggestion extension must never break a session */
    }
  });

  // Reload the roster when packs change on disk (cheap: cache TTL governs).
  if (typeof pi.on === "function") {
    pi.on("session_start", () => resetRosterCache());
  }
}
