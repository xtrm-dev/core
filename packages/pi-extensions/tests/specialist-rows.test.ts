/**
 * CORE-2576: specialist_* and substrate_* rows carry a subject and never a
 * JSON key list. The functions are the production row builder; no fake
 * renderer stands in for them.
 */

import { describe, expect, test } from "bun:test";
import { buildUltraExternalLine, ultraExternalPrimary, ultraExternalSubject, type ToolRowStatus } from "../extensions/xtrm-ui/index.ts";

const strip = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

function row(toolName: string, args: Record<string, unknown>, resultTexts: string[], status: ToolRowStatus, durationMs?: number): string {
  return strip(buildUltraExternalLine(toolName, args, resultTexts, status, durationMs));
}

describe("specialist_* rows (CORE-2576)", () => {
  test("a dispatch names the specialist and the issue ref, with no JSON key list", () => {
    const dispatch = row(
      "specialist_dispatch",
      { specialist: "reviewer", issue_ref: "CORE-2573" },
      ['{"status":"ok","activation_id":"act:1e362bb0","specialist":"reviewer","issue_ref":"CORE-2573","state":"running"}'],
      "success",
    );
    expect(dispatch).toBe("● Dispatched reviewer  CORE-2573");
    expect(dispatch).not.toContain("{");
    expect(dispatch).not.toContain("activation_id");
  });

  test("a resume names the activation and a finished result shows its outcome", () => {
    expect(
      row(
        "specialist_resume",
        { activation_id: "act:1e362bb0" },
        ['{"status":"ok","activation_id":"act:1e362bb0","specialist":"reviewer","state":"running"}'],
        "success",
      ),
    ).toBe("● Resumed reviewer  act:1e362bb0");
    expect(
      row(
        "specialist_result",
        { activation_id: "act:1e362bb0" },
        ['{"activation_id":"act:1e362bb0","specialist":"reviewer","issue_ref":"CORE-2573","status":"ok","result_status":"PASS","state":"settled"}'],
        "success",
        252_000,
      ),
    ).toBe("○ Finished reviewer  CORE-2573  PASS  4m12s");
  });

  test("a failed result leads with ! and states why", () => {
    expect(
      row(
        "specialist_result",
        { activation_id: "act:1e362bb0" },
        ['{"activation_id":"act:1e362bb0","specialist":"reviewer","issue_ref":"CORE-2573","status":"failed","reason":"lease expired"}'],
        "error",
        63_000,
      ),
    ).toBe("! Failed reviewer  CORE-2573  lease expired  1m03s");
  });

  test("resume, retry and lease reconcile stay pinned so they keep their own row", async () => {
    const { PINNED_TOOLS } = await import("../extensions/xtrm-ui/tool-group-view.ts");
    for (const name of ["specialist_resume", "specialist_retry", "specialist_lease_reconcile"]) {
      expect(PINNED_TOOLS.has(name)).toBe(true);
    }
  });
});

describe("substrate_* rows (CORE-2576)", () => {
  test("a read names the issue ref and never prints a JSON key list", () => {
    const substrate = row(
      "substrate_issue_get",
      { ref: "CORE-2573" },
      ['{"id":"iss_1","ref":"CORE-2573","title":"Pi UI surfaces","status":"open","revision":1}'],
      "success",
    );
    expect(substrate).toContain("CORE-2573");
    expect(substrate).not.toContain("{");
    expect(substrate).not.toContain("iss_1");
  });

  test("journal and search rows take their subject from the action", () => {
    expect(ultraExternalSubject("substrate_journal_append", { ref: "CORE-2573", kind: "finding" })).toBe("CORE-2573");
    expect(ultraExternalSubject("substrate_issue_search", { project: "core", query: "cards" })).toBe("core  cards");
    expect(ultraExternalPrimary("substrate_issue_get", ['{"a":1,"b":2,"c":3,"d":4}'])).toBeUndefined();
  });
});
