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
  /** Idle-notice backstop override in ms (tests); default 12 h. */
  idleTtlMs?: number;
  /** Idle-subscription cap override (tests); default 256. */
  maxIdleSubs?: number;
  /** Noticed-undelivered cap override (tests); default 1024. */
  maxUndelivered?: number;
  /** Drop/notice log; default silent. */
  log?: (line: string) => void;
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
  targetName: string;
  targetSessionId?: string;
  resolve: (result: { text: string; replied: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface IdleSubscription {
  messageId: string;
  /** Exact sender session when known, else the sender address for registry resolution. */
  participant: string;
  name: string;
  expiresAt: number;
  /** Real 12 h backstop (unref'd): fires the expiry notice without a settle. */
  timer: ReturnType<typeof setTimeout>;
}

/** Cap on live idle subscriptions: the oldest drops with a log when full. */
export const MAX_IDLE_SUBSCRIPTIONS = 256;
/** Undelivered chip entries older than this clear on the next send. */
export const UNDELIVERED_TTL_MS = 24 * 3600 * 1000;
/** Cap on noticed-undelivered ids; the oldest evict first. */
export const MAX_UNDELIVERED = 1024;

interface IdleEnv {
  pi: ExtensionAPI | null;
  postWake: (req: WakeSendRequest) => Promise<WakeResult>;
  log: (line: string) => void;
  ttlMs: number;
  maxSubs: number;
  maxUndelivered: number;
  nowMs: () => number;
}

let idleEnv: IdleEnv = { pi: null, postWake: defaultPostWake, log: () => {}, ttlMs: IDLE_SUBSCRIPTION_TTL_MS, maxSubs: MAX_IDLE_SUBSCRIPTIONS, maxUndelivered: MAX_UNDELIVERED, nowMs: Date.now };

const pendingAsks = new Map<string, PendingAsk>();
const idleSubscriptions = new Map<string, IdleSubscription>();
/**
 * Owned sends noticed undelivered/expired, by target name with timestamps
 * (CORE-2436 I5 review: sweep clears roster-leavers and TTL-aged entries).
 */
const undeliveredByTarget = new Map<string, Map<string, number>>();
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
    ids = new Map();
    undeliveredByTarget.set(target, ids);
  }
  ids.set(messageId, idleEnv.nowMs());
  evictUndeliveredOverflow();
  refreshWaitingStore();
}

function evictUndeliveredOverflow(): void {
  let total = 0;
  for (const ids of undeliveredByTarget.values()) total += ids.size;
  while (total > idleEnv.maxUndelivered) {
    let oldestTarget: string | null = null;
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [target, ids] of undeliveredByTarget) {
      for (const [id, at] of ids) {
        if (at < oldestAt) {
          oldestAt = at;
          oldestTarget = target;
          oldestId = id;
        }
      }
    }
    if (oldestTarget === null || oldestId === null) break;
    const ids = undeliveredByTarget.get(oldestTarget);
    ids?.delete(oldestId);
    if (ids && ids.size === 0) undeliveredByTarget.delete(oldestTarget);
    total -= 1;
  }
}

/**
 * Sweep noticed-undelivered entries (CORE-2436 I5 review): a target that
 * left the roster clears, and so do entries past the TTL. Runs on every
 * send, so the chip hides when nothing waits anymore.
 */
function sweepUndelivered(knownNames: Set<string>): void {
  const nowMs = idleEnv.nowMs();
  let changed = false;
  for (const [target, ids] of [...undeliveredByTarget]) {
    if (!knownNames.has(target)) {
      undeliveredByTarget.delete(target);
      changed = true;
      continue;
    }
    for (const [id, at] of [...ids]) {
      if (nowMs - at >= UNDELIVERED_TTL_MS) {
        ids.delete(id);
        changed = true;
      }
    }
    if (ids.size === 0) {
      undeliveredByTarget.delete(target);
      changed = true;
    }
  }
  if (changed) refreshWaitingStore();
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
  ask.resolve({ text: `Ask to ${ask.targetName} (message ${messageId}) was cancelled.`, replied: false });
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
    // CORE-2436 I5 review: a reply resolves the ask only when its sender
    // is the ask's target (exact session id wins, else the exact name).
    // Anything else is another conversation; the ask keeps waiting.
    const senderId = clean(notice.fromSessionId ?? "", 256);
    const senderName = clean(notice.from ?? "", 256);
    const idMatch = senderId !== "" && ask?.targetSessionId !== undefined && senderId === ask.targetSessionId;
    const nameMatch = senderName !== "" && senderName === ask?.targetName;
    if (ask && (idMatch || nameMatch)) {
      clearTimeout(ask.timer);
      pendingAsks.delete(notice.replyTo);
      refreshWaitingStore();
      const from = senderName || "unknown";
      ask.resolve({ text: `Reply from ${from} (message ${notice.messageId}): ${notice.ref}`, replied: true });
    }
  }
  if (notice.notifyWhenIdle === true) {
    const participant = clean(notice.fromSessionId ?? "", 256) || clean(notice.from ?? "", 256);
    const name = clean(notice.fromName ?? notice.from ?? "", 256) || participant || "unknown";
    if (participant && notice.messageId) {
      armIdleSubscription(notice.messageId, participant, name, nowMs);
    }
  }
}

