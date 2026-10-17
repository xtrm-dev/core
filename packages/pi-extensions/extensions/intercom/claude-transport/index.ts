/**
 * Claude transport adapter (CORE-2434 I3, XT-91 ADR rev 2 + amendment 1).
 *
 * One adapter module speaks Claude Code's cross-session socket behind the I1
 * wake contract: it sends to Claude sessions, receives from Claude sessions,
 * and maps Claude's receipts onto delivered, held and refused. It can register
 * the Pi session in Claude's registry and exposes the Claude roster so Claude
 * sessions appear in the Pi roster (the ListAgents tool itself is I4,
 * CORE-2435; SendMessage is I5, CORE-2436).
 *
 * Off by default behind `intercom.claudeTransport` (M1 turns it on when it
 * removes pi-claude-link). Until then pi-claude-link owns the registry entry,
 * so "Pi sessions appear in Claude Code's ListAgents" through this adapter
 * is not proven here; that proof moves to M1.
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
  ClaudeReceiptWaiter,
  closeBoundSocket,
  deregisterPiPeer,
  isOwnPeer,
  peerSocketPath,
  readPeerEntry,
  registerPiPeer,
  socketIdentity,
  updatePiPeer,
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
  closeBoundSocket,
  deregisterPiPeer,
  isOwnPeer,
  ownPeerVersion,
  peerSocketPath,
  readPeerEntry,
  registerPiPeer,
  sameSocket,
  sendClaudeFrame,
  sendToClaudeSession,
  socketIdentity,
  updatePiPeer,
} from "./transport.ts";

export interface ClaudeTransportOptions {
  /** Override the socket path (tests, alternate hosts). */
  socketPath?: string;
  /** Override the Claude registry directory (tests). */
  sessionsDir?: string;
  /** Force the transport on/off, winning over the settings key and env (tests, M1). */
  enabled?: boolean;
  /** Test-only hooks. Never set in production. */
  hooks?: {
    /** Runs after registration, before the takeover verification (takeover tests). */
    afterRegister?: () => Promise<void> | void;
    /** Runs once a start fully settles, successful or not (start/stop race tests). */
    afterStart?: () => Promise<void> | void;
    /** Runs once a stop fully settles (start/stop race tests). */
    afterStop?: () => Promise<void> | void;
  };
}

/** Settings key gating the Claude transport. Off by default; M1 turns it on. */
export const CLAUDE_TRANSPORT_SETTING = "intercom.claudeTransport";
/** Environment fallback for the same gate (operators without settings access). */
export const CLAUDE_TRANSPORT_ENV = "INTERCOM_CLAUDE_TRANSPORT";

/**
 * Whether the Claude transport starts. Precedence: explicit option, then the
 * environment fallback, then the `intercom.claudeTransport` settings key;
 * default false.
 */
