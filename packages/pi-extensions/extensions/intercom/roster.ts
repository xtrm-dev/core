/**
 * ListAgents roster (CORE-2435 I4, XT-91 ADR rev 2 + amendment 1).
 *
 * One model-only tool, `ListAgents`, prints this session's own name first,
 * then one row per peer — Pi sessions from the agent-host registry and Claude
 * sessions from the Claude transport roster — in Claude Code's exact row and
 * header shape (see the coordinator's observed output quoted in the slice
 * brief: "This session is <name> [<ref>] — …", "Peer sessions (N):",
 * "  <name> [<6-hex ref>]  ·  interactive  ·  idle  ·  tmux …  ·  started …").
 * Rows carry no ANSI and no timestamps in model text (D1, D9).
 *
 * Pi session states render with Claude's words (rev 1 Decision A):
 * working/waiting_for_input read busy, settled reads idle, anything else
 * reads offline. Claude peer states pass through untouched: where Claude
 * shows a value, Claude's word wins.
 *
 * Name resolution is exact-only (R7): an exact session id wins, an exact
 * name resolves, several live sessions under one name throw naming every
 * candidate, and a prefix that is not an exact hit is an error, never a
 * guess. The resolver is shared with I5's SendMessage.
 *
 * Lineage: the own-first header plus the "name [ref] · kind · state ·
 * started" row idea is informed by pi-intercom 0.17.1 `list` and
 * pi-claude-link `list` (ADOPTION-CREDITS.md: principal behaviour source /
 * Claude socket interoperability); the header words, the row shape and the
 * state vocabulary follow Claude Code. Clean reimplementation otherwise.
 *
 * This module never registers the names xtrm-ui owns (bash, read, edit,
 * write, find, grep, ls).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentSessionSummary } from "@xtrm/contracts";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { listClaudeSessions, toRosterRow, type ClaudePeer } from "./claude-transport/index.ts";

/** One peer row in the combined roster. */
export interface RosterRow {
  name: string;
  ref: string;
  kind: string;
  state: string;
  where?: string;
  started?: number;
}

/** A resolvable roster entry (I5's SendMessage reuses this shape). */
export interface RosterEntry {
  kind: "pi" | "claude";
  sessionId?: string;
  name: string;
}

