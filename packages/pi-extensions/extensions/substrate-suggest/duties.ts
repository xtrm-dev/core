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
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import type { Cooldowns, VerbSpec } from "../../shared/suggest.ts";
import { applyCooldown, cooldownAllows } from "../../shared/suggest.ts";

// ── provenance duty ──────────────────────────────────────────────────────────

// XTRM provenance is engineering evidence (engineering-quality): commits and
// PRs are memory of *why* code is the way it is. A behavior-affecting change
// made without consulting that memory is exactly what the doctrine forbids.
// Deterministic trigger: the turn edited files AND consulted no history.
// Jev only verifies whether the history could plausibly matter.

/** Tools that change code or tracked content. The python tool is excluded:
 * it is invoked far too often for compute to gate cheaply — its file writes
 * are rarer and covered by the kernel's own audit policy. */
export function isEditor(toolName: string): boolean {
  return /^(edit|write|apply_patch|multi_edit)$/.test(toolName);
}

/** Tool evidence that commit/PR history was consulted this turn. */
export function isProvenanceReader(toolName: string, args: Record<string, unknown> | undefined, input: Record<string, unknown> | undefined): boolean {
  const raw = `${toolName} ${JSON.stringify(args ?? {})} ${JSON.stringify(input ?? {})}`;
  return /\b(git (log|show|blame|bisect)|change-provenance|preflight\s*\(|gitnexus_(context|impact))\b/.test(raw);
}

export function provenanceDutyVerb(editedFiles: string[]): VerbSpec {
  const first = editedFiles[0]?.split("/").pop() ?? "the changed file";
  return {
    id: "provenance_unread",
    action: "provenance unread",
    oneLine: "Behavior changed without consulting why the code was the way it was.",
    instruction: () =>
      `You changed ${first} behavior without reading its history: run preflight(repo, '${editedFiles[0] ?? "file"}') or change-provenance.mjs — commits and PRs record why the code is as it is. Ignore this if you already consulted provenance this session.`,
    severity: "normal",
    cooldownMin: 45,
    source: "jev",
  };
}

/**
 * Partition edited paths into tracked vs untracked using an injected check.
 * Pure — the git call lives in trackedEditedFiles so tests inject a stub.
 * Unknown means untracked: the duty must stay silent, never loud on unknown.
 */
export function partitionTracked(
  edited: string[],
  isTracked: (file: string) => boolean,
): { tracked: string[]; untracked: string[] } {
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const f of edited) (isTracked(f) ? tracked : untracked).push(f);
  return { tracked, untracked };
}

/**
 * Build the evidence body for a mid-turn provenance steer: what changed
 * (working-tree diffstat, bounded), who last touched each file and why
 * (one commit line each, bounded), and the exact history commands to run
 * next. All subprocesses are capped and fail-open: on any git failure the
 * steer degrades to the file list rather than erroring the turn.
 */
export function buildProvenanceEvidence(files: string[], cwd: string): string {
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  };
  const lines: string[] = [];
  const stat = run(["diff", "--stat", "--", ...files.slice(0, 8)]).trim();
  if (stat) lines.push(stat.split("\n").slice(0, 12).join("\n"));
  for (const f of files.slice(0, 4)) {
    const last = run(["log", "-1", "--format=%h %ad %s", "--date=short", "--", f]).trim();
    if (last) lines.push(`${f}: last ${last}`);
  }
  if (lines.length === 0) return files.slice(0, 5).join(", ");
  const first = files[0];
  lines.push(
    `History that may matter: git log -p --follow -- ${first}; ` +
      `blast radius: gitnexus impact on the touched exports before editing further.`,
  );
  return lines.join("\n").slice(0, 2000);
}

/**
 * Repo root for git-backed duties: `git rev-parse --show-toplevel` from the
 * launch directory, falling back to it outside a repo. CORE-2406: Pi may be
 * launched in a subdirectory (or outside the repo); process.cwd() is the
 * launch directory, not the repo root.
 */
