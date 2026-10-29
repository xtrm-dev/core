import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildGroupSummary,
  classifyAssistant,
  noteBoundary,
  noteCarrier,
  noteSetExpanded,
  planFor,
  resetGroups,
  RUNNING_ROW_DELAY_MS,
  setAgentRunning,
  takeLateJoin,
} from "./tool-groups.ts";
import { formatGroupHeader, renderGroupedTool, routeGroupedMouse, NOT_GROUPED, type GroupedTool } from "./tool-group-view.ts";

const theme = { fg: (_token: string, text: string) => text };

function tool(toolName: string, over: Partial<GroupedTool> = {}): GroupedTool & { renders: number } {
  const t = {
    toolName,
    isPartial: false,
    expanded: false,
    result: { durationMs: 10, isError: false },
    renders: 0,
    ui: { requestRender: () => { t.renders++; } },
    setExpanded(expanded: boolean) {
      // Mirrors the prototype patch: noteSetExpanded runs before pi's own setExpanded.
      noteSetExpanded(t, expanded, pointer);
      t.expanded = expanded;
    },
    ...over,
  };
  return t;
}

let pointer = false;
const asPointer = (fn: () => void) => {
  pointer = true;
  try { fn(); } finally { pointer = false; }
};

/** pi's own render of a tool box: a spacer, then one row (or more when expanded). */
// Rows carry two marker columns, like every ultracompact row.
const own = (t: GroupedTool) => () => (t.expanded ? ["", `  ${t.toolName} row`, `  └ ${t.toolName} output`] : ["", `  ${t.toolName} row`]);

/** One frame: every component renders top to bottom, as pi does. */
function frame(user: object, tools: GroupedTool[]): Array<string[] | undefined> {
  noteBoundary(user);
  return tools.map((t) => renderGroupedTool(t, 80, theme, own(t)));
}

beforeEach(() => resetGroups());

