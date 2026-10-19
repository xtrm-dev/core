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
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { listClaudeSessions, toRosterRow, type ClaudePeer } from "./claude-transport/index.ts";
import { intercomTrace } from "./trace.ts";

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
  /**
   * Live Claude-protocol socket of a Claude peer (ListAgents prints it as
   * the uds: address; the resolver matches `uds:<sock>` against it).
   * Never set on Pi entries: Pi peers relay through shadowSock instead.
   */
  sock?: string;
  /**
   * Substrate issue ref of the session's claimed work, when the session
   * reports one (CORE-2437 scoped routing: the project key). Claude peers
   * carry no Substrate identity and never match a scope.
   */
  workItemRef?: string;
  /** Repository identity (CORE-2437 scoped routing: the programme key). */
  repository?: string;
  /** Checkout root fallback for the programme key. */
  repositoryPath?: string;
  /**
   * Live Claude-protocol socket of a Pi session's own listener (CORE-2470).
   * A Pi peer whose host-registry record lags still resolves as Pi, and
   * SendMessage may relay through this socket when the Pi route is down.
   * Never set on Claude entries.
   */
  shadowSock?: string;
  /**
   * Host-registry extension state at roster time (CORE-2479). False means
   * the Pi wake leg is definitively unroutable, so SendMessage relays via
   * shadowSock instead of parking held. Undefined for Claude entries and
   * memoized Pi ids, where no Pi route was ever observed.
   */
  extensionConnected?: boolean;
  /**
   * CORE-2488 phase 1: which source produced `sock`, so a refused `uds:`
   * address can say where the socket did (or did not) come from. Absent when
   * the entry carries no socket.
   */
  sockSource?: string;
  /**
   * CORE-2488 phase 1: whether a live socket proved this Claude peer
   * reachable at roster time. `live` with no `sock` is the diagnostic: the
   * socket was proved live and then did not ride the entry.
   */
  live?: boolean;
}

/**
 * Display ref: the first 6 hex of sha256(sessionId). Pi ids are UUIDv7,
 * so the leading characters collide for every session started within
 * hours of each other; the hash spreads them. Opaque by design: our refs
 * do not equal Claude Code's own refs.
 */
export function sessionRef(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 6);
}

/**
 * The ref ListAgents prints for one entry: sessionRef(sessionId) for Pi
 * entries, sessionRef(sessionId ?? sock) for Claude peers — the same
 * function claudeRosterRow uses, so the resolver matches what the roster
 * shows. Falls back to the name hash when neither exists (never "?").
 */
