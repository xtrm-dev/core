/**
 * Claude transport socket I/O (CORE-2434 I3, XT-91 ADR rev 2 + amendment 1).
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

import { chmod, mkdir, unlink, writeFile, readFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
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
  await sendClaudeFrame(options.sock, frame, { authToken: options.authToken, timeoutMs: options.timeoutMs });
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
  const dir = path.dirname(sockPath);
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
  await chmod(dir, 0o700).catch(() => {});
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
            handlers.onUserMessage?.({
              messageId: parsed.messageId,
              body: stripped.body,
              from: parsed.from ?? stripped.from,
              ...(stripped.fromName ? { fromName: stripped.fromName } : {}),
              ...(stripped.fromMode ? { fromMode: stripped.fromMode } : {}),
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
  await chmod(sockPath, 0o600).catch(() => {});
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
 * Await Claude's async receipts for sent messages, keyed by the original
 * message id. Rejects on timeout instead of hanging a turn.
 */
export class ClaudeReceiptWaiter {
  private readonly pending = new Map<string, (receipt: ClaudeReceipt) => void>();

  wait(messageId: string, timeoutMs = 30_000): Promise<ClaudeDeliveryOutcome> {
    return new Promise<ClaudeDeliveryOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`timed out waiting for a Claude receipt for message ${messageId}`));
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
  cwd: string;
  sockPath: string;
  status?: string;
}

/**
 * Register this Pi session in Claude's registry so it appears in Claude
 * Code's ListAgents. Same file shape Claude writes for its own sessions;
 * `procStart` is the `ps lstart` form, which the pid-reuse guard treats as
 * opaque (pid match alone).
 */
export async function registerPiPeer(registration: PiPeerRegistration): Promise<void> {
  const { mkdir: makeDir } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const sessionsDir = path.join(osHomedir(), ".claude", "sessions");
  await makeDir(sessionsDir, { recursive: true }).catch(() => {});
  const procStart = await new Promise<string | undefined>((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(registration.pid)], (error, stdout) => {
      resolve(error ? undefined : String(stdout).trim() || undefined);
    });
  });
  const entry = {
    pid: registration.pid,
    sessionId: registration.sessionId || randomUUID(),
    cwd: registration.cwd || process.cwd(),
    startedAt: Date.now(),
    ...(procStart ? { procStart } : {}),
    version: "xtrm-intercom",
    peerProtocol: 1,
    kind: "interactive",
    entrypoint: "pi",
    messagingSocketPath: registration.sockPath,
    name: registration.name,
    nameSource: "derived",
    status: registration.status || "idle",
  };
  await writeFile(path.join(sessionsDir, `${registration.pid}.json`), JSON.stringify(entry, null, 2));
}

function osHomedir(): string {
  return process.env.HOME || os.homedir();
}

/** Patch one live Pi peer entry (name, status) without touching the socket. */
export async function updatePiPeer(pid: number, patch: { name?: string; status?: string }): Promise<void> {
  const sessionsDir = path.join(osHomedir(), ".claude", "sessions");
  const file = path.join(sessionsDir, `${pid}.json`);
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  await writeFile(file, JSON.stringify({ ...current, ...patch }, null, 2));
}

/** Remove the Pi peer entry and socket on shutdown. */
export async function deregisterPiPeer(pid: number, sockPath?: string): Promise<void> {
  const sessionsDir = path.join(osHomedir(), ".claude", "sessions");
  await unlink(path.join(sessionsDir, `${pid}.json`)).catch(() => {});
  if (sockPath) await unlink(sockPath).catch(() => {});
}

/** Default socket path for one pid inside Claude's socket directory. */
export function peerSocketPath(pid: number, socketsDir: string): string {
  return path.join(socketsDir, `${pid}.sock`);
}