describe("tool folding", () => {
  test("two calls fold into one summary line carried by the first member", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("read");
    const first = frame(user, [a, b]);
    // Frame 1: the first call rendered alone, then the second joined late.
    expect(first[0]).toBeUndefined();
    const second = frame(user, [a, b]);
    expect(second[0]).toEqual(["", "▸ Used shell once, read once"]);
    expect(second[1]).toEqual([]);
  });

  test("header click opens rows, a row click opens that call's output, header click folds back", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("read");
    frame(user, [a, b]);
    frame(user, [a, b]);

    expect(routeGroupedMouse(a, { type: "click", button: "left", y: 1 }, asPointer)).toEqual({ handled: true });
    let lines = frame(user, [a, b]);
    expect(lines[0]).toEqual(["", "▾ Used shell once, read once", "  └ bash row"]);
    expect(lines[1]).toEqual(["    read row"]);

    expect(routeGroupedMouse(b, { type: "click", button: "left", y: 0 }, asPointer)).toEqual({ handled: true });
    expect(b.expanded).toBe(true);
    lines = frame(user, [a, b]);
    expect(lines[1]).toEqual(["    read row", "    └ read output"]);

    routeGroupedMouse(a, { type: "click", button: "left", y: 1 }, asPointer);
    expect(b.expanded).toBe(false);
    lines = frame(user, [a, b]);
    expect(lines[0]).toEqual(["", "▸ Used shell once, read once"]);
    expect(lines[1]).toEqual([]);
  });

  test("moves and non-left clicks pass through for text selection", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("bash");
    frame(user, [a, b]);
    frame(user, [a, b]);
    expect(routeGroupedMouse(a, { type: "move", y: 1 }, asPointer)).toBeUndefined();
    expect(routeGroupedMouse(a, { type: "click", button: "right", y: 1 }, asPointer)).toBeUndefined();
  });

  test("ctrl+o expand-all opens the group; collapse-all folds it to the summary", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("grep");
    frame(user, [a, b]);
    a.setExpanded(true);
    b.setExpanded(true);
    let lines = frame(user, [a, b]);
    expect(lines[0]).toEqual(["", "▾ Used shell once, searched once", "  └ bash row", "    └ bash output"]);
    a.setExpanded(false);
    b.setExpanded(false);
    lines = frame(user, [a, b]);
    expect(lines[0]).toEqual(["", "▸ Used shell once, searched once"]);
  });

  test("a pinned edit renders as usual and starts a new group after it", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("bash");
    const edit = tool("edit");
    const c = tool("read");
    const d = tool("read");
    frame(user, [a, b, edit, c, d]);
    const lines = frame(user, [a, b, edit, c, d]);
    expect(lines[0]).toEqual(["", "▸ Used shell twice"]);
    expect(lines[2]).toBeUndefined();
    expect(lines[3]).toEqual(["", "▸ Read twice"]);
  });

  test("an extension card delivered mid-batch ends the group: later calls never run on below it", () => {
    const user = {};
    const card = {};
    const [a, b, c, d] = [tool("bash"), tool("bash"), tool("bash"), tool("TaskUpdate")];
    const render = () => {
      noteBoundary(user);
      const before = [a, b].map((t) => renderGroupedTool(t, 80, theme, own(t)));
      noteBoundary(card);
      return [...before, ...[c, d].map((t) => renderGroupedTool(t, 80, theme, own(t)))];
    };
    render();
    a.setExpanded(true);
    b.setExpanded(true);
    const lines = render();
    expect(lines[0]).toEqual(["", "▾ Used shell twice", "  └ bash row", "    └ bash output"]);
    expect(lines[2]).toEqual(["", "▸ Used shell once, TaskUpdate once"]);
  });

  test("a non-grouped component answers NOT_GROUPED to clicks", () => {
    const user = {};
    const solo = tool("bash");
    frame(user, [solo]);
    expect(routeGroupedMouse(solo, { type: "click", button: "left", y: 1 }, asPointer)).toBe(NOT_GROUPED);
  });

  test("a running call surfaces under the folded header only after the delay", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("bash", { isPartial: true, result: undefined });
    noteBoundary(user);
    const t0 = Date.now();
    planFor(a, false, t0);
    planFor(b, false, t0);
    takeLateJoin();
    noteBoundary(user);
    expect(planFor(b, false, t0 + 10)).toMatchObject({ line: false, revealIn: RUNNING_ROW_DELAY_MS - 10 });
    expect(planFor(b, false, t0 + RUNNING_ROW_DELAY_MS + 50)).toMatchObject({ line: true });
  });

  test("the summary counts failures, the running call and a streaming carrier", () => {
    const members = [
      tool("bash", { result: { durationMs: 1200, isError: true } }),
      tool("bash", { result: { durationMs: 900, isError: false } }),
      tool("read", { isPartial: true, result: undefined }),
    ];
    const summary = buildGroupSummary(members, true);
    expect(summary).toMatchObject({ count: 3, failed: 1, running: "read", durationMs: 2100, thinking: true });
    expect(formatGroupHeader(summary, "closed", theme)).toBe("▸ Used shell twice, read once  1 failed  2.1s");
  });

  test("two carriers in one group stop asking for repaints once both are known", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("bash");
    const c1 = { isStreaming: false };
    const c2 = { isStreaming: false };
    const step = () => {
      noteBoundary(user);
      noteCarrier(c1);
      renderGroupedTool(a, 80, theme, own(a));
      noteCarrier(c2);
      renderGroupedTool(b, 80, theme, own(b));
    };
    step();
    step();
    takeLateJoin();
    const before = a.renders + b.renders;
    step();
    step();
    expect(a.renders + b.renders).toBe(before);
  });

  test("a streaming carrier marks the group as thinking", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("bash");
    frame(user, [a, b]);
    noteCarrier({ isStreaming: true });
    setAgentRunning(true);
    const lines = frame(user, [a, b]);
    expect(lines[0]?.[1]).toContain("thinking");
    // After agent_end a dropped component may still claim to stream: no marker.
    setAgentRunning(false);
    expect(frame(user, [a, b])[0]?.[1]).not.toContain("thinking");
  });

  test("a step that gains text leaves the previous group's thinking marker", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("bash");
    const step = { isStreaming: true };
    setAgentRunning(true);
    frame(user, [a, b]);
    noteCarrier(step);
    expect(frame(user, [a, b])[0]?.[1]).toContain("thinking");
    noteBoundary(step);
    expect(frame(user, [a, b])[0]?.[1]).not.toContain("thinking");
  });

  test("after a rebuild, tools rendered before any boundary still fold under a live summary", async () => {
    const user = {};
    const old = [tool("bash"), tool("bash")];
    frame(user, old);
    frame(user, old);
    await Promise.resolve();
    // Rebuilt transcript: new components, and the kept slice opens with tools.
    const kept = [tool("read"), tool("read")];
    const render = () => kept.map((t) => renderGroupedTool(t, 80, theme, own(t)));
    render();
    await Promise.resolve();
    expect(render()[0]).toEqual(["", "▸ Read twice"]);
  });
});