export function entryDisplayRef(entry: Pick<RosterEntry, "sessionId" | "sock" | "name">): string {
  const id = entry.sessionId ?? entry.sock;
  return sessionRef(id ?? entry.name);
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

/** Host summary to a roster row. Kind follows the summary's provider (CORE-2479): Pi rows name the Pi leg, while claude/codex rows read claude so a wake never parks held behind a dead extension while a live socket goes untried. Claude socket peers keep their advertised kind via claudeRosterRow. The where segment is tmux only, in Claude's shape; anything else is omitted, never the cwd. */
export function piRosterRow(summary: AgentSessionSummary, _now?: number): RosterRow {
  const ref = sessionRef(summary.sessionId);
  const name = clean(summary.name) || `session ${ref}`;
  const tmux = (summary as { tmux?: { session?: string; paneId?: string } }).tmux;
  const session = clean(tmux?.session);
  const paneId = clean(tmux?.paneId);
  const where = session ? `tmux ${session}${paneId ? `:${paneId}` : ""}` : undefined;
  return {
    name,
    ref,
    kind: summary.provider === "claude" || summary.provider === "codex" ? "claude" : "pi",
    state: piSessionStateWord(summary.state),
    ...(where ? { where } : {}),
    ...(typeof summary.startedAt === "number" ? { started: summary.startedAt } : {}),
  };
}

/** Claude peer to a roster row. State passes through: where Claude shows a value, Claude's word wins. The where segment is Claude's own tmux locator, verbatim; anything else is omitted, never the cwd. Refs are opaque hashes, not Claude's refs. */
export function claudeRosterRow(peer: ClaudePeer, _now?: number): RosterRow {
  const base = toRosterRow(peer);
  const tmux = clean(base.tmux);
  return {
    name: clean(base.name) || "unknown",
    ref: sessionRef(peer.sessionId ?? peer.sock),
    kind: clean(base.kind) || "?",
    state: clean(base.state) || "?",
    ...(tmux ? { where: `tmux ${tmux}` } : {}),
    ...(typeof base.started === "number" ? { started: base.started } : {}),
  };
}

/** Claude Code's own-session header, word for word. */
export function buildOwnLine(own: { sessionId: string; name?: string }): string {
  const name = clean(own.name) || `session ${sessionRef(own.sessionId)}`;
  return `This session is ${name} [${sessionRef(own.sessionId)}] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).`;
}

/** Full ListAgents text: the own header first, then the peer rows. */
export function buildListAgentsText(own: { sessionId: string; name?: string }, peers: RosterRow[], now: number = Date.now()): string {
  const lines = [buildOwnLine(own), `Peer sessions (${peers.length}):`];
  if (peers.length === 0) lines.push("  No other sessions.");
  else for (const peer of peers) lines.push(formatRosterRow(peer, now));
  return lines.join("\n");
}

/**
 * Only live Pi sessions list: history_only rows (journal replays from the
 * session index) and failed ones are not addressable peers, so they stay
 * out of the roster and the resolver alike.
 */
export const LIVE_PI_STATES = new Set(["working", "waiting_for_input", "settled"]);

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
 * socket) is dropped for the same reason. A Pi session that also has a
 * Claude entry lists once, from the host registry: Claude rows whose
 * session id already listed are dropped, so R7 never
 * throws "ambiguous" on a session's own duplicate. Only live Pi sessions
 * list (LIVE_PI_STATES). Peers sort newest first; rows without a start
 * time sort last, stable.
 */
/** How long a Pi session seen live still counts as Pi while the host registry lags or flaps (CORE-2470). */
export const RECENT_PI_TTL_MS = 15 * 60 * 1000;
/** sessionId -> { name, seenAt }: recently-live Pi sessions. Pruned per build. */
const recentPi = new Map<string, { name: string; seenAt: number }>();
/** Test seam: clear the recently-live Pi memo. */
export function __resetRecentPi(): void {
  recentPi.clear();
}

