/**
 * CORE-2546: suggestion cards on the event grid. Folded to one row, opened
 * below a └ anchor, every line within the render width, the accent on the
 * marker only, and nothing but plain text for the model.
 */

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatSuggestionCardPlain, formatSuggestionEventCard } from "../shared/event.ts";
import {
  formatSuggestionPlain,
  parseContextBlock,
  resolveSuggestionMessage,
  suggestionCardFields,
  tintSuggestionGlyph,
  type VerbSpec,
} from "../shared/suggest.ts";

const steerCard = {
  identity: "provenance unread",
  summary: "4 files changed without reading their history",
  reason: "Behavior changed without consulting why the code was the way it was.",
  body: [
    "xtrm-dark.json             last bded0224 2026-10-26 feat(pi): one-line tool rows",
    "xtrm-light.json            last bded0224 2026-10-26 feat(pi): one-line tool rows",
    "+12 -8  ·  next: git log -p --follow -- …/xtrm-dark.json",
  ],
  tint: "substrate" as const,
};

const waitVerb: VerbSpec = {
  id: "wait_guard" as VerbSpec["id"],
  action: "wait without a monitor",
  oneLine: "Nothing is watching the event you wait for.",
  instruction: () => "Start a monitor (Monitor, or BashBackground for shell work) or journal a blocker.",
  severity: "normal",
  cooldownMin: 30,
  source: "jev",
};

describe("suggestion card layout", () => {
  test("folds to one row: hollow marker, action, summary, hidden-line count", () => {
    const details = resolveSuggestionMessage({ details: { card: steerCard } })!;
    expect(formatSuggestionCardPlain(details, 100)).toBe(
      "○ provenance unread 4 files changed without reading their history  +4 lines",
    );
  });

  test("opens with the reason, then the body under a └ anchor", () => {
    const details = resolveSuggestionMessage({ details: { card: steerCard } })!;
    expect(formatSuggestionCardPlain(details, 100, { expanded: true }).split("\n")).toEqual([
      "○ provenance unread 4 files changed without reading their history",
      "  Behavior changed without consulting why the code was the way it was.",
      "  └ xtrm-dark.json             last bded0224 2026-10-26 feat(pi): one-line tool rows",
      "    xtrm-light.json            last bded0224 2026-10-26 feat(pi): one-line tool rows",
      "    +12 -8  ·  next: git log -p --follow -- …/xtrm-dark.json",
    ]);
  });

  test("every line fits a narrow width, and a long path is split, never left to orphan a word", () => {
    const path = "/home/dawid/projects/mercury/market-data/.xtrm/worktrees/market-data-xt-pi-ISSUE-214-r2-watcher/.xtrm/skills/market-data/service-knowledge/services/ingesting-ohlcv/SKILL.md";
    const details = resolveSuggestionMessage({
      details: { card: { identity: "consider skill · ingesting-ohlcv", summary: "the OHLCV Ingestor service is in play", body: [`Open its expert skill at ${path} before going deeper`], facts: "jev 0.82", tint: "skill" } },
    })!;
    for (const width of [40, 60, 100]) {
      for (const expanded of [false, true]) {
        const lines = formatSuggestionCardPlain(details, width, { expanded }).split("\n");
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        if (expanded) expect(lines.some((line) => line.trim() === "at")).toBe(false);
      }
    }
    // The facts and the count survive a cut: the head gives way first. The
    // count is the opened card's line total at this width.
    expect(formatSuggestionCardPlain(details, 50)).toMatch(/jev 0\.82  \+\d+ lines$/);
  });

  test("themed card: tool-row tokens, tint on the marker only, failures keep !", () => {
    const theme = { fg: (t: string, s: string) => `[${t}]${s}`, bold: (s: string) => `*${s}*`, italic: (s: string) => `_${s}_` };
    const details = resolveSuggestionMessage({ details: { card: steerCard } })!;
    const lines = formatSuggestionEventCard(details, theme, 120, {
      expanded: true,
      tintGlyph: (glyph) => `<tint>${glyph}`,
    }).split("\n");
    expect(lines[0]).toBe("<tint>○ *[toolTitle]provenance unread* [toolTitle]4 files changed without reading their history");
    expect(lines[1]).toBe("  _[thinkingText]Behavior changed without consulting why the code was the way it was._");
    expect(lines[2]).toStartWith("  [dim]└ [toolOutput]xtrm-dark.json");
    const high = resolveSuggestionMessage({ details: { card: { ...steerCard, severityHigh: true } } })!;
    expect(formatSuggestionEventCard(high, theme, 120, { tintGlyph: (g) => `<tint>${g}` })).toStartWith("[error]! ");
  });
});

