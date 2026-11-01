/**
 * Three-level folding for the tool calls of one assistant segment (ultracompact):
 *
 *   L0  ▸ Used shell 3 times, read once  1.2s        folded: the segment is one line
 *   L1  ▾ Used shell 3 times, read once  1.2s        click: one row per call
 *         └ Ran shell command git status
 *           Read src/app.ts
 *   L2        └ the call's expanded output           click a row: its full output
 *
 * One group = the tool calls between two boundaries: a user message, or an
 * assistant message with visible text. pi gives every model step its own
 * assistant message; a step that only thinks and calls a tool ("carrier") does
 * not split the group and draws nothing itself: an opened group lists its
 * thinking above the call it led to. Pinned tools (edit, write) keep their own
 * row and end the group before them.
 *
 * The newest group, while the agent runs, is live: it draws two fixed rows from
 * its first call. The second row is the newest call or thinking step, and keeps
 * the last thing done when nothing runs, so no call moves the transcript. The
 * group closes to one row at the next boundary or at the end of the run.
 *
 * Membership is decided at render time from transcript order, so a reloaded
 * session folds the same way. pi renders the whole transcript top to bottom on
 * every frame: a boundary's render selects its group, and a tool joins the
 * selected group the first time it renders.
 *
 * Ported and trimmed from pi-tidy's tool-groups.ts (no background jobs). pi-tidy: MIT License, Copyright (c) 2026 Andy8647,
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
  /** First call to last, from real timestamps; absent when they are unknown. */
  elapsedMs?: number;
  failed: number;
}

/** What a tool component draws this frame, top to bottom. */
export interface ViewPlan {
  /** The summary line, carried by the group's first member: `▸` folded, `▾` open. */
  header: "closed" | "open" | null;
  /** The one-row (collapsed) view of this call. */
  line: boolean;
  /** The call's expanded render. */
  full: boolean;
  /** The group is the newest one and the agent is running. */
  live?: boolean;
  /** This call draws a live group's second row. */
  liveRow?: boolean;
  /** The thinking step that row shows instead of the call, once it is due. */
  liveThinking?: object;
  /** Ms until the live row is due to show the thinking step: schedule a repaint. */
  revealIn?: number;
}

/**
 * A finished call stays on the live row until new thinking has streamed this
 * long. Most calls end within 250ms: without the hold each one would flash
 * between two thinking rows.
 */
export const THINKING_HOLD_MS = 500;

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
  /** Carriers seen so far, so a frame that renders them again changes nothing. */
  carriers: WeakSet<object>;
  /** A carrier whose call has not joined yet: the next member lists it. */
  unclaimedCarrier: { isStreaming?: boolean } | null;
  /** Timestamps of the first and newest assistant message of this group. */
  firstStamp?: number;
  lastStamp?: number;
}

const newGroup = (): Group => ({ level: 0, members: [], carriers: new WeakSet(), unclaimedCarrier: null });

/** The group of the boundary rendered most recently in this frame. */
let current: Group = newGroup();
/** The newest group of the transcript: boundaries first render in order. */
let tail: Group = current;
const groupOfBoundary = new WeakMap<object, Group>();
const groupOf = new WeakMap<object, Group>();
/** The carrier whose thinking led to each tool. */
const carrierOf = new WeakMap<object, object>();
/** When each carrier first rendered (about when its thinking started). */
const firstSeen = new WeakMap<object, number>();
/** The newest message timestamp when each tool joined: when its step began. */
const stepStamp = new WeakMap<object, number>();
/** When each tool was first seen finished during a run. */
const finishedAt = new WeakMap<object, number>();
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
    // The live group just closed: its rows rendered above this boundary.
    if (tail.members.length > 0) lateJoin = true;
    tail = group;
  }
  return group;
}

/** pi stamps each message when it starts: real on a live run and on a reload. */
function noteStamp(group: Group, component: object): void {
  const stamp = (component as { lastMessage?: { timestamp?: unknown } }).lastMessage?.timestamp;
  if (typeof stamp !== "number" || !Number.isFinite(stamp)) return;
  group.firstStamp ??= stamp;
  group.lastStamp = Math.max(group.lastStamp ?? stamp, stamp);
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
  // it was thinking in: the live row must not keep waiting for it.
  if (current.unclaimedCarrier === component) current.unclaimedCarrier = null;
  current = groupKeyedBy(component);
  noteStamp(current, component);
}

