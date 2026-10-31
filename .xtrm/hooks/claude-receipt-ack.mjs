#!/usr/bin/env node
// claude-receipt-ack.mjs — delivered receipts for Pi→Claude cross-session frames (CORE-2492, CORE-2496).
//
// Symptom: every Pi→Claude send starves to `unconfirmed`. The Pi side waits up
// to 30 s for a `peer_message_status` receipt (ClaudeReceiptWaiter); no code on
// any Claude-loaded path emitted one — hooks/dispatch.mjs `runEvent` handled
// Stop only and UserPromptSubmit fell through. This module is the missing
// emitter, on two paths:
//   - UserPromptSubmit (CORE-2492): parses the injected
//     `<cross-session-message message-id from="uds:...">` envelope out of
//     the hook payload prompt and sends one `peer_message_status`/`delivered`
//     NDJSON line back to the sender's socket.
//   - Stop (CORE-2496): socket-injected frames bypass UserPromptSubmit
//     (native-closed delivery — the prompt hook never fires), so the ack is
//     delayed to turn end: the Stop branch tail-scans transcript_path since
//     the last acked position and emits one delivered receipt per newly-
//     appeared envelope with message-id + uds: from.
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
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

/** Upper bound on transcript bytes scanned per Stop (positioned tail read, never the whole file). */
export const MAX_TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

/** Upper bound on tracked transcripts in the Stop position state (position only, never content). */
export const MAX_STATE_ENTRIES = 50;

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
 * Stop position state file (CORE-2496): byte offsets per transcript_path.
 * Temp override for tests, else a sibling of the debug file so the two stay
 * co-located ("beside the debug log"). Deriving from the debug file keeps
 * unit runs hermetic when only CLAUDE_RECEIPT_ACK_DEBUG_FILE is pinned to a
 * temp dir. Position only — never transcript content — so the file stays
 * bounded (MAX_STATE_ENTRIES keys × one offset each). Read at call time.
 */
export function receiptAckStateFile() {
  const override = process.env['CLAUDE_RECEIPT_ACK_STATE_FILE'];
  if (override !== undefined && override !== '') return override;
  return join(dirname(receiptAckDebugFile()), 'claude-receipt-ack.stop-state.json');
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
 * Every (messageId, sender-socket) pair in one text blob: one entry per
 * `<cross-session-message … message-id="…" … from="uds:…" …>` opening tag
 * carrying BOTH attributes. Tags without a message-id (the protocol envelope
 * omits it) or without a uds: return address yield no receipt — the Pi waiter
 * keys on orig_msg_id, so a receipt without it resolves nothing. Never throws.
 *
 * Shared by the UserPromptSubmit prompt scan and the Stop transcript
 * tail-scan (CORE-2496): the transcript is JSONL, so attributes arrive
 * JSON-escaped (`message-id=\"m-1\"`), but the quote characters are still
 * present and the same tag regex applies — no separate grammar needed.
 */
function parseTargetsFromText(text) {
  const targets = [];
  const seen = new Set();
  const tagRe = /<cross-session-message\b[^>]*>/g;
  let tag;
  while ((tag = tagRe.exec(text)) !== null) {
    // Optional backslash around quotes: transcript JSONL arrives JSON-escaped
    // (`message-id=\"m-1\"`) while prompts carry bare quotes. The lazy
    // capture plus trailing `\\?` keeps the escape's backslash out of the
    // value on both shapes without changing bare-quote results.
    const idMatch = /message-id\s*=\s*\\?(?:"([^"]+?)\\?"|'([^']+?)\\?')/.exec(tag[0]);
    const fromMatch = /(?:^|\s)from\s*=\s*\\?(?:"([^"]+?)\\?"|'([^']+?)\\?')/.exec(tag[0]);
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
}

/**
 * Every (messageId, sender-socket) pair in the UserPromptSubmit prompt.
 * Never throws.
 */
export function parseReceiptTargets(input) {
  try {
    const prompt = extractPromptText(input);
    if (!prompt) return [];
    const text = prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;
    return parseTargetsFromText(text);
  } catch {
    return [];
  }
}

