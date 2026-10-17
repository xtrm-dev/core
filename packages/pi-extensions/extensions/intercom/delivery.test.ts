import { describe, expect, test } from "bun:test";

import {
  buildIntercomWakeContent,
  MAX_WAKE_CONTENT_BYTES,
  PROVENANCE_LINE,
} from "./delivery.ts";

describe("intercom envelope content (CORE-2437 I6 F1)", () => {
  test("sender newlines and tabs survive the envelope; the end marker arrives", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}\tvalue ${i}`);
    const attachment = `---\nAttachment: notes.txt\n${lines.join("\n")}\n--- end of attachment ---`;
    const content = buildIntercomWakeContent("m-1", `review this\n\n${attachment}`, { from: "coordinator" });
    expect(content).toContain("line 0\tvalue 0");
    expect(content).toContain("line 199\tvalue 199");
    expect(content).toContain("--- end of attachment ---");
    expect(content).toContain('from="coordinator"');
    expect(content).toContain(PROVENANCE_LINE);
    expect(content).toContain("</cross-session-message>");
  });

  test("ANSI and control characters strip, except newline and tab", () => {
    const content = buildIntercomWakeContent("m-2", "a\x1b[31mred\x1b[0m\x00b\x07c\td\ne", {});
    expect(content).not.toMatch(/\u001b/);
    expect(content).not.toContain("\x00");
    expect(content).not.toContain("\x07");
    expect(content).toContain("aredb");
    expect(content).toContain("\td\ne");
  });

  test("an oversize payload truncates with an explicit notice, never silently", () => {
    const big = `${"x".repeat(1024)}\n`.repeat(600);
    const content = buildIntercomWakeContent("m-3", big, {});
    expect(content).toMatch(/\[truncated: showing the first \d+ KiB of \d+ KiB\]/);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_WAKE_CONTENT_BYTES + 2048);
  });
});
