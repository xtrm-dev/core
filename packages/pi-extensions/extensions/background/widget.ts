/**
 * Background indicator above the prompt (B3 CORE-2441, ADR rev 2 B2 + D-5).
 *
 * While anything runs, one line reads "3 running  1 monitor  /bg": text
 * states every status (no glyph duplicates the word, CORE-2517), fields sit
 * on two-space gaps. A failure stays as "1 failed" until the operator sees
 * it (opening /bg or the record's output marks it seen). Idle means no
 * widget at all. The line is exactly one row (stable height) and truncates
 * to the render width, so it never pushes the editor off-screen at 80, 120,
 * 160 or 220 columns. Theme never touches this line: it is plain text.
 *
 * Refreshes come from the store subscription (no polling): every create,
 * mutation, seen flip and eviction re-renders. The ui handle is captured
 * from session_start and tool/command contexts and may be absent (headless
 * runs, tests); refresh without one is a silent no-op.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  isMonitorFailureStatus,
  isTaskFailure,
  type BackgroundMonitorRecord,
  type BackgroundStore,
  type BackgroundTaskRecord,
} from "./store.ts";

export { isTaskFailure };

/** Widget slot key. Bare name: no xtrm- slug. */
export const BACKGROUND_WIDGET_KEY = "background";

export interface BackgroundSummary {
  runningTasks: number;
  activeMonitors: number;
  unseenFailures: number;
}

/** Monitors that pin the ! part: firehose stops, not exits, stops or expiry. */
export function isMonitorFailure(record: Pick<BackgroundMonitorRecord, "status" | "killReason" | "seen">): boolean {
  return isMonitorFailureStatus(record.status, record.killReason) && !record.seen;
}

export function summarizeBackground(
  tasks: BackgroundTaskRecord[],
  monitors: BackgroundMonitorRecord[],
): BackgroundSummary {
  let runningTasks = 0;
  let activeMonitors = 0;
  let unseenFailures = 0;
  for (const task of tasks) {
    if (task.status === "running") runningTasks += 1;
    else if (isTaskFailure(task.status) && !task.seen) unseenFailures += 1;
  }
  for (const monitor of monitors) {
    if (monitor.status === "armed" || monitor.status === "event") activeMonitors += 1;
    else if (isMonitorFailure(monitor)) unseenFailures += 1;
  }
  return { runningTasks, activeMonitors, unseenFailures };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The D-5 line, or null when idle. Text states every status (CORE-2517):
 * no glyph duplicates the word, and fields sit on two-space gaps instead of
 * `·`. Shapes: "3 running  1 monitor  /bg", "2 running  1 failed  /bg".
 */
export function formatIndicator(summary: BackgroundSummary): string | null {
  const { runningTasks, activeMonitors, unseenFailures } = summary;
  if (runningTasks === 0 && activeMonitors === 0 && unseenFailures === 0) return null;
  const parts: string[] = [];
  if (runningTasks > 0) parts.push(`${runningTasks} running`);
  if (activeMonitors > 0) parts.push(plural(activeMonitors, "monitor", "monitors"));
  if (unseenFailures > 0) parts.push(`${unseenFailures} failed`);
  parts.push("/bg");
  return parts.join("  ");
}

/**
 * Width-safe cut with a repair fallback. Several older suites stub
 * pi-tui process-wide through bun's mock.module (identity or naive-slice
 * truncateToWidth), and which stub wins depends on scheduling: the real
 * library locally, a stub in CI. First try truncateToWidth; if the result
 * still overflows per visibleWidth, hard-cut the longest fitting raw
 * prefix plus "...". The repair loop always terminates (the prefix
 * shrinks every pass; "..." fits any maxWidth >= 8, which every caller
 * guarantees). The width invariant holds under every stub; the exact cut
 * point and ellipsis styling may differ, so tests assert widths, never
 * the literal cut text.
 */
/** Repair primitive for fitToWidth below: longest fitting raw prefix plus "...". */
export function hardCut(line: string, maxWidth: number): string {
  const width = Math.max(8, Math.floor(maxWidth) || 80);
  if (visibleWidth(line) <= width) return line;
  const ellipsis = "...";
  let prefix = line;
  while (prefix.length > 0 && visibleWidth(`${prefix}${ellipsis}`) > width) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${ellipsis}`;
}

export function fitToWidth(line: string, maxWidth: number): string {
  const width = Math.max(8, Math.floor(maxWidth) || 80);
  const first = truncateToWidth(line, width);
  if (visibleWidth(first) <= width) return first;
  return hardCut(line, width);
}

/**
 * Width-safe render: zero lines when idle, exactly one otherwise (stable
 * height). Every line fits the width by display width.
 */
export function renderIndicator(summary: BackgroundSummary, width: number): string[] {
  const line = formatIndicator(summary);
  if (!line) return [];
  const safe = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
  return [fitToWidth(line, Math.max(8, safe))];
}

/** The ui surface the widget needs (duck-typed; tests inject a fake). */
export type BackgroundWidgetUi = Pick<ExtensionUIContext, "setWidget">;

export interface BackgroundWidget {
  refresh(): void;
  dispose(): void;
}

/**
 * Follow the store and mirror the indicator into the widget slot. The
 * component reads the store live at render width, so resizes stay safe
 * without another refresh.
 */
export function createBackgroundWidget(
  store: Pick<BackgroundStore, "list" | "listMonitors" | "subscribe">,
  getUi: () => BackgroundWidgetUi | undefined,
): BackgroundWidget {
  const render = (): void => {
    const ui = getUi();
    if (!ui) return;
    const summary = summarizeBackground(store.list(), store.listMonitors());
    try {
      if (summary.runningTasks === 0 && summary.activeMonitors === 0 && summary.unseenFailures === 0) {
        ui.setWidget(BACKGROUND_WIDGET_KEY, undefined);
        return;
      }
      ui.setWidget(BACKGROUND_WIDGET_KEY, () => ({
        render: (width: number) => renderIndicator(summarizeBackground(store.list(), store.listMonitors()), width),
        invalidate: () => {},
        dispose: () => {},
      }));
    } catch {
      /* headless runtimes without widgets; the store stays the truth */
    }
  };
  const unsubscribe = store.subscribe(() => render());
  return {
    refresh: render,
    dispose: () => {
      unsubscribe();
      try {
        getUi()?.setWidget(BACKGROUND_WIDGET_KEY, undefined);
      } catch {
        /* already gone */
      }
    },
  };
}
