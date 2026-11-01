/**
 * Draws and routes clicks for the folded tool groups of tool-groups.ts.
 * Content always comes from the caller's own render: L1 is the call's
 * collapsed render, L2 its expanded render. This layer only decides
 * visibility, the summary line and the indentation.
 *
 * Adapted from pi-tidy's tool-group-view.ts (MIT License, Copyright (c) 2026
 * Andy8647, https://github.com/Andy8647/pi-tidy).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "./format";
import {
  closeGroup,
  groupSummaryFor,
  isGroupedPlan,
  openGroup,
  planFor,
  takeLateJoin,
  thinkingCarrierFor,
  type GroupSummary,
  type ToolLike,
  type ViewPlan,
} from "./tool-groups";

export interface GroupThemeLike {
  fg(token: string, text: string): string;
  /** pi's dependable route to weight; test stubs have only `fg`. */
  style?(text: string, attrs: { bold?: boolean; fg?: string }): string;
}

export interface GroupedTool extends ToolLike {
  ui?: { requestRender?(): void };
  /** pi's image children of an expanded result; their lines must start at column 0. */
  imageComponents?: unknown[];
  setExpanded(expanded: boolean): void;
}

/**
 * Tools that never fold: their row stays where it is and ends the group.
 * Messages to other agents, background jobs and specialist lifecycle calls act
 * outside the reply; read-only checks on them (bg_status, specialist_result,
 * ...) fold like any other call.
 */
export const PINNED_TOOLS = new Set([
  "SendMessage",
  "intercom",
  "ask_coordinator",
  "BashBackground",
  "Monitor",
  "BackgroundStop",
  "bg_run",
  "bg_kill",
  "specialist_dispatch",
  "specialist_reply",
  "specialist_steer",
  "specialist_stop_activation",
]);

/** Summary phrases: calls of the same kind read as one activity. The noun is the bold part. */
interface Activity {
  verb?: string;
  noun: string;
}

const SHELL: Activity = { verb: "used", noun: "shell" };
const CODE: Activity = { verb: "ran", noun: "code" };
const SEARCHED: Activity = { noun: "searched" };
const JOBS: Activity = { verb: "checked", noun: "jobs" };
const SPECIALISTS: Activity = { verb: "checked", noun: "specialists" };

const ACTIVITY: Record<string, Activity> = {
  bash: SHELL,
  python: CODE,
  codemode: CODE,
  code: CODE,
  read: { noun: "read" },
  edit: { noun: "edited" },
  write: { noun: "wrote" },
  grep: SEARCHED,
  find: SEARCHED,
  ls: SEARCHED,
  ast_grep: SEARCHED,
  search_context: SEARCHED,
  tool_search: SEARCHED,
  bg_status: JOBS,
  bg_logs: JOBS,
  specialist_status: SPECIALISTS,
  specialist_result: SPECIALISTS,
  specialist_feed: SPECIALISTS,
  specialist_list: SPECIALISTS,
};

function activity(toolName: string): Activity {
  if (ACTIVITY[toolName]) return ACTIVITY[toolName]!;
  if (toolName.startsWith("gitnexus_")) return { verb: "used", noun: "GitNexus" };
  return { verb: "used", noun: toolName };
}

