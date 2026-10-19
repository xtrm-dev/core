import { afterEach, describe, expect, spyOn, test } from "bun:test";

const trace = await import("./trace.ts");

const spies: Array<{ mockRestore(): void }> = [];

function capture(): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  spies.push(spy);
  return lines;
}

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

describe("intercom trace line (CORE-2488 phase 1)", () => {
  test("renders a prefixed, flat key=value line in caller order", () => {
    expect(trace.traceLine("send.claude", { messageId: "m-1", from: "uds:/tmp/own.sock", sock: "/tmp/cass.sock" })).toBe(
      "[intercom-trace] send.claude messageId=m-1 from=uds:/tmp/own.sock sock=/tmp/cass.sock",
    );
  });

  test("an absent value reads none instead of dropping the field", () => {
    expect(trace.traceLine("send.claude", { sock: undefined, sockSource: null, target: "" })).toBe(
      "[intercom-trace] send.claude sock=none sockSource=none target=none",
    );
  });

  test("numbers and booleans render bare, whitespace is quoted", () => {
    expect(trace.traceLine("receipt.in", { elapsedMs: 30, live: true, reason: "not idle yet" })).toBe(
      '[intercom-trace] receipt.in elapsedMs=30 live=true reason="not idle yet"',
    );
  });

  test("a line with no fields keeps the prefix and site", () => {
    expect(trace.traceLine("roster.miss", {})).toBe("[intercom-trace] roster.miss");
  });

  test("emission writes one line to stderr", () => {
    const lines = capture();
    trace.intercomTrace("ack.out", { origMessageId: "m-1", sock: "/tmp/peer.sock" });
    expect(lines).toEqual(["[intercom-trace] ack.out origMessageId=m-1 sock=/tmp/peer.sock"]);
  });

  test("a throwing stderr never breaks the caller", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr gone");
    });
    spies.push(spy);
    expect(() => trace.intercomTrace("send.claude", { messageId: "m-1" })).not.toThrow();
  });
});
