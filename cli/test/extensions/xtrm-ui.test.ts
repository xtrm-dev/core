import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

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
    "xtrm-ui-density",
    "xtrm-ui-forcetheme",
    "xtrm-ui-header",
    "xtrm-ui-reset",
    "xtrm-ui-rowbg",
    "xtrm-ui-theme",
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
      showHeader: true,
      forceTheme: true,
      toolRowBg: false,
    });
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
	hint: (text: string) => `H[${text}]`,
	sep: " · ",
};

describe("xtrm-ui thinking chrome", () => {
  it("recaps the first non-empty thinking line", () => {
    expect(buildThinkingRecap("\nPR #522 is queued. Only 5 checks listed.\n")).toBe(
      "PR #522 is queued. Only 5 checks listed.",
    );
  });

  it("skips one-word fragments and picks the first substantive line", () => {
    expect(buildThinkingRecap("**The**\nThe user reports no bold at the render width in the real pipeline")).toBe(
      "The user reports no bold at the render width in the real pipeline",
    );
  });

  it("skips fragment first lines and strips list markers", () => {
    const recap = buildThinkingRecap("Now:\n- \"toggled compact preview\" PASSES (test bug fixed)");
    expect(recap).toBe("\"toggled compact preview\" PASSES (test bug fixed)");
  });

  it("strips markdown emphasis and collapses whitespace", () => {
    expect(buildThinkingRecap("**bold** and `code` with   spaces\nnext")).toBe("bold and code with spaces");
  });

  it("truncates long recaps with an ellipsis", () => {
    const long = "x".repeat(500);
    const recap = buildThinkingRecap(long);
    expect(recap.length).toBe(120);
    expect(recap.endsWith("...")).toBe(true);
  });

  it("falls back to the label when thinking is blank", () => {
    expect(buildThinkingRecap("   \n\t\n")).toBe("Thinking...");
  });

  it("builds the collapsed row with bold label, dim recap, char count and expand hint", () => {
    const row = buildCollapsedThinkingRow("PR #522 queued", 14, thinkingStyle);
    expect(row).toBe(" B[Thinking...] · D[PR #522 queued] · D[14] H[(Ctrl+T to expand)]");
  });

  it("builds the expanded block with collapse hint and full dimmed trace", () => {
    const block = buildExpandedThinkingBlock("Full trace\nsecond line", thinkingStyle);
    expect(block).toBe("B[Thinking...] H[(Ctrl+T to collapse)]\n\nD[Full trace\nsecond line]");
  });
  it("keeps the collapsed row on one line and truncates the recap to fit", () => {
    const row = ` Thinking... · ${'x'.repeat(80)} (Ctrl+T to expand)`;
    const fitted = fitThinkingRowToWidth(row, 40);
    expect(fitted.split("\n")).toHaveLength(1);
    expect(fitted.startsWith(" Thinking... · ")).toBe(true);
    expect(fitted.endsWith(" (Ctrl+T to expand)")).toBe(true);
    expect(fitted.length).toBeLessThan(row.length);
  });

  it("leaves a fitting row untouched", () => {
    const row = " Thinking... · short recap (Ctrl+T to expand)";
    expect(fitThinkingRowToWidth(row, 80)).toBe(row);
  });

  it("leaves expanded and non-row markdown untouched", () => {
    const expanded = "Thinking... (Ctrl+T to collapse)\n\nfull trace here";
    expect(fitThinkingRowToWidth(expanded, 40)).toBe(expanded);
    expect(fitThinkingRowToWidth("regular assistant text", 40)).toBe("regular assistant text");
  });

  it("passes through when no width is available", () => {
    const row = " Thinking... · " + "x".repeat(80) + " (Ctrl+T to expand)";
    expect(fitThinkingRowToWidth(row, undefined)).toBe(row);
  });
});

