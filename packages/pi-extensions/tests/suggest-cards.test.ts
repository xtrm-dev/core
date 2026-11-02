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
  suggestionFacts,
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
  test("folds to one row: hollow marker, bold verb, action, summary, hidden-line count", () => {
    const details = resolveSuggestionMessage({ details: { card: steerCard } })!;
    expect(formatSuggestionCardPlain(details, 100)).toBe(
      "○ Suggested provenance unread  4 files changed without reading their history  +4 lines",
    );
  });

  test("opens with the reason, then the body under a └ anchor", () => {
    const details = resolveSuggestionMessage({ details: { card: steerCard } })!;
    expect(formatSuggestionCardPlain(details, 100, { expanded: true }).split("\n")).toEqual([
      "○ Suggested provenance unread  4 files changed without reading their history",
      "  Behavior changed without consulting why the code was the way it was.",
      "  └ xtrm-dark.json             last bded0224 2026-10-26 feat(pi): one-line tool rows",
      "    xtrm-light.json            last bded0224 2026-10-26 feat(pi): one-line tool rows",
      "    +12 -8  ·  next: git log -p --follow -- …/xtrm-dark.json",
    ]);
  });

  test("every line fits a narrow width, and a long path is split, never left to orphan a word", () => {
    const path = "/home/dawid/projects/mercury/market-data/.xtrm/worktrees/market-data-xt-pi-ISSUE-214-r2-watcher/.xtrm/skills/market-data/service-knowledge/services/ingesting-ohlcv/SKILL.md";
    const details = resolveSuggestionMessage({
      details: { card: { identity: "consider skill · ingesting-ohlcv", summary: "the OHLCV Ingestor service is in play", body: [`Open its expert skill at ${path} before going deeper`], facts: "score 0.82", tint: "skill" } },
    })!;
    for (const width of [40, 60, 100]) {
      // Folded rows clip, so every line fits.
      const folded = formatSuggestionCardPlain(details, width, { expanded: false }).split("\n");
      for (const line of folded) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      // Expanded rows do not clip the summary; the body still wraps cleanly.
      const expanded = formatSuggestionCardPlain(details, width, { expanded: true }).split("\n");
      expect(expanded.some((line) => line.trim() === "at")).toBe(false);
    }
    // The facts and the count survive a cut: the head gives way first. The
    // count is the opened card's line total at this width.
    expect(formatSuggestionCardPlain(details, 50)).toMatch(/score 0\.82  \+\d+ lines$/);
  });

  test("themed card: tool-row tokens, tint on the marker only, failures keep !", () => {
    const theme = { fg: (t: string, s: string) => `[${t}]${s}`, bold: (s: string) => `*${s}*`, italic: (s: string) => `_${s}_` };
    const details = resolveSuggestionMessage({ details: { card: steerCard } })!;
    const lines = formatSuggestionEventCard(details, theme, 120, {
      expanded: true,
      tintGlyph: (glyph) => `<tint>${glyph}`,
    }).split("\n");
    expect(lines[0]).toBe("<tint>○ *[toolTitle]Suggested* [toolTitle]provenance unread  [toolTitle]4 files changed without reading their history");
    expect(lines[1]).toBe("  _[thinkingText]Behavior changed without consulting why the code was the way it was._");
    expect(lines[2]).toStartWith("  [dim]└ [toolOutput]xtrm-dark.json");
    // High severity no longer sets the failure marker: only an error state does.
    const high = resolveSuggestionMessage({ details: { card: { ...steerCard, severityHigh: true } } })!;
    expect(formatSuggestionEventCard(high, theme, 120, { tintGlyph: (g) => `<tint>${g}` })).toStartWith("<tint>○ ");
  });
});

describe("marker tint", () => {
  const theme = (mode?: string) => ({ fg: (t: string, s: string) => `[${t}]${s}`, ...(mode ? { getColorMode: () => mode } : {}) });

  test("markers use theme tokens only: no 24-bit or 256-colour SGR on chrome", () => {
    for (const mode of ["truecolor", "256color", undefined]) {
      const glyph = tintSuggestionGlyph("○", "substrate", theme(mode));
      expect(glyph).toBe("[accent]○");
      expect(glyph).not.toContain("\x1b[");
      expect(tintSuggestionGlyph("○", "skill", theme(mode))).toBe("[accent]○");
      expect(tintSuggestionGlyph("○", undefined, theme(mode))).toBe("[dim]○");
    }
  });
});

describe("skill-suggest row wording (CORE-2576)", () => {
  test("the number reads score, never jev", () => {
    expect(suggestionFacts(0.71)).toBe("score 0.71");
    expect(suggestionFacts(0.71, 3)).toBe("score 0.71 · rev 3");
    expect(suggestionFacts(null)).toBeUndefined();
  });

  test("a skill folds to ○ Suggested <name>  <description…>  score 0.71, unclipped when opened", () => {
    const description =
      "Use Specialists as a governed XTRM execution backend for tracked implementation, debugging, review, testing and documentation.";
    const details = resolveSuggestionMessage({
      details: { card: { identity: "using-specialists", summary: description, facts: suggestionFacts(0.71), tint: "skill" } },
    })!;
    const folded = formatSuggestionCardPlain(details, 80);
    expect(folded.startsWith("○ Suggested using-specialists  Use Specialists as a governed")).toBe(true);
    expect(folded).toContain("score 0.71");
    expect(folded.endsWith("…  score 0.71")).toBe(true);
    expect(formatSuggestionCardPlain(details, 80, { expanded: true }).split("\n")[0]).toBe(
      `○ Suggested using-specialists  ${description}  score 0.71`,
    );
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
      facts: "score 0.39",
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
