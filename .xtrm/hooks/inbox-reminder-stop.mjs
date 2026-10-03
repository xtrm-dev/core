#!/usr/bin/env node
// Stop: surface unread pane-scoped inbound messages once each.
//
// xtrm-wiy5n.4.24. Pi polls its inbox on a bounded 30 s cycle; Claude had no
// equivalent surface. The xtmux side of the PR (Jaggerxtrm/xtmux#87) makes
// `message-list --pane $TMUX_PANE` resolve `--for` from live tmux, so this
// hook can query the pane's inbox in one call.
//
// Output channel — Codex #525:
//   Claude's Stop hook contract surfaces stdout on exit 0 (stderr is only
//   read on exit != 0, and blocking Stop is out of scope here). Emit
//   `{"systemMessage": "..."}` on stdout so the reminder actually reaches
//   the operator when the hook succeeds. Fall back to stderr only when the
//   subprocess encounters a real error (the catch below).
//
// Anti-spin (mandatory, PR body must state it):
//   - Fires on Stop only; there is no poller, no daemon.
//   - Skips when `stop_hook_active` is true, matching the existing Stop hook.
//   - Records each surfaced messageKey in the tmux option
//     `@agent_inbox_reminded_keys` (comma-separated). Same-message-still-
//     pending on the next Stop is INTENTIONALLY silent: it stays recorded
//     and stays silent until the operator acks or replies (at which point
//     the row leaves the `--unacked` projection anyway). A NEW message on
//     a later Stop is a NEW key and gets its own one-time reminder.
//   - Bounded per Stop: at most `--limit LIMIT` rows + one option read +
//     one option write. No retries, no loops.
//   - Registry-write ordering (Codex #525): the anti-spin key MUST persist
//     BEFORE the reminder is emitted. If the write fails (pane gone between
//     query and write, tmux server crash mid-write), the hook aborts the
//     reminder rather than surface a message it will re-surface forever.
//     Reminder + write in the wrong order would silently violate the whole
//     bounded-work guarantee.
//
// Skipped entirely when there is no live tmux pane (TMUX_PANE unset): the
// query surface itself has nothing to resolve to, and this hook exists to
// serve tmux-panes, not headless invocations.
//
// XTRM-592: Claude runs this inside `dispatch.mjs event` (one xt hook process
// per event, CORE-2339); the dispatcher imports inboxReminder() and writes its
// output. The CLI entry below keeps the standalone hook runnable.
import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PICKER = process.env.XTMUX_PICKER || `${process.env.HOME}/.local/bin/xtmux`;
const LIMIT = Math.max(1, Math.min(Number(process.env.XTMUX_INBOX_REMINDER_LIMIT ?? 5) || 5, 25));
const OPTION_NAME = "@agent_inbox_reminded_keys";
const MAX_REMINDED_KEYS = 128;
const CMD_TIMEOUT_MS = 5000;

function readInput() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return null; }
}

function pickerJson(args, command) {
  const result = spawnSync(PICKER, args, { encoding: "utf8", timeout: CMD_TIMEOUT_MS });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || `exit ${result.status}`).trim().replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  try { return JSON.parse(result.stdout || ""); }
  catch (error) { throw new Error(`Malformed ${command} JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function readRemindedKeys(pane) {
  const result = spawnSync("tmux", ["show-options", "-p", "-t", pane, "-qv", OPTION_NAME], { encoding: "utf8", timeout: CMD_TIMEOUT_MS });
  if (result.status !== 0) return new Set();
  return new Set(String(result.stdout || "").trim().split(",").filter(Boolean));
}

// Persist the anti-spin registry FIRST — if the tmux write fails, we MUST NOT
// surface the reminder. A reminder that outlives its registry entry re-fires
// on every subsequent Stop and violates the anti-spin guarantee.
function persistRemindedKeys(pane, keys) {
  const bounded = keys.slice(Math.max(0, keys.length - MAX_REMINDED_KEYS));
  const r = spawnSync("tmux", ["set-option", "-p", "-t", pane, OPTION_NAME, bounded.join(",")], { encoding: "utf8", timeout: CMD_TIMEOUT_MS });
  return r.status === 0;
}

function formatReminder(row) {
  const sender = String(row.senderId ?? "?");
  const bead = row.beadId ? ` (${row.beadId})` : "";
  const summary = String(row.summary ?? "").replace(/\s+/g, " ").slice(0, 200);
  // Codex #525: include the messageKey. Without it an operator who sees the
  // reminder can't run the suggested `xtmux message-reply --in-reply-to`
  // command; when multiple messages arrive the correlation is ambiguous.
  const key = String(row.messageKey ?? "?");
  return row.expectsReply
    ? `Reply required: ${sender}${bead} [${key}]: ${summary}\n    reply: xtmux message-reply --in-reply-to ${key} --text ...`
    : `Inbox FYI: ${sender}${bead} [${key}]: ${summary}`;
}

function systemMessage(text) {
  // Claude hooks contract: on exit 0, stdout is surfaced to the operator.
  // Emit a single JSON envelope with `systemMessage` so the reminder is
  // routed through the supported channel (Hooks reference: systemMessage
  // is shown in the transcript). Not blocking; Stop still proceeds.
  return JSON.stringify({ systemMessage: text }) + "\n";
}

/**
 * The reminder for one Stop payload: `{ stdout }` carries the systemMessage
 * envelope, `{ stderr }` a diagnostic, `{}` means stay silent. Never throws.
 */
export function inboxReminder(input) {
  if (process.env.XTMUX_INBOX_REMINDER_DISABLE === "1") return {};
  const pane = process.env.TMUX_PANE;
  if (!pane) return {};
  if (input && input.stop_hook_active) return {};

  try {
    const rows = pickerJson(
      ["message-list", "--pane", pane, "--unacked", "--expects-reply", "--json", "--limit", String(LIMIT)],
      "message-list",
    );
    if (!Array.isArray(rows) || rows.length === 0) return {};
    const invalid = rows.filter((row) => typeof row?.messageKey !== "string");
    if (invalid.length > 0) throw new Error("Incompatible message-list JSON result");

    const alreadyReminded = readRemindedKeys(pane);
    const fresh = rows.filter((row) => !alreadyReminded.has(String(row.messageKey)));
    if (fresh.length === 0) return {};

    // Anti-spin ordering (Codex #525): persist the registry BEFORE emitting
    // the reminder. If the write fails, abort silently — a reminder we can
    // never mark "already told" would re-fire forever and violate the whole
    // bounded-work property. Silence here is safe: the row is still in the
    // pane's inbox and will surface on a later Stop once tmux is healthy.
    const updated = [...alreadyReminded, ...fresh.map((row) => String(row.messageKey))];
    if (!persistRemindedKeys(pane, updated)) return {};

    const lines = fresh.map((row) => `xtmux inbox: ${formatReminder(row)}`);
    lines.push(`xtmux inbox: reply with \`xtmux message-reply --in-reply-to <messageKey> --text ...\` (${fresh.length} new; ${rows.length - fresh.length} suppressed as already reminded).`);
    return { stdout: systemMessage(lines.join("\n")) };
  } catch (error) {
    // Best-effort: never block Stop. Emit the diagnostic on stderr so a
    // broken CLI surface stays visible without derailing the operator.
    return { stderr: `xtmux inbox reminder unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 300)}\n` };
  }
}

function main() {
  // Same order as before: no stdin read when disabled or headless.
  if (process.env.XTMUX_INBOX_REMINDER_DISABLE === "1" || !process.env.TMUX_PANE) return;
  const { stdout, stderr } = inboxReminder(readInput());
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
