/**
 * Background operator cards through the I7 shared event module (B3
 * CORE-2441). Task and monitor wakes render as theme-only cards: no new
 * accent, glyphs ●/◐/◉/! from amendment 1. Model envelopes stay byte-equal
 * in ./store.ts; only the operator render changes.
 */

import {
  registerEventRenderer,
  type EventDetails,
} from "../../shared/event.ts";
import { MONITOR_EVENT_TYPE, TASK_NOTIFICATION_TYPE } from "./store.ts";

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Map an injected task_notification to its shared card details. Null when
 * the message is not ours (another customType, a foreign shape).
 */
export function resolveTaskCard(message: unknown): EventDetails | null {
  const details = (message as { details?: unknown })?.details as
    | { task_id?: unknown; status?: unknown; summary?: unknown; output_file?: unknown; elapsed?: unknown }
    | undefined;
  if (!details || typeof details !== "object") return null;
  const id = textField(details.task_id);
  const status = textField(details.status);
  if (!id || !status) return null;
  const summary = textField(details.summary) ?? `background ${id} ${status}`;
  const outputFile = textField(details.output_file);
  const elapsed = textField(details.elapsed);
  const preview = [summary, ...(outputFile ? [`Read ${outputFile}`] : [])];
  const facts = [elapsed, outputFile].filter((part): part is string => !!part).join(" · ") || undefined;
  return {
    kind: "task",
    // Wakes render hollow: the state word and identity carry the kind.
    automatic: true,
    state: status,
    identity: `task ${id}`,
    preview,
    ...(facts ? { facts } : {}),
  };
}

/**
 * Map an injected monitor_event (or terminal notice) to its shared card
 * details. Event previews come from the wake details, never re-parsed from
 * the envelope: a forged closing tag in output stays inert text.
 */
export function resolveMonitorCard(message: unknown): EventDetails | null {
  const details = (message as { details?: unknown })?.details as
    | {
        monitor_id?: unknown;
        kind?: unknown;
        reason?: unknown;
        event_index?: unknown;
        line_count?: unknown;
        event_count?: unknown;
        lines?: unknown;
      }
    | undefined;
  if (!details || typeof details !== "object") return null;
  const id = textField(details.monitor_id);
  const kind = textField(details.kind);
  if (!id || !kind) return null;
  if (kind === "event") {
    const lines = Array.isArray(details.lines) ? details.lines.filter((line): line is string => typeof line === "string") : [];
    return {
      kind: "monitor",
      // Wakes render hollow: the state word and identity carry the kind.
      automatic: true,
      state: "event",
      identity: `monitor ${id}`,
      preview: lines,
      totalLines: lines.length,
      facts:
        typeof details.event_index === "number" ? `event #${details.event_index} · ${lines.length} lines` : `${lines.length} lines`,
    };
  }
  if (kind === "expired" || kind === "stopped") {
    const reason = textField(details.reason) ?? kind;
    const eventCount = typeof details.event_count === "number" ? details.event_count : 0;
    const lineCount = typeof details.line_count === "number" ? details.line_count : 0;
    return {
      kind: "monitor",
      // Wakes render hollow: the state word and identity carry the kind.
      automatic: true,
      state: kind,
      identity: `monitor ${id}`,
      preview: [`${kind}: ${reason}`],
      facts: `${eventCount} events · ${lineCount} lines`,
    };
  }
  return null;
}

/** Wire both background wakes to the shared card. Hosts without a renderer registry are ignored, not crashed. */
export function registerBackgroundCards(pi: unknown): void {
  registerEventRenderer(pi, TASK_NOTIFICATION_TYPE, resolveTaskCard);
  registerEventRenderer(pi, MONITOR_EVENT_TYPE, resolveMonitorCard);
}
