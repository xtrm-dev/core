import { describe, expect, test } from "bun:test";

import {
  MAX_RETAINED_FINISHED,
  MAX_RETAINED_UNSEEN_FAILURES,
  createBackgroundStore,
  type StoreChangeEvent,
} from "./store.ts";

const NOW = 1_700_000_000_000;

function sequentialIds(prefix = "bg") {
  let n = 0;
  return () => `${prefix}_${(n += 1)}`;
}

describe("background store change events", () => {
  test("create and createMonitor emit one event each", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const events: StoreChangeEvent[] = [];
    store.subscribe((event) => events.push(event));
    const task = store.create("sleep 1", "sleep 1", "/tmp/bg_1.log", "session");
    const monitor = store.createMonitor({
      command: "tail -f x",
      wsUrl: null,
      description: "tail -f x",
      outputFile: "/tmp/mn_2.log",
      sessionId: "session",
    });
    expect(events).toEqual([
      { kind: "task", id: task.id },
      { kind: "monitor", id: monitor.id },
    ]);
  });

  test("changed emits, and unsubscribe stops delivery", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const task = store.create("sleep 1", "sleep 1", "", "session");
    const events: StoreChangeEvent[] = [];
    const off = store.subscribe((event) => events.push(event));
    store.changed("task", task.id);
    expect(events).toEqual([{ kind: "task", id: task.id }]);
    off();
    store.changed("task", task.id);
    expect(events).toHaveLength(1);
  });

  test("a faulty listener never breaks the store", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    store.subscribe(() => {
      throw new Error("boom");
    });
    const seen: StoreChangeEvent[] = [];
    store.subscribe((event) => seen.push(event));
    const task = store.create("sleep 1", "sleep 1", "", "session");
    expect(seen).toEqual([{ kind: "task", id: task.id }]);
    expect(store.get(task.id)?.id).toBe(task.id);
  });
});

describe("background store seen state", () => {
  test("records start unseen", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const task = store.create("sleep 1", "sleep 1", "", "session");
    const monitor = store.createMonitor({
      command: "tail -f x",
      wsUrl: null,
      description: "tail -f x",
      outputFile: "",
      sessionId: "session",
    });
    expect(task.seen).toBe(false);
    expect(monitor.seen).toBe(false);
  });

  test("markSeen flips finished records with one event; running records never flip (F2a)", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const running = store.create("sleep 1", "sleep 1", "", "session");
    const done = store.create("true", "true", "", "session");
    done.status = "completed";
    done.endedAt = NOW + 1;
    const monitor = store.createMonitor({
      command: null,
      wsUrl: "ws://localhost:9",
      description: "ws",
      outputFile: "",
      sessionId: "session",
    });
    const events: StoreChangeEvent[] = [];
    store.subscribe((event) => events.push(event));
    // A running record is found but never flips: its later failure must count.
    expect(store.markSeen(running.id)).toBe(true);
    expect(store.get(running.id)?.seen).toBe(false);
    expect(store.markSeen(done.id)).toBe(true);
    expect(store.markSeen(monitor.id)).toBe(true);
    expect(store.markSeen("bg_missing")).toBe(false);
    expect(store.get(done.id)?.seen).toBe(true);
    expect(store.getMonitor(monitor.id)?.seen).toBe(false);
    expect(events).toEqual([{ kind: "task", id: done.id }]);
    // Marking an already-seen record is still found, but emits nothing new.
    expect(store.markSeen(done.id)).toBe(true);
    expect(events).toHaveLength(1);
  });

  test("markAllSeen flips only terminal records and returns the count", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const running = store.create("sleep 1", "sleep 1", "", "session");
    const done = store.create("true", "true", "", "session");
    done.status = "completed";
    done.endedAt = NOW + 1;
    const m = store.createMonitor({ command: "c", wsUrl: null, description: "c", outputFile: "", sessionId: "session" });
    m.status = "expired";
    m.endedAt = NOW + 2;
    expect(store.markAllSeen()).toBe(2);
    expect(store.get(running.id)?.seen).toBe(false);
    expect(store.get(done.id)?.seen).toBe(true);
    expect(store.getMonitor(m.id)?.seen).toBe(true);
    expect(store.markAllSeen()).toBe(0);
  });
});

