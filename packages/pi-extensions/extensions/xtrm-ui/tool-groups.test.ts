import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const {
  buildGroupSummary,
  classifyAssistant,
  closeGroup,
  noteBoundary,
  noteCarrier,
  noteSetExpanded,
  openGroup,
  planFor,
  resetGroups,
  THINKING_HOLD_MS,
  setAgentRunning,
  takeLateJoin,
} = await import("./tool-groups.ts");
const { formatGroupHeader, PINNED_TOOLS, renderGroupedTool, routeGroupedMouse, settleLiveGroup, NOT_GROUPED } = await import("./tool-group-view.ts");
type GroupedTool = import("./tool-group-view.ts").GroupedTool;

const visibleWidth = (text: string): number => text.length;

/**
 * Runs a body against the real pi-tui. Other test files stub it and bun leaks
 * that across files, so clipping is only observable in a process of its own.
 */
function realClip(body: string): string {
  const script = `
    const { formatGroupHeader, renderGroupedTool } = await import("./tool-group-view.ts");
    const { noteBoundary, setAgentRunning } = await import("./tool-groups.ts");
    const theme = { fg: (_t, text) => text };
    const user = {};
    const a = { toolName: "bash", isPartial: false, expanded: false, result: {}, setExpanded() {} };
    setAgentRunning(true);
    const run = () => { ${body} };
    console.log(run().replace(/\\x1b\\[[0-9;]*m/g, ""));
    process.exit(0);
  `;
  const out = Bun.spawnSync(["bun", "-e", script], { cwd: import.meta.dir });
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return out.stdout.toString().trimEnd();
}

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
  return tools.map((t) => renderGroupedTool(t, 80, theme, own(t), viewOptions));
}

const viewOptions = { thinkingRow: (carrier: object) => `  thinking: ${(carrier as { recap: string }).recap}` };

beforeEach(() => resetGroups());

