/**
 * /tasks operator surface (B3 CORE-2441, ADR rev 2 B2 + amendment 1).
 *
 * One list of background runs and monitors. Row: state glyph, command or
 * description, id, elapsed, output size or event count. Keys (matched with
 * pi-tui matchesKey, never literal escapes): enter shows or follows the
 * output, s stops, r reruns (finished only; a running row refuses with
 * "stop it first"), c clears finished rows, esc or q closes. Text forms for
 * scripts and muscle memory: /tasks stop|output|rerun <id>, /tasks clear.
 * Theme tokens only (bold header, dim hints); no new colours, no ANSI in
 * model payloads (this module builds none).
 *
 * Opening the list marks every record seen, so the indicator's "! N failed"
 * clears once the operator looked. Viewing one record's output marks it.
 */

import { readFileSync, statSync } from "node:fs";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  formatElapsed,
  sanitizeModelText,
  type BackgroundMonitorRecord,
  type BackgroundStore,
  type BackgroundTaskRecord,
} from "./store.ts";

/** Bare command name: no xtrm- slug. */
export const TASKS_COMMAND = "tasks";

export const TASKS_USAGE = [
  "/tasks — one list of background runs and monitors",
  "/tasks stop <id> — stop a running task or monitor",
  "/tasks output <id> — show the tail of its output file",
  "/tasks rerun <id> — run the same command again (finished rows only)",
  "/tasks clear — evict finished rows",
  "Keys: enter shows or follows the output · s stops · r reruns · c clears finished · esc closes",
].join("\n");

export type TasksAction =
  | { action: "open" }
  | { action: "stop"; id: string }
  | { action: "output"; id: string }
  | { action: "rerun"; id: string }
  | { action: "clear" }
  | { action: "usage" };

/** Split "/tasks <verb> <id>" into an action; anything unknown is usage. */
export function parseTasksArgs(args: string): TasksAction {
  const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return { action: "open" };
  const [verb, id, ...rest] = parts;
  if ((verb === "stop" || verb === "output" || verb === "rerun") && id && rest.length === 0) {
    return { action: verb, id } as TasksAction;
  }
  if (verb === "clear" && parts.length === 1) return { action: "clear" };
  return { action: "usage" };
}

/**
 * Row glyphs from the amendment-1 set (◐ running task, ◉ monitor, !
 * failure) plus two quiet terminals: ✓ completed, ○ stopped/expired. The
 * state word always rides along, so the glyph is a redundant cue.
 */
export function stateGlyph(kind: "task" | "monitor", status: string, killReason?: string | null): string {
  if (kind === "task" && (status === "failed" || status === "timed_out")) return "!";
  if (kind === "monitor" && status === "stopped" && killReason === "firehose") return "!";
  if (status === "running") return "◐";
  if (status === "armed" || status === "event") return "◉";
  if (status === "completed") return "✓";
  return "○";
}

export interface TasksRow {
  kind: "task" | "monitor";
  id: string;
  glyph: string;
  state: string;
  label: string;
  elapsed: string;
  extra: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}

function outputSizeExtra(outputFile: string): string {
  if (!outputFile) return "";
  try {
    return formatBytes(statSync(outputFile).size);
  } catch {
    return "";
  }
}

function taskRow(record: BackgroundTaskRecord, now: number): TasksRow {
  const size = outputSizeExtra(record.outputFile);
  return {
    kind: "task",
    id: record.id,
    glyph: stateGlyph("task", record.status),
    state: record.status,
    label: record.description || record.command || record.id,
    elapsed: formatElapsed((record.endedAt ?? now) - record.startedAt),
    extra: size,
  };
}

function monitorRow(record: BackgroundMonitorRecord, now: number): TasksRow {
  return {
    kind: "monitor",
    id: record.id,
    glyph: stateGlyph("monitor", record.status, record.killReason),
    state: record.status,
    label: record.description || record.command || record.wsUrl || record.id,
    elapsed: formatElapsed((record.endedAt ?? now) - record.startedAt),
    extra: `${record.eventCount} events · ${record.lineCount} lines`,
  };
}