/** Our own address for an outbound idle notice (never to="unknown"). */
function ownNoticeSender(): { from?: string; fromName?: string; fromSessionId?: string } {
  let name = "";
  try {
    name = clean(idleEnv.pi?.getSessionName?.(), 256);
  } catch {
    name = "";
  }
  return name ? { from: name, fromName: name } : {};
}

function armIdleSubscription(messageId: string, participant: string, name: string, nowMs: number): void {
  if (idleSubscriptions.has(messageId)) return;
  while (idleSubscriptions.size >= idleEnv.maxSubs) {
    const oldest = idleSubscriptions.keys().next().value;
    if (oldest === undefined) break;
    const dropped = idleSubscriptions.get(oldest);
    if (dropped) clearTimeout(dropped.timer);
    idleSubscriptions.delete(oldest);
    idleEnv.log(`SendMessage: dropped oldest idle subscription ${oldest} (cap ${idleEnv.maxSubs})`);
  }
  const timer = setTimeout(() => {
    fireIdleExpiry(messageId);
  }, Math.max(0, nowMs + idleEnv.ttlMs - Date.now()));
  timer.unref?.();
  idleSubscriptions.set(messageId, { messageId, participant, name, expiresAt: nowMs + idleEnv.ttlMs, timer });
}

/** Post one notice for a subscription and forget it (exactly-once per id). */
async function postIdleNotice(sub: IdleSubscription, expired: boolean): Promise<void> {
  try {
    await idleEnv.postWake({
      participant: sub.participant,
      payloadRef: expired ? idleExpiryText(sub.name, sub.messageId) : idleNoticeText(sub.name, sub.messageId),
      messageId: randomUUID(),
      ...ownNoticeSender(),
    });
  } catch {
    /* exactly one attempt: a failing post still clears the subscription */
  }
}

function takeIdleSubscription(messageId: string): IdleSubscription | undefined {
  const sub = idleSubscriptions.get(messageId);
  if (!sub) return undefined;
  clearTimeout(sub.timer);
  idleSubscriptions.delete(messageId);
  return sub;
}

function fireIdleExpiry(messageId: string): void {
  const sub = takeIdleSubscription(messageId);
  if (!sub) return;
  void postIdleNotice(sub, true).catch(() => {});
}

function idleNoticeText(name: string, messageId: string): string {
  return `[Cross-session idle notice] ${name} is now idle (message ${messageId}).`;
}

function idleExpiryText(name: string, messageId: string): string {
  return `[Cross-session idle notice] Idle watch for ${name} expired after 12 h without an idle moment (message ${messageId}).`;
}

