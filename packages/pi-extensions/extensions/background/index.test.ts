import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stableWakeMessageId } from "@xtrm/contracts";

import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  OUTPUT_MAX_BYTES,
  TASK_NOTIFICATION_TYPE,
  TASK_STATES,
  formatTaskNotification,
  registerBackgroundExtension,
  sanitizeModelText,
} from "./index.ts";

type SentMessage = { message: Record<string, unknown>; options: Record<string, unknown> };
type ToolDef = {
  name: string;
  parameters?: unknown;
  exposure?: string;
  promptGuidelines?: string[];
  execute: (...args: any[]) => Promise<any>;
};

function fakePi(opts: { sendMessage?: (message: any, options: any) => void } = {}) {
  const tools = new Map<string, ToolDef>();
  const renderers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const sent: SentMessage[] = [];
  const pi = {
    tools,
    renderers,
    commands,
    handlers,
    sent,
    registerTool(tool: ToolDef) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer(type: string, renderer: unknown) {
      renderers.set(type, renderer);
    },
    registerCommand(name: string, options: unknown) {
      commands.set(name, options);
    },
    getSettings() {
      return {};
    },
    sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
      if (opts.sendMessage) {
        opts.sendMessage(message, options);
        return;
      }
      sent.push({ message, options });
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
  };
  return { pi: pi as any, tools, renderers, commands, handlers, sent };
}

const until = async (check: () => boolean, ms = 8000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const TMP_PREFIX = `${os.tmpdir()}${path.sep}`;

let dir = "";
let services: Array<{ close: () => void; store: { list: () => Array<{ outputFile: string; pid?: number }> } }> = [];
let consoleErrors: string[] = [];
const realConsoleError = console.error;
let savedAgentDir: string | undefined;
let savedTasksEnv: string | undefined;
let sandboxAgentDir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "background-test-"));
  // Hermetic off-switch: the file fallback must never see the operator's real settings.
  savedAgentDir = process.env.PI_AGENT_DIR;
  savedTasksEnv = process.env.BACKGROUND_TASKS;
  sandboxAgentDir = mkdtempSync(path.join(os.tmpdir(), "background-test-agent-"));
  process.env.PI_AGENT_DIR = sandboxAgentDir;
  delete process.env.BACKGROUND_TASKS;
  consoleErrors = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.error = realConsoleError;
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;
  if (savedTasksEnv === undefined) delete process.env.BACKGROUND_TASKS;
  else process.env.BACKGROUND_TASKS = savedTasksEnv;
  rmSync(sandboxAgentDir, { recursive: true, force: true });
  for (const service of services.splice(0)) {
    try {
      // Never touch anything outside the temp tree: a record whose output file
      // was never opened (failed open) has no directory to clean.
      const dirs = new Set<string>();
      for (const record of service.store.list()) {
        if (!record.outputFile || !path.isAbsolute(record.outputFile)) continue;
        const parent = path.dirname(record.outputFile);
        if (parent.startsWith(TMP_PREFIX)) dirs.add(parent);
      }
      for (const parent of dirs) {
        try {
          rmSync(parent, { recursive: true, force: true });
        } catch {
          /* already gone */
        }
      }
      service.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function startService(pi: any, overrides: Record<string, unknown> = {}) {
  const service = registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50, ...overrides });
  services.push(service as never);
  return service;
}

function startDefaultService(pi: any, overrides: Record<string, unknown> = {}) {
  const service = registerBackgroundExtension(pi, { killGraceMs: 50, ...overrides });
  services.push(service as never);
  return service;
}

const toolCtx = (session = "test-session") =>
  ({ cwd: dir, sessionManager: { getSessionId: () => session } }) as any;

const countOf = (text: string, needle: string) => text.split(needle).length - 1;