export function isClaudeTransportEnabled(pi: ExtensionAPI, options: ClaudeTransportOptions = {}): boolean {
  if (options.enabled !== undefined) return options.enabled;
  const env = process.env[CLAUDE_TRANSPORT_ENV];
  if (env !== undefined) {
    if (/^(1|true|on|yes)$/i.test(env.trim())) return true;
    if (/^(0|false|off|no)$/i.test(env.trim())) return false;
  }
  try {
    const settings = pi.getSettings?.() as Record<string, unknown> | undefined;
    const intercom = settings?.intercom as Record<string, unknown> | undefined;
    if (typeof intercom?.claudeTransport === "boolean") return intercom.claudeTransport;
  } catch {
    /* unreadable settings read as off */
  }
  return false;
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

/**
 * Process-wide Claude receipt rendezvous (CORE-2436 I5): SendMessage awaits
 * the async peer_message_status receipt for the frame it just flushed, and
 * the bound socket resolves it here. A receipt with no waiter is dropped.
 */
export const claudeReceipts = new ClaudeReceiptWaiter();

/** Line printed when a foreign extension owns this session's registry entry. */
export const FOREIGN_ENTRY_LINE =
  "Claude transport inactive: another extension owns this session's registry entry";

/** Line printed when another writer takes the socket or entry after we bound. */
export const TAKEOVER_LINE =
  "Claude transport stopped: another extension took over this session's socket or registry entry";

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
  let boundIdentity: { dev: number; ino: number } | null = null;
  let sockPath = options.socketPath ?? "";
  let ownFrom = "";
  let started = false;
  /** An in-flight start(): stop() joins it before closing or deregistering. */
  let starting: Promise<void> | null = null;
  /**
   * Set by stop() while a start() is in flight: the tail winds down
   * quietly (no takeover line, no started flag) instead of racing the
   * shutdown. Reset on every fresh start.
   */
  let abandoned = false;
  const dedupe = new WakeDedupe();

  async function start(ctx: ExtensionContext): Promise<void> {
    if (started) return;
    // One flight at a time: concurrent session_start calls join the same
    // run instead of binding twice.
    starting ??= runStart(ctx).finally(() => {
      starting = null;
    });
    await starting;
  }

  async function runStart(ctx: ExtensionContext): Promise<void> {
    abandoned = false;
    // Off by default behind the settings key; M1 turns it on with pi-claude-link gone.
    if (!isClaudeTransportEnabled(pi, options)) return;
    const pid = process.pid;
    const notify = (line: string) => {
      try {
        (ctx.ui as { notify(line: string, level: string): void }).notify(line, "warning");
      } catch {
        /* no UI */
      }
    };
    const fail = (error: unknown) => {
      notify(`Claude transport unavailable: ${(error as Error)?.message ?? String(error)}`);
    };
    // Coexistence first: a live foreign entry means another extension
    // (pi-claude-link until M1) owns this session's socket. Never overwrite
    // it, never bind its path: print one operator line and stay off.
    let claim;
    try {
      claim = await claimPiPeerEntry(pid, options.sessionsDir);
    } catch (error) {
      fail(error);
      return;
    }
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
              // CORE-2436 I5: the Claude sender rides the from-envelope.
              {
                ...(message.from ? { from: message.from } : {}),
                ...(message.fromName ? { fromName: message.fromName } : {}),
              },
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
        onReceipt: (receipt) => {
          claudeReceipts.resolveReceipt(receipt);
        },
      });
      boundIdentity = await socketIdentity(sockPath).catch(() => null);
      if (!boundIdentity) throw new Error(`Claude transport: socket ${sockPath} is not usable after bind`);
      const hadOwnEntry = isOwnPeer((await readPeerEntry(pid, claim.sessionsDir).catch(() => null)) ?? {});
      if (hadOwnEntry) {
        // Refresh the entry we already own: the session id stays stable.
        await updatePiPeer(pid, { name, status: "idle" }, claim.sessionsDir);
      } else {
        await registerPiPeer({ pid, sessionId, name, cwd, sockPath, status: "idle", sessionsDir: claim.sessionsDir });
      }
      await options.hooks?.afterRegister?.();
      if (abandoned) {
        // A shutdown landed mid-start: wind down quietly. Our socket and
        // entry go only when still ours; a foreign socket or entry is never
        // touched, and no takeover line fires for a race the shutdown won.
        const identity = boundIdentity;
        await closeListener();
        await deregisterPiPeer(pid, sockPath || undefined, claim.sessionsDir, identity).catch(() => {});
        return;
      }
      // Load order is not controlled and pi-claude-link unlinks first: verify
      // after registration that the entry is still ours and the socket is
      // still the one we bound. On a takeover, close without unlinking a
      // path we no longer own, print one operator line, and stay off.
      const entryNow = await readPeerEntry(pid, claim.sessionsDir).catch(() => null);
      const socketNow = await socketIdentity(sockPath).catch(() => null);
      const kept =
        !!entryNow &&
        isOwnPeer(entryNow) &&
        !!socketNow &&
        !!boundIdentity &&
        socketNow.dev === boundIdentity.dev &&
        socketNow.ino === boundIdentity.ino;
      if (!kept) {
        const identity = boundIdentity;
        await closeListener();
        // Drop our entry when it is still ours; the foreign socket is never unlinked.
        await deregisterPiPeer(pid, sockPath || undefined, claim.sessionsDir, identity).catch(() => {});
        if (!abandoned) notify(TAKEOVER_LINE);
        return;
      }
      if (!abandoned) started = true;
    } catch (error) {
      if (!abandoned) fail(error);
      await closeListener();
    } finally {
      await options.hooks?.afterStart?.();
    }
  }

  async function closeListener(): Promise<void> {
    const server = bound;
    const identity = boundIdentity;
    bound = null;
    boundIdentity = null;
    await closeBoundSocket(server, identity);
  }

  async function stop(): Promise<void> {
    // A shutdown racing an in-flight start joins it first: closing or
    // deregistering mid-start corrupts the post-register verify (spurious
    // takeover line) and strands entries. The tail winds down quietly once
    // it sees the abandonment.
    if (starting) {
      abandoned = true;
      await starting;
    }
    const identity = boundIdentity;
    await closeListener();
    await deregisterPiPeer(process.pid, sockPath || undefined, options.sessionsDir, identity).catch(() => {});
    await options.hooks?.afterStop?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    await start(ctx as ExtensionContext);
  });
  pi.on("session_shutdown", async () => {
    await stop();
  });
}
