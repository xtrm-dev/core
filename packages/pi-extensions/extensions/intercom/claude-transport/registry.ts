/**
 * Claude session registry reading (CORE-2434 I3, XT-91 ADR rev 2 + amendment 1).
 *
 * Reads `~/.claude/sessions/<pid>.json` so Claude sessions appear in the Pi
 * roster (I4 builds the ListAgents tool on top of this; this slice exposes
 * the roster function only). The pid-reuse guard mirrors
 * `cli/src/core/dispatcher-identity.ts` (`readSessionEntry` /
 * `findLiveDispatchers`, CORE-2432 R8): a dead pid is skipped, a numeric
 * `procStart` that disagrees with the live process start time means the pid
 * was reused, and a probe failure keeps the entry (unknown, not dead). Do not
 * let the two guards diverge.
 *
 * Resolution is exact-only: R7 forbids the prefix name fallback, so a name
 * prefix never matches.
 */

import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

export interface ClaudePeer {
  pid?: number;
  sessionId?: string;
  name: string;
  cwd: string;
  status: string;
  kind?: string;
  startedAt?: number;
  sock: string;
  live?: boolean;
}

/** Pi-roster row shape for a Claude session (I4's ListAgents rows build on this). */
export interface ClaudeRosterRow {
  name: string;
  ref: string;
  kind: string;
  state: string;
  started?: number;
  cwd: string;
}

export function claudeSessionsDir(): string {
  return path.join(os.homedir(), ".claude", "sessions");
}

/**
 * The directory Claude binds its own sockets in. Discovered from a registry
 * entry so our socket co-locates with Claude's (receipts only flow between
 * siblings); falls back to `$XDG_RUNTIME_DIR/cc-socks` else `/tmp/cc-socks-<uid>`.
 */
