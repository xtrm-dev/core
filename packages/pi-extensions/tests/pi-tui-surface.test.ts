import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// CORE-2616: Pi 1.x moved screen construction to the host and keeps the
// concrete TUI classes (TuiMainScreen/TuiAltScreen/TuiBase) behind the `TUI`
// interface. xtrm never instantiates one — it imports the primitives below —
// so that list is the whole contract with pi-tui, and a host-owned class must
// not creep back in.
// ---------------------------------------------------------------------------

const EXTENSIONS_ROOT = join(import.meta.dir, "..");
const SURFACE = ["Box", "MouseRegion", "Text", "matchesKey", "truncateToWidth", "visibleWidth"] as const;
const HOST_OWNED = /TuiMainScreen|TuiAltScreen|TuiBase/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "themes") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

describe("pi-tui surface xtrm depends on (CORE-2616)", () => {
  test("every imported primitive exists in the installed pi-tui", async () => {
    const tui = (await import("@earendil-works/pi-tui")) as Record<string, unknown>;
    expect(SURFACE.filter((name) => typeof tui[name] !== "function")).toEqual([]);
  });

  test("no extension depends on a host-owned TUI class", () => {
    const offenders = sourceFiles(EXTENSIONS_ROOT).filter((file) => HOST_OWNED.test(readFileSync(file, "utf-8")));
    expect(offenders.map((file) => file.slice(EXTENSIONS_ROOT.length + 1))).toEqual([]);
  });
});
