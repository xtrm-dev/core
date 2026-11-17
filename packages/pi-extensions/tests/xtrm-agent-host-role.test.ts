import { describe, expect, test } from "bun:test";
import { resolveSessionRole } from "../extensions/xtrm-agent-host/index.ts";

// CORE-2724: a session that exports its own XTMUX_AGENT_ROLE reports it, even when it shares a
// tmux pane whose @agent_role names another role (a specialist launched by a lead).
describe("resolveSessionRole", () => {
  test("the session's own env role wins over the pane @agent_role", () => {
    expect(resolveSessionRole("pr-reviewer", "lead")).toBe("pr-reviewer");
  });

  test("the pane @agent_role is the fallback when the env sets no role", () => {
    expect(resolveSessionRole(undefined, "lead")).toBe("lead");
    expect(resolveSessionRole("", "lead")).toBe("lead");
  });

  test("an env role that is only control characters counts as absent", () => {
    expect(resolveSessionRole("\u0000\n", "lead")).toBe("lead");
  });

  test("no env role and no pane role is no role", () => {
    expect(resolveSessionRole(undefined, undefined)).toBeUndefined();
    expect(resolveSessionRole(undefined, "")).toBeUndefined();
  });

  test("a non-string value is ignored", () => {
    expect(resolveSessionRole(42, "lead")).toBe("lead");
  });

  test("the same bounded, control-stripped form as the rest of the identity", () => {
    expect(resolveSessionRole("pr-\u0007reviewer", "lead")).toBe("pr-reviewer");
  });
});