/** Settle every live subscription: idle notices now, expiry notices for lapsed ones. */
async function settleIdleSubscriptions(nowMs?: number, forceExpired = false): Promise<void> {
  if (idleSubscriptions.size === 0) return;
  const due = [...idleSubscriptions.values()];
  idleSubscriptions.clear();
  for (const sub of due) {
    clearTimeout(sub.timer);
    const expired = forceExpired || (nowMs ?? Date.now()) >= sub.expiresAt;
    await postIdleNotice(sub, expired);
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
  for (const sub of idleSubscriptions.values()) clearTimeout(sub.timer);
  idleSubscriptions.clear();
  undeliveredByTarget.clear();
  wiredUnsubscribe?.();
  wiredUnsubscribe = null;
  idleEnv = { pi: null, postWake: defaultPostWake, log: () => {}, ttlMs: IDLE_SUBSCRIPTION_TTL_MS, maxSubs: MAX_IDLE_SUBSCRIPTIONS, maxUndelivered: MAX_UNDELIVERED, nowMs: Date.now };
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

  idleEnv = {
    pi,
    postWake,
    log: deps.log ?? (() => {}),
    ttlMs: deps.idleTtlMs ?? IDLE_SUBSCRIPTION_TTL_MS,
    maxSubs: deps.maxIdleSubs ?? MAX_IDLE_SUBSCRIPTIONS,
    maxUndelivered: deps.maxUndelivered ?? MAX_UNDELIVERED,
    nowMs: deps.now ?? Date.now,
  };

  if (!wiredUnsubscribe) wiredUnsubscribe = onWakeInjected((notice) => inboundWakeListener(notice));

  const settleIdle = () => {
    void settleIdleSubscriptions(now()).catch(() => {});
  };
  pi.on("agent_settled", () => settleIdle());
  pi.on("session_start", () => {
    // Expiry only: live subscriptions wait for the next settle.
    if ([...idleSubscriptions.values()].some((sub) => now() >= sub.expiresAt)) void settleIdleSubscriptions(now()).catch(() => {});
  });
  pi.on("session_shutdown", () => {
    // CORE-2436 I5 review: the watched session exits before going idle.
    // Its watchers still get exactly one notice: the expiry notice.
    void settleIdleSubscriptions(undefined, true).catch(() => {});
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
      // Noticed-undelivered entries clear when their target leaves the
      // roster or ages past the TTL, so the chip hides when nothing waits.
      sweepUndelivered(new Set([ownName ?? ownSessionId, ...built.entries.map((e) => e.name)]));
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
        // CORE-2436 I5 review: no silent drops — ask threading and idle
        // subscriptions need the Pi wake frame, so they fail loudly here.
        if (notifyWhenIdle || replyTo) {
          return fail(`SendMessage: notify_when_idle and reply_to are not supported for Claude targets yet.`);
        }
        // CORE-2436 I5 review: from is the resolvable address (the exact
        // roster name, or the session id when unnamed: resolveRosterTarget
        // accepts exact ids, so an unnamed sender stays addressable).
        const from = ownName ?? ownSessionId;
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
      // CORE-2436 I5 review: resolvable address, as above.
      const from = ownName ?? ownSessionId;
      const messageId = randomId();
      // CORE-2436 I5 review (reply race): the ask registers BEFORE the
      // post, so a reply that lands during the post or the settle poll
      // still finds its waiter. Terminal outcomes disarm it again below.
      const ask = expectReply ? armAsk(target, messageId, timeoutS, signal) : null;
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
        ask?.disarm();
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
        return ask!.promise;
      }
      if (state === "queued") {
        if (!expectReply) {
          return ok(
            `Sent to ${target.name} (message ${sent.messageId}); last known state: queued — the session has the frame but has not answered yet.`,
            details,
          );
        }
        return ask!.promise;
      }
      if (state === "held") {
        if (expectReply) {
          // Held now, still answerable later: the ask waits for the flush.
          const heldText = deliveryNotice(state, target.name, sent.messageId);
          const reply = await ask!.promise;
          if (reply.details.ask === "replied") return reply;
          return ok(`${heldText} ${reply.content[0].text}`, { message: details.message, ask: reply.details.ask });
        }
        return ok(deliveryNotice(state, target.name, sent.messageId), details);
      }
      if (state === "undelivered" || state === "expired") noteUndelivered(target.name, sent.messageId);
      ask?.disarm();
      return ok(deliveryNotice(state, target.name, sent.messageId), details);
    },
  });

  /**
   * Register an ask waiter BEFORE the post (CORE-2436 I5 review: a reply
   * landing during the post or the settle poll must find its waiter).
   * Terminal outcomes call disarm() instead of waiting.
   */
  function armAsk(
    target: RosterEntry,
    messageId: string,
    timeoutS: number,
    signal: unknown,
  ): { promise: Promise<ToolResult>; disarm: () => void } {
    let settled = false;
    let resolvePromise!: (value: ToolResult) => void;
    const promise = new Promise<ToolResult>((resolve) => {
      resolvePromise = resolve;
    });
    const done = (text: string, ask: NonNullable<SendMessageDetails["ask"]>) => {
      if (settled) return;
      settled = true;
      pendingAsks.delete(messageId);
      refreshWaitingStore();
      resolvePromise(ok(text, { message: { id: messageId, state: "asked", to: target.name }, ask }));
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
          `Ask to ${target.name} timed out after ${timeoutS} s (last known state: ${lastKnown}). ` +
            `This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session.`,
          "timeout",
        );
      })();
    }, timeoutS * 1000);
    pendingAsks.set(messageId, {
      messageId,
      targetName: target.name,
      ...(target.sessionId ? { targetSessionId: target.sessionId } : {}),
      resolve: ({ text, replied }) => {
        clearTimeout(timer);
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
    return {
      promise,
      disarm: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingAsks.delete(messageId);
        refreshWaitingStore();
      },
    };
  }
}