/** Display ref: the leading 6 characters of a session id. */
export function shortRef(id: string): string {
  return id.slice(0, 6);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function clean(value: unknown, max = 1024): string {
  return stripAnsi(typeof value === "string" ? value : "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

/** Relative age in Claude Code's words ("3h ago"). */
export function agoText(startedAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Pi registry states in Claude Code's words (rev 1 Decision A:
 * busy/idle/offline). A session waiting on the operator is still busy;
 * a dead or history-only session reads offline.
 */
export function piSessionStateWord(state: string): string {
  if (state === "working" || state === "waiting_for_input") return "busy";
  if (state === "settled") return "idle";
  return "offline";
}

/** One peer row in Claude Code's shape. Segments without data are omitted, never "undefined". */
export function formatRosterRow(row: RosterRow, now: number = Date.now()): string {
  const name = clean(row.name) || "unknown";
  const segments = [`${name} [${clean(row.ref, 128) || "?"}]`, clean(row.kind) || "?", clean(row.state) || "?"];
  const where = clean(row.where);
  if (where) segments.push(where);
  if (typeof row.started === "number" && Number.isFinite(row.started)) segments.push(`started ${agoText(row.started, now)}`);
  return `  ${segments.join("  ·  ")}`;
}

/** Pi registry summary to a roster row. Kind is always interactive: the same word this session advertises in Claude's registry. */
export function piRosterRow(summary: AgentSessionSummary, _now?: number): RosterRow {
  const ref = shortRef(summary.sessionId);
  const name = clean(summary.name) || `session ${ref}`;
  const tmux = (summary as { tmux?: { session?: string; paneId?: string } }).tmux;
  const where =
    tmux && clean(tmux.session) ? `tmux ${clean(tmux.session)}${clean(tmux.paneId) ? `:${clean(tmux.paneId)}` : ""}` : clean(summary.cwd) || undefined;
  return {
    name,
    ref,
    kind: "interactive",
    state: piSessionStateWord(summary.state),
    ...(where ? { where } : {}),
    ...(typeof summary.startedAt === "number" ? { started: summary.startedAt } : {}),
  };
}

/** Claude peer to a roster row. State passes through: where Claude shows a value, Claude's word wins. */
export function claudeRosterRow(peer: ClaudePeer, _now?: number): RosterRow {
  const base = toRosterRow(peer);
  return {
    name: clean(base.name) || "unknown",
    ref: peer.sessionId ? shortRef(peer.sessionId) : clean(base.ref, 128) || "?",
    kind: clean(base.kind) || "?",
    state: clean(base.state) || "?",
    ...(clean(base.cwd) ? { where: clean(base.cwd) } : {}),
    ...(typeof base.started === "number" ? { started: base.started } : {}),
  };
}

/** Claude Code's own-session header, word for word. */
export function buildOwnLine(own: { sessionId: string; name?: string }): string {
  const name = clean(own.name) || `session ${shortRef(own.sessionId)}`;
  return `This session is ${name} [${shortRef(own.sessionId)}] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).`;
}

/** Full ListAgents text: the own header first, then the peer rows. */
export function buildListAgentsText(own: { sessionId: string; name?: string }, peers: RosterRow[], now: number = Date.now()): string {
  const lines = [buildOwnLine(own), `Peer sessions (${peers.length}):`];
  if (peers.length === 0) lines.push("  No other sessions.");
  else for (const peer of peers) lines.push(formatRosterRow(peer, now));
  return lines.join("\n");
}

export interface BuiltRoster {
  own: { sessionId: string; name?: string };
  peers: RosterRow[];
  entries: RosterEntry[];
  text: string;
}

export interface RosterSources {
  ownSessionId: string;
  ownName?: string;
  piSessions: AgentSessionSummary[];
  claudePeers: ClaudePeer[];
  /** Our own Claude socket: a peer behind it is this session, never a peer. */
  excludeSock?: string;
  now?: number;
}

/**
 * One roster for Pi and Claude sessions alike. The own session heads the
 * text and never appears below it; our own Claude entry (same pid or same
 * socket) is dropped for the same reason. Peers sort newest first; rows
 * without a start time sort last, stable.
 */
export function buildRoster(sources: RosterSources): BuiltRoster {
  const now = sources.now ?? Date.now();
  const own = { sessionId: sources.ownSessionId, ...(sources.ownName ? { name: sources.ownName } : {}) };
  const pairs: Array<{ row: RosterRow; entry: RosterEntry }> = [];
  for (const summary of sources.piSessions) {
    if (summary.sessionId === sources.ownSessionId) continue;
    pairs.push({
      row: piRosterRow(summary, now),
      entry: { kind: "pi", sessionId: summary.sessionId, name: clean(summary.name) || `session ${shortRef(summary.sessionId)}` },
    });
  }
  for (const peer of sources.claudePeers) {
    if (peer.pid === process.pid) continue;
    if (sources.excludeSock && peer.sock === sources.excludeSock) continue;
    pairs.push({
      row: claudeRosterRow(peer, now),
      entry: { kind: "claude", ...(peer.sessionId ? { sessionId: peer.sessionId } : {}), name: clean(peer.name) || "unknown" },
    });
  }
  // Newest first; rows without a start time sort last, stable.
  pairs.sort((a, b) => {
    const aStarted = typeof a.row.started === "number" ? a.row.started : -1;
    const bStarted = typeof b.row.started === "number" ? b.row.started : -1;
    return bStarted - aStarted;
  });
  const peers = pairs.map((pair) => pair.row);
  const entries = pairs.map((pair) => pair.entry);
  return { own, peers, entries, text: buildListAgentsText(own, peers, now) };
}

export interface ResolveMiss {
  target?: undefined;
  error: string;
  candidates: string[];
}

/**
 * R7: exact session id wins, else an exact name. Several live sessions
 * under one name throw naming every candidate; a prefix that is not an
 * exact hit is an error, never a guess.
 */
export function resolveRosterTarget(entries: RosterEntry[], nameOrId: string): { target: RosterEntry } | ResolveMiss {
  const byId = entries.find((entry) => entry.sessionId === nameOrId);
  if (byId) return { target: byId };
  const named = entries.filter((entry) => entry.name === nameOrId);
  if (named.length > 1) {
    // Full session ids: the caller disambiguates by session id instead.
    const candidates = named.map((entry) => `${entry.name} [${entry.sessionId ?? entry.kind}]`).join(", ");
    throw new Error(`ambiguous session "${nameOrId}": ${candidates}`);
  }
  const hit = named[0];
  if (!hit) {
    return {
      error: `no live session matches "${nameOrId}"`,
      candidates: [...new Set(entries.map((entry) => entry.name))],
    };
  }
  return { target: hit };
}

function defaultAgentHostInfoPath(): string {
  return path.join(os.homedir(), ".xtrm", "run", "agent-host.json");
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address.toLowerCase() === "localhost";
}

export interface FetchPiSessionsOptions {
  infoPath?: string;
  address?: string;
  port?: number;
  timeoutMs?: number;
}

/**
 * Live Pi sessions from the agent host's loopback API (GET /v1/sessions).
 * Never throws: no host, no info file, or a bad reply reads as no Pi
 * sessions. Only loopback addresses are ever dialled.
 */
export async function fetchPiSessions(options: FetchPiSessionsOptions = {}): Promise<AgentSessionSummary[]> {
  const timeoutMs = options.timeoutMs ?? 2000;
  let address = options.address;
  let port = options.port;
  if (address === undefined || port === undefined) {
    let info: { address?: unknown; port?: unknown } | null = null;
    try {
      info = JSON.parse(readFileSync(options.infoPath ?? defaultAgentHostInfoPath(), "utf8")) as { address?: unknown; port?: unknown };
    } catch {
      return [];
    }
    address ??= typeof info?.address === "string" ? info.address : undefined;
    port ??= typeof info?.port === "number" ? info.port : undefined;
  }
  if (typeof address !== "string" || !isLoopbackAddress(address) || typeof port !== "number" || !(port > 0 && port < 65536)) {
    return [];
  }
  return new Promise((resolve) => {
    const done = (sessions: AgentSessionSummary[]) => resolve(sessions);
    let settled = false;
    const finish = (sessions: AgentSessionSummary[]) => {
      if (!settled) {
        settled = true;
        done(sessions);
      }
    };
    const req = httpRequest({ host: address, port, path: "/v1/sessions", method: "GET", timeout: timeoutMs }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > 4 * 1024 * 1024) res.destroy();
      });
      res.on("end", () => {
        try {
          const reply = JSON.parse(text) as { kind?: unknown; sessions?: unknown };
          if (reply.kind === "session_list" && Array.isArray(reply.sessions)) finish(reply.sessions as AgentSessionSummary[]);
          else finish([]);
        } catch {
          finish([]);
        }
      });
    });
    req.on("error", () => finish([]));
    req.on("timeout", () => {
      req.destroy();
      finish([]);
    });
    req.end();
  });
}

