/**
 * Background operator cards through the I7 shared event module (B3
 * CORE-2441; compact rework CORE-2517).
 *
 * A wake rests on one compact row: hollow glyph, identity, the state word
 * with its reason as an argument (`stopped: exited 0`, never `stopped`
 * twice), then two-space separated facts (elapsed, exit code, path, counts).
 * Expanding the row shows what actually ran — the exact command, the output
 * file and the cwd — so compaction never hides the record.
 *
 * Model envelopes stay byte-equal in ./store.ts (task-notification,
 * monitor-event, bracket notices); only the operator render changed.
 */

import {
  registerEventRenderer,
  type EventDetails,
} from "../../shared/event.ts";
import {
  formatElapsed,
  MONITOR_EVENT_TYPE,
  TASK_NOTIFICATION_TYPE,
} from "./store.ts";

/** Two-space field gap: no `·` on any operator row. */
const GAP = "  ";

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Aligned label block for the expanded wake body. Labels pad to the longest
 * one so command, output and cwd line up; empty fields drop out entirely.
 */
function labelled(pairs: Array<[string, string | undefined]>): string[] {
  const rows = pairs.filter((pair): pair is [string, string] => !!pair[1]);
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `${label.padEnd(width)}${GAP}${value}`);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The reason as the state's argument, never a second copy of the state:
 * `command exited (exit code 0)` becomes `exited 0`, `300000ms timeout`
 * becomes `5m timeout`. Unknown reasons pass through unchanged.
 */
export function compactStopReason(reason: string): string {
  const exit = /^command exited \(exit code (-?\d+)\)$/.exec(reason);
  if (exit) return `exited ${exit[1]}`;
  const signal = /^command exited \(signal ([A-Z0-9]+)\)$/.exec(reason);
  if (signal) return `signal ${signal[1]}`;
  const timeout = /^(\d+)ms timeout$/.exec(reason);
  if (timeout) return `${formatElapsed(Number(timeout[1]))} timeout`;
  if (reason === "stopped by BackgroundStop") return "by operator";
  if (reason.startsWith("firehose:")) return "firehose";
  if (reason.startsWith("command failed to start:")) return "failed to start";
  return reason;
}

/**
 * Map an injected task_notification to its compact row details. Null when
 * the message is not ours (another customType, a foreign shape). The
 * summary prose stays in the model envelope and is not repeated here.
 */
export function resolveTaskCard(message: unknown): EventDetails | null {
  const details = (message as { details?: unknown })?.details as
    | {
        task_id?: unknown;
        status?: unknown;
        summary?: unknown;
        output_file?: unknown;
        elapsed?: unknown;
        exit_code?: unknown;
        command?: unknown;
        cwd?: unknown;
      }
    | undefined;
  if (!details || typeof details !== "object") return null;
  const id = textField(details.task_id);
  const status = textField(details.status);
  if (!id || !status) return null;
  const outputFile = textField(details.output_file);
  const elapsed = textField(details.elapsed);
  const command = textField(details.command);
  const cwd = textField(details.cwd);
  const exitCode = numberField(details.exit_code);
  // Ordered facts: the renderer drops them from the end, so the path yields
  // before the exit code does on a narrow terminal.
  const factSegments = [elapsed, exitCode === undefined ? undefined : `exit ${exitCode}`, outputFile].filter(
    (part): part is string => !!part,
  );
  return {
    kind: "task",
    // Wakes render hollow: the state word and identity carry the kind.
    automatic: true,
    state: status,
    identity: `task ${id}`,
    preview: labelled([
      ["command", command],
      ["output", outputFile],
      ["cwd", cwd],
    ]),
    ...(factSegments.length > 0 ? { factSegments } : {}),
  };
}

/**
 * Map an injected monitor_event (or terminal notice) to its compact row.
 * Event previews come from the wake details, never re-parsed from the
 * envelope: a forged closing tag in output stays inert text.
 *
 * Count semantics: an event row says how many lines that wake delivered
 * (`N lines`), a terminal row says the record totals (`N events`, `N lines`
 * — the store counters). The two are never mixed on one row.
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
        elapsed?: unknown;
        command?: unknown;
        ws_url?: unknown;
        cwd?: unknown;
        output_file?: unknown;
      }
    | undefined;
  if (!details || typeof details !== "object") return null;
  const id = textField(details.monitor_id);
  const kind = textField(details.kind);
  if (!id || !kind) return null;
  const command = textField(details.command);
  const wsUrl = textField(details.ws_url);
  const cwd = textField(details.cwd);
  const outputFile = textField(details.output_file);
  const source = command ?? (wsUrl ? `ws ${wsUrl}` : undefined);
  if (kind === "event") {
    const lines = Array.isArray(details.lines)
      ? details.lines.filter((line): line is string => typeof line === "string")
      : [];
    const eventIndex = numberField(details.event_index);
    const first = lines[0];
    const factSegments = [
      eventIndex === undefined ? undefined : `#${eventIndex}`,
      plural(lines.length, "line", "lines"),
      first,
    ].filter((part): part is string => !!part);
    return {
      kind: "monitor",
      // Wakes render hollow: the state word and identity carry the kind.
      automatic: true,
      state: "event",
      identity: `monitor ${id}`,
      preview: [
        ...lines,
        ...labelled([
          ["command", source],
          ["output", outputFile],
          ["cwd", cwd],
        ]),
      ],
      ...(factSegments.length > 0 ? { factSegments } : {}),
    };
  }
  if (kind === "expired" || kind === "stopped") {
    const reason = textField(details.reason) ?? kind;
    const eventCount = numberField(details.event_count) ?? 0;
    const lineCount = numberField(details.line_count) ?? 0;
    const elapsed = textField(details.elapsed);
    const factSegments = [elapsed, plural(eventCount, "event", "events"), plural(lineCount, "line", "lines")].filter(
      (part): part is string => !!part,
    );
    // Firehose stops and start failures pin the indicator as failures, so the
    // row carries ! too instead of reading as an ordinary stop.
    const severityHigh = reason.startsWith("firehose:") || reason.startsWith("command failed to start:");
    return {
      kind: "monitor",
      // Wakes render hollow: the state word and identity carry the kind.
      automatic: true,
      state: kind,
      detail: compactStopReason(reason),
      identity: `monitor ${id}`,
      ...(severityHigh ? { severityHigh } : {}),
      preview: labelled([
        ["command", source],
        ["output", outputFile],
        ["cwd", cwd],
      ]),
      ...(factSegments.length > 0 ? { factSegments } : {}),
    };
  }
  return null;
}

/** Wire both background wakes to the shared card. Hosts without a renderer registry are ignored, not crashed. */
export function registerBackgroundCards(pi: unknown): void {
  registerEventRenderer(pi, TASK_NOTIFICATION_TYPE, resolveTaskCard);
  registerEventRenderer(pi, MONITOR_EVENT_TYPE, resolveMonitorCard);
}
