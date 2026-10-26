import { describe, expect, mock, test } from "bun:test";
// Complete mock: spread the real pi-tui so neighbouring suites sharing the
// module registry under full-suite runs keep working exports (matchesKey).
import * as realPiTui from "../../../../node_modules/@earendil-works/pi-tui/dist/index.js";

mock.module("@earendil-works/pi-ai", () => ({ complete: async () => ({}) }));
mock.module("@earendil-works/pi-coding-agent", () => ({
  BorderedLoader: class {},
  CustomEditor: class {},
  VERSION: "test",
  createBashTool: () => ({}),
  createEditTool: () => ({}),
  createFindTool: () => ({}),
  createGrepTool: () => ({}),
  createLsTool: () => ({}),
  createReadTool: () => ({}),
  createWriteTool: () => ({}),
  isBashToolResult: () => false,
  isToolCallEventType: () => false,
}));
mock.module("@earendil-works/pi-tui", () => ({
  ...(realPiTui as object),
  Box: class {},
  Text: class {
    constructor(public text: string) {}
  },
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));
mock.module("@mariozechner/pi-coding-agent", () => ({}));

const xtrmUiExtension = (await import("./index.ts")).default;
const { createPatchedUpdateContent } = await import("./index.ts");
const { buildThinkingRecap } = await import("./index.ts");
const { createThinkingPreviewInstallState } = await import("./index.ts");

type RegisteredTool = {
  name: string;
  renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
};

type RegisteredCommand = { name: string; handler: (args: string, ctx: unknown) => Promise<void> };

function registerWithMock(): { tools: RegisteredTool[]; events: string[]; commands: RegisteredCommand[]; handlers: Record<string, (ev: unknown, ctx: any) => unknown>; entryRenderers: Record<string, (e: unknown, o: unknown, t: unknown) => unknown>; appended: Array<{ customType: string; data: unknown }>; transformers: Array<(m: string, c: unknown) => string> } {
  const tools: RegisteredTool[] = [];
  const events: string[] = [];
  const commands: RegisteredCommand[] = [];
  const handlers: Record<string, (ev: unknown, ctx: any) => unknown> = {};
  const entryRenderers: Record<string, (e: unknown, o: unknown, t: unknown) => unknown> = {};
  const transformers: Array<(m: string, c: unknown) => string> = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    on: (event: string, handler: (ev: unknown, ctx: any) => unknown) => {
      events.push(event);
      handlers[event] = handler;
    },
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool);
    },
    registerCommand: (name: string, def: Omit<RegisteredCommand, "name">) => {
      commands.push({ name, ...def });
    },
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: (fn: (m: string, c: unknown) => string) => {
      transformers.push(fn);
    },
    registerEntryRenderer: (customType: string, renderer: (e: unknown, o: unknown, t: unknown) => unknown) => {
      entryRenderers[customType] = renderer;
    },
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
    },
    getThinkingLevel: () => "medium",
  };
  xtrmUiExtension(pi as never);
  return { tools, events, commands, handlers, entryRenderers, appended, transformers };
}

function fakeCommandCtx() {
  const notified: string[] = [];
  return {
    ctx: {
      ui: {
        notify: (msg: string) => { notified.push(msg); },
        setTheme: () => {},
        setToolsExpanded: () => {},
        setEditorComponent: () => {},
        setHeader: () => {},
      },
      getContextUsage: () => ({ tokens: 0, contextWindow: 0 }),
      model: { id: "test" },
    },
    notified,
  };
}

