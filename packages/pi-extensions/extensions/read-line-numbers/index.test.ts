import { describe, expect, mock, test } from "bun:test";

// NOTE: keep this factory a structural superset of the sibling factories for
// the same module (see tests/beads-edit-gate.test.ts, CORE-2360): bun shares
// mock.module registrations process-wide across test files.
mock.module("@earendil-works/pi-coding-agent", () => ({
  VERSION: "test",
  isBashToolResult: (event: { toolName: string }) => event.toolName === "bash",
  isReadToolResult: (event: { toolName: string }) => event.toolName === "read",
  isToolCallEventType: (toolName: string, event: { toolName: string }) => event?.toolName === toolName,
}));

const { numberReadText } = await import("./index.ts");
const registerExtension = (await import("./index.ts")).default;

type ReadEvent = {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: { path: string; offset?: number; limit?: number };
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError: boolean;
  details?: unknown;
};

function runHandler(event: ReadEvent): unknown {
  const handlers: Array<(event: unknown) => unknown> = [];
  registerExtension({ on: (_name: string, handler: (event: unknown) => unknown) => handlers.push(handler) } as never);
  return handlers[0]?.(event);
}

describe("numberReadText (Pi split('\\n') EOF parity)", () => {
  // -------- basic numbering --------
  test("multi-line input prefixes every line with 1-based numbers", () => {
    expect(numberReadText("foo\nbar\nbaz", 1, false)).toBe("1 | foo\n2 | bar\n3 | baz");
  });

  test("offset 137 numbers from the true source line", () => {
    expect(numberReadText("foo\nbar", 137, false)).toBe("137 | foo\n138 | bar");
  });

  test("single-line content is numbered 1", () => {
    expect(numberReadText("text", 1, false)).toBe("1 | text");
  });

  // -------- Pi EOF model: every split element is addressable --------
  test("empty text has one addressable line (case 1)", () => {
    // Pi: "".split("\n") -> [""]; offset=1 returns "".
    expect(numberReadText("", 1, false)).toBe("1 | ");
  });

  test("file ending in \\n exposes trailing empty as an addressable line (case 2)", () => {
    // "one\n".split("\n") -> ["one",""]; Pi at offset=2 returns "".
    expect(numberReadText("one\n", 1, false)).toBe("1 | one\n2 | ");
  });

  test("two-line file with trailing newline has 3 addressable lines (case 3)", () => {
    // "one\ntwo\n".split("\n") -> ["one","two",""]; Pi at offset=3 returns "".
    // Parity with Specialists citation-evidence.test.ts:103-110 (same fixture).
    expect(numberReadText("one\ntwo\n", 1, false)).toBe("1 | one\n2 | two\n3 | ");
  });

  test("empty text at offset 3 preserves the caller-supplied offset (case 4)", () => {
    // Slice semantics: whatever line-window Pi hands back, we number FROM
    // the offset we were told. Empty payload at offset=3 -> "3 | ".
    expect(numberReadText("", 3, false)).toBe("3 | ");
  });

  test("interior + trailing blank source lines are all numbered (case 5)", () => {
    // "foo\n\n".split("\n") -> ["foo","",""]; all three are addressable.
    expect(numberReadText("foo\n\n", 1, false)).toBe("1 | foo\n2 | \n3 | ");
  });

  // -------- Pi synthetic notices stay verbatim --------
  test("Pi truncation notice + trailing-empty source: source numbered, notice verbatim (case 6)", () => {
    // Source ran ["foo",""] (file "foo\n"), Pi appended "\n\n" + notice.
    // Full payload string: "foo\n\n\n[Showing lines 1-2 of 900. Use offset=3 to continue.]"
    // Split -> ["foo","","", "[...notice...]"]; last-1 == "" is the separator.
    const input = "foo\n\n\n[Showing lines 1-2 of 900. Use offset=3 to continue.]";
    expect(numberReadText(input, 1, true)).toBe(
      "1 | foo\n2 | \n\n[Showing lines 1-2 of 900. Use offset=3 to continue.]",
    );
  });

  test("Pi user-limit notice + trailing-blanks source: all real blanks numbered (case 7)", () => {
    // Source ["foo","",""] then "\n\n" + notice:
    // "foo\n\n\n\n[3 more lines in file. Use offset=4 to continue.]"
    const input = "foo\n\n\n\n[3 more lines in file. Use offset=4 to continue.]";
    expect(numberReadText(input, 1, false)).toBe(
      "1 | foo\n2 | \n3 | \n\n[3 more lines in file. Use offset=4 to continue.]",
    );
  });

  test("Pi truncation notice at offset preserves verbatim tail", () => {
    const input = "foo\nbar\n\n[Showing lines 1-2 of 5000. Use offset=3 to continue.]";
    expect(numberReadText(input, 1, true)).toBe(
      "1 | foo\n2 | bar\n\n[Showing lines 1-2 of 5000. Use offset=3 to continue.]",
    );
  });

  test("first-line-exceeds banner alone is preserved verbatim", () => {
    const input = "[Line 5 is 60KB, exceeds 50KB limit. Use bash: sed -n '5p' /a/b.txt | head -c 51200]";
    expect(numberReadText(input, 1, true)).toBe(input);
  });

  // -------- interior blank regression (case 8) --------
  test("interior blank source line remains numbered (regression)", () => {
    expect(numberReadText("foo\n\nbar", 1, false)).toBe("1 | foo\n2 | \n3 | bar");
  });

  test("mid-file leading blank at offset 137 is numbered (case 11)", () => {
    expect(numberReadText("\nfoo", 137, false)).toBe("137 | \n138 | foo");
  });

  // -------- cross-contract regression (case 12) --------
  test("citation-evidence contract parity: 'one\\ntwo\\n' totalLines=3, offset=3 empty line", () => {
    // Mirrors ~/dev/specialists/tests/unit/specialist/citation-evidence.test.ts:103-110.
    // Both consumers must agree that line 3 exists as "" for this file.
    const lines = "one\ntwo\n".split("\n");
    expect(lines.length).toBe(3);
    expect(lines[2]).toBe("");
    expect(numberReadText("one\ntwo\n", 1, false)).toBe("1 | one\n2 | two\n3 | ");
    // ...and Pi at offset=3 returns "" — which we serialize as "3 | ".
    expect(numberReadText("", 3, false)).toBe("3 | ");
  });

  // -------- separator-collision regression --------
  test("notice separator is not numbered even when preceded by real blank source", () => {
    const input = "foo\n\n\n[Showing lines 1-2 of 900. Use offset=3 to continue.]";
    const output = numberReadText(input, 1, true);
    // Real blank at row 2 numbered, separator NOT numbered as row 3.
    expect(output).toContain("2 | \n\n[");
    expect(output).not.toContain("3 | [");
  });
});