describe("xtrm-ui built-in tool rendering", () => {
  it("uses one consistent bash row across call phases", () => {
    const { tools } = loadExtension();
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

    expect(pending.render(200).join("\n")).toBe("● Ran \x1b[1mecho context-label\x1b[22m");
    expect(running.render(200).join("\n")).toBe("");
  });

  it("renders multiline bash commands and six collapsed output lines flat", () => {
    const { tools } = loadExtension();
    const output = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
    const component = tools.bash.renderResult(
      { content: [{ type: "text", text: output }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      context({ command: "echo one\necho two" }),
    );

    const lines = component.render(200);
    expect(lines.slice(0, 3)).toEqual([
      "● Ran \x1b[1mecho one\x1b[22m",
      "\x1b[1mecho two\x1b[22m",
      "└ line 3",
    ]);
    expect(lines.at(-1)).toContain("showing 6/8 lines (ctrl+o expand)");
  });

  it("colors only the Ran prefix with phase status and dims the command unless success", () => {
    const { tools } = loadExtension();
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
    expect(colors.slice(0, 3)).toEqual(["success", "success", "text"]); // ● , Ran, command

    colors.length = 0;
    tools.bash.renderResult(
      result,
      renderOptions,
      spyTheme,
      context({ command: "echo fail" }, { isError: true }),
    );
    expect(colors.slice(0, 3)).toEqual(["error", "error", "dim"]); // ● , Ran, command

    colors.length = 0;
    tools.bash.renderCall(
      { command: "echo pending" },
      spyTheme,
      context({ command: "echo pending" }, { executionStarted: false, isPartial: true }),
    );
    expect(colors).toEqual(["accent", "accent", "dim"]); // •, Ran, command
  });

  it.each([
    ["read", { path: "sample.txt" }, "sample.txt", "line"],
    ["find", { pattern: "*.ts" }, "*.ts", "match"],
    ["grep", { pattern: "needle" }, "needle", "match"],
    ["ls", { path: "." }, ".", "entry"],
  ])("shows six collapsed output lines for %s", (name, args, subject, noun) => {
    const { tools } = loadExtension();
    const output = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
    const component = tools[name].renderResult(
      { content: [{ type: "text", text: output }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      context(args),
    );

    const lines = component.render(200);
    expect(lines[0]).toBe(`● ${name} ${subject}`);
    expect(lines[1]).toBe("└ line 1");
    expect(lines[6]).toBe("  line 6");
    expect(lines.at(-1)).toContain(`showing 6/8 ${noun}s (ctrl+o expand)`);
  });

  it("shows small native results without an expansion hint", () => {
    const { tools } = loadExtension();
    const lines = tools.find.renderResult(
      { content: [{ type: "text", text: "only.ts" }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      context({ pattern: "*.ts" }),
    ).render(200);

    expect(lines).toEqual([
      "● find *.ts",
      "└ only.ts",
      "1 match · 7B",
    ]);
    expect(lines.join("\n")).not.toContain("ctrl+o expand");
  });

  it("renders edit diffs and new writes flat", () => {
    const { tools } = loadExtension();
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
    expect(write[1]).toBe("└ line 1");
    expect(write.at(-1)).toContain("showing 6/8 lines (ctrl+o expand)");
    expect(edit[0]).toBe(`● edit ${path}`);
    expect(edit[1]).toMatch(/│ /); // diff line-number gutter, not the tool tree
  });

  it("keeps pre-write diff data in renderer-local state", () => {
    const { tools } = loadExtension();
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

    expect(component.render(200).join("\n")).toContain("+1 · -1");
  });

  it("does not register built-in lifecycle tracking hooks", () => {
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
  it("renders one unindented Claude-style footer", () => {
    const rendered = renderExternalToolBackgroundLines(
      ["[GitNexus]", ...Array.from({ length: 94 }, (_, index) => `line ${index + 1}`)],
      200,
      "gitnexus",
      false,
      "gitnexus_query",
      1600,
    );
    const footer = rendered.at(-1)?.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

    expect(footer).toMatch(/^└─ showing 6\/94 lines \(ctrl\+o expand\) · 1\.6s · \d+B$/);
  });

  it("renders a Serena row in native style and pretty-prints single-line JSON", () => {
    const rendered = renderExternalToolBackgroundLines(
      ['[{"name_path":"highlightExternalToolBadge","kind":"Function"}]'],
      200,
      "serena",
      false,
      "find_symbol",
    );

    // ● used <Serena #9a8bff bold> <find_symbol bold dim>
    expect(rendered[0]).toBe("● \x1b[1mused\x1b[22m \x1b[38;2;154;139;255m\x1b[1mSerena\x1b[22m\x1b[39m \x1b[2m\x1b[1mfind_symbol\x1b[22m\x1b[22m");
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

    expect(rendered[0]).toBe("● \x1b[1mused\x1b[22m \x1b[38;2;154;139;255m\x1b[1mmcp\x1b[22m\x1b[39m \x1b[2m\x1b[1mcustom_tool\x1b[22m\x1b[22m");
  });

  it("keeps a colored provider label and tool for raw GitNexus output", () => {
    const rendered = renderExternalToolBackgroundLines(
      ["[GitNexus]", "{", '  "status": "found"', "}"],
      200,
      "gitnexus",
      false,
      "gitnexus_query",
    );

    expect(rendered[0]).toBe("● \x1b[1mused\x1b[22m \x1b[38;2;154;139;255m\x1b[1mGitNexus\x1b[22m\x1b[39m \x1b[2m\x1b[1mquery\x1b[22m\x1b[22m");
  });

  it("dims the dot and brightens the tool on success, keeps them muted while pending", () => {
    const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
    const statuses = ["pending", "success", "error"] as const;
    const expected = [
      "● used Serena execute_shell_command",
      "● used Serena execute_shell_command",
      "● used Serena execute_shell_command",
    ];

    for (let index = 0; index < statuses.length; index++) {
      const status = statuses[index];
      const rendered = renderExternalToolBackgroundLines(
        ["[Serena] execute_shell_command", "result"],
        200,
        "serena",
        false,
        "execute_shell_command",
        undefined,
        status,
      );
      // Plain text layout is identical across states (same stripped content).
      expect(stripAnsi(rendered[0] ?? "")).toBe(expected[index]);
      const line = rendered[0] ?? "";
      if (status === "success") {
        expect(line).toContain("\x1b[2m●\x1b[22m"); // dot dimmed on success
        expect(line).toContain("\x1b[1mexecute_shell_command\x1b[22m"); // tool bright (no dim)
      } else {
        expect(line).toContain("\x1b[2m\x1b[1mexecute_shell_command\x1b[22m\x1b[22m"); // tool dim while pending/error
      }
      // Extension is always #9a8bff bold.
      expect(line).toContain("\x1b[38;2;154;139;255m\x1b[1mSerena\x1b[22m\x1b[39m");
    }
  });

  it("keeps collapsed structured output multiline and bounded", () => {
    const lines = ["[GitNexus]", "{", "  summary: {", "    changed: 11", "  },", "  symbols: [", "    one", "  ]", "}"];

    expect(collapsedExternalToolLines(lines, false)).toEqual([
      "[GitNexus]",
      "{",
      "  summary: {",
      "    changed: 11",
      "  },",
      "  symbols: [",
      "... (3 more lines, ctrl+o to expand)",
    ]);
    expect(collapsedExternalToolLines(lines, true)).toEqual(lines);
  });
});
