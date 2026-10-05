import { describe, expect, it } from "bun:test";
import { deliverySeam, type Situation } from "../../extensions/skill-suggest/index.ts";

const at = (o: Partial<Situation>): Situation => ({ prompted: false, pending: false, usedTool: false, activeTurn: false, ...o });

describe("delivery covers every situation", () => {
  it("prompted turn with tools delivers inline at the first tool_result", () => {
    expect(deliverySeam(at({ prompted: true, pending: true, usedTool: true }))).toBe("tool_result");
  });

  it("prompted turn WITHOUT tools still delivers — the regression that dropped a block", () => {
    expect(deliverySeam(at({ prompted: true, pending: true, usedTool: false }))).toBe("agent_end_flush");
  });

  it("unprompted turn (autonomous continue, resume) is judged at the boundary", () => {
    expect(deliverySeam(at({ prompted: false, pending: false, usedTool: true, activeTurn: true }))).toBe("agent_end_decision");
    expect(deliverySeam(at({ prompted: false, usedTool: false, activeTurn: true }))).toBe("agent_end_decision");
  });

  it("prompted turn that already delivered falls through to the boundary decision", () => {
    expect(deliverySeam(at({ prompted: true, pending: false, usedTool: true, activeTurn: true }))).toBe("agent_end_decision");
  });

  it("idle turns deliver nothing", () => {
    expect(deliverySeam(at({}))).toBe("none");
    expect(deliverySeam(at({ prompted: true, activeTurn: false }))).toBe("none");
  });
});
