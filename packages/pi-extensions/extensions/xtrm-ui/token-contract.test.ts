import { describe, expect, test } from "bun:test";
import {
  collapsedThinkingStyle,
  expandedThinkingStyle,
  renderUltraRow,
  styledText,
  workingFrames,
} from "./index.ts";
import { renderRichDiffPreview, renderToolSummary } from "./format.ts";
import { REQUIRED } from "./themes.test.ts";

/**
 * Token contract (CORE follow-up to the borderFaint change): the extension
 * styles everything through Pi's live Theme by token name, so every token
 * the renderers ask for must be a documented contract token. A recording
 * stub drives the pure renderers and logs each read; the test asserts the
 * recorded set is a subset of REQUIRED. An `undefined` read is intentional —
 * terminal-default foreground — and is allowed.
 */
function recordingTheme() {
  const tokens: Array<string | undefined> = [];
  const theme = {
    fg: (color: string, text: string) => {
      tokens.push(color);
      return text;
    },
    bold: (text: string) => text,
    italic: (text: string) => text,
  };
  return { theme, tokens };
}

describe("extension reads only documented theme tokens", () => {
  test("recorded tokens are a subset of REQUIRED", () => {
    const { theme, tokens } = recordingTheme();

    const collapsed = collapsedThinkingStyle(() => theme);
    collapsed.label("label");
    collapsed.recap("recap");
    const expanded = expandedThinkingStyle(() => theme);
    expanded.label("label");
    expanded.recap("recap");

    workingFrames(theme);

    renderRichDiffPreview(theme, "@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n", 10);

    for (const status of ["pending", "success", "error", "muted"] as const) {
      renderToolSummary(theme, status, "label", "subject", "meta");
    }

    renderUltraRow(theme, {
      statusColor: "success",
      verb: "ran",
      subject: "subject",
      primary: "primary",
      secondary: "secondary",
    });
    renderUltraRow(theme, { statusColor: "error", verb: "failed", subject: "subject" });

    // Intentional terminal-default read: must not fail the contract.
    styledText(theme, undefined, "XTRM");

    expect(tokens.length).toBeGreaterThan(0);
    for (const token of new Set(tokens)) {
      if (token === undefined) continue;
      expect(REQUIRED, `token ${token} must be a documented contract token`).toContain(token);
    }
  });
});
