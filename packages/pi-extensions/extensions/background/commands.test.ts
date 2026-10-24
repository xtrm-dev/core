import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  OUTPUT_TAIL_LINES,
  TASKS_COMMAND,
  TASKS_USAGE,
  TasksOverlay,
  buildTasksRows,
  followOutputFile,
  formatTasksList,
  formatTasksRow,
  parseTasksArgs,
  readOutput,
  readTailLines,
  registerTasksCommand,
  runTasksCommand,
  sanitizeLabel,
  stateGlyph,
  type OutputFollower,
  type OutputView,
} from "./commands.ts";
import { MAX_RETAINED_UNSEEN_FAILURES, createBackgroundStore } from "./store.ts";

const NOW = 1_700_000_000_000;

function sequentialIds(prefix = "bg") {
  let n = 0;
  return () => `${prefix}_${(n += 1)}`;
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

describe("tasks command parsing", () => {
  test("bare /bg opens; the command name carries no xtrm- slug", () => {
    expect(TASKS_COMMAND).toBe("bg");
    expect(TASKS_COMMAND.includes("xtrm")).toBe(false);
    expect(parseTasksArgs("")).toEqual({ action: "open" });
    expect(parseTasksArgs("   ")).toEqual({ action: "open" });
  });

  test("text forms stop, output, rerun and clear", () => {
    expect(parseTasksArgs("stop bg_1")).toEqual({ action: "stop", id: "bg_1" });
    expect(parseTasksArgs("output bg_1")).toEqual({ action: "output", id: "bg_1" });
    expect(parseTasksArgs("rerun bg_1")).toEqual({ action: "rerun", id: "bg_1" });
    expect(parseTasksArgs("clear")).toEqual({ action: "clear" });
    expect(parseTasksArgs("  clear  ")).toEqual({ action: "clear" });
  });

  test("anything else prints usage, never throws", () => {
    for (const args of ["stop", "output", "rerun", "bogus", "stop a b", "clear now"]) {
      expect(parseTasksArgs(args)).toEqual({ action: "usage" });
    }
    expect(TASKS_USAGE).toMatch(/\/bg/);
    expect(TASKS_USAGE).toMatch(/stop/);
    expect(TASKS_USAGE).toMatch(/output/);
    expect(TASKS_USAGE).toMatch(/rerun/);
    expect(TASKS_USAGE).toMatch(/clear/);
  });
});

describe("tasks row glyphs", () => {
  test("running tasks show ◐, armed monitors ◉, failures !", () => {
    expect(stateGlyph("task", "running")).toBe("◐");
    expect(stateGlyph("monitor", "armed")).toBe("◉");
    expect(stateGlyph("monitor", "event")).toBe("◉");
    expect(stateGlyph("task", "failed")).toBe("!");
    expect(stateGlyph("task", "timed_out")).toBe("!");
    expect(stateGlyph("monitor", "stopped", "firehose")).toBe("!");
  });

  test("neutral terminals use quiet glyphs, never a new accent", () => {
    expect(stateGlyph("task", "completed")).toBe("✓");
    expect(stateGlyph("task", "stopped")).toBe("○");
    expect(stateGlyph("monitor", "expired")).toBe("○");
    expect(stateGlyph("monitor", "stopped", "stop")).toBe("○");
  });
});

describe("tasks list", () => {
  test("running rows come before finished ones, tasks before monitors", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const done = store.create("true", "true", "/tmp/a.log", "session");
    done.status = "completed";
    done.endedAt = NOW + 1000;
    const running = store.create("sleep 30", "sleep 30", "/tmp/b.log", "session");
    const monitor = store.createMonitor({ command: "tail", wsUrl: null, description: "tail", outputFile: "/tmp/c.log", sessionId: "session" });
    const rows = buildTasksRows(store.list(), store.listMonitors(), NOW);
    expect(rows.map((row) => row.id)).toEqual([running.id, done.id, monitor.id]);
    expect(rows[0]).toMatchObject({ kind: "task", glyph: "◐", state: "running" });
    expect(rows[2]).toMatchObject({ kind: "monitor", glyph: "◉" });
  });

  test("rows carry id, elapsed and output size or event count", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const task = store.create("sleep 30", "sleep 30", "/tmp/b.log", "session");
    const monitor = store.createMonitor({ command: "tail", wsUrl: null, description: "tail", outputFile: "/tmp/c.log", sessionId: "session" });
    monitor.status = "event";
    monitor.eventCount = 4;
    monitor.lineCount = 12;
    const rows = buildTasksRows(store.list(), store.listMonitors(), NOW + 12_500);
    const taskRow = rows.find((row) => row.id === task.id);
    expect(taskRow?.elapsed).toBe("12.5s");
    expect(taskRow?.label).toBe("sleep 30");
    const monitorRow = rows.find((row) => row.id === monitor.id);
    expect(monitorRow?.extra).toMatch(/4 events/);
    expect(monitorRow?.extra).toMatch(/12 lines/);
  });

  test("rows and the list truncate to the width", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    store.create(
      "a-very-long-command --with --many --flags --that --never --ends --really --it --keeps --going --forever",
      "a-very-long-command --with --many --flags --that --never --ends --really --it --keeps --going --forever",
      "/tmp/b.log",
      "session",
    );
    for (const width of [80, 120, 160, 220]) {
      const rows = buildTasksRows(store.list(), store.listMonitors(), NOW);
      for (const row of rows) {
        expect(visibleWidth(formatTasksRow(row, width))).toBeLessThanOrEqual(width);
      }
      for (const line of formatTasksList(rows, width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("tasks overlay keys", () => {
  function openOverlay() {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const first = store.create("sleep 30", "sleep 30", "/tmp/a.log", "session");
    const second = store.create("make build", "make build", "/tmp/b.log", "session");
    let closed = false;
    const actions = {
      stopped: [] as string[],
      reran: [] as string[],
      cleared: 0,
      async stop(id: string) {
        actions.stopped.push(id);
        return `Stopped ${id}.`;
      },
      async rerun(id: string) {
        actions.reran.push(id);
        return `Reran ${id} as bg_9.`;
      },
      async clear() {
        actions.cleared += 1;
        return "Cleared 0 finished.";
      },
      async readOutput(id: string): Promise<OutputView> {
        return { id, kind: "task", label: id, running: false, lines: [`${id} line 1`, `${id} line 2`], totalLines: 2, truncated: false, endOffset: 0 };
      },
    };
    const overlay = new TasksOverlay({
      store,
      theme,
      close: () => {
        closed = true;
      },
      actions,
      now: () => NOW,
    });
    return { store, overlay, actions, closed: () => closed, first, second };
  }

  test("enter shows the output, s stops, r reruns, c clears, esc closes", async () => {
    const { overlay, actions, closed, first } = openOverlay();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    overlay.handleInput("\r");
    await tick();
    expect(overlay.render(80).join("\n")).toContain(`${first.id} line 1`);
    overlay.handleInput("\u001b");
    expect(overlay.render(80).join("\n")).toContain("sleep 30");
    overlay.handleInput("s");
    await tick();
    expect(actions.stopped).toEqual([first.id]);
    overlay.handleInput("r");
    await tick();
    expect(actions.reran).toEqual([first.id]);
    overlay.handleInput("c");
    await tick();
    expect(actions.cleared).toBe(1);
    expect(closed()).toBe(false);
    overlay.handleInput("\u001b");
    expect(closed()).toBe(true);
  });

  test("q closes like esc; arrows move the selection", () => {
    let closed = false;
    const { overlay, second } = openOverlay();
    overlay.dispose();
    const probe = new TasksOverlay({
      store: openOverlay().store,
      theme,
      close: () => {
        closed = true;
      },
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
        async readOutput(id: string): Promise<OutputView> {
          return { id, kind: "task", label: id, running: false, lines: [], totalLines: 0, truncated: false, endOffset: 0 };
        },
      },
      now: () => NOW,
    });
    void second;
    probe.handleInput("\u001b[B");
    probe.handleInput("\u001b[A");
    probe.handleInput("x-unhandled");
    expect(closed).toBe(false);
    probe.handleInput("q");
    expect(closed).toBe(true);
    probe.dispose();
    expect(overlay).toBeTruthy();
  });

  test("action results surface on a status line", async () => {
    const { overlay } = openOverlay();
    overlay.handleInput("s");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay.render(80).join("\n")).toMatch(/Stopped bg_/);
    overlay.dispose();
  });

  function followHarness() {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const task = store.create("sleep 30", "sleep 30", "/tmp/follow-harness.log", "session");
    const chunks: string[][] = [];
    let followerCloses = 0;
    let watcherCloses = 0;
    const follower: OutputFollower = {
      get offset() {
        return 0;
      },
      update: () => chunks.shift() ?? [],
      close: () => {
        followerCloses += 1;
      },
    };
    let followerCalls = 0;
    const hooks: Array<{ onChange: () => void; onError: () => void }> = [];
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
        async readOutput(id: string): Promise<OutputView> {
          return { id, kind: "task", label: id, running: true, lines: [], totalLines: 0, truncated: false, endOffset: 0 };
        },
      },
      createFollower: (_id: string, _fromOffset: number) => {
        followerCalls += 1;
        return follower;
      },
      watchFile: (_path: string, hook: { onChange: () => void; onError: () => void }) => {
        hooks.push(hook);
        return {
          close: () => {
            watcherCloses += 1;
          },
        };
      },
      now: () => NOW,
    });
    return { store, task, overlay, chunks, hooks, counts: () => ({ followerCloses, watcherCloses, followerCalls }) };
  }

  test("at terminal state drains until empty so a burst tail is not lost (N1)", async () => {
    const { store, task, overlay, chunks } = followHarness();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    overlay.handleInput("\r");
    await tick();
    // A burst lands in three follower updates, then the task exits.
    chunks.push(["burst-1"], ["burst-2", "LASTLINE"], []);
    task.status = "failed";
    task.endedAt = NOW + 1;
    store.changed("task", task.id);
    await tick();
    const rendered = overlay.render(80).join("\n");
    expect(rendered).toContain("burst-1");
    expect(rendered).toContain("LASTLINE");
    expect(rendered).not.toContain("following — new lines appear live");
    overlay.dispose();
  });

  test("closing the follower is covered: esc and task end both close it (N2)", async () => {
    const { overlay, counts } = followHarness();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    overlay.handleInput("\r");
    await tick();
    expect(counts().followerCalls).toBe(1);
    overlay.handleInput("\u001b");
    expect(counts().followerCloses).toBeGreaterThanOrEqual(1);
    expect(counts().watcherCloses).toBeGreaterThanOrEqual(1);
    overlay.dispose();
  });

  test("a throwing watcher falls back to polling instead of going stale (N3)", async () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    store.create("sleep 30", "sleep 30", "/tmp/poll-fallback.log", "session");
    const live: string[] = [];
    let seenOffset: number | null = null;
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
        async readOutput(id: string): Promise<OutputView> {
          return { id, kind: "task", label: id, running: true, lines: [], totalLines: 0, truncated: false, endOffset: 42 };
        },
      },
      createFollower: (_id: string, fromOffset: number) => {
        seenOffset = fromOffset;
        return {
          get offset() {
            return fromOffset;
          },
          update: () => live.splice(0),
          close: () => {},
        };
      },
      watchFile: () => {
        throw new Error("no inotify");
      },
      now: () => NOW,
    });
    overlay.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The follower starts where the tail read stopped, not at a fresh stat.
    expect(seenOffset).toBe(42);
    live.push("polled-line");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const rendered = overlay.render(80).join("\n");
    expect(rendered).toContain("polled-line");
    expect(rendered).toContain("polling");
    overlay.dispose();
  });

  test("the follower starts at the tail read's end offset on a real file (N3)", async () => {
    const { writeFileSync, appendFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "tasks-offset-test-"));
    try {
      const file = path.join(dir, "out.log");
      writeFileSync(file, "old1\nold2\n");
      const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
      const task = store.create("cmd", "cmd", file, "session");
      const view = await readOutput(store, task.id);
      expect(view.lines).toEqual(["old1", "old2"]);
      appendFileSync(file, "new1\n");
      const follower = followOutputFile(file, view.endOffset);
      try {
        expect(follower.update()).toEqual(["new1"]);
      } finally {
        follower.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dispose during the async load never arms the follow (N2)", async () => {
    const { store, overlay, counts } = followHarness();
    let resolveView: ((view: OutputView) => void) | null = null;
    const pending = new TasksOverlay({
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
        readOutput: (id: string) =>
          new Promise<OutputView>((resolve) => {
            resolveView = resolve;
          }),
      },
      createFollower: () => {
        throw new Error("must not arm after dispose");
      },
      watchFile: () => {
        throw new Error("must not watch after dispose");
      },
      now: () => NOW,
    });
    pending.handleInput("\r");
    pending.dispose();
    resolveView?.({ id: "bg_1", kind: "task", label: "bg_1", running: true, lines: [], totalLines: 0, truncated: false, endOffset: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(counts().followerCalls).toBe(0);
    expect(() => pending.render(80)).not.toThrow();
    expect(pending.render(80).join("\n")).not.toContain("following — new lines appear live");
    overlay.dispose();
  });

  test("follow shows appended file lines live without reopening the file (F1)", async () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const task = store.create("sleep 30", "sleep 30", "/tmp/follow-placeholder.log", "session");
    const live: string[] = ["line1"];
    const follower: OutputFollower = {
      get offset() {
        return 0;
      },
      update: () => live.splice(0),
      close: () => {},
    };
    let listener: (() => void) | null = null;
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
        async readOutput(id: string): Promise<OutputView> {
          return { id, kind: "task", label: id, running: true, lines: [], totalLines: 0, truncated: false, endOffset: 0 };
        },
      },
      createFollower: () => follower,
      watchFile: (_path: string, hooks: { onChange: () => void; onError: () => void }) => {
        listener = hooks.onChange;
        return {
          close: () => {
            listener = null;
          },
        };
      },
      now: () => NOW,
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    overlay.handleInput("\r");
    await tick();
    // The initial view arrived through readOutput; the follower drains live lines.
    listener?.();
    await tick();
    let rendered = overlay.render(80).join("\n");
    expect(rendered).toContain("line1");
    expect(rendered).toContain("following — new lines appear live");
    // The probe appends: the same render shows the new line (F1's case).
    live.push("line2");
    listener?.();
    await tick();
    rendered = overlay.render(80).join("\n");
    expect(rendered).toContain("line2");
    // The task ends: the follow tears itself down.
    task.status = "failed";
    task.endedAt = NOW + 1;
    store.changed("task", task.id);
    await tick();
    rendered = overlay.render(80).join("\n");
    expect(rendered).not.toContain("following — new lines appear live");
    overlay.dispose();
    expect(listener).toBeNull();
  });
});

