#!/usr/bin/env node
// claude-receipt-ack.mjs — delivered receipts for Pi→Claude cross-session frames (CORE-2492).
//
// Symptom: every Pi→Claude send starves to `unconfirmed`. The Pi side waits up
// to 30 s for a `peer_message_status` receipt (ClaudeReceiptWaiter); no code on
// any Claude-loaded path emitted one — hooks/dispatch.mjs `runEvent` handled
// Stop only and UserPromptSubmit fell through. This module is the missing
// emitter: it runs inside `dispatch.mjs event` for UserPromptSubmit, parses the
// injected `<cross-session-message message-id from="uds:...">` envelope out of
// the hook payload prompt, and sends one `peer_message_status`/`delivered`
// NDJSON line back to the sender's socket.
//
// Frame shape mirrors protocol.ts buildReceiptFrame (msgV 1, type control,
// action peer_message_status, status delivered, orig_msg_id): the Pi waiter
// keys on orig_msg_id, so message-id + sender socket are the only fields this
// module depends on. from-mode / session_id / auth are never read — production
// sends omit them.
//
// Hard rules (same contract as the inbox reminder and the agent-host report):
// best effort, never throws, never prints to stdout (UserPromptSubmit stdout
// becomes model context), never changes the hook's exit code. No sender socket
// → resolve at once. A failing or slow socket resolves, never rejects.

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Per-socket delivery budget: the hook must stay far inside the 20 s event budget. */
export const RECEIPT_TIMEOUT_MS = 1500;

/** Upper bound on the prompt text scanned for envelopes (a prompt is small; this only caps pathological input). */
export const MAX_PROMPT_CHARS = 512 * 1024;

/** Upper bound on receipts per hook invocation (one prompt carries few frames; this caps abuse). */
export const MAX_TARGETS = 10;

/** Upper bound on a message id (Pi uses uuids; anything longer is not ours). */
const MAX_MESSAGE_ID_CHARS = 512;

/** Upper bound on a socket path (Linux UDS paths cap at ~108 bytes; be generous, not unbounded). */
const MAX_SOCK_CHARS = 4096;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function unescapeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function isSafeMessageId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MESSAGE_ID_CHARS &&
    !CONTROL_RE.test(value)
  );
}

function isSafeSockPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SOCK_CHARS &&
    value.startsWith('/') &&
    !value.includes('\0')
  );
}

/** The hook payload prompt as text. UserPromptSubmit sends a string; accept array parts defensively. */
function extractPromptText(input) {
  const prompt = input?.prompt;
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    const parts = [];
    for (const part of prompt) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part.text === 'string') parts.push(part.text);
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Every (messageId, sender-socket) pair in the prompt: one entry per
 * `<cross-session-message … message-id="…" … from="uds:…" …>` opening tag
 * carrying BOTH attributes. Tags without a message-id (the protocol envelope
 * omits it) or without a uds: return address yield no receipt — the Pi waiter
 * keys on orig_msg_id, so a receipt without it resolves nothing. Never throws.
 */
export function parseReceiptTargets(input) {
  try {
    const prompt = extractPromptText(input);
    if (!prompt) return [];
    const text = prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;
    const targets = [];
    const seen = new Set();
    const tagRe = /<cross-session-message\b[^>]*>/g;
    let tag;
    while ((tag = tagRe.exec(text)) !== null) {
      const idMatch = /message-id\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(tag[0]);
      const fromMatch = /(?:^|\s)from\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(tag[0]);
      if (!idMatch || !fromMatch) continue;
      const messageId = unescapeEntities(idMatch[1] ?? idMatch[2] ?? '');
      const rawFrom = unescapeEntities(fromMatch[1] ?? fromMatch[2] ?? '');
      if (!rawFrom.startsWith('uds:')) continue;
      const sockPath = rawFrom.slice(4);
      if (!isSafeMessageId(messageId) || !isSafeSockPath(sockPath)) continue;
      const key = `${sockPath.length}:${sockPath}:${messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ messageId, sockPath });
      if (targets.length >= MAX_TARGETS) break;
    }
    return targets;
  } catch {
    return [];
  }
}

/**
 * One `peer_message_status`/`delivered` control frame (protocol.ts
 * buildReceiptFrame shape): msgV 1, a fresh msg_id, no reason, no from — the
 * waiter resolves on (status, orig_msg_id) alone.
 */
export function buildDeliveredReceipt(origMessageId, messageId) {
  return {
    msgV: 1,
    msg_id: messageId ?? randomUUID(),
    type: 'control',
    action: 'peer_message_status',
    status: 'delivered',
    orig_msg_id: origMessageId,
  };
}

/**
 * Send one delivered receipt to the sender's socket. Resolves true once the
 * line is flushed, false when there is nothing to send or delivery failed.
 * Never rejects, never prints.
 */
export function sendDeliveredReceipt(sockPath, origMessageId, options = {}) {
  return new Promise((resolve) => {
    try {
      if (!isSafeSockPath(sockPath) || !isSafeMessageId(origMessageId)) {
        resolve(false);
        return;
      }
      const timeoutMs =
        typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
          ? Math.min(options.timeoutMs, 10_000)
          : RECEIPT_TIMEOUT_MS;
      const line = `${JSON.stringify(buildDeliveredReceipt(origMessageId))}\n`;
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      let socket = null;
      const timer = setTimeout(() => {
        try {
          socket?.destroy();
        } catch {
          /* already gone */
        }
        finish(false);
      }, timeoutMs);
      socket = net.createConnection(sockPath);
      socket.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        finish(false);
      });
      socket.on('connect', () => {
        // Resolve once flushed (same as the agent-host reporter): waiting for
        // the peer's scheduling would hold the prompt on a loaded machine.
        socket.end(line, () => {
          clearTimeout(timer);
          finish(true);
        });
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Ack every injected frame in this UserPromptSubmit payload. Resolves with
 * `{ attempted, delivered }` counts; the dispatcher ignores them. Never
 * throws, never touches stdout/stderr.
 */
export async function claudeReceiptAck(input, options = {}) {
  try {
    const targets = parseReceiptTargets(input);
    if (targets.length === 0) return { attempted: 0, delivered: 0 };
    const results = await Promise.all(
      targets.map((target) => sendDeliveredReceipt(target.sockPath, target.messageId, options)),
    );
    return { attempted: targets.length, delivered: results.filter(Boolean).length };
  } catch {
    return { attempted: 0, delivered: 0 };
  }
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Standalone entry (manual runs, parity with the other hooks): same
  // stdin/exit contract as the dispatcher — exit 0, silent on success.
  // Explicit exit (like dispatch.mjs): the ack socket can stay half-open
  // until the peer closes its side, which must never linger the hook past
  // its work — the line is already flushed to the kernel by then.
  try {
    await claudeReceiptAck(readInput());
  } catch {
    /* fail-open */
  }
  process.exit(0);
}
