/**
 * Claude transport adapter (CORE-2434 I3, XT-91 ADR rev 2 + amendment 1).
 *
 * One adapter module speaks Claude Code's cross-session socket behind the I1
 * wake contract: it sends to Claude sessions, receives from Claude sessions,
 * and maps Claude's receipts onto delivered, held and refused. It registers
 * the Pi session in Claude's registry so Pi sessions appear in Claude Code's
 * ListAgents, and it exposes the Claude roster so Claude sessions appear in
 * the Pi roster (the ListAgents tool itself is I4, CORE-2435; SendMessage is
 * I5, CORE-2436).
 *
 * Protocol interoperability credit: pi-claude-link (see ADOPTION-CREDITS.md).
 * Adapted from pi-claude-link under the MIT license — full notice in
 * ./transport.ts.
 *
 * Coexistence: pi-claude-link stays installed until M1 retires it and writes
 * the same `~/.claude/sessions/<pid>.json`. A foreign entry for our pid is
 * never overwritten: the transport prints one operator line and stays off.
 *
 * Inbound Claude messages are peer text: they are injected through the I2
 * envelope path (`injectIntercomWake`) with the D2 provenance line and are
 * never the operator's words. This slice registers no model tools and no
 * commands, and never the names xtrm-ui owns (bash, read, edit, write, find,
 * grep, ls).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WakeDeliveryState } from "@xtrm/contracts";
import { injectIntercomWake, wakeDeliveryOptions, WakeDedupe } from "../delivery.ts";
import { ccSocksDir, listClaudeSessions, type ClaudePeer } from "./registry.ts";
import {
  ackClaudeMessage,
  bindClaudeTransportSocket,
  claimPiPeerEntry,
  deregisterPiPeer,
  peerSocketPath,
  registerPiPeer,
  type BoundClaudeSocket,
  type ClaudeDeliveryOutcome,
} from "./transport.ts";

export {
  buildEnvelope,
  buildReceiptFrame,
  buildUserFrame,
  mapReceiptStatus,
  parseInboundFrame,
  stripEnvelope,
  SUPPORTED_FRAME_VERSION,
  UnknownFrameVersionError,
  UnknownReceiptStatusError,
  type ClaudeDeliveryOutcome,
} from "./protocol.ts";
export {
  ccSocksDir,
  claudeSessionsDir,
  ensureSocketsDir,
  listClaudeSessions,
  pidGuardPasses,
  processStartTime,
  readPeerToken,
  resolveClaudeTarget,
  socketLive,
  toRosterRow,
  type ClaudePeer,
  type ClaudeRosterRow,
} from "./registry.ts";
export {
  ackClaudeMessage,
  bindClaudeTransportSocket,
  claimPiPeerEntry,
  ClaudeReceiptWaiter,
  deregisterPiPeer,
  ownPeerVersion,
  peerSocketPath,
  registerPiPeer,
  sendClaudeFrame,
  sendToClaudeSession,
  updatePiPeer,
} from "./transport.ts";

export interface ClaudeTransportOptions {
  /** Override the socket path (tests, alternate hosts). */
  socketPath?: string;
  /** Override the Claude registry directory (tests). */
  sessionsDir?: string;
}

/**
 * Claude sessions for the Pi roster (I4's ListAgents rows build on this).
 * Never throws: an unreadable registry reads as no Claude peers.
 */
export async function claudeRoster(excludeSock?: string): Promise<ClaudePeer[]> {
  try {
    return await listClaudeSessions(excludeSock ? { excludeSock } : {});
  } catch {
    return [];
  }
}

/** Line printed when a foreign extension owns this session's registry entry. */
export const FOREIGN_ENTRY_LINE =
  "Claude transport inactive: another extension owns this session's registry entry";

/**
 * The ack for one inbound message, answered from the real injection state:
 * delivered after the injection succeeded, held while deferred, refused when
 * the session rejected it. Undelivered and expired have no Claude wire
 * outcome: no receipt goes out and the closing connection is the signal.
 */
