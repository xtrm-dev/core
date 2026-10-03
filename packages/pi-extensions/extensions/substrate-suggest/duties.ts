/**
 * duties.ts — pluggable suggestion sources beyond the sb verb surface.
 *
 * Same contract as the sb catalog (catalog.ts): a deterministic gate first,
 * a Jev verify second, a cooldown third, at most one card per turn. Two
 * sources live here:
 *
 * 1. wait-guard — the agent's final message commits to waiting for an
 *    external event ("I'll check when CI finishes") while NO monitor was
 *    set this turn. Durable Substrate mapping: a wait is a blocker.
 * 2. skill — service-knowledge packs under `.xtrm/skills/…/service-knowledge/`
 *    carry a service-registry.json whose descriptions are ready-made Jev
 *    criteria ("Use when debugging MCP tool failures, …"). The pick points
 *    the agent at the expert skill for the service it is actually touching.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { VerbSpec } from "./catalog.ts";

// ── wait-guard ───────────────────────────────────────────────────────────────

/** Commitment shapes worth a second opinion. Deliberately broad — Jev filters the noise. */
const WAIT_COMMIT_RE =
  /\b(i'?ll\s+(?:wait|check|monitor|watch|poll)|i will\s+(?:wait|check|monitor|watch|poll)|let'?s wait|going to wait|wait(?:ing)?\s+(?:for\s+(?:it|them|this|that|both|the)\b|on\b)|wait(?:ing)? for (?:the )?(?:ci|build|pipeline|tests?|deploy|review|results?))\b/i;
/** …and this is what "waiting for X" looks like when X is named. */
const WAIT_TARGET_RE =
  /\b(?:once|when|after|until)\s+(?:(?:both|they|it|that|this)\s+(?:merge[sd]?|lands?|finish(?:es)?|complet(?:e|es|ed)|pass(?:es)?|is done)\b|(?:the\s+)?(?:ci|cd|build|pipeline|tests?|checks?|deploy\w*|review|job|run|workflow|results?|reply|response|summary|output|queue|release|cut|merge|publish)\b)/i;

/** Tool evidence that a monitor or wake seam actually exists for the thing being awaited. */
export function isMonitorSetter(toolName: string, args: Record<string, unknown> | undefined, input: Record<string, unknown> | undefined): boolean {
  if (/^(bg_run|bg_delegate|process)$/.test(toolName)) return true;
  // An intercom ask/send IS a wake seam: the peer's reply re-enters this
  // session as a follow-up turn. Awaiting "the reply arrives" behind an
  // intercom send is monitored by construction.
  if (toolName === "intercom") {
    const action = String(args?.["action"] ?? input?.["action"] ?? "");
    if (action === "ask" || action === "send") return true;
  }
  const cmd = String(args?.["command"] ?? input?.["command"] ?? "");
  if (!cmd) return false;
  // Foreground `sleep N; check` poll loops are NOT monitors: they block the
  // turn and force a fresh decision every cycle. Real wake seams are
  // backgrounded or parked: bg_run/process/nohup, `&\s*$`, watch -n (runs
  // behind), sleep infinity, `at now`. A plain foreground while-sleep or
  // timed sleep still lets the wait-guard fire; Jev then decides whether a
  // proper background monitor would materially help.
  return /\b(bg_run|bg_delegate|process start|nohup|watch\s+-?\d|systemd-run|at now|sleep infinity)\b/.test(cmd) || /&\s*$/.test(cmd);
}

export function waitCommitment(text: string): boolean {
  return WAIT_COMMIT_RE.test(text) || WAIT_TARGET_RE.test(text);
}

export function waitGuardVerb(): VerbSpec {
  return {
    id: "wait_guard",
    action: "wait without a monitor",
    oneLine: "The agent committed to waiting for an external event with no monitor or timer set.",
    instruction: () =>
      "You committed to wait for an external event with nothing watching it: start a monitor (bg_run/process) or journal a blocker so a resumed session knows what is pending.",
    severity: "normal",
    cooldownMin: 45,
    source: "jev",
  };
}

// ── skill (service-knowledge) ────────────────────────────────────────────────

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  skillPath: string;
  container: string | null;
  territory?: string[];
}

export interface SkillPack {
  packDir: string;
  entries: SkillEntry[];
}

const ROSTER_CACHE_TTL_MS = 5 * 60_000;
const ROSTER_MAX = 24;
let rosterCache: { at: number; packs: SkillPack[] } = { at: 0, packs: [] };

