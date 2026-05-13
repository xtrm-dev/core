import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the @mariozechner Pi runtime packages before importing the extension —
// Pi provides these at runtime, but CI's npm install does not pull them in.
// Without these mocks, vitest fails the entire test file at module-load time.
// See xtrm-qdsx.
vi.mock("@mariozechner/pi-coding-agent", () => ({
	isToolCallEventType: vi.fn(() => false),
	isBashToolResult: vi.fn(() => false),
}));
vi.mock("@mariozechner/pi-tui", () => ({
	truncateToWidth: vi.fn((s: string) => s),
	visibleWidth: vi.fn((s: string) => s.length),
}));

import customFooterExtension from "../../../packages/pi-extensions/extensions/custom-footer/index";
import { SubprocessRunner, EventAdapter } from "../../../packages/pi-extensions/src/core";

vi.mock("../../../packages/pi-extensions/src/core", async () => {
	const actual = await vi.importActual<any>("../../../packages/pi-extensions/src/core");
	return {
		...actual,
		SubprocessRunner: { run: vi.fn() },
		EventAdapter: { isBeadsProject: vi.fn(() => true) },
	};
});

describe("custom-footer parity", () => {
	let handlers: Record<string, Function[]>;
	let footerRenderer: any;
	let ctx: any;
	let setFooterSpy: any;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetAllMocks();
		handlers = {};
		footerRenderer = null;

		setFooterSpy = vi.fn((factory: any) => {
			footerRenderer = factory(
				{ requestRender: vi.fn() },
				{ fg: (_c: string, text: string) => text },
				{
					getGitBranch: () => "xt/demo",
					onBranchChange: () => () => {},
					getAvailableProviderCount: () => 1,
				},
			);
		});

		ctx = {
			cwd: "/repo/.xtrm/worktrees/demo",
			sessionManager: { getSessionId: () => "session-1" },
			model: { id: "gpt-5" },
			getContextUsage: () => ({ percent: 37 }),
			hasUI: true,
			ui: { setFooter: setFooterSpy },
		};
	});

	it("renders two lines with claim title parity", async () => {
		(EventAdapter.isBeadsProject as any).mockReturnValue(true);
		(SubprocessRunner.run as any).mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === "git" && args[0] === "rev-parse") return { code: 0, stdout: "/repo\n", stderr: "" };
			if (cmd === "git" && args[0] === "branch") return { code: 0, stdout: "xt/demo\n", stderr: "" };
			if (cmd === "git" && args.includes("status")) return { code: 0, stdout: " M file.ts\nA  new.ts\n", stderr: "" };
			if (cmd === "git" && args.includes("rev-list")) return { code: 0, stdout: "0 1\n", stderr: "" };
			if (cmd === "bd" && args[0] === "list" && args[1] === "--status=in_progress") return { code: 0, stdout: "◐ xtrm-123 in progress\n", stderr: "" };
			if (cmd === "bd" && args[0] === "show") {
				return { code: 0, stdout: JSON.stringify([{ status: "in_progress", title: "Fix footer parity" }]), stderr: "" };
			}
			if (cmd === "bd" && args[0] === "list") return { code: 0, stdout: "(4 open, 1 in progress)", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		});

		const pi = {
			on: (event: string, fn: Function) => {
				if (!handlers[event]) handlers[event] = [];
				handlers[event].push(fn);
			},
		};

		customFooterExtension(pi as any);
		await handlers["session_start"][0]({}, ctx);
		await vi.advanceTimersByTimeAsync(45);

		footerRenderer.render(120);
		await vi.advanceTimersByTimeAsync(1);
		const lines = footerRenderer.render(120);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("xt/demo");
		expect(lines[1]).toContain("gpt-5");
		expect(lines[2]).toContain("◐ 123");
		expect(lines[2]).toContain("Fix footer parity");
	});

	it("falls back to open issue count when no claim", async () => {
		(EventAdapter.isBeadsProject as any).mockReturnValue(true);
		(SubprocessRunner.run as any).mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === "git" && args[0] === "rev-parse") return { code: 0, stdout: "/repo\n", stderr: "" };
			if (cmd === "git" && args[0] === "branch") return { code: 0, stdout: "xt/demo\n", stderr: "" };
			if (cmd === "git" && args.includes("status")) return { code: 0, stdout: "", stderr: "" };
			if (cmd === "git" && args.includes("rev-list")) return { code: 0, stdout: "0 0\n", stderr: "" };
			if (cmd === "bd" && args[0] === "list" && args[1] === "--status=in_progress") return { code: 0, stdout: "", stderr: "" };
			if (cmd === "bd" && args[0] === "list") return { code: 0, stdout: "(5 open, 0 in progress)", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		});

		const pi = {
			on: (event: string, fn: Function) => {
				if (!handlers[event]) handlers[event] = [];
				handlers[event].push(fn);
			},
		};

		customFooterExtension(pi as any);
		await handlers["session_start"][0]({}, ctx);
		await vi.advanceTimersByTimeAsync(45);

		footerRenderer.render(100);
		await vi.advanceTimersByTimeAsync(1);
		const lines = footerRenderer.render(100);
		expect(lines[2]).toContain("○ 5 open");
	});

	it("reapplies footer on model/session refresh events", async () => {
		(SubprocessRunner.run as any).mockResolvedValue({ code: 1, stdout: "", stderr: "" });

		const pi = {
			on: (event: string, fn: Function) => {
				if (!handlers[event]) handlers[event] = [];
				handlers[event].push(fn);
			},
		};

		customFooterExtension(pi as any);
		await handlers["session_start"][0]({}, ctx);
		await vi.advanceTimersByTimeAsync(45);
		const initialCalls = setFooterSpy.mock.calls.length;

		await handlers["model_select"][0]({}, ctx);
		await vi.advanceTimersByTimeAsync(45);
		await handlers["session_switch"][0]({}, ctx);
		await vi.advanceTimersByTimeAsync(45);

		expect(setFooterSpy.mock.calls.length).toBeGreaterThan(initialCalls);
	});
});
