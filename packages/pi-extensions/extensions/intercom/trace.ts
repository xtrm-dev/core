/**
 * CORE-2488 phase 1: intercom leg tracing (instrumentation only).
 * CORE-2489: the sink is an append-only file, never stderr. The Pi extension
 * runtime surfaces extension stderr into prompt context, so the previous
 * stderr sink printed every trace line into the model's visible prompt area.
 * Diagnostics must never enter the conversation.
 *
 * One machine-parseable line per leg event in the trace file, so a live
 * SendMessage can be classified from its own trace instead of reconstructed
 * afterwards. The line shape is stable (`[intercom-trace] <site> key=value ...`):
 * absent values render `none`, so a missing socket reads as `sock=none` instead
 * of silently dropping the field that explains the failure. Every line carries
 * the session id (`session=...`) so sessions sharing one file stay attributable;
 * `INTERCOM_TRACE_FILE` redirects the sink (tests pin it to a temp file).
 *
 * Nothing here decides routing, delivery or state. A trace never throws: a
 * broken trace must never break the send it describes.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TRACE_PREFIX = "[intercom-trace]";

export type TraceValue = string | number | boolean | null | undefined;

/**
 * Render one trace line. Key order follows the caller's object, so a test can
 * pin the exact line; values with whitespace are JSON-quoted to stay parseable.
 */
export function traceLine(site: string, fields: Record<string, TraceValue>): string {
  const rendered = Object.entries(fields).map(([name, value]) => `${name}=${renderValue(value)}`);
  return rendered.length > 0 ? `${TRACE_PREFIX} ${site} ${rendered.join(" ")}` : `${TRACE_PREFIX} ${site}`;
}

function renderValue(value: TraceValue): string {
  if (value === undefined || value === null || value === "") return "none";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

/** Trace file: temp override for tests, else the shared xtrm log. Read at call time. */
function traceFile(): string {
  const override = process.env["INTERCOM_TRACE_FILE"];
  if (override !== undefined && override !== "") return override;
  return join(homedir(), ".xtrm", "logs", "intercom-trace.log");
}

/**
 * Best-effort session identity for the `session=` field: the canonical
 * XTRM_SESSION_ID, then XTRM_SESSION_NAME, then the pid so a line is never
 * unattributed. Read at call time so tests can pin it per case.
 */
function sessionRef(): string {
  const id = process.env["XTRM_SESSION_ID"] ?? process.env["XTRM_SESSION_NAME"];
  if (id !== undefined && id !== "") return id;
  return `pid-${process.pid}`;
}

/** Append one trace line to the trace file. Never throws; failures are silent. */
export function intercomTrace(site: string, fields: Record<string, TraceValue>): void {
  try {
    const file = traceFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${traceLine(site, fields)} session=${renderValue(sessionRef())}\n`, "utf8");
  } catch {
    /* tracing must never fail a send */
  }
}
