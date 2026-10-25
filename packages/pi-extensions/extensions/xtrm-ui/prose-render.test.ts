/**
 * The two rendering contracts that pi's component would silently break.
 *
 * pi builds every assistant text block as
 *   new Markdown(content.text.trim(), outputPad, 0, theme)
 * and re-wraps each paragraph itself. So:
 *   1. a leading-space indent is stripped by trim() → the thinking row needs a
 *      zero-width anchor to keep its two columns;
 *   2. a text-prefix dot cannot hang an indent → the dot is a list bullet,
 *      rendered for this component only via a scoped theme override.
 *
 * These tests exercise the mechanisms without importing pi-tui, because the
 * sibling handler suite mocks that module for the whole test process.
 */

import { describe, expect, test } from "bun:test";

import { createPatchedUpdateContent, buildCollapsedThinkingRow, collapsedThinkingStyle } from "./index.ts";

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
    const row = buildCollapsedThinkingRow("comparing renderers", collapsedThinkingStyle(() => "xtrm-dark"));
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

describe("the dot is a scoped bullet, not a text prefix", () => {
  test("the component renders its lists with the dot while updating", () => {
    const seen: string[] = [];
    const component = {
      markdownTheme: { listBullet: (text: string) => `[${text}]`, heading: (text: string) => text },
      updateContent: () => {},
    };
    const originalTheme = component.markdownTheme;
    let bulletDuringRender: string | undefined;
    const patched = createPatchedUpdateContent(() => {
      bulletDuringRender = component.markdownTheme.listBullet("-");
    }, collapsedThinkingStyle(() => "xtrm-dark"));
    patched.call(component as never, { content: [{ type: "text", text: "hello" }] } as never);
    expect(bulletDuringRender).toBe("\u25cf ");
    // Restored afterwards: no other surface sees the dot bullet.
    expect(component.markdownTheme).toBe(originalTheme);
    expect(component.markdownTheme.listBullet("-")).toBe("[-]");
    expect(seen).toEqual([]);
  });
});