describe("xtrm-ui presentation-only boundary", () => {
  test("xtrm-ui installs no tool_result handler", () => {
    const { events } = registerWithMock();
    expect(events).not.toContain("tool_result");
  });

  test("read.renderResult displays already-numbered content without re-prefixing", () => {
    const { tools } = registerWithMock();
    const readTool = tools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      bg: (_color: string) => (text: string) => text,
    };
    const rendered = readTool!.renderResult(
      {
        content: [{ type: "text", text: "137 | foo\n138 | bar\n139 | baz" }],
        details: {},
        isError: false,
      },
      { expanded: true, isPartial: false },
      theme,
      { args: { path: "/a/b.txt" }, executionStarted: true, isPartial: false, state: {} },
    ) as { text: string };

    const output = rendered.text;
    expect(output).toContain("137 | foo");
    expect(output).toContain("138 | bar");
    expect(output).toContain("139 | baz");
    expect(output).not.toContain("137 | 137 |");
    expect(output).not.toContain("1 | foo");
  });

  test("read.renderResult preserves numbered blank lines (collapsed + expanded)", () => {
    // A numbered blank line ("138 | ") is exactly the artifact the previous
    // over-strip fix removed. Guard both view modes so a regression is caught
    // at the presentation layer as well as the transform layer.
    const { tools } = registerWithMock();
    const readTool = tools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      bg: (_color: string) => (text: string) => text,
    };
    const numbered = "137 | foo\n138 | \n139 | bar";
    const call = (expanded: boolean) =>
      (readTool!.renderResult(
        {
          content: [{ type: "text", text: numbered }],
          details: {},
          isError: false,
        },
        { expanded, isPartial: false },
        theme,
        { args: { path: "/a/b.txt", offset: 137 }, executionStarted: true, isPartial: false, state: {} },
      ) as { text: string }).text;

    // Default presentation is one line; the number-preserving body is the
    // expanded row (section 4: full output stays reachable through expansion).
    const collapsed = call(false);
    expect(collapsed.split("\n")).toHaveLength(1);
    expect(collapsed).toContain("read");

    const rendered = call(true);
    expect(rendered).toContain("137 | foo");
    expect(rendered).toContain("138 | ");
    expect(rendered).toContain("139 | bar");
    // No double-prefix drift.
    expect(rendered).not.toContain("137 | 137 |");
    expect(rendered).not.toContain("138 | 138 |");
  });

  test("thinking toggle re-renders existing thinking rows (xtrm-5vi8u)", () => {
    // Simulates pi's AssistantMessageComponent: updateContent stores the
    // message as lastMessage, and setHideThinkingBlock re-renders from it.
    type ContentBlock = { type: string; text?: string; thinking?: string };
    const latch = { followsToggle: false };
    const rendered: Array<{ hide: boolean; content: ContentBlock[] }> = [];
    const component = {
      hideThinkingBlock: false,
      lastMessage: undefined as { content: ContentBlock[] } | undefined,
      updateContent(message: { content: ContentBlock[] }) {
        this.lastMessage = message;
        rendered.push({ hide: this.hideThinkingBlock, content: message.content });
      },
    };
    component.updateContent = createPatchedUpdateContent(
      component.updateContent as never,
      {
        label: (text: string) => text,
        recap: (text: string) => text,
        sep: " · ",
      },
      latch,
    );
    const setHideThinkingBlock = (hide: boolean) => {
      component.hideThinkingBlock = hide;
      if (component.lastMessage) component.updateContent(component.lastMessage as never);
    };
    const trace = "First line of the thinking trace\nDEEP_SECRET_DETAIL_XYZ not in recap";
    const message = { content: [{ type: "thinking", thinking: trace }] };

    // First render with pi's initial hideThinkingBlock=false: compact preview
    // until the user toggles (xtrm-6ggil latch behavior). The recap shows the
    // first substantive line only; the deep detail must stay hidden.
    component.updateContent(message as never);
    expect(rendered.at(-1)!.content[0]).toMatchObject({ type: "text" });
    const first = rendered.at(-1)!.content[0].text!;
    expect(first).toContain("Thinking");
    expect(first).toContain("First line of the thinking trace");
    expect(first).not.toContain("(Ctrl+T");
    expect(first).not.toContain("DEEP_SECRET_DETAIL_XYZ");

    // Toggle ON: rows stay collapsed (still following pi's hide state).
    setHideThinkingBlock(true);
    expect(rendered.at(-1)!.content[0].text!).not.toContain("(Ctrl+T to expand)");

    // Toggle OFF: the EXISTING thinking row must flip to the expanded trace.
    setHideThinkingBlock(false);
    const expanded = rendered.at(-1)!.content[0].text!;
    // No repeated inline shortcut: Ctrl+T stays pi's toggle and is documented
    // once in /xtrm-ui.
    expect(expanded).not.toContain("Ctrl+T");
    expect(expanded).toContain("DEEP_SECRET_DETAIL_XYZ");

    // Toggle ON again: collapses back.
    setHideThinkingBlock(true);
    expect(rendered.at(-1)!.content[0].text!).not.toContain("(Ctrl+T to expand)");

    // lastMessage must keep the RAW thinking block so every toggle re-enters
    // the patch with original content (the bug: it held the converted rows).
    expect(component.lastMessage!.content[0]).toMatchObject({ type: "thinking", thinking: trace });
  });

  test("thinking first-render latch: fresh session stays compact until a real toggle (xtrm-6ggil)", () => {
    type ContentBlock = { type: string; text?: string; thinking?: string };
    const trace = "A long trace line that must not leak on the first render";
    const plainStyle = {
      label: (text: string) => text,
      recap: (text: string) => text,
      sep: " · ",
    };
    const run = (hideThinkingBlock: boolean, latch: { followsToggle: boolean }) => {
      const rendered: ContentBlock[][] = [];
      const component = {
        hideThinkingBlock,
        lastMessage: undefined as { content: ContentBlock[] } | undefined,
        updateContent(message: { content: ContentBlock[] }) {
          this.lastMessage = message;
          rendered.push(message.content);
        },
      };
      component.updateContent = createPatchedUpdateContent(component.updateContent as never, plainStyle, latch);
      component.updateContent({ content: [{ type: "thinking", thinking: trace }] } as never);
      return rendered[0]![0].text ?? "";
    };

    // Fresh session latch (followsToggle=false): first thinking block renders
    // compact even when pi's hide state is false.
    expect(run(false, { followsToggle: false })).toBe("\u200b Thinking... · A long trace line that must not leak on the first render");
    // ...and stays compact when pi's hide state is true.
    expect(run(true, { followsToggle: false })).toBe("\u200b Thinking... · A long trace line that must not leak on the first render");
  });

  test("thinking patch passes non-thinking messages through untouched", () => {
    type ContentBlock = { type: string; text?: string };
    const plainStyle = {
      label: (text: string) => text,
      recap: (text: string) => text,
      sep: " · ",
    };
    const seen: Array<{ content: ContentBlock[] }> = [];
    const component = {
      hideThinkingBlock: false,
      lastMessage: undefined as { content: ContentBlock[] } | undefined,
      updateContent(message: { content: ContentBlock[] }) {
        this.lastMessage = message;
        seen.push(message);
      },
    };
    component.updateContent = createPatchedUpdateContent(component.updateContent as never, plainStyle, {
      followsToggle: false,
    });
    const message = { content: [{ type: "text", text: "plain reply" }] };
    component.updateContent(message as never);
    expect(seen).toEqual([message]);
  });

  test("thinking preview install retries on session start after factory-time failure (xtrm-3tus9)", async () => {
    // The extension factory runs during Pi resource loading, before the TUI
    // controller constructor calls initTheme(); reading theme.js's theme proxy
    // then throws "Theme not initialized". The install must be retried from
    // session_start (which fires after initTheme) before the first message.
    let attempts = 0;
    const state = createThinkingPreviewInstallState(async () => {
      attempts++;
      if (attempts === 1) throw new Error("Theme not initialized. Call initTheme() first.");
    });

    // Factory-time warm-up fails: patch is NOT installed.
    await state.ensureInstalled().catch(() => undefined);
    expect(state.isInstalled()).toBe(false);
    expect(attempts).toBe(1);

    // session_start retry (post-initTheme) succeeds.
    await state.ensureInstalled();
    expect(state.isInstalled()).toBe(true);
    expect(attempts).toBe(2);

    // Subsequent session starts no-op; no double patch install.
    await state.ensureInstalled();
    expect(attempts).toBe(2);
  });

  test("first message with thinking renders collapsed row once install completes (xtrm-3tus9)", async () => {
    // Covers the reported state: patch not yet installed when the session
    // starts (factory-time attempt failed), then session_start ensures the
    // install; the FIRST thinking-emitting message must render the collapsed
    // row instead of Pi's unpatched empty hidden label.
    type ContentBlock = { type: string; text?: string; thinking?: string };
    const plainStyle = {
      label: (text: string) => text,
      recap: (text: string) => text,
      sep: " · ",
    };
    let installs = 0;
    const state = createThinkingPreviewInstallState(async () => {
      installs++;
      if (installs === 1) throw new Error("Theme not initialized. Call initTheme() first.");
    });

    // Factory-time warm-up fails (theme not initialized yet).
    await state.ensureInstalled().catch(() => undefined);
    expect(state.isInstalled()).toBe(false);

    // session_start: ensure the patch before the first message renders.
    await state.ensureInstalled();
    expect(state.isInstalled()).toBe(true);

    // First assistant message carries a thinking block: hideThinkingBlock is
    // true (settings), latch follows pi's hide state only after a real toggle,
    // so the message must render the compact collapsed row.
    const rendered: ContentBlock[][] = [];
    const latch = { followsToggle: false };
    const component = {
      hideThinkingBlock: true,
      lastMessage: undefined as { content: ContentBlock[] } | undefined,
      updateContent(message: { content: ContentBlock[] }) {
        this.lastMessage = message;
        rendered.push(message.content);
      },
    };
    component.updateContent = createPatchedUpdateContent(component.updateContent as never, plainStyle, latch);
    component.updateContent({
      content: [{ type: "thinking", thinking: "First line of the thinking trace\nDEEP_SECRET_DETAIL_XYZ not in recap" }],
    } as never);

    const row = rendered[0]![0].text ?? "";
    expect(row).toContain("Thinking");
    expect(row).not.toContain("(Ctrl+T");
    expect(row).not.toContain("DEEP_SECRET_DETAIL_XYZ");
    // lastMessage keeps the RAW thinking block so toggle re-renders re-enter
    // the patch with original content (xtrm-5vi8u).
    expect(component.lastMessage!.content[0]).toMatchObject({
      type: "thinking",
      thinking: "First line of the thinking trace\nDEEP_SECRET_DETAIL_XYZ not in recap",
    });
  });
});

describe("CORE-2358 external frame shows executed code", async () => {
  const { externalToolCodePreview, externalToolContentLines } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  test("python code is previewed line by line", () => {
    expect(externalToolCodePreview("python", { code: "a = 1\nprint(a)" })).toEqual(["a = 1", "print(a)"]);
  });
  test("any tool with a code string gets the preview, no per-tool list", () => {
    expect(externalToolCodePreview("bash", { command: "ls" })).toBeUndefined();
    expect(externalToolCodePreview("somecode_tool", { code: "x = 1" })).toEqual(["x = 1"]);
    expect(externalToolCodePreview("python", { code: "  " })).toBeUndefined();
    expect(externalToolCodePreview("python", {})).toBeUndefined();
  });
  test("content is program above output once resolved", () => {
    const component = {
      toolName: "python",
      args: { code: "print(1)" },
      result: { content: [{ type: "text", text: "1" }] },
    };
    // Single-line program: the header carries it, the body holds output only.
    expect(externalToolContentLines(component as never, [])).toEqual(["1"]);
  });
  test("pending content is the program alone", () => {
    const component = { toolName: "python", args: { code: "print(1)" }, result: null };
    // Single-line program: the header carries it, so the body is empty.
    expect(externalToolContentLines(component as never, ["fallback"])).toEqual([]);
  });
});

describe("CORE-2358 collapsed code cap and dimmed output", async () => {
  const { externalToolContentLines } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  test("collapsed shows lines 2..cap plus a native-style hidden count, expanded shows all", () => {
    const code = "l1\nl2\nl3\nl4\nl5";
    const component = { toolName: "python", args: { code }, result: { content: [{ type: "text", text: "out" }] } };
    // Line 1 lives in the header; hidden counts it as shown (5-4=1).
    expect(externalToolContentLines(component as never, [], false)).toEqual(["  l2", "  l3", "  l4", "  +1 line", "out"]);
    expect(externalToolContentLines(component as never, [], true)).toEqual(["  l2", "  l3", "  l4", "  l5", "out"]);
  });

});