/** Active rows first (oldest first), then terminal rows (newest first). */
export function buildTasksRows(
  tasks: BackgroundTaskRecord[],
  monitors: BackgroundMonitorRecord[],
  now: number,
): TasksRow[] {
  const activeTasks = tasks.filter((record) => record.status === "running").sort((a, b) => a.startedAt - b.startedAt);
  const doneTasks = tasks
    .filter((record) => record.status !== "running")
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  const activeMonitors = monitors
    .filter((record) => record.status === "armed" || record.status === "event")
    .sort((a, b) => a.startedAt - b.startedAt);
  const doneMonitors = monitors
    .filter((record) => record.status !== "armed" && record.status !== "event")
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  return [
    ...activeTasks.map((record) => taskRow(record, now)),
    ...doneTasks.map((record) => taskRow(record, now)),
    ...activeMonitors.map((record) => monitorRow(record, now)),
    ...doneMonitors.map((record) => monitorRow(record, now)),
  ];
}

/** One row: glyph, command or description, id, state, elapsed, size/events. */
export function formatTasksRow(row: TasksRow, width: number): string {
  const safe = Math.max(20, Math.floor(width) || 80);
  const line = `${row.glyph} ${row.label} ${row.id} ${row.state} · ${row.elapsed}${row.extra ? ` · ${row.extra}` : ""}`;
  return truncateToWidth(line, safe);
}

/** Header plus rows, every line within the width. */
export function formatTasksList(rows: TasksRow[], width: number): string[] {
  const safe = Math.max(20, Math.floor(width) || 80);
  const out = [truncateToWidth("tasks", safe)];
  if (rows.length === 0) {
    out.push(truncateToWidth("Nothing running.", safe));
    return out;
  }
  for (const row of rows) out.push(formatTasksRow(row, safe));
  return out;
}

export interface OutputView {
  id: string;
  kind: "task" | "monitor";
  label: string;
  running: boolean;
  lines: string[];
  totalLines: number;
  truncated: boolean;
}

/** Tail lines shown per output view; the file itself is unbounded (64 MiB cap). */
export const OUTPUT_TAIL_LINES = 50;

/**
 * Tail one record's output file, bounded. Display-only: ANSI and C0
 * controls are stripped so a hostile child cannot redraw the operator's
 * terminal; the file on disk is untouched.
 */
