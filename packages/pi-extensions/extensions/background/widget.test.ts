import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  BACKGROUND_WIDGET_KEY,
  createBackgroundWidget,
  fitToWidth,
  formatIndicator,
  hardCut,
  renderIndicator,
  summarizeBackground,
  type BackgroundSummary,
} from "./widget.ts";
import { createBackgroundStore } from "./store.ts";

const NOW = 1_700_000_000_000;

function summary(overrides: Partial<BackgroundSummary> = {}): BackgroundSummary {
  return { runningTasks: 0, activeMonitors: 0, unseenFailures: 0, ...overrides };
}

describe("background indicator text", () => {
  test("hides when idle", () => {
    expect(formatIndicator(summary())).toBeNull();
  });

  test("matches the D-5 shapes: tasks, monitors, failures, /bg", () => {
    expect(formatIndicator(summary({ runningTasks: 3, activeMonitors: 1 }))).toBe("◐ 3 tasks running · 1 monitor · /bg");
    expect(formatIndicator(summary({ runningTasks: 2, unseenFailures: 1 }))).toBe("◐ 2 tasks running · ! 1 failed · /bg");
    expect(formatIndicator(summary({ runningTasks: 1, activeMonitors: 1 }))).toBe("◐ 1 task running · 1 monitor · /bg");
    expect(formatIndicator(summary({ activeMonitors: 2 }))).toBe("2 monitors · /bg");
    expect(formatIndicator(summary({ unseenFailures: 1 }))).toBe("! 1 failed · /bg");
    expect(formatIndicator(summary({ runningTasks: 2, activeMonitors: 3, unseenFailures: 2 }))).toBe(
      "◐ 2 tasks running · 3 monitors · ! 2 failed · /bg",
    );
  });

  test("the widget key carries no xtrm- slug", () => {
    expect(BACKGROUND_WIDGET_KEY).toBe("background");
    expect(BACKGROUND_WIDGET_KEY.includes("xtrm")).toBe(false);
  });
});

describe("background summary", () => {
  test("counts running tasks, active monitors and unseen failures", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: (() => { let n = 0; return () => `bg_${(n += 1)}`; })() });
    const running = store.create("sleep 30", "sleep 30", "", "session");
    const failed = store.create("false", "false", "", "session");
    expect(running.id).toBeTruthy();
    expect(failed.id).toBeTruthy();
    const armed = store.createMonitor({ command: "tail", wsUrl: null, description: "tail", outputFile: "", sessionId: "session" });
    const expired = store.createMonitor({ command: "echo", wsUrl: null, description: "echo", outputFile: "", sessionId: "session" });
    failed.status = "failed";
    failed.endedAt = NOW + 1000;
    expired.status = "expired";
    expired.endedAt = NOW + 1000;
    const result = summarizeBackground(store.list(), store.listMonitors());
    // One running task, one armed monitor, one unseen failed task.
    // The expired monitor is terminal but not a failure.
    expect(result).toEqual({ runningTasks: 1, activeMonitors: 1, unseenFailures: 1 });
    expect(armed.id).toBeTruthy();
  });

  test("seen failures leave the count; timed_out counts as failed", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: (() => { let n = 0; return () => `bg_${(n += 1)}`; })() });
    const failed = store.create("false", "false", "", "session");
    const timedOut = store.create("sleep 99", "sleep 99", "", "session");
    failed.status = "failed";
    failed.endedAt = NOW + 1;
    timedOut.status = "timed_out";
    timedOut.endedAt = NOW + 2;
    expect(summarizeBackground(store.list(), store.listMonitors()).unseenFailures).toBe(2);
    store.markSeen(failed.id);
    expect(summarizeBackground(store.list(), store.listMonitors()).unseenFailures).toBe(1);
  });

  test("a firehose-stopped monitor counts; an operator-stopped one does not", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: (() => { let n = 0; return () => `mn_${(n += 1)}`; })() });
    const firehose = store.createMonitor({ command: "yes", wsUrl: null, description: "yes", outputFile: "", sessionId: "session" });
    const stopped = store.createMonitor({ command: "top", wsUrl: null, description: "top", outputFile: "", sessionId: "session" });
    firehose.status = "stopped";
    firehose.killReason = "firehose";
    firehose.endedAt = NOW + 1;
    stopped.status = "stopped";
    stopped.killReason = "stop";
    stopped.endedAt = NOW + 2;
    expect(summarizeBackground([], store.listMonitors()).unseenFailures).toBe(1);
  });
});

