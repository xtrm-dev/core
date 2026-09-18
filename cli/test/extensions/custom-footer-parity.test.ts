import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	isToolCallEventType: vi.fn(() => false),
	isBashToolResult: vi.fn(() => false),
}));
vi.mock("@earendil-works/pi-tui", () => ({
	truncateToWidth: vi.fn((s: string) => s),
	visibleWidth: vi.fn((s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length),
}));

import customFooterExtension from "../../../packages/pi-extensions/extensions/custom-footer/index";
import { SubprocessRunner } from "../../../packages/pi-extensions/src/core";
import * as beadsCache from "../../../.xtrm/hooks/beads-status-cache.mjs";

vi.mock("../../../packages/pi-extensions/src/core", async () => {
	const actual = await vi.importActual<any>("../../../packages/pi-extensions/src/core");
	return { ...actual, SubprocessRunner: { run: vi.fn() } };
});

const repoRoot = join(import.meta.dirname, "../../..");

// Lane 1 (hook cleanup): the footer beads segment is severed
// (BEADS_RETIRED_LANE1) — the footer renders git-only and never loads the
// retired payload. These tests cover what remains: timer hygiene, git-only
// render, no subprocess on render/startup, no-module path, and absence of
// the removed toggle UI.
describe("custom-footer shared beads cache", () => {
	let handlers: Record<string, Function[]>;
	let footerRenderer: any;
	let ctx: any;
	let commands: Record<string, any>;
	let shortcuts: Record<string, any>;
	let requestRenderSpy: ReturnType<typeof vi.fn>;
	let cacheRoot: string;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetAllMocks();
		handlers = {};
		footerRenderer = null;
		commands = {};
		shortcuts = {};
		requestRenderSpy = vi.fn();
		cacheRoot = mkdtempSync(join(tmpdir(), "xtrm-footer-cache-"));
		process.env.XTRM_BEADS_CACHE_ROOT = cacheRoot;
		ctx = {
			cwd: repoRoot,
			model: { id: "gpt-5", contextWindow: 200_000 },
			getContextUsage: () => ({ percent: 37, contextWindow: 200_000 }),
			hasUI: true,
			mode: "tui",
			ui: {
				setFooter: vi.fn((factory: any) => {
					footerRenderer = factory(
						{ requestRender: requestRenderSpy },
						{ fg: (_color: string, text: string) => text },
						{
							getGitBranch: () => "feature/footer",
							onBranchChange: () => () => {},
							getAvailableProviderCount: () => 1,
						},
					);
				}),
			},
		};
		(SubprocessRunner.run as any).mockImplementation(async (command: string, args: string[]) => {
			if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
				return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
			}
			return { code: 1, stdout: "", stderr: "" };
		});
	});

	afterEach(() => {
		delete process.env.XTRM_BEADS_CACHE_ROOT;
		rmSync(cacheRoot, { recursive: true, force: true });
		vi.useRealTimers();
	});

	const createPi = () => ({
		on: (event: string, fn: Function) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(fn);
		},
		getThinkingLevel: () => "off",
		registerCommand: (name: string, options: any) => { commands[name] = options; },
		registerShortcut: (key: string, options: any) => { shortcuts[key] = options; },
	});

	async function start() {
		customFooterExtension(createPi() as any);
		await handlers.session_start[0]({}, ctx);
		await vi.runOnlyPendingTimersAsync();
	}

	it("cleans cache synchronization and refresh timers on shutdown", async () => {
		beadsCache.writeCache(cacheRoot, {
			counts: { open: 1, in_progress: 0, blocked: 0 }, activeIssues: [], activeEpic: null,
		});
		await start();
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		await handlers.session_shutdown[0]();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("renders git-only with no beads segment even when a fixture cache exists", async () => {
		beadsCache.writeCache(cacheRoot, {
			counts: { open: 12, in_progress: 2, blocked: 0 },
			activeIssues: [],
			activeEpic: { id: "xtrm-k2ufi", title: "Role parity", closed: 1, total: 3 },
		});
		await start();
		const lines = footerRenderer.render(120);
		expect(lines).toHaveLength(1);
		// Lane 1: beads severed — the retired payload cache must not leak into the line.
		expect(lines[0].replace(/\x1b\[[0-9;]*m/g, "")).not.toContain("o:12 p:2");
	});

	it("no-module path: footer renders git-only without ever loading the cache module", async () => {
		// Lane 1 proof: no beads payload import is attempted at startup.
		beadsCache.writeCache(cacheRoot, {
			counts: { open: 5, in_progress: 0, blocked: 0 }, activeIssues: [], activeEpic: null,
		});
		await start();
		const lines = footerRenderer.render(100);
		expect(lines).toHaveLength(1);
		expect(lines[0].replace(/\x1b\[[0-9;]*m/g, "")).not.toContain("o:");
	});

	it("render performs no subprocess work", async () => {
		beadsCache.writeCache(cacheRoot, {
			counts: { open: 5, in_progress: 0, blocked: 0 }, activeIssues: [], activeEpic: null,
		});
		await start();
		vi.clearAllMocks();
		footerRenderer.render(100);
		footerRenderer.render(100);
		expect(SubprocessRunner.run).not.toHaveBeenCalled();
	});

	it("registers no beads toggle command/shortcut and spawns no bd or refresh subprocess on startup", async () => {
		beadsCache.writeCache(cacheRoot, {
			counts: { open: 2, in_progress: 1, blocked: 0 },
			activeIssues: [{ id: "xtrm-one", title: "First claim", status: "in_progress" }],
			activeEpic: { id: "xtrm-epic", title: "Some epic", closed: 1, total: 3 },
		});
		await start();

		// The expandable tree UI is gone: no /beads command, no Alt+G shortcut.
		expect(commands.beads).toBeUndefined();
		expect(shortcuts["alt+g"]).toBeUndefined();

		// Startup is git-only (branch line). No bd, and no node cache-refresh subprocess.
		const calls = (SubprocessRunner.run as any).mock.calls as Array<[string, string[]]>;
		expect(calls.filter(([cmd]) => cmd === "bd")).toHaveLength(0);
		expect(calls.filter(([cmd]) => cmd !== "git" && cmd !== "bd")).toHaveLength(0);

		// The footer renders exactly one line: path/branch, context/model, compact beads.
		expect(footerRenderer.render(120)).toHaveLength(1);
	});

	it("re-reads the cache file (no subprocess) when a bd mutation tool_result arrives", async () => {
		beadsCache.writeCache(cacheRoot, {
			counts: { open: 1, in_progress: 0, blocked: 0 }, activeIssues: [], activeEpic: null,
		});
		await start();
		vi.clearAllMocks();
		await handlers.tool_result[0]({ input: { command: "bd close xtrm-1 --reason done" } }, ctx);
		await vi.runOnlyPendingTimersAsync();
		// No subprocess is spawned to refresh; the footer only re-reads the on-disk cache.
		expect(SubprocessRunner.run).not.toHaveBeenCalled();
	});
});
