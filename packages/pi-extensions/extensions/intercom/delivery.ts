/**
 * Pi-transport wake delivery (CORE-2433 I2, XT-91 ADR rev 2 + amendment 1).
 *
 * Clean reimplementation inspired by pi-intercom 0.17.1 `sendIncomingMessage`
 * (see ADOPTION-CREDITS.md): inbound wakes are injected with `pi.sendMessage`
 * as `customType: "intercom_message"`, never as a plain user message. The model
 * payload is a plain envelope plus the D2 provenance line; no ANSI, no
 * timestamps in model text (D1, D2, D9).
 *
 * Delivery rule (D6): an idle session wakes with
 * `{ triggerTurn: true, deliverAs: "followUp" }` (`triggerTurn` exists only on
 * `sendMessage`). `deliverAs: "steer"` is reserved for priority-next wakes;
 * the I1 wake frame carries no priority marker, so busy sessions queue the
 * message as `followUp` and never steer.
 */

import { buildMessageEnvelope, MAX_ENVELOPE_BYTES } from "../../shared/event.ts";

export const INTERCOM_MESSAGE_TYPE = "intercom_message";

export { PROVENANCE_LINE } from "../../shared/event.ts";

/** Upper bound on tracked message ids; the oldest entry is evicted first. */
export const MAX_TRACKED_WAKES = 512;

/** SendMessage options for one wake injection. */
export interface WakeDelivery {
  readonly triggerTurn?: boolean;
  readonly deliverAs: "followUp";
}

function stripAnsi(value: string): string {
  // ESC [ ... final-byte sequences (SGR, cursor, mode).
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function bounded(value: unknown, max = 1024): string {
  const text = typeof value === "string" ? value : "";
  return stripAnsi(text)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .slice(0, max);
}

/**
 * Envelope content for one wake (CORE-2437 I6, F1; N4): newlines and tabs
 * survive (attachments are multiline), every other control character and
 * ANSI goes. The cap applies AFTER envelope-escaping (N4: a payload full
 * of `&`/`<`/`>` would otherwise expand past the cap); it fits the 512
 * KiB attachment payload plus the message and the envelope lines. A cut
 * says so with an explicit truncation line instead of losing the end
 * silently. A cut can split an escape entity mid-way; the result stays
 * plain inert text.
 */
/** Cap on the escaped payload reference (shared event module value, kept under this slice's name). */
export const MAX_WAKE_CONTENT_BYTES: number = MAX_ENVELOPE_BYTES;

function sanitizeEnvelopeText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return stripAnsi(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function truncateEnvelopeText(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  const buffer = Buffer.from(text, "utf8");
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  const kept = buffer.subarray(0, end).toString("utf8");
  const keptKiB = Math.floor(Buffer.byteLength(kept, "utf8") / 1024);
  const totalKiB = Math.floor(bytes / 1024);
  return `${kept}\n[truncated: showing the first ${keptKiB} KiB of ${totalKiB} KiB]`;
}

/**
 * Sender identity for the from-envelope (CORE-2436 I5). The address is the
 * session name `to` accepts; the display name feeds from-name. Both are
 * envelope-escaped; absent fields omit their attributes (I1-era frames).
 */
export interface WakeSender {
  from?: string;
  fromName?: string;
}

export { buildReplyActionLine } from "../../shared/event.ts";

/**
 * Model-visible content for one wake (CORE-2438 I7: built by the shared
 * event module): the payload reference inside a `<cross-session-message>`
 * envelope (Claude Code's inbound tag, D1) with the sender's
 * from-attributes when known, followed by the one D3 action line and the
 * D2 provenance line. The operator card renderer is registered in
 * ./index.ts; this stays the plain model fallback.
 */
export function buildIntercomWakeContent(messageId: string, payloadRef: string, sender: WakeSender = {}): string {
  return buildMessageEnvelope({ messageId, ref: payloadRef, ...sender });
}

/** Non-model details carried alongside the injected message for later renderers. */
export function buildIntercomWakeDetails(
  messageId: string,
  payloadRef: string,
  sender: WakeSender = {},
): { messageId: string; payloadRef: string; from?: string; fromName?: string } {
  return {
    messageId: bounded(messageId, 128),
    payloadRef: truncateEnvelopeText(sanitizeEnvelopeText(payloadRef), MAX_WAKE_CONTENT_BYTES),
    ...(sender.from ? { from: bounded(sender.from, 256) } : {}),
    ...(sender.fromName ? { fromName: bounded(sender.fromName, 256) } : {}),
  };
}

/** D6 delivery choice: followUp (+ triggerTurn) when idle, queued followUp when busy. */
export function wakeDeliveryOptions({ idle }: { idle: boolean }): WakeDelivery {
  return idle ? { triggerTurn: true, deliverAs: "followUp" } : { deliverAs: "followUp" };
}

interface Sender {
  sendMessage(message: unknown, options?: unknown): void;
}

/**
 * Inject one wake into the session. Resolves once `sendMessage` took the
 * message; throws when the injection itself failed so the caller answers
 * `failed` and the registry reports `undelivered`.
 */
export function injectIntercomWake(
  pi: Sender,
  messageId: string,
  payloadRef: string,
  options: WakeDelivery,
  sender: WakeSender = {},
): void {
  pi.sendMessage(
    {
      customType: INTERCOM_MESSAGE_TYPE,
      content: buildIntercomWakeContent(messageId, payloadRef, sender),
      display: true,
      details: buildIntercomWakeDetails(messageId, payloadRef, sender),
    },
    { ...options },
  );
}

/**
 * Extension-side redelivery guard (§5 follow-up: a held wake flushed by the
 * registry while still deferred must inject once). `mark` records a
 * successful injection; `has` answers whether one happened; `remove`
 * drops the record so a later resend can inject (F1: a failed id must not
 * stay marked). While a wake sits in the deferred-hold queue it is neither
 * marked nor injected; duplicates then answer held, not accepted.
 */
export class WakeDedupe {
  private readonly seenIds = new Set<string>();

  has(messageId: string): boolean {
    return this.seenIds.has(messageId);
  }

  mark(messageId: string): boolean {
    if (this.seenIds.has(messageId)) return false;
    this.seenIds.add(messageId);
    if (this.seenIds.size > MAX_TRACKED_WAKES) {
      const oldest = this.seenIds.values().next().value;
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
    return true;
  }

  remove(messageId: string): void {
    this.seenIds.delete(messageId);
  }
}
