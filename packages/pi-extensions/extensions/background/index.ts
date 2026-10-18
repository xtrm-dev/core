/**
 * Background runs and monitors for Pi (B1 CORE-2439, B2 CORE-2440) with the
 * B3 operator surface (CORE-2441): /bg (./commands.ts), the one-line
 * indicator above the prompt (./widget.ts), task and monitor cards through
 * the I7 shared event module (./cards.ts), and the off switch
 * (background.enabled=false or BACKGROUND_TASKS=off).
 *
 * Model tools: BashBackground{command, description, timeout} starts one shell
 * command without blocking and returns at once with a task id and an output
 * file path; Monitor{command | ws{url, protocols}, description, timeout_ms}
 * streams one event per stdout line (or WebSocket text frame) until the
 * command exits or the monitor expires; BackgroundStop{task_id} stops either one.
 * On exit exactly one <task-notification> wakes the owning session through
 * pi.sendMessage with {triggerTurn: true, deliverAs: "followUp"} (D6); each
 * monitor batch wakes it with one <monitor-event>. The model reads output
 * files with read. Prompt guidance keeps the rule: do not poll, end the turn,
 * the notification wakes you.
 *
 * On Pi, use BashBackground where Claude Code uses Bash with
 * run_in_background. Defaults follow Claude Code: background runs 30 min, at
 * most 2 h; monitors 5 min, at most 30 min, lines within 200 ms batched into
 * one event, one expiry notice with the event count, a firehose stopped with
 * a notice.
 *
 * Lineage: the start/output-file/single-completion method is informed by
 * `pi-background-tasks` (ADOPTION-CREDITS.md: background-process UX subset
 * only). The message id and the wake delivery vocabulary come from the I1
 * wake contract in @xtrm/contracts. Nothing else is carried over: no
 * bg_status, bg_logs, attestation, fusion_*, bg_delegate or provider override.
 * Method and envelope parity with Claude Code; clean reimplementation
 * otherwise.
 */

import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stableWakeMessageId, type WakeDeliveryState } from "@xtrm/contracts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";

import {
  createBackgroundStore,
  formatElapsed,
  formatMonitorEvent,
  formatMonitorExpired,
  formatMonitorStopped,
  formatTaskNotification,
  MONITOR_EVENT_TYPE,
  MONITOR_STATES,
  sanitizeModelText,
  TASK_NOTIFICATION_TYPE,
  TASK_STATES,
  type BackgroundMonitorRecord,
  type BackgroundStore,
  type BackgroundTaskRecord,
  type MonitorKillReason,
  type TaskStatus,
} from "./store.ts";
import { registerBackgroundCards } from "./cards.ts";
import { readOutput, registerTasksCommand, type OutputView } from "./commands.ts";
import { createBackgroundWidget, type BackgroundWidgetUi } from "./widget.ts";

export {
  TASK_STATES,
  MONITOR_STATES,
  TASK_NOTIFICATION_TYPE,
  MONITOR_EVENT_TYPE,
  formatTaskNotification,
  formatMonitorEvent,
  formatMonitorExpired,
  formatMonitorStopped,
  sanitizeModelText,
};
export { createBackgroundStore };
export type { BackgroundStore, BackgroundTaskRecord, BackgroundMonitorRecord, MonitorKillReason, TaskStatus };

/** Log prefix. Bare name: no xtrm- slug. */
export const LOG_PREFIX = "[background]";

/** Environment gate for the off switch (operators without settings access). */
export const BACKGROUND_TASKS_ENV = "BACKGROUND_TASKS";

/** Claude Code background default: 30 min. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Claude Code background maximum: 2 h. Values above fail loudly. */
export const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Claude Code monitor default: 5 min. */
export const MONITOR_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Claude Code monitor maximum: 30 min. Values above fail loudly. */
export const MONITOR_MAX_TIMEOUT_MS = 30 * 60 * 1000;
/** Lines arriving within this window batch into one monitor event. */
export const MONITOR_BATCH_WINDOW_MS = 200;
/** Wakes go out at most this often; a full batch waits for the interval. */
export const MONITOR_MIN_WAKE_INTERVAL_MS = 200;
/** A batch flushes early once it holds this many lines. */
export const MONITOR_MAX_EVENT_LINES = 100;
/** One monitor event carries at most this many sanitized characters. */
export const MONITOR_MAX_EVENT_CHARS = 8000;
/** A command-mode line buffered past this without a newline is emitted
 * truncated and the rest dropped until the next newline (unbounded partial
 * lines stalled the event loop). */
export const MONITOR_PARTIAL_MAX_CHARS = 16 * 1024;
/** Firehose trip: more than this many lines in any rolling window. A steady
 * tail never trips it; only a burst does (lifetime caps killed healthy tails). */
export const MONITOR_FIREHOSE_WINDOW_MS = 10_000;
export const MONITOR_FIREHOSE_MAX_LINES = 5000;
/** Ceiling for one task output file; writing stops here with one truncation line. */
export const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** Grace between SIGTERM and SIGKILL for stop, timeout and shutdown kills. */
const DEFAULT_KILL_GRACE_MS = 2000;

const BashBackgroundParams = Type.Object({
  command: Type.String({ minLength: 1, description: "Shell command to run in the background" }),
  description: Type.Optional(
    Type.String({ description: "Short human-readable description of the task" }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Timeout in milliseconds (default 30 min, maximum 2 h). The task ends with status timed_out.",
    }),
  ),
});

const BackgroundStopParams = Type.Object({
  task_id: Type.String({ minLength: 1, description: "Background task or monitor id to stop" }),
});

const MonitorParams = Type.Object({
  command: Type.Optional(
    Type.String({ minLength: 1, description: "Shell command whose stdout lines are streamed as events" }),
  ),
  ws: Type.Optional(
    Type.Object({
      url: Type.String({ minLength: 1, description: "WebSocket URL whose text frames are streamed as events" }),
      protocols: Type.Optional(Type.Array(Type.String(), { description: "WebSocket subprotocols" })),
    }),
  ),
  description: Type.Optional(
    Type.String({ description: "Short human-readable description of the monitor" }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        "Timeout in milliseconds (default 5 min, maximum 30 min). The monitor expires with one notice and the event count.",
    }),
  ),
});

type MonitorArgs = Static<typeof MonitorParams>;

