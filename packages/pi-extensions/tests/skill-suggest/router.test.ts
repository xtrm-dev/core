import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isServiceEntry, readPathOf, routerSections, samePath, watchRead } from "../../extensions/skill-suggest/index.ts";

describe("router payload (CORE-2367)", () => {
  it("carries section headings and no prose", () => {
    const md = ["# Title", "", "Some prose that must not be quoted.", "", "## Diagnose", "more prose", "## Fix", "## Verify", "### Deep"].join("\n");
    const sections = routerSections(md);
    // The H1 document title is not a section a reader looks in.
    expect(sections).toEqual(["Diagnose", "Fix", "Verify", "Deep"]);
    expect(sections.join(" ")).not.toContain("prose");
  });

  it("bounds the section list", () => {
    const md = Array.from({ length: 50 }, (_, i) => `## S${i}`).join("\n");
    expect(routerSections(md, 5)).toHaveLength(5);
  });
});

describe("service entries name the CLI route", () => {
  it("detects a registry-backed entry", () => {
    expect(isServiceEntry({ id: "service-knowledge/services/api/references/deploy", skill: "service-knowledge" })).toBe(true);
    expect(isServiceEntry({ id: "engineering-quality/causal-debugging", skill: "engineering-quality" })).toBe(false);
  });
});

describe("read-after-suggest (CORE-2367)", () => {
  const watch = { id: "x", path: "/tmp/a/SKILL.md", turnsLeft: 2 };

  it("counts a path-identical read as the suggestion landing", () => {
    const r = watchRead(watch, "/tmp/a/SKILL.md", false);
    expect(r.read).toBe(true);
    expect(r.watch).toBeNull();
  });

  it("ignores a read of any other file", () => {
    const r = watchRead(watch, "/tmp/b/other.md", false);
    expect(r.read).toBe(false);
    expect(r.watch).not.toBeNull();
  });

  it("expires unread at the end of the window, one turn at a time", () => {
    // A boundary decrements; a mid-turn call does not.
    expect(watchRead(watch, null, false).watch?.turnsLeft).toBe(2);
    const afterFirst = watchRead(watch, null, true);
    expect(afterFirst.expired).toBe(false);
    expect(afterFirst.watch?.turnsLeft).toBe(1);
    const afterSecond = watchRead(afterFirst.watch, null, true);
    expect(afterSecond.expired).toBe(true);
    expect(afterSecond.watch).toBeNull();
  });

  it("tolerates relative and absolute forms of the same path", () => {
    const root = mkdtempSync(join(tmpdir(), "sk-path-"));
    try {
      const f = join(root, "SKILL.md");
      writeFileSync(f, "# x");
      expect(samePath(f, f)).toBe(true);
      expect(samePath("./SKILL.md", "SKILL.md")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only counts read-shaped tools", () => {
    expect(readPathOf("read", { path: "/x" })).toBe("/x");
    expect(readPathOf("bash", { command: "cat /x" })).toBeNull();
    expect(readPathOf("read", {})).toBeNull();
  });
});
