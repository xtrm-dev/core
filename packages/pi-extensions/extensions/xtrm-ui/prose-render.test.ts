/**
 * The two rendering contracts that pi's component would silently break.
 *
 * pi builds every assistant text block as
 *   new Markdown(content.text.trim(), outputPad, 0, theme)
 * and re-wraps each paragraph itself. So:
 *   1. a leading-space indent is stripped by trim() → the thinking row needs a
 *      zero-width anchor to keep its two columns;
 *   2. pi re-wraps each paragraph, so the dot is a plain first-line prefix and
 *      continuation lines stay flush left — wrapping it ourselves to force a
 *      hanging indent would split inline code spans and links.
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

  test("the anchored indent keeps both columns", () => {
    const row = buildCollapsedThinkingRow("comparing renderers", 1200, collapsedThinkingStyle(() => "xtrm-dark"));
    expect(visibleIndent(row.trim())).toBe(2);
    expect(stripSgr(row.trim())).toContain("Thinking");
  });

  test("the expanded block keeps the indent on label and body", () => {
    const { buildExpandedThinkingBlock } = require("./index.ts") as typeof import("./index.ts");
    const block = buildExpandedThinkingBlock("first detail\nsecond detail", collapsedThinkingStyle(() => "xtrm-dark"));
    const lines = block.trim().split("\n").filter((line) => stripSgr(line).trim() !== "");
    for (const line of lines) expect(visibleIndent(line)).toBe(2);
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

  test("a model-written list keeps the theme's own dash", () => {
    const { prefixAssistantDot } = require("./index.ts") as typeof import("./index.ts");
    expect(prefixAssistantDot("intro\n\n- first\n- second")).toBe("\u25cf intro\n\n- first\n- second");
    expect(prefixAssistantDot("- first")).toBeUndefined();
  });
});