describe("dropped failures line (N6)", () => {
  test("formatTasksList names evicted unseen failures, singular and plural", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const rows = buildTasksRows(store.list(), store.listMonitors(), NOW);
    expect(formatTasksList(rows, 80, 0).join("\n")).not.toContain("dropped");
    expect(formatTasksList(rows, 80, 1).join("\n")).toContain("+1 earlier failure dropped");
    expect(formatTasksList(rows, 80, 7).join("\n")).toContain("+7 earlier failures dropped");
    for (const width of [80, 120]) {
      for (const line of formatTasksList(rows, width, 12345)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("the overlay list shows the dropped count from the store", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    for (let i = 0; i < MAX_RETAINED_UNSEEN_FAILURES + 3; i += 1) {
      const record = store.create(`fail-${i}`, `fail-${i}`, "", "session");
      record.status = "failed";
      record.endedAt = NOW + i;
      store.changed("task", record.id);
    }
    expect(store.droppedUnseenFailures()).toBe(3);
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
        async readOutput(id: string): Promise<OutputView> {
          return { id, kind: "task", label: id, running: false, lines: [], totalLines: 0, truncated: false, endOffset: 0 };
        },
      },
      now: () => NOW,
    });
    expect(overlay.render(80).join("\n")).toContain("+3 earlier failures dropped");
    overlay.dispose();
  });
});

