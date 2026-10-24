import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  MONITOR_EVENT_TYPE,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_MAX_TIMEOUT_MS,
  registerBackgroundExtension,
} from "./index.ts";
import { MONITOR_STATES, formatMonitorEvent, formatMonitorExpired, formatMonitorStopped } from "./store.ts";

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

let dir = "";
let services: Array<{ close: () => void }> = [];
let savedAgentDir: string | undefined;
let savedTasksEnv: string | undefined;
let sandboxAgentDir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "monitor-test-"));
  // Hermetic off-switch: the file fallback must never see the operator's real settings.
  savedAgentDir = process.env.PI_AGENT_DIR;
  savedTasksEnv = process.env.BACKGROUND_TASKS;
  sandboxAgentDir = mkdtempSync(path.join(os.tmpdir(), "monitor-test-agent-"));
  process.env.PI_AGENT_DIR = sandboxAgentDir;
  delete process.env.BACKGROUND_TASKS;
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;
  if (savedTasksEnv === undefined) delete process.env.BACKGROUND_TASKS;
  else process.env.BACKGROUND_TASKS = savedTasksEnv;
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

function startService(pi: any, overrides: Record<string, unknown> = {}) {
  const service = registerBackgroundExtension(pi, { outputDir: dir, killGraceMs: 50, ...overrides });
  services.push(service as never);
  return service;
}

const toolCtx = (session = "monitor-session") =>
  ({ cwd: dir, sessionManager: { getSessionId: () => session } }) as any;

const countOf = (text: string, needle: string) => text.split(needle).length - 1;

const monitorEvents = (sent: SentMessage[]) =>
  sent.filter(
    (s) => s.message.customType === MONITOR_EVENT_TYPE && String(s.message.content).includes("<monitor-event>"),
  );
const monitorNotices = (sent: SentMessage[]) =>
  sent.filter(
    (s) =>
      s.message.customType === MONITOR_EVENT_TYPE &&
      !String(s.message.content).includes("<monitor-event>"),
  );

/** Minimal RFC 6455 server: answers one upgrade, sends unmasked text frames, closes. */
function startFrameServer(frames: string[]): Promise<{ server: Server; url: string }> {
  const server = createServer();
  server.on("upgrade", (req, socket: Socket) => {
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "utf8")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    for (const frame of frames) {
      const payload = Buffer.from(frame, "utf8");
      if (payload.length < 126) {
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      } else if (payload.length < 65536) {
        const header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
        socket.write(Buffer.concat([header, payload]));
      } else {
        throw new Error("test frame too long");
      }
    }
    socket.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no listen address");
      resolve({ server, url: `ws://127.0.0.1:${address.port}/events` });
    });
  });
}