export async function readOutput(
  store: Pick<BackgroundStore, "get" | "getMonitor">,
  id: string,
  maxLines: number = OUTPUT_TAIL_LINES,
): Promise<OutputView> {
  const task = store.get(id);
  const monitor = task ? undefined : store.getMonitor(id);
  if (!task && !monitor) throw new Error(`[background] unknown task ${JSON.stringify(id)}.`);
  const outputFile = (task ?? monitor)?.outputFile ?? "";
  let raw: string;
  try {
    raw = readFileSync(outputFile, "utf8");
  } catch (error) {
    throw new Error(`[background] could not read output file for ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const all = raw.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const totalLines = all.length;
  const tail = all.slice(Math.max(0, totalLines - Math.max(1, maxLines)));
  const lines = tail.map((line) => sanitizeModelText(line, Number.POSITIVE_INFINITY));
  return {
    id,
    kind: task ? "task" : "monitor",
    label: (task?.description ?? monitor?.description ?? "") || id,
    running: task ? task.status === "running" : monitor?.status === "armed" || monitor?.status === "event",
    lines,
    totalLines,
    truncated: totalLines > lines.length,
  };
}

export interface TasksOverlayActions {
  stop(id: string): Promise<string>;
  rerun(id: string): Promise<string>;
  clear(): Promise<string>;
  readOutput(id: string): Promise<OutputView>;
}

export interface TasksOverlayOptions {
  store: Pick<BackgroundStore, "list" | "listMonitors" | "subscribe" | "markSeen">;
  theme: { fg(color: string, text: string): string; bold(text: string): string };
  close: () => void;
  requestRender?: () => void;
  actions: TasksOverlayActions;
  now?: () => number;
}

const OVERLAY_VISIBLE_ROWS = 16;

interface OutputState {
  view: OutputView;
  scroll: number;
  following: boolean;
}

/** /tasks overlay: the list, an output/follow view, and the action keys. */
export class TasksOverlay {
  private selected = 0;
  private listScroll = 0;
  private mode: "list" | "output" = "list";
  private output: OutputState | null = null;
  private status = "";
  private readonly unsubscribe: () => void;

  constructor(private readonly options: TasksOverlayOptions) {
    this.unsubscribe = options.store.subscribe(() => this.onStoreChange());
  }

  dispose(): void {
    this.unsubscribe();
  }

  private rows(): TasksRow[] {
    return buildTasksRows(this.options.store.list(), this.options.store.listMonitors(), this.options.now?.() ?? Date.now());
  }

  private rerender(): void {
    try {
      this.options.requestRender?.();
    } catch {
      /* render is best effort */
    }
  }

  private onStoreChange(): void {
    if (this.mode === "output" && this.output?.following) {
      const id = this.output.view.id;
      this.options.actions
        .readOutput(id)
        .then((view) => {
          if (this.mode === "output" && this.output?.view.id === id) {
            // Follow mode pins the tail: a live view always shows the newest lines.
            this.output = { view, scroll: 0, following: view.running };
            this.rerender();
          }
        })
        .catch(() => {
          /* a cleared record ends the follow below */
        });
    }
    const count = this.rows().length;
    if (this.selected >= count) this.selected = Math.max(0, count - 1);
    this.rerender();
  }

  private setStatus(text: string): void {
    this.status = text;
    this.rerender();
  }

  private selectedRow(): TasksRow | undefined {
    return this.rows()[this.selected];
  }

  private openOutput(row: TasksRow): void {
    this.mode = "output";
    this.output = null;
    this.status = `Loading ${row.id}…`;
    this.rerender();
    this.options.store.markSeen(row.id);
    this.options.actions.readOutput(row.id).then(
      (view) => {
        if (this.mode !== "output") return;
        this.output = { view, scroll: 0, following: view.running };
        this.status = "";
        this.rerender();
      },
      (error) => {
        if (this.mode !== "output") return;
        this.output = null;
        this.setStatus(error instanceof Error ? error.message : String(error));
      },
    );
  }

  private runAction(kind: "stop" | "rerun" | "clear", row?: TasksRow): void {
    const promise =
      kind === "clear" ? this.options.actions.clear() : kind === "stop" && row ? this.options.actions.stop(row.id) : row ? this.options.actions.rerun(row.id) : Promise.resolve("");
    promise.then(
      (text) => this.setStatus(text),
      (error) => this.setStatus(error instanceof Error ? error.message : String(error)),
    );
  }

  handleInput(data: string): void {
    if (this.mode === "output") {
      if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
        this.mode = "list";
        this.output = null;
        this.status = "";
        this.rerender();
        return;
      }
      if (!this.output) return;
      const total = this.output.view.lines.length;
      const maxScroll = Math.max(0, total - OVERLAY_VISIBLE_ROWS);
      if (matchesKey(data, "up")) this.output.scroll = Math.min(this.output.scroll + 1, maxScroll);
      else if (matchesKey(data, "down")) this.output.scroll = Math.max(0, this.output.scroll - 1);
      else if (matchesKey(data, "pageUp")) this.output.scroll = Math.min(this.output.scroll + OVERLAY_VISIBLE_ROWS, maxScroll);
      else if (matchesKey(data, "pageDown")) this.output.scroll = Math.max(0, this.output.scroll - OVERLAY_VISIBLE_ROWS);
      else if (matchesKey(data, "home")) this.output.scroll = maxScroll;
      else if (matchesKey(data, "end")) this.output.scroll = 0;
      else return;
      this.rerender();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.dispose();
      this.options.close();
      return;
    }
    const count = this.rows().length;
    if (matchesKey(data, "up")) {
      this.selected = count === 0 ? 0 : (this.selected + count - 1) % count;
      this.rerender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = count === 0 ? 0 : (this.selected + 1) % count;
      this.rerender();
      return;
    }
    if (matchesKey(data, "enter")) {
      const row = this.selectedRow();
      if (row) this.openOutput(row);
      return;
    }
    if (matchesKey(data, "s")) {
      const row = this.selectedRow();
      if (row) this.runAction("stop", row);
      return;
    }
    if (matchesKey(data, "r")) {
      const row = this.selectedRow();
      if (row) this.runAction("rerun", row);
      return;
    }
    if (matchesKey(data, "c")) {
      this.runAction("clear");
    }
  }

  render(width: number): string[] {
    const { theme } = this.options;
    const safe = Math.max(20, Math.floor(width) || 80);
    const cut = (line: string): string => truncateToWidth(line, safe);
    if (this.mode === "output") {
      const out = [cut(theme.bold(`output ${this.output?.view.id ?? ""}`)), ""];
      const view = this.output?.view;
      if (!view) {
        out.push(cut(theme.fg("dim", this.status || "Loading…")));
      } else {
        const total = view.lines.length;
        const maxScroll = Math.max(0, total - OVERLAY_VISIBLE_ROWS);
        const scroll = Math.min(this.output?.scroll ?? 0, maxScroll);
        const visible = view.lines.slice(Math.max(0, total - OVERLAY_VISIBLE_ROWS - scroll), total - scroll || total);
        for (const line of visible) out.push(cut(line));
        if (view.truncated) out.push(cut(theme.fg("dim", `… showing the last ${view.lines.length} of ${view.totalLines} lines`)));
        if (view.running) out.push(cut(theme.fg("dim", "following — new lines appear live · esc back")));
      }
      if (this.status && view) out.push(cut(theme.fg("dim", this.status)));
      out.push(cut(theme.fg("dim", "esc back · ↑↓ scroll")));
      return out.map((line) => (visibleWidth(line) > safe ? cut(line) : line));
    }
    const rows = this.rows();
    const maxOffset = Math.max(0, rows.length - OVERLAY_VISIBLE_ROWS);
    if (this.selected < this.listScroll) this.listScroll = this.selected;
    if (this.selected >= this.listScroll + OVERLAY_VISIBLE_ROWS) this.listScroll = this.selected - OVERLAY_VISIBLE_ROWS + 1;
    this.listScroll = Math.min(this.listScroll, maxOffset);
    const out = [cut(theme.bold("tasks")), ""];
    if (rows.length === 0) {
      out.push(cut(theme.fg("dim", "Nothing running.")));
    } else {
      const visible = rows.slice(this.listScroll, this.listScroll + OVERLAY_VISIBLE_ROWS);
      visible.forEach((row, i) => {
        const marker = this.listScroll + i === this.selected ? "→ " : "  ";
        out.push(cut(`${marker}${formatTasksRow(row, safe - 2)}`));
      });
      if (rows.length > OVERLAY_VISIBLE_ROWS) {
        out.push(cut(theme.fg("dim", `… ${rows.length - OVERLAY_VISIBLE_ROWS} more · ↑↓ move`)));
      }
    }
    if (this.status) out.push(cut(theme.fg("dim", this.status)));
    out.push(cut(theme.fg("dim", "enter output · s stop · r rerun · c clear · esc closes")));
    return out;
  }
}

export interface TasksCommandCtx {
  mode?: string;
  hasUI?: boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    custom?: <T>(factory: (...args: any[]) => any, options?: Record<string, unknown>) => Promise<T>;
  };
}

export interface TasksCommandDeps {
  store: BackgroundStore;
  stopTask(id: string): Promise<string>;
  rerunTask(id: string): Promise<string>;
  readOutputView?(id: string): Promise<OutputView>;
  now?: () => number;
}

/** Open the overlay on a TUI, or notify the plain list anywhere else. */
export async function openTasksList(
  ctx: TasksCommandCtx,
  deps: TasksCommandDeps,
): Promise<void> {
  deps.store.markAllSeen();
  const custom = ctx.ui.custom;
  const canOverlay = ctx.mode === "tui" && ctx.hasUI === true && typeof custom === "function";
  if (!canOverlay) {
    const rows = buildTasksRows(deps.store.list(), deps.store.listMonitors(), deps.now?.() ?? Date.now());
    ctx.ui.notify(formatTasksList(rows, 120).join("\n"), "info");
    return;
  }
  const actions: TasksOverlayActions = {
    stop: (id) => deps.stopTask(id),
    rerun: (id) => deps.rerunTask(id),
    clear: async () => {
      const cleared = deps.store.clearFinished();
      const total = cleared.tasks + cleared.monitors;
      return `Cleared ${total} finished (${cleared.tasks} tasks, ${cleared.monitors} monitors).`;
    },
    readOutput: (id) => (deps.readOutputView ? deps.readOutputView(id) : readOutput(deps.store, id)),
  };
  try {
    await custom<void>(
      (tui: any, theme: any, _keybindings: any, done: (result: void) => void) => {
        const overlay = new TasksOverlay({
          store: deps.store,
          theme,
          close: () => {
            done(undefined);
          },
          requestRender: () => {
            try {
              tui.requestRender();
            } catch {
              /* render is best effort */
            }
          },
          actions,
          ...(deps.now ? { now: deps.now } : {}),
        });
        return overlay as any;
      },
      { overlay: true, overlayOptions: { width: 88 } },
    );
  } catch {
    const rows = buildTasksRows(deps.store.list(), deps.store.listMonitors(), deps.now?.() ?? Date.now());
    ctx.ui.notify(formatTasksList(rows, 120).join("\n"), "info");
  }
}

/** Run one /tasks invocation: overlay or text form. Never throws. */
export async function runTasksCommand(args: string, ctx: TasksCommandCtx, deps: TasksCommandDeps): Promise<void> {
  const parsed = parseTasksArgs(args);
  switch (parsed.action) {
    case "open":
      await openTasksList(ctx, deps);
      return;
    case "clear": {
      const cleared = deps.store.clearFinished();
      const total = cleared.tasks + cleared.monitors;
      ctx.ui.notify(`Cleared ${total} finished (${cleared.tasks} tasks, ${cleared.monitors} monitors).`, "info");
      return;
    }
    case "stop":
      try {
        ctx.ui.notify(await deps.stopTask(parsed.id), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
      return;
    case "rerun":
      try {
        ctx.ui.notify(await deps.rerunTask(parsed.id), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
      return;
    case "output": {
      try {
        const view = deps.readOutputView ? await deps.readOutputView(parsed.id) : await readOutput(deps.store, parsed.id);
        deps.store.markSeen(parsed.id);
        const lines = [...view.lines];
        if (view.truncated) lines.push(`… showing the last ${view.lines.length} of ${view.totalLines} lines`);
        ctx.ui.notify(lines.join("\n") || "(empty output)", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
      return;
    }
    case "usage":
      ctx.ui.notify(TASKS_USAGE, "info");
      return;
  }
}

export interface TasksCommandPi {
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }): void;
}

/** Register /tasks and nothing else. No bash/read/edit/write/find/grep/ls. */
export function registerTasksCommand(pi: TasksCommandPi, deps: TasksCommandDeps): void {
  pi.registerCommand(TASKS_COMMAND, {
    description: "List background runs and monitors (/tasks stop|output|rerun <id>, /tasks clear)",
    handler: async (args, ctx) => {
      await runTasksCommand(args, ctx as TasksCommandCtx, deps);
    },
  });
}