describe("xtrm-ui code tools cap execution and result independently", async () => {
  const { externalToolContentLines, renderExternalToolLines, activeCommandPreviewLines, DEFAULT_PREFS } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  const code = Array.from({ length: 10 }, (_, i) => `line${i + 1} = ${i + 1}`).join("\n");
  const output = Array.from({ length: 20 }, (_, i) => `result${i + 1}`).join("\n");
  const component = {
    toolName: "codemode",
    args: { code },
    result: { content: [{ type: "text", text: output }] },
  };
  // Same codeCount derivation as the frame patch: pre-filter code-section length.
  const codeCountOf = (content: string[]) => content.length - output.split("\n").length;
  const render = (expanded: boolean) => {
    const content = externalToolContentLines(component as never, [], expanded);
    return renderExternalToolLines(content, 200, "external", expanded, "codemode", 10, "success", true, 6, "line1 = 1", codeCountOf(content));
  };

  test("collapsed shows the code budget plus a full result budget", () => {
    const plain = render(false).map(strip);
    expect(plain[0]).toContain("codemode");
    expect(plain[0]).toContain("line1 = 1");
    // Line 1 renders once, in the header — never again in the body.
    expect(plain.slice(1).some((l) => l.includes("line1 = 1"))).toBe(false);
    expect(plain).toContain("  line2 = 2");
    expect(plain).toContain("  line4 = 4");
    expect(plain.some((l) => l.includes("+6 lines"))).toBe(true);
    expect(plain).toContain("  └ result1");
    for (let i = 2; i <= 6; i++) expect(plain).toContain(`    result${i}`);
    expect(plain.some((l) => l.includes("result7"))).toBe(false);
    // Compact meta: hidden-content indicator and duration, never the old
    // `showing x/y lines (ctrl+o expand)` bookkeeping.
    expect(plain.at(-1)).toContain("+14 lines");
    expect(plain.at(-1)).not.toContain("ctrl+o");
    expect(plain.join("\n")).not.toContain("showing");
    expect(plain.join("\n")).not.toContain("ctrl+o");
  });

  test("code body mirrors the bash tree: bold execution, └ output, bare meta", async () => {
    const { setActiveThemeProvider } = await import("./index.ts");
    const mark = { fg: (c: string, t: string) => `[${c}]${t}`, bold: (t: string) => `*${t}*`, italic: (t: string) => `_${t}_` };
    setActiveThemeProvider(() => mark);
    try {
      const raw = render(false);
      const plain = raw.map(strip);
      // Execution lines carry weight from the theme (no raw SGR).
      expect(raw[1]).toContain("*");
      expect(raw[1]).not.toContain("\x1b[");
      expect(raw.some((l) => l.includes("└") && l.includes("result1"))).toBe(true);
      expect(raw.some((l) => l.includes("└─"))).toBe(false);
      expect(plain[0]).toContain("codemode");
    } finally {
      setActiveThemeProvider(null);
    }
  });

  test("multi-block results join: codemode wrapper plus script output", () => {
    const component = {
      toolName: "codemode",
      args: { code: "return 1" },
      result: {
        content: [
          { type: "text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
          { type: "text", text: "probe-result-1\nprobe-result-2" },
        ],
      },
    };
    const content = externalToolContentLines(component as never, [], false);
    expect(content).toContain("probe-result-1");
    expect(content).toContain("probe-result-2");
  });

  test("empty partial code result renders program only, no placeholder swap", () => {
    // Slow code tools paint once with an empty partial result before the
    // real output lands; that must not render a `› tool` line the output
    // then visibly replaces (the native-looking flash).
    const partial = { toolName: "codemode", args: { code: "x = 1\ny = 2" }, result: { content: [] } };
    const content = externalToolContentLines(partial as never, [], false);
    expect(content).toEqual(["  y = 2"]);
    expect(content.some((l) => l.includes("› codemode"))).toBe(false);
  });

  test("pending code renders dim-bold execution with the header untouched", () => {
    const pending = { toolName: "python", args: { code: "x = 1\ny = 2" }, result: null };
    const content = externalToolContentLines(pending as never, [], false);
    expect(content).toEqual(["  y = 2"]);
    const codeCount = content.length;
    const raw = renderExternalToolLines(content, 200, "external", false, "python", undefined, "pending", true, 6, "x = 1", codeCount);
    expect(raw[0]).toContain("python");
    // No theme is bound in this suite, so the frame renders plain: no raw
    // escapes survive a theme-less runtime.
    expect(raw[1]).not.toContain("\x1b[");
    expect(raw[1]).toContain("y = 2");
  });

  test("expanded shows the whole program and the whole output", () => {
    const plain = render(true).map(strip);
    expect(plain).toContain("  line2 = 2");
    expect(plain).toContain("  line10 = 10");
    expect(plain).toContain("    result20");
    expect(plain.some((l) => l.includes("+"))).toBe(false);
    // Expanded means nothing is hidden: no line-count tail at all.
    expect(plain.join("\n")).not.toContain("lines");
  });

  test("code cap follows the command-lines pref", () => {
    expect(activeCommandPreviewLines()).toBe(DEFAULT_PREFS.commandPreviewLines);
    const content = externalToolContentLines(component as never, [], false, 2);
    expect(content.slice(0, 1)).toEqual(["  line2 = 2"]);
    expect(content[1]).toContain("+8 lines");
  });

  test("code shaped like a header never hijacks the frame", () => {
    const tricky = { toolName: "codemode", args: { code: "[note] hello\nsecond" }, result: { content: [{ type: "text", text: "ok" }] } };
    const content = externalToolContentLines(tricky as never, [], false);
    const rows = renderExternalToolLines(content, 200, "external", false, "codemode", 10, "success", true, 6, "[note] hello", content.length - 1).map(strip);
    expect(rows[0]).toContain("codemode");
    expect(rows[0]).not.toMatch(/used note\b/);
    expect(rows).toContain("  second");
    expect(rows.slice(1).some((l) => l.includes("[note] hello"))).toBe(false);
  });
});

describe("CORE-2358 bare headers for non-code tools", async () => {
  const { bareExternalToolHeader, renderExternalToolBackgroundLines } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  test("gitnexus header is provider plus tool, nothing sniffed", () => {
    expect(bareExternalToolHeader("gitnexus", "gitnexus_query")).toEqual({ provider: "GitNexus", action: "query" });
    expect(bareExternalToolHeader("external", "python")).toEqual({ provider: "python", action: undefined });
  });
  test("bare frame keeps output-shaped first lines in the body", () => {
    const rows = renderExternalToolBackgroundLines(["[Serena] done", "ok"], 80, "serena", false, "read_file", 5, "success", true);
    const plain = rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain.split("\n")[0]).toContain("read_file");
    expect(plain).toContain("[Serena] done");
  });
});

describe("CORE-2358 bash command cap and pref", async () => {
  const { renderBashTree, normalizePrefs, DEFAULT_PREFS } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;
  const theme = { fg: (_n: string, t: string) => t, bold: (t: string) => t };

  test("long commands cap at 4 with a hidden-count line", () => {
    const out = renderBashTree(theme, "success", "l1\nl2\nl3\nl4\nl5\nl6", [], undefined, 4);
    expect(out).toContain("l4");
    expect(out).not.toContain("l5");
    expect(out).toContain("+2 lines");
  });
  test("short commands render whole, no count", () => {
    const out = renderBashTree(theme, "success", "a\nb", [], undefined, 4);
    expect(out).toContain("b");
    expect(out).not.toContain("+");
  });
  test("pref defaults to 4 and clamps 1-20", () => {
    expect(DEFAULT_PREFS.commandPreviewLines).toBe(4);
    expect(normalizePrefs({}).commandPreviewLines).toBe(4);
    expect(normalizePrefs({ commandPreviewLines: 99 }).commandPreviewLines).toBe(20);
    expect(normalizePrefs({ commandPreviewLines: 0 }).commandPreviewLines).toBe(1);
  });
});

describe("CORE-2358 result-lines pref and payload indent", async () => {
  const { renderExternalToolBackgroundLines, renderBashTree, normalizePrefs, DEFAULT_PREFS } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;
  const theme = { fg: (_n: string, t: string) => t, bold: (t: string) => t };
  const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

  test("frame output indents under the call, code keeps its indent", () => {
    const rows = renderExternalToolBackgroundLines(["out1", "out2"], 80, "external", false, "some_tool", 5, "success", true, 6);
    expect(strip(rows[0]).startsWith("●")).toBe(true);
    expect(strip(rows[1])).toBe("  out1");
  });
  test("header carries the first code line as summary", () => {
    const rows = renderExternalToolBackgroundLines(["  import json", "\x1b[2m2\x1b[22m"], 80, "external", false, "python", 903, "success", false, 6, "import json");
    expect(strip(rows[0])).toContain("import json");
  });
  test("bash continued lines indent, header stays flush", () => {
    const out = renderBashTree(theme, "success", "c1\nc2", ["o1"], undefined, 4);
    const lines = out.split("\n").map(strip);
    expect(lines[0].startsWith("●")).toBe(true);
    expect(lines[1]).toBe("  c2");
    expect(lines[2]).toBe("  └ o1");
  });
  test("extension frame prefs default, clamp, and fail open", () => {
    expect(DEFAULT_PREFS.extPreviewLines).toBe(6);
    expect(DEFAULT_PREFS.extNoCompact).toBe(false);
    expect(normalizePrefs({}).extPreviewLines).toBe(6);
    expect(normalizePrefs({ extPreviewLines: 99 }).extPreviewLines).toBe(50);
    expect(normalizePrefs({ extPreviewLines: 0 }).extPreviewLines).toBe(1);
    expect(normalizePrefs({}).extNoCompact).toBe(false);
    expect(normalizePrefs({ extNoCompact: true }).extNoCompact).toBe(true);
  });
  test("result pref defaults 6, clamps 1-50", () => {
    expect(DEFAULT_PREFS.resultPreviewLines).toBe(6);
    expect(normalizePrefs({}).resultPreviewLines).toBe(6);
    expect(normalizePrefs({ resultPreviewLines: 99 }).resultPreviewLines).toBe(50);
    expect(normalizePrefs({}).diffPreviewLines).toBe(18);
    expect(normalizePrefs({ diffPreviewLines: 99 }).diffPreviewLines).toBe(50);
  });
});

