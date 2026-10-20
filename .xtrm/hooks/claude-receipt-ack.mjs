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
// Observability (CORE-2494) is file-append only (~/.xtrm/logs/claude-receipt-ack.log,
// CLAUDE_RECEIPT_ACK_DEBUG_FILE override) — debug lines never enter stdout/stderr.

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

// ── CORE-2494 debug sink ────────────────────────────────────────────────────
// File-append observability mirroring the #803 intercom-trace discipline:
// one machine-parseable line per hook event in the debug file, so a live
// Pi→Claude send can be classified from its own trail (fired/not-fired via
// the `invoke` line, parsed/not-parsed via `attempted`, delivered/dial-failed
// via per-target `receipt` lines) instead of reconstructed afterwards. The
// sink is a file, never stdout/stderr (prompt-pollution precedent #803:
// UserPromptSubmit stdout becomes model context). `CLAUDE_RECEIPT_ACK_DEBUG_FILE`
// redirects the sink (tests pin it to a temp dir). A debug write never
// throws: a broken sink must never break the ack it describes.

const DEBUG_PREFIX = '[claude-receipt-ack]';

function renderDebugValue(value) {
  if (value === undefined || value === null || value === '') return 'none';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

/**
 * Render one debug line. Key order follows the caller's object, so a test
 * can pin the exact line; values with whitespace are JSON-quoted to stay
 * parseable. Session attribution is added by receiptAckDebug, not here.
 */
export function receiptAckDebugLine(site, fields) {
  const rendered = Object.entries(fields ?? {}).map(([name, value]) => `${name}=${renderDebugValue(value)}`);
  return rendered.length > 0 ? `${DEBUG_PREFIX} ${site} ${rendered.join(' ')}` : `${DEBUG_PREFIX} ${site}`;
}

/** Debug file: temp override for tests, else the shared xtrm log. Read at call time. */
function receiptAckDebugFile() {
  const override = process.env['CLAUDE_RECEIPT_ACK_DEBUG_FILE'];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.xtrm', 'logs', 'claude-receipt-ack.log');
}

/**
 * Best-effort session identity for the `session=` field: the canonical
 * XTRM_SESSION_ID, then XTRM_SESSION_NAME, then the pid so a line is never
 * unattributed. Read at call time so tests can pin it per case.
 */
function receiptAckSessionRef() {
  const id = process.env['XTRM_SESSION_ID'] ?? process.env['XTRM_SESSION_NAME'];
  if (id !== undefined && id !== '') return id;
  return `pid-${process.pid}`;
}

/** Append one debug line to the debug file. Never throws; failures are silent. */
function receiptAckDebug(site, fields) {
  try {
    const file = receiptAckDebugFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${receiptAckDebugLine(site, fields)} session=${renderDebugValue(receiptAckSessionRef())}\n`, 'utf8');
  } catch {
    /* debug must never fail an ack */
  }
}

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
 *
 * CORE-2494 debug observability: every invocation appends one `invoke` line
 * (fired + parsed/not-parsed via the attempted count) plus one `receipt`
 * line per target (delivered/dial-failed), so a live send leaves a hook-side
 * trail readable without inference. File sink only (prompt-pollution
 * precedent #803), never throws, never changes ack behavior or exit code.
 */
export async function claudeReceiptAck(input, options = {}) {
  const event =
    typeof input?.hook_event_name === 'string' && input.hook_event_name !== ''
      ? input.hook_event_name
      : 'none';
  try {
    const targets = parseReceiptTargets(input);
    receiptAckDebug('invoke', { event, attempted: targets.length });
    if (targets.length === 0) return { attempted: 0, delivered: 0 };
    const results = await Promise.all(
      targets.map((target) => sendDeliveredReceipt(target.sockPath, target.messageId, options)),
    );
    const delivered = results.filter(Boolean).length;
    targets.forEach((target, index) => {
      receiptAckDebug('receipt', {
        sock: target.sockPath,
        orig_msg_id: target.messageId,
        outcome: results[index] ? 'delivered' : 'dial-failed',
      });
    });
    return { attempted: targets.length, delivered };
  } catch {
    try {
      receiptAckDebug('invoke', { event, attempted: 0 });
    } catch {
      /* debug must never break the fail-open path */
    }
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