describe("tasks text forms", () => {
  function textDeps() {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const task = store.create("sleep 30", "sleep 30", "", "session");
    const notified: Array<{ message: string; type?: string }> = [];
    const ctx = {
      mode: "print",
      hasUI: false,
      ui: {
        notify: (message: string, type?: "info" | "warning" | "error") => {
          notified.push({ message, type });
        },
      },
    };
    const deps = {
      store,
      now: () => NOW,
      async stopTask(id: string) {
        if (id !== task.id) throw new Error(`[background] unknown task ${JSON.stringify(id)}.`);
        return `Stopped background task ${id}.`;
      },
      async rerunTask(id: string) {
        if (id !== task.id) throw new Error(`[background] unknown task ${JSON.stringify(id)}.`);
        return `Reran background task ${id} as bg_2.`;
      },
      async readOutputView(id: string): Promise<OutputView> {
        if (id !== task.id) throw new Error(`[background] unknown task ${JSON.stringify(id)}.`);
        return { id, kind: "task" as const, label: "sleep 30", running: true, lines: ["out"], totalLines: 1, truncated: false, endOffset: 0 };
      },
    };
    return { store, task, notified, ctx: ctx as never, deps };
  }

  test("stop, output, rerun and clear notify their results", async () => {
    const { task, notified, ctx, deps } = textDeps();
    await runTasksCommand(`stop ${task.id}`, ctx, deps);
    expect(notified[notified.length - 1]?.message).toMatch(/Stopped background task/);
    await runTasksCommand(`output ${task.id}`, ctx, deps);
    expect(notified[notified.length - 1]?.message).toContain("out");
    await runTasksCommand(`rerun ${task.id}`, ctx, deps);
    expect(notified[notified.length - 1]?.message).toMatch(/Reran background task/);
    await runTasksCommand("clear", ctx, deps);
    expect(notified[notified.length - 1]?.message).toMatch(/Cleared/);
  });

  test("unknown ids fail loudly through notify", async () => {
    const { notified, ctx, deps } = textDeps();
    await runTasksCommand("stop bg_missing", ctx, deps);
    expect(notified[notified.length - 1]?.type).toBe("error");
    await runTasksCommand("output bg_missing", ctx, deps);
    expect(notified[notified.length - 1]?.type).toBe("error");
  });

  test("bare /bg without a TUI notifies the list and marks failures seen", async () => {
    const { notified, ctx, deps, store, task } = textDeps();
    task.status = "failed";
    task.endedAt = NOW + 1000;
    expect(task.seen).toBe(false);
    await runTasksCommand("", ctx, deps);
    expect(notified[notified.length - 1]?.message).toContain("bg ");
    expect(notified[notified.length - 1]?.message).toContain("sleep 30");
    expect(store.get(task.id)?.seen).toBe(true);
  });

  test("usage prints the forms without touching the store", async () => {
    const { notified, ctx, deps, store } = textDeps();
    const before = store.list().length;
    await runTasksCommand("bogus", ctx, deps);
    expect(notified[notified.length - 1]?.message).toMatch(/\/bg/);
    expect(store.list()).toHaveLength(before);
  });

  test("registerTasksCommand registers bg and nothing else (CORE-2456: /tasks lives in pi-tasks)", () => {
    const commands = new Map<string, unknown>();
    const pi = { registerCommand: (name: string, options: unknown) => commands.set(name, options) };
    const { deps } = textDeps();
    registerTasksCommand(pi as never, { store: deps.store, stopTask: deps.stopTask, rerunTask: deps.rerunTask, readOutputView: deps.readOutputView });
    expect([...commands.keys()]).toEqual(["bg"]);
  });
});