export function ccSocksDir(sessionsDir: string = claudeSessionsDir()): string {
  try {
    for (const file of readdirSync(sessionsDir)) {
      if (!/^\d+\.json$/.test(file)) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(readFileSync(path.join(sessionsDir, file), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof entry.messagingSocketPath === "string" && entry.messagingSocketPath.endsWith(".sock")) {
        return path.dirname(entry.messagingSocketPath as string);
      }
    }
  } catch {
    /* registry missing */
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const base = process.env.XDG_RUNTIME_DIR || "/tmp";
  return base === "/tmp" ? path.join(base, `cc-socks-${uid}`) : path.join(base, "cc-socks");
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Kernel start time (clock ticks) for one pid; undefined when unknowable. */
export function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTime = fields[19];
    return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pid-reuse guard (mirrors dispatcher-identity.ts): false for a dead pid and
 * for a numeric procStart that disagrees with the live start time; true when
 * the pid is alive and either carries no numeric procStart (for example a
 * `ps lstart` date string, which cannot be compared to ticks) or agrees.
 * A /proc probe failure keeps the entry: unknown, not dead.
 */
export function pidGuardPasses(entry: Record<string, unknown>): boolean {
  if (typeof entry.pid !== "number") return true;
  const procStart = clean(entry.procStart);
  const filePid = Number(path.basename(String(entry.__file ?? "")).replace(/\.json$/, ""));
  if (Number.isInteger(filePid) && entry.pid !== filePid) return false;
  let stat: string | null = null;
  try {
    stat = readFileSync(`/proc/${entry.pid}/stat`, "utf8");
  } catch {
    return false;
  }
  if (!stat) return false;
  if (procStart && /^\d+$/.test(procStart)) {
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const liveStart = fields[19];
    if (liveStart && procStart !== liveStart) return false;
  }
  return true;
}

function entryToPeer(entry: Record<string, unknown>): ClaudePeer | null {
  const sock = clean(entry.messagingSocketPath);
  if (!sock) return null;
  const name = clean(entry.name) ?? (typeof entry.pid === "number" ? `pid ${entry.pid}` : "unknown");
  return {
    ...(typeof entry.pid === "number" ? { pid: entry.pid } : {}),
    ...(clean(entry.sessionId) ? { sessionId: clean(entry.sessionId) as string } : {}),
    name: name as string,
    cwd: clean(entry.cwd) ?? "?",
    status: clean(entry.status) ?? "unknown",
    ...(clean(entry.kind) ? { kind: clean(entry.kind) as string } : {}),
    ...(typeof entry.startedAt === "number" ? { startedAt: entry.startedAt } : {}),
    sock: sock as string,
  };
}

/** One-shot connect probe: true only when the socket accepts. */
export function socketLive(sock: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    if (!sock) return resolve(false);
    const conn = connect({ path: sock });
    const done = (value: boolean) => {
      try {
        conn.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    conn.setTimeout(timeoutMs, () => done(false));
    conn.on("connect", () => done(true));
    conn.on("error", () => done(false));
  });
}

export interface ListClaudeSessionsOptions {
  sessionsDir?: string;
  excludeSock?: string;
  checkLive?: boolean;
  liveTimeoutMs?: number;
}

/**
 * All addressable Claude peers: registry entries with a messaging socket that
 * pass the pid-reuse guard, excluding our own socket. With `checkLive`
 * (default) only sockets that accept a connection list, newest first.
 */
export async function listClaudeSessions(options: ListClaudeSessionsOptions = {}): Promise<ClaudePeer[]> {
  const sessionsDir = options.sessionsDir ?? claudeSessionsDir();
  const checkLive = options.checkLive ?? true;
  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((file) => /^\d+\.json$/.test(file));
  } catch {
    return [];
  }
  const rows: ClaudePeer[] = [];
  for (const file of files) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(readFileSync(path.join(sessionsDir, file), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    entry.__file = file;
    if (!pidGuardPasses(entry)) continue;
    const peer = entryToPeer(entry);
    if (!peer || (options.excludeSock && peer.sock === options.excludeSock)) continue;
    rows.push(peer);
  }
  if (checkLive) {
    await Promise.all(
      rows.map(async (row) => {
        row.live = await socketLive(row.sock, options.liveTimeoutMs);
      }),
    );
    return rows.filter((row) => row.live).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }
  return rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export interface ResolveClaudeTargetResult {
  target?: ClaudePeer;
  error?: string;
  candidates?: string[];
}

/**
 * Resolve a target by exact session name or exact session id. R7: no prefix
 * fallback — a prefix that is not an exact hit is an error, never a guess.
 */
export function resolveClaudeTarget(peers: ClaudePeer[], nameOrId: string): ResolveClaudeTargetResult {
  const hit =
    peers.find((row) => row.sessionId === nameOrId) || peers.find((row) => row.name === nameOrId);
  if (!hit) {
    return {
      error: `no live Claude session matches "${nameOrId}"`,
      candidates: peers.map((row) => row.name),
    };
  }
  return { target: hit };
}

/** Pi-roster row for one Claude peer; names follow Claude's own vocabulary. */
export function toRosterRow(peer: ClaudePeer): ClaudeRosterRow {
  return {
    name: peer.name,
    ref: peer.sessionId ?? peer.sock,
    kind: peer.kind ?? "claude",
    state: peer.status,
    ...(peer.startedAt !== undefined ? { started: peer.startedAt } : {}),
    cwd: peer.cwd,
  };
}

/**
 * Read the pairing token for one Claude socket from its sidecar key file
 * (`<pid>.<hash>.key`, JSON with `peerToken`). The token stays in memory
 * only: callers must never log or print it.
 */
export async function readPeerToken(sessionsDir: string, pid: number): Promise<string | undefined> {
  const { readdir, readFile } = await import("node:fs/promises");
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return undefined;
  }
  const sidecar = files.find((file) => file.startsWith(`${pid}.`) && file.endsWith(".key"));
  if (!sidecar) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path.join(sessionsDir, sidecar), "utf8")) as Record<string, unknown>;
    return typeof parsed.peerToken === "string" && parsed.peerToken ? parsed.peerToken : undefined;
  } catch {
    return undefined;
  }
}
