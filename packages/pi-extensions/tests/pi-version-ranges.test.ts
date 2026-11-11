import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// CORE-2616: core supports Pi 1.4.0 (the operator PC) through 1.5.2 (npm
// latest). Every @earendil-works/pi-* declaration must accept both ends, so an
// install on either Pi resolves. A ^0.x range silently excludes every 1.x —
// read-line-numbers carried one until this guard existed.
// ---------------------------------------------------------------------------

const repoRoot = join(import.meta.dir, "..", "..", "..");
const SUPPORTED = ["1.4.0", "1.5.2"];
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function packageJsonFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "experiments") continue;
      packageJsonFiles(path, found);
    } else if (entry === "package.json") {
      found.push(path);
    }
  }
  return found;
}

const declarations = packageJsonFiles(repoRoot).flatMap((file) => {
  const manifest = JSON.parse(readFileSync(file, "utf-8")) as Record<string, Record<string, string> | undefined>;
  return DEPENDENCY_FIELDS.flatMap((field) => {
    const block = manifest[field] ?? {};
    return Object.entries(block)
      .filter(([name]) => name.startsWith("@earendil-works/pi-"))
      .map(([name, range]) => ({ file: file.slice(repoRoot.length + 1), field, name, range }));
  });
});

describe("Pi version declarations (CORE-2616)", () => {
  test("the scope finds the declarations it is meant to guard", () => {
    // An empty or shrunken set would make every assertion below vacuous.
    expect(declarations.length).toBeGreaterThanOrEqual(6);
    expect(declarations.map((entry) => entry.name)).toContain("@earendil-works/pi-coding-agent");
    expect(declarations.map((entry) => entry.name)).toContain("@earendil-works/pi-tui");
  });

  test("every @earendil-works/pi-* range accepts Pi 1.4.0 and 1.5.2", () => {
    const rejected = declarations
      .filter((entry) => SUPPORTED.some((version) => !Bun.semver.satisfies(version, entry.range)))
      .map((entry) => `${entry.file} ${entry.field} ${entry.name}: "${entry.range}" excludes ${SUPPORTED.filter((v) => !Bun.semver.satisfies(v, entry.range)).join(" and ")}`);
    expect(rejected).toEqual([]);
  });

  test("no @earendil-works/pi-* range pins the pre-1.0 major", () => {
    const pinnedToZero = declarations
      .filter((entry) => /^\s*(?:\^|~|=)?\s*0\./.test(entry.range))
      .map((entry) => `${entry.file} ${entry.field} ${entry.name}: "${entry.range}"`);
    expect(pinnedToZero).toEqual([]);
  });
});