export function buildRoster(sources: RosterSources): BuiltRoster {
  const now = sources.now ?? Date.now();
  const own = { sessionId: sources.ownSessionId, ...(sources.ownName ? { name: sources.ownName } : {}) };
  const pairs: Array<{ row: RosterRow; entry: RosterEntry }> = [];
  const listedSessionIds = new Set<string>([sources.ownSessionId]);
  // CORE-2479: the host lists every bound runtime, not just Pi. Only
  // provider "pi" rows read Pi; any other provider (claude/codex) waits
  // below and lists with its true leg, so a wake never parks held behind
  // a dead extension while a live socket goes untried.
  const hostNonPi = new Map<string, AgentSessionSummary>();
  for (const summary of sources.piSessions) {
    if (listedSessionIds.has(summary.sessionId)) continue;
    if (!LIVE_PI_STATES.has(summary.state)) continue;
    if (summary.provider === "claude" || summary.provider === "codex") {
      if (!hostNonPi.has(summary.sessionId)) hostNonPi.set(summary.sessionId, summary);
      continue;
    }
    listedSessionIds.add(summary.sessionId);
    const workItemRef = clean(summary.workItem?.ref);
    const repository = clean(summary.repository);
    const repositoryPath = clean(summary.repositoryPath);
    pairs.push({
      row: piRosterRow(summary, now),
      entry: {
        kind: "pi",
        sessionId: summary.sessionId,
        name: clean(summary.name) || `session ${sessionRef(summary.sessionId)}`,
        ...(workItemRef ? { workItemRef } : {}),
        ...(repository ? { repository } : {}),
        ...(repositoryPath ? { repositoryPath } : {}),
        ...(typeof summary.extensionConnected === "boolean" ? { extensionConnected: summary.extensionConnected } : {}),
      },
    });
  }
  // CORE-2470: remember live Pi identities so a registry lag never
  // re-resolves a Pi session as a Claude peer through its shadow socket.
  for (const [id, seen] of recentPi) {
    if (now - seen.seenAt > RECENT_PI_TTL_MS) recentPi.delete(id);
  }
  for (const summary of sources.piSessions) {
    if (!LIVE_PI_STATES.has(summary.state)) continue;
    // A Claude host record must never memoize as Pi: the memo is the
    // registry-lag backstop for the Pi leg only.
    if (summary.provider === "claude" || summary.provider === "codex") continue;
    if (typeof summary.sessionId === "string" && summary.sessionId) {
      recentPi.set(summary.sessionId, {
        name: clean(summary.name) || `session ${sessionRef(summary.sessionId)}`,
        seenAt: now,
      });
    }
  }
  const piById = new Map<string, RosterEntry>();
  for (const pair of pairs) {
    if (pair.entry.sessionId) piById.set(pair.entry.sessionId, pair.entry);
  }
  for (const peer of sources.claudePeers) {
    if (peer.pid === process.pid) continue;
    if (sources.excludeSock && peer.sock === sources.excludeSock) continue;
    // A session already listed from the host registry never lists twice:
    // the Pi entry stands and keeps the live socket as its relay.
    const listed = peer.sessionId ? piById.get(peer.sessionId) : undefined;
    if (listed) {
      if (peer.sock && !listed.shadowSock) listed.shadowSock = peer.sock;
      continue;
    }
    // CORE-2479: dual registration — the host holds a non-Pi record for
    // the same session the socket serves. The live socket leg stands and
    // the host row drops, so the session lists once, as Claude, and
    // SendMessage takes the socket instead of a held Pi wake.
    const hostLeg = peer.sessionId ? hostNonPi.get(peer.sessionId) : undefined;
    if (hostLeg) {
      hostNonPi.delete(hostLeg.sessionId);
      pairs.push({
        row: claudeRosterRow(peer, now),
        // CORE-2488: the live socket rides this branch too. A host-held peer
        // whose socket is live is addressable by the uds: address it itself
        // reports; dropping the socket left it name-only and refused every
        // uds: target in under a second. `live` still rides along so the trace
        // keeps saying whether a socket was proved reachable.
        entry: {
          kind: "claude",
          ...(peer.sessionId ? { sessionId: peer.sessionId } : {}),
          name: clean(peer.name) || "unknown",
          sock: peer.sock,
          ...(peer.sockSource ? { sockSource: peer.sockSource } : {}),
          ...(peer.live !== undefined ? { live: peer.live } : {}),
        },
      });
      continue;
    }
    if (peer.sessionId && listedSessionIds.has(peer.sessionId)) continue;
    // Registry lags but this id was Pi minutes ago: resolve as Pi with
    // the shadow relay, never as a Claude peer.
    const memo = peer.sessionId ? recentPi.get(peer.sessionId) : undefined;
    if (memo && peer.sock && peer.sessionId) {
      const name = memo.name;
      pairs.push({
        row: { name, ref: sessionRef(peer.sessionId), kind: "pi", state: clean(peer.status) || "recent" },
        entry: { kind: "pi", sessionId: peer.sessionId, name, shadowSock: peer.sock },
      });
      listedSessionIds.add(peer.sessionId);
      continue;
    }
    if (peer.sessionId) listedSessionIds.add(peer.sessionId);
    pairs.push({
      row: claudeRosterRow(peer, now),
      // The sock rides along so `uds:<sock>` resolves exactly (MMD-2538:
      // ListAgents prints refs for Claude peers but SendMessage could not
      // address them by the socket address the peer itself reports).
      entry: { kind: "claude", ...(peer.sessionId ? { sessionId: peer.sessionId } : {}), name: clean(peer.name) || "unknown", sock: peer.sock, ...(peer.sockSource ? { sockSource: peer.sockSource } : {}), ...(peer.live !== undefined ? { live: peer.live } : {}) },
    });
  }
  // CORE-2479: host non-Pi records with no live socket still list, with
  // their true leg. No socket means SendMessage fails loudly (no
  // reachable Claude socket) instead of silently parking held.
  // Claude-leg entries carry no Substrate identity and never match a
  // scope, like Claude socket peers.
  for (const summary of hostNonPi.values()) {
    pairs.push({
      row: piRosterRow(summary, now),
      entry: {
        kind: "claude",
        sessionId: summary.sessionId,
        name: clean(summary.name) || `session ${sessionRef(summary.sessionId)}`,
      },
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

/** Display leg of a roster entry: Pi sessions read Pi, everything else Claude. */
export function legWord(kind: RosterEntry["kind"]): string {
  return kind === "pi" ? "Pi" : "Claude";
}

/**
 * R7: exact session id wins, then an exact `uds:<sock>` socket address,
 * then an exact 6-hex ref, then an exact name. Several live sessions
 * under one address throw naming every candidate; a unique prefix of 4+
 * chars over sessionId/ref/name resolves, a shared prefix throws, and
 * anything else is a miss listing every candidate with its ref — never a
 * guess (MMD-2538: same-name peers across legs must refuse, not pick).
 */
export function resolveRosterTarget(entries: RosterEntry[], nameOrId: string): { target: RosterEntry } | ResolveMiss {
  const byId = entries.find((entry) => entry.sessionId === nameOrId);
  if (byId) return { target: byId };
  // ListAgents prints Claude sockets as uds: addresses and the Claude leg
  // sends its own uds: address as from: match sock/shadowSock exactly.
  if (nameOrId.startsWith("uds:")) {
    const sock = nameOrId.slice(4);
    if (sock) {
      const bySock = entries.filter((entry) => entry.sock === sock || entry.shadowSock === sock);
      if (bySock.length === 1) return { target: bySock[0] };
      if (bySock.length > 1) throw new Error(`ambiguous session "${nameOrId}": ${nameCandidates(bySock)}`);
    }
  } else if (/^[0-9a-fA-F]{6}$/.test(nameOrId)) {
    // The 6-hex ref ListAgents prints next to each name (opaque hash,
    // not an id prefix): exact, case-insensitive, never a prefix guess.
    const want = nameOrId.toLowerCase();
    const byRef = entries.filter((entry) => entryDisplayRef(entry) === want);
    if (byRef.length === 1) return { target: byRef[0] };
    if (byRef.length > 1) throw new Error(`ambiguous session "${nameOrId}": ${nameCandidates(byRef)}`);
  }
  const named = entries.filter((entry) => entry.name === nameOrId);
  if (named.length > 1) {
    throw new Error(`ambiguous session "${nameOrId}": ${nameCandidates(named)}`);
  }
  const hit = named[0];
  if (hit) return { target: hit };
  // Unique-prefix arm (4+ chars, like a git short hash): exactly one
  // sessionId/ref/name prefix resolves; a shared prefix throws naming
  // every candidate. Shorter inputs stay a miss, never a guess.
  if (nameOrId.length >= 4 && !nameOrId.startsWith("uds:")) {
    const lower = nameOrId.toLowerCase();
    const prefixed = entries.filter(
      (entry) =>
        (entry.sessionId !== undefined && entry.sessionId.startsWith(nameOrId)) ||
        entryDisplayRef(entry).startsWith(lower) ||
        entry.name.startsWith(nameOrId),
    );
    if (prefixed.length === 1) return { target: prefixed[0] };
    if (prefixed.length > 1) {
      throw new Error(`ambiguous session "${nameOrId}": ${nameCandidates(prefixed)}`);
    }
  }
  // Every candidate with its ref and leg: same-name peers must stay
  // distinguishable (MMD-2538 printed one row per name and hid the rest).
  // CORE-2488 phase 1: a miss also records the attempted key and, for the
  // closest candidates, the socket/id/liveness facts that explain the miss
  // (`live=true sock=none` is a proved-live socket that did not ride the entry).
  intercomTrace("roster.miss", { key: nameOrId, entries: entries.length });
  for (const candidate of closestEntries(entries, nameOrId)) {
    intercomTrace("roster.miss.candidate", {
      key: nameOrId,
      name: candidate.name,
      ref: entryDisplayRef(candidate),
      kind: candidate.kind,
      sessionId: candidate.sessionId,
      sock: candidate.sock,
      sockSource: candidate.sockSource,
      live: candidate.live,
    });
  }
  return {
    error: `no live session matches "${nameOrId}"`,
    candidates: entries.map((entry) => `${entry.name} [${entryDisplayRef(entry)}] (${legWord(entry.kind)} session)`),
  };
}

/**
 * Closest entries for a miss, best first (CORE-2488 phase 1 diagnostics only:
 * resolution never uses this). Score is the longest shared case-insensitive
 * prefix against the entry's name, session id, display ref, sock or shadow
 * sock; entries sharing fewer than three characters are not candidates. A
 * uds: key scores Claude entries at a floor of one instead, because a Claude
 * entry with no socket is itself the explanation of the miss.
 */
function closestEntries(entries: RosterEntry[], key: string): RosterEntry[] {
  const wanted = key.toLowerCase().replace(/^uds:/, "");
  const uds = key.startsWith("uds:");
  return entries
    .map((entry) => ({
      entry,
      score: Math.max(
        sharedPrefix(wanted, [entry.name, entry.sessionId, entryDisplayRef(entry), entry.sock, entry.shadowSock]),
        // A uds: miss is about socket-bearing legs, so a Claude entry with no
        // socket is itself the explanation: a proved-live socket that did not
        // ride the entry. It stays a candidate at the floor score.
        uds && entry.kind === "claude" ? 1 : 0,
      ),
    }))
    .filter((row) => row.score >= (uds ? 1 : 3))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((row) => row.entry);
}

function sharedPrefix(wanted: string, values: Array<string | undefined>): number {
  let best = 0;
  for (const value of values) {
    if (!value) continue;
    const candidate = value.toLowerCase();
    let shared = 0;
    while (shared < wanted.length && shared < candidate.length && wanted[shared] === candidate[shared]) shared += 1;
    if (shared > best) best = shared;
  }
  return best;
}

/** Full session ids survive in ambiguity errors: the caller disambiguates by session id instead. */
function nameCandidates(entries: RosterEntry[]): string {
  return entries.map((entry) => `${entry.name} [${entry.sessionId ?? entryDisplayRef(entry)}] (${legWord(entry.kind)} session)`).join(", ");
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
 * Only loopback addresses are ever dialled. No host info, a non-loopback
 * address, or a well-formed-but-unexpected reply reads as no Pi sessions.
 * A transport failure on both attempts throws: the roster must fail loud
 * instead of resolving against a silent partial list (MMD-2538 flapped
 * between Pi and Claude legs while the host lagged).
 *
 * Timeout basis: /v1/sessions is a loopback read of the in-memory live
 * registry (p99 single-digit ms on an unloaded host); 2000 ms plus one
 * bounded retry covers a loaded host without stalling the model path.
 * The 15-minute recent-Pi memo stays a lag-cover only: it keeps a Pi id
 * resolving as Pi across one missed fetch, never as a second authority.
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
  // One attempt. Transport failures (error/timeout) report transportError;
  // a well-formed but unexpected reply reads as an empty list, never an error.
  const attempt = (): Promise<{ sessions: AgentSessionSummary[]; transportError: boolean }> =>
    new Promise((resolve) => {
      const done = (sessions: AgentSessionSummary[], transportError: boolean) => resolve({ sessions, transportError });
      let settled = false;
      const finish = (sessions: AgentSessionSummary[], transportError = false) => {
        if (!settled) {
          settled = true;
          done(sessions, transportError);
        }
      };
      // CORE-2470: no pooled keep-alive on loopback control calls. The host
      // closes idle keep-alive sockets after its keepAliveTimeout while the
      // client pool still hands them out; reusing one races ECONNRESET and
      // reads as an empty session list, which silently routes Pi peers via
      // their Claude shadow. A fresh loopback connection costs ~0.1 ms.
      const req = httpRequest({ host: address, port, path: "/v1/sessions", method: "GET", timeout: timeoutMs, agent: false }, (res) => {
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
      req.on("error", () => finish([], true));
      req.on("timeout", () => {
        req.destroy();
        finish([], true);
      });
      req.end();
    });
  const first = await attempt();
  if (!first.transportError) return first.sessions;
  // CORE-2470: a transient stall (slow host under load) reads as "no Pi
  // sessions" and silently routes Pi peers via their Claude shadow. One
  // bounded retry; a persistent failure throws (fail-closed) so callers
  // surface a loud registry error instead of a partial roster.
  await new Promise((r) => setTimeout(r, 500));
  const second = await attempt();
  if (!second.transportError) return second.sessions;
  throw new Error("could not reach the agent host registry (GET /v1/sessions failed twice)");
}

export interface ListAgentsDeps {
  fetchPi?: () => Promise<AgentSessionSummary[]>;
  fetchClaude?: (excludeSock?: string) => Promise<ClaudePeer[]>;
  excludeSock?: string;
  now?: () => number;
}

/** Details shape of the ListAgents result: a roster count, or an error flag. */
export interface ListAgentsDetails {
  roster?: { peers: number; total: number };
  error?: boolean;
}

/** The model-only ListAgents tool. No parameters, like Claude Code's. */
export function registerListAgentsTool(pi: ExtensionAPI, deps: ListAgentsDeps = {}): void {
  pi.registerTool({
    name: "ListAgents",
    label: "ListAgents",
    description:
      "List live Pi and Claude Code sessions on this machine. This session prints first, then one row per peer: name [ref] · kind · state · started. Address a peer by its exact name, exact session id, 6-hex ref, unique 4+ char prefix of name/id/ref, or uds: socket. Call this before SendMessage, and at session start with tmux list-windows and gh pr list.",
    parameters: Type.Object({}),
    exposure: "model-only",
    execute: async (
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: unknown,
      _onUpdate: unknown,
      ctx?: { sessionManager?: { getSessionId?: () => string } },
    ): Promise<{ content: [{ type: "text"; text: string }]; details: ListAgentsDetails; isError?: boolean }> => {
      // No fallback id: a roster without the real own id would list the own
      // session as a peer and misresolve names.
      let ownSessionId: string | undefined;
      try {
        ownSessionId = ctx?.sessionManager?.getSessionId?.();
      } catch {
        ownSessionId = undefined;
      }
      if (!ownSessionId) {
        return {
          content: [{ type: "text" as const, text: "ListAgents needs the current session id, and none was available." }],
          details: { error: true },
          isError: true,
        };
      }
      let ownName: string | undefined;
      try {
        ownName = pi.getSessionName?.() || undefined;
      } catch {
        ownName = undefined;
      }
      let piSessions: AgentSessionSummary[];
      try {
        piSessions = await (deps.fetchPi ?? (() => fetchPiSessions()))();
      } catch (error) {
        // Fail-closed (MMD-2538): a down registry is a loud error, never
        // a partial roster that silently drops every Pi peer.
        return {
          content: [{ type: "text" as const, text: `ListAgents cannot reach the agent host registry: ${(error as Error)?.message ?? String(error)}. The roster is unavailable rather than partial.` }],
          details: { error: true },
          isError: true,
        };
      }
      // A missing Claude registry reads as no Claude peers (no registry
      // means no peers); a down Pi registry above is the loud failure.
      const claudePeers = await (deps.fetchClaude ?? ((excludeSock?: string) => listClaudeSessions(excludeSock ? { excludeSock } : {})))(deps.excludeSock).catch(
        () => [] as ClaudePeer[],
      );
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
