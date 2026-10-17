import { describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import manifest from "../src/manifest.json" with { type: "json" };
// Complete mock: spread the real pi-tui so neighbouring suites sharing the
// module registry under full-suite runs keep working exports (matchesKey).
import * as realPiTui from "../../../node_modules/@earendil-works/pi-tui/dist/index.js";

mock.module("@earendil-works/pi-ai", () => ({ complete: async () => ({}) }));
mock.module("@earendil-works/pi-coding-agent", () => ({
  BorderedLoader: class {},
  CustomEditor: class {},
  VERSION: "test",
  createBashTool: () => ({}),
  createEditTool: () => ({}),
  createFindTool: () => ({}),
  createGrepTool: () => ({}),
  createLsTool: () => ({}),
  createReadTool: () => ({}),
  createWriteTool: () => ({}),
  isBashToolResult: () => false,
  isReadToolResult: (event: { toolName: string }) => event.toolName === "read",
  isToolCallEventType: () => false,
}));
mock.module("@earendil-works/pi-tui", () => ({
  ...(realPiTui as object),
  Box: class {},
  Text: class {},
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));
mock.module("@mariozechner/pi-coding-agent", () => ({}));

const repoRoot = join(import.meta.dir, "../../..");
const extensionsRoot = join(repoRoot, "packages/pi-extensions/extensions");

function activeIds(): string[] {
  return manifest.active.map((extension) => extension.id);
}

describe("Pi extension ownership parity", () => {
  test("package registry and global inventory use the same active IDs", async () => {
    const [{ managedPiExtensions }, { inventoryPiRuntime, resolveManagedPiExtensionsSourceDir }] = await Promise.all([
      import("../src/registry.ts"),
      import("../../../cli/src/core/pi-runtime.ts"),
    ]);
    const packageIds = managedPiExtensions.map((extension) => extension.id);
    const sourceDir = resolveManagedPiExtensionsSourceDir(repoRoot);
    if (!sourceDir) throw new Error("Managed Pi extension source is missing");

    // inventoryPiRuntime also spawns `pi list`; a host Pi makes this test slow and
    // machine-dependent, so a failing stub keeps it hermetic (CORE-2371).
    const stubDir = mkdtempSync(join(tmpdir(), "pi-stub-"));
    writeFileSync(join(stubDir, "pi"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(stubDir, "pi"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${stubDir}${delimiter}${savedPath ?? ""}`;
    let globalPlan;
    try {
      globalPlan = await inventoryPiRuntime(sourceDir, sourceDir);
    } finally {
      process.env.PATH = savedPath;
      rmSync(stubDir, { recursive: true, force: true });
    }

    expect(packageIds).toEqual(activeIds());
    expect(globalPlan.extensions.map((status) => status.ext.id)).toEqual(activeIds());
  });

  test("active entries have source directories and disabled entries have reasons", () => {
    for (const extension of manifest.active) {
      expect(existsSync(join(extensionsRoot, extension.id, "package.json"))).toBe(true);
    }

    for (const [id, reason] of Object.entries(manifest.disabled)) {
      expect(reason.length, `missing disabled reason for ${id}`).toBeGreaterThan(0);
    }
  });

  test("read-line-numbers is enrolled as a required active extension", () => {
    const entry = manifest.active.find((extension) => extension.id === "read-line-numbers");
    expect(entry).toBeDefined();
    expect(entry?.required).toBe(true);
  });
});