describe("background store eviction", () => {
  function finishTask(store: ReturnType<typeof createBackgroundStore>, id: string, seen: boolean, endedAt = NOW + 1000) {
    const record = store.get(id);
    if (!record) throw new Error(`missing task ${id}`);
    record.status = "failed";
    record.endedAt = endedAt;
    if (seen) record.seen = true;
    store.changed("task", id);
  }

  test("clearFinished removes only finished records and reports counts", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    const running = store.create("sleep 30", "sleep 30", "", "session");
    const done = store.create("true", "true", "", "session");
    const failed = store.create("false", "false", "", "session");
    const monitor = store.createMonitor({ command: "echo hi", wsUrl: null, description: "echo hi", outputFile: "", sessionId: "session" });
    const events: StoreChangeEvent[] = [];
    store.subscribe((event) => events.push(event));
    finishTask(store, done.id, true);
    finishTask(store, failed.id, false);
    monitor.status = "stopped";
    monitor.endedAt = NOW + 1000;
    store.changed("monitor", monitor.id);
    events.length = 0;
    const cleared = store.clearFinished();
    expect(cleared).toEqual({ tasks: 2, monitors: 1 });
    expect(store.get(running.id)?.id).toBe(running.id);
    expect(store.get(done.id)).toBeUndefined();
    expect(store.get(failed.id)).toBeUndefined();
    expect(store.getMonitor(monitor.id)).toBeUndefined();
    // One event per evicted record.
    expect(events).toHaveLength(3);
  });

  test("finished records past the bound evict oldest-seen-first", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    expect(MAX_RETAINED_FINISHED).toBeGreaterThan(0);
    const ids: string[] = [];
    for (let i = 0; i < MAX_RETAINED_FINISHED + 3; i += 1) {
      ids.push(store.create(`cmd-${i}`, `cmd-${i}`, "", "session").id);
    }
    // Finish them oldest-first; all seen, so the bound bites on the 51st.
    ids.forEach((id, i) => finishTask(store, id, true, NOW + i));
    const finished = store.list().filter((record) => record.status !== "running");
    expect(finished).toHaveLength(MAX_RETAINED_FINISHED);
    // The three oldest finished are gone; running records are never evicted.
    expect(store.get(ids[0])).toBeUndefined();
    expect(store.get(ids[2])).toBeUndefined();
    expect(store.get(ids[3])?.id).toBe(ids[3]);
  });

  test("every finished record is bounded; unseen failures keep a smaller cap (F4)", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds() });
    expect(MAX_RETAINED_UNSEEN_FAILURES).toBeLessThan(MAX_RETAINED_FINISHED);
    // 500 unseen completed tasks: all bounded, none of them failures.
    const completed: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      const record = store.create(`cmd-${i}`, `cmd-${i}`, "", "session");
      record.status = "completed";
      record.endedAt = NOW + i;
      store.changed("task", record.id);
      completed.push(record.id);
    }
    void completed;
    expect(store.list()).toHaveLength(MAX_RETAINED_FINISHED);
    // Unseen failures survive up to their cap, then evict oldest-first.
    const failures: string[] = [];
    for (let i = 0; i < MAX_RETAINED_UNSEEN_FAILURES + 5; i += 1) {
      failures.push(store.create(`fail-${i}`, `fail-${i}`, "", "session").id);
    }
    failures.forEach((id, i) => finishTask(store, id, false, NOW + 1_000_000 + i));
    const kept = store.list().filter((record) => record.status === "failed");
    expect(kept).toHaveLength(MAX_RETAINED_UNSEEN_FAILURES);
    // The oldest unseen failures evicted; the newest survive and still count.
    expect(store.get(failures[0])).toBeUndefined();
    expect(store.get(failures[failures.length - 1])?.seen).toBe(false);
  });

  test("monitors share the same bound independently of tasks", () => {
    const store = createBackgroundStore({ now: () => NOW, makeId: sequentialIds("mn") });
    const ids: string[] = [];
    for (let i = 0; i < MAX_RETAINED_FINISHED + 2; i += 1) {
      ids.push(
        store.createMonitor({ command: `cmd-${i}`, wsUrl: null, description: `cmd-${i}`, outputFile: "", sessionId: "session" }).id,
      );
    }
    ids.forEach((id, i) => {
      const record = store.getMonitor(id);
      if (!record) throw new Error(`missing monitor ${id}`);
      record.status = "expired";
      record.endedAt = NOW + i;
      record.seen = true;
      store.changed("monitor", id);
    });
    expect(store.listMonitors()).toHaveLength(MAX_RETAINED_FINISHED);
  });
});
