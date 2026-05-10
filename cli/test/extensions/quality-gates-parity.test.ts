import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtensionHarness } from "./extension-harness";
import qualityGatesExtension from "../../../packages/pi-extensions/extensions/quality-gates/index";
import { SubprocessRunner } from "../../../packages/pi-extensions/src/core";
import * as fs from "node:fs";

vi.mock("../../../packages/pi-extensions/src/core", async () => {
	const actual = await vi.importActual<any>("../../../packages/pi-extensions/src/core");
	return {
		...actual,
		SubprocessRunner: {
			run: vi.fn(),
		},
		EventAdapter: {
			isMutatingFileTool: vi.fn((event: any) => event.toolName === "write" || event.toolName === "edit"),
			extractPathFromToolInput: vi.fn((event: any) => event.input.path),
		},
	};
});

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
}));

describe("Pi quality-gates extension parity", () => {
	let harness: ExtensionHarness;

	beforeEach(() => {
		vi.resetAllMocks();
		harness = new ExtensionHarness();
	});

	it("runs JS gate for .cjs files and reports stdout details", async () => {
		(SubprocessRunner.run as any).mockResolvedValue({
			code: 0,
			stdout: "ESLint auto-fixed issues",
			stderr: "",
		});

		qualityGatesExtension(harness.pi);

		const result = await harness.emit("tool_result", {
			toolName: "write",
			input: { path: "hooks/sample.cjs" },
			content: [{ type: "text", text: "ok" }],
		});

		expect(SubprocessRunner.run).toHaveBeenCalledWith(
			"node",
			expect.arrayContaining([expect.stringContaining("quality-check.cjs")]),
			expect.any(Object),
		);
		expect(result?.content?.[1]?.text).toContain("ESLint auto-fixed issues");
	});

	it("fails tool result when hook exits with status 2", async () => {
		(SubprocessRunner.run as any).mockResolvedValue({
			code: 2,
			stdout: "",
			stderr: "Compilation failed: error TS1234",
		});

		qualityGatesExtension(harness.pi);

		const result = await harness.emit("tool_result", {
			toolName: "write",
			input: { path: "src/main.ts" },
			content: [{ type: "text", text: "Original content" }],
		});

		expect(result?.isError).toBe(true);
		expect(result?.content?.[1]?.text).toContain("Compilation failed");
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith("Quality Gate failed for main.ts", "error");
	});

	it("no-ops when hook script is missing", async () => {
		(fs.existsSync as any).mockReturnValue(false);
		qualityGatesExtension(harness.pi);

		const result = await harness.emit("tool_result", {
			toolName: "write",
			input: { path: "src/main.ts" },
			content: [{ type: "text", text: "Original content" }],
		});

		expect(result).toBeUndefined();
		expect(SubprocessRunner.run).not.toHaveBeenCalled();
	});
});
