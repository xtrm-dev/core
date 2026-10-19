import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { buildTasksRows, formatTasksList } from "./commands.ts";
import { renderIndicator, type BackgroundSummary } from "./widget.ts";
import { formatEventCard, type EventTheme } from "../../shared/event.ts";
import { resolveMonitorCard, resolveTaskCard } from "./cards.ts";
import { createBackgroundStore } from "./store.ts";

const WIDTHS = [80, 120, 160, 220] as const;

function stripStyling(value: string): string {
  return value
    .replace(/\[.+?\]/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Light and dark differ only in styling: layout must be identical. */
function themedPair() {
  const light: EventTheme = { fg: (token, text) => `[light:${token}:${text}]`, bold: (text) => `[light:bold:${text}]` };
  const dark: EventTheme = { fg: (token, text) => `[dark:${token}:${text}]`, bold: (text) => `[dark:bold:${text}]` };
  return { light, dark };
}

function indicatorScenarios(): Array<{ name: string; summary: BackgroundSummary }> {
  return [
    { name: "idle", summary: { runningTasks: 0, activeMonitors: 0, unseenFailures: 0 } },
    { name: "one task", summary: { runningTasks: 1, activeMonitors: 0, unseenFailures: 0 } },
    { name: "spec example", summary: { runningTasks: 3, activeMonitors: 1, unseenFailures: 0 } },
    { name: "spec failure", summary: { runningTasks: 2, activeMonitors: 0, unseenFailures: 1 } },
    { name: "crowded", summary: { runningTasks: 12, activeMonitors: 34, unseenFailures: 5 } },
    { name: "failures only", summary: { runningTasks: 0, activeMonitors: 0, unseenFailures: 7 } },
  ];
}

describe("indicator snapshots", () => {
  test("canonical lines match the D-5 shapes", () => {
    expect(renderIndicator({ runningTasks: 3, activeMonitors: 1, unseenFailures: 0 }, 80)).toEqual([
      "◐ 3 tasks running · 1 monitor · /bg",
    ]);
    expect(renderIndicator({ runningTasks: 2, activeMonitors: 0, unseenFailures: 1 }, 80)).toEqual([
      "◐ 2 tasks running · ! 1 failed · /bg",
    ]);
  });

  test("every scenario holds one line within every width", () => {
    for (const { name, summary } of indicatorScenarios()) {
      for (const width of WIDTHS) {
        const lines = renderIndicator(summary, width);
        // Stable height: the indicator is exactly one line, or hidden.
        expect(lines.length).toBeLessThanOrEqual(1);
        for (const line of lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
        if (name === "idle") expect(lines).toEqual([]);
      }
    }
  });
});

describe("tasks list snapshots", () => {
  function fixtureStore() {
    let n = 0;
    const store = createBackgroundStore({ now: () => 1_700_000_000_000, makeId: () => `bg_${(n += 1)}` });
    const running = store.create(
      "bun test extensions/background --rerun-each 5 with a very long tail of flags",
      "bun test extensions/background --rerun-each 5 with a very long tail of flags",
      "/tmp/background-bg_1.log",
      "session",
    );
    const failed = store.create("make build", "make build", "/tmp/background-bg_2.log", "session");
    failed.status = "failed";
    failed.endedAt = 1_700_000_000_000 + 125_000;
    failed.seen = true;
    const monitor = store.createMonitor({
      command: "tail -f /var/log/app.log | grep ERROR",
      wsUrl: null,
      description: "tail -f /var/log/app.log | grep ERROR",
      outputFile: "/tmp/monitor-bg_3.log",
      sessionId: "session",
    });
    monitor.status = "event";
    monitor.eventCount = 4;
    monitor.lineCount = 12;
    return { store, running, failed, monitor };
  }

  test("every width holds every line; light and dark lay out identically", () => {
    const { light, dark } = themedPair();
    const { store } = fixtureStore();
    // F6: CJK, emoji and ANSI labels ride the same rows.
    const cjk = store.create("make translations", "ビルド 翻訳 更新", "/tmp/d.log", "session");
    const emoji = store.create("notify", "🚀 deploy gate", "/tmp/e.log", "session");
    const ansi = store.create("evil", "evil\n\x1b[2J\x1b]0;pwned\x07done", "/tmp/f.log", "session");
    void cjk;
    void emoji;
    void ansi;
    const rows = buildTasksRows(store.list(), store.listMonitors(), 1_700_000_000_000 + 12_500);
    expect(rows).toHaveLength(6);
    for (const width of WIDTHS) {
      for (const line of formatTasksList(rows, width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    const at80 = formatTasksList(rows, 80);
    expect(at80.join("\n")).toContain("tasks");
    expect(at80.join("\n")).toContain("make build");
    expect(at80.join("\n")).toContain("ビルド");
    expect(at80.join("\n")).toContain("🚀");
    // Labels contribute no escapes: pi-tui's own CSI ellipsis styling
    // strips away, while a raw OSC/CSI remnant would survive stripping.
    expect(stripStyling(at80.join("\n"))).not.toMatch(/\x1b/);
    // Both themes run: the I7 cards for one task and one monitor row lay
    // out identically once styling is stripped.
    const taskCard = resolveTaskCard({
      details: { task_id: "bg_2", status: "failed", summary: "f", output_file: "/tmp/x", elapsed: "1s" },
    });
    const monitorCard = resolveMonitorCard({
      details: { monitor_id: "mn_1", kind: "event", event_index: 0, line_count: 1, lines: ["ビルド ok 🚀"] },
    });
    if (!taskCard || !monitorCard) throw new Error("fixture cards must resolve");
    for (const width of WIDTHS) {
      for (const theme of [light, dark]) {
        for (const details of [taskCard, monitorCard]) {
          for (const line of formatEventCard(details, theme, width).split("\n")) {
            expect(visibleWidth(stripStyling(line))).toBeLessThanOrEqual(width);
          }
        }
      }
      const plain = (theme: EventTheme) =>
        [taskCard, monitorCard].map((d) => formatEventCard(d, theme, width).split("\n").map(stripStyling).join("\n")).join("\n");
      expect(plain(light)).toBe(plain(dark));
    }
  });
});

describe("tasks overlay snapshot", () => {
  test("one overlay render holds the width and shows rows, hints and status", async () => {
    const { TasksOverlay } = await import("./commands.ts");
    let n = 0;
    const store = createBackgroundStore({ now: () => 1_700_000_000_000, makeId: () => `bg_${(n += 1)}` });
    store.create("sleep 30", "sleep 30", "/tmp/a.log", "session");
    const failed = store.create("make build", "make build", "/tmp/b.log", "session");
    failed.status = "failed";
    failed.endedAt = 1_700_000_000_000 + 1000;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
    const overlay = new TasksOverlay({
      store,
      theme,
      close: () => {},
      actions: {
        async stop(id: string) {
          return `Stopped ${id}.`;
        },
        async rerun(id: string) {
          return `Reran ${id}.`;
        },
        async clear() {
          return "Cleared 0 finished.";
        },
        async readOutput(id: string) {
          const { readOutput } = await import("./commands.ts");
          return readOutput(store, id);
        },
      },
      now: () => 1_700_000_000_000 + 12_500,
    });
    const lines = overlay.render(80);
    for (const line of lines) {
      // Strip first: neighbouring suites mock pi-tui's visibleWidth as a
      // plain length, which counts styling escapes; the real one ignores
      // them, so measure the visible text either way.
      expect(visibleWidth(stripStyling(line))).toBeLessThanOrEqual(80);
    }
    const text = lines.join("\n");
    expect(text).toContain("tasks");
    expect(text).toContain("sleep 30");
    expect(text).toContain("make build");
    expect(text).toContain("enter output · s stop · r rerun · c clear · esc closes");
    overlay.dispose();
  });
});

describe("card snapshots", () => {
  test("task and monitor cards hold every width in light and dark", () => {
    const { light, dark } = themedPair();
    const task = resolveTaskCard({
      content: "ignored",
      details: {
        task_id: "bg_1a2b",
        status: "failed",
        summary: 'Background command "make build with a long tail of arguments --and --more --flags" failed (exit code 2)',
        output_file: "/tmp/background-bg_1a2b.log",
        elapsed: "12.5s",
      },
    });
    const monitor = resolveMonitorCard({
      content: "ignored",
      details: {
        monitor_id: "mn_3c4d",
        kind: "event",
        event_index: 2,
        line_count: 3,
        lines: ["a quite long build line that keeps going with detail", "tests ok", "done"],
      },
    });
    if (!task || !monitor) throw new Error("fixture cards must resolve");
    for (const width of WIDTHS) {
      for (const theme of [light, dark]) {
        for (const details of [task, monitor]) {
          for (const line of formatEventCard(details, theme, width).split("\n")) {
            expect(visibleWidth(stripStyling(line))).toBeLessThanOrEqual(width);
          }
        }
      }
      // Theme only styles: the plain layout is identical in light and dark.
      const taskLight = formatEventCard(task, light, width).split("\n").map(stripStyling).join("\n");
      const taskDark = formatEventCard(task, dark, width).split("\n").map(stripStyling).join("\n");
      expect(taskLight).toBe(taskDark);
    }
  });
});