/**
 * The inbound text of one transcript record, or '' (CORE-2554 C3). Only
 * records that carry a delivered message count: a user record's string or
 * text parts (tool_result parts excluded), and a queued_command attachment
 * (a message absorbed mid-turn). An envelope quoted by the assistant, in a
 * tool result, or in a request log is not a delivery and draws no receipt.
 */
function inboundRecordText(record) {
  if (!record || typeof record !== 'object') return '';
  if (record.type === 'user' && record.message?.role === 'user') {
    const content = record.message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    }
    return '';
  }
  if (record.type === 'attachment' && record.attachment?.type === 'queued_command' && typeof record.attachment.prompt === 'string') {
    return record.attachment.prompt;
  }
  return '';
}

/**
 * Every (messageId, sender-socket) pair in one transcript tail chunk
 * (CORE-2496). The chunk is JSONL: each line parses as one record and only
 * inbound records are scanned (CORE-2554 C3); a line that does not parse
 * (a partial tail) is skipped. Same tag grammar as the prompt scan; the
 * chunk is already bounded by the positioned tail read. Never throws.
 */
export function parseTranscriptTargets(text) {
  try {
    if (typeof text !== 'string' || !text) return [];
    const inbound = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const recordText = inboundRecordText(record);
      if (recordText) inbound.push(recordText);
    }
    return inbound.length > 0 ? parseTargetsFromText(inbound.join('\n')) : [];
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
 * Send one delivered receipt per target and log one `receipt` debug line per
 * target (delivered/dial-failed). Shared by the UserPromptSubmit prompt path
 * and the Stop transcript path (CORE-2496 refactor: identical wire bytes and
 * identical debug shape on both paths). Never throws, never touches
 * stdout/stderr; resolves with `{ attempted, delivered }`.
 */
export async function emitDeliveredReceipts(targets, options = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return { attempted: 0, delivered: 0 };
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
    return await emitDeliveredReceipts(targets, options);
  } catch {
    try {
      receiptAckDebug('invoke', { event, attempted: 0 });
    } catch {
      /* debug must never break the fail-open path */
    }
    return { attempted: 0, delivered: 0 };
  }
}

// ── CORE-2496 Stop path: transcript tail-scan with position state ─────────
// Socket-injected frames bypass UserPromptSubmit (native-closed delivery),
// so the #804 prompt hook never fires for them. The Stop branch acks them at
// turn end instead: read transcript_path since the last acked byte offset,
// emit one delivered receipt per newly-appeared envelope with message-id +
// uds: from, and advance the offset. Per-message precise (one receipt per
// envelope, deduped within the chunk), delayed to turn end, fail-open with
// exit code unchanged and nothing on stdout (sockets + debug file only).
//
// Duplicate-delivery note: a prompt-path frame acked by #804 also lands in
// the transcript, so Stop re-acks it. That duplicate is benign: the Pi waiter
// resolves on the first receipt and drops later ones (no waiter → dropped),
// and precisely-once across the two paths would need shared acked-id state
// the position-only file deliberately avoids (bounded: position, no content).

function expandHome(pathValue) {
  if (typeof pathValue === 'string' && pathValue.startsWith('~/')) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

/** Load the offset map `{ [transcriptPath]: offset }`. Never throws. */
function loadStopOffsets(stateFile) {
  try {
    if (!stateFile || !existsSync(stateFile)) return {};
    const raw = readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    const offsets = parsed && typeof parsed === 'object' ? (parsed.offsets ?? parsed) : null;
    if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return {};
    const clean = {};
    for (const [key, value] of Object.entries(offsets)) {
      if (typeof key === 'string' && key && Number.isFinite(value) && value >= 0) {
        clean[key] = Math.floor(value);
      }
    }
    return clean;
  } catch {
    return {};
  }
}

/** Store one offset, evicting oldest keys past the bound. Never throws. */
function saveStopOffset(stateFile, transcriptPath, offset) {
  try {
    if (!stateFile || !transcriptPath) return;
    const offsets = loadStopOffsets(stateFile);
    delete offsets[transcriptPath];
    offsets[transcriptPath] = Math.max(0, Math.floor(offset));
    const keys = Object.keys(offsets);
    for (let index = 0; index < keys.length - MAX_STATE_ENTRIES; index += 1) {
      delete offsets[keys[index]];
    }
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, offsets }), 'utf8');
    renameSync(tmp, stateFile);
  } catch {
    /* state must never fail an ack */
  }
}

