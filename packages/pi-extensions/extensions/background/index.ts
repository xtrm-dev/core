/**
 * Background runs for Pi (B1, CORE-2439).
 *
 * Model tools: BashBackground{command, description, timeout} starts one shell
 * command without blocking and returns at once with a task id and an output
 * file path; TaskStop{task_id} stops it. On exit exactly one
 * <task-notification> wakes the owning session through pi.sendMessage with
 * {triggerTurn: true, deliverAs: "followUp"} (D6). The model reads the output
 * file with read. Prompt guidance keeps the rule: do not poll, end the turn,
 * the notification wakes you.
 *
 * On Pi, use BashBackground where Claude Code uses Bash with
 * run_in_background. Defaults follow Claude Code: 30 min, at most 2 h.
 *
 * Lineage: the start/output-file/single-completion method is informed by
 * `pi-background-tasks` (ADOPTION-CREDITS.md: background-process UX subset
 * only). The message id and the wake delivery vocabulary come from the I1
 * wake contract in @xtrm/contracts. Nothing else is carried over: no
 * bg_status, bg_logs, attestation, fusion_*, bg_delegate or provider override.
 * Method and envelope parity with Claude Code; clean reimplementation
 * otherwise.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stableWakeMessageId, type WakeDeliveryState } from "@xtrm/contracts";
import { Text } from "@earendil-works/pi-tui";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";

import {
  createBackgroundStore,
  formatTaskNotification,
  sanitizeModelText,
  TASK_STATES,
  type BackgroundStore,
  type BackgroundTaskRecord,
  type TaskStatus,
} from "./store.ts";

export { TASK_STATES, formatTaskNotification, sanitizeModelText };
export { createBackgroundStore };
export type { BackgroundStore, BackgroundTaskRecord, TaskStatus };

/** Model-visible custom type for the completion wake. Bare name: no xtrm- slug. */
export const TASK_NOTIFICATION_TYPE = "task_notification";

/** Log prefix. Bare name: no xtrm- slug. */
export const LOG_PREFIX = "[background]";

/** Claude Code background default: 30 min. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Claude Code background maximum: 2 h. Values above fail loudly. */
export const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
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

const TaskStopParams = Type.Object({
  task_id: Type.String({ minLength: 1, description: "Background task id to stop" }),
});

type BashBackgroundArgs = Static<typeof BashBackgroundParams>;
type TaskStopArgs = Static<typeof TaskStopParams>;

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function shellForPlatform(): true | string {
  return process.platform === "win32" ? true : "/bin/sh";
}

export interface BackgroundServiceOptions {
  outputDir?: string;
  killGraceMs?: number;
  outputMaxBytes?: number;
  makeId?: () => string;
  now?: () => number;
}

export interface BackgroundService {
  store: BackgroundStore;
  runBackground(args: BashBackgroundArgs, ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string } }): Promise<Record<string, unknown>>;
  stopTask(taskId: string): Promise<Record<string, unknown>>;
  close(): void;
}

interface LiveHandle {
  child: ChildProcess;
  fd: number;
  written: number;
  truncated: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
}

