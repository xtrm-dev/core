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
const { setActivePrefsSnapshotForTests, DEFAULT_PREFS } = await import("./index.ts");

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
    // Ultra is the default now, so pin the frame path explicitly: the
    // one-line default is asserted separately below.
    setActivePrefsSnapshotForTests({ ...DEFAULT_PREFS, ultracompact: false });
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

    for (const rendered of [call(false), call(true)]) {
      expect(rendered).toContain("137 | foo");
      expect(rendered).toContain("138 | ");
      expect(rendered).toContain("139 | bar");
      // No double-prefix drift.
      expect(rendered).not.toContain("137 | 137 |");
      expect(rendered).not.toContain("138 | 138 |");
    }
    // Default presentation: one row, path and range only — the numbered body
    // is the expanded detail.
    setActivePrefsSnapshotForTests({ ...DEFAULT_PREFS });
    const oneLine = call(false);
    expect(oneLine).toContain("b.txt:137");
    expect(oneLine).not.toContain("137 | foo");
    expect(oneLine.split("\n")).toHaveLength(1);
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
        hint: (text: string) => text,
        italic: (text: string) => text,
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
    // The collapsed row advertises neither the count nor the shortcut.
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
    expect(expanded).toContain("(Ctrl+T to collapse)");
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
      hint: (text: string) => text,
      italic: (text: string) => text,
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
    expect(run(false, { followsToggle: false })).toBe("Thinking · A long trace line that must not leak on the first render");
    // ...and stays compact when pi's hide state is true.
    expect(run(true, { followsToggle: false })).toBe("Thinking · A long trace line that must not leak on the first render");
  });

  test("thinking patch passes non-thinking messages through untouched", () => {
    type ContentBlock = { type: string; text?: string };
    const plainStyle = {
      label: (text: string) => text,
      recap: (text: string) => text,
      hint: (text: string) => text,
      italic: (text: string) => text,
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
      hint: (text: string) => text,
      italic: (text: string) => text,
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
    expect(externalToolContentLines(component as never, [], false)).toEqual(["  l2", "  l3", "  l4", " \x1b[2m\x1b[3m … +1 lines\x1b[23m\x1b[22m", "out"]);
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
    expect(plain.some((l) => l.includes("… +6 lines"))).toBe(true);
    expect(plain).toContain("  └ result1");
    for (let i = 2; i <= 6; i++) expect(plain).toContain(`    result${i}`);
    expect(plain.some((l) => l.includes("result7"))).toBe(false);
    expect(plain.at(-1)).toContain("showing 6/20 lines");
  });

  test("code body mirrors the bash tree: bold execution, └ output, bare meta", () => {
    const raw = render(false);
    const plain = raw.map(strip);
    expect(raw[1]).toContain("\x1b[1m");
    expect(plain.some((l) => l.includes("└ result1"))).toBe(true);
    expect(raw.some((l) => l.includes("└─"))).toBe(false);
    expect(plain[0]).toContain("codemode");
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
    expect(raw[1]).toContain("\x1b[2m\x1b[1m");
    expect(raw[1]).toContain("y = 2");
  });

  test("expanded shows the whole program and the whole output", () => {
    const plain = render(true).map(strip);
    expect(plain).toContain("  line2 = 2");
    expect(plain).toContain("  line10 = 10");
    expect(plain).toContain("    result20");
    expect(plain.some((l) => l.includes("+"))).toBe(false);
    expect(plain.at(-1)).toContain("20 lines");
  });

  test("code cap follows the command-lines pref", () => {
    expect(activeCommandPreviewLines()).toBe(DEFAULT_PREFS.commandPreviewLines);
    const content = externalToolContentLines(component as never, [], false, 2);
    expect(content.slice(0, 1)).toEqual(["  line2 = 2"]);
    expect(content[1]).toContain("… +8 lines");
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
    expect(out).toContain(" … +2 lines");
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
    expect(lines[4]).toContain(" … +2 lines");
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

describe("ultracompact rows", async () => {
  const { renderUltraRow, buildUltraExternalLine, ultraExternalSubject, ultraExternalPrimary, ultraBashSubject, ULTRA_BASH_VERB, normalizePrefs, DEFAULT_PREFS } = await import("./index.ts");
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

  test("prefs default on (one-line timeline), explicit off survives as the escape hatch", () => {
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

  test("external spans byte-match native spans", async () => {
    // Same bytes by construction, in every terminal: force chalk color and
    // compare raw output (no strip — the escapes are the point).
    const chalk = (await import("chalk")).default;
    const prev = chalk.level;
    chalk.level = 3;
    try {
      // The mock must reproduce the real theme's dim token, which wraps the
      // colour in SGR 2; the ladder's soft tier relies on that.
      const mock = {
        fg: (c: string, t: string) => c === "dim" ? `\u001b[2m${chalk.hex("#8a8a8a")(t)}\u001b[22m` : c === "muted" ? chalk.hex("#a7a7a7")(t) : c === "error" ? chalk.hex("#ff9a9a")(t) : t,
        bold: (t: string) => chalk.bold(t),
      };
      for (const status of ["pending", "success", "error"] as const) {
        const native = renderUltraRow(mock, { statusColor: status, verb: "used codemode", subject: "x = 1", primary: "ok" });
        const framed = buildUltraExternalLine("codemode", { code: "x = 1" }, ["ok"], status);
        expect(framed).toBe(native);
      }
    } finally {
      chalk.level = prev;
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

  test("bash ultra verb matches the external row grammar", () => {
    // One grammar across native and external rows: "used <tool>".
    expect(ULTRA_BASH_VERB).toBe("used bash");
  });

  test("bash subject strips a dangling && or || tail", () => {
    expect(ultraBashSubject("rm -f /tmp/x && echo done")).toBe("rm -f /tmp/x");
    expect(ultraBashSubject("a || b")).toBe("a");
    expect(ultraBashSubject("npm test")).toBe("npm test");
  });

  test("weight ladder baseline: semi verb, soft body, never full-bright", () => {
    const mark = { fg: (c: string, t: string) => `[${c}]${t}`, bold: (t: string) => `*${t}*` };
    const raw = renderUltraRow(mark, { statusColor: "success", verb: "Ran", subject: "npm test", primary: "3 lines" });
    // SPEC v1 rule 15: the head is the intermediate weight (muted, no bold),
    // the body is soft (dim). Nothing renders full-bright.
    expect(raw).toContain("[muted]Ran");
    expect(raw).toContain("[dim]npm test");
    expect(raw).toContain("[dim]3 lines");
    expect(raw).not.toContain("\x1b[1m");
    expect(raw).not.toContain("[text]");
    // theme.bold must not be consulted: the fake's bold tag never appears.
    expect(raw).not.toContain("*");
    expect(strip(raw).replace(/\[(muted|dim)\]/g, "")).toBe("  Ran            npm test  3 lines");
  });

  test("errors keep full red instead of dimming", () => {
    const mark = { fg: (c: string, t: string) => `[${c}]${t}`, bold: (t: string) => `*${t}*` };
    const raw = renderUltraRow(mark, { statusColor: "error", verb: "read", subject: "/a", primary: "nope" });
    expect(raw).toContain("[error]");
    expect(raw).not.toContain("\x1b[2m");
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

describe("thinking collapsed row shape", async () => {
  const { buildCollapsedThinkingRow } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  test("no indent, no count, no inline hint: label then one clause", () => {
    const style = {
      label: (t: string) => `L${t}`,
      recap: (t: string) => `R${t}`,
      italic: (t: string) => `I${t}`,
      hint: (t: string) => `H${t}`,
      sep: "|",
    };
    // The row carries the activity, not the bookkeeping: no character count
    // and no per-row Ctrl+T advertisement.
    expect(buildCollapsedThinkingRow("trace here", style)).toBe("LThinking|Itrace here");
    expect(buildCollapsedThinkingRow("trace here", style)).not.toContain("193");
    expect(buildCollapsedThinkingRow("trace here", style)).not.toContain("Ctrl+T");
  });
});

describe("CORE-2502 follow-ups", async () => {
  const mod = await import("./index.ts");
  const { buildCollapsedThinkingRow, collapsedThinkingStyle, expandedThinkingStyle, ultraThemeHexes, setActivePrefsSnapshotForTests, DEFAULT_PREFS, renderExternalToolLines, buildUltraExternalLine } = mod;
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;
  const theme = { fg: (_n: string, t: string) => t, bold: (t: string) => t };

  test("ultraThemeHexes mirrors xtrm theme tokens per theme", () => {
    expect(ultraThemeHexes("xtrm-dark")).toEqual({ muted: "#a7a7a7", dim: "#8a8a8a", error: "#ff9a9a" });
    expect(ultraThemeHexes("xtrm-light")).toEqual({ muted: "#5f5f5f", dim: "#7a7a7a", error: "#a85f5f" });
    expect(ultraThemeHexes("something-else")).toEqual({ muted: "#a7a7a7", dim: "#8a8a8a", error: "#ff9a9a" });
  });

  test("collapsed thinking style: grayscale italic, label brighter than recap, zero bold", () => {
    for (const [name, dimRgb, mutedRgb] of [
      ["xtrm-dark", "138;138;138", "167;167;167"],
      ["xtrm-light", "122;122;122", "95;95;95"],
    ] as const) {
      const style = collapsedThinkingStyle(() => name);
      for (const span of [style.recap("trace"), style.italic("trace"), style.hint("x")]) {
        expect(span).toContain("[3m");
        expect(span).toContain(`38;2;${dimRgb}m`);
        expect(span).not.toContain("[1m");
      }
      // The label is the one step up: muted, still italic, still no bold.
      expect(style.label("Thinking")).toContain(`38;2;${mutedRgb}m`);
      expect(style.label("Thinking")).toContain("[3m");
      expect(style.label("Thinking")).not.toContain("[1m");
    }
    const row = buildCollapsedThinkingRow("trace here", collapsedThinkingStyle(() => "xtrm-dark"));
    expect(row).not.toContain("[1m");
    expect(row).not.toContain("Ctrl+T");
  });

  test("expanded thinking style keeps the frozen pre-ultra treatment", () => {
    expect(expandedThinkingStyle.label("Thinking...")).toContain("[1m");
    expect(expandedThinkingStyle.recap("trace")).toContain("38;2;167;167;167m");
  });

  test("frame follows the active theme (dark vs light hexes)", async () => {
    const chalk = (await import("chalk")).default;
    const prevLevel = chalk.level;
    const prevPrefs = { ...DEFAULT_PREFS };
    chalk.level = 3;
    try {
      setActivePrefsSnapshotForTests({ ...DEFAULT_PREFS, themeName: "xtrm-dark" });
      expect(buildUltraExternalLine("codemode", { code: "x = 1" }, ["ok"], "success")).toContain("138;138;138");
      setActivePrefsSnapshotForTests({ ...DEFAULT_PREFS, themeName: "xtrm-light" });
      const light = buildUltraExternalLine("codemode", { code: "x = 1" }, ["ok"], "success");
      expect(light).toContain("122;122;122");
      expect(light).not.toContain("138;138;138");
    } finally {
      chalk.level = prevLevel;
      setActivePrefsSnapshotForTests(prevPrefs);
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

  test("prefixes the first prose line", () => {
    expect(prefixAssistantDot("hello there")).toBe("● hello there");
    expect(prefixAssistantDot("\n\nhello there\nsecond line")).toBe("\n\n● hello there\nsecond line");
  });

  test("skips fences, headings, quotes, lists, thinking rows", () => {
    expect(prefixAssistantDot("```ts\ncode\n```")).toBe("```ts\ncode\n```");
    expect(prefixAssistantDot("# Title")).toBe("# Title");
    expect(prefixAssistantDot("> quoted")).toBe("> quoted");
    expect(prefixAssistantDot("- item")).toBe("- item");
    expect(prefixAssistantDot("Thinking  recap clause")).toBe("Thinking  recap clause");
    expect(prefixAssistantDot("")).toBe("");
  });

  test("idempotent across re-renders", () => {
    expect(prefixAssistantDot(prefixAssistantDot("hello"))).toBe("● hello");
  });

  test("factory wires the dot for assistant text only", () => {
    const { transformers } = registerWithMock();
    const dotter = transformers[transformers.length - 1];
    expect(dotter("hello", { messageType: "assistant" })).toBe("● hello");
    expect(dotter("hello", { messageType: "user" })).toBe("hello");
    expect(dotter("some *thinking* trace", { messageType: "assistant-thinking" })).toBe("some *thinking* trace");
  });
});

describe("assistant dot guards", async () => {
  const { prefixAssistantDot, collapsedThinkingStyle, buildCollapsedThinkingRow } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  test("skips the styled thinking row (ANSI-prefixed label)", () => {
    const row = buildCollapsedThinkingRow("some recap", collapsedThinkingStyle(() => "xtrm-dark"));
    expect(row.startsWith("Thinking")).toBe(false);
    expect(prefixAssistantDot(row)).toBe(row);
  });

  test("leaves invisible-only messages untouched", () => {
    expect(prefixAssistantDot("​")).toBe("​");
    expect(prefixAssistantDot("​\n​")).toBe("​\n​");
  });
});

describe("custom message click expansion (CORE-2517)", async () => {
  const { wrapCustomMessageForClick } = await import("./index.ts");
  const test = (await import("bun:test")).test;
  const expect = (await import("bun:test")).expect;

  class FakeMouseRegion {
    constructor(
      public child: { render(width: number): string[] },
      public handler: (event: { type?: string; button?: string }) => unknown,
    ) {}
    render(width: number) {
      return this.child.render(width);
    }
    invalidate() {}
    handleMouse(event: { type?: string; button?: string }) {
      return this.handler(event);
    }
  }

  function fakeHost() {
    const expansions: boolean[] = [];
    return {
      expansions,
      children: [] as unknown[],
      customComponent: undefined as unknown,
      _expanded: false,
      setExpanded(value: boolean) {
        this._expanded = value;
        expansions.push(value);
      },
    };
  }

  test("a left click toggles expansion; other events and double wrapping do nothing", () => {
    const host = fakeHost();
    const component = { render: () => ["row"], invalidate: () => {} };
    const wrapped = wrapCustomMessageForClick(component, host, FakeMouseRegion as never);
    expect(wrapped).not.toBe(component);
    const region = wrapped as unknown as FakeMouseRegion;
    expect(region.render(80)).toEqual(["row"]);

    expect(region.handleMouse({ type: "click", button: "left" })).toEqual({ handled: true });
    expect(host.expansions).toEqual([true]);
    region.handleMouse({ type: "click", button: "left" });
    expect(host.expansions).toEqual([true, false]);

    // Only a left click is ours; movement and right clicks fall through.
    region.handleMouse({ type: "move" });
    region.handleMouse({ type: "click", button: "right" });
    expect(host.expansions).toEqual([true, false]);

    // Re-wrapping an already wrapped region would double-toggle.
    expect(wrapCustomMessageForClick(wrapped, host, FakeMouseRegion as never)).toBe(wrapped);
  });

  test("degrades to the raw component when pi-tui has no MouseRegion or the component cannot render", () => {
    const host = fakeHost();
    const component = { render: () => ["row"], invalidate: () => {} };
    expect(wrapCustomMessageForClick(component, host, null as never)).toBe(component);
    const notAComponent = {};
    expect(wrapCustomMessageForClick(notAComponent, host, FakeMouseRegion as never)).toBe(notAComponent);
    expect(host.expansions).toEqual([]);
  });
});

describe("compact timeline presentation contract", async () => {
  const mod = await import("./index.ts");
  const {
    buildUltraExternalLine,
    renderUltraRow,
    renderExternalToolLines,
    buildThinkingRecap,
    buildCollapsedThinkingRow,
    collapsedThinkingStyle,
    ultraThemeHexes,
    ULTRA_HIDDEN_MARK,
  } = mod;
  const stripSgr = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

  test("a resting tool row never advertises a shortcut", () => {
    const row = stripSgr(buildUltraExternalLine("codemode", { code: "x = 1" }, ["ok"], "success", { durationMs: 42 }));
    for (const hint of ["ctrl+o", "Ctrl+O", "Ctrl+T", "expand"]) expect(row.toLowerCase()).not.toContain(hint.toLowerCase());
    expect(row).toContain("used codemode");
    expect(row).toContain("42ms");
  });

  test("hidden detail is one glyph, and only above the threshold", () => {
    const hidden = buildUltraExternalLine("bash", {}, ["a", "b", "c", "d", "e"], "success", { hiddenLines: 5 });
    expect(stripSgr(hidden).trimEnd().endsWith(ULTRA_HIDDEN_MARK)).toBe(true);
    const trivial = buildUltraExternalLine("bash", {}, ["a"], "success", { hiddenLines: 1 });
    expect(trivial).not.toContain(ULTRA_HIDDEN_MARK);
  });

  test("expanded frames carry no collapsed indicator and keep every line", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `result line ${i}`);
    const expanded = renderExternalToolLines(lines, 80, "external", true, "probe", 12, "success").join("\n");
    expect(expanded).not.toContain(ULTRA_HIDDEN_MARK);
    expect(expanded).toContain("result line 19");
  });

  test("errors stay red and say failed in words", () => {
    const row = renderUltraRow({ fg: (token: string, text: string) => `[${token}]${text}` }, {
      statusColor: "error",
      verb: "bash",
      subject: "pnpm test",
    });
    expect(row).toContain("[error]");
    expect(row).toContain("failed");
  });

  test("thinking recap is one clause, capped, with no bookkeeping", () => {
    const long = "First clause. " + "x".repeat(200);
    const recap = buildThinkingRecap(long);
    expect(recap.length).toBeLessThanOrEqual(64);
    const row = stripSgr(buildCollapsedThinkingRow(recap, collapsedThinkingStyle(() => "xtrm-dark")));
    expect(row.startsWith("Thinking")).toBe(true);
    expect(row).not.toMatch(/\d{2,}/);
    expect(row).not.toContain("Ctrl+T");
  });

  test("both themes keep a darker soft tier than the intermediate one", () => {
    const luminance = (hex: string) => {
      const h = hex.replace("#", "");
      return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
    };
    for (const name of ["xtrm-dark", "xtrm-light"]) {
      const { muted, dim } = ultraThemeHexes(name);
      expect(muted).not.toBe(dim);
      for (const channel of [0, 1, 2]) {
        if (name === "xtrm-dark") expect(luminance(muted)[channel]).toBeGreaterThan(luminance(dim)[channel]);
        else expect(luminance(muted)[channel]).toBeLessThan(luminance(dim)[channel]);
      }
    }
  });
});
