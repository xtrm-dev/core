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
  type GroupSummary,
  type ToolLike,
  type ViewPlan,
} from "./tool-groups";

export interface GroupThemeLike {
  fg(token: string, text: string): string;
}

export interface GroupedTool extends ToolLike {
  ui?: { requestRender?(): void };
  /** pi's image children of an expanded result; their lines must start at column 0. */
  imageComponents?: unknown[];
  setExpanded(expanded: boolean): void;
}

/**
 * Tools that never fold: their row stays where it is and ends the group.
 * File changes, messages to other agents, background jobs and specialist
 * lifecycle calls change state outside the reply; read-only checks on them
 * (bg_status, specialist_result, ...) fold like any other call.
 */
export const PINNED_TOOLS = new Set([
  "edit",
  "write",
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
  "subagent",
]);

/** Summary phrases: calls of the same kind read as one activity. */
const ACTIVITY: Record<string, string> = {
  bash: "used shell",
  python: "ran code",
  codemode: "ran code",
  code: "ran code",
  read: "read",
  grep: "searched",
  find: "searched",
  ls: "searched",
  ast_grep: "searched",
  search_context: "searched",
  tool_search: "searched",
  bg_status: "checked jobs",
  bg_logs: "checked jobs",
  specialist_status: "checked specialists",
  specialist_result: "checked specialists",
  specialist_feed: "checked specialists",
  specialist_list: "checked specialists",
};

function activity(toolName: string): string {
  if (ACTIVITY[toolName]) return ACTIVITY[toolName]!;
  if (toolName.startsWith("gitnexus_")) return "used GitNexus";
  return `used ${toolName}`;
}

function times(count: number): string {
  return count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
}

const INDENT = "  ";
const INDENT_CELLS = 2;

/** One repaint per tool when a hidden running row is due. */
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
 * It stands for rows it hides, so it sits on the rows' subject level
 * (toolTitle, regular weight), never above their bold verbs. Commas join the
 * activities only; the outcome follows as row metadata does, two spaces apart.
 */
export function formatGroupHeader(summary: GroupSummary, state: "closed" | "open", theme: GroupThemeLike): string {
  const counts = new Map<string, number>();
  for (const entry of summary.breakdown) {
    const phrase = activity(entry.name);
    counts.set(phrase, (counts.get(phrase) ?? 0) + entry.count);
  }
  const phrases = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([phrase, count]) => `${phrase} ${times(count)}`);
  // "Used shell 4 times, GitNexus twice": a run of `used …` phrases says the
  // verb once, at the start of the run.
  for (let i = phrases.length - 1; i > 0; i--) {
    if (phrases[i]!.startsWith("used ") && phrases[i - 1]!.startsWith("used ")) phrases[i] = phrases[i]!.slice(5);
  }
  const first = phrases[0] ?? "";
  if (phrases.length > 0) phrases[0] = first.charAt(0).toUpperCase() + first.slice(1);
  const parts = [phrases.map((phrase) => theme.fg("toolTitle", phrase)).join(theme.fg("dim", ", "))];
  if (summary.failed > 0) parts.push(theme.fg("error", `${summary.failed} failed`));
  // A running call is not named here: after RUNNING_ROW_DELAY_MS it gets its
  // own row under the summary, and naming it at once made short calls flash
  // `running …` at the end of the line. Thinking has no row, so it says so.
  // In the thinking tone, a step below the activities, as pi's thinking rows.
  if (summary.thinking && !summary.running) parts.push(theme.fg("thinkingText", "thinking"));
  const duration = summary.durationMs >= 1000 ? formatDuration(summary.durationMs) : undefined;
  if (duration) parts.push(theme.fg("dim", duration));
  return `${theme.fg("dim", state === "closed" ? "▸" : "▾")} ${parts.join("  ")}`;
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

/**
 * The tool's lines while folding is on, or `undefined` when it renders as usual
 * (pinned, a group of one, or not grouped). `own` is the tool's regular render.
 */
export function renderGroupedTool(
  tool: GroupedTool,
  width: number,
  theme: GroupThemeLike,
  own: (width: number) => string[],
): string[] | undefined {
  const plan = planFor(tool, PINNED_TOOLS.has(tool.toolName));
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
      lines.push(truncateToWidth(formatGroupHeader(summary, plan.header, theme), width, "…"));
    }
  }
  const bodyFrom = lines.length;
  if (plan.line || plan.full) {
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
      const anchored = index === 0 && headerRow >= 0 && stripAnsi(line).startsWith("  ");
      lines.push(anchored ? `${INDENT}${theme.fg("dim", "└")} ${dropTwoCells(line)}` : INDENT + line);
    });
  }
  geometry.set(tool, { plan, headerRow, bodyFrom, bodyTo: lines.length });
  return lines;
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
