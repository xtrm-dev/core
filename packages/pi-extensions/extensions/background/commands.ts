/**
 * /bg operator surface (B3 CORE-2441, ADR rev 2 B2 + amendment 1).
 *
 * One list of background runs and monitors. Row: state glyph, command or
 * description, id, elapsed, output size or event count. Keys (matched with
 * pi-tui matchesKey, never literal escapes): enter shows or follows the
 * output, s stops, r reruns (finished only; a running row refuses with
 * "stop it first"), c clears finished rows, esc or q closes. Text forms for
 * scripts and muscle memory: /bg stop|output|rerun <id>, /bg clear.
 * Theme tokens only (bold header, dim hints); no new colours, no ANSI in
 * model payloads (this module builds none).
 *
 * Opening the list marks every record seen, so the indicator's "! N failed"
 * clears once the operator looked. Viewing one record's output marks it.
 */

import { closeSync, openSync, readFileSync, readSync, statSync, watch } from "node:fs";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { fitToWidth } from "./widget.ts";

import {
  formatElapsed,
  sanitizeModelText,
  type BackgroundMonitorRecord,
  type BackgroundStore,
  type BackgroundTaskRecord,
} from "./store.ts";

/** Bare command name: no xtrm- slug. */
export const TASKS_COMMAND = "bg";

export const TASKS_USAGE = [
  "/bg — one list of background runs and monitors",
  "/bg stop <id> — stop a running task or monitor",
  "/bg output <id> — show the tail of its output file",
  "/bg rerun <id> — run the same command again (finished rows only)",
  "/bg clear — evict finished rows",
  "Keys: enter shows or follows the output · s stops · r reruns · c clears finished · esc closes",
].join("\n");

export type TasksAction =
  | { action: "open" }
  | { action: "stop"; id: string }
  | { action: "output"; id: string }
  | { action: "rerun"; id: string }
  | { action: "clear" }
  | { action: "usage" };

/** Split "/bg <verb> <id>" into an action; anything unknown is usage. */
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

/**
 * Operator-row label hygiene (F3): the description/command is
 * model-controlled, so it renders sanitized — CSI and OSC sequences
 * stripped, newlines collapsed to spaces, length bounded. A probe label
 * carrying an OSC title or a CSI clear must arrive as inert text.
 */
const OSC_PATTERN = "\x1b\][^\x07\x1b]*(?:\x07|\x1b\\\\)";

/** C1 controls (U+0080-U+009F), including the single-char CSI U+009B. */
const C1_PATTERN = "[\u0080-\u009f]";

export function sanitizeLabel(value: string, maxLength = 120): string {
  const noOsc = value.replace(new RegExp(OSC_PATTERN, "g"), "");
  const noC1 = noOsc.replace(new RegExp(C1_PATTERN, "g"), "");
  const singleLine = noC1.replace(/[\r\n]+/g, " ");
  const clean = sanitizeModelText(singleLine, maxLength);
  return clean.length > 0 ? clean : "(unnamed)";
}

