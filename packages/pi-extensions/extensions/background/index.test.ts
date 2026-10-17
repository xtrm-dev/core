import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  TASK_NOTIFICATION_TYPE,
  TASK_STATES,
  formatTaskNotification,
  registerBackgroundExtension,
  stableBackgroundMessageId,
} from "./index.ts";

type SentMessage = { message: Record<string, unknown>; options: Record<string, unknown> };
type ToolDef = {
  name: string;
  parameters?: unknown;
  exposure?: string;
  promptGuidelines?: string[];
  execute: (...args: any[]) => Promise<any>;
};

function fakePi() {
  const tools = new Map<string, ToolDef>();
  const renderers = new Map<string, unknown>();
  const sent: SentMessage[] = [];
  const pi = {
    tools,
    renderers,
    sent,
    registerTool(tool: ToolDef) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer(type: string, renderer: unknown) {
      renderers.set(type, renderer);
    },
    sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
      sent.push({ message, options });
    },
    on() {
      return () => {};
    },
  };
  return { pi: pi as any, tools, renderers, sent };
}

const until = async (check: () => boolean, ms = 8000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let dir = "";
let services: Array<{ close: () => void }> = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "background-test-"));
});

afterEach(() => {
  for (const service of services.splice(0)) {
    try {
      service.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function startService(pi: any, overrides: Record<string, unknown> = {}) {
  const service = registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50, ...overrides });
  services.push(service);
  return service;
}

const toolCtx = () => ({ cwd: dir, sessionManager: { getSessionId: () => "test-session" } }) as any;

describe("background extension registration", () => {
  test("registers only BashBackground and TaskStop, codemode-exposed, never bash/read/edit/write/find/grep/ls", () => {
    const { pi, tools } = fakePi();
    startService(pi);
    expect([...tools.keys()].sort()).toEqual(["BashBackground", "TaskStop"]);
    for (const name of ["bash", "read", "edit", "write", "find", "grep", "ls"]) {
      expect(tools.has(name)).toBe(false);
    }
    expect(tools.get("BashBackground")?.exposure).toBe("codemode");
    expect(tools.get("TaskStop")?.exposure).toBe("codemode");
    const guidelines = (tools.get("BashBackground")?.promptGuidelines ?? []).join("\n").toLowerCase();
    expect(guidelines).toContain("do not poll");
    expect(guidelines).toContain("notification wakes you");
  });

  test("registers a task_notification message renderer and no xtrm- slug user-visible", () => {
    const { pi, renderers } = fakePi();
    startService(pi);
    expect(renderers.has(TASK_NOTIFICATION_TYPE)).toBe(true);
    expect(TASK_NOTIFICATION_TYPE).toBe("task_notification");
    expect(TASK_NOTIFICATION_TYPE.includes("xtrm")).toBe(false);
  });

  test("task states use the D7 vocabulary", () => {
    expect([...TASK_STATES].sort()).toEqual(["completed", "failed", "running", "stopped", "timed_out"]);
  });

  test("message ids are stable 32-hex like the I1 wake contract", () => {
    const first = stableBackgroundMessageId("bg_abc123");
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(stableBackgroundMessageId("bg_abc123")).toBe(first);
    expect(stableBackgroundMessageId("bg_other")).not.toBe(first);
  });
});

describe("BashBackground", () => {
  test("returns at once with a task id and an output file while the process still runs", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const result = await tools.get("BashBackground")!.execute("call-1", { command: "sleep 5" }, undefined, undefined, toolCtx());
    const details = result.details as Record<string, unknown>;
    expect(typeof details.task_id).toBe("string");
    expect(String(details.task_id).length).toBeGreaterThan(0);
    expect(typeof details.output_file).toBe("string");
    expect(details.status).toBe("running");
    const snapshot = service.store.get(String(details.task_id));
    expect(snapshot?.status).toBe("running");
    expect(pi.sent).toEqual([]);
  });

  test("exit wakes the session exactly once with a task_notification and readable output file", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    const result = await tools.get("BashBackground")!.execute("call-1", { command: "echo hello-background" }, undefined, undefined, toolCtx());
    const details = result.details as Record<string, unknown>;
    const taskId = String(details.task_id);
    const outputFile = String(details.output_file);
    await until(() => pi.sent.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(pi.sent.length).toBe(1);
    const [{ message, options }] = pi.sent;
    expect(message.customType).toBe("task_notification");
    expect(options).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });
    const content = String(message.content);
    expect(content).toContain("<task-notification>");
    expect(content).toContain(`<task-id>${taskId}</task-id>`);
    expect(content).toContain("<status>completed</status>");
    expect(content).toContain(`<output-file>${outputFile}</output-file>`);
    expect(content).toContain("Read ");
    expect(content).not.toContain("xtrm-");
    expect(content).not.toMatch(/\x1b\[/);
    expect(readFileSync(outputFile, "utf8")).toContain("hello-background");
  });

  test("nonzero exit ends with status failed", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    const result = await tools.get("BashBackground")!.execute("call-1", { command: "exit 3" }, undefined, undefined, toolCtx());
    const taskId = String((result.details as Record<string, unknown>).task_id);
    await until(() => pi.sent.length >= 1);
    const content = String(pi.sent[0].message.content);
    expect(content).toContain("<status>failed</status>");
    expect(content).toContain("<exit-code>3</exit-code>");
    expect(content).toContain(`<task-id>${taskId}</task-id>`);
  });

  test("timeout ends with status timed_out and exactly one notification", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    const result = await tools.get("BashBackground")!.execute(
      "call-1",
      { command: "sleep 30", timeout: 200 },
      undefined,
      undefined,
      toolCtx(),
    );
    const taskId = String((result.details as Record<string, unknown>).task_id);
    await until(() => pi.sent.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(pi.sent.length).toBe(1);
    const content = String(pi.sent[0].message.content);
    expect(content).toContain("<status>timed_out</status>");
    expect(content).toContain(`<task-id>${taskId}</task-id>`);
  });

  test("rejects a timeout above the 2 h maximum and the defaults match Claude Code", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(MAX_TIMEOUT_MS).toBe(2 * 60 * 60 * 1000);
  });

  test("rejects a timeout above the maximum instead of silently clamping", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    let error: unknown;
    try {
      await tools.get("BashBackground")!.execute("call-1", { command: "echo hi", timeout: MAX_TIMEOUT_MS + 1 }, undefined, undefined, toolCtx());
    } catch (e) {
      error = e;
    }
    expect(String(error)).toMatch(/timeout/i);
    expect(pi.sent).toEqual([]);
  });
});