type BashBackgroundArgs = Static<typeof BashBackgroundParams>;
type BackgroundStopArgs = Static<typeof BackgroundStopParams>;

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function killTreeForce(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Process groups that must die on process exit (F2b, N4). close() moves
 * every live, monitored and reaping child here; the unref'd sweep SIGKILLs
 * them after the grace on reload, and the synchronous exit hook below
 * covers a quit (process.kill is synchronous and works in exit handlers;
 * no timers or async work may run there). Both the victim set and the
 * installed flag live on globalThis under well-known symbols: module
 * re-evaluation must neither lose tracked children nor leak one exit
 * listener per evaluation. Bare key names: no xtrm- slug.
 */
const EXIT_HOOK_INSTALLED = Symbol.for("background.exitHookInstalled");
const EXIT_HOOK_VICTIMS = Symbol.for("background.exitHookVictims");

type ExitHookGlobal = Record<symbol, Set<ChildProcess> | boolean | undefined>;

function exitVictimSet(): Set<ChildProcess> {
  const g = globalThis as unknown as ExitHookGlobal;
  let set = g[EXIT_HOOK_VICTIMS] as Set<ChildProcess> | undefined;
  if (!set) {
    set = new Set<ChildProcess>();
    g[EXIT_HOOK_VICTIMS] = set;
  }
  return set;
}

export function installExitHook(): void {
  const g = globalThis as unknown as ExitHookGlobal;
  if (g[EXIT_HOOK_INSTALLED]) return;
  g[EXIT_HOOK_INSTALLED] = true;
  process.on("exit", () => {
    for (const child of exitVictimSet()) {
      try {
        killTreeForce(child);
      } catch {
        /* already gone; exit handlers must never throw */
      }
    }
  });
}

function shellForPlatform(): true | string {
  return process.platform === "win32" ? true : "/bin/sh";
}

/** Minimal WebSocket surface a monitor needs (the global WebSocket satisfies it). */
export interface MonitorSocket {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export type MonitorSocketFactory = (url: string, protocols?: string[]) => MonitorSocket;

export interface BackgroundServiceOptions {
  outputDir?: string;
  killGraceMs?: number;
  outputMaxBytes?: number;
  makeId?: () => string;
  now?: () => number;
  /** Override the WebSocket constructor (tests inject a fake or a local server URL works as-is). */
  createWebSocket?: MonitorSocketFactory;
  /** Force the extension on/off, winning over env and settings (tests). */
  enabled?: boolean;
}

export interface BackgroundService {
  store: BackgroundStore;
  runBackground(args: BashBackgroundArgs, ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string } }): Promise<Record<string, unknown>>;
  runMonitor(args: MonitorArgs, ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string } }): Promise<Record<string, unknown>>;
  stopTask(taskId: string): Promise<Record<string, unknown>>;
  rerunTask(taskId: string): Promise<Record<string, unknown>>;
  close(): void;
}

/**
 * Whether the background extension starts. Precedence: explicit option,
 * then BACKGROUND_TASKS env, then the `background.enabled` settings key,
 * then the same key read straight from the settings files; default true.
 * (The file fallback exists because pi.getSettings() is not populated with
 * the operator's keys at extension-registration time — CORE-2456 — while the
 * env and the files are process-immediate. Project settings win over global
 * ones. The Claude Code analogue is CLAUDE_CODE_DISABLE_BACKGROUND_TASKS.)
 * Off registers nothing: no tools, no /bg, no widget, no renderers.
 */
export function isBackgroundEnabled(pi: ExtensionAPI, options: BackgroundServiceOptions = {}): boolean {
  if (options.enabled !== undefined) return options.enabled;
  const env = process.env[BACKGROUND_TASKS_ENV];
  if (env !== undefined) {
    if (/^(1|true|on|yes)$/i.test(env.trim())) return true;
    if (/^(0|false|off|no)$/i.test(env.trim())) return false;
  }
  try {
    const settings = pi.getSettings?.() as Record<string, unknown> | undefined;
    const background = settings?.background as Record<string, unknown> | undefined;
    if (typeof background?.enabled === "boolean") return background.enabled;
  } catch {
    /* unreadable settings are not a signal; the file fallback below still runs */
  }
  const fromFiles = readEnabledFromSettingsFiles();
  if (fromFiles !== undefined) return fromFiles;
  return true;
}

/** `background.enabled` from the settings files: project first, then global. */
export function readEnabledFromSettingsFiles(cwd: string = process.cwd(), home: string = os.homedir()): boolean | undefined {
  const agentDir = process.env.PI_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
  for (const file of [path.join(cwd, ".pi", "settings.json"), path.join(agentDir, "settings.json")]) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const background = parsed?.background as Record<string, unknown> | undefined;
      if (typeof background?.enabled === "boolean") return background.enabled;
    } catch {
      /* a broken file is not a disable signal; keep looking */
    }
  }
  return undefined;
}

interface LiveHandle {
  child: ChildProcess;
  fd: number;
  written: number;
  truncated: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
}

interface LiveMonitor {
  child: ChildProcess | undefined;
  socket: MonitorSocket | undefined;
  decoder: StringDecoder;
  partial: string;
  /** True while dropping an overlong line until its newline arrives. */
  dropping: boolean;
  buffer: string[];
  /** Observed-line timestamps for the rolling firehose window. */
  lineTimes: number[];
  lastWakeAt: number | undefined;
  fd: number;
  written: number;
  truncated: boolean;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
  batchTimer: ReturnType<typeof setTimeout> | undefined;
  wakeBroken: boolean;
}

