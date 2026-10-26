import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => {
  const tool = (name: string) => ({ name, description: name, parameters: {}, execute: vi.fn() });
  return {
    CustomEditor: class {},
    createBashTool: () => tool("bash"),
    createEditTool: () => tool("edit"),
    createFindTool: () => tool("find"),
    createGrepTool: () => tool("grep"),
    createLsTool: () => tool("ls"),
    createReadTool: () => tool("read"),
    createWriteTool: () => tool("write"),
  };
});

vi.mock("@earendil-works/pi-tui", () => ({
  Box: class {},
  Text: class {
    constructor(private text: string) {}
    render() { return this.text.split("\n"); }
  },
  truncateToWidth: (text: string, width?: number) =>
    typeof width === "number" && width > 0 && text.length > width ? text.slice(0, width) : text,
  visibleWidth: (text: string) => text.length,
  wrapTextWithAnsi: (text: string, width: number) => {
    const lines: string[] = [];
    for (const line of text.split("\n")) {
      if (!line) {
        lines.push("");
        continue;
      }
      for (let offset = 0; offset < line.length; offset += width) {
        lines.push(line.slice(offset, offset + width));
      }
    }
    return lines;
  },
}));

const {
	buildCollapsedThinkingRow,
	buildExpandedThinkingBlock,
	buildThinkingRecap,
	collapsedExternalToolLines,
	DEFAULT_PREFS,
	default: xtrmUiExtension,
	fitThinkingRowToWidth,
	piRuntimeEntryForCliPath,
	renderExternalToolBackgroundLines,
	selectPatchBase,
	setActivePrefsSnapshotForTests,
	setActiveThemeProvider,
} = await import("../../../packages/pi-extensions/extensions/xtrm-ui/index");

function loadExtension() {
  const handlers: Record<string, Function[]> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const entries: Array<{ customType: string; data: unknown }> = [];
  const messages: any[] = [];
  const pi = new Proxy(
    {
      appendEntry(customType: string, data: unknown) {
        entries.push({ customType, data });
      },
      getThinkingLevel: () => "off",
      on(event: string, handler: Function) {
        (handlers[event] ??= []).push(handler);
      },
      registerTool(tool: any) {
        tools[tool.name] = tool;
      },
      registerCommand(name: string, command: any) {
        commands[name] = command;
      },
      registerMessageRenderer() {},
      sendMessage(message: unknown) {
        messages.push(message);
      },
    },
    { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} },
  );

  xtrmUiExtension(pi as any);
  return { commands, entries, handlers, messages, tools };
}

