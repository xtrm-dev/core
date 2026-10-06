import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const retiredAutoUpdatePaths = [
  "packages/pi-extensions/extensions/auto-update",
  "packages/pi-extensions/src/extensions/auto-update.ts",
  ".xtrm/packages/pi-extensions/extensions/auto-update",
  ".xtrm/packages/pi-extensions/src/extensions/auto-update.ts",
  ".xtrm/ext-src/auto-update",
];

const retiredExtensionIds = [
  "auto-session-name",
  "custom-provider-qwen-cli",
  "lsp-bootstrap",
  "pi-serena-compact",
  "serena-pool",
];

describe("retired Pi extensions", () => {
  test("auto-update is absent from shipped sources and runtime inventories", () => {
    for (const relativePath of retiredAutoUpdatePaths) {
      expect(existsSync(join(repoRoot, relativePath))).toBe(false);
    }

    for (const relativePath of [
      "packages/pi-extensions/src/shared/legacy-path-map.ts",
      "packages/pi-extensions/MIGRATION_NOTES.md",
      "packages/pi-extensions/extensions/xtprompt/index.test.ts",
      "cli/src/core/pi-runtime.ts",
    ]) {
      expect(readFileSync(join(repoRoot, relativePath), "utf8")).not.toContain("auto-update");
    }
  });

  test("retired extension ids are absent from shipped sources and runtime inventories", () => {
    for (const id of retiredExtensionIds) {
      for (const relativePath of [
        `packages/pi-extensions/extensions/${id}`,
        `packages/pi-extensions/src/extensions/${id}.ts`,
        `.xtrm/packages/pi-extensions/extensions/${id}`,
        `.xtrm/packages/pi-extensions/src/extensions/${id}.ts`,
        `.xtrm/ext-src/${id}`,
      ]) {
        expect(existsSync(join(repoRoot, relativePath)), `${relativePath} should be absent`).toBe(false);
      }
    }

    for (const relativePath of [
      "packages/pi-extensions/src/shared/legacy-path-map.ts",
      "packages/pi-extensions/extensions/xtprompt/index.test.ts",
      "cli/src/core/plugin-era-cleanup.ts",
      "cli/src/core/pi-runtime.ts",
    ]) {
      const content = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const id of retiredExtensionIds) {
        expect(content, `${relativePath} should not contain ${id}`).not.toContain(id);
      }
    }

    // CORE-2372: no retired Beads gate may be reachable from a shipped
    // extension source, a policy declaration, or the Pi extension shim tree.
    for (const relativePath of [
      "packages/pi-extensions/src/registry.ts",
      "packages/pi-extensions/src/core/adapter.ts",
      "packages/pi-extensions/src/shared/legacy-path-map.ts",
      "packages/pi-extensions/extensions/xtprompt/index.test.ts",
      ".xtrm/packages/pi-extensions/src/registry.ts",
      ".xtrm/packages/pi-extensions/src/shared/legacy-path-map.ts",
    ]) {
      const content = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const token of ["beads", "session-flow", "isBeadsProject", "parseBdCounts"]) {
        expect(content, `${relativePath} should not contain ${token}`).not.toContain(token);
      }
    }

    for (const relativePath of [
      "packages/pi-extensions/extensions/beads",
      "packages/pi-extensions/extensions/session-flow",
      "packages/pi-extensions/src/extensions/beads.ts",
      "packages/pi-extensions/src/extensions/session-flow.ts",
      ".xtrm/ext-src/beads",
      ".xtrm/ext-src/session-flow",
      ".xtrm/packages/pi-extensions/extensions/beads",
      ".xtrm/packages/pi-extensions/extensions/session-flow",
      ".xtrm/packages/pi-extensions/src/extensions/beads.ts",
      ".xtrm/packages/pi-extensions/src/extensions/session-flow.ts",
      "policies/beads.json",
      "policies/session-flow.json",
    ]) {
      expect(existsSync(join(repoRoot, relativePath)), `${relativePath} should be absent`).toBe(false);
    }

    // The manifest names retired ids in its `disabled` block WITH the
    // retirement reason — that is documentation, not enrollment. The scan
    // checks the structured contract: no retired id may sit in `active`.
    const manifest = JSON.parse(readFileSync(join(repoRoot, "packages/pi-extensions/src/manifest.json"), "utf8"));
    const activeIds = (manifest.active ?? []).map((entry: { id: string }) => entry.id);
    for (const id of retiredExtensionIds) {
      expect(activeIds, `retired id ${id} must not be enrolled in active`).not.toContain(id);
    }
    for (const id of ["beads", "session-flow"]) {
      expect(activeIds, `retired id ${id} must not be enrolled in active`).not.toContain(id);
      expect(manifest.disabled?.[id], `retired id ${id} needs a tombstone reason`).toBeTruthy();
    }
  });

  test("no shipped extension source authorizes edits or commits on Beads claim state", () => {
    const extensionsRoot = join(repoRoot, "packages/pi-extensions/extensions");
    const sources = readdirSync(extensionsRoot, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"));

    expect(sources.length).toBeGreaterThan(0);
    for (const entry of sources) {
      const relativePath = join("packages/pi-extensions/extensions", entry);
      const content = readFileSync(join(repoRoot, relativePath), "utf8");
      for (const token of ["isBeadsProject", ".xtrm/claims", 'SubprocessRunner.run("bd"', "bd kv"]) {
        expect(content, `${relativePath} should not contain ${token}`).not.toContain(token);
      }
    }
  });
});