describe("live group", () => {
  const realNow = Date.now;
  let now = 0;
  beforeEach(() => {
    now = realNow();
    Date.now = () => now;
    setAgentRunning(true);
  });
  afterEach(() => {
    Date.now = realNow;
  });

  /** Drawn rows of one settled frame: blank spacers do not count. */
  function rows(render: () => Array<string[] | undefined>): string[] {
    render();
    return render().flatMap((lines) => lines ?? []).filter((line) => line !== "");
  }

  test("the group draws two rows from its first call and holds them through a running call", () => {
    const user = {};
    const a = tool("bash", { isPartial: true, result: undefined });
    const b = tool("read", { isPartial: true, result: undefined });
    expect(rows(() => frame(user, [a]))).toEqual(["▸ Used shell once", "  └ bash row"]);
    Object.assign(a, { isPartial: false, result: { durationMs: 10, isError: false } });
    expect(rows(() => frame(user, [a]))).toHaveLength(2);
    const heights = [rows(() => frame(user, [a, b]))];
    now += 5000;
    heights.push(rows(() => frame(user, [a, b])));
    Object.assign(b, { isPartial: false, result: { durationMs: 5000, isError: false } });
    heights.push(rows(() => frame(user, [a, b])));
    expect(heights.map((drawn) => drawn.length)).toEqual([2, 2, 2]);
    expect(heights[0]).toEqual(["▸ Used shell once, read once", "  └ read row"]);
  });

  test("with nothing running the second row keeps the last thing done", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("read");
    expect(rows(() => frame(user, [a, b]))[1]).toBe("  └ read row");
  });

  test("parallel calls show the newest one still running", () => {
    const user = {};
    const a = tool("bash", { isPartial: true, result: undefined });
    const b = tool("read");
    expect(rows(() => frame(user, [a, b]))[1]).toBe("  └ bash row");
  });

  test("a boundary closes the group to one row, in a repaint", () => {
    const user = {};
    const text = {};
    const a = tool("bash");
    const b = tool("read");
    rows(() => frame(user, [a, b]));
    takeLateJoin();
    const render = () => {
      noteBoundary(user);
      const drawn = [renderGroupedTool(a, 80, theme, own(a), viewOptions), renderGroupedTool(b, 80, theme, own(b), viewOptions)];
      noteBoundary(text);
      return drawn;
    };
    // The frame that first meets the boundary already drew the rows above it.
    render();
    expect(takeLateJoin()).toBe(true);
    expect(rows(render)).toEqual(["▸ Used shell once, read once"]);
  });

  test("the end of the run closes the group and repaints it", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("read");
    rows(() => frame(user, [a, b]));
    const before = b.renders;
    setAgentRunning(false);
    settleLiveGroup();
    expect(a.renders + b.renders).toBeGreaterThan(before);
    expect(rows(() => frame(user, [a, b]))).toEqual(["▸ Used shell once, read once"]);
  });

  test("a group of one closes to its own row", () => {
    const user = {};
    const a = tool("bash");
    expect(rows(() => frame(user, [a]))).toHaveLength(2);
    setAgentRunning(false);
    expect(frame(user, [a])[0]).toBeUndefined();
  });

  test("a finished call holds until new thinking has streamed for the hold", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("read");
    const carrier = { recap: "the config is next", isStreaming: true };
    const render = () => {
      const drawn = frame(user, [a, b]);
      noteCarrier(carrier);
      return drawn;
    };
    expect(rows(() => frame(user, [a, b]))[1]).toBe("  └ read row");
    expect(rows(render)[1]).toBe("  └ read row");
    now += THINKING_HOLD_MS - 1;
    expect(planFor(b)).toMatchObject({ liveRow: true, revealIn: 1 });
    expect(rows(render)[1]).toBe("  └ read row");
    now += 1;
    expect(rows(render)[1]).toBe("  └ thinking: the config is next");
    expect(rows(render)).toHaveLength(2);
    // Newest wins: the call that thinking led to takes the row at once.
    carrier.isStreaming = false;
    const c = tool("bash", { isPartial: true, result: undefined });
    const next = () => {
      noteBoundary(user);
      const drawn = [a, b].map((t) => renderGroupedTool(t, 80, theme, own(t), viewOptions));
      noteCarrier(carrier);
      drawn.push(renderGroupedTool(c, 80, theme, own(c), viewOptions));
      return drawn;
    };
    expect(rows(next)[1]).toBe("  └ bash row");
  });

  test("the second row is one line, clipped to the width", () => {
    const user = {};
    const a = tool("bash");
    const long = () => ["", "  first line", "  second line"];
    const render = () => {
      noteBoundary(user);
      return [renderGroupedTool(a, 40, theme, long, viewOptions)];
    };
    expect(rows(render)).toEqual(["▸ Used shell once", "  └ first line"]);
    const clipped = realClip(`
      noteBoundary(user);
      const draw = () => renderGroupedTool(a, 40, theme, () => ["", "  " + "x".repeat(200)]);
      draw(); noteBoundary(user); return draw().at(-1);
    `);
    expect(visibleWidth(clipped)).toBeLessThanOrEqual(40);
    expect(clipped).toEndWith("…");
  });

  test("a failed call stays on the first row and keeps its marker on the second", () => {
    const user = {};
    const a = tool("bash", { result: { durationMs: 10, isError: true } });
    const b = tool("read", { result: { durationMs: 10, isError: true } });
    const failed = () => ["", "! read row"];
    const render = () => {
      noteBoundary(user);
      return [renderGroupedTool(a, 80, theme, own(a), viewOptions), renderGroupedTool(b, 80, theme, failed, viewOptions)];
    };
    expect(rows(render)).toEqual(["▸ Used shell once, read once  2 failed", "  ! read row"]);
  });

  test("elapsed time runs from the first step to the last call's end, shown only once closed", () => {
    const user = {};
    const t0 = now;
    const carrierA = { lastMessage: { timestamp: t0 } };
    const carrierB = { lastMessage: { timestamp: t0 + 20000 } };
    const a = tool("bash", { result: { durationMs: 50, isError: false } });
    const b = tool("read", { result: { durationMs: 7000, isError: false } });
    const render = () => {
      noteBoundary(user);
      noteCarrier(carrierA);
      const first = renderGroupedTool(a, 80, theme, own(a), viewOptions);
      noteCarrier(carrierB);
      return [first, renderGroupedTool(b, 80, theme, own(b), viewOptions)];
    };
    expect(rows(render)[0]).toBe("▸ Used shell once, read once");
    setAgentRunning(false);
    expect(rows(render)).toEqual(["▸ Used shell once, read once  27s"]);
  });

  test("a reloaded session uses message timestamps and no render time", () => {
    setAgentRunning(false);
    const user = {};
    const t0 = now - 3_600_000;
    const carrierA = { lastMessage: { timestamp: t0 } };
    const carrierB = { lastMessage: { timestamp: t0 + 4000 } };
    const a = tool("bash");
    const b = tool("read", { result: { durationMs: 1000, isError: false } });
    const render = () => {
      noteBoundary(user);
      noteCarrier(carrierA);
      const first = renderGroupedTool(a, 80, theme, own(a), viewOptions);
      noteCarrier(carrierB);
      return [first, renderGroupedTool(b, 80, theme, own(b), viewOptions)];
    };
    expect(rows(render)).toEqual(["▸ Used shell once, read once  5.0s"]);
  });

  test("without message timestamps the row shows no time rather than an invented one", () => {
    setAgentRunning(false);
    const user = {};
    const a = tool("bash", { result: { durationMs: 9000, isError: false } });
    const b = tool("read", { result: { durationMs: 9000, isError: false } });
    expect(rows(() => frame(user, [a, b]))).toEqual(["▸ Used shell once, read once"]);
  });
});

