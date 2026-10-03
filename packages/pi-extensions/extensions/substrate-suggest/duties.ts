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

/** Commitment shapes worth a second opinion. Deliberately small — Jev verifies. */
const WAIT_COMMIT_RE =
  /\b(i'?ll\s+(?:wait|check|monitor|watch|poll)|i will\s+(?:wait|check|monitor|watch|poll)|let'?s wait|going to wait|wait(?:ing)? for (?:the )?(?:ci|build|pipeline|tests?|deploy|review|results?))\b/i;
/** …and this is what "waiting for X" looks like when X is named. */
const WAIT_TARGET_RE =
  /\b(?:once|when|after|until)\s+(?:the\s+)?(?:ci|cd|build|pipeline|tests?|deploy\w*|review|job|run|workflow)\s+(?:finishes|completes|passes|fails|is done|lands|ends)\b/i;

/** Tool evidence that a monitor actually exists for the thing being awaited. */
export function isMonitorSetter(toolName: string, args: Record<string, unknown> | undefined, input: Record<string, unknown> | undefined): boolean {
  if (/^(bg_run|bg_delegate|process)$/.test(toolName)) return true;
  const cmd = String(args?.["command"] ?? input?.["command"] ?? "");
  if (!cmd) return false;
  return /\b(bg_run|bg_delegate|process start|nohup|watch\s+-?\d|sleep\s+\d{2,}|while\s+.*sleep|systemd-run|at now|sleep infinity)\b/.test(cmd) || /&\s*$/.test(cmd);
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
    const parsed = JSON.parse(registryJson) as { services?: Record<string, { name?: string; description?: string; container?: string; skill_path?: string }> };
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