describe("fitToWidth", () => {
  test("short lines pass through untouched", () => {
    expect(fitToWidth("◐ 3 tasks running · /bg", 80)).toBe("◐ 3 tasks running · /bg");
  });

  test("long lines fit, measured by the same ruler the tests use", () => {
    // Width only: under the process-wide pi-tui stubs the cut point and
    // ellipsis styling vary (identity stub, naive slice, real library).
    const out = fitToWidth("◐ 12345 tasks running · 67890 monitors · ! 42 failed · /bg", 20);
    expect(visibleWidth(out)).toBeLessThanOrEqual(20);
    expect(out.length).toBeGreaterThan(0);
  });

  test("the repair path holds even for adversarial widths", () => {
    for (const width of [8, 12, 20, 40]) {
      const out = fitToWidth(`${"x".repeat(200)} · ${"y".repeat(200)}`, width);
      expect(visibleWidth(out)).toBeLessThanOrEqual(width);
    }
  });

  test("hardCut converges on its own: longest fitting prefix plus ellipsis", () => {
    // The CI-engine regression proof in miniature: hardCut uses only the
    // width ruler, so it holds even where truncateToWidth no-ops.
    for (const width of [8, 20]) {
      const out = hardCut("◐ 12345 tasks running · 67890 monitors · ! 42 failed · /bg", width);
      expect(visibleWidth(out)).toBeLessThanOrEqual(width);
    }
    expect(hardCut("short", 80)).toBe("short");
  });
});

describe("background indicator width and height", () => {
  test("renders exactly one line within the width, none when idle", () => {
    for (const width of [80, 120, 160, 220]) {
      const lines = renderIndicator(summary({ runningTasks: 12, activeMonitors: 34, unseenFailures: 5 }), width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0] as string)).toBeLessThanOrEqual(width);
      expect(renderIndicator(summary(), width)).toEqual([]);
    }
  });

  test("a crowded line truncates instead of pushing the editor", () => {
    const lines = renderIndicator(summary({ runningTasks: 12345, activeMonitors: 67890, unseenFailures: 42 }), 20);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0] as string)).toBeLessThanOrEqual(20);
  });
});

describe("background widget controller", () => {
  function fakeUi() {
    const calls: Array<{ key: string; content: unknown }> = [];
    return {
      calls,
      ui: {
        setWidget: (key: string, content: unknown) => {
          calls.push({ key, content });
        },
      },
    };
  }

  test("shows the line while anything runs and clears it when idle", () => {
    let n = 0;
    const store = createBackgroundStore({ now: () => NOW, makeId: () => `bg_${(n += 1)}` });
    const { ui, calls } = fakeUi();
    let current: unknown = ui;
    const widget = createBackgroundWidget(store, () => current as never);
    const task = store.create("sleep 30", "sleep 30", "", "session");
    // The create already refreshed through the subscription (no polling).
    expect(calls).toHaveLength(1);
    widget.refresh();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toBe("background");
    const factory = calls[0]?.content as (tui: unknown, theme: unknown) => { render: (width: number) => string[] };
    expect(typeof factory).toBe("function");
    const lines = factory({}, {}).render(80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 task running");
    // Finishing and seeing the task idles the widget back to cleared.
    task.status = "completed";
    task.endedAt = NOW + 1000;
    store.changed("task", task.id);
    const cleared = calls[calls.length - 1];
    expect(cleared?.content).toBeUndefined();
  });

  test("store changes refresh without polling", () => {
    let n = 0;
    const store = createBackgroundStore({ now: () => NOW, makeId: () => `bg_${(n += 1)}` });
    const { ui, calls } = fakeUi();
    const widget = createBackgroundWidget(store, () => ui as never);
    calls.length = 0;
    // No refresh call here: the subscription below must drive the update.
    store.create("sleep 30", "sleep 30", "", "session");
    expect(calls.length).toBeGreaterThan(0);
    widget.dispose();
  });

  test("without a ui handle refresh is a silent no-op", () => {
    let n = 0;
    const store = createBackgroundStore({ now: () => NOW, makeId: () => `bg_${(n += 1)}` });
    const widget = createBackgroundWidget(store, () => undefined);
    store.create("sleep 30", "sleep 30", "", "session");
    expect(() => widget.refresh()).not.toThrow();
    widget.dispose();
  });

  test("dispose unsubscribes and clears the widget", () => {
    let n = 0;
    const store = createBackgroundStore({ now: () => NOW, makeId: () => `bg_${(n += 1)}` });
    const { ui, calls } = fakeUi();
    const widget = createBackgroundWidget(store, () => ui as never);
    store.create("sleep 30", "sleep 30", "", "session");
    const before = calls.length;
    widget.dispose();
    expect(calls[calls.length - 1]?.content).toBeUndefined();
    store.create("sleep 31", "sleep 31", "", "session");
    expect(calls).toHaveLength(before + 1);
  });
});