export interface ListAgentsDeps {
  fetchPi?: () => Promise<AgentSessionSummary[]>;
  fetchClaude?: (excludeSock?: string) => Promise<ClaudePeer[]>;
  excludeSock?: string;
  now?: () => number;
}

/** The model-only ListAgents tool. No parameters, like Claude Code's. */
export function registerListAgentsTool(pi: ExtensionAPI, deps: ListAgentsDeps = {}): void {
  pi.registerTool({
    name: "ListAgents",
    label: "ListAgents",
    description:
      "List live Pi and Claude Code sessions on this machine. This session prints first, then one row per peer: name [ref] · kind · state · started. Address a peer by its exact name or session id.",
    parameters: Type.Object({}),
    exposure: "model-only",
    execute: async (_toolCallId: string, _params: Record<string, never>, _signal: unknown, _onUpdate: unknown, ctx?: { sessionManager?: { getSessionId?: () => string } }) => {
      const ownSessionId = ctx?.sessionManager?.getSessionId?.() ?? "session";
      let ownName: string | undefined;
      try {
        ownName = pi.getSessionName?.() || undefined;
      } catch {
        ownName = undefined;
      }
      const [piSessions, claudePeers] = await Promise.all([
        (deps.fetchPi ?? (() => fetchPiSessions()))().catch(() => [] as AgentSessionSummary[]),
        (deps.fetchClaude ?? ((excludeSock?: string) => listClaudeSessions(excludeSock ? { excludeSock } : {})))(deps.excludeSock).catch(
          () => [] as ClaudePeer[],
        ),
      ]);
      const built = buildRoster({
        ownSessionId,
        ...(ownName ? { ownName } : {}),
        piSessions,
        claudePeers,
        ...(deps.excludeSock ? { excludeSock: deps.excludeSock } : {}),
        ...(deps.now ? { now: deps.now() } : {}),
      });
      return {
        content: [{ type: "text" as const, text: built.text }],
        details: { roster: { peers: built.peers.length, total: built.peers.length + 1 } },
      };
    },
  });
}