export function setAgentRunning(running: boolean): void {
  agentRunning = running;
}

/** A carrier rendered inside the current group. Its streaming state feeds the live row. */
export function noteCarrier(component: { isStreaming?: boolean }): void {
  touchFrame(component);
  noteStamp(current, component);
  // Two carriers in one group render every frame: only a new one may ask for
  // a repaint, or the pair would swap the slot and repaint forever.
  if (current.carriers.has(component)) return;
  current.carriers.add(component);
  current.unclaimedCarrier = component;
  firstSeen.set(component, Date.now());
  // The rows rendered before this carrier: they learn about it next frame.
  if (current.members.length > 0) lateJoin = true;
}

export function currentGroupHasMembers(): boolean {
  return current.members.length > 0;
}

function join(tool: ToolLike): Group {
  touchFrame(tool);
  const known = groupOf.get(tool);
  if (known) return known;
  const group = current;
  if (group.members.length > 0 || tool.expanded) lateJoin = true;
  group.members.push(tool);
  if (group.lastStamp !== undefined) stepStamp.set(tool, group.lastStamp);
  if (group.unclaimedCarrier) {
    carrierOf.set(tool, group.unclaimedCarrier);
    group.unclaimedCarrier = null;
  }
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
  const group = join(tool);
  if (agentRunning && !tool.isPartial && !finishedAt.has(tool)) finishedAt.set(tool, now);
  const live = agentRunning && group === tail;
  if (group.members.length < 2 && !live) return SOLO;
  const header = group.members[0] === tool ? (group.level === 0 ? "closed" : "open") : null;
  if (group.level !== 0) return { header, line: !tool.expanded, full: tool.expanded, live };
  if (!live || liveMember(group) !== tool) return { header, line: false, full: false, live };
  const plan: ViewPlan = { header, line: false, full: false, live, liveRow: true };
  const carrier = group.unclaimedCarrier;
  if (carrier?.isStreaming !== true || group.members.some((member) => member.isPartial)) return plan;
  const age = now - (firstSeen.get(carrier) ?? now);
  if (age >= THINKING_HOLD_MS) plan.liveThinking = carrier;
  else plan.revealIn = THINKING_HOLD_MS - age;
  return plan;
}

/** The newest running call, or the newest call when none runs. */
function liveMember(group: Group): ToolLike | undefined {
  return [...group.members].reverse().find((member) => member.isPartial) ?? group.members.at(-1);
}

/** Whether the plan draws through the group (summary line or indented row) rather than as usual. */
export function isGroupedPlan(plan: ViewPlan): boolean {
  return plan !== PINNED && plan !== SOLO;
}

/** The thinking step that led to this call, for its row in an opened group. */
export function thinkingCarrierFor(tool: object): object | undefined {
  return carrierOf.get(tool);
}

export function groupMembers(component: object): readonly ToolLike[] {
  return groupOf.get(component)?.members ?? [];
}

export function groupSummaryFor(component: object): GroupSummary | undefined {
  const group = groupOf.get(component);
  return group ? buildGroupSummary(group.members, group.firstStamp) : undefined;
}

/** First call to last. A step's stamp is when it started, so a call's end adds its duration. */
function elapsedMs(members: readonly ToolLike[], firstStamp: number | undefined): number | undefined {
  if (firstStamp === undefined) return undefined;
  let end: number | undefined;
  for (const member of members) {
    if (member.isPartial) return undefined;
    const stamp = stepStamp.get(member);
    const ms = member.result?.durationMs;
    const ends = [finishedAt.get(member), stamp, stamp !== undefined && typeof ms === "number" && Number.isFinite(ms) ? stamp + ms : undefined];
    for (const value of ends) if (value !== undefined) end = Math.max(end ?? value, value);
  }
  return end === undefined ? undefined : Math.max(0, end - firstStamp);
}

/** Pure: what the summary line says, independent of theme. */
export function buildGroupSummary(members: readonly ToolLike[], firstStamp?: number): GroupSummary {
  const counts = new Map<string, number>();
  let failed = 0;
  for (const member of members) {
    counts.set(member.toolName, (counts.get(member.toolName) ?? 0) + 1);
    if (!member.isPartial && member.result?.isError) failed++;
  }
  const breakdown = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { count: members.length, breakdown, elapsedMs: elapsedMs(members, firstStamp), failed };
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
  tail = current;
  lateJoin = false;
  frameOpen = false;
  agentRunning = false;
}
