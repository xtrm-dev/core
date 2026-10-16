import { describe, expect, mock, test } from "bun:test";

// CORE-2403: the `xt end` worktree reminder lived in the retired
// session-flow extension and was restored in git-checkpoint. These tests
// pin the reminder: it fires once per worktree cwd on agent_end with a UI,
// and stays silent elsewhere. They fail if the agent_end block is removed.
//
// NOTE: the factories below stay structural supersets of the sibling
// factories for the same modules (see registry-parity, CORE-2360): bun
// shares mock.module registrations process-wide, so a narrower factory
// breaks sibling files when scheduling interleaves.
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
  Box: class {},
  Text: class {},
  matchesKey: () => false,
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));
mock.module("@mariozechner/pi-coding-agent", () => ({}));

const gitCheckpoint = (await import("../extensions/git-checkpoint/index.ts")).default;

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  };
  const fire = async (name: string, event: any, ctx: any) => {
    const out: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) out.push(await handler({ type: name, ...event }, ctx));
    return out;
  };
  return { pi, fire };
}

const notifyCtx = (cwd: string, hasUI = true) => {
  const notify = mock(() => {});
  return {
    ctx: {
      cwd,
      hasUI,
      ui: { notify },
      sessionManager: { getLeafEntry: () => null },
    },
    notify,
  };
};

const WORKTREE = "/repo/.xtrm/worktrees/wt-a";
const OTHER_WORKTREE = "/repo/.xtrm/worktrees/wt-b";
const NON_WORKTREE = "/repo";

describe("git-checkpoint xt end worktree reminder", () => {
  test("agent_end notifies once per worktree cwd when a UI is present", async () => {
    const { pi, fire } = fakePi();
    gitCheckpoint(pi as any);
    const { ctx, notify } = notifyCtx(WORKTREE);

    await fire("agent_end", {}, ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toContain("xt end");

    await fire("agent_end", {}, ctx);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("agent_end stays silent outside worktrees and without a UI", async () => {
    const { pi, fire } = fakePi();
    gitCheckpoint(pi as any);

    const plain = notifyCtx(NON_WORKTREE);
    await fire("agent_end", {}, plain.ctx);
    expect(plain.notify).not.toHaveBeenCalled();

    const headless = notifyCtx(WORKTREE, false);
    await fire("agent_end", {}, headless.ctx);
    expect(headless.notify).not.toHaveBeenCalled();
  });

  test("a different worktree cwd reminds again", async () => {
    const { pi, fire } = fakePi();
    gitCheckpoint(pi as any);

    const first = notifyCtx(WORKTREE);
    await fire("agent_end", {}, first.ctx);
    expect(first.notify).toHaveBeenCalledTimes(1);

    const second = notifyCtx(OTHER_WORKTREE);
    await fire("agent_end", {}, second.ctx);
    expect(second.notify).toHaveBeenCalledTimes(1);
  });
});