export function registerBackgroundExtension(pi: ExtensionAPI, options: BackgroundServiceOptions = {}): BackgroundService {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const outputMaxBytes = options.outputMaxBytes ?? OUTPUT_MAX_BYTES;
  const now = options.now ?? Date.now;
  const store = createBackgroundStore({ now, makeId: options.makeId, outputDir: options.outputDir ?? "" });
  const live = new Map<string, LiveHandle>();
  const sessionDirs = new Map<string, string>();
  let disposed = false;

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
  function openOutputFile(dir: string, id: string): number {
    return openSync(path.join(dir, `background-${id}.log`), "wx", 0o600);
  }

  function writeChunk(handle: LiveHandle, chunk: Buffer): void {
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

  function closeFd(handle: LiveHandle): void {
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

  function summaryFor(record: BackgroundTaskRecord): string {
    const exit = record.exitCode === null ? "(no exit code)" : `(exit code ${record.exitCode})`;
    return `Background command "${sanitizeModelText(record.description)}" ${record.status} ${exit}`;
  }

  function notify(record: BackgroundTaskRecord): void {
    if (record.notified || disposed) return;
    record.notified = true;
    const content = formatTaskNotification({
      taskId: record.id,
      status: record.status,
      summary: summaryFor(record),
      outputFile: record.outputFile,
      exitCode: record.exitCode,
    });
    const details = {
      task_id: record.id,
      status: record.status,
      output_file: record.outputFile,
      message_id: record.messageId,
      exit_code: record.exitCode,
      delivery: "delivered" as WakeDeliveryState,
    };
    try {
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
  }

  function finalize(record: BackgroundTaskRecord, status: TaskStatus, exitCode: number | null): void {
    if (record.status !== "running") return;
    record.status = status;
    record.exitCode = exitCode;
    record.endedAt = now();
    record.pid = undefined;
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

    let fd: number;
    try {
      fd = openOutputFile(dir, record.id);
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

  async function stopTask(taskId: string): Promise<Record<string, unknown>> {
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

  function close(): void {
    disposed = true;
    const running = [...live.keys()];
    for (const [id, handle] of live) {
      if (handle.timer !== undefined) clearTimeout(handle.timer);
      if (handle.graceTimer !== undefined) clearTimeout(handle.graceTimer);
      // The shutdown kill owns the exit: the close event settles as stopped,
      // not failed, and no wake follows (the session is going away).
      const record = store.get(id);
      if (record && record.status === "running") record.killReason = "stop";
      try {
        killTree(handle.child);
      } catch {
        /* best effort on shutdown */
      }
      const child = handle.child;
      handle.graceTimer = setTimeout(() => {
        try {
          killTreeForce(child);
        } catch {
          /* best effort on shutdown */
        }
        const rec = store.get(id);
        if (rec && rec.status === "running") {
          rec.status = "stopped";
          rec.endedAt = now();
          rec.pid = undefined;
        }
        live.delete(id);
      }, killGraceMs);
    }
    if (running.length > 0) {
      console.error(`${LOG_PREFIX} session shutdown: stopping background task(s) ${running.join(", ")}`);
    }
  }

  pi.registerTool({
    name: "BashBackground",
    label: "BashBackground",
    description:
      "Run a shell command in the background without blocking. Returns at once with a task id and an output file path. On exit one task notification wakes the session; read the output file with read. (On Pi, use this where Claude Code uses Bash with run_in_background.)",
    parameters: BashBackgroundParams,
    exposure: "codemode",
    promptGuidelines: [
      "Do not poll a background task; end the turn. The notification wakes you when the task exits, then read the output file.",
    ],
    execute: async (_toolCallId: string, params: BashBackgroundArgs, _signal: unknown, _onUpdate: unknown, ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string } }) => {
      return (await runBackground(params, ctx)) as never;
    },
  });

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: "Stop a running background task by id. The task ends with status stopped.",
    parameters: TaskStopParams,
    exposure: "codemode",
    execute: async (_toolCallId: string, params: TaskStopArgs) => {
      return (await stopTask(params.task_id)) as never;
    },
  });

  pi.registerMessageRenderer(TASK_NOTIFICATION_TYPE, (message, _options, theme) => {
    const details = (message.details ?? {}) as { task_id?: string; status?: string; output_file?: string };
    const status = String(details.status ?? "");
    const color = status === "completed" ? "success" : status === "failed" ? "error" : status === "running" ? "text" : "warning";
    const head = `◐ background ${String(details.task_id ?? "")} ${status}`;
    const facts = `Output: ${String(details.output_file ?? "")}`;
    try {
      return new Text(`${theme.fg(color, head)}\n${theme.fg("dim", facts)}`, 0, 0);
    } catch {
      return new Text(`${head}\n${facts}`, 0, 0);
    }
  });

  if (typeof pi.on === "function") {
    try {
      pi.on("session_shutdown", () => close());
    } catch {
      /* older runtimes without this event; close() stays available to the host */
    }
  }

  return { store, runBackground, stopTask, close };
}

export default function backgroundExtension(pi: ExtensionAPI, options: BackgroundServiceOptions = {}): void {
  registerBackgroundExtension(pi, options);
}