export function repoRoot(startDir: string = process.cwd()): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || startDir;
  } catch {
    return startDir;
  }
}

export interface ProvenanceClassifyResult {
  mean: number;
  model: string | null;
}

/**
 * Provenance-steer ordering: cooldown → classify/gate → mark → deliver.
 * Files are marked steered only when the steer is actually delivered, so a
 * gate- or cooldown-blocked steer retries later in the turn instead of being
 * silently dropped (CORE-2406). Returns the outcome for callers and tests.
 */
export async function runProvenanceSteer(opts: {
  files: string[];
  steered: string[];
  cooldowns: Cooldowns;
  threshold: number;
  classify: () => Promise<ProvenanceClassifyResult | null>;
  deliver: (files: string[], model: string | null) => void;
}): Promise<"delivered" | "gated" | "cooled"> {
  if (opts.files.length === 0) return "gated";
  const verb = provenanceDutyVerb(opts.files);
  if (!cooldownAllows(opts.cooldowns, "prov", verb.id, Date.now(), verb)) return "cooled";
  const result = await opts.classify();
  if (!result || result.mean < opts.threshold) return "gated";
  opts.steered.push(...opts.files);
  applyCooldown(opts.cooldowns, "prov", verb);
  opts.deliver(opts.files, result.model);
  return "delivered";
}

/**
 * Keep only the edited files git tracks under cwd. One subprocess per
 * steer at most. Non-repo cwd or any git failure means no trackable
 * history exists, so the duty must stay silent.
 */
export function trackedEditedFiles(edited: string[], cwd: string): string[] {
  if (edited.length === 0) return [];
  try {
    const out = execFileSync("git", ["ls-files", "--", ...edited], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tracked = new Set(
      out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => resolve(cwd, l)),
    );
    return edited.filter((f) => tracked.has(resolve(cwd, f)));
  } catch {
    return [];
  }
}

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
/**
 * Cached pack scan. Keyed by repoRoot, NOT a single slot: an unkeyed cache makes the FIRST
 * repo's packs answer for every later repo in the same process, so a session that evaluates
 * duties in a second repo silently suggests another repository's services.
 */
let rosterCache: { at: number; key: string; packs: SkillPack[] } = { at: 0, key: "", packs: [] };

/** Parse one service-registry.json into bounded roster entries. */
export function parseRegistry(registryJson: string, packDir: string, repoRoot: string): SkillEntry[] {
  try {
    const parsed = JSON.parse(registryJson) as { services?: Record<string, { name?: string; description?: string; container?: string; skill_path?: string; territory?: unknown }> };
    const services = parsed.services ?? {};
    const entries: SkillEntry[] = [];
    for (const [id, svc] of Object.entries(services)) {
      const description = typeof svc?.description === "string" ? svc.description.trim() : "";
      if (!description) continue;
      const skillPath = svc.skill_path ? join(repoRoot, svc.skill_path) : join(packDir, "services", id, "SKILL.md");
      // The card tells the agent to OPEN this path. A service whose skill file is missing
      // would otherwise produce a confident instruction that cannot be followed: the agent
      // reads the path, takes ENOENT, and burns a turn. Quiet beats wrong.
      if (!existsSync(skillPath)) continue;
      entries.push({
        id,
        name: svc.name ?? id,
        description,
        skillPath,
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
  const repoRoot = repoRootOf(cwd);
  if (repoRoot === rosterCache.key && now - rosterCache.at < ROSTER_CACHE_TTL_MS) return rosterCache.packs;
  const packs: SkillPack[] = [];
  try {
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
  rosterCache = { at: now, key: repoRoot, packs };
  return packs;
}

/** Reset for tests. */
export function resetRosterCache(): void {
  rosterCache = { at: 0, key: "", packs: [] };
}

/** Nearest ancestor holding `.git`, else the cwd itself. Bounded to 8 levels. */
function repoRootOf(cwd: string): string {
  let dir = cwd;
  for (let guard = 0; guard < 8; guard++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
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
