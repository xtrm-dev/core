import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtensionHarness } from "./extension-harness";
import sessionFlowExtension from "../../../packages/pi-extensions/extensions/session-flow/index";
import { SubprocessRunner } from "../../../packages/pi-extensions/src/core";

vi.mock("@mariozechner/pi-coding-agent", () => ({
	isBashToolResult: (event: any) => event?.toolName === "bash",
}));

vi.mock("../../../packages/pi-extensions/src/core", async () => {
	const actual = await vi.importActual<any>("../../../packages/pi-extensions/src/core");
	return {
		...actual,
		SubprocessRunner: {
			run: vi.fn(),
		},
		EventAdapter: {
			isBeadsProject: vi.fn(() => true),
		},
	};
});

describe("Pi session-flow extension", () => {
	let harness: ExtensionHarness;

	beforeEach(() => {
		vi.resetAllMocks();
		harness = new ExtensionHarness();
		harness.pi.sendUserMessage = vi.fn();
	});

	it("adds claim-sync context on bd update --claim", async () => {
		sessionFlowExtension(harness.pi);

		const result = await harness.emit("tool_result", {
			toolName: "bash",
			input: { command: "bd update xtrm-123 --claim" },
			content: [{ type: "text", text: "ok" }],
		});

		expect(result?.content?.[1]?.text).toContain("claimed xtrm-123");
	});

	it("does not trigger follow-up turns on agent_end (prevents stop-loop)", async () => {
		(SubprocessRunner.run as any).mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "kv" && args[1] === "get") {
				return { code: 0, stdout: "xtrm-123\n", stderr: "" };
			}
			if (args[0] === "show") {
				return { code: 0, stdout: JSON.stringify({ id: "xtrm-123", status: "in_progress" }), stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});

		sessionFlowExtension(harness.pi);

		await harness.emit("agent_end", { messages: [] });
		await harness.emit("agent_end", { messages: [] });

		expect(harness.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("bd close xtrm-123"),
			"warning",
		);
	});

	it("reminds about xt end only once per worktree", async () => {
		harness.ctx.cwd = "/repo/.xtrm/worktrees/demo";
		(SubprocessRunner.run as any).mockImplementation(async (_cmd: string, args: string[]) => {
			if (args[0] === "kv" && args[1] === "get") {
				return { code: 0, stdout: "xtrm-999\n", stderr: "" };
			}
			if (args[0] === "show") {
				return { code: 0, stdout: JSON.stringify({ id: "xtrm-999", status: "closed" }), stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});

		sessionFlowExtension(harness.pi);

		await harness.emit("agent_end", { messages: [] });
		await harness.emit("agent_end", { messages: [] });

		expect(harness.ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			"Run `xt end` to create a PR and clean up this worktree.",
			"info",
		);
	});
});