describe("Monitor registration", () => {
  test("registers BashBackground, Monitor and BackgroundStop, direct-exposed, never bash/read/edit/write/find/grep/ls", () => {
    const { pi, tools } = fakePi();
    startService(pi);
    expect([...tools.keys()].sort()).toEqual(["BackgroundStop", "BashBackground", "Monitor"]);
    for (const name of ["bash", "read", "edit", "write", "find", "grep", "ls"]) {
      expect(tools.has(name)).toBe(false);
    }
    expect(tools.get("Monitor")?.exposure).toBe("direct");
    const guidelines = (tools.get("Monitor")?.promptGuidelines ?? []).join("\n").toLowerCase();
    expect(guidelines).toContain("do not poll");
    expect(guidelines).toContain("failure");
  });

  test("registers a monitor_event renderer with no xtrm- slug user-visible", () => {
    const { pi, renderers } = fakePi();
    startService(pi);
    expect(renderers.has(MONITOR_EVENT_TYPE)).toBe(true);
    expect(MONITOR_EVENT_TYPE).toBe("monitor_event");
    expect(MONITOR_EVENT_TYPE.includes("xtrm")).toBe(false);
  });

  test("monitor states use the D7 vocabulary", () => {
    expect([...MONITOR_STATES].sort()).toEqual(["armed", "event", "expired", "stopped"]);
  });

  test("default timeout is 5 min, max is 30 min", () => {
    expect(MONITOR_DEFAULT_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(MONITOR_MAX_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  test("rejects a timeout above the 30 min maximum", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    let error: unknown;
    try {
      await tools
        .get("Monitor")!
        .execute("call-1", { command: "echo hi", timeout_ms: MONITOR_MAX_TIMEOUT_MS + 1 }, undefined, undefined, toolCtx());
    } catch (e) {
      error = e;
    }
    expect(String(error)).toMatch(/timeout/i);
    expect(pi.sent).toEqual([]);
  });

  test("requires exactly one of command and ws", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    for (const params of [{ description: "neither" }, { command: "echo hi", ws: { url: "wss://example.invalid" } }, {}]) {
      let error: unknown;
      try {
        await tools.get("Monitor")!.execute("call-1", params, undefined, undefined, toolCtx());
      } catch (e) {
        error = e;
      }
      expect(String(error)).toMatch(/one of|command|ws/i);
    }
    expect(pi.sent).toEqual([]);
  });
});

describe("Monitor command mode", () => {
  test("streams one event per line", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    const result = await tools
      .get("Monitor")!
      .execute("call-1", { command: "printf 'line-a\\nline-b\\n'; sleep 30", description: "line probe" }, undefined, undefined, toolCtx());
    const monitorId = String((result.details as Record<string, unknown>).monitor_id);
    await until(() => monitorEvents(pi.sent).length >= 1);
    const content = String(monitorEvents(pi.sent)[0].message.content);
    expect(content).toContain("<monitor-event>");
    expect(content).toContain(`<monitor-id>${monitorId}</monitor-id>`);
    expect(content).toContain("<line>line-a</line>");
    expect(content).toContain("<line>line-b</line>");
    expect(monitorEvents(pi.sent)[0].options).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });
  });

  test("lines within 200 ms batch into one event; later lines form the next", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    await tools
      .get("Monitor")!
      .execute(
        "call-1",
        { command: "printf 'b1\\nb2\\nb3\\n'; sleep 0.5; echo b4; sleep 30", description: "batch probe" },
        undefined,
        undefined,
        toolCtx(),
      );
    await until(() => monitorEvents(pi.sent).length >= 2);
    await new Promise((r) => setTimeout(r, 400));
    const events = monitorEvents(pi.sent);
    expect(events.length).toBe(2);
    const first = String(events[0].message.content);
    expect(first).toContain("<line>b1</line>");
    expect(first).toContain("<line>b2</line>");
    expect(first).toContain("<line>b3</line>");
    expect(first).toContain("<event-index>0</event-index>");
    const second = String(events[1].message.content);
    expect(second).toContain("<line>b4</line>");
    expect(second).not.toContain("<line>b1</line>");
    expect(second).toContain("<event-index>1</event-index>");
  });

  test("expiry sends one notice with the event count and stops the process", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const result = await tools
      .get("Monitor")!
      .execute(
        "call-1",
        { command: "echo first; sleep 0.4; echo second; sleep 30", timeout_ms: 1200, description: "expiry probe" },
        undefined,
        undefined,
        toolCtx(),
      );
    const monitorId = String((result.details as Record<string, unknown>).monitor_id);
    await until(() => monitorNotices(pi.sent).length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    const notices = monitorNotices(pi.sent);
    expect(notices.length).toBe(1);
    const content = String(notices[0].message.content);
    expect(content).toContain("[monitor expired]");
    expect(content).toContain(monitorId);
    expect(content).toContain("2 events");
    expect(service.store.getMonitor(monitorId)?.status).toBe("expired");
    const pid = service.store.getMonitor(monitorId)?.pid;
    if (pid !== undefined) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  });

  test("a firehose is stopped with a notice", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const result = await tools
      .get("Monitor")!
      .execute("call-1", { command: "yes firehose-marker", timeout_ms: 30000, description: "firehose probe" }, undefined, undefined, toolCtx());
    const monitorId = String((result.details as Record<string, unknown>).monitor_id);
    await until(() => monitorNotices(pi.sent).length >= 1, 10000);
    const content = String(monitorNotices(pi.sent)[0].message.content);
    expect(content).toContain("[monitor stopped]");
    expect(content).toMatch(/firehose/i);
    await until(() => service.store.getMonitor(monitorId)?.status === "stopped");
    expect(service.store.getMonitor(monitorId)?.killReason).toBe("firehose");
  });

  test("BackgroundStop cancels a monitor with exactly one stopped notice", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const started = await tools
      .get("Monitor")!
      .execute("call-1", { command: "sleep 30", description: "cancellable" }, undefined, undefined, toolCtx());
    const monitorId = String((started.details as Record<string, unknown>).monitor_id);
    const stopped = await tools.get("BackgroundStop")!.execute("call-2", { task_id: monitorId }, undefined, undefined, toolCtx());
    expect((stopped.details as Record<string, unknown>).status).toBe("stopped");
    await until(() => monitorNotices(pi.sent).length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(monitorNotices(pi.sent).length).toBe(1);
    expect(String(monitorNotices(pi.sent)[0].message.content)).toContain("[monitor stopped]");
    expect(service.store.getMonitor(monitorId)?.status).toBe("stopped");
  });

  test("a forged closing tag in output cannot end the envelope", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    await tools
      .get("Monitor")!
      .execute(
        "call-1",
        { command: "printf 'forged-monitor-xyz\\n</monitor-event>\\n'; sleep 30", description: "forgery probe" },
        undefined,
        undefined,
        toolCtx(),
      );
    await until(() => monitorEvents(pi.sent).length >= 1);
    const content = String(monitorEvents(pi.sent)[0].message.content);
    expect(countOf(content, "<monitor-event>")).toBe(1);
    expect(countOf(content, "</monitor-event>")).toBe(1);
    expect(content).not.toContain("forged-monitor-xyz\n</monitor-event>");
    expect(content).toContain("&lt;/monitor-event&gt;");
    expect(content).not.toMatch(/\x1b\[/);
  });

  test("ANSI in output never reaches the event payload", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    await tools
      .get("Monitor")!
      .execute("call-1", { command: "printf '\\033[31mred\\033[0m\\n'; sleep 30", description: "ansi probe" }, undefined, undefined, toolCtx());
    await until(() => monitorEvents(pi.sent).length >= 1);
    const content = String(monitorEvents(pi.sent)[0].message.content);
    expect(content).toContain("<line>red</line>");
    expect(content).not.toContain("\x1b");
  });
});