export function ackForWakeState(state: WakeDeliveryState): ClaudeDeliveryOutcome | null {
  if (state === "delivered") return "delivered";
  if (state === "held" || state === "queued") return "held";
  if (state === "refused") return "refused";
  return null;
}

export default function claudeTransportExtension(pi: ExtensionAPI, options: ClaudeTransportOptions = {}): void {
  let bound: BoundClaudeSocket | null = null;
  let sockPath = options.socketPath ?? "";
  let ownFrom = "";
  let started = false;
  const dedupe = new WakeDedupe();

  async function start(ctx: ExtensionContext): Promise<void> {
    if (started) return;
    const pid = process.pid;
    const notify = (line: string) => {
      try {
        (ctx.ui as { notify(line: string, level: string): void }).notify(line, "warning");
      } catch {
        /* no UI */
      }
    };
    // Coexistence first: a foreign entry means another extension (pi-claude-link
    // until M1) owns this session's socket. Never overwrite it, never bind its
    // path: print one operator line and keep the transport off.
    const claim = await claimPiPeerEntry(pid, options.sessionsDir).catch(() => null);
    if (!claim) return;
    if (!claim.owned) {
      notify(FOREIGN_ENTRY_LINE);
      return;
    }
    if (!sockPath) sockPath = peerSocketPath(pid, ccSocksDir());
    ownFrom = `uds:${sockPath}`;
    const sessionId = ctx.sessionManager?.getSessionId?.() || undefined;
    const cwd = ctx.cwd || process.cwd();
    let name = "pi-session";
    try {
      name = pi.getSessionName?.() || name;
    } catch {
      /* keep the default */
    }
    try {
      bound = await bindClaudeTransportSocket(sockPath, {
        onUserMessage: (message) => {
          const key = message.messageId || `${message.from ?? "unknown"}:${message.body.slice(0, 64)}`;
          // Duplicate deliveries inject once; a failed injection stays
          // unmarked so a resend can inject (I2 F1 rule, shared vocabulary).
          if (!dedupe.mark(key)) {
            const senderSock = (message.from ?? "").startsWith("uds:")
              ? (message.from as string).slice(4)
              : "";
            if (senderSock && message.messageId) {
              void ackClaudeMessage(senderSock, "delivered", { from: ownFrom, origMessageId: message.messageId });
            }
            return;
          }
          let state: WakeDeliveryState = "delivered";
          try {
            const idle = ctx.isIdle?.() ?? true;
            injectIntercomWake(
              pi as unknown as {
                sendMessage(message: unknown, options?: unknown): void;
              },
              message.messageId || "unknown",
              message.body,
              wakeDeliveryOptions({ idle }),
            );
          } catch {
            dedupe.remove(message.messageId || key);
            state = "refused";
          }
          const ack = ackForWakeState(state);
          const senderSock = (message.from ?? "").startsWith("uds:")
            ? (message.from as string).slice(4)
            : "";
          if (ack && senderSock) {
            void ackClaudeMessage(senderSock, ack, {
              from: ownFrom,
              ...(message.messageId ? { origMessageId: message.messageId } : {}),
            });
          }
        },
        onUnknownVersion: (seen) => {
          const rendered = seen === undefined ? "absent" : JSON.stringify(seen) ?? String(seen);
          notify(`Claude transport: unsupported frame version ${rendered}: this adapter speaks msgV 1`);
        },
      });
      await registerPiPeer({ pid, sessionId, name, cwd, sockPath, status: "idle", sessionsDir: claim.sessionsDir });
      started = true;
    } catch {
      try {
        await bound?.close();
      } catch {
        /* already closed */
      }
      bound = null;
    }
  }

  async function stop(): Promise<void> {
    try {
      await bound?.close();
    } catch {
      /* already closed */
    }
    bound = null;
    await deregisterPiPeer(process.pid, sockPath || undefined, options.sessionsDir).catch(() => {});
  }

  pi.on("session_start", async (_event, ctx) => {
    await start(ctx as ExtensionContext);
  });
  pi.on("session_shutdown", async () => {
    await stop();
  });
}
