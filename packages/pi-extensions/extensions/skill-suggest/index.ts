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
 *      block carrying the doc excerpt and its path, phrased ignore-if-not-fits
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
import { formatSuggestionCard, type VerbSpec } from "../substrate-suggest/catalog.ts";
import { classifyViaRegistry, systemOne, readApiKey, type Question, type RegistryLike } from "../substrate-suggest/jev.ts";
import { discoverRoster, resetRosterCache, type RosterEntry } from "./roster.ts";

const CUSTOM_TYPE = "skill_suggestion";
const LOG_DIR = join(homedir(), ".xtrm", "skill-suggest");
const LOG_FILE = join(LOG_DIR, "log.jsonl");

const GATE_THRESHOLD = 0.3; // mean of gate nouls under this -> nothing
const FITS_THRESHOLD = 0.3; // winner's verify noul under this -> nothing
const EXCERPT_CHARS = 700;
const INJECT_TIMEOUT_MS = 2500;

const COOLDOWN_MIN = 30;

function logDecision(row: Record<string, unknown>): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${JSON.stringify(row)}\n`);
  } catch {
    /* logging is best-effort */
  }
}

/** Bounded doc excerpt for the injection block. */
function docExcerpt(path: string): string {
  try {
    const md = readFileSync(path, "utf8");
    const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
    return body.slice(0, EXCERPT_CHARS);
  } catch {
    return "";
  }
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
  const cooldownOk = (id: string, now: number) => (cooldowns[id] === undefined || now >= cooldowns[id]);
  const cooldownSet = (id: string) => { cooldowns[id] = Date.now() + COOLDOWN_MIN * 60_000; };

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

  const handler = async (event: { text?: string }, ctx?: { modelRegistry?: unknown }) => {
    if (off()) return { action: "continue" } as const;
    const prompt = typeof event?.text === "string" ? event.text : "";
    if (prompt.trim().length < 8 || prompt.startsWith("/")) return { action: "continue" } as const; // commands decide for themselves

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
      };
      const state = { request: prompt.slice(0, 2000), cwd: process.cwd() };
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

      const gate = [(result.nouls["would_follow_documented_procedure"] ?? 0), 1 - (result.nouls["prose_suffices"] ?? 0)];
      const gateMean = gate.reduce((a, b) => a + b, 0) / gate.length;
      const pick = result.choice.choice;
      const entry = roster.find((r) => r.id === pick);
      if (!result || gateMean < GATE_THRESHOLD || !entry) return { action: "continue" } as const;

      // One card per prompt, per catalog id.
      if (!cooldownOk(entry.id, Date.now())) return { action: "continue" } as const;
      cooldownSet(entry.id);

      const excerpt = docExcerpt(entry.path);
      const block = [
        `<skill_relevance>`,
        `Relevant to the current request: ${entry.id}. Ignore this if it does not fit what the user actually asked for.`,
        `Its instructions follow (bounded excerpt of ${entry.path}); read the file for the rest.`,
        entry.level === "reference" ? `This is a nested reference of the ${entry.skill} skill.` : "",
        excerpt,
        `</skill_relevance>`,
      ].filter(Boolean).join("\n");

      logDecision({
        ts: new Date().toISOString(),
        skill: entry.id,
        level: entry.level,
        confidence: result.choice.confidence,
        gate: gateMean,
        prompt_chars: prompt.length,
      });

      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: formatSuggestionCard({ verb: skillVerb(entry, result.choice.confidence), ref: "—", confidence: result.choice.confidence }),
          display: true,
          details: { skill: entry.id, level: entry.level },
        },
        { deliverAs: "followUp", triggerTurn: false },
      );

      return { action: "transform", text: `${prompt}\n\n${block}` } as const;
    } catch {
      return { action: "continue" } as const; // fail-open: prompt untouched
    }
  };

  // The input seam: transform the prompt before the turn starts.
  pi.on("input", handler as never);

  // The intention seam: the agent declares what it is doing in its own final
  // message. Same two-stage Jev over the turn evidence; the doctrine rides
  // into the next turn as a followUp the model reads.
  pi.on("agent_end", async (event, ctx) => {
    try {
      if (off()) return;
      const messages = (event as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      let lastAssistant = "";
      let wasActive = false;
      for (let i = Math.max(0, messages.length - 6); i < messages.length; i++) {
        const m = messages[i];
        const content = Array.isArray(m?.content) ? (m!.content as Array<Record<string, unknown>>) : [];
        for (const p of content) {
          if (p?.["type"] === "text" && typeof p["text"] === "string" && m?.role === "assistant") lastAssistant = p["text"];
          if (p?.["type"] === "tool_call") wasActive = true;
        }
      }
      if (!lastAssistant || !wasActive) return;
      const registry = ((ctx as unknown as { modelRegistry?: RegistryLike } | undefined)?.modelRegistry ?? null);
      if (!registry && !readApiKey()) return;
      const roster = discoverRoster(process.cwd());
      if (roster.length === 0) return;

      const result = await askJev(registry, {
        agent_final_message: lastAssistant.slice(0, 1500),
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
      const gate = [(result.nouls["would_follow_documented_procedure"] ?? 0), 1 - (result.nouls["prose_suffices"] ?? 0)];
      const gateMean = gate.reduce((a, b) => a + b, 0) / gate.length;
      const pick = result.choice.choice;
      const entry = roster.find((r) => r.id === pick);
      if (gateMean < GATE_THRESHOLD || !entry) return;
      if (!cooldownOk(entry.id, Date.now())) return;
      cooldownSet(entry.id);

      const excerpt = docExcerpt(entry.path);
      const block = [
        `<skill_relevance>`,
        `Relevant to your stated next step: ${entry.id}. Ignore this if it does not fit what you actually plan to do.`,
        `Its instructions follow (bounded excerpt of ${entry.path}); read the file for the rest.`,
        entry.level === "reference" ? `This is a nested reference of the ${entry.skill} skill.` : "",
        excerpt,
        `</skill_relevance>`,
      ].filter(Boolean).join("\n");
      logDecision({ ts: new Date().toISOString(), skill: entry.id, level: entry.level, seam: "agent_end", confidence: result.choice.confidence, gate: gateMean });
      // One message carries both audiences: the model reads the doctrine
      // block; the operator sees the house card around it.
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: `${formatSuggestionCard({ verb: skillVerb(entry, result.choice.confidence), ref: "—", confidence: result.choice.confidence })}\n\x1b[2m${excerpt.slice(0, 600)}\x1b[22m`,
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