describe("marker tint", () => {
  const theme = (mode?: string) => ({ fg: (t: string, s: string) => `[${t}]${s}`, ...(mode ? { getColorMode: () => mode } : {}) });

  test("truecolor uses the CORE-2348 accent, 256-colour its nearest cube entry, otherwise the theme accent", () => {
    expect(tintSuggestionGlyph("○", "substrate", theme("truecolor"))).toBe("\x1b[38;2;255;112;52m○\x1b[39m");
    expect(tintSuggestionGlyph("○", "skill", theme("truecolor"))).toBe("\x1b[38;2;0;103;188m○\x1b[39m");
    // xterm cube levels 0/95/135/175/215/255: #FF7034 → (255, 95, 95) = 203, #0067BC → (0, 95, 175) = 25.
    expect(tintSuggestionGlyph("○", "substrate", theme("256color"))).toBe("\x1b[38;5;203m○\x1b[39m");
    expect(tintSuggestionGlyph("○", "skill", theme("256color"))).toBe("\x1b[38;5;25m○\x1b[39m");
    expect(tintSuggestionGlyph("○", "skill", theme())).toBe("[accent]○");
    expect(tintSuggestionGlyph("○", undefined, theme("truecolor"))).toBe("[dim]○");
  });
});

describe("model-visible content stays plain", () => {
  test("a verb card's text for the model carries no escape", () => {
    expect(formatSuggestionPlain({ verb: waitVerb, ref: "—", confidence: 0.39 })).not.toContain("\x1b");
  });

  test("card fields fold the verb: action, lower-case summary, instruction body, facts", () => {
    expect(suggestionCardFields({ verb: waitVerb, ref: "—", confidence: 0.39 })).toEqual({
      identity: "wait without a monitor",
      summary: "nothing is watching the event you wait for",
      body: ["Start a monitor (Monitor, or BashBackground for shell work) or journal a blocker"],
      facts: "jev 0.39",
      tint: "substrate",
    });
  });

  test("a skill block's description line is plain, and older italic blocks still parse", () => {
    const plain = '<xtrm_context kind="skill-doctrine" source="x" confidence="0.5">\nInjected context, not the operator\'s words:\nlead\nDescription: Governed role lifecycles\n</xtrm_context>';
    expect(parseContextBlock(plain)?.body).toBe("Governed role lifecycles");
    const legacy = plain.replace("Description: Governed role lifecycles", "\x1b[3mGoverned role lifecycles\x1b[23m");
    expect(parseContextBlock(legacy)?.body).toBe("Governed role lifecycles");
  });
});

describe("sessions from before CORE-2546", () => {
  test("an old ANSI card reads as its header plus body", () => {
    const old = "\x1b[1m●\x1b[22m \x1b[48;2;255;112;52m\x1b[38;2;24;20;16m\x1b[1mwait without a monitor\x1b[22m\x1b[49m\x1b[39m\n  \x1b[3mYou committed to wait\x1b[23m";
    const details = resolveSuggestionMessage({ content: old })!;
    expect(details).toMatchObject({ kind: "suggestion", identity: "wait without a monitor", preview: ["You committed to wait"] });
  });

  test("old raw provenance evidence takes its name from the stored verb", () => {
    const details = resolveSuggestionMessage({
      content: "a.json | 5 +++--\n 1 file changed\nHistory that may matter: git log",
      details: { verb: "provenance_unread" },
    })!;
    expect(details.identity).toBe("provenance unread");
    expect(details.preview).toEqual(["a.json | 5 +++--", "1 file changed", "History that may matter: git log"]);
  });
});
