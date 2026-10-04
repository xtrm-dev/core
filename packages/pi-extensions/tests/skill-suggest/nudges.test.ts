import { describe, expect, it } from "bun:test";
import { isControlNudge } from "../../extensions/skill-suggest/index.ts";

describe("control nudges are never doctrine", () => {
  it("suppresses bare resume/ack prompts", () => {
    for (const p of ["continue", "Continue", "continue.", "go on", "go ahead", "yes please", "ok", "k", "thanks!", "proceed", "carry on"]) {
      expect(isControlNudge(p)).toBe(true);
    }
  });

  it("lets anything with real content through", () => {
    for (const p of ["continue, check the PR checks", "continue debugging the auth flow", "why is the build failing", "ok now explain the merge order"]) {
      expect(isControlNudge(p)).toBe(false);
    }
  });

  it("the live miss: 'continue' is 8 chars, below the 12-char floor", () => {
    // Guard order matters: isControlNudge fires before any classifier call.
    expect("continue".length).toBeLessThan(12);
    expect(isControlNudge("continue")).toBe(true);
  });
});