describe("TaskStop", () => {
  test("stops a running task with status stopped and exactly one notification", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    const started = await tools.get("BashBackground")!.execute("call-1", { command: "sleep 30" }, undefined, undefined, toolCtx());
    const taskId = String((started.details as Record<string, unknown>).task_id);
    const stopped = await tools.get("TaskStop")!.execute("call-2", { task_id: taskId }, undefined, undefined, toolCtx());
    expect((stopped.details as Record<string, unknown>).status).toBe("stopped");
    await until(() => pi.sent.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(pi.sent.length).toBe(1);
    expect(String(pi.sent[0].message.content)).toContain("<status>stopped</status>");
  });

  test("stopping a finished task is idempotent and reports its terminal status", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    const started = await tools.get("BashBackground")!.execute("call-1", { command: "echo done" }, undefined, undefined, toolCtx());
    const taskId = String((started.details as Record<string, unknown>).task_id);
    await until(() => pi.sent.length >= 1);
    const again = await tools.get("TaskStop")!.execute("call-2", { task_id: taskId }, undefined, undefined, toolCtx());
    expect((again.details as Record<string, unknown>).status).toBe("completed");
    expect(pi.sent.length).toBe(1);
  });

  test("an unknown task id fails loudly", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    let error: unknown;
    try {
      await tools.get("TaskStop")!.execute("call-1", { task_id: "bg_doesnotexist" }, undefined, undefined, toolCtx());
    } catch (e) {
      error = e;
    }
    expect(String(error)).toMatch(/unknown task/i);
  });
});

describe("formatTaskNotification", () => {
  test("carries task-id, status, summary and output-file with no ANSI", () => {
    const content = formatTaskNotification({
      taskId: "bg_abc",
      status: "completed",
      summary: "Background task finished",
      outputFile: "/tmp/background-bg_abc.log",
      exitCode: 0,
      elapsedMs: 1200,
      preview: ["line one"],
    });
    expect(content).toContain("<task-id>bg_abc</task-id>");
    expect(content).toContain("<status>completed</status>");
    expect(content).toContain("<summary>Background task finished</summary>");
    expect(content).toContain("<output-file>/tmp/background-bg_abc.log</output-file>");
    expect(content).not.toMatch(/\x1b\[/);
  });
});