describe("background extension registration", () => {
  test("registers only BashBackground, Monitor and BackgroundStop, codemode-exposed, never bash/read/edit/write/find/grep/ls", () => {
    const { pi, tools } = fakePi();
    startService(pi);
    expect([...tools.keys()].sort()).toEqual(["BackgroundStop", "BashBackground", "Monitor"]);
    for (const name of ["bash", "read", "edit", "write", "find", "grep", "ls"]) {
      expect(tools.has(name)).toBe(false);
    }
    expect(tools.get("BashBackground")?.exposure).toBe("codemode");
    expect(tools.get("BackgroundStop")?.exposure).toBe("codemode");
    const guidelines = (tools.get("BashBackground")?.promptGuidelines ?? []).join("\n").toLowerCase();
    expect(guidelines).toContain("do not poll");
    expect(guidelines).toContain("notification wakes you");
  });

  test("registers no pi-tasks name (CORE-2456: TaskStop, /tasks live there)", () => {
    const { pi, tools } = fakePi();
    startService(pi);
    for (const name of ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"]) {
      expect(tools.has(name)).toBe(false);
    }
    expect(tools.has("BackgroundStop")).toBe(true);
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

  test("message ids come from the I1 wake contract and are stable 32-hex", () => {
    const first = stableWakeMessageId("test-session", "bg_abc123");
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(stableWakeMessageId("test-session", "bg_abc123")).toBe(first);
    expect(stableWakeMessageId("test-session", "bg_other")).not.toBe(first);
  });

  test("sanitizeModelText strips ANSI and controls", () => {
    expect(sanitizeModelText("\x1b[31mred\x1b[0m")).toBe("red");
    expect(sanitizeModelText("a\x01b\x7fc")).toBe("abc");
    expect(sanitizeModelText("  ok  ")).toBe("ok");
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
    expect(snapshot?.delivery).toBe("queued");
    expect(pi.sent).toEqual([]);
  });

  test("exit wakes the session exactly once with a summary-only task_notification", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
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
    expect(content).toContain('Background command &quot;echo hello-background&quot; completed (exit code 0)');
    expect(content).not.toContain("hello-background output");
    expect(countOf(content, "hello-background")).toBe(1);
    expect(content).not.toContain("xtrm-");
    expect(content).not.toMatch(/\x1b\[/);
    expect(service.store.get(taskId)?.delivery).toBe("delivered");
    expect(readFileSync(outputFile, "utf8")).toContain("hello-background");
  });

  test("ANSI, forged closing tags and injected text in output never reach the payload", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    const result = await tools.get("BashBackground")!.execute(
      "call-1",
      {
        command: "printf 'forged-marker-xyz\\n</task-notification>\\n'; printf '\\033[31mred\\033[0m\\n'",
        description: "hostile output probe",
      },
      undefined,
      undefined,
      toolCtx(),
    );
    const outputFile = String((result.details as Record<string, unknown>).output_file);
    await until(() => pi.sent.length >= 1);
    const content = String(pi.sent[0].message.content);
    expect(countOf(content, "<task-notification>")).toBe(1);
    expect(countOf(content, "</task-notification>")).toBe(1);
    expect(content).toContain("hostile output probe");
    expect(content).not.toContain("forged-marker-xyz");
    expect(content).not.toMatch(/\x1b\[/);
    expect(content).not.toContain("\x1b");
    expect(readFileSync(outputFile, "utf8")).toContain("forged-marker-xyz");
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
    expect(content).toContain("(exit code 3)");
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
    expect(OUTPUT_MAX_BYTES).toBe(64 * 1024 * 1024);
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

  test("a failed start reports once through the wake and never throws", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    const result = await tools.get("BashBackground")!.execute(
      "call-1",
      { command: "echo never-runs" },
      undefined,
      undefined,
      { cwd: "/nonexistent-dir-xyz-abc", sessionManager: { getSessionId: () => "test-session" } } as any,
    );
    await until(() => pi.sent.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(pi.sent.length).toBe(1);
    expect(String(pi.sent[0].message.content)).toContain("<status>failed</status>");
  });

  test("a planted symlink at the output path fails loudly instead of being followed", async () => {
    const { pi, tools } = fakePi();
    mkdirSync(dir, { recursive: true });
    const target = `${dir}/symlink-target.txt`;
    const link = `${dir}/background-fixed.log`;
    await Bun.write(target, "target-content");
    symlinkSync(target, link);
    const service = startService(pi, { makeId: () => "fixed" });
    let error: unknown;
    try {
      await tools.get("BashBackground")!.execute("call-1", { command: "echo hi" }, undefined, undefined, toolCtx());
    } catch (e) {
      error = e;
    }
    expect(String(error)).toMatch(/could not open output file/i);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("target-content");
    expect(service.store.get("fixed")?.status).toBe("failed");
  });

  test("output stops at the ceiling with one truncation line", async () => {
    const { pi, tools } = fakePi();
    startService(pi, { outputMaxBytes: 64 });
    const result = await tools.get("BashBackground")!.execute("call-1", { command: "seq 1 200" }, undefined, undefined, toolCtx());
    const outputFile = String((result.details as Record<string, unknown>).output_file);
    await until(() => pi.sent.length >= 1);
    const body = readFileSync(outputFile, "utf8");
    expect(body).toContain("[background: output truncated at 64 bytes]");
    expect(body.length).toBeLessThan(256);
    expect(body).not.toContain("\n200\n");
  });

  test("default session directory and output file carry restrictive permissions", async () => {
    const { pi, tools } = fakePi();
    const service = startDefaultService(pi);
    const result = await tools.get("BashBackground")!.execute("call-1", { command: "echo hi" }, undefined, undefined, toolCtx("perm-session"));
    const details = result.details as Record<string, unknown>;
    const outputFile = String(details.output_file);
    await until(() => pi.sent.length >= 1);
    expect(statSync(path.dirname(outputFile)).mode & 0o777).toBe(0o700);
    expect(statSync(outputFile).mode & 0o777).toBe(0o600);
    expect(service.store.get(String(details.task_id))?.sessionId).toBe("perm-session");
  });

  test("a throwing sendMessage records undelivered with one loud line and never throws", async () => {
    let calls = 0;
    const { pi, tools } = fakePi({
      sendMessage: () => {
        calls += 1;
        throw new Error("session gone");
      },
    });
    const service = startService(pi);
    const result = await tools.get("BashBackground")!.execute("call-1", { command: "echo hi" }, undefined, undefined, toolCtx());
    const taskId = String((result.details as Record<string, unknown>).task_id);
    await until(() => service.store.get(taskId)?.notified === true);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(1);
    expect(service.store.get(taskId)?.delivery).toBe("undelivered");
    expect(consoleErrors.join("\n")).toContain(taskId);
    expect(consoleErrors.join("\n")).toContain("undelivered");
  });
});

describe("BackgroundStop", () => {
  test("stops a running task with status stopped and exactly one notification", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const started = await tools.get("BashBackground")!.execute("call-1", { command: "sleep 30" }, undefined, undefined, toolCtx());
    const taskId = String((started.details as Record<string, unknown>).task_id);
    const stopped = await tools.get("BackgroundStop")!.execute("call-2", { task_id: taskId }, undefined, undefined, toolCtx());
    expect((stopped.details as Record<string, unknown>).status).toBe("stopped");
    await until(() => pi.sent.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(pi.sent.length).toBe(1);
    expect(String(pi.sent[0].message.content)).toContain("<status>stopped</status>");
    expect(service.store.get(taskId)?.delivery).toBe("delivered");
  });

  test("stopping a finished task is idempotent and reports its terminal status", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    const started = await tools.get("BashBackground")!.execute("call-1", { command: "echo done" }, undefined, undefined, toolCtx());
    const taskId = String((started.details as Record<string, unknown>).task_id);
    await until(() => pi.sent.length >= 1);
    const again = await tools.get("BackgroundStop")!.execute("call-2", { task_id: taskId }, undefined, undefined, toolCtx());
    expect((again.details as Record<string, unknown>).status).toBe("completed");
    expect(pi.sent.length).toBe(1);
  });

  test("an unknown task id fails loudly", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    let error: unknown;
    try {
      await tools.get("BackgroundStop")!.execute("call-1", { task_id: "bg_doesnotexist" }, undefined, undefined, toolCtx());
    } catch (e) {
      error = e;
    }
    expect(String(error)).toMatch(/unknown task/i);
  });
});

describe("rerunTask", () => {
  test("reruns a finished task as a new id with the same command", async () => {
    const { pi } = fakePi();
    const service = startService(pi);
    const first = await service.runBackground({ command: "echo hi", description: "echo hi" }, toolCtx());
    const firstId = String((first.details as Record<string, unknown>).task_id);
    await until(() => service.store.get(firstId)?.status === "completed");
    const rerun = await service.rerunTask(firstId);
    const secondId = String((rerun.details as Record<string, unknown>).task_id);
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    expect(service.store.get(secondId)?.command).toBe("echo hi");
    expect(service.store.get(secondId)?.status).toBe("running");
    await until(() => service.store.get(secondId)?.status === "completed");
  });

  test("rerunning a running task refuses with stop-it-first", async () => {
    const { pi } = fakePi();
    const service = startService(pi);
    const first = await service.runBackground({ command: "sleep 30", description: "sleep 30" }, toolCtx());
    const firstId = String((first.details as Record<string, unknown>).task_id);
    await expect(service.rerunTask(firstId)).rejects.toThrow(/stop it first/);
  });

  test("rerunning an unknown id fails loudly", async () => {
    const { pi } = fakePi();
    const service = startService(pi);
    await expect(service.rerunTask("bg_doesnotexist")).rejects.toThrow(/unknown task/);
  });

  test("rerunning a ws monitor replays its subprotocols", async () => {
    const { pi } = fakePi();
    const seenSockets: Array<{ url: string; protocols?: string[] }> = [];
    const service = startService(pi, {
      createWebSocket: ((url: string, protocols?: string[]) => {
        seenSockets.push({ url, protocols });
        return { onmessage: null, onclose: null, onerror: null, close: () => {} };
      }) as never,
    });
    const first = await service.runMonitor({ ws: { url: "ws://localhost:9/x", protocols: ["p1"] }, description: "ws" }, toolCtx());
    const firstId = String((first.details as Record<string, unknown>).monitor_id);
    await service.stopTask(firstId);
    const rerun = await service.rerunTask(firstId);
    const secondId = String((rerun.details as Record<string, unknown>).monitor_id);
    expect(secondId).not.toBe(firstId);
    expect(seenSockets).toHaveLength(2);
    expect(seenSockets[1]).toEqual({ url: "ws://localhost:9/x", protocols: ["p1"] });
    expect(service.store.getMonitor(secondId)?.wsProtocols).toEqual(["p1"]);
  });

  test("reruns a finished command monitor as a new armed id", async () => {
    const { pi } = fakePi();
    const service = startService(pi);
    const first = await service.runMonitor({ command: "echo hi", description: "echo hi" }, toolCtx());
    const firstId = String((first.details as Record<string, unknown>).monitor_id);
    await until(() => {
      const status = service.store.getMonitor(firstId)?.status;
      return status === "stopped" || status === "expired";
    });
    const rerun = await service.rerunTask(firstId);
    const secondId = String((rerun.details as Record<string, unknown>).monitor_id);
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    const status = service.store.getMonitor(secondId)?.status;
    expect(status === "armed" || status === "event").toBe(true);
  });
});

describe("seen across the lifecycle (F2a)", () => {
  test("a failure after markAllSeen still pins the indicator", async () => {
    const { pi } = fakePi();
    const service = startService(pi);
    const started = await service.runBackground(
      { command: "sleep 0.3; exit 3", description: "late failure" },
      toolCtx(),
    );
    const taskId = String((started.details as Record<string, unknown>).task_id);
    // The operator looks while the task still runs: nothing flips.
    expect(service.store.get(taskId)?.status).toBe("running");
    expect(service.store.markAllSeen()).toBe(0);
    expect(service.store.get(taskId)?.seen).toBe(false);
    await until(() => service.store.get(taskId)?.status === "failed");
    // The fresh failure counts even though the operator looked earlier.
    expect(service.store.get(taskId)?.seen).toBe(false);
    const { summarizeBackground } = await import("./widget.ts");
    expect(summarizeBackground(service.store.list(), service.store.listMonitors()).unseenFailures).toBe(1);
  });
});

describe("rerun replays cwd and timeout (F5)", () => {
  test("a rerun task respawns in the original cwd with the original timeout", async () => {
    const { pi } = fakePi();
    const service = startService(pi);
    const first = await service.runBackground(
      { command: "pwd", description: "whereami", timeout: 60000 },
      { cwd: dir, sessionManager: { getSessionId: () => "f5" } },
    );
    const firstId = String((first.details as Record<string, unknown>).task_id);
    expect(service.store.get(firstId)?.cwd).toBe(dir);
    expect(service.store.get(firstId)?.timeoutMs).toBe(60000);
    await until(() => service.store.get(firstId)?.status === "completed");
    const rerun = await service.rerunTask(firstId);
    const secondId = String((rerun.details as Record<string, unknown>).task_id);
    expect(service.store.get(secondId)?.cwd).toBe(dir);
    expect(service.store.get(secondId)?.timeoutMs).toBe(60000);
    await until(() => service.store.get(secondId)?.status === "completed");
    const output = readFileSync(service.store.get(secondId)?.outputFile as string, "utf8");
    expect(output.trim()).toBe(dir);
  });

  test("a rerun monitor keeps its cwd and timeout", async () => {
    const { pi } = fakePi();
    const service = startService(pi);
    const first = await service.runMonitor(
      { command: "echo hi", description: "hi", timeout_ms: 45000 },
      { cwd: dir, sessionManager: { getSessionId: () => "f5m" } },
    );
    const firstId = String((first.details as Record<string, unknown>).monitor_id);
    expect(service.store.getMonitor(firstId)?.cwd).toBe(dir);
    expect(service.store.getMonitor(firstId)?.timeoutMs).toBe(45000);
    await service.stopTask(firstId);
    const rerun = await service.rerunTask(firstId);
    const secondId = String((rerun.details as Record<string, unknown>).monitor_id);
    expect(service.store.getMonitor(secondId)?.cwd).toBe(dir);
    expect(service.store.getMonitor(secondId)?.timeoutMs).toBe(45000);
  });
});

describe("process exit hook (F2b)", () => {
  test("installs at most one exit hook no matter how many services register", () => {
    const { pi } = fakePi();
    const before = process.listenerCount("exit");
    const a = startService(pi);
    const b = startService(pi);
    const c = startService(pi);
    // An earlier suite may have installed the process hook already; what
    // matters is N services never add N listeners.
    expect(process.listenerCount("exit") - before).toBeLessThanOrEqual(1);
    a.close();
    b.close();
    c.close();
    expect(process.listenerCount("exit") - before).toBeLessThanOrEqual(1);
  });

  test("a quit after close still SIGKILLs a TERM-trapping tree (child bun process)", { timeout: 30000 }, async () => {
    const childDir = mkdtempSync(path.join(os.tmpdir(), "background-exit-child-"));
    const pidFile = path.join(childDir, "child.pid");
    const grandchildFile = path.join(childDir, "grandchild.pid");
    const closedFile = path.join(childDir, "closed");
    const outDir = path.join(childDir, "out");
    mkdirSync(outDir, { recursive: true });
    // File-relative, never process.cwd(): CI runs the suite from the repo
    // root while local runs use packages/pi-extensions (CORE-2352).
    const indexTs = new URL("./index.ts", import.meta.url).pathname;
    const script = [
      `const { registerBackgroundExtension } = await import(${JSON.stringify(indexTs)});`,
      `const pi = { registerTool() {}, registerMessageRenderer() {}, registerCommand() {}, getSettings: () => ({}), sendMessage() {}, on() {} };`,
      `const svc = registerBackgroundExtension(pi, { outputDir: ${JSON.stringify(outDir)}, killGraceMs: 5000 });`,
      `await svc.runBackground({ command: ${JSON.stringify(`echo $$ > ${pidFile}; trap "" TERM; sleep 60 & echo $! > ${grandchildFile}; wait`) } }, { cwd: ${JSON.stringify(childDir)}, sessionManager: { getSessionId: () => "exit-probe" } });`,
      `while (true) { try { const t = (await import("node:fs")).readFileSync(${JSON.stringify(grandchildFile)}, "utf8").trim(); if (t) break; } catch {} await new Promise((r) => setTimeout(r, 20)); }`,
      `svc.close();`,
      `(await import("node:fs")).writeFileSync(${JSON.stringify(closedFile)}, "closed\\n");`,
      `process.exit(0);`,
    ].join("\n");
    const { spawn } = await import("node:child_process");
    const child = spawn("bun", ["-e", script], { cwd: childDir, stdio: "ignore", detached: true });
    child.unref();
    try {
      // The child closes (non-blocking) and exits at once; the 5 s sweep
      // never fires. Only the synchronous exit hook can kill the tree.
      await until(() => {
        try {
          return readFileSync(closedFile, "utf8").trim() === "closed";
        } catch {
          return false;
        }
      }, 15000);
      const grandchildPid = Number(readFileSync(grandchildFile, "utf8").trim());
      expect(grandchildPid).toBeGreaterThan(0);
      await until(() => procGone(grandchildPid), 10000);
      expect(procGone(grandchildPid)).toBe(true);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      rmSync(childDir, { recursive: true, force: true });
    }
  });
});

describe("exit hook sharing across re-evaluations (N4)", () => {
  test("fifteen module evaluations share one exit hook", async () => {
    const before = process.listenerCount("exit");
    const { pi } = fakePi();
    // Dynamic specifiers defeat TS module resolution on purpose: each
    // query busts bun's module cache and re-evaluates index.ts.
    const reimport = (n: number): Promise<typeof import("./index.ts")> =>
      Function("s", "return import(s);")(`./index.ts?n4reval=${n}`) as Promise<typeof import("./index.ts")>;
    for (let i = 0; i < 15; i += 1) {
      const mod = await reimport(i);
      const service = mod.registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50 });
      services.push(service as never);
    }
    expect(process.listenerCount("exit") - before).toBeLessThanOrEqual(1);
  });
});