function commandContext() {
  const notifications: Array<[string, string]> = [];
  const ui = {
    notify(message: string, level: string) {
      notifications.push([message, level]);
    },
    setEditorComponent: vi.fn(),
    setFooter: vi.fn(),
    setHeader: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
    setTheme: vi.fn(),
    setWorkingIndicator: vi.fn(),
    setToolsExpanded: vi.fn(),
  };
  return {
    context: {
      cwd: "/tmp/project",
      getContextUsage: () => ({ tokens: 42, contextWindow: 100 }),
      model: { id: "test-model" },
      sessionManager: { getEntries: () => [] },
      ui,
    },
    notifications,
    ui,
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const context = (args: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  args,
  toolCallId: "call-1",
  invalidate() {},
  lastComponent: undefined,
  state: {},
  cwd: "/tmp",
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: true,
  isError: false,
  ...overrides,
});

describe("xtrm-ui commands", () => {
  const supportedCommands = [
    "xtrm-ui",
    "xtrm-ui-command-lines",
    "xtrm-ui-density",
    "xtrm-ui-diff-lines",
    "xtrm-ui-ext-compact",
    "xtrm-ui-ext-lines",
    "xtrm-ui-forcetheme",
    "xtrm-ui-header",
    "xtrm-ui-reset",
    "xtrm-ui-result-lines",
    "xtrm-ui-rowbg",
    "xtrm-ui-theme",
    "xtrm-ui-ultra",
  ];

  it("registers only commands backed by active behavior", () => {
    const { commands } = loadExtension();

    expect(Object.keys(commands).sort()).toEqual(supportedCommands);
  });

  it("leaves theme ownership to the global Pi runtime sync", () => {
    const { handlers } = loadExtension();
    expect(handlers.resources_discover).toBeUndefined();
  });

  it("reports only active preferences and rejects subcommands", async () => {
    const { commands, entries, messages } = loadExtension();
    const { context, notifications } = commandContext();

    await commands["xtrm-ui"].handler("", context);
    await commands["xtrm-ui"].handler("chrome box", context);

    expect(messages[0].content).toContain("Theme: xtrm-dark");
    expect(messages[0].content).toContain("Density: compact");
    expect(messages[0].content).toContain("Show header: yes");
    expect(messages[0].content).toContain("Force theme: on");
    expect(messages[0].content).toContain("Tool row background: off");
    expect(messages[0].content).not.toMatch(/footer|external tool chrome|compact external/i);
    expect(notifications).toContainEqual(["Usage: /xtrm-ui", "warning"]);
    expect(entries).toEqual([]);
  });

  it.each([
    ["xtrm-ui-theme", "light", "themeName", "xtrm-light"],
    ["xtrm-ui-density", "comfortable", "density", "comfortable"],
    ["xtrm-ui-header", "off", "showHeader", false],
    ["xtrm-ui-forcetheme", "off", "forceTheme", false],
    ["xtrm-ui-rowbg", "on", "toolRowBg", true],
  ])("persists and applies /%s", async (name, arg, key, expected) => {
    const { commands, entries } = loadExtension();
    const { context, ui } = commandContext();

    await commands[name].handler(arg, context);

    expect(entries).toHaveLength(1);
    expect(entries[0].data).toMatchObject({ [key]: expected });
    expect(ui.setEditorComponent).toHaveBeenCalledOnce();
    expect(ui.setFooter).not.toHaveBeenCalled();
  });

  it("applies theme variants and respects disabled theme ownership", async () => {
    const themeExtension = loadExtension();
    const themeCommand = commandContext();
    await themeExtension.commands["xtrm-ui-theme"].handler("light", themeCommand.context);
    expect(themeCommand.ui.setTheme).toHaveBeenCalledWith("xtrm-light-flattools");

    const rowExtension = loadExtension();
    const rowCommand = commandContext();
    await rowExtension.commands["xtrm-ui-rowbg"].handler("on", rowCommand.context);
    expect(rowCommand.ui.setTheme).toHaveBeenCalledWith("xtrm-dark");

    const forceExtension = loadExtension();
    const forceCommand = commandContext();
    await forceExtension.commands["xtrm-ui-forcetheme"].handler("off", forceCommand.context);
    expect(forceCommand.ui.setTheme).not.toHaveBeenCalled();
  });

  it.each([
    ["xtrm-ui-theme", "blue", "/xtrm-ui-theme dark|light"],
    ["xtrm-ui-density", "dense", "/xtrm-ui-density compact|comfortable"],
    ["xtrm-ui-header", "maybe", "/xtrm-ui-header on|off"],
    ["xtrm-ui-forcetheme", "maybe", "/xtrm-ui-forcetheme on|off"],
    ["xtrm-ui-rowbg", "maybe", "/xtrm-ui-rowbg on|off"],
  ])("rejects invalid /%s arguments", async (name, arg, usage) => {
    const { commands, entries } = loadExtension();
    const { context, notifications, ui } = commandContext();

    await commands[name].handler(arg, context);

    expect(notifications).toContainEqual([`Usage: ${usage}`, "warning"]);
    expect(entries).toEqual([]);
    expect(ui.setEditorComponent).not.toHaveBeenCalled();
  });

  it("resets exactly to the supported defaults", async () => {
    const { commands, entries } = loadExtension();
    const { context } = commandContext();

    await commands["xtrm-ui-reset"].handler("ignored", context);

    expect(entries).toEqual([{ customType: "xtrm-ui-prefs", data: DEFAULT_PREFS }]);
    expect(DEFAULT_PREFS).toEqual({
      themeName: "xtrm-dark",
      density: "compact",
      commandPreviewLines: 4,
      diffPreviewLines: 18,
      extNoCompact: false,
      extPreviewLines: 6,
      resultPreviewLines: 6,
      showHeader: true,
      forceTheme: true,
      toolRowBg: false,
      ultracompact: true,
    });
  });

  it("regulates extension compaction with two dedicated commands", async () => {
    const { commands, entries } = loadExtension();
    const { context, notifications } = commandContext();

    await commands["xtrm-ui-ext-lines"].handler("3", context);
    expect(entries.at(-1)).toMatchObject({ customType: "xtrm-ui-prefs", data: { extPreviewLines: 3 } });

    await commands["xtrm-ui-ext-lines"].handler("99", context);
    expect(notifications.at(-1)).toEqual(["Usage: /xtrm-ui-ext-lines <1-50>", "warning"]);

    await commands["xtrm-ui-ext-compact"].handler("off", context);
    expect(entries.at(-1)).toMatchObject({ customType: "xtrm-ui-prefs", data: { extNoCompact: true } });

    await commands["xtrm-ui-ext-compact"].handler("on", context);
    expect(entries.at(-1)).toMatchObject({ customType: "xtrm-ui-prefs", data: { extNoCompact: false } });

    await commands["xtrm-ui-ext-compact"].handler("maybe", context);
    expect(notifications.at(-1)).toEqual(["Usage: /xtrm-ui-ext-compact on|off", "warning"]);
  });

  it("migrates legacy session themes without restoring obsolete preferences", async () => {
    const { handlers } = loadExtension();
    const { context, ui } = commandContext();
    context.sessionManager.getEntries = () => [{
      type: "custom",
      customType: "xtrm-ui-prefs",
      data: {
        themeName: "pidex-light-flattools",
        compactExternalToolResults: false,
        externalToolChrome: "box",
        showFooter: true,
      },
    }];

    await handlers.session_start[0]({}, context);

    expect(ui.setTheme).toHaveBeenCalledWith("xtrm-light-flattools");
    expect(ui.setFooter).not.toHaveBeenCalled();
    expect(ui.setHiddenThinkingLabel).toHaveBeenCalledWith("");
  });
});

const thinkingStyle = {
	label: (text: string) => `B[${text}]`,
	recap: (text: string) => `D[${text}]`,
	sep: " · ",
};

describe("xtrm-ui thinking chrome", () => {
  it("recaps the first non-empty thinking line", () => {
    expect(buildThinkingRecap("\nPR #522 is queued. Only 5 checks listed.\n")).toBe(
      "PR #522 is queued. Only 5 checks listed.",
    );
  });

  it("skips one-word fragments and picks the first substantive line", () => {
    expect(buildThinkingRecap("**The**\nNo bold at the render width")).toBe(
      "No bold at the render width",
    );
  });

  it("skips fragment first lines and strips list markers", () => {
    const recap = buildThinkingRecap("Now:\n- \"toggled compact preview\" PASSES (test bug fixed)");
    expect(recap).toBe("\"toggled compact preview\" PASSES (test bug fixed)");
  });

  it("strips markdown emphasis and collapses whitespace", () => {
    expect(buildThinkingRecap("**bold** and `code` with   spaces\nnext")).toBe("bold and code with spaces");
  });

  it("truncates long recaps with an ellipsis at the 64-character cap", () => {
    const long = "word ".repeat(100).trim();
    const recap = buildThinkingRecap(long);
    expect(recap.length).toBeLessThanOrEqual(64);
    expect(recap.endsWith("…")).toBe(true);
  });

  it("falls back to the label when thinking is blank", () => {
    expect(buildThinkingRecap("   \n\t\n")).toBe("Thinking...");
  });

  it("builds the collapsed row: label plus one clause, no count, no hint", () => {
    const row = buildCollapsedThinkingRow("PR #522 queued", thinkingStyle);
    expect(row).toBe("\u200b B[Thinking...] · D[PR #522 queued]");
    expect(row).not.toContain("Ctrl+T");
  });

  it("builds the expanded block without an inline shortcut", () => {
    const block = buildExpandedThinkingBlock("Full trace\nsecond line", thinkingStyle);
    expect(block).toBe("\u200b B[Thinking...]\n\nD[\u200b Full trace\n\u200b second line]");
    expect(block).not.toContain("Ctrl+T");
  });
  it("keeps the collapsed row on one line and truncates the recap to fit", () => {
    const row = `\u200b Thinking... · ${'x'.repeat(80)}`;
    const fitted = fitThinkingRowToWidth(row, 40);
    expect(fitted.split("\n")).toHaveLength(1);
    expect(fitted.startsWith("\u200b Thinking... · ")).toBe(true);
    expect(fitted.length).toBeLessThan(row.length);
  });

  it("leaves a fitting row untouched", () => {
    const row = "\u200b Thinking... · short recap";
    expect(fitThinkingRowToWidth(row, 80)).toBe(row);
  });

  it("leaves expanded and non-row markdown untouched", () => {
    const expanded = "Thinking...\n\nfull trace here";
    expect(fitThinkingRowToWidth(expanded, 40)).toBe(expanded);
    expect(fitThinkingRowToWidth("regular assistant text", 40)).toBe("regular assistant text");
  });

  it("passes through when no width is available", () => {
    const row = "\u200b Thinking... · " + "x".repeat(80);
    expect(fitThinkingRowToWidth(row, undefined)).toBe(row);
  });
});

/** Load the extension and turn the one-line default off, so the tree contract renders. */
async function loadTreeExtension() {
  const bundle = loadExtension();
  const { context: ctx } = commandContext();
  await bundle.commands["xtrm-ui-ultra"].handler("off", ctx);
  return bundle;
}

describe("xtrm-ui built-in tool rendering", () => {
  // These exercise the tree/expanded presentation. The one-line default has its
  // own test; prefs + theme are module state, so pin them per test.
  beforeEach(() => {
    setActivePrefsSnapshotForTests({ ...DEFAULT_PREFS, ultracompact: false });
    setActiveThemeProvider(null);
  });
  afterEach(() => setActivePrefsSnapshotForTests({ ...DEFAULT_PREFS }));

  it("renders a concise one-line row by default", async () => {
    setActivePrefsSnapshotForTests({ ...DEFAULT_PREFS });
    const { tools } = loadExtension();
    const args = { command: "echo context-label" };
    const rows = tools.bash.renderResult(
      { content: [{ type: "text", text: "context-label" }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      context(args),
    ).render(200);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Ran shell command");
    expect(rows[0]).toContain("echo context-label");
  });

  it("uses one consistent bash row across call phases", async () => {
    const { tools } = await loadTreeExtension();
    const args = { command: "echo context-label" };
    const pending = tools.bash.renderCall(
      args,
      theme,
      context(args, { executionStarted: false, isPartial: true }),
    );
    const running = tools.bash.renderCall(
      args,
      theme,
      context(args, { executionStarted: true, isPartial: true }),
    );

    expect(pending.render(200).join("\n")).toBe("● Ran echo context-label");
    expect(running.render(200).join("\n")).toBe("");
  });

  it("renders multiline bash commands and six collapsed output lines flat", async () => {
    const { tools } = await loadTreeExtension();
    const output = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
    const component = tools.bash.renderResult(
      { content: [{ type: "text", text: output }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      context({ command: "echo one\necho two" }),
    );

    const lines = component.render(200);
    expect(lines.slice(0, 3)).toEqual([
      "● Ran echo one",
      "  echo two",
      "  └ line 3",
    ]);
    // Compact hidden-content indicator; the shortcut is documented globally.
    expect(lines.at(-1)).toContain("+2 lines");
    expect(lines.join("\n")).not.toContain("ctrl+o expand");
  });

  it("keeps a long one-line row on one line instead of wrapping", () => {
    const { tools } = loadExtension();
    const lines = tools.bash
      .renderResult(
        { content: [{ type: "text", text: "ok" }], details: {} },
        { expanded: false, isPartial: false },
        theme,
        context({ command: `echo ${"x".repeat(200)}` }),
      )
      .render(40);
    expect(lines.length).toBe(1);
    expect(lines[0].length).toBeLessThanOrEqual(40);
  });

  it("leaves a multi-line expanded row unclipped", () => {
    const { tools } = loadExtension();
    const lines = tools.bash
      .renderResult(
        { content: [{ type: "text", text: "y".repeat(120) }], details: {} },
        { expanded: true, isPartial: false },
        theme,
        context({ command: "echo hi" }),
      )
      .render(40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((line) => line.includes("y".repeat(100)))).toBe(true);
  });

  it("moves row emphasis through theme tokens and never uses a hue", async () => {
    const { tools } = await loadTreeExtension();
    const colors: string[] = [];
    const spyTheme = {
      ...theme,
      fg: (color: string, text: string) => {
        colors.push(color);
        return text;
      },
    };
    const result = { content: [{ type: "text", text: "" }], details: {} };
    const renderOptions = { expanded: false, isPartial: false };

    colors.length = 0;
    tools.bash.renderResult(result, renderOptions, spyTheme, context({ command: "echo ok" }));
    // marker (structural) · identifier (toolTitle) · subject (toolTitle, upright)
    expect(colors.slice(0, 3)).toEqual(["dim", "toolTitle", "toolTitle"]);

    colors.length = 0;
    tools.bash.renderResult(
      result,
      renderOptions,
      spyTheme,
      context({ command: "echo fail" }, { isError: true }),
    );
    expect(colors.slice(0, 3)).toEqual(["error", "error", "error"]);

    colors.length = 0;
    tools.bash.renderCall(
      { command: "echo pending" },
      spyTheme,
      context({ command: "echo pending" }, { executionStarted: false, isPartial: true }),
    );
    expect(colors.slice(0, 3)).toEqual(["dim", "toolTitle", "toolTitle"]);
  });

  it.each([
    ["read", { path: "sample.txt" }, "sample.txt", "line"],
    ["find", { pattern: "*.ts" }, "*.ts", "match"],
    ["grep", { pattern: "needle" }, "needle", "match"],
    ["ls", { path: "." }, ".", "entry"],
  ])("shows six collapsed output lines for %s", async (name, args, subject, noun) => {
    const { tools } = await loadTreeExtension();
    const output = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
    const component = tools[name].renderResult(
      { content: [{ type: "text", text: output }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      context(args),
    );

    const lines = component.render(200);
    expect(lines[0]).toBe(`● ${name} ${subject}`);
    expect(lines[1]).toBe("  └ line 1");
    expect(lines[6]).toBe("    line 6");
    expect(lines.at(-1)).toContain(`+2 ${noun}s`);
    expect(lines.join("\n")).not.toContain("ctrl+o expand");
  });

  it("shows small native results without an expansion hint", async () => {
    const { tools } = await loadTreeExtension();
    const lines = tools.find.renderResult(
      { content: [{ type: "text", text: "only.ts" }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      context({ pattern: "*.ts" }),
    ).render(200);

    // Fully shown and fast: the row ends where its content ends. No trailing
    // size/line-count/duration fields, no repeated shortcut hint.
    expect(lines).toEqual([
      "● find *.ts",
      "  └ only.ts",
    ]);
    expect(lines.join("\n")).not.toContain("ctrl+o expand");
  });

  it("renders edit diffs and new writes flat", async () => {
    const { tools } = await loadTreeExtension();
    const path = join(mkdtempSync(join(tmpdir(), "xtrm-ui-")), "new.txt");
    const content = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
    const writeContext = context({ path, content });
    tools.write.renderCall(writeContext.args, theme, writeContext);

    const write = tools.write.renderResult(
      { content: [{ type: "text", text: "ok" }], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      writeContext,
    ).render(200);
    const edit = tools.edit.renderResult(
      { content: [{ type: "text", text: "ok" }], details: { diff: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new" } },
      { expanded: false, isPartial: false },
      theme,
      context({ path }),
    ).render(200);

    expect(write[0]).toBe(`● write ${path}`);
    expect(write[1]).toBe("  └ line 1");
    expect(write.at(-1)).toContain("+2 lines");
    expect(edit[0]).toBe(`● edit ${path}`);
    expect(edit[1]).toMatch(/│ /); // diff line-number gutter, not the tool tree
  });

  it("keeps pre-write diff data in renderer-local state", async () => {
    const { tools } = await loadTreeExtension();
    const path = join(mkdtempSync(join(tmpdir(), "xtrm-ui-")), "probe.txt");
    writeFileSync(path, "before\n");
    const renderContext = context({ path, content: "after\n" });

    tools.write.renderCall(renderContext.args, theme, renderContext);
    const component = tools.write.renderResult(
      { content: [{ type: "text", text: "ok" }], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      renderContext,
    );

    expect(component.render(200).join("\n")).toContain("+1 -1");
  });

  it("does not register built-in lifecycle tracking hooks", async () => {
    const { handlers } = loadExtension();

    expect(handlers.tool_call).toBeUndefined();
    expect(handlers.tool_execution_end).toBeUndefined();
    expect(handlers.tool_result).toBeUndefined();
  });
});

describe("xtrm-ui pi runtime resolution", () => {
  it("targets the bundled runtime used by dist/bundle/cli.js", () => {
    expect(piRuntimeEntryForCliPath("/opt/pi/dist/bundle/cli.js"))
      .toBe("/opt/pi/dist/bundle/index.js");
  });

  it("keeps unbundled dist/cli.js compatibility", () => {
    expect(piRuntimeEntryForCliPath("/opt/pi/dist/cli.js"))
      .toBe("/opt/pi/dist/index.js");
  });

  it("rejects unrelated entry paths", () => {
    expect(piRuntimeEntryForCliPath("/opt/other/cli.js")).toBeUndefined();
  });
});

describe("xtrm-ui prototype patch upgrades", () => {
  const base = () => "base";
  const wrapped = () => "wrapped";

  it("uses the current method for a fresh install", () => {
    expect(selectPatchBase(base, undefined, 23, undefined, "test patch")).toBe(base);
  });

  it("skips an already-current patch", () => {
    expect(selectPatchBase(wrapped, 23, 23, base, "test patch")).toBeUndefined();
  });

  it("replaces an older patch from the preserved original", () => {
    expect(selectPatchBase(wrapped, 22, 23, base, "test patch")).toBe(base);
  });

  it("refuses to stack over a legacy patch without its original", () => {
    expect(() => selectPatchBase(wrapped, 22, 23, undefined, "test patch"))
      .toThrow("test patch was installed by a legacy version; restart pi before upgrading");
  });
});

describe("xtrm-ui external tool rendering", () => {
  const mark = {
    fg: (color: string, text: string) => `[${color}]${text}`,
    bold: (text: string) => `*${text}*`,
    italic: (text: string) => `_${text}_`,
  };
  const strip = (text: string) => text.replace(/\[[a-z]+\]/g, "").replace(/\*/g, "").replace(/_/g, "");

  beforeEach(() => setActiveThemeProvider(() => mark));
  afterEach(() => setActiveThemeProvider(null));

  it("renders one indented footer with a compact hidden-line indicator", () => {
    const rendered = renderExternalToolBackgroundLines(
      ["[GitNexus]", ...Array.from({ length: 94 }, (_, index) => `line ${index + 1}`)],
      200,
      "gitnexus",
      false,
      "gitnexus_query",
      1600,
    );
    const footer = rendered.at(-1)!;

    expect(strip(footer)).toContain("+88 lines");
    expect(strip(footer)).toContain("1.6s");
    expect(strip(footer)).not.toContain("ctrl+o");
    expect(strip(footer)).not.toContain("showing");
    expect(strip(footer)).toMatch(/^  └─ /);
  });

  it("renders a Serena row through theme tokens and pretty-prints single-line JSON", () => {
    const rendered = renderExternalToolBackgroundLines(
      ['[{"name_path":"highlightExternalToolBadge","kind":"Function"}]'],
      200,
      "serena",
      false,
      "find_symbol",
    );

    // ● used <Serena: tool-name level, bold> <find_symbol: dim, bold>
    expect(rendered[0]).toContain("[toolTitle]*Serena*");
    expect(rendered[0]).toContain("[dim]*find_symbol*");
    expect(rendered[0]).not.toContain("38;2;");
    expect(rendered.length).toBeGreaterThan(2);
    expect(rendered.join("\n")).toContain('"name_path": "highlightExternalToolBadge"');
  });

  it("uses the real name for generic external tools", () => {
    const rendered = renderExternalToolBackgroundLines(
      ["plain result"],
      200,
      "external",
      false,
      "mcp_custom_tool",
    );

    expect(rendered[0]).toContain("[toolTitle]*mcp*");
    expect(rendered[0]).toContain("[dim]*custom_tool*");
  });

  it("keeps the provider label without a hue", () => {
    const rendered = renderExternalToolBackgroundLines(
      ["[GitNexus]", "{", '  "status": "found"', "}"],
      200,
      "gitnexus",
      false,
      "gitnexus_query",
    );
    const line = rendered[0]!;
    expect(line).toContain("[toolTitle]*GitNexus*");
    expect(line).not.toContain("154;139;255");
    expect(line).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  it("marks a failed frame with the error token and the ! marker, never red", () => {
    const rendered = renderExternalToolBackgroundLines(["boom"], 200, "external", false, "probe", 5, "error");
    expect(rendered[0]).toContain("[error]!");
    expect(rendered[0]).not.toContain("38;2;");
    expect(rendered.join("\n")).not.toContain("255;154;154");
  });

  it("keeps collapsed structured output multiline and bounded", () => {
    const lines = ["[GitNexus]", "{", "  summary: {", "    changed: 11", "  },", "  symbols: [", "    one", "  ]", "}"];

    expect(collapsedExternalToolLines(lines, false).map(strip)).toEqual([
      "[GitNexus]",
      "{",
      "  summary: {",
      "    changed: 11",
      "  },",
      "  symbols: [",
      "  +3 lines",
    ]);
    expect(collapsedExternalToolLines(lines, true)).toEqual(lines);
  });
});
