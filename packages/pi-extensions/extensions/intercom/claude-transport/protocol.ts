/**
 * Claude transport frame protocol (CORE-2434 I3, XT-91 ADR rev 2 + amendment 1).
 *
 * Adapted from pi-claude-link (https://github.com/alonw0/pi-claude-link,
 * claude-protocol.ts) under the MIT license — full notice in ./transport.ts;
 * behaviour credit is also recorded in ADOPTION-CREDITS.md. The envelope
 * shape and the msgV: 1 / peer_message_status frame vocabulary follow
 * pi-claude-link; the version gate and the loud unknown-version / unknown-
 * status errors are XTRM-owned. All frame handling for the Claude side lives
 * in this adapter; the wire is treated as unstable.
 *
 * Frames are newline-delimited JSON. User frames carry `msgV: 1`,
 * `type: "user"` and a `<cross-session-message>` envelope (Claude Code's
 * inbound tag, D1). Receipts are control frames with
 * `action: "peer_message_status"` and a `status` of delivered, held or
 * refused (Claude Code's own outcomes, ADR Q4). Anything else versioned that
 * is not `msgV: 1` fails loudly naming the version seen.
 */

export const SUPPORTED_FRAME_VERSION = 1 as const;

/** Upper bound for one NDJSON line; Claude drops a connection past 1 MiB. */
export const MAX_FRAME_LINE = 1024 * 1024;

/** Claude Code's own delivery outcomes (ADR rev 2 Q4). */
export type ClaudeDeliveryOutcome = "delivered" | "held" | "refused";

const OUTCOMES: readonly ClaudeDeliveryOutcome[] = ["delivered", "held", "refused"];

/** A frame whose version is not the one this adapter speaks. */
export class UnknownFrameVersionError extends Error {
  readonly seen: unknown;
  constructor(seen: unknown) {
    const rendered = seen === undefined ? "absent" : JSON.stringify(seen) ?? String(seen);
    super(`unsupported Claude frame version ${rendered}: this adapter speaks msgV ${SUPPORTED_FRAME_VERSION}`);
    this.name = "UnknownFrameVersionError";
    this.seen = seen;
  }
}

/** A receipt whose status is outside delivered/held/refused. */
export class UnknownReceiptStatusError extends Error {
  readonly seen: unknown;
  constructor(seen: unknown) {
    super(`unsupported Claude receipt status ${JSON.stringify(seen) ?? String(seen)}: expected delivered, held or refused`);
    this.name = "UnknownReceiptStatusError";
    this.seen = seen;
  }
}

const ENVELOPE_TAG = "cross-session-message";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function bounded(value: unknown, max = 8192): string {
  const text = typeof value === "string" ? value : "";
  return stripAnsi(text)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, max);
}

/**
 * Largest envelope body (CORE-2554 C1): the SendMessage payload cap (512 KiB)
 * plus the envelope lines, the same bound as the Pi wake envelope.
 */
export const MAX_ENVELOPE_BODY_BYTES = 528 * 1024;