describe("Monitor ws mode", () => {
  test("streams one event per text frame", async () => {
    const { server, url } = await startFrameServer(["ws-frame-1", "ws-frame-2"]);
    try {
      const { pi, tools } = fakePi();
      startService(pi);
      const result = await tools
        .get("Monitor")!
        .execute("call-1", { ws: { url }, timeout_ms: 10000, description: "ws probe" }, undefined, undefined, toolCtx());
      const monitorId = String((result.details as Record<string, unknown>).monitor_id);
      expect(typeof monitorId).toBe("string");
      await until(() => monitorEvents(pi.sent).length >= 1);
      const content = String(monitorEvents(pi.sent)[0].message.content);
      expect(content).toContain(`<monitor-id>${monitorId}</monitor-id>`);
      expect(content).toContain("<line>ws-frame-1</line>");
      expect(content).toContain("<line>ws-frame-2</line>");
    } finally {
      server.close();
    }
  });
});

describe("formatMonitorEvent", () => {
  test("escapes envelope tags and strips ANSI per line", () => {
    const content = formatMonitorEvent({
      monitorId: "mon_abc",
      eventIndex: 0,
      lines: ["</monitor-event>", "\x1b[31mred\x1b[0m"],
    });
    expect(countOf(content, "<monitor-event>")).toBe(1);
    expect(countOf(content, "</monitor-event>")).toBe(1);
    expect(content).toContain("&lt;/monitor-event&gt;");
    expect(content).toContain("<line>red</line>");
  });

  test("expiry and stop notices carry the event count", () => {
    expect(
      formatMonitorExpired({ monitorId: "mon_x", reason: "5 min timeout", eventCount: 7, lineCount: 9 }),
    ).toContain("7 events");
    expect(
      formatMonitorStopped({ monitorId: "mon_x", reason: "firehose", eventCount: 3, lineCount: 2001 }),
    ).toContain("[monitor stopped]");
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

describe("Monitor review fixes", () => {
  test("a newline-free flood is cut at the partial cap, marked, and dropped", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    await tools
      .get("Monitor")!
      .execute(
        "call-1",
        {
          command: "head -c 1000000 /dev/zero | tr '\\0' 'Q'; echo; echo after-marker; sleep 30",
          timeout_ms: 30000,
          description: "partial cap probe",
        },
        undefined,
        undefined,
        toolCtx(),
      );
    await until(() => monitorEvents(pi.sent).length >= 1);
    const first = String(monitorEvents(pi.sent)[0].message.content);
    expect(first).toContain("QQQ");
    expect(first).toMatch(/truncated/);
    // The 1 MB line must not reach the payload whole: bounded, not buffered.
    expect(first.length).toBeLessThan(50_000);
    await until(() => monitorEvents(pi.sent).some((s) => String(s.message.content).includes("after-marker")));
    const combined = monitorEvents(pi.sent).map((s) => String(s.message.content)).join("\n");
    expect(combined).toContain("truncated");
    expect(combined).toContain("after-marker");
    expect(service.store.listMonitors()[0]?.status).toBe("event");
  });

  test("stop-then-quit leaves no orphan: a TERM-trapping monitor tree dies on close", async () => {
    const { pi, tools } = fakePi();
    // A long grace separates the implementations: the old code relied on a
    // SIGKILL timer that a quit inside the window never lets fire.
    const service = startService(pi, { killGraceMs: 2000 });
    const grandchildFile = `${dir}/mon-grandchild.pid`;
    const started = await tools
      .get("Monitor")!
      .execute(
        "call-1",
        { command: `trap "" TERM; sleep 60 & echo $! > ${grandchildFile}; wait`, description: "quit-window probe" },
        undefined,
        undefined,
        toolCtx(),
      );
    const monitorId = String((started.details as Record<string, unknown>).monitor_id);
    await until(() => {
      try {
        return readFileSync(grandchildFile, "utf8").trim().length > 0;
      } catch {
        return false;
      }
    });
    const pid = service.store.getMonitor(monitorId)?.pid;
    expect(pid).toBeGreaterThan(0);
    const grandchildPid = Number(readFileSync(grandchildFile, "utf8").trim());
    expect(grandchildPid).toBeGreaterThan(0);
    // Stop, then quit inside the SIGKILL grace window. B3 follow-up 7:
    // close() never blocks for the grace — it returns at once with the
    // record stopped, and the unref'd sweep SIGKILLs the group later.
    await tools.get("BackgroundStop")!.execute("call-2", { task_id: monitorId }, undefined, undefined, toolCtx());
    const startedAt = Date.now();
    service.close();
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(service.store.getMonitor(monitorId)?.status).toBe("stopped");
    // After the 2 s grace the whole TERM-trapping tree is dead, no orphan.
    await until(() => procGone(pid as number) && procGone(grandchildPid), 10000);
    expect(procGone(pid as number)).toBe(true);
    expect(procGone(grandchildPid)).toBe(true);
  });

  test("BackgroundStop flushes waiting lines before the terminal notice", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const started = await tools
      .get("Monitor")!
      .execute("call-1", { command: "printf 'f1\\nf2\\n'; sleep 30", description: "flush probe" }, undefined, undefined, toolCtx());
    const monitorId = String((started.details as Record<string, unknown>).monitor_id);
    // Both lines arrive in one chunk; stop inside the batch window (and even
    // if the batch fires first, the end state is identical).
    await until(() => (service.store.getMonitor(monitorId)?.lineCount ?? 0) >= 2);
    await tools.get("BackgroundStop")!.execute("call-2", { task_id: monitorId }, undefined, undefined, toolCtx());
    await until(() => monitorNotices(pi.sent).length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    const events = monitorEvents(pi.sent);
    expect(events.length).toBe(1);
    expect(String(events[0].message.content)).toContain("<line>f1</line>");
    expect(String(events[0].message.content)).toContain("<line>f2</line>");
    expect(monitorNotices(pi.sent).length).toBe(1);
    const notice = String(monitorNotices(pi.sent)[0].message.content);
    expect(notice).toContain("[monitor stopped]");
    expect(notice).toContain("1 events");
    expect(notice).toContain("2 lines");
  });

  test("a slow tail survives past the old lifetime cap; only bursts trip the firehose", { timeout: 40000 }, async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const result = await tools
      .get("Monitor")!
      .execute(
        "call-1",
        { command: "for i in $(seq 1 2100); do echo slow-line-$i; sleep 0.003; done; sleep 30", timeout_ms: 60000, description: "slow tail probe" },
        undefined,
        undefined,
        toolCtx(),
      );
    const monitorId = String((result.details as Record<string, unknown>).monitor_id);
    await until(() => (service.store.getMonitor(monitorId)?.lineCount ?? 0) > 2000, 30000);
    // Past the old 2000-line lifetime cap and still running: rate, not total.
    expect(monitorNotices(pi.sent).length).toBe(0);
    expect(["armed", "event"]).toContain(service.store.getMonitor(monitorId)?.status);
    await tools.get("BackgroundStop")!.execute("call-2", { task_id: monitorId }, undefined, undefined, toolCtx());
    await until(() => monitorNotices(pi.sent).length >= 1);
  });

  test("wakes go out at most every 200 ms while batching continues", async () => {
    const times: number[] = [];
    const { pi, tools } = fakePi();
    const origSend = pi.sendMessage.bind(pi);
    pi.sendMessage = (message: Record<string, unknown>, options: Record<string, unknown>) => {
      times.push(Date.now());
      origSend(message, options);
    };
    startService(pi);
    await tools
      .get("Monitor")!
      .execute("call-1", { command: "seq 1 250; sleep 30", timeout_ms: 30000, description: "wake interval probe" }, undefined, undefined, toolCtx());
    await until(() => monitorEvents(pi.sent).length >= 3, 10000);
    const eventTimes = monitorEvents(pi.sent).map((_, i) => times[i]);
    expect(eventTimes.length).toBeGreaterThanOrEqual(3);
    expect(eventTimes[1] - eventTimes[0]).toBeGreaterThanOrEqual(150);
    expect(eventTimes[2] - eventTimes[1]).toBeGreaterThanOrEqual(150);
    // Lossless across wakes (N2): the 250-line burst arrives as 100 + 100 +
    // 50 with no drop trailer; only the rate firehose stop discards.
    const counts = monitorEvents(pi.sent).map((s) => (String(s.message.content).match(/<line>/g) ?? []).length);
    expect(counts).toEqual([100, 100, 50]);
    expect(monitorEvents(pi.sent).map((s) => String(s.message.content)).join("\n")).not.toContain("[+");
  });

  test("an exit within 200 ms of a wake still delivers every line (N1)", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const result = await tools
      .get("Monitor")!
      .execute(
        "call-1",
        { command: "echo n1-a; sleep 0.25; echo n1-b; sleep 0.05", timeout_ms: 30000, description: "exit race probe" },
        undefined,
        undefined,
        toolCtx(),
      );
    const monitorId = String((result.details as Record<string, unknown>).monitor_id);
    await until(() => monitorNotices(pi.sent).length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    const combined = monitorEvents(pi.sent).map((s) => String(s.message.content)).join("\n");
    expect(combined).toContain("<line>n1-a</line>");
    expect(combined).toContain("<line>n1-b</line>");
    expect(monitorNotices(pi.sent).length).toBe(1);
    const notice = String(monitorNotices(pi.sent)[0].message.content);
    expect(notice).toContain("2 events");
    expect(notice).toContain("2 lines");
    expect(service.store.getMonitor(monitorId)?.status).toBe("stopped");
  });

  test("a BackgroundStop within 200 ms of a wake still delivers every line (N1)", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const started = await tools
      .get("Monitor")!
      .execute(
        "call-1",
        { command: "echo n2-a; sleep 0.25; echo n2-b; sleep 30", timeout_ms: 30000, description: "stop race probe" },
        undefined,
        undefined,
        toolCtx(),
      );
    const monitorId = String((started.details as Record<string, unknown>).monitor_id);
    // Stop right after both lines arrived: the first wake is ~60 ms old,
    // inside the minimum interval, so only a forced finalize flush keeps b.
    await until(() => (service.store.getMonitor(monitorId)?.lineCount ?? 0) >= 2);
    await tools.get("BackgroundStop")!.execute("call-2", { task_id: monitorId }, undefined, undefined, toolCtx());
    await until(() => monitorNotices(pi.sent).length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    const combined = monitorEvents(pi.sent).map((s) => String(s.message.content)).join("\n");
    expect(combined).toContain("<line>n2-a</line>");
    expect(combined).toContain("<line>n2-b</line>");
    expect(monitorNotices(pi.sent).length).toBe(1);
    const notice = String(monitorNotices(pi.sent)[0].message.content);
    expect(notice).toContain("2 events");
    expect(notice).toContain("2 lines");
  });

  test("stderr reaches the output file but never becomes an event", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    const result = await tools
      .get("Monitor")!
      .execute(
        "call-1",
        { command: "echo out-line; echo err-line >&2; sleep 30", timeout_ms: 30000, description: "stderr probe" },
        undefined,
        undefined,
        toolCtx(),
      );
    const outputFile = String((result.details as Record<string, unknown>).output_file);
    await until(() => monitorEvents(pi.sent).length >= 1);
    await new Promise((r) => setTimeout(r, 400));
    const combined = monitorEvents(pi.sent).map((s) => String(s.message.content)).join("\n");
    expect(combined).toContain("out-line");
    expect(combined).not.toContain("err-line");
    const body = readFileSync(outputFile, "utf8");
    expect(body).toContain("out-line");
    expect(body).toContain("err-line");
  });
});

describe("Monitor item 6 and 8 (N3)", () => {
  test("a ws frame write respects the output-file ceiling", async () => {
    const big = `frame-${"F".repeat(500)}`;
    const { server, url } = await startFrameServer([big]);
    try {
      const { pi, tools } = fakePi();
      startService(pi, { outputMaxBytes: 64 });
      const result = await tools
        .get("Monitor")!
        .execute("call-1", { ws: { url }, timeout_ms: 10000, description: "ws ceiling probe" }, undefined, undefined, toolCtx());
      const outputFile = String((result.details as Record<string, unknown>).output_file);
      await until(() => monitorEvents(pi.sent).length >= 1);
      const body = readFileSync(outputFile, "utf8");
      expect(body).toContain("[background: output truncated at 64 bytes]");
      expect(body.length).toBeLessThan(256);
    } finally {
      server.close();
    }
  });

  test("a socket creation failure ends stopped with no wake and no later expiry", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi, {
      createWebSocket: () => {
        throw new Error("connection refused by probe");
      },
    });
    let error: unknown;
    try {
      await tools
        .get("Monitor")!
        .execute(
          "call-1",
          { ws: { url: "wss://example.invalid/events" }, timeout_ms: 150, description: "ws failure probe" },
          undefined,
          undefined,
          toolCtx(),
        );
    } catch (e) {
      error = e;
    }
    expect(String(error)).toMatch(/connection refused by probe/);
    expect(service.store.listMonitors()[0]?.status).toBe("stopped");
    // Past the 150 ms expiry: no expiry timer survived setup to wake anyone.
    await new Promise((r) => setTimeout(r, 400));
    expect(pi.sent).toEqual([]);
  });

  test("an exit by signal names the signal, not (exit code null)", async () => {
    const { pi, tools } = fakePi();
    startService(pi);
    await tools
      .get("Monitor")!
      .execute("call-1", { command: "kill -TERM $$", timeout_ms: 10000, description: "signal probe" }, undefined, undefined, toolCtx());
    await until(() => monitorNotices(pi.sent).length >= 1);
    const notice = String(monitorNotices(pi.sent)[0].message.content);
    expect(notice).toContain("[monitor stopped]");
    expect(notice).toContain("(signal SIGTERM)");
    expect(notice).not.toContain("(exit code null)");
  });
});

