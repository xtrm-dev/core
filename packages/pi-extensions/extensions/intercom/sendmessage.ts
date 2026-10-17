/**
 * SendMessage model tool (CORE-2436 I5, XT-91 ADR rev 2 + amendment 1, D-2).
 *
 * One model-only tool, `SendMessage`, with Claude Code's parameters
 * (to, message, summary, notify_when_idle) plus the D-2 ask options
 * (expect_reply, timeout_s) and two threading options (reply_to, cancel).
 * Attachments stay out: they are I6 (CORE-2437), not this slice.
 *
 * Routing: names resolve through I4's resolveRosterTarget (exact only, R7).
 * Pi targets go through the tracked registry wake (POST /v1/wake: held,
 * expiry, flush and dedupe live in the registry, not here); Claude targets
 * go through the I3 send path with the receipt waiter, and fail loudly when
 * the Claude transport is off. The sender sees the delivery state in the
 * tool result; held, refused and undelivered arrive as bracketed
 * [Cross-session delivery notice] lines in Claude's bracket style (D8).
 * notify_when_idle arms one idle notice (or the 12 h expiry notice),
 * delivered back to the subscribing session when it settles.
 *
 * Pending asks and noticed undelivered messages feed the I4 waiting store
 * (intercomWaiting) and trigger a footer redraw, so the chip shows only
 * while something waits. Replies arrive through the bridge's wake-injected
 * hook and resolve the waiting ask by replyTo.
 *
 * Lineage: ask-with-timeout, pending asks and cancel are informed by
 * pi-intercom 0.17.1 (ADOPTION-CREDITS.md: principal behaviour source);
 * the transport, envelope and state vocabulary follow Claude Code.
 * Clean reimplementation otherwise.
 *
 * This module never registers the names xtrm-ui owns (bash, read, edit,
 * write, find, grep, ls). Model payloads carry no ANSI and no timestamps.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentSessionSummary, WakeDeliveryState, WakeResult } from "@xtrm/contracts";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { onWakeInjected, type InjectedWakeNotice } from "../xtrm-agent-host/index.ts";
import { requestFooterRender } from "../custom-footer/index.ts";
import { buildIntercomWakeContent } from "./delivery.ts";
import { buildRoster, fetchPiSessions, resolveRosterTarget, type RosterEntry } from "./roster.ts";
import {
  claudeReceipts,
  isClaudeTransportEnabled,
  listClaudeSessions,
  sendToClaudeSession,
  type ClaudeDeliveryOutcome,
  type ClaudePeer,
} from "./claude-transport/index.ts";
import { intercomWaiting } from "./waiting.ts";

/** 12 h idle-notice subscription TTL, as Claude Code's expiry (Q2). */
export const IDLE_SUBSCRIPTION_TTL_MS = 12 * 3600 * 1000;
/** Upper bound on one message: the receiver envelope carries it whole. */
export const MAX_MESSAGE_BYTES = 8 * 1024;
/** Upper bound on the summary preview. */
export const MAX_SUMMARY_BYTES = 512;
/** Default ask wait, and the hard ceiling for one wait. */
export const DEFAULT_ASK_TIMEOUT_S = 300;
export const MAX_ASK_TIMEOUT_S = 3600;
/** Long-poll budget for a queued wake to settle before answering. */
export const DEFAULT_SETTLE_WAIT_MS = 5000;

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function clean(value: unknown, max = 1024): string {
  return stripAnsi(typeof value === "string" ? value : "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

function defaultAgentHostInfoPath(): string {
  return path.join(os.homedir(), ".xtrm", "run", "agent-host.json");
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address.toLowerCase() === "localhost";
}

function readAgentHostAddress(infoPath?: string): { address: string; port: number } | null {
  try {
    const info = JSON.parse(readFileSync(infoPath ?? defaultAgentHostInfoPath(), "utf8")) as {
      address?: unknown;
      port?: unknown;
    };
    if (typeof info.address !== "string" || !isLoopbackAddress(info.address)) return null;
    if (typeof info.port !== "number" || !(info.port > 0 && info.port < 65536)) return null;
    return { address: info.address, port: info.port };
  } catch {
    return null;
  }
}

export interface WakeSendRequest {
  participant: string;
  payloadRef: string;
  messageId: string;
  from?: string;
  fromName?: string;
  fromSessionId?: string;
  replyTo?: string;
  notifyWhenIdle?: boolean;
}

function httpJson(
  method: string,
  host: { address: string; port: number },
  urlPath: string,
  body: string | undefined,
  timeoutMs = 10_000,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: host.address,
        port: host.port,
        path: urlPath,
        method,
        timeout: timeoutMs,
        headers: body !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 1024 * 1024) res.destroy();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timed out reaching the agent host"));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function defaultPostWake(req: WakeSendRequest, infoPath?: string): Promise<WakeResult> {
  const host = readAgentHostAddress(infoPath);
  if (!host) throw new Error("no agent host is running on this machine");
  const { status, text } = await httpJson("POST", host, "/v1/wake", JSON.stringify(req));
  if (status !== 200) throw new Error(`the agent host refused the wake (http ${status}): ${text.slice(0, 256)}`);
  const reply = JSON.parse(text) as WakeResult;
  if (!reply || typeof reply.messageId !== "string" || typeof reply.state !== "string") {
    throw new Error("the agent host answered with an unreadable wake result");
  }
  return reply;
}

async function defaultWakeStatus(messageId: string, infoPath?: string): Promise<WakeResult | null> {
  const host = readAgentHostAddress(infoPath);
  if (!host) return null;
  try {
    const { status, text } = await httpJson("GET", host, `/v1/wake?messageId=${encodeURIComponent(messageId)}`, undefined);
    if (status !== 200) return null;
    const reply = JSON.parse(text) as WakeResult;
    if (!reply || typeof reply.messageId !== "string" || typeof reply.state !== "string") return null;
    return reply;
  } catch {
    return null;
  }
}

export interface SendMessageDeps {
  fetchPi?: () => Promise<AgentSessionSummary[]>;
  fetchClaude?: (excludeSock?: string) => Promise<ClaudePeer[]>;
  excludeSock?: string;
  sessionsDir?: string;
  /** Force the Claude transport on/off; default reads settings/env. */
  claudeTransportEnabled?: boolean;
  postWake?: (req: WakeSendRequest) => Promise<WakeResult>;
  wakeStatus?: (messageId: string) => Promise<WakeResult | null>;
  sendClaude?: (opts: { sock: string; body: string; from: string; fromName: string; messageId: string }) => Promise<{
    outcome: ClaudeDeliveryOutcome;
  }>;
  /** Long-poll budget for a queued wake to settle; 0 disables polling (tests). */
  settleWaitMs?: number;
  now?: () => number;
  randomId?: () => string;
  infoPath?: string;
}

async function defaultSendClaude(opts: {
  sock: string;
  body: string;
  from: string;
  fromName: string;
  messageId: string;
}): Promise<{ outcome: ClaudeDeliveryOutcome }> {
  const id = await sendToClaudeSession({
    sock: opts.sock,
    body: opts.body,
    from: opts.from,
    fromName: opts.fromName,
    messageId: opts.messageId,
  });
  return { outcome: await claudeReceipts.wait(id, 30_000) };
}

interface PendingAsk {
  messageId: string;
  target: string;
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface IdleSubscription {
  messageId: string;
  /** Exact sender session when known, else the sender address for registry resolution. */
  participant: string;
  name: string;
  expiresAt: number;
}

const pendingAsks = new Map<string, PendingAsk>();
const idleSubscriptions = new Map<string, IdleSubscription>();
/** Owned sends noticed undelivered/expired, by target name; a later delivery clears the target. */
const undeliveredByTarget = new Map<string, Set<string>>();
let wiredUnsubscribe: (() => void) | null = null;

function refreshWaitingStore(): void {
  intercomWaiting.setPendingAsks(pendingAsks.size);
  let undelivered = 0;
  for (const ids of undeliveredByTarget.values()) undelivered += ids.size;
  intercomWaiting.setUndelivered(undelivered);
  requestFooterRender();
}

function noteUndelivered(target: string, messageId: string): void {
  let ids = undeliveredByTarget.get(target);
  if (!ids) {
    ids = new Set();
    undeliveredByTarget.set(target, ids);
  }
  ids.add(messageId);
  refreshWaitingStore();
}

function noteDelivered(target: string): void {
  if (undeliveredByTarget.delete(target)) refreshWaitingStore();
}

/** Cancel one pending ask from a later turn. Returns true when one was waiting. */
export function cancelPendingAsk(messageId: string): boolean {
  const ask = pendingAsks.get(messageId);
  if (!ask) return false;
  clearTimeout(ask.timer);
  pendingAsks.delete(messageId);
  refreshWaitingStore();
  ask.resolve(`Ask to ${ask.target} (message ${messageId}) was cancelled.`);
  return true;
}

/**
 * Inbound wake hook (registered on the bridge by registerSendMessageTool):
 * a wake carrying replyTo resolves the matching ask with the reply text, and
 * a wake carrying notifyWhenIdle arms one idle subscription for the sender.
 */
export function inboundWakeListener(notice: InjectedWakeNotice, nowMs: number = Date.now()): void {
  if (notice.replyTo) {
    const ask = pendingAsks.get(notice.replyTo);
    if (ask) {
      clearTimeout(ask.timer);
      pendingAsks.delete(notice.replyTo);
      refreshWaitingStore();
      const from = clean(notice.from ?? notice.fromName, 256) || "unknown";
      ask.resolve(`Reply from ${from} (message ${notice.messageId}): ${notice.ref}`);
    }
  }
  if (notice.notifyWhenIdle === true) {
    const participant = clean(notice.fromSessionId ?? "", 256) || clean(notice.from ?? "", 256);
    const name = clean(notice.fromName ?? notice.from ?? "", 256) || participant || "unknown";
    if (participant && notice.messageId) {
      idleSubscriptions.set(notice.messageId, {
        messageId: notice.messageId,
        participant,
        name,
        expiresAt: nowMs + IDLE_SUBSCRIPTION_TTL_MS,
      });
    }
  }
}

function idleNoticeText(name: string, messageId: string): string {
  return `[Cross-session idle notice] ${name} is now idle (message ${messageId}).`;
}

function idleExpiryText(name: string, messageId: string): string {
  return `[Cross-session idle notice] Idle watch for ${name} expired after 12 h without an idle moment (message ${messageId}).`;
}

async function settleIdleSubscriptions(postWake: (req: WakeSendRequest) => Promise<WakeResult>, nowMs: number): Promise<void> {
  if (idleSubscriptions.size === 0) return;
  const due = [...idleSubscriptions.values()];
  idleSubscriptions.clear();
  for (const sub of due) {
    const expired = nowMs >= sub.expiresAt;
    try {
      await postWake({
        participant: sub.participant,
        payloadRef: expired ? idleExpiryText(sub.name, sub.messageId) : idleNoticeText(sub.name, sub.messageId),
        messageId: randomUUID(),
      });
    } catch {
      /* exactly one attempt: a failing post still clears the subscription */
    }
  }
}

/** Test seam: drive the inbound hook without a bridge. */
export function __inboundWakeForTests(notice: InjectedWakeNotice, nowMs?: number): void {
  inboundWakeListener(notice, nowMs);
}

/** Test seam: the receiver envelope for one message. */
export function __buildContentForTests(messageId: string, ref: string, sender?: { from?: string; fromName?: string }): string {
  return buildIntercomWakeContent(messageId, ref, sender);
}

/** Test seam: clear asks, subscriptions, undelivered counts and the bridge wiring. */
export function __resetSendMessageState(): void {
  for (const ask of pendingAsks.values()) clearTimeout(ask.timer);
  pendingAsks.clear();
  idleSubscriptions.clear();
  undeliveredByTarget.clear();
  wiredUnsubscribe?.();
  wiredUnsubscribe = null;
}

function deliveryNotice(state: WakeDeliveryState, name: string, messageId: string): string {
  switch (state) {
    case "held":
      return (
        `[Cross-session delivery notice] ${name} is not connected; ` +
        `message ${messageId} is held and will deliver when the session registers.`
      );
    case "refused":
      return `[Cross-session delivery notice] ${name} refused message ${messageId}.`;
    case "undelivered":
      return `[Cross-session delivery notice] Message ${messageId} to ${name} was undelivered: the session ended before it was accepted.`;
    case "expired":
      return `[Cross-session delivery notice] Message ${messageId} to ${name} expired before delivery.`;
    default:
      return `[Cross-session delivery notice] Message ${messageId} to ${name}: ${state}.`;
  }
}

export interface SendMessageDetails {
  message?: { id: string; state: string; to: string };
  ask?: "replied" | "timeout" | "cancelled" | "not-waited";
  error?: boolean;
}

type ToolResult = { content: [{ type: "text"; text: string }]; details: SendMessageDetails; isError?: boolean };

function ok(text: string, details: SendMessageDetails = {}): ToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string, details: SendMessageDetails = {}): ToolResult {
  return { content: [{ type: "text" as const, text }], details: { ...details, error: true }, isError: true };
}

/** The model-only SendMessage tool. Parameter names follow Claude Code; ask options follow D-2. */
export function registerSendMessageTool(pi: ExtensionAPI, deps: SendMessageDeps = {}): void {
  const postWake = deps.postWake ?? ((req: WakeSendRequest) => defaultPostWake(req, deps.infoPath));
  const getWakeStatus =
    deps.wakeStatus ?? ((messageId: string) => defaultWakeStatus(messageId, deps.infoPath));
  const sendClaude = deps.sendClaude ?? defaultSendClaude;
  const settleWaitMs = deps.settleWaitMs ?? DEFAULT_SETTLE_WAIT_MS;
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? randomUUID;

  if (!wiredUnsubscribe) wiredUnsubscribe = onWakeInjected((notice) => inboundWakeListener(notice));

  const settleIdle = () => {
    void settleIdleSubscriptions(postWake, now()).catch(() => {});
  };
  pi.on("agent_settled", () => settleIdle());
  pi.on("session_start", () => {
    // Expiry only: live subscriptions wait for the next settle.
    if ([...idleSubscriptions.values()].some((sub) => now() >= sub.expiresAt)) void settleIdleSubscriptions(postWake, now()).catch(() => {});
  });

  pi.registerTool({
    name: "SendMessage",
    label: "SendMessage",
    description:
      "Message another session by its exact name or session id (see ListAgents). " +
      "Send once with to, message and an optional summary; notify_when_idle delivers one idle notice when the " +
      "recipient settles. expect_reply waits up to timeout_s for a reply; cancel removes a pending ask by message id; " +
      "reply_to answers the ask with the given message id.",
    parameters: Type.Object({
      to: Type.Optional(Type.String({ description: "Exact session name or session id (see ListAgents)." })),
      message: Type.Optional(Type.String({ description: "Message text for the recipient session." })),
      summary: Type.Optional(Type.String({ description: "Short preview of the message." })),
      notify_when_idle: Type.Optional(Type.Boolean({ description: "Deliver one idle notice when the recipient settles." })),
      expect_reply: Type.Optional(Type.Boolean({ description: "Wait up to timeout_s for the recipient's reply." })),
      timeout_s: Type.Optional(Type.Number({ description: "Ask wait budget in seconds (default 300, at most 3600)." })),
      reply_to: Type.Optional(Type.String({ description: "Answer the ask with this message id." })),
      cancel: Type.Optional(Type.String({ description: "Cancel the pending ask with this message id." })),
    }),
    exposure: "model-only",
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: unknown,
      _onUpdate: unknown,
      ctx?: { sessionManager?: { getSessionId?: () => string } },
    ): Promise<ToolResult> => {
      const cancelId = clean(params.cancel, 128);
      if (cancelId) {
        if (typeof params.to === "string" || typeof params.message === "string") {
          return fail("SendMessage with cancel takes only cancel: the message id of the pending ask.");
        }
        if (cancelPendingAsk(cancelId)) return ok(`Cancelled pending ask ${cancelId}.`);
        return fail(`No pending ask ${cancelId}.`);
      }

      const to = clean(params.to, 256);
      const message = stripAnsi(typeof params.message === "string" ? params.message : "")
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .trim();
      if (!to) return fail("SendMessage needs to: the exact session name or session id (see ListAgents).");
      if (!message) return fail("SendMessage needs message: the text for the recipient session.");
      if (message.length > MAX_MESSAGE_BYTES) {
        return fail(`SendMessage message must be ${MAX_MESSAGE_BYTES} bytes or shorter; split it and send again.`);
      }
      const summary = params.summary === undefined ? "" : clean(params.summary, MAX_SUMMARY_BYTES + 1);
      if (summary.length > MAX_SUMMARY_BYTES) return fail("SendMessage summary must be 512 bytes or shorter.");
      const timeoutS = params.timeout_s === undefined ? DEFAULT_ASK_TIMEOUT_S : Number(params.timeout_s);
      if (!Number.isFinite(timeoutS) || timeoutS < 1 || timeoutS > MAX_ASK_TIMEOUT_S) {
        return fail(`SendMessage timeout_s must be between 1 and ${MAX_ASK_TIMEOUT_S} seconds.`);
      }
      const replyTo = clean(params.reply_to, 128) || undefined;
      const notifyWhenIdle = params.notify_when_idle === true;
      const expectReply = params.expect_reply === true;

      let ownSessionId: string | undefined;
      try {
        ownSessionId = ctx?.sessionManager?.getSessionId?.();
      } catch {
        ownSessionId = undefined;
      }
      if (!ownSessionId) {
        return fail("SendMessage needs the current session id, and none was available.");
      }
      let ownName: string | undefined;
      try {
        ownName = clean(pi.getSessionName?.(), 256) || undefined;
      } catch {
        ownName = undefined;
      }

      const [piSessions, claudePeers] = await Promise.all([
        (deps.fetchPi ?? (() => fetchPiSessions()))().catch(() => [] as AgentSessionSummary[]),
        (deps.fetchClaude ?? ((excludeSock?: string) => listClaudeSessions(excludeSock ? { excludeSock } : {})))(
          deps.excludeSock,
        ).catch(() => [] as ClaudePeer[]),
      ]);
      const built = buildRoster({
        ownSessionId,
        ...(ownName ? { ownName } : {}),
        piSessions,
        claudePeers,
        ...(deps.excludeSock ? { excludeSock: deps.excludeSock } : {}),
      });
      let target: RosterEntry;
      try {
        const resolved = resolveRosterTarget(built.entries, to);
        if (!resolved.target) {
          const candidates = resolved.candidates.length > 0 ? `: ${resolved.candidates.join(", ")}` : "";
          return fail(`SendMessage: no live session matches "${to}"${candidates}.`);
        }
        target = resolved.target;
      } catch (error) {
        return fail(`SendMessage: ${(error as Error)?.message ?? String(error)}.`);
      }

      if (target.kind === "claude") {
        const claudeTransportOn = deps.claudeTransportEnabled ?? isClaudeTransportEnabled(pi);
        if (!claudeTransportOn) {
          return fail(
            `SendMessage: session "${to}" is a Claude session and the Claude transport is off. ` +
              `Set intercom.claudeTransport to true (or INTERCOM_CLAUDE_TRANSPORT=1); until then only Pi sessions are reachable.`,
          );
        }
        const peer = claudePeers.find((p) => (target.sessionId && p.sessionId === target.sessionId) || p.name === target.name);
        const sock = peer?.sock;
        if (!sock) return fail(`SendMessage: session "${to}" has no reachable Claude socket.`);
        const from = ownName ?? `session ${ownSessionId.slice(0, 8)}`;
        const messageId = randomId();
        let receipt: ClaudeDeliveryOutcome;
        try {
          receipt = (await sendClaude({ sock, body: message, from, fromName: from, messageId })).outcome;
        } catch (error) {
          return fail(`SendMessage: could not send to "${to}": ${(error as Error)?.message ?? String(error)}.`);
        }
        if (receipt === "delivered") {
          const waited = expectReply
            ? " The ask did not wait: replies from Claude sessions arrive as new messages."
            : "";
          return ok(`Delivered to ${target.name} (message ${messageId}).${waited}`, {
            message: { id: messageId, state: "delivered", to: target.name },
            ...(expectReply ? { ask: "not-waited" as const } : {}),
          });
        }
        return ok(deliveryNotice(receipt === "held" ? "held" : "refused", target.name, messageId), {
          message: { id: messageId, state: receipt, to: target.name },
        });
      }

      const participant = target.sessionId ?? target.name;
      const from = ownName ?? `session ${ownSessionId.slice(0, 8)}`;
      const messageId = randomId();
      let sent: WakeResult;
      try {
        sent = await postWake({
          participant,
          payloadRef: message,
          messageId,
          from,
          fromName: from,
          fromSessionId: ownSessionId,
          ...(replyTo ? { replyTo } : {}),
          ...(notifyWhenIdle ? { notifyWhenIdle: true as const } : {}),
        });
      } catch (error) {
        return fail(`SendMessage: could not reach the agent host: ${(error as Error)?.message ?? String(error)}.`);
      }

      let state: WakeDeliveryState = sent.state;
      if (state === "queued" && settleWaitMs > 0) {
        const deadline = Date.now() + settleWaitMs;
        while (state === "queued" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
          try {
            const latest = await getWakeStatus(sent.messageId);
            if (latest) state = latest.state;
            else break;
          } catch {
            break;
          }
        }
      }

      const details: SendMessageDetails = { message: { id: sent.messageId, state, to: target.name } };
      if (state === "delivered") {
        noteDelivered(target.name);
        let text = `Delivered to ${target.name} (message ${sent.messageId}).`;
        if (notifyWhenIdle) text += ` You will get one idle notice when ${target.name} goes idle.`;
        if (!expectReply) return ok(text, details);
        return await waitForReply(target.name, sent.messageId, timeoutS, signal);
      }
      if (state === "queued") {
        if (!expectReply) {
          return ok(
            `Sent to ${target.name} (message ${sent.messageId}); last known state: queued — the session has the frame but has not answered yet.`,
            details,
          );
        }
        return await waitForReply(target.name, sent.messageId, timeoutS, signal);
      }
      if (state === "held") {
        if (expectReply) {
          // Held now, still answerable later: the ask waits for the flush.
          const heldText = deliveryNotice(state, target.name, sent.messageId);
          const reply = await waitForReply(target.name, sent.messageId, timeoutS, signal);
          if (reply.details.ask === "replied") return reply;
          return ok(`${heldText} ${reply.content[0].text}`, { message: details.message, ask: reply.details.ask });
        }
        return ok(deliveryNotice(state, target.name, sent.messageId), details);
      }
      if (state === "undelivered" || state === "expired") noteUndelivered(target.name, sent.messageId);
      return ok(deliveryNotice(state, target.name, sent.messageId), details);
    },
  });

  function waitForReply(target: string, messageId: string, timeoutS: number, signal: unknown): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const done = (text: string, ask: SendMessageDetails["ask"]) => {
        pendingAsks.delete(messageId);
        refreshWaitingStore();
        resolve(ok(text, { message: { id: messageId, state: "asked", to: target }, ask }));
      };
      const timer = setTimeout(() => {
        void (async () => {
          let lastKnown = "unknown";
          try {
            const latest = await getWakeStatus(messageId);
            if (latest) lastKnown = latest.state;
          } catch {
            /* the timeout text stands on its own */
          }
          done(
            `Ask to ${target} timed out after ${timeoutS} s (last known state: ${lastKnown}). ` +
              `This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session.`,
            "timeout",
          );
        })();
      }, timeoutS * 1000);
      pendingAsks.set(messageId, {
        messageId,
        target,
        resolve: (text: string) => {
          clearTimeout(timer);
          const replied = text.startsWith("Reply from");
          done(text, replied ? "replied" : "cancelled");
        },
        timer,
      });
      refreshWaitingStore();
      const abortable = signal as { addEventListener?: (name: string, fn: () => void) => void } | undefined;
      try {
        abortable?.addEventListener?.("abort", () => cancelPendingAsk(messageId));
      } catch {
        /* abort is best effort */
      }
    });
  }
}
