/**
 * xtrm-primer — XTRM operating primer at session start (CORE-2363).
 *
 * Pi counterpart of the Claude Substrate plugin's SessionStart hook
 * (XTRM-637, xtrm repo: packages/substrate/plugin/substrate/scripts/xtrm-primer.mjs).
 * Same rules: read ONLY the global skills at ~/.xtrm/skills/default/<skill>/SKILL.md,
 * keep each skill's preamble plus a fixed set of named `##` sections, and say when
 * to load the full skill. Section headings are the excerpt interface: a renamed
 * heading drops that section, a missing skill drops that skill's excerpt (the
 * unconditional ALWAYS_ON block below still ships), any excerpt error emits
 * nothing for that skill.
 *
 * Injection point (CORE-2394): `before_agent_start` returns `systemPrompt` =
 * event.systemPrompt + primer, a per-turn override (extensions.md, "Events and
 * concurrency"), so the primer is system context on every turn, including after
 * resume and compaction. It used to be a custom `message`, which Pi hands the
 * model in the user role; cautious models then refused the dispatcher reply
 * address as user-pasted text. MARKER in event.systemPrompt keeps a second loaded
 * copy of this extension (later handlers see the override) from appending twice.
 *
 * Single vehicle (XT-138/XT-139, CORE-2476): this primer is the only versioned
 * Pi doctrine vehicle. The ALWAYS_ON block folds the always-on content that
 * used to live in the unversioned ~/.pi/agent/APPEND_SYSTEM.md home file
 * (codemode router, operator mandate, monitor rule, ast_grep, probe/kernel,
 * memory + drift doctrine) with the CORE-2475 audit fixes applied. The
 * installer no longer writes Pi doctrine to the home file
 * (cli/src/core/global-prompt-sync.ts); project .pi/APPEND_SYSTEM.md
 * overrides keep Pi-native precedence (never managed here).
 *
 * DRIFT: SKILLS below is copied from xtrm-primer.mjs (XTRM-637); the two repos
 * share no module. Change both together. ALWAYS_ON is Pi-primer-owned
 * (Pi 1.3.0 citations, repo extension names) and is intentionally NOT mirrored.
 *
 * Dispatcher line (CORE-2390): when `xt pi` exported XTRM_DISPATCHER_NAME or
 * XTRM_DISPATCHER_ADDRESS, the primer opens with who dispatched this worker,
 * where to reply and its Substrate participant name (SUBSTRATE_HOLDER). The
 * line stands first; it no longer stands alone (ALWAYS_ON always follows).
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
 * Folded always-on rules (XT-138/XT-139, CORE-2476; audit fixes CORE-2475).
 *
 * Versioned single vehicle for the doctrine that used to live split across
 * the unversioned ~/.pi/agent/APPEND_SYSTEM.md home file and this primer's
 * skill excerpts. Emitted unconditionally on every turn (unlike excerpts,
 * which drop with a missing skill or renamed heading). Each line carries its
 * audit fix: rejection semantics resolve-only-on-failure/block/invalid-args
 * with isError+structuredContent for outputSchema/MCP tools (Pi 1.3.0
 * docs/codemode.md:44,48, extensions.md:147); ast_grep guidance is
 * session-scoped (absent from Pi 1.3.0 dist/core/tools); the
 * background-monitor rule covers shell/streaming waits only (native agent
 * waits excluded); SendMessage/ListAgents are the repo intercom extension,
 * never Pi-native; the service-knowledge reconcile cites the
 * status-suggested /updating-service-knowledge action, scoped to installed
 * packs; python/preflight/background are tagged repo-extension capabilities
 * while bun/tsx/cargo/dolt are environment guidance; all Pi citations pin
 * installed 1.3.0 (repo devDeps floor is Pi SDK 1.0.0 — wording verified
 * against the 1.3.0 install, not the bundled minimum).
 */
export const ALWAYS_ON = `XTRM always-on rules (primer-injected; excerpt — load the full skill before relying on it).

- One programmatic cell per batch: fan out independent tool calls in a single codemode cell (Promise.allSettled), filter in-script, return the digest. A call rejects only when it failed, was blocked, or had invalid args; outputSchema and MCP tools resolve with isError + structuredContent — parse the resolved value defensively (Pi 1.3.0 docs/codemode.md:44,48, extensions.md:147).
- Session-scoped ast_grep (absent from Pi 1.3.0 dist/core/tools): where this session provides it, prefer it for code-shape queries; otherwise use text search.
- Shell/streaming waits only: when a background shell or streaming task runs (repo background extension: BashBackground/Monitor), register the runtime monitor and end the turn — its notification wakes you. Native agent waits (intercom asks, specialist/subagent joins) are excluded: use their native continuation, never a background monitor or an operator nudge.
- Coordinate peers via SendMessage + ListAgents from the repo intercom extension (never Pi-native).
- Project runner: a project's own tests, scripts, and CLIs run in the project's documented environment (uv run, .venv/bin/python, npm/bun run); treat that environment's failures as the result.
- Capability tags: the python kernel with preflight() and background tasks/monitors are repo-extension capabilities (absent outside this repo's extensions). bun/tsx (TS probes), cargo (Rust), dolt sql (Dolt) are environment guidance — reach them through the project runner, not as model tools.
- Memory on demand: before editing, run file-scoped preflight(); consult bd memories and the commit corpus; never bulk-prime. Service-knowledge reconcile only where its pack is installed: follow the status-suggested /updating-service-knowledge action and stamp last_sync_ref.`;

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
    // ALWAYS_ON is unconditional: the folded always-on rules ship on every
    // turn even when no skill yields an excerpt. The signature keeps
    // `| null` for caller compatibility, but this path no longer returns it.
    return [
      ...(dispatcher ? [dispatcher] : []),
      ALWAYS_ON,
      ...(blocks.length > 0
        ? [
            "XTRM operating primer, condensed from the global skills in ~/.xtrm/skills/default. This is an excerpt, not the full doctrine. Load the full skill with its slash command:",
            loads.join("\n"),
            ...blocks,
          ]
        : []),
    ].join("\n\n");
  } catch {
    return dispatcher ? `${dispatcher}\n\n${ALWAYS_ON}` : ALWAYS_ON;
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
