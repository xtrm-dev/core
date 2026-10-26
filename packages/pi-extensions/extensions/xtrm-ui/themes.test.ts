import { describe, expect, test } from "bun:test";

import dark from "../../themes/xtrm-ui/xtrm-dark.json";
import darkFlat from "../../themes/xtrm-ui/xtrm-dark-flattools.json";
import light from "../../themes/xtrm-ui/xtrm-light.json";
import lightFlat from "../../themes/xtrm-ui/xtrm-light-flattools.json";

/**
 * Theme contract for the monochrome hierarchy (design contract §2).
 *
 * The chrome is a pure grayscale ladder: equal RGB channels, ordered by
 * luminance, with content (inline code, links, diffs) keeping its hue. These
 * assertions catch a hand-edited palette that silently turns chrome into a hue
 * or inverts the hierarchy.
 */

type Theme = {
  name: string;
  appearance?: string;
  vars: Record<string, string>;
  colors: Record<string, string | number>;
  export?: Record<string, string>;
};

const THEMES: Theme[] = [dark, light, darkFlat, lightFlat] as Theme[];

const REQUIRED = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
  "muted", "dim", "text", "thinkingText", "selectedBg", "userMessageBg",
  "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel",
  "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder",
  "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffAdded",
  "toolDiffRemoved", "toolDiffContext", "thinkingOff", "thinkingMinimal",
  "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
];

/** Chrome tokens: the interface ramp, which must stay on the gray axis. */
const CHROME = [
  "text", "muted", "dim", "accent", "border", "borderAccent", "borderMuted",
  "success", "error", "warning", "thinkingText", "toolTitle", "toolOutput",
  "mdHeading", "mdLinkUrl", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote",
  "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffContext", "thinkingOff",
  "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
  "thinkingXhigh", "bashMode", "customMessageLabel", "scrollbarTrack",
  "scrollbarThumb",
];

/** Resolve a color token through chained `vars` references. */
function resolve(theme: Theme, token: string): string {
  return resolveValue(theme, theme.colors[token], token);
}

function resolveValue(theme: Theme, value: string | number | undefined, token: string): string {
  if (value === undefined) throw new Error(`${theme.name}: missing ${token}`);
  if (value === "") return theme.appearance === "light" ? "#FFFFFF" : "#000000";
  if (typeof value === "number") throw new Error(`${theme.name}.${token} is a palette index`);
  if (value.startsWith("#")) return value;
  const next = theme.vars[value];
  if (next === undefined) throw new Error(`${theme.name}.${token} references undefined var ${value}`);
  return resolveValue(theme, next, token);
}

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(first: string, second: string): number {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe("shipped XTRM themes", () => {
  test("declare the documented contract tokens", () => {
    for (const theme of THEMES) {
      for (const token of REQUIRED) expect(theme.colors[token], `${theme.name}.${token}`).toBeDefined();
      expect(theme.appearance, `${theme.name}.appearance`).toMatch(/^(dark|light)$/);
      // Variable references resolve (chained references included).
      for (const token of REQUIRED) expect(resolve(theme, token)).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  test("chrome stays on the gray axis; content keeps its hue", () => {
    for (const theme of THEMES) {
      for (const token of CHROME) {
        if (theme.colors[token] === undefined) continue;
        const [r, g, b] = channels(resolve(theme, token));
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${theme.name}.${token} must be gray`).toBe(0);
      }
      for (const token of ["mdCode", "mdLink"]) {
        const [r, g, b] = channels(resolve(theme, token));
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${theme.name}.${token} keeps a hue`).toBeGreaterThan(24);
      }
      expect(resolve(theme, "mdCode")).not.toBe(resolve(theme, "mdLink"));
      expect(resolve(theme, "toolDiffAdded")).not.toBe(resolve(theme, "toolDiffRemoved"));
    }
  });

  test("the hierarchy is ordered by luminance, not inverted", () => {
    for (const theme of THEMES) {
      const ramp = ["text", "toolTitle", "muted", "thinkingText", "dim", "border"].map((token) => luminance(resolve(theme, token)));
      // Dark themes descend from primary to border; light themes ascend
      // because "brighter" means more contrast against a light background.
      const lightTheme = theme.appearance === "light";
      for (let index = 1; index < ramp.length; index += 1) {
        if (lightTheme) expect(ramp[index]!, `${theme.name} ramp ${index}`).toBeGreaterThan(ramp[index - 1]!);
        else expect(ramp[index]!, `${theme.name} ramp ${index}`).toBeLessThan(ramp[index - 1]!);
      }
    }
  });

  test("text, secondary and thinking levels stay legible on every surface", () => {
    for (const theme of THEMES) {
      const surfaces = ["userMessageBg", "customMessageBg", "selectedBg"].map((token) => resolve(theme, token));
      for (const surface of surfaces) {
        expect(contrast(resolve(theme, "text"), surface), `${theme.name} text on ${surface}`).toBeGreaterThanOrEqual(7);
        expect(contrast(resolve(theme, "muted"), surface), `${theme.name} secondary on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(resolve(theme, "thinkingText"), surface), `${theme.name} thinking on ${surface}`).toBeGreaterThanOrEqual(4.3);
      }
    }
  });

  test("errors are the brightest grayscale, never a hue", () => {
    for (const theme of THEMES) {
      const error = resolve(theme, "error");
      expect(error).toBe(resolve(theme, "text"));
      const [r, g, b] = channels(error);
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
  });

  test("the flat variants differ only in the tool-row backgrounds", () => {
    const pairs: Array<[Theme, Theme]> = [[dark, darkFlat], [light, lightFlat]];
    for (const [base, flat] of pairs) {
      expect(flat.name).toBe(`${base.name}-flattools`);
      expect({ ...flat.colors, toolPendingBg: "", toolSuccessBg: "", toolErrorBg: "" })
        .toEqual({ ...base.colors, toolPendingBg: "", toolSuccessBg: "", toolErrorBg: "" });
      expect(flat.colors.toolPendingBg).toBe("");
      expect(flat.colors.toolSuccessBg).toBe("");
      expect(flat.colors.toolErrorBg).toBe("");
      expect(base.colors.toolPendingBg).toBe(base.colors.toolSuccessBg);
      expect(base.colors.toolSuccessBg).toBe(base.colors.toolErrorBg);
    }
  });

  test("$schema points at pi's published schema", () => {
    for (const theme of THEMES) {
      expect((theme as unknown as { $schema?: string }).$schema).toBe("https://pi.dev/schemas/theme.schema.json");
    }
  });
});
