import { describe, expect, test } from "bun:test";

import {
  registerBackgroundCards,
  resolveMonitorCard,
  resolveTaskCard,
} from "./cards.ts";
import { MONITOR_EVENT_TYPE, TASK_NOTIFICATION_TYPE } from "./index.ts";
import { formatEventCard, glyphFor } from "../../shared/event.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

describe("task cards through the I7 module", () => {
  test("a failed task resolves to a ! card with its summary", () => {
    const details = resolveTaskCard({
      details: {
        task_id: "bg_1a2b",
        status: "failed",
        summary: 'Background command "make build" failed (exit code 2)',
        output_file: "/tmp/background-bg_1a2b.log",
        elapsed: "12.5s",
      },
    });
    expect(details).not.toBeNull();
    expect(details).toMatchObject({ kind: "task", state: "failed", identity: "task bg_1a2b" });
    expect(glyphFor(details as never)).toBe("!");
    const card = formatEventCard(details as never, theme, 80);
    expect(card).toContain("task bg_1a2b");
    expect(card).toContain("failed");
    expect(card).toContain('Background command "make build" failed (exit code 2)');
  });

  test("a completed task resolves to a hollow card with the read line", () => {
    const details = resolveTaskCard({
      details: {
        task_id: "bg_1a2b",
        status: "completed",
        summary: 'Background command "true" completed (exit code 0)',
        output_file: "/tmp/background-bg_1a2b.log",
        elapsed: "0.1s",
      },
    });
    expect(details).toMatchObject({ kind: "task", state: "completed" });
    expect(glyphFor(details as never)).toBe("○");
    expect(formatEventCard(details as never, theme, 80)).toContain("Read /tmp/background-bg_1a2b.log");
  });

  test("garbage resolves to null, never a crash", () => {
    expect(resolveTaskCard(null)).toBeNull();
    expect(resolveTaskCard({})).toBeNull();
    expect(resolveTaskCard({ details: { status: "completed" } })).toBeNull();
    expect(resolveTaskCard({ details: "nope" })).toBeNull();
  });
});

describe("monitor cards through the I7 module", () => {
  test("an event resolves to a hollow card with its lines", () => {
    const details = resolveMonitorCard({
      details: {
        monitor_id: "mn_3c4d",
        kind: "event",
        event_index: 2,
        line_count: 3,
        lines: ["build ok", "tests ok", "done"],
      },
    });
    expect(details).toMatchObject({ kind: "monitor", state: "event", identity: "monitor mn_3c4d" });
    expect(glyphFor(details as never)).toBe("○");
    const card = formatEventCard(details as never, theme, 80);
    expect(card).toContain("build ok");
    expect(card).toContain("tests ok");
  });

  test("a terminal notice resolves with its counts", () => {
    const details = resolveMonitorCard({
      details: {
        monitor_id: "mn_3c4d",
        kind: "expired",
        reason: "300000ms timeout",
        event_count: 5,
        line_count: 41,
      },
    });
    expect(details).toMatchObject({ kind: "monitor", state: "expired" });
    const card = formatEventCard(details as never, theme, 80);
    expect(card).toContain("mn_3c4d");
    expect(card).toContain("5");
  });

  test("garbage resolves to null, never a crash", () => {
    expect(resolveMonitorCard(null)).toBeNull();
    expect(resolveMonitorCard({})).toBeNull();
    expect(resolveMonitorCard({ details: { kind: "event" } })).toBeNull();
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
