/**
 * The two rendering contracts that pi's component would silently break.
 *
 * pi builds every assistant text block as
 *   new Markdown(content.text.trim(), outputPad, 0, theme)
 * and re-wraps each paragraph itself. So:
 *   1. a leading-space indent is stripped by trim() → the thinking row needs a
 *      zero-width anchor to keep its column; the row carries ONE indent space
 *      and markdown's outputPad supplies the second, so thinking and tool rows
 *      share one column (no double indent);
 *   2. pi re-wraps each paragraph, so the dot is a plain first-line prefix —
 *      wrapping it ourselves would split inline code spans and links. The
 *      hanging indent is applied to pi's finished lines instead
 *      (alignAssistantLines): the dot moves into the marker columns and every
 *      line starts on the text column, like the tool rows.
 *
 * These tests exercise the mechanisms without importing pi-tui, because the
 * sibling handler suite mocks that module for the whole test process.
 */

import { describe, expect, test } from "bun:test";

import { buildCollapsedThinkingRow, collapsedThinkingStyle } from "./index.ts";

const stripSgr = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
const visibleIndent = (text: string) => {
  const visible = stripSgr(text).replace(/^\u200b/, "");
  return visible.length - visible.trimStart().length;
};

describe("thinking row survives pi's text.trim()", () => {
  test("a plain indent would be stripped", () => {
    expect(visibleIndent("  Thinking".trim())).toBe(0);
  });

  test("the anchored indent keeps its column (markdown adds the other)", () => {
    const row = buildCollapsedThinkingRow("comparing renderers", collapsedThinkingStyle(() => undefined));
    // One space at the row level; pi's Markdown padding is the second column.
    expect(visibleIndent(row.trim())).toBe(1);
    expect(stripSgr(row.trim())).toContain("Thinking");
  });

  test("the expanded block keeps the indent on label and body", () => {
    const { buildExpandedThinkingBlock } = require("./index.ts") as typeof import("./index.ts");
    const block = buildExpandedThinkingBlock("first detail\nsecond detail", collapsedThinkingStyle(() => undefined));
    const lines = block.trim().split("\n").filter((line) => stripSgr(line).trim() !== "");
    for (const line of lines) expect(visibleIndent(line)).toBe(1);
  });
});

describe("the dot does not disturb pi's own rendering", () => {
  test("only the first line is touched", () => {
    const { prefixAssistantDot } = require("./index.ts") as typeof import("./index.ts");
    const prose = "alpha beta gamma delta epsilon zeta eta theta";
    expect(prefixAssistantDot(prose)).toBe(`\u25cf ${prose}`);
  });

  test("inline constructs are never split by a break of ours", () => {
    const { prefixAssistantDot } = require("./index.ts") as typeof import("./index.ts");
    // A pre-wrap would cut these in half; a prefix cannot.
    const prose = "use `the/whole/span` then [the label](https://example.com/x) here";
    expect(prefixAssistantDot(prose)).toBe(`\u25cf ${prose}`);
  });

  test("rendered prose lands on the tool rows' grid: dot in the marker columns, text and wrap on column 2", () => {
    const { alignAssistantLines } = require("./index.ts") as typeof import("./index.ts");
    // pi's output at outputPad 1: a spacer, the dotted first line, a wrapped
    // line, a thinking row (anchored, already on column 2), a styled dot line.
    const rendered = ["", " ● First line of the reply", " wrapped part", " ​ Thinking...", " \x1b[1m● Bold start"];
    expect(alignAssistantLines(rendered, 1)).toEqual([
      "",
      "● First line of the reply",
      "  wrapped part",
      " ​ Thinking...",
      "\x1b[1m● Bold start",
    ]);
    // outputPad 0 needs two columns; the dot line comes out the same.
    expect(alignAssistantLines(["● Hi", "more"], 2)).toEqual(["● Hi", "  more"]);
    expect(alignAssistantLines(rendered, 0)).toBe(rendered);
  });

  test("a model-written list keeps the theme's own dash", () => {
    const { prefixAssistantDot } = require("./index.ts") as typeof import("./index.ts");
    expect(prefixAssistantDot("intro\n\n- first\n- second")).toBe("\u25cf intro\n\n- first\n- second");
    expect(prefixAssistantDot("- first")).toBeUndefined();
  });
});