function taskRow(record: BackgroundTaskRecord, now: number): TasksRow {
  const size = outputSizeExtra(record.outputFile);
  return {
    kind: "task",
    id: record.id,
    glyph: stateGlyph("task", record.status),
    state: record.status,
    label: sanitizeLabel(record.description || record.command || record.id),
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
    label: sanitizeLabel(record.description || record.command || record.wsUrl || record.id),
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
  return fitToWidth(line, safe);
}

/**
 * Header plus rows, every line within the width. droppedUnseen names
 * evicted unseen failures (N6) so the indicator never silently
 * undercounts them.
 */
export function formatTasksList(rows: TasksRow[], width: number, droppedUnseen = 0): string[] {
  const safe = Math.max(20, Math.floor(width) || 80);
  const out = [fitToWidth("tasks", safe)];
  if (droppedUnseen > 0) {
    out.push(
      fitToWidth(
        droppedUnseen === 1 ? "+1 earlier failure dropped" : `+${droppedUnseen} earlier failures dropped`,
        safe,
      ),
    );
  }
  if (rows.length === 0) {
    out.push(fitToWidth("Nothing running.", safe));
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
  /** Exact line count for small files; null when the tail window cut the head off. */
  totalLines: number | null;
  truncated: boolean;
  /** Byte offset where the tail read stopped; the follower starts here (N3). */
  endOffset: number;
}

/** Tail lines shown per output view; the file itself is unbounded (64 MiB cap). */
export const OUTPUT_TAIL_LINES = 50;

/** Tail window for opening an output view: the head past this is never loaded. */
export const OUTPUT_TAIL_WINDOW_BYTES = 256 * 1024;

/** Cap per follower update: live lines stream in bounded chunks. */
export const FOLLOW_MAX_BYTES_PER_UPDATE = 256 * 1024;

/** Cap on lines kept per output view; older live lines drop off the top. */
export const OUTPUT_VIEW_MAX_LINES = 500;

/** Follow poll fallback interval (N3): only while watching is unavailable. */
export const FOLLOW_POLL_INTERVAL_MS = 500;

/**
 * Tail one record's output file, bounded. Display-only: ANSI and C0
 * controls are stripped so a hostile child cannot redraw the operator's
 * terminal; the file on disk is untouched. Reads at most the last
 * OUTPUT_TAIL_WINDOW_BYTES (never the whole 64 MiB file on the TUI
 * thread); totalLines is exact for small files, null when the window cut
 * the head off.
 */
export interface TailResult {
  lines: string[];
  totalLines: number | null;
  truncated: boolean;
  endOffset: number;
}

export function readTailLines(outputFile: string, maxLines: number, windowBytes: number = OUTPUT_TAIL_WINDOW_BYTES): TailResult {
  let size: number;
  try {
    size = statSync(outputFile).size;
  } catch (error) {
    throw new Error(`[background] could not read output file ${outputFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const start = Math.max(0, size - Math.max(1, windowBytes));
  const fd = openSync(outputFile, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const raw = buffer.subarray(0, read).toString("utf8");
    const all = raw.split("\n");
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    const complete = start > 0 ? all.slice(1) : all;
    const totalLines = start > 0 ? null : complete.length;
    const tail = complete.slice(Math.max(0, complete.length - Math.max(1, maxLines)));
    return {
      lines: tail.map((line) => sanitizeModelText(line, Number.POSITIVE_INFINITY)),
      totalLines,
      truncated: totalLines === null || totalLines > tail.length,
      endOffset: size,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Append-only follower for one output file (F1). Tracks a byte offset and
 * a leftover partial line; each update reads only the new tail bytes
 * (capped), never the whole file. A shrunk file resets to zero.
 */
export interface OutputFollower {
  update(): string[];
  readonly offset: number;
  close(): void;
}

export function followOutputFile(
  outputFile: string,
  fromOffset: number,
  opts: { maxBytesPerUpdate?: number } = {},
): OutputFollower {
  const cap = Math.max(1024, opts.maxBytesPerUpdate ?? FOLLOW_MAX_BYTES_PER_UPDATE);
  const fd = openSync(outputFile, "r");
  let offset = Math.max(0, fromOffset);
  let leftover = "";
  let closed = false;
  return {
    get offset() {
      return offset;
    },
    update(): string[] {
      if (closed) return [];
      let size: number;
      try {
        size = statSync(outputFile).size;
      } catch {
        return [];
      }
      if (size < offset) {
        offset = 0;
        leftover = "";
      }
      if (size <= offset) return [];
      const want = Math.min(size - offset, cap);
      const buffer = Buffer.alloc(want);
      let read = 0;
      while (read < want) {
        const n = readSync(fd, buffer, read, want - read, offset + read);
        if (n <= 0) break;
        read += n;
      }
      offset += read;
      const text = leftover + buffer.subarray(0, read).toString("utf8");
      const parts = text.split("\n");
      leftover = parts.pop() ?? "";
      return parts.map((line) => sanitizeModelText(line, Number.POSITIVE_INFINITY));
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}

export function outputFileOf(store: Pick<BackgroundStore, "get" | "getMonitor">, id: string): string | null {
  const task = store.get(id);
  if (task) return task.outputFile || null;
  const monitor = store.getMonitor(id);
  if (monitor) return monitor.outputFile || null;
  return null;
}

export async function readOutput(
  store: Pick<BackgroundStore, "get" | "getMonitor">,
  id: string,
  maxLines: number = OUTPUT_TAIL_LINES,
): Promise<OutputView> {
  const task = store.get(id);
  const monitor = task ? undefined : store.getMonitor(id);
  if (!task && !monitor) throw new Error(`[background] unknown task ${JSON.stringify(id)}.`);
  const outputFile = (task ?? monitor)?.outputFile ?? "";
  let tail: TailResult;
  try {
    tail = readTailLines(outputFile, maxLines);
  } catch (error) {
    throw new Error(`[background] could not read output file for ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    id,
    kind: task ? "task" : "monitor",
    label: sanitizeLabel((task?.description ?? monitor?.description ?? "") || id),
    running: task ? task.status === "running" : monitor?.status === "armed" || monitor?.status === "event",
    lines: tail.lines,
    totalLines: tail.totalLines,
    truncated: tail.truncated,
    endOffset: tail.endOffset,
  };
}

export interface TasksOverlayActions {
  stop(id: string): Promise<string>;
  rerun(id: string): Promise<string>;
  clear(): Promise<string>;
  readOutput(id: string): Promise<OutputView>;
}

export interface TasksOverlayOptions {
  store: Pick<BackgroundStore, "droppedUnseenFailures" | "get" | "getMonitor" | "list" | "listMonitors" | "subscribe" | "markSeen">;
  theme: { fg(color: string, text: string): string; bold(text: string): string };
  close: () => void;
  requestRender?: () => void;
  actions: TasksOverlayActions;
  now?: () => number;
  /** Follow source for a running record; null means no live follow. Tests inject a fake. */
  createFollower?: (id: string, fromOffset: number) => OutputFollower | null;
  /** File watcher; tests inject a manual trigger. Defaults to node:fs watch. */
  watchFile?: (path: string, hooks: { onChange: () => void; onError: () => void }) => { close(): void };
}

const OVERLAY_VISIBLE_ROWS = 16;

interface OutputState {
  view: OutputView;
  scroll: number;
  following: boolean;
  follower: OutputFollower | null;
  watcher: { close(): void } | null;
}

/** /bg overlay: the list, an output/follow view, and the action keys. */
export class TasksOverlay {
  private selected = 0;
  private listScroll = 0;
  private mode: "list" | "output" = "list";
  private output: OutputState | null = null;
  private status = "";
  private disposed = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: TasksOverlayOptions) {
    this.unsubscribe = options.store.subscribe(() => this.onStoreChange());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownFollow();
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

  private defaultFollower(id: string, fromOffset: number): OutputFollower | null {
    if (this.options.createFollower) return this.options.createFollower(id, fromOffset);
    const file = outputFileOf(this.options.store, id);
    if (!file) return null;
    try {
      return followOutputFile(file, fromOffset);
    } catch {
      return null;
    }
  }

  private defaultWatch(
    path: string,
    hooks: { onChange: () => void; onError: () => void },
  ): { close(): void } {
    const watchFile = this.options.watchFile;
    if (watchFile) {
      // An injected watcher that throws degrades to the poll fallback
      // through onError, never to a silent static view.
      try {
        return watchFile(path, hooks);
      } catch {
        hooks.onError();
        return { close: () => {} };
      }
    }
    try {
      const watcher = watch(path, () => hooks.onChange());
      watcher.on("error", () => hooks.onError());
      return {
        close: () => {
          try {
            watcher.close();
          } catch {
            /* already closed */
          }
        },
      };
    } catch {
      hooks.onError();
      return { close: () => {} };
    }
  }

  private teardownFollow(): void {
    this.stopPoll();
    if (!this.output) return;
    this.output.following = false;
    try {
      this.output.watcher?.close();
    } catch {
      /* already closed */
    }
    try {
      this.output.follower?.close();
    } catch {
      /* already closed */
    }
    this.output.watcher = null;
    this.output.follower = null;
  }

  /**
   * Bounded unref'd poll fallback (N3): when the file watcher throws or
   * errors, follow degrades to a 500 ms poll instead of going silently
   * stale. Stops with the follow.
   */
  private startPoll(id: string): void {
    if (this.pollTimer || this.disposed) return;
    const timer = setInterval(() => {
      if (!this.output?.following || this.disposed) {
        this.stopPoll();
        return;
      }
      this.pumpFollow(id);
    }, FOLLOW_POLL_INTERVAL_MS);
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* runtimes without unref */
    }
    this.pollTimer = timer;
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private onWatcherError(id: string): void {
    if (this.mode !== "output" || this.output?.view.id !== id || !this.output?.following) return;
    this.setStatus("file watch unavailable — polling for new lines");
    this.startPoll(id);
  }

  /**
   * Drain new tail bytes into the view (F1). At terminal state, drain
   * until the follower is empty: one 256 KiB update may end mid-burst and
   * the terminal notice must not drop the tail. Still bounded per tick
   * (at most 8 updates) so a firehose cannot wedge the TUI thread. Ends
   * the follow once the record is terminal and drained.
   */
  private pumpFollow(id: string): void {
    const state = this.mode === "output" && this.output?.view.id === id ? this.output : null;
    if (!state || !state.following || !state.follower) return;
    const terminal = !this.isRunning(id);
    let guard = 0;
    let broken = false;
    for (;;) {
      let fresh: string[] = [];
      try {
        fresh = state.follower.update();
      } catch {
        broken = true;
        break;
      }
      if (fresh.length > 0) {
        state.view.lines.push(...fresh);
        if (state.view.lines.length > OUTPUT_VIEW_MAX_LINES) {
          state.view.lines.splice(0, state.view.lines.length - OUTPUT_VIEW_MAX_LINES);
          state.view.truncated = true;
        }
        if (typeof state.view.totalLines === "number") state.view.totalLines += fresh.length;
        state.scroll = 0;
      }
      guard += 1;
      if (fresh.length === 0 || !terminal || guard >= 8) break;
    }
    if (broken || terminal) this.teardownFollow();
    this.rerender();
  }

  private isRunning(id: string): boolean {
    const task = this.options.store.get(id);
    if (task) return task.status === "running";
    const monitor = this.options.store.getMonitor(id);
    if (monitor) return monitor.status === "armed" || monitor.status === "event";
    return false;
  }

  private onStoreChange(): void {
    // Store events still refresh a follow (a notice may carry the terminal
    // state), but the file watcher below owns the live lines (F1).
    if (this.mode === "output" && this.output?.following) {
      this.pumpFollow(this.output.view.id);
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
    this.teardownFollow();
    this.mode = "output";
    this.output = null;
    this.status = `Loading ${row.id}…`;
    this.rerender();
    this.options.store.markSeen(row.id);
    this.options.actions.readOutput(row.id).then(
      (view) => {
        // N2: a dispose during the async load must not re-arm the follow
        // (leaked follower fd and watcher, rendering after death).
        if (this.disposed || this.mode !== "output") return;
        const state: OutputState = { view, scroll: 0, following: false, follower: null, watcher: null };
        this.output = state;
        this.status = "";
        // F1: a running record streams its file. The watcher owns the live
        // lines; the follower reads only new tail bytes, never the whole
        // file. Either half failing degrades to a static snapshot (or the
        // N3 poll fallback, which sets its own status below).
        if (view.running) {
          try {
            // N3: start at the tail read's end offset, not a fresh stat.
            const follower = this.defaultFollower(row.id, view.endOffset);
            if (follower) {
              state.follower = follower;
              state.following = true;
              const file = outputFileOf(this.options.store, row.id);
              if (file) {
                state.watcher = this.defaultWatch(file, {
                  onChange: () => this.pumpFollow(row.id),
                  onError: () => this.onWatcherError(row.id),
                });
              }
            }
          } catch {
            this.teardownFollow();
          }
        }
        this.rerender();
      },
      (error) => {
        if (this.disposed || this.mode !== "output") return;
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
        this.teardownFollow();
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
    const cut = (line: string): string => fitToWidth(line, safe);
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
        if (view.truncated) {
          out.push(
            cut(
              theme.fg(
                "dim",
                view.totalLines === null
                  ? `… showing the last ${view.lines.length} lines (older lines not counted)`
                  : `… showing the last ${view.lines.length} of ${view.totalLines} lines`,
              ),
            ),
          );
        }
        if (this.output?.following) out.push(cut(theme.fg("dim", "following — new lines appear live · esc back")));
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
    const dropped = this.options.store.droppedUnseenFailures();
    if (dropped > 0) {
      out.push(cut(theme.fg("dim", dropped === 1 ? "+1 earlier failure dropped" : `+${dropped} earlier failures dropped`)));
    }
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
    ctx.ui.notify(formatTasksList(rows, 120, deps.store.droppedUnseenFailures()).join("\n"), "info");
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
    ctx.ui.notify(formatTasksList(rows, 120, deps.store.droppedUnseenFailures()).join("\n"), "info");
  }
}

/** Run one /bg invocation: overlay or text form. Never throws. */
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
        if (view.truncated) {
          lines.push(
            view.totalLines === null
              ? `… showing the last ${view.lines.length} lines (older lines not counted)`
              : `… showing the last ${view.lines.length} of ${view.totalLines} lines`,
          );
        }
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

/** Register /bg and nothing else. No bash/read/edit/write/find/grep/ls. */
export function registerTasksCommand(pi: TasksCommandPi, deps: TasksCommandDeps): void {
  pi.registerCommand(TASKS_COMMAND, {
    description: "List background runs and monitors (/bg stop|output|rerun <id>, /bg clear)",
    handler: async (args, ctx) => {
      await runTasksCommand(args, ctx as TasksCommandCtx, deps);
    },
  });
}