describe("CORE-2358 chained commands segment before capping", async () => {
  const { renderBashTree, splitCommandSegments } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;
  const theme = { fg: (_n: string, t: string) => t, bold: (t: string) => t };
  const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

  test("&& chains split keeping the operator", () => {
    expect(splitCommandSegments('echo a && echo b || echo c')).toEqual(['echo a &&', 'echo b ||', 'echo c']);
  });
  test("six chained segments cap at 4 with hidden count", () => {
    const cmd = 'echo 1 && echo 2 && echo 3 && echo 4 && echo 5 && echo 6';
    const lines = renderBashTree(theme, "success", cmd, [], undefined, 4).split("\n").map(strip);
    expect(lines.length).toBe(5);
    expect(lines[4]).toContain("+2 lines");
  });
});

describe("CORE-2358 expanded bash shows the whole command", async () => {
  const { renderBashTree } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;
  const theme = { fg: (_n: string, t: string) => t, bold: (t: string) => t };
  const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

  test("expanded ignores the cap, collapsed keeps it", () => {
    const cmd = "a && b && c && d && e && f";
    const collapsed = renderBashTree(theme, "success", cmd, [], undefined, 2, false).split("\n").map(strip);
    expect(collapsed.some((l) => l.includes("+"))).toBe(true);
    const expanded = renderBashTree(theme, "success", cmd, [], undefined, 2, true).split("\n").map(strip);
    expect(expanded.some((l) => l.includes("+"))).toBe(false);
    expect(expanded.join("\n")).toContain("e &&");
  });
});

