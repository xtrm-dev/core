import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({ VERSION: "1.0.0-test" }));

const waiting = await import("./waiting.ts");
const { registerFooterSection } = await import("../custom-footer/index.ts");

describe("intercom waiting-count source (CORE-2435 I4, fed by I5)", () => {
  test("starts at zero: no pending asks, no undelivered messages", () => {
    const store = waiting.createWaitingStore();
    expect(store.total()).toBe(0);
    expect(waiting.formatIntercomChip(store)).toBeNull();
  });

  test("one pending ask renders the contract example exactly", () => {
    const store = waiting.createWaitingStore();
    store.setPendingAsks(1);
    expect(waiting.formatIntercomChip(store)).toBe("intercom · 1 pending ask");
  });

  test("plurals and undelivered messages", () => {
    const store = waiting.createWaitingStore();
    store.setPendingAsks(2);
    store.setUndelivered(3);
    expect(waiting.formatIntercomChip(store)).toBe("intercom · 2 pending asks · 3 undelivered messages");
  });

  test("a single undelivered message renders alone", () => {
    const store = waiting.createWaitingStore();
    store.setUndelivered(1);
    expect(waiting.formatIntercomChip(store)).toBe("intercom · 1 undelivered message");
  });

  test("the chip carries no ANSI and no hex colours: theme default only", () => {
    const store = waiting.createWaitingStore();
    store.setPendingAsks(1);
    const chip = waiting.formatIntercomChip(store)!;
    expect(chip).not.toMatch(/\u001b/);
    expect(chip).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  test("subscribers hear every change", () => {
    const store = waiting.createWaitingStore();
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.total()));
    store.setPendingAsks(1);
    store.setUndelivered(2);
    expect(seen).toEqual([1, 3]);
  });
});

describe("intercom footer chip", () => {
  test("hidden while nothing waits, shown once something waits", () => {
    const store = waiting.createWaitingStore();
    expect(waiting.footerLines(store, 80)).toEqual([]);
    store.setPendingAsks(1);
    expect(waiting.footerLines(store, 80)).toEqual(["intercom · 1 pending ask"]);
    store.setPendingAsks(0);
    expect(waiting.footerLines(store, 80)).toEqual([]);
  });

  test("registerIntercomFooter registers under the intercom key and unregisters cleanly", () => {
    const store = waiting.createWaitingStore();
    const unregister = waiting.registerIntercomFooter(store);
    expect(typeof unregister).toBe("function");
    expect(typeof registerFooterSection).toBe("function");
    unregister();
  });
});
