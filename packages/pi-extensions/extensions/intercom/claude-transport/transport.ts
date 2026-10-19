/**
 * Claude transport socket I/O (CORE-2434 I3, XT-91 ADR rev 2 + amendment 1).
 *
 * Adapted from pi-claude-link (https://github.com/alonw0/pi-claude-link,
 * claude-protocol.ts) under the MIT license; behaviour credit is also
 * recorded in ADOPTION-CREDITS.md. The socket lifecycle (bind, NDJSON
 * framing, auth first line, registry entry read/write), the msgV: 1 user
 * frames and the peer_message_status receipts follow pi-claude-link; the
 * version gate, the exact-only resolution, the I1 delivery mapping and the
 * I2 injection path are XTRM-owned. No pi-claude-link code is copied
 * verbatim.
 *
 * MIT License
 *
 * Copyright (c) 2026 alonw0
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Speaks Claude Code's cross-session socket behind the I1 wake contract:
 * send a user frame to a Claude session, receive user frames from Claude
 * sessions, and map Claude's `peer_message_status` receipts onto the I1
 * delivery vocabulary (delivered, held, refused). Frame parsing and the
 * version gate live in ./protocol.ts; registry reading lives in ./registry.ts.
 *
 * Security: inbound Claude messages are peer text. They are escaped through
 * the I2 envelope path before they reach the model and are never the
 * operator's words. An auth token, when the target socket requires one, is
 * passed through in memory only and never logged or printed.
 */

import { chmod, unlink, writeFile, readFile, rename } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { claudeSessionsDir, ensureSocketsDir, pidGuardPasses, processStartTime, readPeerToken } from "./registry.ts";
import intercomPkg from "../package.json" with { type: "json" };
import {
  buildReceiptFrame,
  buildUserFrame,
  mapReceiptStatus,
  MAX_FRAME_LINE,
  parseInboundFrame,
  stripEnvelope,
  type ClaudeDeliveryOutcome,
} from "./protocol.ts";

export type { ClaudeDeliveryOutcome };

export interface SendToClaudeOptions {
  sock: string;
  body: string;
  from?: string;
  fromName?: string;
  fromMode?: string;
  priority?: string;
  sessionId?: string;
  messageId?: string;
  /** Optional pairing token for sockets that require an auth first line. Memory only. */
  authToken?: string;
  /** Read the pairing token from the registry sidecar for this pid (memory only). */
  authFromRegistry?: { sessionsDir?: string; pid: number };
  timeoutMs?: number;
}

/** Optional auth first line for sockets that require pairing. */
function authLine(token: string): string {
  return `${JSON.stringify({ type: "auth", token })}\n`;
}

/**
 * Send one frame to a Claude socket (connect, optional auth line, JSON line,
 * close). Resolves with the frame's message id once the bytes are flushed.
 */
export function sendClaudeFrame(
  sock: string,
  frame: Record<string, unknown>,
  options: { authToken?: string; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const conn = connect({ path: sock });
    const fail = (error: Error) => {
      try {
        conn.destroy();
      } catch {
        /* already gone */
      }
      reject(error);
    };
    conn.setTimeout(timeoutMs, () => fail(new Error(`timed out connecting to ${sock}`)));
    conn.on("error", fail);
    conn.on("connect", () => {
      const payload = (options.authToken ? authLine(options.authToken) : "") + `${JSON.stringify(frame)}\n`;
      conn.end(payload, () => resolve(typeof frame.msg_id === "string" ? frame.msg_id : ""));
    });
  });
}

/**
 * High-level send: wrap the body in Claude's envelope and deliver one user
 * frame to the target socket. The delivery outcome (delivered/held/refused)
 * arrives asynchronously as a receipt on our own socket; use
 * ClaudeReceiptWaiter to await it.
 */
export async function sendToClaudeSession(options: SendToClaudeOptions): Promise<string> {
  const { frame, messageId } = buildUserFrame({
    body: options.body,
    ...(options.from ? { from: options.from } : {}),
    ...(options.fromName ? { fromName: options.fromName } : {}),
    ...(options.fromMode ? { fromMode: options.fromMode } : {}),
    ...(options.messageId ? { messageId: options.messageId } : {}),
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  });
  let authToken = options.authToken;
  if (!authToken && options.authFromRegistry) {
    authToken = await readPeerToken(
      options.authFromRegistry.sessionsDir ?? claudeSessionsDir(),
      options.authFromRegistry.pid,
    );
  }
  await sendClaudeFrame(options.sock, frame, {
    ...(authToken ? { authToken } : {}),
    timeoutMs: options.timeoutMs,
  });
  return messageId;
}