export function registerBackgroundExtension(pi: ExtensionAPI, options: BackgroundServiceOptions = {}): BackgroundService {
  const store = createBackgroundStore({ now: options.now ?? Date.now, makeId: options.makeId, outputDir: options.outputDir ?? "" });
  if (!isBackgroundEnabled(pi, options)) {
    const disabled = `${LOG_PREFIX} background extension is disabled (background.enabled=false or BACKGROUND_TASKS=off).`;
    const refuse = async (): Promise<Record<string, unknown>> => {
      throw new Error(disabled);
    };
    return { store, runBackground: refuse, runMonitor: refuse, stopTask: refuse, rerunTask: refuse, close: () => {} };
  }
  installExitHook();
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const outputMaxBytes = options.outputMaxBytes ?? OUTPUT_MAX_BYTES;
  const now = options.now ?? Date.now;
  const live = new Map<string, LiveHandle>();
  const monitors = new Map<string, LiveMonitor>();
  /**
   * Children terminated (stop/expiry/firehose/wake-broken) but not yet dead:
   * their SIGKILL grace timer is pending and no live map owns them anymore.
   * close() force-kills everything here, so a quit inside the grace window
   * cannot orphan a TERM-trapping tree.
   */
  const reaping = new Map<ChildProcess, ReturnType<typeof setTimeout>>();
  const sessionDirs = new Map<string, string>();
  let disposed = false;
  const createSocket: MonitorSocketFactory =
    options.createWebSocket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as MonitorSocket);

  function truncationLine(): string {
    return `\n[background: output truncated at ${outputMaxBytes} bytes]\n`;
  }

  /** Per-session output directory, mode 0700. Tests pass outputDir and skip this. */
  function runDir(sessionId: string): string {
    if (options.outputDir) {
      mkdirSync(options.outputDir, { recursive: true });
      return options.outputDir;
    }
    const cached = sessionDirs.get(sessionId);
    if (cached) return cached;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const dir = path.join(os.tmpdir(), `background-${sessionId}-${randomBytes(4).toString("hex")}`);
      try {
        mkdirSync(dir, { mode: 0o700 });
        sessionDirs.set(sessionId, dir);
        return dir;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error(`${LOG_PREFIX} could not create a session output directory.`);
  }

  /**
   * Open the task output file 0600 with O_EXCL: an existing path (including a
   * planted symlink) fails loudly instead of being followed or truncated.
   */
  function openOutputFile(dir: string, prefix: string, id: string): number {
    return openSync(path.join(dir, `${prefix}-${id}.log`), "wx", 0o600);
  }

  function writeChunk(handle: { fd: number; written: number; truncated: boolean }, chunk: Buffer): void {
    if (handle.truncated) return;
    const room = outputMaxBytes - handle.written;
    if (room <= 0) {
      try {
        writeSync(handle.fd, truncationLine());
      } catch {
        /* output file unavailable; the notification still carries the status */
      }
      handle.truncated = true;
      return;
    }
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    try {
      writeSync(handle.fd, slice);
    } catch {
      handle.truncated = true;
      return;
    }
    handle.written += slice.length;
    if (chunk.length > room) {
      try {
        writeSync(handle.fd, truncationLine());
      } catch {
        /* output file unavailable; the notification still carries the status */
      }
      handle.truncated = true;
    }
  }

  function closeFd(handle: { fd: number }): void {
    try {
      closeSync(handle.fd);
    } catch {
      /* already closed */
    }
  }

  function sessionIdOf(ctx?: { sessionManager?: { getSessionId?: () => string } }): string {
    try {
      return ctx?.sessionManager?.getSessionId?.() ?? "session";
    } catch {
      return "session";
    }
  }

  /**
   * Own a terminated child until it is dead: SIGTERM now, SIGKILL after the
   * grace. The child stays in the reaping set so close() can force-kill it
   * even when no live map owns it anymore. Reaped children join the exit
   * victims so a quit inside the grace window still kills them (F2b).
   */
  function reapLater(child: ChildProcess): void {
    if (reaping.has(child)) return;
    exitVictimSet().add(child);
    killTree(child);
    const timer = setTimeout(() => {
      reaping.delete(child);
      exitVictimSet().delete(child);
      try {
        killTreeForce(child);
      } catch {
        /* already gone */
      }
    }, killGraceMs);
    // A reaped child must never hold the loop open on its own.
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* runtimes without unref */
    }
    reaping.set(child, timer);
  }

  function summaryFor(record: BackgroundTaskRecord): string {
    const exit = record.exitCode === null ? "(no exit code)" : `(exit code ${record.exitCode})`;
    return `Background command "${sanitizeModelText(record.description)}" ${record.status} ${exit}`;
  }

  function notify(record: BackgroundTaskRecord): void {
    if (record.notified || disposed) return;
    record.notified = true;
    const summary = summaryFor(record);
    const content = formatTaskNotification({
      taskId: record.id,
      status: record.status,
      summary,
      outputFile: record.outputFile,
      exitCode: record.exitCode,
    });
    const details = {
      task_id: record.id,
      status: record.status,
      summary,
      output_file: record.outputFile,
      elapsed: formatElapsed((record.endedAt ?? now()) - record.startedAt),
      message_id: record.messageId,
      exit_code: record.exitCode,
      delivery: "delivered" as WakeDeliveryState,
    };
    try {
      // Busy-versus-idle is owned by the runtime: deliverAs followUp queues
      // behind a streaming turn, triggerTurn wakes an idle session. The
      // extension pins exactly these options (see delivery.test.ts).
      (pi as { sendMessage: (message: unknown, options: unknown) => void }).sendMessage(
        { customType: TASK_NOTIFICATION_TYPE, content, display: true, details },
        { deliverAs: "followUp", triggerTurn: true },
      );
      record.delivery = "delivered";
    } catch (error) {
      // One loud line, then the wake is recorded as undelivered: the session
      // is gone, and a second injection attempt would only add noise.
      record.delivery = "undelivered";
      console.error(
        `${LOG_PREFIX} task_notification for ${record.id} undelivered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    store.changed("task", record.id);
  }

  function finalize(record: BackgroundTaskRecord, status: TaskStatus, exitCode: number | null): void {
    if (record.status !== "running") return;
    record.status = status;
    record.exitCode = exitCode;
    record.endedAt = now();
    record.pid = undefined;
    // F2a: a fresh terminal state is never already seen. A failure that
    // lands after the operator looked still pins the indicator.
    record.seen = false;
    const handle = live.get(record.id);
    live.delete(record.id);
    if (handle) {
      if (handle.timer !== undefined) clearTimeout(handle.timer);
      if (handle.graceTimer !== undefined) clearTimeout(handle.graceTimer);
      closeFd(handle);
    }
    notify(record);
  }

  function settleFromExit(record: BackgroundTaskRecord, code: number | null): void {
    if (record.killReason === "stop") finalize(record, "stopped", code);
    else if (record.killReason === "timeout") finalize(record, "timed_out", code);
    else if (code === 0) finalize(record, "completed", code);
    else finalize(record, "failed", code);
  }

  function armGraceKill(record: BackgroundTaskRecord, child: ChildProcess): void {
    const handle = live.get(record.id);
    if (!handle) return;
    if (handle.graceTimer !== undefined) clearTimeout(handle.graceTimer);
    handle.graceTimer = setTimeout(() => {
      if (record.status !== "running") return;
      killTreeForce(child);
      handle.graceTimer = setTimeout(() => {
        if (record.status !== "running") return;
        settleFromExit(record, record.exitCode);
      }, killGraceMs);
    }, killGraceMs);
  }

  async function runBackground(
    args: BashBackgroundArgs,
    ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
  ): Promise<Record<string, unknown>> {
    const command = args.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error(`${LOG_PREFIX} BashBackground requires a non-empty command.`);
    }
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (args.timeout !== undefined) {
      if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
        throw new Error(`${LOG_PREFIX} timeout must be a positive number of milliseconds.`);
      }
      if (args.timeout > MAX_TIMEOUT_MS) {
        throw new Error(
          `${LOG_PREFIX} timeout ${args.timeout}ms exceeds the 2 h maximum (${MAX_TIMEOUT_MS}ms).`,
        );
      }
      timeoutMs = args.timeout;
    }
    if (disposed) throw new Error(`${LOG_PREFIX} background extension is disposed.`);
    const sessionId = sessionIdOf(ctx);
    const description = args.description?.trim() ? args.description.trim() : command.length > 90 ? `${command.slice(0, 90)}...` : command;
    const dir = runDir(sessionId);
    const record = store.create(command, description, "", sessionId);
    record.messageId = stableWakeMessageId(sessionId, record.id);
    store.changed("task", record.id);

    let fd: number;
    try {
      fd = openOutputFile(dir, "background", record.id);
    } catch (error) {
      record.status = "failed";
      record.endedAt = now();
      throw new Error(
        `${LOG_PREFIX} could not open output file for ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const outputFile = path.join(dir, `background-${record.id}.log`);
    record.outputFile = outputFile;

    const cwd = ctx?.cwd && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    const handle: LiveHandle = { child: undefined as never, fd, written: 0, truncated: false, timer: undefined, graceTimer: undefined };
    let child: ChildProcess;
    try {
      // Intentional: BashBackground IS a shell-execution tool (Claude Code Bash
      // parity). The command comes from the model tool call under Pi's normal
      // tool approval, output is bounded to the task file, and the child is
      // process-group scoped so stop/timeout kill the whole tree.
      child = spawn(command, { // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
        cwd,
        shell: shellForPlatform(),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      // Single report: the throw below is the report; no wake follows.
      closeFd(handle);
      record.status = "failed";
      record.endedAt = now();
      throw error;
    }
    handle.child = child;
    record.pid = child.pid;
    record.cwd = cwd;
    record.timeoutMs = timeoutMs;
    exitVictimSet().add(child);
    child.stdout?.on("data", (chunk: Buffer) => writeChunk(handle, chunk));
    child.stderr?.on("data", (chunk: Buffer) => writeChunk(handle, chunk));
    try {
      child.unref();
    } catch {
      /* keep running without holding the loop when supported */
    }

    const timer = setTimeout(() => {
      if (record.status !== "running") return;
      const current = live.get(record.id);
      if (current && current.child.exitCode !== null && current.child.exitCode !== undefined) {
        settleFromExit(record, current.child.exitCode);
        return;
      }
      record.killReason = "timeout";
      killTree(child);
      armGraceKill(record, child);
    }, timeoutMs);
    handle.timer = timer;
    live.set(record.id, handle);

    child.on("error", (error: Error) => {
      // Single report: the wake below is the report; nothing is thrown.
      try {
        writeSync(fd, `Failed to start: ${error.message}\n`);
      } catch {
        /* output file unavailable; the notification still carries the status */
      }
      settleFromExit(record, null);
    });
    child.on("close", (code: number | null) => {
      exitVictimSet().delete(child);
      settleFromExit(record, code);
    });

    const message =
      `Started background task ${record.id}.\n` +
      `Command: ${command}\n` +
      `Output file: ${outputFile}\n` +
      `Do not poll; end the turn. The notification wakes you when the task exits.`;
    return textResult(message, {
      task_id: record.id,
      output_file: outputFile,
      status: "running",
      message_id: record.messageId,
    }) as Record<string, unknown>;
  }

  function isMonitorTerminal(record: BackgroundMonitorRecord): boolean {
    return record.status === "expired" || record.status === "stopped";
  }

  function sendMonitorWake(
    record: BackgroundMonitorRecord,
    content: string,
    details: Record<string, unknown>,
  ): boolean {
    try {
      (pi as { sendMessage: (message: unknown, options: unknown) => void }).sendMessage(
        { customType: MONITOR_EVENT_TYPE, content, display: true, details },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return true;
    } catch (error) {
      record.delivery = "undelivered";
      console.error(
        `${LOG_PREFIX} monitor_event for ${record.id} undelivered: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  function clearMonitorTimers(mon: LiveMonitor): void {
    if (mon.expiryTimer !== undefined) clearTimeout(mon.expiryTimer);
    if (mon.batchTimer !== undefined) clearTimeout(mon.batchTimer);
    mon.expiryTimer = undefined;
    mon.batchTimer = undefined;
  }

  /**
   * Terminal monitor path: flush pending lines first (a BackgroundStop or expiry
   * with a waiting batch still reports its lines), then exactly one notice,
   * the fd closed, the child owned by the reaping set. The child's later
   * close event is ignored: the terminal state owns the exit.
   */
  function finalizeMonitor(
    record: BackgroundMonitorRecord,
    terminal: "expired" | "stopped",
    reason: string,
  ): void {
    if (isMonitorTerminal(record) || record.notified) return;
    const mon = monitors.get(record.id);
    if (mon && !mon.wakeBroken) {
      if (mon.batchTimer !== undefined) clearTimeout(mon.batchTimer);
      mon.batchTimer = undefined;
      if (mon.partial.length > 0) {
        mon.buffer.push(mon.partial);
        record.lineCount += 1;
        mon.partial = "";
      }
      // Force: drain the whole buffer in bounded batches before the notice.
      // A single forced flush would leave the remainder to a re-armed timer
      // that can never fire once the monitor below is terminal and deleted.
      let guard = 0;
      while (mon.buffer.length > 0 && guard++ < 10000) {
        flushMonitorEvent(record, true);
        // The flush may have found the session gone and stopped the monitor
        // silently (no notice could be delivered either).
        if (record.notified) return;
        if (mon.batchTimer !== undefined) {
          clearTimeout(mon.batchTimer);
          mon.batchTimer = undefined;
        }
      }
      if (record.notified) return;
    }
    record.status = terminal;
    record.endedAt = now();
    record.pid = undefined;
    record.notified = true;
    // F2a: like tasks, a fresh terminal state is never already seen.
    record.seen = false;
    monitors.delete(record.id);
    if (mon) {
      if (mon.expiryTimer !== undefined) clearTimeout(mon.expiryTimer);
      mon.expiryTimer = undefined;
      if (mon.child) reapLater(mon.child);
      try {
        mon.socket?.close();
      } catch {
        /* already closed */
      }
      closeFd(mon);
    }
    const content =
      terminal === "expired"
        ? formatMonitorExpired({ monitorId: record.id, reason, eventCount: record.eventCount, lineCount: record.lineCount })
        : formatMonitorStopped({ monitorId: record.id, reason, eventCount: record.eventCount, lineCount: record.lineCount });
    record.messageId = stableWakeMessageId(record.sessionId, `${record.id}:end`);
    const delivered = disposed
      ? false
      : sendMonitorWake(record, content, {
          monitor_id: record.id,
          kind: terminal,
          reason,
          event_count: record.eventCount,
          line_count: record.lineCount,
          message_id: record.messageId,
          delivery: "delivered" as WakeDeliveryState,
        });
    record.delivery = delivered ? "delivered" : "undelivered";
    store.changed("monitor", record.id);
  }

  function flushMonitorEvent(record: BackgroundMonitorRecord, force = false): void {
    const mon = monitors.get(record.id);
    if (!mon || isMonitorTerminal(record) || mon.wakeBroken) return;
    if (mon.buffer.length === 0) return;
    // Wakes go out at most every MONITOR_MIN_WAKE_INTERVAL_MS: a full batch
    // that fills up right after a wake waits out the interval instead of
    // waking twice in a row. The batch keeps accumulating meanwhile. The
    // finalize path passes force: terminal lines are never dropped because
    // of the interval (N1).
    if (!force && mon.lastWakeAt !== undefined && now() - mon.lastWakeAt < MONITOR_MIN_WAKE_INTERVAL_MS) {
      if (mon.batchTimer === undefined) {
        const wait = MONITOR_MIN_WAKE_INTERVAL_MS - (now() - mon.lastWakeAt);
        mon.batchTimer = setTimeout(() => {
          mon.batchTimer = undefined;
          flushMonitorEvent(record);
        }, wait);
      }
      return;
    }
    // Bounded wakes, lossless stream (N2): at most MONITOR_MAX_EVENT_LINES
    // lines / MONITOR_MAX_EVENT_CHARS chars go out per wake; the remainder
    // stays buffered (front) for the next wake. Only the rate firehose stop
    // discards, and it always leaves a notice.
    const raw = mon.buffer.splice(0, mon.buffer.length);
    const kept: string[] = [];
    let chars = 0;
    let keptCount = 0;
    for (const line of raw) {
      const clean = sanitizeModelText(line);
      if (keptCount >= MONITOR_MAX_EVENT_LINES || chars + clean.length > MONITOR_MAX_EVENT_CHARS) break;
      kept.push(line);
      chars += clean.length;
      keptCount += 1;
    }
    const rest = raw.slice(keptCount);
    if (rest.length > 0) mon.buffer.unshift(...rest);
    const eventIndex = record.eventCount;
    record.messageId = stableWakeMessageId(record.sessionId, `${record.id}:${eventIndex}`);
    const content = formatMonitorEvent({ monitorId: record.id, eventIndex, lines: kept });
    const delivered = disposed
      ? false
      : sendMonitorWake(record, content, {
          monitor_id: record.id,
          kind: "event",
          event_index: eventIndex,
          line_count: kept.length,
          // The card preview reads these, never re-parsed from the envelope.
          lines: kept,
          message_id: record.messageId,
          delivery: "delivered" as WakeDeliveryState,
        });
    if (!delivered) {
      // The session is gone: no point streaming further. SIGKILL at once
      // (no one is left to be graceful for) and own the child in the
      // reaping set so a quit in this window still cannot orphan it. The
      // terminal state owns the exit; no notice follows (it could not be
      // delivered either).
      mon.wakeBroken = true;
      record.status = "stopped";
      record.endedAt = now();
      record.pid = undefined;
      record.notified = true;
      clearMonitorTimers(mon);
      monitors.delete(record.id);
      if (mon.child) {
        try {
          killTreeForce(mon.child);
        } catch {
          /* already gone */
        }
        reapLater(mon.child);
      }
      try {
        mon.socket?.close();
      } catch {
        /* already closed */
      }
      closeFd(mon);
      store.changed("monitor", record.id);
      return;
    }
    mon.lastWakeAt = now();
    record.eventCount += 1;
    record.status = "event";
    record.delivery = "delivered";
    store.changed("monitor", record.id);
    // A kept-behind remainder still needs its wake: re-arm the batch window.
    if (mon.buffer.length > 0 && mon.batchTimer === undefined && !isMonitorTerminal(record)) {
      mon.batchTimer = setTimeout(() => {
        mon.batchTimer = undefined;
        flushMonitorEvent(record);
      }, MONITOR_BATCH_WINDOW_MS);
    }
  }

  function observeMonitorLine(record: BackgroundMonitorRecord, line: string): void {
    const mon = monitors.get(record.id);
    if (!mon || isMonitorTerminal(record)) return;
    record.lineCount += 1;
    // Rate-based firehose trip: more than MONITOR_FIREHOSE_MAX_LINES in any
    // rolling MONITOR_FIREHOSE_WINDOW_MS window. A steady tail never trips
    // it no matter how long it runs; only a burst does.
    const windowStart = now() - MONITOR_FIREHOSE_WINDOW_MS;
    while (mon.lineTimes.length > 0 && (mon.lineTimes[0] as number) <= windowStart) {
      mon.lineTimes.shift();
    }
    mon.lineTimes.push(now());
    if (mon.lineTimes.length > MONITOR_FIREHOSE_MAX_LINES) {
      record.killReason = "firehose";
      finalizeMonitor(
        record,
        "stopped",
        `firehose: more than ${MONITOR_FIREHOSE_MAX_LINES} lines in ${MONITOR_FIREHOSE_WINDOW_MS / 1000}s`,
      );
      return;
    }
    mon.buffer.push(line);
    if (mon.buffer.length >= MONITOR_MAX_EVENT_LINES) {
      if (mon.batchTimer !== undefined) clearTimeout(mon.batchTimer);
      mon.batchTimer = undefined;
      flushMonitorEvent(record);
      return;
    }
    if (mon.batchTimer === undefined) {
      mon.batchTimer = setTimeout(() => {
        mon.batchTimer = undefined;
        flushMonitorEvent(record);
      }, MONITOR_BATCH_WINDOW_MS);
    }
  }

  /** Head emitted for an overlong line cut at MONITOR_PARTIAL_MAX_CHARS:
   * the marker leads (the per-line sanitize cap would amputate a trailing
   * one) followed by a short sample of the dropped line. */
  function truncatedLineHead(sample: string): string {
    return `[+line truncated at ${MONITOR_PARTIAL_MAX_CHARS} chars without a newline; dropped until next newline] ${sample.slice(0, 200)}`;
  }

  function observeMonitorChunk(record: BackgroundMonitorRecord, chunk: Buffer): void {
    const mon = monitors.get(record.id);
    if (!mon || isMonitorTerminal(record)) return;
    writeChunk(mon, chunk);
    // The partial line buffer is capped: a newline-free flood must not grow
    // it without bound. An overlong head is emitted truncated and the rest
    // dropped until the next newline.
    let text = mon.decoder.write(chunk);
    let guard = 0;
    while (text.length > 0 && guard++ < 32) {
      if (mon.dropping) {
        const newline = text.indexOf("\n");
        if (newline === -1) return;
        text = text.slice(newline + 1);
        mon.dropping = false;
      }
      mon.partial += text;
      text = "";
      if (mon.partial.length <= MONITOR_PARTIAL_MAX_CHARS) break;
      const rest = mon.partial.slice(MONITOR_PARTIAL_MAX_CHARS);
      observeMonitorLine(record, truncatedLineHead(mon.partial.slice(0, MONITOR_PARTIAL_MAX_CHARS)));
      if (isMonitorTerminal(record)) return;
      mon.partial = "";
      mon.dropping = true;
      text = rest;
    }
    if (mon.dropping) return;
    const parts = mon.partial.split("\n");
    mon.partial = parts.pop() ?? "";
    for (const line of parts) observeMonitorLine(record, line);
  }

  function describeMonitorSource(args: MonitorArgs): { command: string | null; wsUrl: string | null; label: string } {
    if (args.command !== undefined && args.command.trim().length > 0) {
      return { command: args.command, wsUrl: null, label: args.command };
    }
    if (args.ws !== undefined && typeof args.ws.url === "string" && args.ws.url.trim().length > 0) {
      return { command: null, wsUrl: args.ws.url, label: args.ws.url };
    }
    throw new Error(`${LOG_PREFIX} Monitor requires exactly one of command and ws{url}.`);
  }

  async function runMonitor(
    args: MonitorArgs,
    ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
  ): Promise<Record<string, unknown>> {
    const hasCommand = args.command !== undefined && args.command.trim().length > 0;
    const hasWs = args.ws !== undefined && typeof args.ws.url === "string" && args.ws.url.trim().length > 0;
    if (hasCommand === hasWs) {
      throw new Error(`${LOG_PREFIX} Monitor requires exactly one of command and ws{url}.`);
    }
    let timeoutMs = MONITOR_DEFAULT_TIMEOUT_MS;
    if (args.timeout_ms !== undefined) {
      if (!Number.isFinite(args.timeout_ms) || args.timeout_ms <= 0) {
        throw new Error(`${LOG_PREFIX} timeout_ms must be a positive number of milliseconds.`);
      }
      if (args.timeout_ms > MONITOR_MAX_TIMEOUT_MS) {
        throw new Error(
          `${LOG_PREFIX} timeout_ms ${args.timeout_ms}ms exceeds the 30 min maximum (${MONITOR_MAX_TIMEOUT_MS}ms).`,
        );
      }
      timeoutMs = args.timeout_ms;
    }
    if (disposed) throw new Error(`${LOG_PREFIX} background extension is disposed.`);
    const sessionId = sessionIdOf(ctx);
    const source = describeMonitorSource(args);
    const description = args.description?.trim()
      ? args.description.trim()
      : source.label.length > 90
        ? `${source.label.slice(0, 90)}...`
        : source.label;
    const dir = runDir(sessionId);
    const record = store.createMonitor({
      command: source.command,
      wsUrl: source.wsUrl,
      ...(args.ws?.protocols ? { wsProtocols: [...args.ws.protocols] } : {}),
      description,
      outputFile: "",
      sessionId,
    });

    let fd: number;
    try {
      fd = openOutputFile(dir, "monitor", record.id);
    } catch (error) {
      record.status = "stopped";
      record.endedAt = now();
      throw new Error(
        `${LOG_PREFIX} could not open output file for ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const outputFile = path.join(dir, `monitor-${record.id}.log`);
    record.outputFile = outputFile;
    store.changed("monitor", record.id);

    const mon: LiveMonitor = {
      child: undefined,
      socket: undefined,
      decoder: new StringDecoder("utf8"),
      partial: "",
      dropping: false,
      buffer: [],
      lineTimes: [],
      lastWakeAt: undefined,
      fd,
      written: 0,
      truncated: false,
      expiryTimer: undefined,
      batchTimer: undefined,
      wakeBroken: false,
    };
    monitors.set(record.id, mon);

    const expiryReason = `${timeoutMs}ms timeout`;
    mon.expiryTimer = setTimeout(() => {
      if (isMonitorTerminal(record)) return;
      record.killReason = "timeout";
      finalizeMonitor(record, "expired", expiryReason);
    }, timeoutMs);

    if (source.command !== null) {
      const cwd = ctx?.cwd && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
      let child: ChildProcess;
      try {
        // Intentional: Monitor IS a shell-execution tool (Claude Code Monitor
        // parity). The command comes from the model tool call under Pi's
        // normal tool approval, output is bounded to the monitor file and to
        // bounded event payloads, and the child is process-group scoped so
        // stop/expiry kill the whole tree.
        child = spawn(source.command, { // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
          cwd,
          shell: shellForPlatform(),
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        if (mon.expiryTimer !== undefined) clearTimeout(mon.expiryTimer);
        mon.expiryTimer = undefined;
        closeFd(mon);
        monitors.delete(record.id);
        record.status = "stopped";
        record.endedAt = now();
        throw error;
      }
      mon.child = child;
      record.pid = child.pid;
      record.cwd = cwd;
      record.timeoutMs = timeoutMs;
      exitVictimSet().add(child);
      // Only stdout is the event stream (Claude Code parity); stderr lands
      // in the output file, each stream with its own accounting below.
      child.stdout?.on("data", (chunk: Buffer) => observeMonitorChunk(record, chunk));
      child.stderr?.on("data", (chunk: Buffer) => {
        if (isMonitorTerminal(record)) return;
        writeChunk(mon, chunk);
      });
      try {
        child.unref();
      } catch {
        /* keep running without holding the loop when supported */
      }
      child.on("error", (error: Error) => {
        if (isMonitorTerminal(record)) return;
        try {
          writeSync(fd, `Failed to start: ${error.message}\n`);
        } catch {
          /* output file unavailable; the notice still carries the counts */
        }
        record.killReason = record.killReason ?? "stop";
        finalizeMonitor(record, "stopped", `command failed to start: ${sanitizeModelText(error.message, 200)}`);
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        exitVictimSet().delete(child);
        if (isMonitorTerminal(record)) return;
        // finalizeMonitor flushes the leftover partial line and any waiting
        // batch before the notice, so the counts line up.
        const reason = signal !== null && signal !== undefined
          ? `command exited (signal ${signal})`
          : `command exited (exit code ${code})`;
        finalizeMonitor(record, "stopped", reason);
      });
    } else {
      let socket: MonitorSocket;
      try {
        socket = createSocket(source.wsUrl as string, args.ws?.protocols);
      } catch (error) {
        if (mon.expiryTimer !== undefined) clearTimeout(mon.expiryTimer);
        mon.expiryTimer = undefined;
        closeFd(mon);
        monitors.delete(record.id);
        record.status = "stopped";
        record.endedAt = now();
        throw error;
      }
      mon.socket = socket;
      socket.onmessage = (event: { data: unknown }) => {
        if (isMonitorTerminal(record)) return;
        const data = event.data;
        if (typeof data !== "string") return;
        // Frames share the output-file ceiling with command output.
        writeChunk(mon, Buffer.from(`${data}\n`, "utf8"));
        observeMonitorLine(record, data);
      };
      const closedNotice = (): void => {
        if (isMonitorTerminal(record)) return;
        finalizeMonitor(record, "stopped", "connection closed");
      };
      socket.onclose = closedNotice;
      socket.onerror = closedNotice;
    }

    const sourceLine = source.command !== null ? `Command: ${source.command}` : `WebSocket: ${source.wsUrl}`;
    const message =
      `Started monitor ${record.id}.\n` +
      `${sourceLine}\n` +
      `Do not poll; end the turn. Each matching line wakes you with one event; the filter must match failure states too, silence is not success.`;
    return textResult(message, {
      monitor_id: record.id,
      output_file: outputFile,
      status: "armed",
      message_id: stableWakeMessageId(sessionId, record.id),
    }) as Record<string, unknown>;
  }

  async function stopTask(taskId: string): Promise<Record<string, unknown>> {
    const monitor = store.getMonitor(taskId);
    if (monitor) {
      if (isMonitorTerminal(monitor)) {
        return textResult(`Monitor ${monitor.id} already ${monitor.status}.`, {
          task_id: monitor.id,
          monitor_id: monitor.id,
          status: monitor.status,
          message_id: monitor.messageId,
        }) as Record<string, unknown>;
      }
      monitor.killReason = "stop";
      finalizeMonitor(monitor, "stopped", "stopped by BackgroundStop");
      return textResult(`Stopped monitor ${monitor.id}.`, {
        task_id: monitor.id,
        monitor_id: monitor.id,
        status: "stopped",
        message_id: monitor.messageId,
      }) as Record<string, unknown>;
    }
    const record = store.get(taskId);
    if (!record) throw new Error(`${LOG_PREFIX} unknown task ${JSON.stringify(taskId)}.`);
    if (record.status !== "running") {
      return textResult(`Background task ${record.id} already ${record.status}. Output: ${record.outputFile}`, {
        task_id: record.id,
        output_file: record.outputFile,
        status: record.status,
        message_id: record.messageId,
      }) as Record<string, unknown>;
    }
    const handle = live.get(record.id);
    if (handle?.child.exitCode !== null && handle?.child.exitCode !== undefined) {
      settleFromExit(record, handle.child.exitCode);
      return textResult(`Background task ${record.id} already ${record.status}. Output: ${record.outputFile}`, {
        task_id: record.id,
        output_file: record.outputFile,
        status: record.status,
        message_id: record.messageId,
      }) as Record<string, unknown>;
    }
    record.killReason = "stop";
    if (handle) {
      killTree(handle.child);
      armGraceKill(record, handle.child);
    } else {
      finalize(record, "stopped", null);
    }
    return textResult(`Stopped background task ${record.id}. Output: ${record.outputFile}`, {
      task_id: record.id,
      output_file: record.outputFile,
      status: "stopped",
      message_id: record.messageId,
    }) as Record<string, unknown>;
  }

  /**
   * Operator-only rerun (the model has no rerun tool): respawn a finished
   * task or monitor from its record as a new id. Running rows refuse loudly
   * with "stop it first" instead of doubling the command.
   */
  async function rerunTask(taskId: string): Promise<Record<string, unknown>> {
    // F5: rerun replays the original cwd and timeout, not the ambient ones.
    const rerunCtx = (
      sessionId: string,
      cwd: string,
    ): { cwd: string; sessionManager: { getSessionId: () => string } } => ({
      cwd: cwd || process.cwd(),
      sessionManager: { getSessionId: () => sessionId },
    });
    const monitor = store.getMonitor(taskId);
    if (monitor) {
      if (!isMonitorTerminal(monitor)) {
        throw new Error(`${LOG_PREFIX} monitor ${monitor.id} is still ${monitor.status}; stop it first.`);
      }
      const source =
        monitor.command !== null && monitor.command.trim().length > 0
          ? { command: monitor.command }
          : { ws: { url: monitor.wsUrl ?? "", ...(monitor.wsProtocols ? { protocols: [...monitor.wsProtocols] } : {}) } };
      const started = (await runMonitor(
        {
          ...source,
          description: monitor.description,
          ...(monitor.timeoutMs > 0 ? { timeout_ms: monitor.timeoutMs } : {}),
        },
        rerunCtx(monitor.sessionId, monitor.cwd),
      )) as { details?: { monitor_id?: string; output_file?: string } };
      const newId = started.details?.monitor_id ?? "";
      return textResult(`Reran monitor ${monitor.id} as ${newId}.`, {
        monitor_id: newId,
        reran_from: monitor.id,
        status: "armed",
      }) as Record<string, unknown>;
    }
    const record = store.get(taskId);
    if (!record) throw new Error(`${LOG_PREFIX} unknown task ${JSON.stringify(taskId)}.`);
    if (record.status === "running") {
      throw new Error(`${LOG_PREFIX} background task ${record.id} is still running; stop it first.`);
    }
    const started = (await runBackground(
      {
        command: record.command,
        description: record.description,
        ...(record.timeoutMs > 0 ? { timeout: record.timeoutMs } : {}),
      },
      rerunCtx(record.sessionId, record.cwd),
    )) as { details?: { task_id?: string; output_file?: string } };
    const newId = started.details?.task_id ?? "";
    return textResult(`Reran background task ${record.id} as ${newId}.`, {
      task_id: newId,
      reran_from: record.id,
      status: "running",
    }) as Record<string, unknown>;
  }

  function close(): void {
    disposed = true;
    const running = [...live.keys(), ...monitors.keys()];
    // Non-blocking shutdown (B3 follow-up 7): SIGTERM the whole groups now,
    // settle every record as stopped and close every fd synchronously, then
    // return. The SIGKILL sweep for TERM-trappers rides an unref'd timer so
    // a reload never blocks the event loop for the kill grace. No wake
    // follows: the session is going away. Tradeoff: on full process exit
    // the sweep may not fire; the groups already got SIGTERM above.
    const victims: ChildProcess[] = [];
    for (const [, handle] of live) {
      if (handle.timer !== undefined) clearTimeout(handle.timer);
      if (handle.graceTimer !== undefined) clearTimeout(handle.graceTimer);
      handle.timer = undefined;
      handle.graceTimer = undefined;
      try {
        killTree(handle.child);
      } catch {
        /* best effort on shutdown */
      }
      victims.push(handle.child);
    }
    for (const [, mon] of monitors) {
      clearMonitorTimers(mon);
      if (mon.child) {
        try {
          killTree(mon.child);
        } catch {
          /* best effort on shutdown */
        }
        victims.push(mon.child);
      }
      try {
        mon.socket?.close();
      } catch {
        /* best effort on shutdown */
      }
    }
    for (const [child, timer] of reaping) {
      clearTimeout(timer);
      victims.push(child);
      exitVictimSet().add(child);
    }
    reaping.clear();
    for (const [id, handle] of live) {
      // Seal the handle first: a lingering child write after closeFd must
      // drop here, never into a recycled fd number.
      handle.truncated = true;
      closeFd(handle);
      const record = store.get(id);
      if (record && record.status === "running") {
        record.killReason = "stop";
        record.status = "stopped";
        record.endedAt = now();
        record.pid = undefined;
        store.changed("task", id);
      }
    }
    live.clear();
    for (const [id, mon] of monitors) {
      mon.truncated = true;
      closeFd(mon);
      const record = store.getMonitor(id);
      if (record && !isMonitorTerminal(record)) {
        record.killReason = "stop";
        record.status = "stopped";
        record.endedAt = now();
        record.pid = undefined;
        store.changed("monitor", id);
      }
    }
    monitors.clear();
    // The late close/exit events of killed children land here: records are
    // already terminal, so settle paths no-op and no wake follows.
    if (victims.length > 0) {
      if (killGraceMs > 0) {
        const sweep = setTimeout(() => {
          for (const child of victims) {
            exitVictimSet().delete(child);
            try {
              killTreeForce(child);
            } catch {
              /* already gone */
            }
          }
        }, killGraceMs);
        try {
          (sweep as unknown as { unref?: () => void }).unref?.();
        } catch {
          /* runtimes without unref */
        }
      } else {
        for (const child of victims) {
          exitVictimSet().delete(child);
          try {
            killTreeForce(child);
          } catch {
            /* best effort on shutdown */
          }
        }
      }
    }
    if (running.length > 0) {
      console.error(`${LOG_PREFIX} session shutdown: stopping background task(s) ${running.join(", ")}`);
    }
  }

  // The widget follows the store without polling. The ui handle arrives
  // with session_start and is refreshed from every tool/command context;
  // every store change then re-renders through the latest handle.
  let currentUi: BackgroundWidgetUi | undefined;
  const noteUi = (ui: unknown): void => {
    if (ui && typeof (ui as BackgroundWidgetUi).setWidget === "function") currentUi = ui as BackgroundWidgetUi;
  };
  const widget = createBackgroundWidget(store, () => currentUi);

  pi.registerTool({
    name: "BashBackground",
    label: "BashBackground",
    description:
      "Run a shell command in the background without blocking. Returns at once with a task id and an output file path. On exit one task notification wakes the session; read the output file with read. (On Pi, use this where Claude Code uses Bash with run_in_background.)",
    parameters: BashBackgroundParams,
    exposure: "direct",
    promptGuidelines: [
      "Do not poll a background task; end the turn. The notification wakes you when the task exits, then read the output file.",
    ],
    execute: async (_toolCallId: string, params: BashBackgroundArgs, _signal: unknown, _onUpdate: unknown, ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string }; ui?: unknown }) => {
      noteUi(ctx?.ui);
      return (await runBackground(params, ctx)) as never;
    },
  });

  pi.registerTool({
    name: "Monitor",
    label: "Monitor",
    description:
      "Monitor a shell command's stdout lines or a WebSocket stream without blocking. Returns at once with a monitor id. Each line (or text frame) wakes the session with one event; lines within 200 ms batch into one event. The monitor expires at timeout_ms (default 5 min, maximum 30 min) with one notice and the event count; a firehose is stopped with a notice; BackgroundStop cancels it.",
    parameters: MonitorParams,
    exposure: "direct",
    promptGuidelines: [
      "Do not poll a monitor; end the turn. Each matching line wakes you with one event. The filter must match failure states too; silence is not success.",
    ],
    execute: async (_toolCallId: string, params: MonitorArgs, _signal: unknown, _onUpdate: unknown, ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string }; ui?: unknown }) => {
      noteUi(ctx?.ui);
      return (await runMonitor(params, ctx)) as never;
    },
  });

  pi.registerTool({
    name: "BackgroundStop",
    label: "BackgroundStop",
    description: "Stop a running background task or monitor by id. The task or monitor ends with status stopped.",
    parameters: BackgroundStopParams,
    exposure: "direct",
    execute: async (_toolCallId: string, params: BackgroundStopArgs) => {
      return (await stopTask(params.task_id)) as never;
    },
  });

  // B3 operator surface: I7 cards and /bg (the widget is wired above).
  registerBackgroundCards(pi);

  const resultText = (result: Record<string, unknown>): string => {
    const content = (result as { content?: Array<{ text?: unknown }> }).content;
    const first = content?.[0]?.text;
    return typeof first === "string" ? first : JSON.stringify(result);
  };
  registerTasksCommand(pi, {
    store,
    stopTask: async (id: string) => resultText(await stopTask(id)),
    rerunTask: async (id: string) => resultText(await rerunTask(id)),
    readOutputView: (id: string): Promise<OutputView> => readOutput(store, id),
  });

  if (typeof pi.on === "function") {
    try {
      pi.on("session_shutdown", () => close());
    } catch {
      /* older runtimes without this event; close() stays available to the host */
    }
    try {
      pi.on("session_start", (_event, ctx) => {
        try {
          noteUi((ctx as unknown as { ui?: unknown } | undefined)?.ui);
          widget.refresh();
        } catch {
          /* a failed refresh must never fail session start */
        }
      });
    } catch {
      /* older runtimes without this event; tool/command contexts still feed the widget */
    }
  }

  return { store, runBackground, runMonitor, stopTask, rerunTask, close };
}

export default function backgroundExtension(pi: ExtensionAPI, options: BackgroundServiceOptions = {}): void {
  registerBackgroundExtension(pi, options);
}
