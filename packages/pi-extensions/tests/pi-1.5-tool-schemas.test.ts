import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// CORE-2616: Pi 1.5.0 moved tool-argument validation to @earendil-works/pi-schema.
// TypeBox features outside JSON Schema no longer apply, and validation failures
// now carry pi-schema's messages. Every tool xtrm registers must still accept
// the arguments it documents and reject the ones its schema forbids.
//
// The probe runs in its own process: sibling suites mock `typebox`
// process-wide, so only a fresh import sees the real schemas.
// ---------------------------------------------------------------------------

const repoRoot = join(import.meta.dir, "..", "..", "..");
const probe = join(import.meta.dir, "fixtures", "tool-schema-probe.ts");

const EXPECTED_TOOLS = ["BackgroundStop", "BashBackground", "ListAgents", "Monitor", "SendMessage", "python"];

describe("tool parameter schemas under Pi 1.5 validation (CORE-2616)", () => {
  test("every registered tool accepts valid arguments and rejects invalid ones through pi-schema", () => {
    const result = spawnSync(process.execPath, [probe], { cwd: repoRoot, encoding: "utf-8", timeout: 120_000 });
    const report = (() => {
      try {
        return JSON.parse(result.stdout) as {
          tools: string[];
          checks: Array<{ tool: string; case: string; ok: boolean; detail?: string }>;
          failures: string[];
        };
      } catch {
        throw new Error(`probe produced no JSON report (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
      }
    })();

    // A missing tool would otherwise pass silently: the probe only checks what it registered.
    expect(report.tools).toEqual(EXPECTED_TOOLS);
    // Readable failure: name the tool and the argument set Pi disagreed about.
    expect(report.failures).toEqual([]);
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(result.status).toBe(0);
    expect(report.checks.length).toBeGreaterThanOrEqual(EXPECTED_TOOLS.length);
  });
});
