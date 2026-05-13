import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtensionHarness } from "./extension-harness";

// Mock the @mariozechner Pi runtime packages before importing the extension —
// Pi provides these at runtime, but CI's npm install does not pull them in.
// Without these mocks, vitest fails the entire test file at module-load time
// trying to resolve unused-at-test-time imports from the extension source.
// See xtrm-qdsx.
vi.mock("@mariozechner/pi-coding-agent", () => ({
	isToolCallEventType: vi.fn(() => false),
	isBashToolResult: vi.fn(() => false),
}));
vi.mock("@mariozechner/pi-tui", () => ({
	truncateToWidth: vi.fn((s: string) => s),
	visibleWidth: vi.fn((s: string) => s.length),
}));

import beadsExtension from "../../../packages/pi-extensions/extensions/beads/index";
import { SubprocessRunner } from "../../../packages/pi-extensions/src/core/lib";
import * as fs from "node:fs";

vi.mock("../../../packages/pi-extensions/src/core/lib", async () => {
	return {
		SubprocessRunner: {
			run: vi.fn(),
		},
		EventAdapter: {
			isMutatingFileTool: vi.fn((event) => event.toolName === "write"),
		},
		Logger: vi.fn().mockImplementation(function() {
			this.debug = vi.fn();
			this.info = vi.fn();
			this.warn = vi.fn();
			this.error = vi.fn();
		}),
	};
});

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
}));

describe.skip("Beads Extension (API mismatch - see xtrm-p3gk)", () => {
	let harness: ExtensionHarness;

	beforeEach(() => {
		vi.resetAllMocks();
		harness = new ExtensionHarness();
		(fs.existsSync as any).mockReturnValue(true);
	});

	it("should block edits when claim check fails", async () => {
		(SubprocessRunner.run as any).mockImplementation(async (cmd: string, args: string[]) => {
			if (args[0] === "kv" && args[1] === "get") return { code: 1, stdout: "", stderr: "" };
			if (args[0] === "list") {
                return { code: 0, stdout: "Total: 5 issues (3 open, 2 in progress)", stderr: "" };
            }
			return { code: 0, stdout: "", stderr: "" };
		});

		beadsExtension(harness.pi);

		const result = await harness.emit("tool_call", {
			toolName: "write",
			input: { path: "src/main.ts" },
		});

		expect(result).toBeDefined();
        if (result) {
		    expect(result.block).toBe(true);
		    expect(result.reason).toContain("No active issue claim");
        }
	});

	it("should allow edits when an issue is claimed", async () => {
		(SubprocessRunner.run as any).mockImplementation(async (cmd: string, args: string[]) => {
			if (args[0] === "kv" && args[1] === "get") return { code: 0, stdout: "issue-123", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		});

		beadsExtension(harness.pi);

		const result = await harness.emit("tool_call", {
			toolName: "write",
			input: { path: "src/main.ts" },
		});

		expect(result).toBeUndefined();
	});

	it("should block git commit when an issue is claimed", async () => {
		(SubprocessRunner.run as any).mockImplementation(async (cmd: string, args: string[]) => {
			if (args[0] === "kv" && args[1] === "get") return { code: 0, stdout: "issue-123", stderr: "" };
			if (args[0] === "list") {
                return { code: 0, stdout: "Total: 1 issues (0 open, 1 in progress)\n◐ issue-123 Title", stderr: "" };
            }
			return { code: 0, stdout: "", stderr: "" };
		});

		beadsExtension(harness.pi);

		const result = await harness.emit("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'feat: something'" },
		});

		expect(result).toBeDefined();
        if (result) {
		    expect(result.block).toBe(true);
		    expect(result.reason).toContain("Resolve open claim [issue-123]");
        }
	});

	it("should inject memory reminder on bd close", async () => {
		(SubprocessRunner.run as any).mockResolvedValue({ code: 0, stdout: "", stderr: "" });

		beadsExtension(harness.pi);

		const result = await harness.emit("tool_result", {
			toolName: "bash",
			input: { command: "bd close issue-123" },
			content: [{ type: "text", text: "Issue closed successfully." }],
			isError: false,
		});

		expect(result.content).toHaveLength(2);
		expect(result.content[1].text).toContain("Beads Insight");
	});

	it("should auto-claim session on bd update --claim", async () => {
		const kvSetCalls: string[][] = [];
		(SubprocessRunner.run as any).mockImplementation(async (cmd: string, args: string[]) => {
			if (args[0] === "kv" && args[1] === "set") {
				kvSetCalls.push(args);
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});

		beadsExtension(harness.pi);

		const result = await harness.emit("tool_result", {
			toolName: "bash",
			input: { command: "bd update issue-456 --claim" },
			content: [{ type: "text", text: "Updated issue: issue-456" }],
			isError: false,
		});

		expect(kvSetCalls.length).toBe(1);
		expect(kvSetCalls[0][2]).toBe(`claimed:${process.pid}`);
		expect(kvSetCalls[0][3]).toBe("issue-456");
		expect(result.content[1].text).toContain("claimed issue");
		expect(result.content[1].text).toContain("issue-456");
	});


	it("should auto-claim even when bd update --claim returns exit 1 (already in_progress)", async () => {
		const kvSetCalls: string[][] = [];
		(SubprocessRunner.run as any).mockImplementation(async (cmd: string, args: string[]) => {
			if (args[0] === "kv" && args[1] === "set") {
				kvSetCalls.push(args);
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});

		beadsExtension(harness.pi);

		const result = await harness.emit("tool_result", {
			toolName: "bash",
			input: { command: "bd update issue-789 --claim" },
			content: [{ type: "text", text: "already in_progress" }],
			isError: true,
		});

		expect(kvSetCalls.length).toBe(1);
		expect(kvSetCalls[0][2]).toBe(`claimed:${process.pid}`);
		expect(kvSetCalls[0][3]).toBe("issue-789");
		expect(result.content[1].text).toContain("issue-789");
	});
});
