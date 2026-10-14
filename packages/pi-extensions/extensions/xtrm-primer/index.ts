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
 * Injection point: `before_agent_start` may return a `message` that Pi adds to the
 * run and persists in the transcript (extensions.md, "Events and concurrency").
 * `session_start` cannot return context, so it only checks whether the session
 * branch already carries the primer (resume, fork) and arms the next run.
 *
 * DRIFT: SKILLS below is copied from xtrm-primer.mjs (XTRM-637); the two repos
 * share no module. Change both together.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CUSTOM_TYPE = "xtrm-primer";

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

export function excerpt(text: string, sections: readonly string[]): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  return body
    .split(/^(?=## )/m)
    .filter((part) => !part.startsWith("## ") || sections.includes(part.split("\n", 1)[0].slice(3).trim()))
    .map((part) => part.trim())
    .join("\n\n")
    .replace(/^# .*\n+/, "")
    .trim();
}

/** Builds the primer from `<home>/.xtrm/skills/default`; null when no skill yields a section. Never throws. */
export function buildPrimer(home: string = homedir()): string | null {
  try {
    const root = join(home, ".xtrm", "skills", "default");
    const loads: string[] = [];
    const blocks: string[] = [];
    for (const { name, sections, load } of SKILLS) {
      let text: string;
      try {
        text = readFileSync(join(root, name, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const body = excerpt(text, sections);
      if (!body) continue;
      loads.push(`- /skill:${name}: ${load}`);
      blocks.push(`### ${name} (excerpt)\n\n${body}`);
    }
    if (blocks.length === 0) return null;
    return [
      "XTRM operating primer, condensed from the global skills in ~/.xtrm/skills/default. This is an excerpt, not the full doctrine. Load the full skill with its slash command:",
      loads.join("\n"),
      ...blocks,
    ].join("\n\n");
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI): void {
  let armed = true;

  pi.on("session_start", async (_event, ctx) => {
    try {
      const branch = ctx.sessionManager.getBranch() as Array<{ customType?: string }>;
      armed = !branch.some((entry) => entry.customType === CUSTOM_TYPE);
    } catch {
      armed = true;
    }
  });

  pi.on("before_agent_start", async () => {
    if (!armed) return undefined;
    const content = buildPrimer();
    if (!content) return undefined;
    armed = false;
    return { message: { customType: CUSTOM_TYPE, content, display: false } };
  });
}