describe("read-line-numbers extension (registered handler)", () => {
  test("registered handler numbers an interior blank line (case 16)", () => {
    const result = runHandler({
      type: "tool_result",
      toolCallId: "call-blank",
      toolName: "read",
      input: { path: "/a/b.txt", offset: 10 },
      content: [{ type: "text", text: "alpha\n\nbeta" }],
      isError: false,
    }) as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toBe("10 | alpha\n11 | \n12 | beta");
  });

  test("registered handler numbers Pi trailing-empty EOF line", () => {
    const result = runHandler({
      type: "tool_result",
      toolCallId: "call-eof",
      toolName: "read",
      input: { path: "/a/b.txt", offset: 1 },
      content: [{ type: "text", text: "one\ntwo\n" }],
      isError: false,
    }) as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toBe("1 | one\n2 | two\n3 | ");
  });

  test("read tool result is numbered using the event offset", () => {
    const result = runHandler({
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "read",
      input: { path: "/a/b.txt", offset: 137 },
      content: [{ type: "text", text: "foo\nbar" }],
      isError: false,
    }) as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toBe("137 | foo\n138 | bar");
  });

  test("read tool result without offset numbers from 1", () => {
    const result = runHandler({
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "read",
      input: { path: "/a/b.txt" },
      content: [{ type: "text", text: "foo" }],
      isError: false,
    }) as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toBe("1 | foo");
  });

  test("non-read tool result passes through untouched", () => {
    const result = runHandler({
      type: "tool_result",
      toolCallId: "call-2",
      toolName: "bash",
      input: { command: "ls" } as never,
      content: [{ type: "text", text: "a.txt\nb.txt" }],
      isError: false,
    });
    expect(result).toBeUndefined();
  });

  test("error result passes through untouched", () => {
    const result = runHandler({
      type: "tool_result",
      toolCallId: "call-3",
      toolName: "read",
      input: { path: "/a/b.txt", offset: 999 },
      content: [{ type: "text", text: "Offset 999 is beyond end of file (5 lines total)" }],
      isError: true,
    });
    expect(result).toBeUndefined();
  });

  test("image processing-failure text note passes through unchanged (case 9)", () => {
    // Pi read.js:174 shape when image processing fails: single text item,
    // no image item attached, starting with "Read image file [<mime>]\n...".
    const result = runHandler({
      type: "tool_result",
      toolCallId: "call-img-fail",
      toolName: "read",
      input: { path: "/a/photo.png" },
      content: [{ type: "text", text: "Read image file [image/png]\nprocessing failed" }],
      isError: false,
    });
    expect(result).toBeUndefined();
  });

  test("successful image result with attached image item passes through (case 10)", () => {
    const result = runHandler({
      type: "tool_result",
      toolCallId: "call-img-ok",
      toolName: "read",
      input: { path: "/a/photo.png" },
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      isError: false,
    });
    // Existing non-text guard fires — pass through, xtrm-ui renders image chip.
    expect(result).toBeUndefined();
  });
});