describe("CORE-2358 global defaults", async () => {
  const { normalizePrefs, readGlobalXtrmUi, DEFAULT_PREFS } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  test("explicit base beats built-ins, session beats base", () => {
    const base = { ...DEFAULT_PREFS, commandPreviewLines: 7 };
    expect(normalizePrefs({}, base).commandPreviewLines).toBe(7);
    expect(normalizePrefs({ commandPreviewLines: 2 }, base).commandPreviewLines).toBe(2);
  });
  test("global reader is fail-open and scoped to xtrmUi", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xtrm-ui-test-"));
    try {
      const good = path.join(dir, "good.json");
      fs.writeFileSync(good, JSON.stringify({ xtrmUi: { resultPreviewLines: 9 }, other: 1 }));
      expect(readGlobalXtrmUi(good)).toEqual({ resultPreviewLines: 9 });
      const broken = path.join(dir, "broken.json");
      fs.writeFileSync(broken, "{nope");
      expect(readGlobalXtrmUi(broken)).toEqual({});
      expect(readGlobalXtrmUi(path.join(dir, "missing.json"))).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("one-line rows keep their line", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    bg: (_color: string) => (text: string) => text,
  };
  const bash = () => registerWithMock().tools.find((tool) => tool.name === "bash")!;
  const render = (command: string, width: number) =>
    bash()
      .renderResult(
        { content: [{ type: "text", text: "ok" }], details: {} },
        { expanded: false, isPartial: false },
        theme,
        { args: { command }, isError: false, state: {} },
      )
      .render(width);

  test("a fitting row carries no ellipsis", () => {
    const lines = render("echo ok", 120);
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain("…");
  });

  test("the reported line count follows the shown command", () => {
    const row = bash().renderResult(
      { content: [{ type: "text", text: "ok" }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      { args: { command: `cd ${process.cwd()} && python3 - <<'PY'\nprint(1)\nPY` }, isError: false, state: {} },
    ) as { text: string };
    expect(row.text).toContain("Ran shell command python3 - <<'PY'");
    expect(row.text).toContain("+2 lines");
  });

  test("a single-line chain shows the whole command and reports nothing", () => {
    const row = bash().renderResult(
      { content: [{ type: "text", text: "ok" }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      { args: { command: "a && b && c" }, isError: false, state: {} },
    ) as { text: string };
    expect(row.text).toContain("Ran shell command a && b && c");
    expect(row.text).not.toContain("lines");
  });
});

describe("ultracompact rows", async () => {
  const { renderUltraRow, buildUltraExternalLine, ultraExternalSubject, ultraExternalPrimary, ultraBashSubject, stripCwdCd, ULTRA_BASH_VERB, normalizePrefs, DEFAULT_PREFS } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;
  const theme = { fg: (_n: string, t: string) => t, bold: (t: string) => t };
  const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

  test("Class A: indent instead of dot, no separators", () => {
    const row = strip(renderUltraRow(theme, { statusColor: "success", verb: "Ran", subject: "npm test", primary: "3 lines" }));
    expect(row.startsWith("  ")).toBe(true);
    expect(row).not.toContain("●");
    expect(row).not.toContain("·");
    expect(row).toContain("Ran");
    expect(row).toContain("npm test");
  });

  test("no dots on any tool row: operational tools take the indent too", () => {
    const row = strip(renderUltraRow(theme, { statusColor: "success", verb: "SendMessage", subject: "to bob", primary: "delivered" }));
    expect(row.startsWith("  ")).toBe(true);
    expect(row).not.toContain("●");
    expect(row).not.toContain("·");
  });

  test("prefs default to one-line rows; explicit off survives", () => {
    expect(DEFAULT_PREFS.ultracompact).toBe(true);
    expect(normalizePrefs({}).ultracompact).toBe(true);
    expect(normalizePrefs({ ultracompact: false }).ultracompact).toBe(false);
  });

  test("external Class A: bare header plus first code line", () => {
    const row = strip(buildUltraExternalLine("codemode", { code: "x = 1\ny = 2" }, ["ok"], "success"));
    expect(row.startsWith("  ")).toBe(true);
    expect(row).toContain("codemode");
    expect(row).toContain("x = 1");
    expect(row).not.toContain("●");
    expect(row).not.toContain("·");
  });

  test("ultra frame carries no provider accent", () => {
    for (const raw of [
      buildUltraExternalLine("codemode", { code: "x = 1" }, ["ok"], "success"),
      buildUltraExternalLine("SendMessage", { to: "bob" }, ["held"], "pending"),
      buildUltraExternalLine("gitnexus_query", { query: "q" }, ["out"], "success"),
    ]) {
      expect(raw).not.toContain("154;139;255");
    }
  });

  test("external spans match native spans through the active theme", async () => {
    const { setActiveThemeProvider } = await import("./index.ts");
    // Same tokens by construction: both rows read the live theme.
    const tokened = {
      fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
      bold: (t: string) => `*${t}*`,
      italic: (t: string) => `_${t}_`,
    };
    setActiveThemeProvider(() => tokened);
    try {
      for (const status of ["pending", "success", "error"] as const) {
        const native = renderUltraRow(tokened, { statusColor: status, verb: "used codemode", subject: "x = 1", primary: "ok" });
        const framed = buildUltraExternalLine("codemode", { code: "x = 1" }, ["ok"], status);
        expect(framed).toBe(native);
      }
    } finally {
      setActiveThemeProvider(null);
    }
  });

  test("external operational tools: indent plus outcome, no dot", () => {
    const row = strip(buildUltraExternalLine("SendMessage", { to: "bob" }, ["delivered to bob"], "success"));
    expect(row.startsWith("  ")).toBe(true);
    expect(row).not.toContain("●");
    expect(row).toContain("to bob");
    expect(row).toContain("delivered to bob");
    expect(row).not.toContain("·");
  });

  test("subjects: background command, stop id, monitor ws url", () => {
    expect(ultraExternalSubject("BashBackground", { command: "npm test" })).toContain("npm test");
    expect(ultraExternalSubject("BackgroundStop", { task_id: "t1" })).toBe("t1");
    expect(ultraExternalSubject("Monitor", { ws: { url: "wss://x" } })).toContain("wss://x");
    expect(ultraExternalSubject("SendMessage", { reply_to: "m1" })).toBe("reply m1");
  });

  test("bash ultra verb is the full phrase", () => {
    expect(ULTRA_BASH_VERB).toBe("Ran shell command");
  });

  test("bash subject strips a dangling && or || tail", () => {
    expect(ultraBashSubject("rm -f /tmp/x && echo done")).toBe("rm -f /tmp/x && echo done");
    expect(ultraBashSubject("a || b")).toBe("a || b");
    expect(ultraBashSubject("python3 - <<'PY'\nprint(1)\nPY")).toBe("python3 - <<'PY'");
    expect(ultraBashSubject("npm test")).toBe("npm test");
  });

  test("a cd into the current directory is dropped from the subject", () => {
    const cwd = "/tmp/wt";
    expect(stripCwdCd("cd /tmp/wt && sed -n '1,2p' x", cwd)).toBe("sed -n '1,2p' x");
    expect(stripCwdCd("cd /tmp/wt && cd /tmp/wt && npm test", cwd)).toBe("npm test");
    expect(stripCwdCd('cd "/tmp/wt" && make', cwd)).toBe("make");
    // A cd somewhere else stays: it changes what the command means.
    expect(stripCwdCd("cd /tmp/other && make", cwd)).toBe("cd /tmp/other && make");
    expect(ultraBashSubject("cd /tmp/wt && npm test", cwd)).toBe("npm test");
    expect(ultraBashSubject("cd /tmp/other && make", cwd)).toBe("cd /tmp/other && make");
  });

  test("aligned ladder: tool name above subject, no faint dimming", () => {
    const mark = { fg: (c: string, t: string) => `[${c}]${t}`, bold: (t: string) => `*${t}*` };
    const raw = renderUltraRow(mark, { statusColor: "success", verb: "Ran", subject: "npm test", primary: "3 lines" });
    // Every tool row reads at the same tier: name (toolTitle, semibold),
    // subject (toolTitle, upright), metadata (muted/dim). No raw SGR, no hue.
    expect(raw).toContain("[toolTitle]*Ran*");
    expect(raw).toContain("[toolTitle]npm test");
    expect(raw).toContain("[muted]3 lines");
    expect(raw).not.toContain("\x1b[");
    expect(strip(raw).replace(/\[[a-zA-Z]+\]|\*/g, "")).toBe("  Ran npm test  3 lines");
  });

  test("errors take the brightest grayscale token plus the marker, never a hue", () => {
    const mark = { fg: (c: string, t: string) => `[${c}]${t}`, bold: (t: string) => `*${t}*` };
    const raw = renderUltraRow(mark, { statusColor: "error", verb: "read", subject: "/a", primary: "nope" });
    expect(raw).toContain("[error]!");
    expect(raw).toContain("[error]*read*");
    expect(raw).not.toContain("\x1b[");
    expect(raw).not.toContain("[success]");
  });

  test("failed rows say so, once", () => {
    const mark = { fg: (c: string, t: string) => `[${c}]${t}`, bold: (t: string) => `*${t}*` };
    expect(strip(renderUltraRow(mark, { statusColor: "error", verb: "bash", subject: "x" })).trimEnd().endsWith("failed")).toBe(true);
    expect(strip(renderUltraRow(mark, { statusColor: "error", verb: "bash", subject: "x", primary: "already failed" })).match(/failed/g)?.length).toBe(1);
    expect(strip(renderUltraRow(mark, { statusColor: "success", verb: "bash", subject: "x" }))).not.toContain("failed");
    expect(strip(buildUltraExternalLine("SendMessage", { to: "b" }, ["no wake"], "error")).trimEnd().endsWith("failed")).toBe(true);
    expect(strip(buildUltraExternalLine("x", {}, ["ok"], "success"))).not.toContain("failed");
  });

  test("bracket-only result lines never duplicate the header", () => {
    expect(ultraExternalPrimary("gitnexus_query", ["[GitNexus]", "real outcome"])).toBe("real outcome");
    expect(ultraExternalPrimary("gitnexus_query", ["[GitNexus]"])).toBeUndefined();
  });

  test("ListAgents primary is the peer count", () => {
    expect(ultraExternalPrimary("ListAgents", ["This session is a\nPeer sessions (3):\n  x"])).toBe("3 peers");
    expect(ultraExternalPrimary("BashBackground", ["Started task t1"])).toContain("t1");
    expect(ultraExternalPrimary("BashBackground", [])).toBeUndefined();
  });

  test("JSON results summarize shape, never a bare brace", () => {
    expect(ultraExternalPrimary("specialist_status", ['{\n  "activations": [],\n  "pending_asks": []\n}'])).toBe("{activations, pending_asks}");
    expect(ultraExternalPrimary("specialist_list", ['{"a":1,"b":2,"c":3,"d":4}'])).toBe("{a, b, c, +1}");
    expect(ultraExternalPrimary("x", ['[1,2,3]'])).toBe("[3 items]");
    expect(ultraExternalPrimary("x", ['{broken'])).toBe("{broken");
  });
});

describe("weight in a chalk-less runtime", async () => {
  const { renderUltraRow, renderExternalToolBackgroundLines, setActiveThemeProvider } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  test("bold goes through theme.style, never chalk-backed bold()", () => {
    const seen: Array<{ text: string; options: Record<string, unknown> }> = [];
    const theme = {
      fg: (_color: string, text: string) => text,
      // Simulates chalk with no colour level: bold()/italic() return plain text.
      bold: () => "CHALK-NOOP",
      italic: () => "CHALK-NOOP",
      style: (text: string, options: Record<string, unknown>) => {
        seen.push({ text, options });
        return `\u00ab${text}\u00bb`;
      },
    };

    const row = renderUltraRow(theme, { statusColor: "success", verb: "Ran", subject: "x" });
    expect(row).toContain("\u00abRan\u00bb");
    expect(row).not.toContain("CHALK-NOOP");
    expect(seen[0]?.options).toEqual({ bold: true, fg: "toolTitle" });

    setActiveThemeProvider(() => theme);
    try {
      const header = renderExternalToolBackgroundLines(["x"], 80, "external", false, "codemode")[0]!;
      expect(header).toContain("\u00abused\u00bb");
      expect(header).toContain("\u00abcodemode\u00bb");
      expect(header).not.toContain("CHALK-NOOP");
    } finally {
      setActiveThemeProvider(null);
    }
  });
});

describe("theme binding across reloads", async () => {
  const mod = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  test("a lost provider falls back to the last recorded theme", () => {
    const theme = {
      fg: (token: string, text: string) => `[${token}]${text}`,
      bold: (text: string) => `*${text}*`,
      italic: (text: string) => `_${text}_`,
    };
    try {
      mod.rememberTheme({ ui: { theme } });
      // A patch installed by an earlier module instance keeps its own closure;
      // after a reload that closure may only see a cleared provider.
      mod.setActiveThemeProvider(null);
      expect(mod.activeTheme()).toBe(theme);
      const style = mod.collapsedThinkingStyle(mod.activeTheme);
      expect(style.recap("trace")).toBe("[thinkingText]_trace_");
      expect(style.label("Thinking...")).toBe("[muted]Thinking...");
    } finally {
      mod.setActiveThemeProvider(null);
      mod.resetThemeBinding();
    }
  });
});

describe("thinking collapsed row shape", async () => {
  const { buildCollapsedThinkingRow } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  test("indent, Thinking... label, one clause; no count and no hint", () => {
    const style = {
      label: (t: string) => `L${t}`,
      recap: (t: string) => `R${t}`,
      sep: "|",
    };
    // The zero-width anchor survives pi's text.trim(); ONE space follows it so
    // the row lands on the tool-row column (markdown's outputPad adds the
    // second column). The character count and the inline shortcut are gone.
    expect(buildCollapsedThinkingRow("trace here", style)).toBe("\u200b LThinking...|Rtrace here");
    expect(buildCollapsedThinkingRow("trace here", style)).not.toContain("Ctrl+T");
    expect(buildCollapsedThinkingRow("trace here", style)).not.toContain("193");
  });
});

describe("grayscale row ladder (CORE-2502 follow-ups)", async () => {
  const mod = await import("./index.ts");
  const { buildCollapsedThinkingRow, collapsedThinkingStyle, expandedThinkingStyle, setActiveThemeProvider, setActivePrefsSnapshotForTests, DEFAULT_PREFS, renderExternalToolLines, buildUltraExternalLine } = mod;
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;
  const theme = { fg: (_n: string, t: string) => t, bold: (t: string) => t, italic: (t: string) => t };
  const tokened = () => ({
    fg: (c: string, t: string) => `[${c}]${t}`,
    bold: (t: string) => `*${t}*`,
    italic: (t: string) => `_${t}_`,
  });

  test("collapsed thinking style reads theme tokens, not baked hex", () => {
    const style = collapsedThinkingStyle(() => tokened());
    // Label: secondary level, upright. Recap: one step back, italic.
    expect(style.label("Thinking...")).toBe("[muted]Thinking...");
    expect(style.recap("trace")).toBe("[thinkingText]_trace_");
    expect(style.sep).toBe("  ");
    // No theme bound (factory boot): plain text, never a stale escape.
    const plain = collapsedThinkingStyle(() => undefined);
    expect(plain.label("Thinking...")).toBe("Thinking...");
    expect(plain.recap("trace")).toBe("trace");
  });

  test("expanded thinking style: bold label, trace at the thinking level", () => {
    const style = expandedThinkingStyle(() => tokened());
    expect(style.label("Thinking...")).toBe("[muted]*Thinking...*");
    expect(style.recap("trace")).toBe("[thinkingText]trace");
    expect(style.label("Thinking...")).not.toContain("\\x1b[");
  });

  test("the style rebinds the theme per call, so a theme switch reaches installed rows", () => {
    let theme: ReturnType<typeof tokened> = tokened();
    const style = collapsedThinkingStyle(() => theme);
    const first = style.recap("x");
    theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => `*${t}*`, italic: (t: string) => `<i>${t}</i>` };
    expect(style.recap("x")).not.toBe(first);
    expect(style.recap("x")).toBe("<thinkingText><i>x</i></thinkingText>");
  });

  test("the ultra frame follows the active theme and carries no baked hex", () => {
    setActiveThemeProvider(() => tokened());
    try {
      const line = buildUltraExternalLine("codemode", { code: "x = 1" }, ["ok"], "success");
      expect(line).toContain("[toolTitle]");
      expect(line).not.toMatch(/#[0-9a-fA-F]{3,6}/);
      expect(line).not.toMatch(/\x1b\[/);
      expect(line).toContain("used");
      // Thinking rows and tool rows share the ladder, not the same level.
      const row = buildCollapsedThinkingRow("recap", collapsedThinkingStyle(() => tokened()));
      expect(row).toContain("[muted]Thinking...");
      expect(row).toContain("[thinkingText]_recap_");
    } finally {
      setActiveThemeProvider(null);
    }
  });

  test("expanded native rows are byte-identical with ultra on and off", async () => {
    const { tools, commands } = registerWithMock();
    const ultra = commands.find((c) => c.name === "xtrm-ui-ultra");
    expect(ultra).toBeDefined();
    const { ctx } = fakeCommandCtx();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, RegisteredTool>;
    const cases: Array<[string, unknown, unknown]> = [
      ["bash", { command: "echo hi && ls" }, { content: [{ type: "text", text: "hi\nfile1" }], details: {} }],
      ["read", { path: "/tmp/x.md" }, { content: [{ type: "text", text: "l1\nl2\nl3" }], details: {} }],
      ["edit", { path: "/tmp/x.md" }, { content: [{ type: "text", text: "edited" }], details: {} }],
      ["write", { path: "/nonexistent-xtrm-test-file", content: "a\nb" }, { content: [{ type: "text", text: "wrote" }], details: {} }],
      ["find", { pattern: "*.md", path: "/tmp" }, { content: [{ type: "text", text: "a.md\nb.md" }], details: {} }],
      ["grep", { pattern: "ultra", path: "/tmp" }, { content: [{ type: "text", text: "a:1\nb:2" }], details: {} }],
      ["ls", { path: "/tmp" }, { content: [{ type: "text", text: "a\nb" }], details: {} }],
    ];
    const renderAll = () => cases.map(([name, args, result]) => {
      const out = byName[name].renderResult(result, { expanded: true, isPartial: false }, theme, { args, isError: false, state: {} }) as { text: string };
      return out.text;
    });
    await ultra!.handler("off", ctx);
    const withoutUltra = renderAll();
    for (const text of withoutUltra) expect(text).toContain("●");
    await ultra!.handler("on", ctx);
    // Prove the flip took effect: a collapsed render must now be an ultra row.
    const collapsed = byName["bash"].renderResult(
      { content: [{ type: "text", text: "hi" }], details: {} },
      { expanded: false, isPartial: false }, theme, { args: { command: "echo hi" }, isError: false, state: {} },
    ) as { text: string };
    expect(collapsed.text).not.toContain("●");
    const withUltra = renderAll();
    expect(withUltra).toEqual(withoutUltra);
    await ultra!.handler("off", ctx);
  });

  test("expanded frame output ignores the ultra pref (fall-through target is pref-free)", () => {
    const render = () => renderExternalToolLines(["line one", "line two"], 100, "external", true, "codemode", 5, "success", true, 6, "x = 1", 1).join("\n");
    setActivePrefsSnapshotForTests({ ...DEFAULT_PREFS, ultracompact: false });
    const off = render();
    expect(off).toContain("●");
    setActivePrefsSnapshotForTests({ ...DEFAULT_PREFS, ultracompact: true });
    expect(render()).toBe(off);
    setActivePrefsSnapshotForTests({ ...DEFAULT_PREFS });
  });
});

describe("working indicator + turn summary", async () => {
  const mod = await import("./index.ts");
  const { sumUsageTokens, formatTokenCount, formatTurnSummary, applyWorkingIndicator, startTurnClock, stopTurnClockAndSummarize, WORKING_FRAMES, WORKING_FRAME_MS, XTRM_TURN_SUMMARY_ENTRY } = mod;
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  test("usage total counts fresh tokens only, ignores cacheRead", () => {
    expect(sumUsageTokens([
      { type: "usage", usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 } },
      { type: "message", message: { role: "assistant", usage: { input: 929, output: 236, cacheRead: 172913, cacheWrite: 0, totalTokens: 174078 } } },
      { type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } },
      { type: "message", message: { role: "user" } },
      { type: "usage" },
    ])).toBe(350 + 1165 + 15);
  });

  test("summary line uses the operator's words", () => {
    expect(formatTokenCount(4120)).toBe("4,120");
    expect(formatTurnSummary({ seconds: 12, tokens: 4120 })).toBe("worked for 12s, used 4,120 tokens");
  });

  test("frames travel the X through the center, then double-flash, no lead-in, at 80ms", () => {
    expect(WORKING_FRAMES).toHaveLength(10);
    const [tl, c1, br, bl, c2, tr, on1, off1, on2, off2] = WORKING_FRAMES;
    expect([tl, c1, br, bl, c2, tr]).toEqual(["\u2801", "\u2812", "\u2820", "\u2804", "\u2812", "\u2808"]);
    expect([on1, on2]).toEqual(["\u282d", "\u282d"]);
    expect([off1, off2]).toEqual([" ", " "]);
    for (const frame of WORKING_FRAMES) expect(frame.startsWith("\t")).toBe(false);
    const seen: unknown[] = [];
    applyWorkingIndicator({ setWorkingIndicator: (o) => { seen.push(o); } });
    expect(seen).toEqual([{ frames: WORKING_FRAMES, intervalMs: WORKING_FRAME_MS }]);
    expect(WORKING_FRAME_MS).toBe(80);
  });

  test("ticker messages carry elapsed seconds; settle summarizes the turn alone", () => {
    const messages: string[] = [];
    const ui = { setWorkingMessage: (m?: string) => { messages.push(m ?? ""); } };
    const timers: Array<() => void> = [];
    const realNow = Date.now;
    try {
      startTurnClock(ui, 1000, 5000, (fn) => { timers.push(fn); return 1 as unknown as ReturnType<typeof setInterval>; });
      expect(messages).toEqual(["elapsed 0s"]);
      Date.now = () => 5000 + 12_300;
      timers.forEach((fn) => fn());
      expect(messages.at(-1)).toBe("elapsed 12s");
      const { freezeTurnClock } = mod;
      freezeTurnClock(5000 + 12_300);
      // Turn used 340 tokens alone (1340 end - 1000 start), took 12s.
      expect(stopTurnClockAndSummarize(1340)).toEqual({ seconds: 12, tokens: 340 });
      // Double-settle never summarizes twice.
      expect(stopTurnClockAndSummarize(9999)).toBeNull();
    } finally {
      Date.now = realNow;
      stopTurnClockAndSummarize(0);
    }
  });

  test("agent start/end wires message, entry append, and renderer", async () => {
    const { handlers, entryRenderers, appended } = registerWithMock();
    expect(handlers["agent_start"]).toBeDefined();
    expect(handlers["agent_end"]).toBeDefined();
    expect(handlers["agent_settled"]).toBeDefined();
    const messages: string[] = [];
    const startEntries = [{ type: "message", message: { role: "assistant", usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } } }];
    const endEntries = [...startEntries, { type: "message", message: { role: "assistant", usage: { input: 0, output: 34, cacheRead: 200, cacheWrite: 0 } } }];
    const ctx = (entries: unknown[]) => ({
      ui: { setWorkingMessage: (m?: string) => { messages.push(m ?? ""); } },
      sessionManager: { getEntries: () => entries },
    });
    await handlers["agent_start"]({ type: "agent_start" }, ctx(startEntries));
    expect(messages).toEqual(["elapsed 0s"]);
    await handlers["agent_end"]({ type: "agent_end", messages: [] }, ctx(endEntries));
    expect(appended).toEqual([]);
    await handlers["agent_settled"]({ type: "agent_settled" }, ctx(endEntries));
    expect(appended).toEqual([{ customType: XTRM_TURN_SUMMARY_ENTRY, data: { seconds: expect.any(Number), tokens: 34 } }]);
    await handlers["agent_settled"]({ type: "agent_settled" }, ctx(endEntries));
    expect(appended).toHaveLength(1);
    const render = entryRenderers[XTRM_TURN_SUMMARY_ENTRY] as (e: unknown, o: unknown, t: unknown) => { text: string };
    const theme = { fg: (_n: string, t: string) => `fg[${t}]`, italic: (t: string) => `i[${t}]` };
    expect(render({ data: { seconds: 12, tokens: 4120 } }, { expanded: false }, theme).text)
      .toBe("  fg[i[worked for 12s, used 4,120 tokens]]");
  });
});

describe("assistant response dot", async () => {
  const { prefixAssistantDot } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  test("opens the leading paragraph with the dot", () => {
    expect(prefixAssistantDot("hello there")).toBe("\u25cf hello there");
    // Only the leading paragraph: later ones keep their own shape.
    expect(prefixAssistantDot("hello there\n\nsecond paragraph")).toBe("\u25cf hello there\n\nsecond paragraph");
  });

  test("only the first line is prefixed; pi wraps the rest itself", () => {
    const out = prefixAssistantDot("one two three four five six seven eight nine ten") as string;
    expect(out).toBe("\u25cf one two three four five six seven eight nine ten");
    expect(out.split("\n")).toHaveLength(1);
    // No indent is invented: a wrapped continuation stays flush left.
    expect(out).not.toContain("\u200b");
  });

  test("leaves a model-written list alone", () => {
    // The list bullet is the theme's, not ours: dashes stay dashes.
    expect(prefixAssistantDot("- item")).toBeUndefined();
    expect(prefixAssistantDot("intro\n\n- item one\n- item two"))
      .toBe("\u25cf intro\n\n- item one\n- item two");
    expect(prefixAssistantDot("\u25cf already dotted")).toBeUndefined();
  });

  test("code fences, headings, quotes, lists and thinking rows get no dot", () => {
    expect(prefixAssistantDot("```ts\ncode\n```")).toBeUndefined();
    expect(prefixAssistantDot("# Title")).toBeUndefined();
    expect(prefixAssistantDot("> quoted")).toBeUndefined();
    expect(prefixAssistantDot("- item")).toBeUndefined();
    expect(prefixAssistantDot("Thinking...  recap clause  193")).toBeUndefined();
    expect(prefixAssistantDot("")).toBeUndefined();
  });

  test("a block construct after the prose passes through", () => {
    const out = prefixAssistantDot("intro line\n\n```ts\nconst a = 1;\n```");
    expect(out).toBe("\u25cf intro line\n\n```ts\nconst a = 1;\n```");
  });

  test("idempotent across re-renders", () => {
    // Second pass sees its own dot and leaves the block alone.
    expect(prefixAssistantDot("\u25cf hello")).toBeUndefined();
    expect(prefixAssistantDot(prefixAssistantDot("hello") as string)).toBeUndefined();
  });

  test("factory wires the dot for assistant text only", () => {
    const { transformers } = registerWithMock();
    const dotter = transformers[transformers.length - 1];
    expect(dotter("hello", { messageType: "assistant" })).toBe("\u25cf hello");
    expect(dotter("hello", { messageType: "user" })).toBe("hello");
    expect(dotter("some *thinking* trace", { messageType: "assistant-thinking" })).toBe("some *thinking* trace");
  });
});

describe("assistant dot guards", async () => {
  const { prefixAssistantDot, collapsedThinkingStyle, buildCollapsedThinkingRow } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  test("skips the styled thinking row (ANSI-prefixed label)", () => {
    const row = buildCollapsedThinkingRow("some recap", collapsedThinkingStyle(() => undefined));
    expect(row.startsWith("Thinking")).toBe(false);
    expect(prefixAssistantDot(row)).toBeUndefined();
  });

  test("leaves invisible-only messages untouched", () => {
    // Nothing visible to hang the dot on: the transformer declines.
    expect(prefixAssistantDot("​")).toBeUndefined();
    expect(prefixAssistantDot("​\n​")).toBeUndefined();
  });
});

describe("assistant text hierarchy (CORE-2517 rework)", async () => {
  const { boldMarkdownHeadings, prefixAssistantDot, buildThinkingRecap, fitThinkingRowToWidth } = await import("./index.ts");
  const stripSgr = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const width = (text: string) => stripSgr(text).length;

  test("headings gain weight: pi's heading style is colour-only", async () => {
    const { setActiveThemeProvider } = await import("./index.ts");
    const theme = { fg: (_n: string, t: string) => t, bold: (t: string) => `\u001b[1m${t}\u001b[22m`, italic: (t: string) => t };
    setActiveThemeProvider(() => theme);
    try {
      const headed = boldMarkdownHeadings("# Title\nbody\n## Sub");
      expect(headed).toContain("\u001b[1mTitle\u001b[22m");
      expect(headed).toContain("\u001b[1mSub\u001b[22m");
      expect(headed).toContain("\nbody");
      // Idempotent: a second pass does not stack bold.
      expect(boldMarkdownHeadings(headed)).toBe(headed);
    } finally {
      setActiveThemeProvider(null);
    }
  });

  test("headings inside fenced code are untouched", async () => {
    const { setActiveThemeProvider } = await import("./index.ts");
    const theme = { fg: (_n: string, t: string) => t, bold: (t: string) => `\u001b[1m${t}\u001b[22m`, italic: (t: string) => t };
    setActiveThemeProvider(() => theme);
    try {
      const md = "```sh\n# not a heading\n```\n# real";
      const out = boldMarkdownHeadings(md);
      expect(out).toContain("\n# not a heading\n");
      expect(out).toContain("\u001b[1mreal\u001b[22m");
    } finally {
      setActiveThemeProvider(null);
    }
  });

  test("the dot is a prefix, not a re-wrap: pi owns the line breaking", () => {
    const paragraph = "word ".repeat(40).trim();
    const source = `first line\n${paragraph}`;
    const out = prefixAssistantDot(source) as string;
    // The text is untouched apart from the marker, so inline markup (code
    // spans, links) is never split by a break of ours.
    expect(out).toBe(`\u25cf ${source}`);
  });

  test("code fences after the run keep their own shape", () => {
    const out = prefixAssistantDot("intro\n\n```ts\nconst a = 1;\n```") as string;
    expect(out).toContain("\n```ts\nconst a = 1;\n```");
  });

  test("thinking recap keeps the ellipsis and the 64-char cap; row fits", () => {
    const recap = buildThinkingRecap("x".repeat(200));
    expect(recap.endsWith("…")).toBe(true);
    expect(recap.length).toBeLessThanOrEqual(64);
    const row = `  Thinking  ${recap}`;
    // The fitter is ANSI/width driven (this file mocks pi-tui's truncation),
    // so assert the guards here: unknown width and non-rows pass through.
    expect(fitThinkingRowToWidth(row, 0)).toBe(row);
    expect(fitThinkingRowToWidth("plain text", 40)).toBe("plain text");
    expect(fitThinkingRowToWidth(row, undefined)).toBe(row);
  });
});

describe("thinking clause truncation", async () => {
  const { truncateClause, buildThinkingRecap, fitThinkingRowToWidth, buildCollapsedThinkingRow, collapsedThinkingStyle } = await import("./index.ts");
  const stripSgr = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

  test("cuts at a word boundary and marks the cut", () => {
    const out = truncateClause("I need to inspect the renderer and identify the relevant files", 40);
    const source = "I need to inspect the renderer and identify the relevant files";
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
    // The kept text is a prefix of the source and stops where a word ends.
    const body = out.slice(0, -1);
    expect(source.startsWith(body)).toBe(true);
    expect(source[body.length]).toBe(" ");
  });

  test("short text passes through untouched", () => {
    expect(truncateClause("short", 40)).toBe("short");
  });

  test("the clause and the command cut use the same ellipsis glyph", async () => {
    expect(truncateClause("word ".repeat(20).trim(), 30).endsWith("…")).toBe(true);
    const { shortenCommand } = await import("./format.ts");
    expect(shortenCommand("a".repeat(120)).endsWith("…")).toBe(true);
  });

  test("the recap keeps the ellipsis inside the 64-character cap", () => {
    const recap = buildThinkingRecap("word ".repeat(40).trim());
    expect(recap.length).toBeLessThanOrEqual(64);
    expect(recap.endsWith("…")).toBe(true);
  });

  test("the fitter leaves short rows and non-rows alone", () => {
    expect(fitThinkingRowToWidth("plain text", 80)).toBe("plain text");
    const row = buildCollapsedThinkingRow("short clause", collapsedThinkingStyle(() => undefined));
    expect(fitThinkingRowToWidth(row, 200)).toBe(row);
    expect(fitThinkingRowToWidth(row, 0)).toBe(row);
    expect(fitThinkingRowToWidth(row, undefined)).toBe(row);
    // Strip safety: the label and the anchor survive whatever the mock reports.
    expect(stripSgr(fitThinkingRowToWidth(row, 80))).toContain("Thinking");
  });
});

describe("errors are the only thing that grabs attention", () => {
  const RED_DARK = "255;154;154";

  const tag = { fg: (token: string, text: string) => `[${token}]${text}`, bold: (text: string) => `*${text}*` };

  test("a failed tool row uses the error token and says failed", async () => {
    const { renderUltraRow } = await import("./index.ts");
    const raw = renderUltraRow(tag, { statusColor: "error", verb: "read", subject: "/a", primary: "nope" });
    expect(raw).toContain("[error]");
    expect(raw).toContain("failed");
    expect(raw).not.toContain("[dim]");
  });

  test("a successful row never touches the error token", async () => {
    const { renderUltraRow } = await import("./index.ts");
    const raw = renderUltraRow(tag, { statusColor: "success", verb: "Ran shell command", subject: "pnpm test", primary: "84 passed" });
    expect(raw).not.toContain("[error]");
  });

  test("the error token resolves to the brightest grayscale in every shipped theme", async () => {
    const themes = ["xtrm-dark", "xtrm-dark-flattools", "xtrm-light", "xtrm-light-flattools"];
    for (const name of themes) {
      const json = (await import(`../../themes/xtrm-ui/${name}.json`)) as unknown as {
        default: { colors: Record<string, string>; vars: Record<string, string> };
      };
      const { colors, vars } = json.default;
      const hex = (colors.error ?? "").startsWith("#") ? colors.error : vars[colors.error];
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      // Chrome grayscale: equal channels, no hue. Emphasis comes from
      // brightness and weight, never from red: near-white on dark themes,
      // near-black on light themes.
      expect(r).toBe(g);
      expect(g).toBe(b);
      if (name.includes("light")) expect(r).toBeLessThanOrEqual(0x20);
      else expect(r).toBeGreaterThanOrEqual(0xE0);
      // Diffs keep their semantic colours.
      expect(colors.toolDiffAdded).not.toBe(colors.toolDiffRemoved);
    }
  });

  test("inline code and links keep a hue; chrome stays grey", async () => {
    const themes = ["xtrm-dark", "xtrm-dark-flattools", "xtrm-light", "xtrm-light-flattools"];
    for (const name of themes) {
      const json = (await import(`../../themes/xtrm-ui/${name}.json`)) as unknown as {
        default: { colors: Record<string, string>; vars: Record<string, string> };
      };
      const { colors, vars } = json.default;
      const hex = (token: string | undefined) => {
        const value = token ?? "";
        return value.startsWith("#") ? value : vars[value];
      };
      const channels = (value: string) => [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
      const code = hex(colors.mdCode) as string;
      const link = hex(colors.mdLink) as string;
      const secondary = hex(colors.muted) as string;
      // Content keeps hue — inline code is an identifier, not chrome — while
      // the surrounding chrome tokens stay on the grey ramp (r === g === b).
      for (const hue of [code, link]) {
        expect(hue).toMatch(/^#[0-9A-Fa-f]{6}$/);
        const [r, g, b] = channels(hue);
        expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(24);
      }
      expect(code).not.toBe(link);
      const [sr, sg, sb] = channels(secondary);
      expect(Math.max(sr, sg, sb) - Math.min(sr, sg, sb)).toBeLessThanOrEqual(2);
    }
  });

  test("the external frame header marks failure with the error token, not red", async () => {
    const { renderExternalToolLines, setActiveThemeProvider } = await import("./index.ts");
    const theme = { fg: (c: string, t: string) => `[${c}]${t}`, bold: (t: string) => `*${t}*`, italic: (t: string) => `_${t}_` };
    setActiveThemeProvider(() => theme);
    try {
      const failed = renderExternalToolLines(["boom"], 80, "external", true, "probe", 5, "error").join("\n");
      expect(failed).toContain("[error]!");
      expect(failed).toContain("[error]");
      expect(failed).not.toContain("[success]");
      expect(failed).not.toContain("38;2;");
      const ok = renderExternalToolLines(["fine"], 80, "external", true, "probe", 5, "success").join("\n");
      expect(ok).not.toContain("[error]");
    } finally {
      setActiveThemeProvider(null);
    }
  });
});

describe("click-to-expand on framed tool rows", async () => {
  const { externalToolRowClick } = await import("./index.ts");
  test("a left click toggles the frame's own expanded state, like pi's rows", () => {
    const seen: boolean[] = [];
    const row = { toolName: "serena_find_symbol", expanded: false, setExpanded: (next: boolean) => seen.push(next) };
    expect(externalToolRowClick(row, { type: "click", button: "left" })).toBe(true);
    expect(seen).toEqual([true]);
    // A second click collapses again: the same toggle ctrl+o drives.
    const expandedRow = { toolName: "codemode", expanded: true, setExpanded: (next: boolean) => seen.push(next) };
    expect(externalToolRowClick(expandedRow, { type: "click", button: "left" })).toBe(true);
    expect(seen).toEqual([true, false]);
  });

  test("rows the frame does not own fall through to pi's handler", () => {
    // pi's built-in tools (bash, read, … — lowercase, as pi registers them)
    // keep their own result region and its MouseRegion.
    expect(externalToolRowClick({ toolName: "bash", expanded: false }, { type: "click", button: "left" })).toBeUndefined();
    expect(externalToolRowClick({ toolName: "read", expanded: false }, { type: "click", button: "left" })).toBeUndefined();
    expect(externalToolRowClick({ toolName: undefined }, { type: "click", button: "left" })).toBeUndefined();
  });

  test("only a left click counts", () => {
    const row = { toolName: "structured_return", expanded: false, setExpanded: () => {} };
    expect(externalToolRowClick(row, { type: "click", button: "right" })).toBeUndefined();
    expect(externalToolRowClick(row, { type: "move", button: "left" })).toBeUndefined();
    expect(externalToolRowClick(row, {})).toBeUndefined();
  });

  test("falls back to the component's own updateDisplay when it has no setter", () => {
    let redrawn = 0;
    const row = { toolName: "process_logs", expanded: false, updateDisplay: () => { redrawn += 1; } };
    expect(externalToolRowClick(row, { type: "click", button: "left" })).toBe(true);
    expect(row.expanded).toBe(true);
    expect(redrawn).toBe(1);
  });
});

describe("markdown transformer wiring", () => {
  test("one registration does fitting, dotting and heading weight", async () => {
    const { setActiveThemeProvider } = await import("./index.ts");
    setActiveThemeProvider(() => ({ fg: (_n: string, t: string) => t, bold: (t: string) => `\u001b[1m${t}\u001b[22m`, italic: (t: string) => t }));
    const { transformers } = registerWithMock();
    // pi keeps one transformer per extension; a second registration would
    // replace this one, so the extension must register exactly one.
    expect(transformers).toHaveLength(1);
    const transform = transformers[0];
    // A long thinking row is fitted, not dotted.
    const longRecap = "word ".repeat(40).trim();
    const row = `\u200b  Thinking...  ${longRecap}  200`;
    const fitted = transform(row, { messageType: "assistant", availableWidth: 40 });
    expect(fitted).not.toContain("\u25cf");
    expect(fitted.split("\n")).toHaveLength(1);
    // Prose takes the dot; headings gain weight.
    const prose = transform("intro line\n\n# Title", { messageType: "assistant", availableWidth: 80 });
    expect(prose.startsWith("\u25cf intro line")).toBe(true);
    expect(prose).toContain("\u001b[1mTitle\u001b[22m");
    // Non-assistant messages are untouched.
    expect(transform("intro", { messageType: "user", availableWidth: 80 })).toBe("intro");
    setActiveThemeProvider(null);
  });

  test("a thinking row never takes the dot, whatever its label variant", async () => {
    const { prefixAssistantDot } = await import("./index.ts");
    for (const label of ["Thinking...", "Thinking", "Thinking..."]) {
      expect(prefixAssistantDot(`${label}  a recap  42`)).toBeUndefined();
    }
  });
});
