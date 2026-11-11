/**
 * skill-suggest worker for Claude Code (CORE-2594).
 *
 * One process per eligible user prompt; it exits when done. The Python monitor
 * owns delivery (turn state, epoch, caps); this process owns the decision and
 * runs the one shared judge (packages/pi-extensions/shared/judge.ts), so Pi and
 * Claude decide identically.
 *
 * stdin : {"sid","epoch","cwd","prompt"}
 * stdout: exactly one JSON line, {"outcome":"fire","pick","score","nudge"} or
 *         {"outcome":"skip","reason"}. Nothing else is ever written to stdout.
 * Fail-open: every error is a skip row, never an exception.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { judge } from "../../pi-extensions/shared/judge.ts";
import { discoverRoster, repoRootOf, type RosterEntry } from "../../pi-extensions/shared/roster.ts";
import { type RetrievalIndex, type ServiceRecord, buildRetrievalIndex, loadServices } from "../../pi-extensions/shared/shortlist.ts";
import { createJsonlLog } from "../../pi-extensions/shared/jsonl-log.ts";
import { primeApiKey, readApiKey } from "../../pi-extensions/shared/suggest.ts";

export const NUDGE_MAX = 600;
const STAGE_TIMEOUT_MS = 1800; // two stages: worst case 3.6 s, under the monitor's hard 4 s kill
const ROSTER_TTL_MS = 5 * 60_000;

const logDir = (): string => process.env["SKILL_SUGGEST_LOG_DIR"] ?? join(homedir(), ".xtrm", "skill-suggest");
const cacheDir = (): string => process.env["SKILL_SUGGEST_CACHE_DIR"] ?? join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "xtrm-skill-suggest");
const log = createJsonlLog(logDir);

interface Cached { at: number; cwd: string; repoRoot: string; entries: RosterEntry[]; services: ServiceRecord[] }

/** The roster and service registry, cached on disk so each worker skips the ~0.7 s discovery. */
export async function loadIndex(cwd: string, now = Date.now()): Promise<{ index: RetrievalIndex<RosterEntry>; cached: boolean }> {
  const file = join(cacheDir(), `roster-${createHash("sha1").update(cwd).digest("hex").slice(0, 12)}.json`);
  try {
    const c = JSON.parse(await readFile(file, "utf8")) as Cached;
    if (c.cwd === cwd && now - c.at < ROSTER_TTL_MS && Array.isArray(c.entries) && c.entries.length > 0) {
      return { index: buildRetrievalIndex(c.entries, c.services ?? [], c.repoRoot, cwd), cached: true };
    }
  } catch { /* miss or corrupt: rebuild */ }
  const repoRoot = await repoRootOf(cwd);
  const [entries, services] = await Promise.all([discoverRoster(cwd), loadServices(repoRoot)]);
  try {
    await mkdir(cacheDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ at: now, cwd, repoRoot, entries, services } satisfies Cached));
    await rename(tmp, file); // atomic: a concurrent worker never reads a half file
  } catch { /* the cache is an optimisation */ }
  return { index: buildRetrievalIndex(entries, services, repoRoot, cwd), cached: false };
}

const oneLine = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

/** The absolute path a nudge names; repo-local roster entries carry repo-relative paths. */
export const absolutePath = (entry: RosterEntry, cwd: string): string => (isAbsolute(entry.path) ? entry.path : resolve(cwd, entry.path));

/** The nudge: one line (a monitor line is one notification), an absolute path, the rule text, at most NUDGE_MAX characters. */
export function nudgeText(entry: RosterEntry, cwd: string): string {
  const path = absolutePath(entry, cwd); // the nudge must name a path the agent can open from anywhere
  const what = entry.level === "skill" ? `skill "${entry.skill}"` : `reference "${entry.name}" of skill "${entry.skill}"`;
  const tail = " Ignore it if it does not fit.";
  const head = `[skill-suggest] This request may call for ${what}: `;
  const read = ` Read ${path} before you start.`;
  const room = NUDGE_MAX - head.length - read.length - tail.length - 1;
  return `${head}${oneLine(entry.description, Math.max(40, room)).replace(/[.\s]+$/, "")}.${read}${tail}`.slice(0, NUDGE_MAX);
}

/** PRD 12b structured context: the claimed Issue ref, the last few tool names, and the files in play (service territory). */
export interface WorkerInput { sid?: string; epoch?: string; cwd: string; prompt: string; issue?: string | null; tools?: string[]; files?: string[] }
export type WorkerOutput = { outcome: "fire"; pick: string; score: number | null; nudge: string; path: string; model: string | null } | { outcome: "skip"; reason: string };

export async function run(input: WorkerInput): Promise<WorkerOutput> {
  const base = { ts: new Date().toISOString(), host: "claude", seam: "input", sid: input.sid ?? null, epoch: input.epoch ?? null };
  const skip = (reason: string, extra: Record<string, unknown> = {}): WorkerOutput => {
    log.append({ ...base, outcome: "skip", reason, ...extra });
    return { outcome: "skip", reason };
  };
  try {
    await primeApiKey();
    if (!readApiKey()) return skip("no_key");
    const { index, cached } = await loadIndex(input.cwd);
    const tools = (input.tools ?? []).filter((t) => typeof t === "string").slice(-5);
    const files = (input.files ?? []).filter((f) => typeof f === "string").slice(-10);
    const state: Record<string, unknown> = { request: input.prompt.slice(0, 2000), recent_conversation: "", cwd: input.cwd };
    if (typeof input.issue === "string" && input.issue) state["claimed_issue"] = input.issue;
    if (tools.length) state["recent_tools"] = tools.join(", ");
    const j = await judge("input", null, index, state, { text: input.prompt, files }, STAGE_TIMEOUT_MS);
    const facts = { prompt_chars: input.prompt.length, roster_cached: cached, ctx_tools: tools.length, ctx_files: files.length, ctx_issue: Boolean(input.issue), ...j.facts };
    if (j.skip !== null) return skip(j.skip, facts);
    if (!j.entry) {
      log.append({ ...base, pick: j.pick ?? "none", outcome: "abstain", reason: j.reason, injected: false, ...facts });
      return { outcome: "skip", reason: j.reason };
    }
    log.append({ ...base, pick: j.entry.id, outcome: "fire", reason: "fire", injected: false, ...facts });
    return { outcome: "fire", pick: j.entry.id, score: j.score, nudge: nudgeText(j.entry, input.cwd), path: absolutePath(j.entry, input.cwd), model: j.model };
  } catch (e) {
    return skip(`error:${(e as Error)?.name ?? "unknown"}`);
  }
}

if (import.meta.main) {
  let out: WorkerOutput = { outcome: "skip", reason: "bad_input" };
  try {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WorkerInput;
    if (typeof input.cwd === "string" && typeof input.prompt === "string") out = await run(input);
  } catch { /* bad_input */ }
  await log.flush();
  process.stdout.write(JSON.stringify(out) + "\n");
}