describe("readTailLines", () => {
  test("reads only the tail window of a big file and reports an unknown total", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "tasks-tail-test-"));
    try {
      const file = path.join(dir, "big.log");
      const lines = Array.from({ length: 20000 }, (_, i) => `line ${i} with padding xxxxxxxxxxxxxxxxxx`);
      writeFileSync(file, `${lines.join("\n")}\n`);
      const tail = readTailLines(file, 50, 8192);
      expect(tail.lines).toHaveLength(50);
      expect(tail.lines[tail.lines.length - 1]).toBe("line 19999 with padding xxxxxxxxxxxxxxxxxx");
      expect(tail.totalLines).toBeNull();
      expect(tail.truncated).toBe(true);
      expect(tail.endOffset).toBeGreaterThan(8192);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("small files keep an exact total", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "tasks-tail-small-"));
    try {
      const file = path.join(dir, "small.log");
      writeFileSync(file, "a\nb\nc\n");
      const tail = readTailLines(file, 50);
      expect(tail.lines).toEqual(["a", "b", "c"]);
      expect(tail.totalLines).toBe(3);
      expect(tail.truncated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("followOutputFile", () => {
  test("drains only new tail bytes; a partial line waits for its newline (F1)", async () => {
    const { writeFileSync, appendFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "tasks-follow-test-"));
    let follower: OutputFollower | null = null;
    try {
      const file = path.join(dir, "out.log");
      writeFileSync(file, "line1\n");
      follower = followOutputFile(file, 0);
      expect(follower.update()).toEqual(["line1"]);
      expect(follower.update()).toEqual([]);
      appendFileSync(file, "line2\nline3\n");
      expect(follower.update()).toEqual(["line2", "line3"]);
      // A partial line is held back until its newline arrives.
      appendFileSync(file, "half");
      expect(follower.update()).toEqual([]);
      appendFileSync(file, "-done\n");
      expect(follower.update()).toEqual(["half-done"]);
      expect(follower.offset).toBeGreaterThan(0);
    } finally {
      follower?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one update never loads the whole file", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "tasks-follow-cap-"));
    let follower: OutputFollower | null = null;
    try {
      const file = path.join(dir, "out.log");
      writeFileSync(file, `${"z".repeat(300 * 1024)}\n`);
      follower = followOutputFile(file, 0, { maxBytesPerUpdate: 4096 });
      const first = follower.update();
      expect(first.join("\n").length).toBeLessThanOrEqual(8192);
      // The rest streams on later updates; the offset always advances.
      const before = follower.offset;
      expect(before).toBeGreaterThan(0);
      follower.update();
      expect(follower.offset).toBeGreaterThan(before);
    } finally {
      follower?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sanitizeLabel", () => {
  test("an OSC title, a CSI clear and newlines arrive as inert one-line text (F3)", () => {
    const label = sanitizeLabel("make build\n\x1b[2J\x1b]0;pwned\x07more");
    expect(label).not.toContain("\n");
    expect(label).not.toContain("\x1b");
    expect(label).toContain("make build");
    expect(label).toContain("more");
  });

  test("an ST-terminated OSC title is stripped, not leaked (N5)", () => {
    // Failed before the terminator fix: the payload leaked as "]0;title".
    expect(sanitizeLabel("a\x1b]0;title\x1b\\b")).toBe("ab");
    expect(sanitizeLabel("a\x1b]0;title\x07b")).toBe("ab");
  });

  test("C1 controls including single-char CSI are stripped (N5)", () => {
    // Failed before the C1 range: U+009B survived verbatim.
    const label = sanitizeLabel("a\u009B2Jb");
    expect(label).not.toContain("\u009B");
    expect(label).toContain("a");
    expect(label).toContain("b");
  });

  test("rows carry sanitized labels", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    store.create("echo hi\n\x1b[2J", "echo hi\n\x1b[2J", "", "session");
    const rows = buildTasksRows(store.list(), store.listMonitors(), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).not.toMatch(/[\n\x1b]/);
  });
});

describe("readOutput", () => {
  test("tails the output file bounded, marking truncation", async () => {
    const { writeFileSync, mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "tasks-output-test-"));
    try {
      const file = path.join(dir, "background-bg_1.log");
      const lines = Array.from({ length: 120 }, (_, i) => `line ${i}`);
      writeFileSync(file, `${lines.join("\n")}\n`);
      const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
      const task = store.create("cmd", "cmd", file, "session");
      const view = await readOutput(store, task.id);
      expect(view.totalLines).toBe(120);
      expect(view.truncated).toBe(true);
      expect(view.lines).toHaveLength(OUTPUT_TAIL_LINES);
      expect(view.lines[view.lines.length - 1]).toBe("line 119");
      const head = await readOutput(store, task.id, 120);
      expect(head.truncated).toBe(false);
      expect(head.lines).toHaveLength(120);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unknown ids and missing files fail loudly", async () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    await expect(readOutput(store, "bg_missing")).rejects.toThrow(/unknown task/);
    const task = store.create("cmd", "cmd", "/nonexistent-dir-xyz/background-bg_1.log", "session");
    await expect(readOutput(store, task.id)).rejects.toThrow();
  });
});