/** A body or frame too large for the Claude transport: refused loudly, never sliced. */
export class ClaudeFrameTooLargeError extends Error {
  readonly bytes: number;
  readonly limit: number;
  constructor(what: string, bytes: number, limit: number) {
    super(`Claude transport: ${what} is ${bytes} bytes; the limit is ${limit} bytes. Split the message and send again.`);
    this.name = "ClaudeFrameTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * Body text (CORE-2554 C1): newlines and tabs survive (multi-line messages
 * arrived glued into one line), CRLF normalises, other control characters
 * and ANSI go. No silent slice: an oversized body throws.
 */
function sanitizeBody(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const body = stripAnsi(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_ENVELOPE_BODY_BYTES) throw new ClaudeFrameTooLargeError("the message body", bytes, MAX_ENVELOPE_BODY_BYTES);
  return body;
}

function escapeAttr(value: string): string {
  return value.replace(/["<>]/g, "");
}

/**
 * Escape a body so a forged envelope stays inert text inside the real one.
 * Both tags (CORE-2554 C2): a forged opening tag with its own from= and
 * message-id= would otherwise read as a second, attributed message.
 * `</tag` becomes `<\/tag`, `<tag` becomes `<\tag`.
 */
function escapeBody(body: string): string {
  return body
    .replace(new RegExp(`</(?=${ENVELOPE_TAG}(?:[>\\s/]|$))`, "gi"), "<\\/")
    .replace(new RegExp(`<(?=${ENVELOPE_TAG}(?:[>\\s/]|$))`, "gi"), "<\\");
}

function unescapeBody(body: string): string {
  return body
    .replace(new RegExp(`<\\\\/(?=${ENVELOPE_TAG}(?:[>\\s/]|$))`, "gi"), "</")
    .replace(new RegExp(`<\\\\(?=${ENVELOPE_TAG}(?:[>\\s/]|$))`, "gi"), "<");
}

export interface EnvelopeParts {
  body: string;
  from?: string;
  fromName?: string;
  fromMode?: string;
  messageId?: string;
}

/** Build Claude's inbound envelope with Claude's own tag and attribute names. */
export function buildEnvelope(parts: EnvelopeParts): string {
  const attrs: string[] = [];
  if (parts.messageId) attrs.push(`message-id="${escapeAttr(bounded(parts.messageId, 128))}"`);
  if (parts.from) attrs.push(`from="${escapeAttr(bounded(parts.from, 512))}"`);
  if (parts.fromName) attrs.push(`from-name="${escapeAttr(bounded(parts.fromName, 128))}"`);
  if (parts.fromMode) attrs.push(`from-mode="${escapeAttr(bounded(parts.fromMode, 64))}"`);
  const head = attrs.length ? ` ${attrs.join(" ")}` : "";
  return `<${ENVELOPE_TAG}${head}>\n${escapeBody(sanitizeBody(parts.body))}\n</${ENVELOPE_TAG}>`;
}

/** Split an inbound content string into its body and sender attributes. */
export function stripEnvelope(content: unknown): EnvelopeParts {
  if (typeof content !== "string") return { body: "" };
  const match = content.match(
    new RegExp(`^<${ENVELOPE_TAG}((?:\\s+[a-z-]+="[^"]*")*)>\\n([\\s\\S]*)\\n</${ENVELOPE_TAG}>$`),
  );
  if (!match) return { body: content };
  const attrs: Record<string, string> = {};
  for (const attr of match[1].matchAll(/([a-z-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
  return {
    body: unescapeBody(match[2]),
    ...(attrs["message-id"] ? { messageId: attrs["message-id"] } : {}),
    ...(attrs.from ? { from: attrs.from } : {}),
    ...(attrs["from-name"] ? { fromName: attrs["from-name"] } : {}),
    ...(attrs["from-mode"] ? { fromMode: attrs["from-mode"] } : {}),
  };
}

export interface UserFrameInput {
  body: string;
  from?: string;
  fromName?: string;
  fromMode?: string;
  messageId?: string;
  priority?: string;
  sessionId?: string;
}

export interface BuiltUserFrame {
  frame: Record<string, unknown>;
  messageId: string;
  content: string;
}

function newMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `m-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** Build one `msgV: 1` user frame carrying the envelope. */
export function buildUserFrame(input: UserFrameInput): BuiltUserFrame {
  const messageId = input.messageId || newMessageId();
  const content = buildEnvelope({
    body: input.body,
    messageId,
    ...(input.from ? { from: input.from } : {}),
    ...(input.fromName ? { fromName: input.fromName } : {}),
    ...(input.fromMode ? { fromMode: input.fromMode } : {}),
  });
  const frame = {
    msgV: SUPPORTED_FRAME_VERSION,
    msg_id: messageId,
    type: "user",
    priority: input.priority || "next",
    ...(input.from ? { from: input.from } : {}),
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    message: { role: "user", content },
  };
  // Claude drops a connection past MAX_FRAME_LINE: refuse here, loudly.
  const lineBytes = Buffer.byteLength(JSON.stringify(frame), "utf8") + 1;
  if (lineBytes > MAX_FRAME_LINE) throw new ClaudeFrameTooLargeError("the frame", lineBytes, MAX_FRAME_LINE);
  return { messageId, content, frame };
}

export interface ReceiptFrameInput {
  status: ClaudeDeliveryOutcome | string;
  from?: string;
  origMessageId?: string;
  reason?: string;
  messageId?: string;
}

/** Build one `peer_message_status` control frame (used for acks and tests). */
export function buildReceiptFrame(input: ReceiptFrameInput): Record<string, unknown> {
  return {
    msgV: SUPPORTED_FRAME_VERSION,
    msg_id: input.messageId || newMessageId(),
    type: "control",
    action: "peer_message_status",
    status: input.status,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.origMessageId ? { orig_msg_id: input.origMessageId } : {}),
  };
}

/** Map one Claude receipt status onto the I1 delivery vocabulary. */
export function mapReceiptStatus(status: unknown): ClaudeDeliveryOutcome {
  const lowered = typeof status === "string" ? status.toLowerCase() : "";
  if ((OUTCOMES as readonly string[]).includes(lowered)) return lowered as ClaudeDeliveryOutcome;
  throw new UnknownReceiptStatusError(status);
}

export type InboundFrame =
  | { kind: "user"; messageId: string; content: string; from?: string; frame: Record<string, unknown> }
  | { kind: "receipt"; status: ClaudeDeliveryOutcome; origMessageId?: string; from?: string; reason?: string }
  | { kind: "rename"; name: string }
  | { kind: "unknown_receipt"; seen: unknown; origMessageId?: string; from?: string }
  | { kind: "other"; frame: Record<string, unknown> };

function checkVersion(frame: Record<string, unknown>): void {
  if (frame.msgV !== SUPPORTED_FRAME_VERSION) throw new UnknownFrameVersionError(frame.msgV);
}

/**
 * Parse one decoded JSON line. Version-gated: anything that is not
 * `msgV: 1` throws UnknownFrameVersionError naming the version seen.
 */
export function parseInboundFrame(raw: unknown): InboundFrame {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UnknownFrameVersionError(undefined);
  }
  const frame = raw as Record<string, unknown>;
  checkVersion(frame);
  if (frame.type === "control" && frame.action === "peer_message_status") {
    // CORE-2554 C4: an unrecognised status answers its message as unknown
    // instead of being dropped (a dropped receipt starved into "delivered").
    const lowered = typeof frame.status === "string" ? frame.status.toLowerCase() : "";
    if (!(OUTCOMES as readonly string[]).includes(lowered)) {
      return {
        kind: "unknown_receipt",
        seen: frame.status,
        ...(typeof frame.orig_msg_id === "string" ? { origMessageId: frame.orig_msg_id } : {}),
        ...(typeof frame.from === "string" ? { from: frame.from } : {}),
      };
    }
    return {
      kind: "receipt",
      status: mapReceiptStatus(frame.status),
      ...(typeof frame.orig_msg_id === "string" ? { origMessageId: frame.orig_msg_id } : {}),
      ...(typeof frame.from === "string" ? { from: frame.from } : {}),
      ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}),
    };
  }
  if (frame.type === "control" && frame.action === "rename" && typeof frame.name === "string") {
    return { kind: "rename", name: frame.name };
  }
  if (frame.type === "user") {
    const message = frame.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === "string" ? message.content : "";
    return {
      kind: "user",
      messageId: typeof frame.msg_id === "string" ? frame.msg_id : "",
      content,
      ...(typeof frame.from === "string" ? { from: frame.from } : {}),
      frame,
    };
  }
  return { kind: "other", frame };
}
