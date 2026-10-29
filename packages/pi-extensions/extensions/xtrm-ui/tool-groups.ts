/**
 * Three-level folding for the tool calls of one assistant segment (ultracompact):
 *
 *   L0  ▸ Used shell 3 times, read once, 1.2s        folded: the segment is one line
 *   L1  ▾ Used shell 3 times, read once, 1.2s        click: one row per call
 *         └ Ran shell command git status
 *           Read src/app.ts
 *   L2        └ the call's expanded output           click a row: its full output
 *
 * One group = the tool calls between two boundaries: a user message, or an
 * assistant message with visible text. pi gives every model step its own
 * assistant message; a step that only thinks and calls a tool ("carrier") does
 * not split the group and draws nothing. Pinned tools (edit, write) keep their
 * own row and end the group before them.
 *
 * Membership is decided at render time from transcript order, so a reloaded
 * session folds the same way. pi renders the whole transcript top to bottom on
 * every frame: a boundary's render selects its group, and a tool joins the
 * selected group the first time it renders.
 *
 * Ported and trimmed from pi-tidy's tool-groups.ts (no thinking rows, no
 * background jobs). pi-tidy: MIT License, Copyright (c) 2026 Andy8647,
 * https://github.com/Andy8647/pi-tidy
 */

export interface ToolLike {
  toolName: string;
  toolCallId?: string;
  isPartial: boolean;
  expanded: boolean;
  result?: { durationMs?: number; isError?: boolean };
}

export interface GroupSummary {
  count: number;
  /** Per-tool counts, most frequent first, ties alphabetical. */
  breakdown: Array<{ name: string; count: number }>;
  /** Sum of the known durations (running calls have none yet). */
  durationMs: number;
  /** Tool name of the first member still executing, if any. */
  running?: string;
  failed: number;
  /** A carrier step of this group is streaming its thinking right now. */
  thinking: boolean;
}

/** What a tool component draws this frame, top to bottom. */
export interface ViewPlan {
  /** The summary line, carried by the group's first member: `▸` folded, `▾` open. */
  header: "closed" | "open" | null;
  /** The one-row (collapsed) view of this call. */
  line: boolean;
  /** The call's expanded render. */
  full: boolean;
  /** Ms until this hidden running row is due to appear: schedule a repaint. */
  revealIn?: number;
}

/**
 * A folded group shows a running call's row only after it has run this long.
 * Most calls finish well inside it, and a row that pops out under the summary
 * and folds back a frame later reads as flicker.
 */
export const RUNNING_ROW_DELAY_MS = 1000;

export type AssistantRole = "boundary" | "carrier" | "plain";

interface AssistantMessageLike {
  content?: unknown;
  stopReason?: unknown;
}

/** Stop reasons whose notice must stay on screen, never folded away. */
const LOUD_STOPS = new Set(["length", "error", "aborted"]);

/**
 * - `boundary`: has visible text; starts a group and renders as usual
 * - `carrier`:  only thinking and tool calls; belongs to the current group, draws nothing
 * - `plain`:    anything else (streaming thinking, an error); leaves grouping alone
 */
export function classifyAssistant(message: AssistantMessageLike | undefined): AssistantRole {
  // Unknown shape (pi changed the field): keep pi's rendering, never hide.
  if (!message || !Array.isArray(message.content)) return "boundary";
  let hasToolCall = false;
  for (const block of message.content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) return "boundary";
    if (block?.type === "toolCall") hasToolCall = true;
  }
  if (hasToolCall && !LOUD_STOPS.has(String(message.stopReason))) return "carrier";
  return "plain";
}

interface Group {
  level: 0 | 1;
  /** The components themselves, so the summary always reads live state. */
  members: ToolLike[];
  /** The newest carrier component of this group. */
  carrier: { isStreaming?: boolean } | null;
  /** Carriers seen so far, so a frame that renders them again changes nothing. */
  carriers: WeakSet<object>;
}

const newGroup = (): Group => ({ level: 0, members: [], carrier: null, carriers: new WeakSet() });

/** The group of the boundary rendered most recently in this frame. */
let current: Group = newGroup();
const groupOfBoundary = new WeakMap<object, Group>();
const groupOf = new WeakMap<object, Group>();
/** When each tool first rendered (about when its call appeared). */
const firstSeen = new WeakMap<object, number>();
/** A tool joined a group whose summary line already rendered this frame. */
let lateJoin = false;
/** Between agent_start and agent_end: only then can a carrier be thinking. */
let agentRunning = false;
let frameOpen = false;

function groupKeyedBy(component: object): Group {
  let group = groupOfBoundary.get(component);
  if (!group) {
    group = newGroup();
    groupOfBoundary.set(component, group);
  }
  return group;
}

/**
 * The first grouping call of a frame starts it. What renders before any
 * boundary belongs to a group keyed by the frame's first component, never to
 * the last group of the previous frame: after a rebuild (compaction keeps a
 * slice that can open mid-turn) that group holds dead components, and new
 * tools joining it would never draw its summary. pi renders a frame
 * synchronously, so the frame ends at the next microtask.
 */
function touchFrame(component: object): void {
  if (frameOpen) return;
  frameOpen = true;
  current = groupKeyedBy(component);
  queueMicrotask(() => {
    frameOpen = false;
  });
}

/** A boundary rendered: what follows it belongs to its group. Idempotent per frame. */
export function noteBoundary(component: object): void {
  touchFrame(component);
  // A step that streamed as a carrier and then gained text leaves the group
  // it was thinking in: its `thinking` must not stay on that summary.
  if (current.carrier === component) current.carrier = null;
  current = groupKeyedBy(component);
}