function bold(theme: GroupThemeLike, token: string, text: string): string {
  return theme.style ? theme.style(text, { bold: true, fg: token }) : theme.fg(token, text);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function times(count: number): string {
  return count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
}

const INDENT = "  ";
const INDENT_CELLS = 2;

/** One repaint per tool when the live row is due to show thinking. */
const revealScheduled = new WeakSet<object>();

function scheduleReveal(tool: GroupedTool, delayMs: number): void {
  if (revealScheduled.has(tool)) return;
  revealScheduled.add(tool);
  const timer = setTimeout(() => {
    revealScheduled.delete(tool);
    tool.ui?.requestRender?.();
  }, delayMs + 16);
  (timer as { unref?: () => void }).unref?.();
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** A leading `●` with its escapes around it, followed by a space. */
const LEADING_DOT = /^((?:\x1b\[[0-9;]*m)*)●((?:\x1b\[[0-9;]*m)* )/;

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Drops the two leading blank cells, keeping the escapes around them. */
function dropTwoCells(line: string): string {
  return line.replace(/^((?:\x1b\[[0-9;]*m)*) ((?:\x1b\[[0-9;]*m)*) /, "$1$2");
}

function dropLeadingBlanks(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && visibleWidth(lines[start]!.trim()) === 0) start++;
  return start === 0 ? lines : lines.slice(start);
}

/**
 * The summary line, as a sentence about what the reply did:
 * `▸ Used shell 3 times, read twice, searched 4 times  1 failed  4.2s`.
 * The arrow sits in the two columns every ultracompact row reserves for its
 * marker, so the sentence lines up with the rows under it.
 *
 * Every part sits at toolTitle; the tool or action is bold, so the eye lands on
 * what was used. Commas join the activities only; the outcome follows as row
 * metadata does, two spaces apart. The time is the group's elapsed total and
 * shows once it closes (`live: false`), so nothing ticks. With a `width`, the
 * activities clip first, so a failure always stays readable.
 */
export function formatGroupHeader(
  summary: GroupSummary,
  state: "closed" | "open",
  theme: GroupThemeLike,
  width?: number,
  live = false,
): string {
  const counts = new Map<string, { activity: Activity; count: number }>();
  for (const entry of summary.breakdown) {
    const kind = activity(entry.name);
    const key = `${kind.verb ?? ""} ${kind.noun}`;
    const known = counts.get(key);
    if (known) known.count += entry.count;
    else counts.set(key, { activity: kind, count: entry.count });
  }
  const entries = [...counts.values()].sort((a, b) => b.count - a.count);
  const phrases = entries.map(({ activity: kind, count }, index) => {
    // "Used shell 4 times, GitNexus twice": a run of `used …` phrases says the
    // verb once, at the start of the run.
    const repeated = kind.verb === "used" && entries[index - 1]?.activity.verb === "used";
    const verb = repeated ? undefined : kind.verb;
    const noun = index === 0 && !verb ? capitalize(kind.noun) : kind.noun;
    const lead = verb ? `${index === 0 ? capitalize(verb) : verb} ` : "";
    return `${lead ? theme.fg("toolTitle", lead) : ""}${bold(theme, "toolTitle", noun)}${theme.fg("toolTitle", ` ${times(count)}`)}`;
  });
  const activities = phrases.join(theme.fg("dim", ", "));
  const parts: string[] = [];
  if (summary.failed > 0) parts.push(theme.fg("error", `${summary.failed} failed`));
  const elapsed = !live && summary.elapsedMs !== undefined && summary.elapsedMs >= 1000 ? formatDuration(summary.elapsedMs) : undefined;
  if (elapsed) parts.push(theme.fg("dim", elapsed));
  const tail = parts.map((part) => `  ${part}`).join("");
  const room = width === undefined ? Infinity : width - 2 - visibleWidth(tail);
  const head = visibleWidth(activities) > room ? truncateToWidth(activities, Math.max(1, room), "…") : activities;
  return `${theme.fg("dim", state === "closed" ? "▸" : "▾")} ${head}${tail}`;
}

/** Row geometry of the last grouped render, for click routing. */
interface Geometry {
  plan: ViewPlan;
  /** Index of the summary line, or -1. */
  headerRow: number;
  /** First and past-last row of the call's own lines. */
  bodyFrom: number;
  bodyTo: number;
}

const geometry = new WeakMap<object, Geometry>();

/** A component of the live group, the handle for the repaint at the end of a run. */
let liveTool: GroupedTool | undefined;

export interface GroupViewOptions {
  /** A carrier's thinking as one row on the two-column grid, if it has any. */
  thinkingRow?: (carrier: object) => string | undefined;
}

/**
 * The tool's lines while folding is on, or `undefined` when it renders as usual
 * (pinned, a group of one, or not grouped). `own` is the tool's regular render.
 */
export function renderGroupedTool(
  tool: GroupedTool,
  width: number,
  theme: GroupThemeLike,
  own: (width: number) => string[],
  options: GroupViewOptions = {},
): string[] | undefined {
  const plan = planFor(tool, PINNED_TOOLS.has(tool.toolName));
  if (plan.live) liveTool = tool;
  if (takeLateJoin()) tool.ui?.requestRender?.();
  if (plan.revealIn !== undefined) scheduleReveal(tool, plan.revealIn);
  if (!isGroupedPlan(plan)) {
    geometry.delete(tool);
    return undefined;
  }

  const lines: string[] = [];
  let headerRow = -1;
  if (plan.header) {
    const summary = groupSummaryFor(tool);
    if (summary) {
      // The blank row stands in for pi's own spacer above a tool box.
      lines.push("");
      headerRow = lines.length;
      lines.push(truncateToWidth(formatGroupHeader(summary, plan.header, theme, width, plan.live), width, "…"));
    }
  }
  let bodyFrom = lines.length;
  if (plan.liveRow) {
    const row = liveRow(plan, width, theme, own, options);
    if (row !== undefined) lines.push(truncateToWidth(row, width, "…"));
    geometry.set(tool, { plan, headerRow, bodyFrom, bodyTo: lines.length });
    return lines;
  }
  if (plan.line || plan.full) {
    // Thinking sits where it happened, above the call it led to. It takes the
    // anchor when it comes first, and clicks stay with the call's own rows.
    const carrier = thinkingCarrierFor(tool);
    const thinking = carrier ? options.thinkingRow?.(carrier) : undefined;
    if (thinking !== undefined) {
      const row = truncateToWidth(thinking, Math.max(8, width - INDENT_CELLS), "…");
      lines.push(headerRow >= 0 ? `${INDENT}${theme.fg("dim", "└")} ${dropTwoCells(row)}` : INDENT + row);
      bodyFrom = lines.length;
    }
    // The bash-tree idiom: rows nest by indentation alone, and one muted `└`
    // anchors the first row under the summary. It takes the row's own two
    // marker columns, so a failed first row keeps its `!` instead.
    // An expanded call opens with pi's `● ` header, a group row has no dot:
    // the dot gives way, so the row keeps its column and anchor when it opens.
    // Terminal image escapes are placed from column 0: a result with images
    // keeps pi's own layout, unindented, even inside an open group.
    if (plan.full && (tool.imageComponents?.length ?? 0) > 0) {
      lines.push(...dropLeadingBlanks(own(width)));
      geometry.set(tool, { plan, headerRow, bodyFrom, bodyTo: lines.length });
      return lines;
    }
    const rows = dropLeadingBlanks(own(Math.max(8, width - INDENT_CELLS)));
    rows.forEach((raw, index) => {
      const line = index === 0 ? raw.replace(LEADING_DOT, "$1 $2") : raw;
      const anchored = index === 0 && headerRow >= 0 && bodyFrom === headerRow + 1 && stripAnsi(line).startsWith("  ");
      lines.push(anchored ? `${INDENT}${theme.fg("dim", "└")} ${dropTwoCells(line)}` : INDENT + line);
    });
  }
  geometry.set(tool, { plan, headerRow, bodyFrom, bodyTo: lines.length });
  return lines;
}

/** A live group's second row: the thinking step when it is due, else the call. */
function liveRow(
  plan: ViewPlan,
  width: number,
  theme: GroupThemeLike,
  own: (width: number) => string[],
  options: GroupViewOptions,
): string | undefined {
  const anchor = `${INDENT}${theme.fg("dim", "└")} `;
  const thinking = plan.liveThinking ? options.thinkingRow?.(plan.liveThinking) : undefined;
  if (thinking !== undefined) return `${anchor}${dropTwoCells(truncateToWidth(thinking, Math.max(8, width - INDENT_CELLS), "…"))}`;
  const raw = dropLeadingBlanks(own(Math.max(8, width - INDENT_CELLS)))[0];
  if (raw === undefined) return undefined;
  const line = raw.replace(LEADING_DOT, "$1 $2");
  return stripAnsi(line).startsWith("  ") ? `${anchor}${dropTwoCells(line)}` : INDENT + line;
}

/** The run ended: repaint so the live group closes even if nothing else draws. */
export function settleLiveGroup(): void {
  liveTool?.ui?.requestRender?.();
  liveTool = undefined;
}

export const NOT_GROUPED = Symbol("xtrm-ui:not-grouped");

/**
 * Clicks on a grouped tool. Only left clicks on our own rows are taken; presses,
 * moves and drags fall through so text selection keeps working.
 * `asPointer` marks the `setExpanded` calls as pointer-driven (see noteSetExpanded).
 */
export function routeGroupedMouse(
  tool: GroupedTool,
  event: { type?: string; button?: string | number; y?: number } | undefined,
  asPointer: (fn: () => void) => void,
): unknown {
  const geo = geometry.get(tool);
  if (!geo) return NOT_GROUPED;
  const y = event?.y;
  const click = event?.type === "click" && (event.button === "left" || event.button === 0);
  if (!click || typeof y !== "number") return undefined;

  if (y === geo.headerRow) {
    if (geo.plan.header === "closed") openGroup(tool);
    else for (const member of closeGroup(tool)) asPointer(() => (member as GroupedTool).setExpanded(false));
    tool.ui?.requestRender?.();
    return { handled: true };
  }
  if (y >= geo.bodyFrom && y < geo.bodyTo) {
    // A row means "this call's output"; a click on the output folds it back.
    // A running row under a folded header opens the group on the way.
    openGroup(tool);
    asPointer(() => tool.setExpanded(!tool.expanded));
    tool.ui?.requestRender?.();
    return { handled: true };
  }
  return undefined;
}