/** Parse one service-registry.json into bounded roster entries. */
export function parseRegistry(registryJson: string, packDir: string, repoRoot: string): SkillEntry[] {
  try {
    const parsed = JSON.parse(registryJson) as { services?: Record<string, { name?: string; description?: string; container?: string; skill_path?: string; territory?: unknown }> };
    const services = parsed.services ?? {};
    const entries: SkillEntry[] = [];
    for (const [id, svc] of Object.entries(services)) {
      const description = typeof svc?.description === "string" ? svc.description.trim() : "";
      if (!description) continue;
      entries.push({
        id,
        name: svc.name ?? id,
        description,
        skillPath: svc.skill_path ? join(repoRoot, svc.skill_path) : join(packDir, "services", id, "SKILL.md"),
        container: svc.container ?? null,
        territory: Array.isArray(svc.territory) ? (svc.territory as string[]).slice(0, 40) : [],
      });
    }
    return entries.slice(0, ROSTER_MAX);
  } catch {
    return [];
  }
}

/** Discover service-knowledge packs between cwd and the git root. Bounded walk, 5-min cache. */
export function discoverSkillPacks(cwd: string, now = Date.now()): SkillPack[] {
  if (now - rosterCache.at < ROSTER_CACHE_TTL_MS) return rosterCache.packs;
  const packs: SkillPack[] = [];
  try {
    let dir = cwd;
    let repoRoot = cwd;
    for (let guard = 0; guard < 8; guard++) {
      if (existsSync(join(dir, ".git"))) { repoRoot = dir; break; }
      const parent = join(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
    const skillsRoot = join(repoRoot, ".xtrm", "skills");
    if (existsSync(skillsRoot)) {
      for (const pack of readdirSync(skillsRoot)) {
        const packDir = join(skillsRoot, pack, "service-knowledge");
        const registryPath = join(packDir, "service-registry.json");
        if (!existsSync(registryPath)) continue;
        const entries = parseRegistry(readFileSync(registryPath, "utf8"), packDir, repoRoot);
        if (entries.length > 0) packs.push({ packDir: relative(cwd, packDir) || packDir, entries });
      }
    }
  } catch {
    return [];
  }
  rosterCache = { at: now, packs };
  return packs;
}

/** Reset for tests. */
export function resetRosterCache(): void {
  rosterCache = { at: 0, packs: [] };
}

export function skillVerb(entry: SkillEntry): VerbSpec {
  return {
    id: "skill_suggest",
    action: `consider skill · ${entry.id}`,
    oneLine: entry.description,
    instruction: () =>
      `The ${entry.name} service is in play${entry.container ? ` (container ${entry.container})` : ""}: open its expert skill at ${entry.skillPath} before going deeper.`,
    severity: "normal",
    cooldownMin: 30,
    source: "jev",
  };
}

// ── mid-turn territory hit (tool_result injection) ──────────────────────────

/** Extract plausible file paths from a tool call's input. */
export function inputPaths(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.length > 0 && v.length < 500 && /[A-Za-z0-9_./-]/.test(v) && !v.includes("\n")) out.push(v);
  };
  for (const key of ["path", "file_path", "file", "filePath"]) push(input[key]);
  const cmd = input["command"];
  if (typeof cmd === "string") {
    // bash: bare path-ish tokens only — bounded scan, no regex over the whole command.
    for (const tok of cmd.split(/\s+/).slice(0, 40)) {
      if (/\.(py|ts|js|mjs|json|md|toml|ya?ml|go|rs|sh)$/.test(tok)) out.push(tok);
    }
  }
  return out.slice(0, 10);
}

/** Glob-lite: `dir/**␣/` is a prefix, a trailing `*` is a segment wildcard, else exact. */
function territoryMatches(pattern: string, path: string): boolean {
  const p = pattern.replace(/^\.\//, "");
  if (p.includes("**")) return path.startsWith(p.split("**")[0]);
  if (p.endsWith("*")) return path.startsWith(p.slice(0, -1));
  return path === p || path.endsWith(`/${p}`) || path.startsWith(`${p}/`);
}

/** The service whose territory this tool call touches, or null. First hit wins. */
export function territoryHit(packs: SkillPack[], input: Record<string, unknown> | undefined, cwd: string): SkillEntry | null {
  const paths = inputPaths(input);
  if (paths.length === 0) return null;
  for (const pack of packs) {
    for (const entry of pack.entries) {
      for (const pattern of entry.territory ?? []) {
        for (const path of paths) {
          const rel = path.startsWith("/") ? (relative(cwd, path) || path) : path;
          if (!rel.startsWith("..") && territoryMatches(pattern, rel)) return entry;
        }
      }
    }
  }
  return null;
}
