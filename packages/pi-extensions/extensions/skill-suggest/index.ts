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

  // Reload the roster when packs change on disk (cheap: cache TTL governs).
  if (typeof pi.on === "function") {
    pi.on("session_start", () => resetRosterCache());
  }
}