describe("closed row", () => {
  const styled = { ...theme, style: (text: string, attrs: { bold?: boolean }) => (attrs.bold ? `**${text}**` : text) };

  test("the tool or action is bold and the rest regular, on one line", () => {
    const line = formatGroupHeader(buildGroupSummary([tool("bash"), tool("bash"), tool("read")]), "closed", styled);
    expect(line).toBe("▸ Used **shell** twice, **read** once");
  });

  test("a run of used phrases says the verb once, and a verbless first phrase capitalises", () => {
    expect(formatGroupHeader(buildGroupSummary([tool("bash"), tool("bash"), tool("gitnexus_query")]), "closed", styled)).toBe("▸ Used **shell** twice, **GitNexus** once");
    expect(formatGroupHeader(buildGroupSummary([tool("read"), tool("read"), tool("codemode")]), "closed", styled)).toBe("▸ **Read** twice, ran **code** once");
  });

  test("the live row hides the time and a failure outlasts a clip", () => {
    const summary = { count: 9, failed: 1, elapsedMs: 4200, breakdown: [{ name: "bash", count: 4 }, { name: "gitnexus_query", count: 3 }, { name: "grep", count: 2 }] };
    expect(formatGroupHeader(summary, "closed", theme, 80, true)).toEndWith("1 failed");
    const clipped = realClip(`return formatGroupHeader(${JSON.stringify(summary)}, "closed", theme, 40);`);
    expect(clipped).toEndWith("…  1 failed  4.2s");
    expect(visibleWidth(clipped)).toBeLessThanOrEqual(40);
  });

  test("edits and writes fold; messages, background and worker control keep their row; subagent is gone", () => {
    for (const name of ["edit", "write", "subagent"]) expect(PINNED_TOOLS.has(name)).toBe(false);
    for (const name of ["SendMessage", "intercom", "BashBackground", "Monitor", "BackgroundStop", "bg_run", "bg_kill", "specialist_dispatch", "specialist_reply", "specialist_steer", "specialist_stop_activation", "ask_coordinator"]) {
      expect(PINNED_TOOLS.has(name)).toBe(true);
    }
    expect(formatGroupHeader(buildGroupSummary([tool("edit"), tool("edit"), tool("write")]), "closed", theme)).toBe("▸ Edited twice, wrote once");
  });
});

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

  test("a pinned call renders as usual and starts a new group after it", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("bash");
    const message = tool("SendMessage");
    const c = tool("read");
    const d = tool("read");
    frame(user, [a, b, message, c, d]);
    const lines = frame(user, [a, b, message, c, d]);
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

  test("an open group lists each thinking step above its call, in transcript order", () => {
    const user = {};
    const carrierA = { recap: "checking the log" };
    const carrierB = { recap: "the config is next" };
    const a = tool("bash");
    const b = tool("read");
    const render = () => {
      noteBoundary(user);
      noteCarrier(carrierA);
      const first = renderGroupedTool(a, 80, theme, own(a), viewOptions);
      noteCarrier(carrierB);
      const second = renderGroupedTool(b, 80, theme, own(b), viewOptions);
      return [...(first ?? []), ...(second ?? [])];
    };
    render();
    render();
    openGroup(a);
    const rows = render().map((line) => line.trim());
    expect(rows.slice(1)).toEqual(["▾ Used shell once, read once", "└ thinking: checking the log", "bash row", "thinking: the config is next", "read row"]);
    // Folded, the same steps add nothing.
    closeGroup(a);
    expect(render().filter((line) => line.includes("thinking:"))).toEqual([]);
  });

  test("a click on a call's row still opens that call when a thinking row sits above it", () => {
    const user = {};
    const carrier = { recap: "checking the log" };
    const a = tool("bash");
    const b = tool("read");
    const render = () => {
      noteBoundary(user);
      noteCarrier(carrier);
      return [renderGroupedTool(a, 80, theme, own(a), viewOptions), renderGroupedTool(b, 80, theme, own(b), viewOptions)];
    };
    render();
    render();
    openGroup(a);
    const lines = render()[0]!;
    const y = lines.findIndex((line) => line.includes("bash row"));
    routeGroupedMouse(a, { type: "click", button: "left", y: y - 1 }, asPointer);
    expect(a.expanded).toBe(false);
    routeGroupedMouse(a, { type: "click", button: "left", y }, asPointer);
    expect(a.expanded).toBe(true);
  });

  test("the summary counts failures and has no time while a call runs", () => {
    const members = [
      tool("bash", { result: { durationMs: 1200, isError: true } }),
      tool("bash", { result: { durationMs: 900, isError: false } }),
      tool("read", { isPartial: true, result: undefined }),
    ];
    const summary = buildGroupSummary(members, 1000);
    expect(summary).toMatchObject({ count: 3, failed: 1 });
    expect(summary.elapsedMs).toBeUndefined();
    expect(formatGroupHeader(summary, "closed", theme)).toBe("▸ Used shell twice, read once  1 failed");
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

  test("after the run a dropped component that still claims to stream shows nothing", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("bash");
    frame(user, [a, b]);
    noteCarrier({ isStreaming: true, recap: "stale" });
    setAgentRunning(false);
    frame(user, [a, b]);
    expect(frame(user, [a, b]).flat().join("\n")).not.toContain("stale");
  });

  test("a step that gains text closes the group it was thinking in", () => {
    const user = {};
    const a = tool("bash");
    const b = tool("bash");
    const step = { isStreaming: true, recap: "stale" };
    setAgentRunning(true);
    frame(user, [a, b]);
    noteCarrier(step);
    noteBoundary(step);
    frame(user, [a, b]);
    expect(frame(user, [a, b]).flat().filter(Boolean)).toEqual(["▸ Used shell twice"]);
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