/**
 * Read transcript bytes since the last acked position (CORE-2496).
 * Positioned bounded tail read: opens the file, seeks to the stored offset,
 * and reads at most MAX_TRANSCRIPT_TAIL_BYTES — never the whole file.
 * Resolves with `{ text, start, end }` where end is the current file size
 * (the next offset to store). Never throws; on any failure resolves with an
 * empty text and the previous offset so the caller stays fail-open.
 */
export function readTranscriptTail(transcriptPath, options = {}) {
  const stateFile = options.stateFile ?? receiptAckStateFile();
  try {
    const resolved = expandHome(transcriptPath);
    if (typeof resolved !== 'string' || !resolved) return { text: '', start: 0, end: 0 };
    let size;
    try {
      size = statSync(resolved).size;
    } catch {
      return { text: '', start: 0, end: 0 };
    }
    if (!Number.isFinite(size) || size < 0) return { text: '', start: 0, end: 0 };
    const offsets = loadStopOffsets(stateFile);
    let stored = offsets[transcriptPath];
    if (transcriptPath !== resolved && offsets[resolved] !== undefined) stored = offsets[resolved];
    let start;
    if (stored === undefined) {
      // First run: no history to replay — tail only, so old turns never spam.
      start = Math.max(0, size - MAX_TRANSCRIPT_TAIL_BYTES);
    } else if (!Number.isFinite(stored) || stored < 0 || stored > size) {
      // Rotation/truncation: re-anchor to the tail instead of the whole file.
      start = Math.max(0, size - MAX_TRANSCRIPT_TAIL_BYTES);
    } else {
      start = stored;
    }
    if (size <= start) return { text: '', start: size, end: size };
    const end = size;
    const wanted = end - start;
    const len = Math.min(wanted, MAX_TRANSCRIPT_TAIL_BYTES);
    const readStart = end - len;
    let fd = -1;
    try {
      fd = openSync(resolved, 'r');
      const buffer = Buffer.alloc(len);
      const bytesRead = readSync(fd, buffer, 0, len, readStart);
      return { text: buffer.subarray(0, Math.max(0, bytesRead)).toString('utf8'), start: readStart, end };
    } finally {
      try {
        if (fd !== -1) closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  } catch {
    return { text: '', start: 0, end: 0 };
  }
}

/**
 * Ack every newly-appeared injected frame in the transcript tail (CORE-2496).
 * Runs in the Stop branch after the inbox reminder. Resolves with
 * `{ attempted, delivered }`; the dispatcher ignores them. Never throws,
 * never touches stdout/stderr, never changes the hook's exit code.
 */
export async function claudeReceiptAckStop(input, options = {}) {
  const stateFile = options.stateFile ?? receiptAckStateFile();
  try {
    const transcriptPath = input?.transcript_path ?? input?.transcriptPath;
    if (typeof transcriptPath !== 'string' || !transcriptPath) {
      receiptAckDebug('invoke', { event: 'Stop', attempted: 0 });
      return { attempted: 0, delivered: 0 };
    }
    const tail = readTranscriptTail(transcriptPath, { stateFile });
    const targets = parseTranscriptTargets(tail.text);
    receiptAckDebug('invoke', { event: 'Stop', attempted: targets.length });
    let result = { attempted: 0, delivered: 0 };
    if (targets.length > 0) {
      result = await emitDeliveredReceipts(targets, options);
    }
    // Advance past what was read even on dial failure: the sender's 30 s
    // waiter outlives a dead socket retry, and re-acking the same turn on
    // every later Stop would spam. A read failure (end 0) stores nothing.
    if (tail.end > 0) saveStopOffset(stateFile, transcriptPath, tail.end);
    return result;
  } catch {
    try {
      receiptAckDebug('invoke', { event: 'Stop', attempted: 0 });
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
