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
 * Clean reimplementation; no pi-claude-link code is copied.
 *
 * Inbound Claude messages are peer text: they are injected through the I2
 * envelope path (`injectIntercomWake`) with the D2 provenance line and are
 * never the operator's words. This slice registers no model tools and no
 * commands, and never the names xtrm-ui owns (bash, read, edit, write, find,
 * grep, ls).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { injectIntercomWake, wakeDeliveryOptions, WakeDedupe } from "../delivery.ts";
import { ccSocksDir, listClaudeSessions, type ClaudePeer } from "./registry.ts";
import {
  ackClaudeMessage,
  bindClaudeTransportSocket,
  ClaudeReceiptWaiter,
  deregisterPiPeer,
  peerSocketPath,
  registerPiPeer,
  type BoundClaudeSocket,
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
  ClaudeReceiptWaiter,
  deregisterPiPeer,
  peerSocketPath,
  registerPiPeer,
  sendClaudeFrame,
  sendToClaudeSession,
  updatePiPeer,
} from "./transport.ts";

export interface ClaudeTransportOptions {
  /** Override the socket path (tests, alternate hosts). */
  socketPath?: string;
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

export default function claudeTransportExtension(pi: ExtensionAPI, options: ClaudeTransportOptions = {}): void {
  let bound: BoundClaudeSocket | null = null;
  let sockPath = options.socketPath ?? "";
  let ownFrom = "";
  let started = false;
  const dedupe = new WakeDedupe();
  const receipts = new ClaudeReceiptWaiter();
  void receipts;

  async function start(ctx: ExtensionContext): Promise<void> {
    if (started) return;
    started = true;
    const pid = process.pid;
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
          // Duplicate deliveries inject once; a failed injection stays
          // unmarked so a resend can inject (I2 F1 rule, shared vocabulary).
          if (!dedupe.mark(message.messageId || `${message.from ?? "unknown"}:${message.body.slice(0, 64)}`)) return;
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
            const senderSock = (message.from ?? "").startsWith("uds:")
              ? (message.from as string).slice(4)
              : "";
            if (senderSock) void ackClaudeMessage(senderSock, "delivered", { from: ownFrom });
          } catch {
            dedupe.remove(message.messageId);
          }
        },
        onReceipt: (receipt) => {
          receipts.resolveReceipt(receipt);
        },
      });
      await registerPiPeer({ pid, sessionId, name, cwd, sockPath, status: "idle" });
    } catch {
      started = false;
    }
  }

  async function stop(): Promise<void> {
    try {
      await bound?.close();
    } catch {
      /* already closed */
    }
    bound = null;
    await deregisterPiPeer(process.pid, sockPath || undefined).catch(() => {});
  }

  pi.on("session_start", async (_event, ctx) => {
    await start(ctx as ExtensionContext);
  });
  pi.on("session_shutdown", async () => {
    await stop();
  });
}