/** Send a `peer_message_status` ack back to the sender's socket. Best effort. */
export function ackClaudeMessage(
  senderSock: string,
  status: ClaudeDeliveryOutcome,
  options: { from?: string; origMessageId?: string; reason?: string } = {},
): Promise<string> {
  return sendClaudeFrame(
    senderSock,
    buildReceiptFrame({
      status,
      ...(options.from ? { from: options.from } : {}),
      ...(options.origMessageId ? { origMessageId: options.origMessageId } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    }),
  ).catch(() => "");
}

export interface ClaudeUserMessage {
  messageId: string;
  body: string;
  from?: string;
  fromName?: string;
  fromMode?: string;
  /** Top-level frame session_id when the sender carries one (registry join key). */
  sessionId?: string;
}

export interface ClaudeReceipt {
  status: ClaudeDeliveryOutcome;
  origMessageId?: string;
  from?: string;
  reason?: string;
}

export interface ClaudeTransportHandlers {
  onUserMessage?: (message: ClaudeUserMessage) => void;
  onReceipt?: (receipt: ClaudeReceipt) => void;
  onUnknownVersion?: (seen: unknown) => void;
}

export interface BoundClaudeSocket {
  server: Server;
  sockPath: string;
  close(): Promise<void>;
}

/**
 * Bind one listening UDS socket that speaks Claude's NDJSON framing. Every
 * line is version-gated: an unknown version is reported through
 * `onUnknownVersion` (loud, with the version seen) and the line is dropped;
 * the connection stays open for the remaining lines. Receipts resolve through
 * `onReceipt` after mapping; user frames arrive envelope-stripped through
 * `onUserMessage`.
 *
 * The socket closes its side when the sender half-closes, so the sender's
 * send resolves instead of timing out.
 */
export async function bindClaudeTransportSocket(
  sockPath: string,
  handlers: ClaudeTransportHandlers = {},
): Promise<BoundClaudeSocket> {
  await ensureSocketsDir(path.dirname(sockPath));
  await unlink(sockPath).catch(() => {});
  const server = createServer((conn: Socket) => {
    conn.setEncoding("utf8");
    let buffer = "";
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_LINE) {
        conn.destroy();
        buffer = "";
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let decoded: unknown;
        try {
          decoded = JSON.parse(line);
        } catch {
          continue;
        }
        // An auth line carries no msgV and is not a frame: skip it quietly.
        if (
          typeof decoded === "object" &&
          decoded !== null &&
          (decoded as Record<string, unknown>).type === "auth" &&
          !("msgV" in (decoded as Record<string, unknown>))
        ) {
          continue;
        }
        try {
          const parsed = parseInboundFrame(decoded);
          if (parsed.kind === "user") {
            const stripped = stripEnvelope(parsed.content);
            const frameSessionId = (parsed.frame as Record<string, unknown> | undefined)?.session_id;
            handlers.onUserMessage?.({
              messageId: parsed.messageId,
              body: stripped.body,
              from: parsed.from ?? stripped.from,
              ...(stripped.fromName ? { fromName: stripped.fromName } : {}),
              ...(stripped.fromMode ? { fromMode: stripped.fromMode } : {}),
              ...(typeof frameSessionId === "string" && frameSessionId ? { sessionId: frameSessionId } : {}),
            });
          } else if (parsed.kind === "receipt") {
            handlers.onReceipt?.({
              status: mapReceiptStatus(parsed.status),
              ...(parsed.origMessageId ? { origMessageId: parsed.origMessageId } : {}),
              ...(parsed.from ? { from: parsed.from } : {}),
              ...(parsed.reason ? { reason: parsed.reason } : {}),
            });
          }
        } catch (error) {
          handlers.onUnknownVersion?.(
            error instanceof Error && "seen" in error ? (error as { seen: unknown }).seen : error,
          );
        }
      }
    });
    conn.on("end", () => {
      try {
        conn.end();
      } catch {
        /* already closed */
      }
    });
    conn.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    await chmod(sockPath, 0o600);
  } catch (error) {
    server.close();
    throw new Error(`Claude transport: cannot secure socket ${sockPath}: ${(error as Error).message}`);
  }
  return {
    server,
    sockPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * A receipt wait that outlived its budget (CORE-2465). The frame was
 * flushed; only the async receipt is missing, so callers must report
 * unconfirmed — never failed — and must not invite a retry.
 */
export class ClaudeReceiptTimeoutError extends Error {
  readonly messageId: string;
  constructor(messageId: string) {
    super(`timed out waiting for a Claude receipt for message ${messageId}`);
    this.name = "ClaudeReceiptTimeoutError";
    this.messageId = messageId;
  }
}

/** True for a starved receipt wait (frame flushed, outcome unknown). */
export function isClaudeReceiptTimeout(error: unknown): boolean {
  return error instanceof ClaudeReceiptTimeoutError;
}

/**
 * Await Claude's async receipts for sent messages, keyed by the original
 * message id. Rejects on timeout instead of hanging a turn.
 */
export class ClaudeReceiptWaiter {
  private readonly pending = new Map<string, (receipt: ClaudeReceipt) => void>();

  wait(messageId: string, timeoutMs = 30_000): Promise<ClaudeDeliveryOutcome> {
    return new Promise<ClaudeDeliveryOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new ClaudeReceiptTimeoutError(messageId));
      }, timeoutMs);
      this.pending.set(messageId, (receipt) => {
        clearTimeout(timer);
        this.pending.delete(messageId);
        try {
          resolve(mapReceiptStatus(receipt.status));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  resolveReceipt(receipt: ClaudeReceipt): boolean {
    if (!receipt.origMessageId) return false;
    const waiter = this.pending.get(receipt.origMessageId);
    if (!waiter) return false;
    waiter(receipt);
    return true;
  }

  get size(): number {
    return this.pending.size;
  }
}

export interface PiPeerRegistration {
  pid: number;
  sessionId?: string;
  name: string;
  /** Whether the name was chosen by a human (`user`) or fell back (`derived`).
   * Claude's /list-agents withholds names (and directories) not chosen by a
   * human, so operator-named Pi sessions must advertise `user` to appear
   * named; the `pi-session` fallback stays `derived`. */
  nameSource?: string;
  cwd: string;
  sockPath: string;
  status?: string;
  /** Registry directory override (tests). */
  sessionsDir?: string;
}

export interface PiPeerClaim {
  owned: boolean;
  sessionsDir: string;
}

/** This adapter's registry marker: `intercom <xtrm-intercom package version>`. */
export function ownPeerVersion(): string {
  return `intercom ${(intercomPkg as { version?: string }).version ?? "0.0.0"}`;
}

function peerFile(sessionsDir: string, pid: number): string {
  return path.join(sessionsDir, `${pid}.json`);
}

function isOwnPeerEntry(entry: Record<string, unknown>): boolean {
  return typeof entry.version === "string" && entry.version.startsWith("intercom ");
}

export { isOwnPeerEntry as isOwnPeer };

/** Read one pid's registry entry, or null when absent/unreadable. */
export async function readPeerEntry(
  pid: number,
  sessionsDir?: string,
): Promise<Record<string, unknown> | null> {
  const dir = sessionsDir ?? path.join(osHomedir(), ".claude", "sessions");
  try {
    return JSON.parse(await readFile(peerFile(dir, pid), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Identity of one socket path (lstat: never follows a symlink). Null when absent or not a socket. */
export async function socketIdentity(sockPath: string): Promise<{ dev: number; ino: number } | null> {
  const { lstat } = await import("node:fs/promises");
  try {
    const stat = await lstat(sockPath);
    if (!stat.isSocket() || stat.isSymbolicLink()) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/** True while the socket at this path is still the one we bound. */
export async function sameSocket(
  sockPath: string,
  identity: { dev: number; ino: number },
): Promise<boolean> {
  const now = await socketIdentity(sockPath);
  return !!now && now.dev === identity.dev && now.ino === identity.ino;
}

/** Atomically replace one registry file (tmp + rename, mode 0600). */
async function writeEntryAtomic(file: string, entry: Record<string, unknown>): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * Claim this pid's registry entry. A live foreign entry (written by another
 * extension, whose pid passes the guard) is never overwritten: the claim reports unowned and the
 * caller keeps the transport off. An absent entry, an owned one, or a stale
 * foreign entry (dead pid or procStart mismatch: litter, not a peer) is
 * owned and may be written.
 */
export async function claimPiPeerEntry(pid: number, sessionsDir?: string): Promise<PiPeerClaim> {
  const dir = sessionsDir ?? path.join(osHomedir(), ".claude", "sessions");
  const current = await readPeerEntry(pid, dir);
  if (!current || isOwnPeerEntry(current)) return { owned: true, sessionsDir: dir };
  const stale = !pidGuardPasses(current, pid);
  return { owned: stale, sessionsDir: dir };
}

/**
 * Register this Pi session in Claude's registry so it appears in Claude
 * Code's ListAgents. Same file shape Claude writes for its own sessions;
 * `procStart` is the numeric kernel start time, which the pid-reuse guard
 * compares directly. Throws when the entry is foreign-owned (see
 * claimPiPeerEntry): callers check ownership first.
 */
export async function registerPiPeer(registration: PiPeerRegistration): Promise<void> {
  const { mkdir: makeDir } = await import("node:fs/promises");
  const dir = registration.sessionsDir ?? path.join(osHomedir(), ".claude", "sessions");
  await makeDir(dir, { recursive: true });
  const claim = await claimPiPeerEntry(registration.pid, dir);
  if (!claim.owned) {
    throw new Error(
      `Claude transport: refusing to overwrite the registry entry for pid ${registration.pid}: another extension owns it`,
    );
  }
  const procStart = processStartTime(registration.pid);
  const entry = {
    pid: registration.pid,
    sessionId: registration.sessionId || randomUUID(),
    cwd: registration.cwd || process.cwd(),
    startedAt: Date.now(),
    ...(procStart ? { procStart } : {}),
    version: ownPeerVersion(),
    peerProtocol: 1,
    kind: "interactive",
    entrypoint: "pi",
    messagingSocketPath: registration.sockPath,
    name: registration.name,
    nameSource: registration.nameSource ?? "derived",
    status: registration.status || "idle",
  };
  await writeEntryAtomic(peerFile(dir, registration.pid), entry);
}

function osHomedir(): string {
  return process.env.HOME || os.homedir();
}

/** Patch one live Pi peer entry (name, status) without touching the socket. Foreign entries are left alone. */
export async function updatePiPeer(
  pid: number,
  patch: { name?: string; status?: string; nameSource?: string },
  sessionsDir?: string,
): Promise<void> {
  const dir = sessionsDir ?? path.join(osHomedir(), ".claude", "sessions");
  const file = peerFile(dir, pid);
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!isOwnPeerEntry(current)) return;
  await writeEntryAtomic(file, { ...current, ...patch });
}

/** Remove the Pi peer entry and socket on shutdown. The entry goes only when
 * it is still ours; the socket goes only when its identity still matches a
 * bound socket we pass in. A missing/unreadable entry removes nothing. */
export async function deregisterPiPeer(
  pid: number,
  sockPath?: string,
  sessionsDir?: string,
  identity?: { dev: number; ino: number } | null,
): Promise<void> {
  const dir = sessionsDir ?? path.join(osHomedir(), ".claude", "sessions");
  const file = peerFile(dir, pid);
  const current = await readPeerEntry(pid, dir);
  if (!current || !isOwnPeerEntry(current)) return;
  await unlink(file).catch(() => {});
  if (sockPath && identity && (await sameSocket(sockPath, identity).catch(() => false))) {
    await unlink(sockPath).catch(() => {});
  }
}

/**
 * Close a bound socket without unlinking a path we no longer own.
 * `server.close()` unlinks the socket path unconditionally, so a foreign
 * path (taken over after our bind) must never be closed: our orphaned
 * listener is left for the session teardown instead. Absent paths and our
 * own socket close normally.
 */
export async function closeBoundSocket(
  bound: BoundClaudeSocket | null,
  identity: { dev: number; ino: number } | null,
): Promise<void> {
  if (!bound) return;
  if (identity) {
    const { lstat } = await import("node:fs/promises");
    const exists = await lstat(bound.sockPath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const now = await socketIdentity(bound.sockPath);
      if (!now || now.dev !== identity.dev || now.ino !== identity.ino) return;
    }
  }
  try {
    await bound.close();
  } catch {
    /* already closed */
  }
}

/** Default socket path for one pid inside Claude's socket directory. */
export function peerSocketPath(pid: number, socketsDir: string): string {
  return path.join(socketsDir, `${pid}.sock`);
}
