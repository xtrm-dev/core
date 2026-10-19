/**
 * CORE-2488 phase 1: intercom leg tracing (instrumentation only).
 *
 * One machine-parseable line per leg event on stderr, so a live SendMessage
 * can be classified from its own trace instead of reconstructed afterwards.
 * The line shape is stable (`[intercom-trace] <site> key=value ...`): absent
 * values render `none`, so a missing socket reads as `sock=none` instead of
 * silently dropping the field that explains the failure.
 *
 * Nothing here decides routing, delivery or state. A trace never throws: a
 * broken trace must never break the send it describes.
 */

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

/** Emit one trace line to stderr. Never throws. */
export function intercomTrace(site: string, fields: Record<string, TraceValue>): void {
  try {
    console.error(traceLine(site, fields));
  } catch {
    /* tracing must never fail a send */
  }
}