describe("summary wording and pinned tools", () => {
  test("calls of one kind merge into one activity, most frequent first", () => {
    const members = [tool("grep"), tool("find"), tool("ast_grep"), tool("bash"), tool("gitnexus_query"), tool("TaskUpdate")];
    expect(formatGroupHeader(buildGroupSummary(members), "closed", theme))
      .toBe("▸ Searched 3 times, used shell once, GitNexus once, TaskUpdate once");
    // Another verb ends the run; the next `used` phrase says it again.
    const mixed = [tool("bash"), tool("bash"), tool("bash"), tool("read"), tool("read"), tool("gitnexus_query")];
    expect(formatGroupHeader(buildGroupSummary(mixed), "closed", theme)).toBe("▸ Used shell 3 times, read twice, used GitNexus once");
    const leading = [tool("bash"), tool("bash"), tool("gitnexus_query"), tool("TaskUpdate")];
    expect(formatGroupHeader(buildGroupSummary(leading), "closed", theme)).toBe("▸ Used shell twice, GitNexus once, TaskUpdate once");
  });

  test("SendMessage, background jobs and specialist dispatches interrupt the group", () => {
    const user = {};
    const names = ["bash", "bash", "SendMessage", "bash", "bash", "BashBackground", "read", "read", "specialist_dispatch"];
    const tools = names.map((name) => tool(name));
    frame(user, tools);
    const lines = frame(user, tools);
    expect(lines[0]).toEqual(["", "▸ Used shell twice"]);
    expect(lines[2]).toBeUndefined();
    expect(lines[3]).toEqual(["", "▸ Used shell twice"]);
    expect(lines[5]).toBeUndefined();
    expect(lines[6]).toEqual(["", "▸ Read twice"]);
    expect(lines[8]).toBeUndefined();
  });
});

describe("classifyAssistant", () => {
  test("text makes a boundary, tool-only steps carry, loud stops stay visible", () => {
    expect(classifyAssistant({ content: [{ type: "text", text: "Done." }] })).toBe("boundary");
    expect(classifyAssistant({ content: [{ type: "thinking" }, { type: "toolCall" }], stopReason: "toolUse" })).toBe("carrier");
    expect(classifyAssistant({ content: [{ type: "toolCall" }], stopReason: "error" })).toBe("plain");
    expect(classifyAssistant({ content: [{ type: "toolCall" }], stopReason: "length" })).toBe("plain");
    expect(classifyAssistant({ content: [{ type: "thinking" }] })).toBe("plain");
    expect(classifyAssistant(undefined)).toBe("boundary");
  });
});

describe("opened group layout", () => {
  test("a failed first row keeps its ! marker instead of the └ anchor", () => {
    const user = {};
    const a = tool("bash", { result: { durationMs: 5, isError: true } });
    const b = tool("read");
    const failedOwn = () => ["", "! bash row  failed"];
    // Two frames: the second call joins on the first, the summary lands on the second.
    for (let i = 0; i < 2; i++) {
      noteBoundary(user);
      renderGroupedTool(a, 80, theme, failedOwn);
      renderGroupedTool(b, 80, theme, own(b));
    }
    routeGroupedMouse(a, { type: "click", button: "left", y: 1 }, asPointer);
    noteBoundary(user);
    const first = renderGroupedTool(a, 80, theme, failedOwn);
    expect(first).toEqual(["", "▾ Used shell once, read once  1 failed", "  ! bash row  failed"]);
  });

  test("an expanded first member gives up pi's ● for the └ anchor, escapes and all", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("read");
    const esc = (t: string) => `\x1b[2m${t}\x1b[22m`;
    const dotted = () => (a.expanded ? ["", `${esc("●")} Ran ls`, "  └ out"] : ["", "  bash row"]);
    for (let i = 0; i < 2; i++) {
      noteBoundary(user);
      renderGroupedTool(a, 80, theme, dotted);
      renderGroupedTool(b, 80, theme, own(b));
    }
    routeGroupedMouse(a, { type: "click", button: "left", y: 1 }, asPointer);
    noteBoundary(user);
    renderGroupedTool(a, 80, theme, dotted);
    routeGroupedMouse(a, { type: "click", button: "left", y: 2 }, asPointer);
    noteBoundary(user);
    const lines = renderGroupedTool(a, 80, theme, dotted)!;
    expect(lines[2]!.replace(/\x1b\[[0-9;]*m/g, "")).toBe("  └ Ran ls");
    expect(lines[3]).toBe("    └ out");
  });
});