export function setAgentRunning(running: boolean): void {
  agentRunning = running;
}

/** A carrier rendered inside the current group. Its streaming state feeds the summary. */
export function noteCarrier(component: { isStreaming?: boolean }): void {
  touchFrame(component);
  // Two carriers in one group render every frame: only a new one may ask for
  // a repaint, or the pair would swap the slot and repaint forever.
  if (current.carriers.has(component)) return;
  current.carriers.add(component);
  current.carrier = component;
  // The summary rendered before this carrier: it learns about it next frame.
  if (current.members.length > 0) lateJoin = true;
}

export function currentGroupHasMembers(): boolean {
  return current.members.length > 0;
}

function join(tool: ToolLike, now: number): Group {
  touchFrame(tool);
  const known = groupOf.get(tool);
  if (known) return known;
  const group = current;
  if (group.members.length > 0 || tool.expanded) lateJoin = true;
  group.members.push(tool);
  firstSeen.set(tool, now);
  // pi hands a new box `setExpanded(toolOutputExpanded)` before it renders:
  // arriving expanded means ctrl+o's expand-all is on.
  if (tool.expanded) group.level = 1;
  groupOf.set(tool, group);
  return group;
}

/** Whether a tool joined a group since the last call: the caller asks for one more frame. */
export function takeLateJoin(): boolean {
  const late = lateJoin;
  lateJoin = false;
  return late;
}

const PINNED: ViewPlan = { header: null, line: false, full: true };
const SOLO: ViewPlan = { header: null, line: false, full: true };

/**
 * `pinned`: an always-shown tool. It renders as usual and acts as a boundary.
 * A group of one renders as usual too: a summary that says "1 call" is longer
 * than the row it hides.
 */
export function planFor(tool: ToolLike, pinned = false, now = Date.now()): ViewPlan {
  if (pinned) {
    noteBoundary(tool);
    return PINNED;
  }
  const group = join(tool, now);
  if (group.members.length < 2) return SOLO;
  const header = group.members[0] === tool ? (group.level === 0 ? "closed" : "open") : null;
  if (group.level === 0) {
    const age = tool.isPartial ? now - (firstSeen.get(tool) ?? now) : undefined;
    if (age === undefined) return { header, line: false, full: false };
    if (age >= RUNNING_ROW_DELAY_MS) return { header, line: true, full: false };
    return { header, line: false, full: false, revealIn: RUNNING_ROW_DELAY_MS - age };
  }
  return { header, line: !tool.expanded, full: tool.expanded };
}

/** Whether the plan draws through the group (summary line or indented row) rather than as usual. */
export function isGroupedPlan(plan: ViewPlan): boolean {
  return plan !== PINNED && plan !== SOLO;
}

export function groupMembers(component: object): readonly ToolLike[] {
  return groupOf.get(component)?.members ?? [];
}

export function groupSummaryFor(component: object): GroupSummary | undefined {
  const group = groupOf.get(component);
  // pi drops a still-streaming component at agent_end without clearing its
  // isStreaming, so the flag alone could say `thinking` forever.
  return group ? buildGroupSummary(group.members, agentRunning && group.carrier?.isStreaming === true) : undefined;
}

/** Pure: what the summary line says, independent of theme. */
export function buildGroupSummary(members: readonly ToolLike[], thinking = false, now = Date.now()): GroupSummary {
  const counts = new Map<string, number>();
  let durationMs = 0;
  let running: string | undefined;
  let failed = 0;
  for (const member of members) {
    counts.set(member.toolName, (counts.get(member.toolName) ?? 0) + 1);
    if (!member.isPartial && member.result?.isError) failed++;
    const ms = member.result?.durationMs;
    if (!member.isPartial && typeof ms === "number" && Number.isFinite(ms)) durationMs += ms;
    // Like the running row, a call counts as running only once it is due to show:
    // a short call must not blink the `thinking` marker off.
    if (member.isPartial && running === undefined && now - (firstSeen.get(member) ?? -Infinity) >= RUNNING_ROW_DELAY_MS) {
      running = member.toolName;
    }
  }
  const breakdown = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { count: members.length, breakdown, durationMs, running, failed, thinking };
}

/** L0 → L1: the summary line unfolds into one row per call. */
export function openGroup(component: object): void {
  const group = groupOf.get(component);
  if (group) group.level = 1;
}

/**
 * L1 → L0 from the `▾` header. Returns the members still expanded; the caller
 * collapses them through pi's `setExpanded`, so reopening starts from rows.
 */
export function closeGroup(component: object): ToolLike[] {
  const group = groupOf.get(component);
  if (!group) return [];
  group.level = 0;
  return group.members.filter((member) => member.expanded);
}

/**
 * pi calls `setExpanded` for ctrl+o (every box, not from a pointer) and for a
 * click on a box. Expanding anything opens its group so the rows are
 * reachable; collapse-all returns the group to its summary line, while a
 * pointer collapse only folds that one call back into its row.
 */
export function noteSetExpanded(tool: object, expanded: boolean, fromPointer: boolean): void {
  const group = groupOf.get(tool);
  if (!group) return;
  if (expanded) group.level = 1;
  else if (!fromPointer) group.level = 0;
}

/** Test seam: forget the current group (WeakMaps drop with their components). */
export function resetGroups(): void {
  current = newGroup();
  lateJoin = false;
  frameOpen = false;
  agentRunning = false;
}
