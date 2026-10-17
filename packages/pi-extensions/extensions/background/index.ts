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
 * only). Nothing else is carried over: no bg_status, bg_logs, attestation,
 * fusion_*, bg_delegate or provider override. Method and envelope parity with
 * Claude Code; clean reimplementation otherwise.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";

import {
  createBackgroundStore,
  formatElapsed,
  formatTaskNotification,
  stableBackgroundMessageId,
  TASK_STATES,
  type BackgroundStore,
  type BackgroundTaskRecord,
  type TaskStatus,
} from "./store.ts";

export { TASK_STATES, stableBackgroundMessageId, formatTaskNotification };
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

/** Bounded preview of the output file inside the notification. */
const PREVIEW_MAX_BYTES = 4096;
const PREVIEW_MAX_LINES = 10;
/** Grace between SIGTERM and SIGKILL for stop and timeout kills. */
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
  now?: () => number;
}

export interface BackgroundService {
  store: BackgroundStore;
  runBackground(args: BashBackgroundArgs, ctx?: { cwd?: string }): Promise<Record<string, unknown>>;
  stopTask(taskId: string): Promise<Record<string, unknown>>;
  close(): void;
}

export function registerBackgroundExtension(pi: ExtensionAPI, options: BackgroundServiceOptions = {}): BackgroundService {
  const outputDir = options.outputDir ?? os.tmpdir();
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const now = options.now ?? Date.now;
  const store = createBackgroundStore({ now, outputDir });
  const live = new Map<string, { child: ChildProcess; timer: ReturnType<typeof setTimeout> | undefined; graceTimer: ReturnType<typeof setTimeout> | undefined }>();
  let disposed = false;

  function outputFileFor(id: string): string {
    return path.join(outputDir, `background-${id}.log`);
  }

  function previewOf(outputFile: string): string[] {
    try {
      const data = readFileSync(outputFile, "utf8");
      const tail = data.length > PREVIEW_MAX_BYTES ? data.slice(data.length - PREVIEW_MAX_BYTES) : data;
      const lines = tail.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return lines.slice(-PREVIEW_MAX_LINES);
    } catch {
      return [];
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

  function notify(record: BackgroundTaskRecord): void {
    if (record.notified || disposed) return;
    record.notified = true;
    const elapsedMs = (record.endedAt ?? now()) - record.startedAt;
    const summary = `Background task ${JSON.stringify(record.description)} ${record.status} after ${formatElapsed(elapsedMs)}.`;
    const content = formatTaskNotification({
      taskId: record.id,
      status: record.status,
      summary,
      outputFile: record.outputFile,
      exitCode: record.exitCode,
      elapsedMs,
      preview: previewOf(record.outputFile),
    });
    try {
      (pi as { sendMessage: (message: unknown, options: unknown) => void }).sendMessage(
        {
          customType: TASK_NOTIFICATION_TYPE,
          content,
          display: true,
          details: {
            task_id: record.id,
            status: record.status,
            output_file: record.outputFile,
            message_id: record.messageId,
            exit_code: record.exitCode,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch (error) {
      record.notified = false;
      console.error(`${LOG_PREFIX} failed to wake session for ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function finalize(record: BackgroundTaskRecord, status: TaskStatus, exitCode: number | null): void {
    if (record.status !== "running") return;
    record.status = status;
    record.exitCode = exitCode;
    record.endedAt = now();
    const handle = live.get(record.id);
    live.delete(record.id);
    if (handle?.timer !== undefined) clearTimeout(handle.timer);
    if (handle?.graceTimer !== undefined) clearTimeout(handle.graceTimer);
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

  async function runBackground(args: BashBackgroundArgs, ctx?: { cwd?: string }): Promise<Record<string, unknown>> {
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
    const description = args.description?.trim() ? args.description.trim() : command.length > 90 ? `${command.slice(0, 90)}...` : command;
    mkdirSync(outputDir, { recursive: true });
    const record = store.create(command, description, "");
    const outputFile = outputFileFor(record.id);
    record.outputFile = outputFile;

    const cwd = ctx?.cwd && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    const stream = createWriteStream(outputFile, { flags: "a" });
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
      stream.close();
      record.status = "failed";
      record.endedAt = now();
      appendFileSync(outputFile, `Failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
      notify(record);
      throw error;
    }
    child.stdout?.pipe(stream);
    child.stderr?.pipe(stream);
    try {
      child.unref();
    } catch {
      /* keep running without holding the loop when supported */
    }

    const timer = setTimeout(() => {
      if (record.status !== "running") return;
      const handle = live.get(record.id);
      if (handle?.child.exitCode !== null && handle?.child.exitCode !== undefined) {
        settleFromExit(record, handle.child.exitCode);
        return;
      }
      record.killReason = "timeout";
      killTree(child);
      armGraceKill(record, child);
    }, timeoutMs);
    live.set(record.id, { child, timer, graceTimer: undefined });

    child.on("error", (error: Error) => {
      try {
        appendFileSync(outputFile, `Failed to start: ${error.message}\n`);
      } catch {
        /* output file unavailable; the notification still carries the status */
      }
      settleFromExit(record, null);
    });
    child.on("close", (code: number | null) => {
      try {
        stream.close();
      } catch {
        /* already closed */
      }
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
    for (const [id, handle] of live) {
      if (handle.timer !== undefined) clearTimeout(handle.timer);
      if (handle.graceTimer !== undefined) clearTimeout(handle.graceTimer);
      try {
        killTreeForce(handle.child);
      } catch {
        /* best effort on shutdown */
      }
      live.delete(id);
      const record = store.get(id);
      if (record && record.status === "running") {
        record.status = "stopped";
        record.endedAt = now();
      }
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
    execute: async (_toolCallId: string, params: BashBackgroundArgs, _signal: unknown, _onUpdate: unknown, ctx?: { cwd?: string }) => {
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