describe("tasks command registration", () => {
  test("registers /bg once, with no xtrm- slug and no tool-name collisions", () => {
    const { pi, tools, commands } = fakePi();
    startService(pi);
    expect([...commands.keys()]).toEqual(["bg"]);
    expect(tools.has("tasks")).toBe(false);
    for (const name of ["bash", "read", "edit", "write", "find", "grep", "ls"]) {
      expect(tools.has(name)).toBe(false);
    }
  });
});

describe("session_shutdown", () => {
  test("never blocks the event loop for the kill grace, sends no wake, settles stopped (B2 follow-up 7)", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi, { killGraceMs: 2000 });
    const started = await tools.get("BashBackground")!.execute(
      "call-1",
      { command: `trap "" TERM; sleep 60`, description: "term trapper" },
      undefined,
      undefined,
      toolCtx(),
    );
    const taskId = String((started.details as Record<string, unknown>).task_id);
    const pid = service.store.get(taskId)?.pid;
    expect(pid).toBeGreaterThan(0);
    const sentBefore = pi.sent.length;
    const startedAt = Date.now();
    service.close();
    // Returns at once even though the child traps TERM and the grace is 2 s.
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(service.store.get(taskId)?.status).toBe("stopped");
    // No wake follows: the session is going away.
    expect(pi.sent.length).toBe(sentBefore);
    // The sweep still SIGKILLs the trapper after the grace: no orphan.
    await until(() => procGone(pid as number), 10000);
    expect(procGone(pid as number)).toBe(true);
  });

  test("SIGTERMs running tasks with a short grace, then kills, and names them on one line", async () => {
    const { pi, tools, handlers } = fakePi();
    const service = startService(pi);
    const started = await tools.get("BashBackground")!.execute("call-1", { command: "sleep 30" }, undefined, undefined, toolCtx());
    const taskId = String((started.details as Record<string, unknown>).task_id);
    const pid = service.store.get(taskId)?.pid;
    expect(pid).toBeGreaterThan(0);
    const shutdown = handlers.get("session_shutdown");
    expect(shutdown?.length).toBe(1);
    for (const handler of shutdown ?? []) handler();
    expect(consoleErrors.join("\n")).toContain(taskId);
    await until(() => service.store.get(taskId)?.status === "stopped");
    await until(() => {
      try {
        process.kill(pid as number, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});

describe("formatTaskNotification", () => {
  test("carries task-id, status, summary and output-file with no ANSI and no output lines", () => {
    const content = formatTaskNotification({
      taskId: "bg_abc",
      status: "completed",
      summary: 'Background command "echo hi" completed (exit code 0)',
      outputFile: "/tmp/background-bg_abc.log",
      exitCode: 0,
    });
    expect(content).toContain("<task-id>bg_abc</task-id>");
    expect(content).toContain("<status>completed</status>");
    expect(content).toContain('<summary>Background command &quot;echo hi&quot; completed (exit code 0)</summary>');
    expect(content).toContain("<output-file>/tmp/background-bg_abc.log</output-file>");
    expect(countOf(content, "<task-notification>")).toBe(1);
    expect(countOf(content, "</task-notification>")).toBe(1);
    expect(content).not.toMatch(/\x1b\[/);
  });
});

/** A pid is gone when the signal fails or the kernel reports it a zombie. */
function procGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.split(")")[1]?.trim().split(" ")[0] === "Z";
  } catch {
    return true;
  }
}

function openFdTargets(): string[] {
  const found: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc/self/fd");
  } catch {
    return found;
  }
  for (const entry of entries) {
    try {
      found.push(readlinkSync(`/proc/self/fd/${entry}`));
    } catch {
      /* fd closed mid-scan */
    }
  }
  return found;
}

describe("B1 review follow-ups", () => {
  test("close returns at once and a SIGTERM-ignoring tree dies after the grace, no orphan", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const grandchildFile = `${dir}/grandchild.pid`;
    const result = await tools.get("BashBackground")!.execute(
      "call-1",
      { command: `trap "" TERM; sleep 60 & echo $! > ${grandchildFile}; wait` },
      undefined,
      undefined,
      toolCtx(),
    );
    const taskId = String((result.details as Record<string, unknown>).task_id);
    await until(() => {
      try {
        return readFileSync(grandchildFile, "utf8").trim().length > 0;
      } catch {
        return false;
      }
    });
    const pid = service.store.get(taskId)?.pid;
    expect(pid).toBeGreaterThan(0);
    const grandchildPid = Number(readFileSync(grandchildFile, "utf8").trim());
    expect(grandchildPid).toBeGreaterThan(0);
    expect(grandchildPid).not.toBe(pid);
    // B3 follow-up 7: non-blocking shutdown. close() SIGTERMs, settles the
    // record and returns; the sweep SIGKILLs the TERM-trapping tree later.
    const closedAt = Date.now();
    service.close();
    expect(Date.now() - closedAt).toBeLessThan(500);
    expect(service.store.get(taskId)?.status).toBe("stopped");
    await until(() => procGone(pid as number) && procGone(grandchildPid), 10000);
    expect(procGone(pid as number)).toBe(true);
    expect(procGone(grandchildPid)).toBe(true);
  });

  test("the shutdown grace path closes the output fd synchronously", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const result = await tools.get("BashBackground")!.execute("call-1", { command: "sleep 30" }, undefined, undefined, toolCtx());
    const outputFile = String((result.details as Record<string, unknown>).output_file);
    expect(openFdTargets()).toContain(outputFile);
    service.close();
    expect(openFdTargets()).not.toContain(outputFile);
  });

  test("a description with < and \" is escaped in the task-notification summary", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    const result = await tools.get("BashBackground")!.execute(
      "call-1",
      { command: "echo hi", description: '<img src="x">' },
      undefined,
      undefined,
      toolCtx(),
    );
    const taskId = String((result.details as Record<string, unknown>).task_id);
    await until(() => pi.sent.length >= 1);
    const content = String(pi.sent[0].message.content);
    expect(content).toContain(`<task-id>${taskId}</task-id>`);
    expect(content).toContain("&lt;img src=&quot;x&quot;&gt;");
    expect(content).not.toContain('<img src="x">');
  });
});

describe("stop-then-quit", () => {
  test("a stopped background task is dead after close inside the grace window", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const result = await tools.get("BashBackground")!.execute("call-1", { command: "sleep 30" }, undefined, undefined, toolCtx());
    const taskId = String((result.details as Record<string, unknown>).task_id);
    const pid = service.store.get(taskId)?.pid;
    expect(pid).toBeGreaterThan(0);
    await tools.get("BackgroundStop")!.execute("call-2", { task_id: taskId }, undefined, undefined, toolCtx());
    service.close();
    expect(service.store.get(taskId)?.status).toBe("stopped");
    await until(() => procGone(pid as number), 10000);
    expect(procGone(pid as number)).toBe(true);
  });
});
