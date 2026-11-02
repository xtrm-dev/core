import { describe, expect, mock, test } from "bun:test";
// Complete mock: spread the real pi-tui so neighbouring suites sharing the
// module registry under full-suite runs keep working exports (matchesKey).
import * as realPiTui from "../../../node_modules/@earendil-works/pi-tui/dist/index.js";

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
  ...(realPiTui as object),
  Box: class {},
  Text: class {},
  truncateToWidth: (value: string) => value,
  visibleWidth: (value: string) => value.length,
}));
mock.module("@mariozechner/pi-coding-agent", () => ({}));

const gitCheckpoint = (await import("../extensions/git-checkpoint/index.ts")).default;

type Handler = (event: any, ctx: any) => unknown;

type ExecResult = { stdout: string; stderr: string; code: number };

function fakePi(exec: (args: string[]) => ExecResult = () => ({ stdout: "", stderr: "", code: 0 })) {
  const handlers = new Map<string, Handler[]>();
  const calls: string[][] = [];
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      return exec(args);
    },
  };
  const fire = async (name: string, event: any, ctx: any) => {
    const out: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) out.push(await handler({ type: name, ...event }, ctx));
    return out;
  };
  return { pi, fire, calls };
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

// CORE-2578: the restore used to report success from the dialog answer alone,
// so a conflicted or dropped `git stash apply` still printed "Code restored".
// The report now follows the exit code: success only on 0, and a genuine
// failure leads with `!` and carries the error line.
describe("git-checkpoint restore reporting", () => {
  const ENTRY = "entry-1";

  const forkCtx = (notify: ReturnType<typeof mock>, choice: string) => ({
    cwd: WORKTREE,
    hasUI: true,
    ui: { notify, select: async () => choice },
    sessionManager: { getLeafEntry: () => ({ id: ENTRY }) },
  });

  const execResults = (apply: ExecResult) => (args: string[]) =>
    args[0] === "stash" && args[1] === "create" ? { stdout: "deadbeef\n", stderr: "", code: 0 } : apply;

  async function fork(options: { apply?: ExecResult; choice?: string }) {
    const { pi, fire, calls } = fakePi(execResults(options.apply ?? { stdout: "", stderr: "", code: 0 }));
    gitCheckpoint(pi as any);
    const notify = mock(() => {});
    const ctx = forkCtx(notify, options.choice ?? "Yes, restore code to that point");
    await fire("tool_result", {}, ctx);
    await fire("turn_start", {}, ctx);
    await fire("session_before_fork", { entryId: ENTRY }, ctx);
    return { notify, calls };
  }

  test("a zero exit reports the restore", async () => {
    const { notify, calls } = await fork({});

    expect(calls).toContainEqual(["stash", "apply", "deadbeef"]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toBe("Code restored to checkpoint");
    expect(notify.mock.calls[0][1]).toBe("info");
  });

  test("a non-zero exit reports the failure, never a restore", async () => {
    const { notify } = await fork({
      apply: { stdout: "", stderr: "error: Your local changes would be overwritten\n", code: 1 },
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, level] = notify.mock.calls[0] as [string, string];
    expect(message).not.toContain("Code restored");
    expect(message.startsWith("!")).toBe(true);
    expect(message).toContain("Your local changes would be overwritten");
    expect(level).toBe("error");
  });

  test("declining the dialog restores nothing and reports nothing", async () => {
    const { notify, calls } = await fork({ choice: "No, keep current code" });

    expect(calls.some((args) => args[1] === "apply")).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});
