import { describe, expect, test } from "bun:test";

import { boldSgr, rgbSgr, weightHex, weightText, type UiWeight } from "./weight.ts";

const tag = { fg: (token: string, text: string) => `<${token}>${text}</>` };

describe("weight ladder (SPEC v1 rule 15)", () => {
  test("boldSgr emits real SGR, independent of any theme", () => {
    expect(boldSgr("x")).toBe("\u001b[1mx\u001b[22m");
  });

  test("heavy is the only tier that bolds, and it never consults theme.bold", () => {
    const heavy = weightText(tag, "heavy", "explorer");
    const semi = weightText(tag, "semi", "explorer");
    const soft = weightText(tag, "soft", "explorer");
    expect(heavy).toContain("\u001b[1m");
    expect(semi).not.toContain("\u001b[1m");
    expect(soft).not.toContain("\u001b[1m");
    // Tiers come from the colour tokens, so the same code renders in light
    // and dark without hardcoded hexes.
    expect(heavy).toContain("<muted>");
    expect(semi).toBe("<muted>explorer</>");
    expect(soft).toBe("<dim>explorer</>");
  });

  test("one row cannot ask for two heavies by accident: tiers are explicit values", () => {
    const tiers: UiWeight[] = ["heavy", "semi", "soft"];
    expect(tiers.map((tier) => weightText(tag, tier, "x"))).toHaveLength(3);
  });

  test("the hex ladder matches the theme ladder tier for tier", () => {
    const palette = { muted: "#a7a7a7", dim: "#8a8a8a" };
    expect(weightHex(palette, "heavy", "x")).toBe(`\u001b[1m\u001b[38;2;167;167;167mx\u001b[39m\u001b[22m`);
    expect(weightHex(palette, "semi", "x")).toBe(`\u001b[38;2;167;167;167mx\u001b[39m`);
    // soft reproduces the theme's dim token: colour wrapped in SGR 2.
    expect(weightHex(palette, "soft", "x")).toBe(`\u001b[2m\u001b[38;2;138;138;138mx\u001b[39m\u001b[22m`);
    expect(weightHex(palette, "soft", "x")).not.toContain("\u001b[1m");
  });

  test("rgbSgr parses a #rrggbb literal without chalk", () => {
    expect(rgbSgr("#5f5f5f", "x")).toBe("\u001b[38;2;95;95;95mx\u001b[39m");
    expect(rgbSgr("ff9a9a", "x")).toBe("\u001b[38;2;255;154;154mx\u001b[39m");
  });
});
