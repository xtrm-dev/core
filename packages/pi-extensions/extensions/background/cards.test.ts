import { describe, expect, test } from "bun:test";

import {
  compactStopReason,
  registerBackgroundCards,
  resolveMonitorCard,
  resolveTaskCard,
} from "./cards.ts";
import { MONITOR_EVENT_TYPE, TASK_NOTIFICATION_TYPE } from "./index.ts";
import { formatEventCard, glyphFor } from "../../shared/event.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

function card(details: unknown, width = 80, expanded = false): string {
  return formatEventCard(details as never, theme, width, { expanded });
}

describe("task cards through the I7 module", () => {
  test("a failed task rests on one compact row with exit code and path", () => {
    const details = resolveTaskCard({
      details: {
        task_id: "bg_1a2b",
        status: "failed",
        summary: 'Background command "make build" failed (exit code 2)',
        output_file: "/tmp/background-bg_1a2b.log",
        elapsed: "12.5s",
        exit_code: 2,
        command: "make build",
        cwd: "/work",
      },
    });
    expect(details).not.toBeNull();
    expect(details).toMatchObject({ kind: "task", state: "failed", identity: "task bg_1a2b" });
    expect(glyphFor(details as never)).toBe("!");
    const row = card(details);
    // One line: nothing wraps, and the state is stated once.
    expect(row.split("\n")).toHaveLength(1);
    expect(row).toBe("! task bg_1a2b  failed  12.5s  exit 2  /tmp/background-bg_1a2b.log");
    // The model-facing summary prose does not leak into the operator row.
    expect(row).not.toContain("Background command");
  });

  test("a completed task renders hollow and keeps the output path once", () => {
    const details = resolveTaskCard({
      details: {
        task_id: "bg_1a2b",
        status: "completed",
        summary: 'Background command "true" completed (exit code 0)',
        output_file: "/tmp/background-bg_1a2b.log",
        elapsed: "0.1s",
        exit_code: 0,
        command: "true",
      },
    });
    expect(details).toMatchObject({ kind: "task", state: "completed" });
    expect(glyphFor(details as never)).toBe("○");
    const row = card(details);
    expect(row).toBe("○ task bg_1a2b  completed  0.1s  exit 0  /tmp/background-bg_1a2b.log");
    // No duplicate "Read <file>" line: the path appears exactly once.
    expect(row.split("/tmp/background-bg_1a2b.log")).toHaveLength(2);
    // Expanding shows the exact command, the output file and the cwd.
    const expanded = card(details, 80, true).split("\n");
    expect(expanded[0]).toBe(row);
    expect(expanded).toContain("  command  true");
    expect(expanded).toContain("  output   /tmp/background-bg_1a2b.log");
  });

  test("a narrow row drops the path before the status facts", () => {
    const details = resolveTaskCard({
      details: {
        task_id: "bg_1",
        status: "failed",
        exit_code: 2,
        elapsed: "1.2s",
        output_file: "/tmp/background-bg_1.log/some/deeper/directory",
      },
    });
    const row = card(details, 60);
    expect(row).toBe("! task bg_1  failed  1.2s  exit 2");
  });

  test("garbage resolves to null, never a crash", () => {
    expect(resolveTaskCard(null)).toBeNull();
    expect(resolveTaskCard({})).toBeNull();
    expect(resolveTaskCard({ details: { status: "completed" } })).toBeNull();
    expect(resolveTaskCard({ details: "nope" })).toBeNull();
  });
});

describe("monitor cards through the I7 module", () => {
  test("an event row counts the lines that wake delivered and shows the first", () => {
    const details = resolveMonitorCard({
      details: {
        monitor_id: "mn_3c4d",
        kind: "event",
        event_index: 2,
        line_count: 3,
        lines: ["build ok", "tests ok", "done"],
        command: "tail -f app.log",
      },
    });
    expect(details).toMatchObject({ kind: "monitor", state: "event", identity: "monitor mn_3c4d" });
    expect(glyphFor(details as never)).toBe("○");
    const row = card(details);
    expect(row.split("\n")).toHaveLength(1);
    expect(row).toBe("○ monitor mn_3c4d  event  #2  3 lines  build ok");
    // Expanding shows every delivered line and what was running.
    const expanded = card(details, 80, true).split("\n");
    expect(expanded).toEqual([
      "○ monitor mn_3c4d  event  #2  3 lines  build ok",
      "  build ok",
      "  tests ok",
      "  done",
      "  command  tail -f app.log",
    ]);
  });

  test("a terminal row states the reason once, as the state's argument", () => {
    const details = resolveMonitorCard({
      details: {
        monitor_id: "mn_3c4d",
        kind: "stopped",
        reason: "command exited (exit code 0)",
        event_count: 5,
        line_count: 41,
        elapsed: "1m20s",
      },
    });
    expect(details).toMatchObject({ kind: "monitor", state: "stopped" });
    const row = card(details);
    expect(row).toBe("○ monitor mn_3c4d  stopped: exited 0  1m20s  5 events  41 lines");
    // The word "stopped" appears exactly once.
    expect(row.split("stopped")).toHaveLength(2);
  });

  test("an expired monitor renders its timeout as the reason", () => {
    const details = resolveMonitorCard({
      details: { monitor_id: "mn_1", kind: "expired", reason: "300000ms timeout", event_count: 7, line_count: 9 },
    });
    expect(card(details)).toBe("○ monitor mn_1  expired: 5m timeout  7 events  9 lines");
  });

  test("garbage resolves to null, never a crash", () => {
    expect(resolveMonitorCard(null)).toBeNull();
    expect(resolveMonitorCard({})).toBeNull();
    expect(resolveMonitorCard({ details: { kind: "event" } })).toBeNull();
  });
});

describe("terminal reason compaction", () => {
  test("known reason shapes lose only their prose wrapper", () => {
    expect(compactStopReason("command exited (exit code 0)")).toBe("exited 0");
    expect(compactStopReason("command exited (exit code 127)")).toBe("exited 127");
    expect(compactStopReason("command exited (signal SIGTERM)")).toBe("signal SIGTERM");
    expect(compactStopReason("300000ms timeout")).toBe("5m timeout");
    expect(compactStopReason("stopped by BackgroundStop")).toBe("by operator");
    expect(compactStopReason("firehose: more than 5000 lines in 10s")).toBe("firehose");
    expect(compactStopReason("command failed to start: ENOENT")).toBe("failed to start");
    expect(compactStopReason("connection closed")).toBe("connection closed");
    expect(compactStopReason("something new")).toBe("something new");
  });
});

describe("background card registration", () => {
  test("registers task_notification and monitor_event with no xtrm- slug", () => {
    const renderers = new Map<string, unknown>();
    const pi = {
      registerMessageRenderer(type: string, renderer: unknown) {
        renderers.set(type, renderer);
      },
    };
    registerBackgroundCards(pi as never);
    expect(renderers.has(TASK_NOTIFICATION_TYPE)).toBe(true);
    expect(renderers.has(MONITOR_EVENT_TYPE)).toBe(true);
    expect(TASK_NOTIFICATION_TYPE.includes("xtrm")).toBe(false);
    expect(MONITOR_EVENT_TYPE.includes("xtrm")).toBe(false);
  });

  test("registration without a renderer host is a no-op, never a crash", () => {
    expect(() => registerBackgroundCards({} as never)).not.toThrow();
  });
});
