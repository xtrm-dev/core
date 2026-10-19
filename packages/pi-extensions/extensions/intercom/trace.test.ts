import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const trace = await import("./trace.ts");

const tmpDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function tempTraceFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "intercom-trace-"));
  tmpDirs.push(dir);
  return join(dir, "intercom-trace.log");
}

function readLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
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

  test("emission appends one line to the trace file with the session id", () => {
    const file = tempTraceFile();
    setEnv("INTERCOM_TRACE_FILE", file);
    setEnv("XTRM_SESSION_ID", "sess-test-1");
    trace.intercomTrace("ack.out", { origMessageId: "m-1", sock: "/tmp/peer.sock" });
    expect(readLines(file)).toEqual(["[intercom-trace] ack.out origMessageId=m-1 sock=/tmp/peer.sock session=sess-test-1"]);
  });

  test("emission never touches stderr (CORE-2489: prompt stays clean)", () => {
    const file = tempTraceFile();
    setEnv("INTERCOM_TRACE_FILE", file);
    setEnv("XTRM_SESSION_ID", "sess-test-1");
    const errors: unknown[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(line);
    });
    try {
      trace.intercomTrace("send.claude", { messageId: "m-1" });
      trace.intercomTrace("send.claude.result", { messageId: "m-1", outcome: "delivered" });
      trace.intercomTrace("roster.miss", { key: "zzz", entries: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(errors).toEqual([]);
    expect(readLines(file)).toHaveLength(3);
  });

  test("a failing file append never breaks the caller and stays off stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "intercom-trace-broken-"));
    tmpDirs.push(dir);
    setEnv("INTERCOM_TRACE_FILE", dir); // appending to a directory always fails
    const errors: unknown[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(line);
    });
    try {
      expect(() => trace.intercomTrace("send.claude", { messageId: "m-1" })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(errors).toEqual([]);
  });

  test("without session env the line falls back to the pid", () => {
    const file = tempTraceFile();
    setEnv("INTERCOM_TRACE_FILE", file);
    setEnv("XTRM_SESSION_ID", undefined);
    setEnv("XTRM_SESSION_NAME", undefined);
    trace.intercomTrace("roster.miss", {});
    expect(readLines(file)).toEqual([`[intercom-trace] roster.miss session=pid-${process.pid}`]);
  });
});
