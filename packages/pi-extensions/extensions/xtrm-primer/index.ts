/**
 * xtrm-primer — XTRM operating primer at session start (CORE-2363).
 *
 * Pi counterpart of the Claude Substrate plugin's SessionStart hook
 * (XTRM-637, xtrm repo: packages/substrate/plugin/substrate/scripts/xtrm-primer.mjs).
 * Same rules: read ONLY the global skills at ~/.xtrm/skills/default/<skill>/SKILL.md,
 * keep each skill's preamble plus a fixed set of named `##` sections, and say when
 * to load the full skill. Section headings are the interface: a renamed heading
 * drops that section, a missing skill drops that skill, no skill emits nothing,
 * any error emits nothing.
 *
 * Injection point (CORE-2394): `before_agent_start` returns `systemPrompt` =
 * event.systemPrompt + primer, a per-turn override (extensions.md, "Events and
 * concurrency"), so the primer is system context on every turn, including after
 * resume and compaction. It used to be a custom `message`, which Pi hands the
 * model in the user role; cautious models then refused the dispatcher reply
 * address as user-pasted text. MARKER in event.systemPrompt keeps a second loaded
 * copy of this extension (later handlers see the override) from appending twice.
 *
 * DRIFT: SKILLS below is copied from xtrm-primer.mjs (XTRM-637); the two repos
 * share no module. Change both together.
 *
 * Dispatcher line (CORE-2390): when `xt pi` exported XTRM_DISPATCHER_NAME or
 * XTRM_DISPATCHER_ADDRESS, the primer opens with who dispatched this worker,
 * where to reply and its Substrate participant name (SUBSTRATE_HOLDER). The
 * line stands alone when no skill yields a section.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MARKER = "<!-- xtrm-primer -->";

export const SKILLS = [
  {
    name: "using-xtrm",
    sections: ["The system contract", "Completion rule"],
    load: "before substantial work, when choosing between local work, subagents, xt peers, Specialists or a workflow, and when handing work off",
  },
  {
    name: "multiplexing",
    sections: ["Native first", "Durable work is separate from transport", "Failure rules"],
    load: "whenever two or more live agents, subagents or xt sessions collaborate, message each other or wait on each other",
  },
];

/**
 * Skills already warned about in this process. CORE-2405: buildPrimer runs on
 * every before_agent_start, so an unguarded warn repeats on every turn; the
 * first occurrence is the actionable one.
 */
const WARNED_MISSING_SECTIONS = new Set<string>();

/** Test seam: the warn cache is process-wide, so tests must be able to reset it. */
export function resetPrimerWarnings(): void {
  WARNED_MISSING_SECTIONS.clear();
}

export function excerpt(text: string, sections: readonly string[]): string {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const body = normalized.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*\n/, "");
  return body
    .split(/^(?=## )/m)
    .filter((part) => !part.startsWith("## ") || sections.includes(part.split("\n", 1)[0].slice(3).trim()))
    .map((part) => part.trim())
    .join("\n\n")
    .replace(/^# .*\n+/, "")
    .trim();
}

/** Requested `##` sections absent from text (BOM/CRLF/frontmatter tolerant); surfaces heading renames. */
export function missingSections(text: string, sections: readonly string[]): string[] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const body = normalized.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*\n/, "");
  const present = new Set<string>();
  for (const part of body.split(/^(?=## )/m)) {
    if (part.startsWith("## ")) present.add(part.split("\n", 1)[0].slice(3).trim());
  }
  return sections.filter((s) => !present.has(s));
}

/** Home for primer lookup: HOME per call (Bun caches homedir()), then USERPROFILE (Windows), then homedir(). */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** One line naming the dispatcher, its reply address and this worker's holder; null without dispatcher env. */
export function dispatcherLine(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = env.XTRM_DISPATCHER_NAME?.trim();
  const address = env.XTRM_DISPATCHER_ADDRESS?.trim();
  if (!name && !address) return null;
  const holder = env.SUBSTRATE_HOLDER?.trim();
  const parts = [`Dispatcher: ${name || "an agent session"} launched you.`];
  if (address) parts.push(`Reply to it at ${address}.`);
  if (holder) parts.push(`Your Substrate participant name is ${holder} (SUBSTRATE_HOLDER); claim Issues with --holder ${holder}.`);
  return parts.join(" ");
}

/** Builds the primer from `<home>/.xtrm/skills/default`; null when no skill yields a section and no dispatcher env is set. Never throws. */
// ponytail: read HOME per call; Bun caches os.homedir(), so a runtime HOME change is invisible to it.
// Dedup is bounded by construction: MARKER substring in systemPrompt, no global registry (no Symbol.for growth).
export function buildPrimer(home?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const resolvedHome = home ?? resolveHome(env);
  let dispatcher: string | null = null;
  try {
    dispatcher = dispatcherLine(env);
  } catch {
    dispatcher = null;
  }
  try {
    const root = join(resolvedHome, ".xtrm", "skills", "default");
    const loads: string[] = [];
    const blocks: string[] = [];
    for (const { name, sections, load } of SKILLS) {
      let text: string;
      try {
        text = readFileSync(join(root, name, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const missing = missingSections(text, sections);
      if (missing.length > 0 && !WARNED_MISSING_SECTIONS.has(name)) {
        WARNED_MISSING_SECTIONS.add(name);
        try {
          console.warn(`[xtrm-primer] skill '${name}' missing sections: ${missing.join(", ")} (heading renamed?)`);
        } catch {
          /* ignore warn failure */
        }
      }
      const body = excerpt(text, sections);
      if (!body) continue;
      loads.push(`- /skill:${name}: ${load}`);
      blocks.push(`### ${name} (excerpt)\n\n${body}`);
    }
    if (blocks.length === 0) return dispatcher;
    return [
      ...(dispatcher ? [dispatcher] : []),
      "XTRM operating primer, condensed from the global skills in ~/.xtrm/skills/default. This is an excerpt, not the full doctrine. Load the full skill with its slash command:",
      loads.join("\n"),
      ...blocks,
    ].join("\n\n");
  } catch {
    return dispatcher;
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    try {
      const base = event.systemPrompt;
      if (typeof base !== "string" || base.includes(MARKER)) return undefined;
      const primer = buildPrimer();
      if (!primer) return undefined;
      return { systemPrompt: `${base}\n\n${MARKER}\n${primer}` };
    } catch {
      return undefined;
    }
  });
}
