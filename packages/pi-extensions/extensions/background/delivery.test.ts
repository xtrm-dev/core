import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MONITOR_EVENT_TYPE,
  TASK_NOTIFICATION_TYPE,
  isBackgroundEnabled,
  readEnabledFromSettingsFiles,
  registerBackgroundExtension,
} from "./index.ts";

type SentMessage = { message: Record<string, unknown>; options: Record<string, unknown> };

function fakePi() {
  const tools = new Map<string, unknown>();
  const renderers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const sent: SentMessage[] = [];
  const widgets: Array<{ key: string; content: unknown }> = [];
  const pi = {
    tools,
    renderers,
    commands,
    handlers,
    sent,
    widgets,
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerMessageRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
    registerCommand: (name: string, options: unknown) => commands.set(name, options),
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => {
      sent.push({ message, options });
    },
    on: (name: string, handler: (...args: any[]) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    getSettings: () => ({}),
    getSessionName: () => "",
  };
  return { pi: pi as never, tools, renderers, commands, handlers, sent, widgets };
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
let savedAgentDir: string | undefined;
let sandboxAgentDir = "";

function writeAgentSettings(value: unknown): void {
  writeFileSync(path.join(sandboxAgentDir, "settings.json"), JSON.stringify(value));
}

function writeProjectSettings(cwd: string, value: unknown): void {
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi", "settings.json"), typeof value === "string" ? value : JSON.stringify(value));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "background-delivery-test-"));
  // Hermetic off-switch: the file fallback must never see the operator's real settings.
  savedAgentDir = process.env.PI_AGENT_DIR;
  sandboxAgentDir = mkdtempSync(path.join(os.tmpdir(), "background-delivery-agent-"));
  process.env.PI_AGENT_DIR = sandboxAgentDir;
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;
  rmSync(sandboxAgentDir, { recursive: true, force: true });
  for (const service of services.splice(0)) {
    try {
      service.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const toolCtx = (session = "test-session") => ({ cwd: dir, sessionManager: { getSessionId: () => session } });

describe("task-notification delivery", () => {
  test("to a busy session it queues as a followUp with exactly one wake", async () => {
    const { pi, sent, tools } = fakePi();
    const service = registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50 });
    services.push(service);
    // Busy: the agent is mid-turn streaming. The extension's whole control
    // over busy-versus-idle is these options: deliverAs followUp queues
    // behind the turn; the runtime owns the queue itself.
    const run = tools.get("BashBackground") as { execute: (...args: any[]) => Promise<any> };
    await run.execute("call", { command: "true", description: "true" }, undefined, undefined, toolCtx());
    await until(() => sent.length === 1);
    const [wake] = sent;
    expect(wake?.message.customType).toBe(TASK_NOTIFICATION_TYPE);
    expect(wake?.options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
    await until(() => (service.store.list()[0]?.status ?? "running") !== "running");
    // Exactly once: no second wake follows the settlement.
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(1);
  });

  test("to an idle session the same wake triggers the turn", async () => {
    const { pi, sent, tools } = fakePi();
    const service = registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50 });
    services.push(service);
    // Idle: nobody streams. triggerTurn: true is the wake; without it the
    // message would sit unread until the operator speaks.
    const run = tools.get("BashBackground") as { execute: (...args: any[]) => Promise<any> };
    await run.execute("call", { command: "true", description: "true" }, undefined, undefined, toolCtx());
    await until(() => sent.length === 1);
    expect(sent[0]?.options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
    expect(sent[0]?.message.customType).toBe(TASK_NOTIFICATION_TYPE);
  });
});

describe("monitor-event delivery", () => {
  test("events and the terminal notice queue as followUp and trigger the turn", async () => {
    const { pi, sent, tools } = fakePi();
    const service = registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50 });
    services.push(service);
    const run = tools.get("Monitor") as { execute: (...args: any[]) => Promise<any> };
    await run.execute("call", { command: "printf 'a\\nb\\n'", description: "two lines" }, undefined, undefined, toolCtx());
    await until(() => sent.length >= 1);
    for (const wake of sent) {
      expect(wake.options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
    }
    expect(sent[0]?.message.customType).toBe(MONITOR_EVENT_TYPE);
    await until(() => sent.some((wake) => (wake.message.details as { kind?: string })?.kind !== "event"));
  });
});

describe("background off switch", () => {
  const ENV_KEY = "BACKGROUND_TASKS";
  let savedEnv: string | undefined;
  let savedSettings: unknown;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    savedSettings = undefined;
    void savedSettings;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  test("BACKGROUND_TASKS=off disables every registration", () => {
    process.env[ENV_KEY] = "off";
    const { pi, tools, renderers, commands } = fakePi();
    const service = registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50 });
    services.push(service);
    expect(isBackgroundEnabled(pi)).toBe(false);
    expect(tools.size).toBe(0);
    expect(renderers.size).toBe(0);
    expect(commands.size).toBe(0);
  });

  test("background.enabled=false in settings disables too", () => {
    const { pi, tools } = fakePi();
    (pi as { getSettings: () => unknown }).getSettings = () => ({ background: { enabled: false } });
    const service = registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50 });
    services.push(service);
    expect(isBackgroundEnabled(pi)).toBe(false);
    expect(tools.size).toBe(0);
  });

  test("the extension is on by default and stays on with explicit true", () => {
    const { pi, tools, commands } = fakePi();
    const service = registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50 });
    services.push(service);
    expect(isBackgroundEnabled(pi)).toBe(true);
    expect([...tools.keys()].sort()).toEqual(["BackgroundStop", "BashBackground", "Monitor"]);
    expect([...commands.keys()]).toEqual(["bg"]);
  });

  test("the file fallback disables the extension without getSettings (CORE-2456)", () => {
    const { pi, tools } = fakePi();
    writeAgentSettings({ background: { enabled: false } });
    const service = registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50 });
    services.push(service);
    expect(isBackgroundEnabled(pi)).toBe(false);
    expect(tools.size).toBe(0);
  });

  test("project settings win over global ones; broken files are ignored", () => {
    const savedCwd = process.cwd();
    process.chdir(dir);
    try {
      const { pi } = fakePi();
      writeAgentSettings({ background: { enabled: true } });
      expect(readEnabledFromSettingsFiles(dir, sandboxAgentDir)).toBe(true);
      expect(isBackgroundEnabled(pi)).toBe(true);
      writeProjectSettings(dir, { background: { enabled: false } });
      expect(readEnabledFromSettingsFiles(dir, sandboxAgentDir)).toBe(false);
      expect(isBackgroundEnabled(pi)).toBe(false);
      writeProjectSettings(dir, "not json{{{");
      expect(readEnabledFromSettingsFiles(dir, sandboxAgentDir)).toBe(true);
    } finally {
      process.chdir(savedCwd);
    }
  });

  test("getSettings wins over the files when both name a value", () => {
    const { pi } = fakePi();
    writeAgentSettings({ background: { enabled: false } });
    (pi as { getSettings: () => unknown }).getSettings = () => ({ background: { enabled: true } });
    expect(isBackgroundEnabled(pi)).toBe(true);
  });
  test("precedence is explicit option, then env, then settings, then files", () => {
    const { pi } = fakePi();
    expect(isBackgroundEnabled(pi, { enabled: false })).toBe(false);
    process.env[ENV_KEY] = "off";
    expect(isBackgroundEnabled(pi, { enabled: true })).toBe(true);
    delete process.env[ENV_KEY];
    (pi as { getSettings: () => unknown }).getSettings = () => ({ background: { enabled: false } });
    expect(isBackgroundEnabled(pi)).toBe(false);
    process.env[ENV_KEY] = "1";
    expect(isBackgroundEnabled(pi)).toBe(true);
  });

  test("a disabled service fails its tools loudly instead of half-running", async () => {
    process.env[ENV_KEY] = "off";
    const { pi } = fakePi();
    const service = registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50 });
    services.push(service);
    await expect(service.runBackground({ command: "true" })).rejects.toThrow(/disabled/);
    await expect(service.runMonitor({ command: "true" })).rejects.toThrow(/disabled/);
    await expect(service.stopTask("bg_x")).rejects.toThrow(/disabled/);
  });
});