describe("Monitor terminal drain", () => {
  test("250 lines pending at BackgroundStop drain as 100, 100 and 50 before the notice, then silence", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const started = await tools
      .get("Monitor")!
      .execute("call-1", { command: "seq 1 250; sleep 30", timeout_ms: 30000, description: "drain probe" }, undefined, undefined, toolCtx());
    const monitorId = String((started.details as Record<string, unknown>).monitor_id);
    // Stop while all 250 lines are still waiting for the batch window.
    await until(() => (service.store.getMonitor(monitorId)?.lineCount ?? 0) >= 250);
    await tools.get("BackgroundStop")!.execute("call-2", { task_id: monitorId }, undefined, undefined, toolCtx());
    await until(() => monitorNotices(pi.sent).length >= 1);
    const events = monitorEvents(pi.sent);
    expect(events.map((s) => (String(s.message.content).match(/<line>/g) ?? []).length)).toEqual([100, 100, 50]);
    expect(monitorNotices(pi.sent).length).toBe(1);
    expect(String(monitorNotices(pi.sent)[0].message.content)).toContain("3 events");
    // No re-armed timer may flush after the notice: silence afterwards.
    const sentAfterNotice = pi.sent.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(pi.sent.length).toBe(sentAfterNotice);
    expect(service.store.getMonitor(monitorId)?.status).toBe("stopped");
  });

  test("wake counts are exact: per-wake lines sum to the drain, indexes are gap-free, notice matches the store", async () => {
    const { pi, tools } = fakePi();
    const service = startService(pi);
    const started = await tools
      .get("Monitor")!
      .execute("call-1", { command: "seq 1 250; sleep 30", timeout_ms: 30000, description: "count probe" }, undefined, undefined, toolCtx());
    const monitorId = String((started.details as Record<string, unknown>).monitor_id);
    await until(() => (service.store.getMonitor(monitorId)?.lineCount ?? 0) >= 250);
    await tools.get("BackgroundStop")!.execute("call-2", { task_id: monitorId }, undefined, undefined, toolCtx());
    await until(() => monitorNotices(pi.sent).length >= 1);
    const events = monitorEvents(pi.sent);
    // What each wake declared equals what it actually delivered.
    const declared = events.map((event) => Number((event.message.details as Record<string, unknown>).line_count));
    const delivered = events.map((event) => (String(event.message.content).match(/<line>/g) ?? []).length);
    expect(declared).toEqual(delivered);
    expect(delivered.reduce((sum, count) => sum + count, 0)).toBe(250);
    // Event indexes are the envelope's own 0-based sequence, gap-free.
    const indexes = events.map((event) => Number((event.message.details as Record<string, unknown>).event_index));
    expect(indexes).toEqual(indexes.map((_, index) => index));
    // The terminal notice reports the record totals, not a batch.
    const notice = monitorNotices(pi.sent)[0].message.details as Record<string, unknown>;
    expect(notice.event_count).toBe(events.length);
    expect(notice.line_count).toBe(250);
    expect(notice.elapsed).toMatch(/^\d/);
    expect(service.store.getMonitor(monitorId)?.eventCount).toBe(events.length);
    expect(service.store.getMonitor(monitorId)?.lineCount).toBe(250);
  });
});
