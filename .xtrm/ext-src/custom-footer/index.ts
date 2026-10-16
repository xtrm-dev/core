/**
 * XTRM Custom Footer Extension
 *
 * Layout (git-only; the retired beads claim line is gone):
 * Line 1: ~/path (branch *+↑) — with git status flags, no session name
 * Line 2: XX%/window | (provider) model • thinking — simplified stats
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import { SubprocessRunner } from "@xtrm/pi-core";

export default function (pi: ExtensionAPI) {
	interface RuntimeState {
		branch: string | null;
		gitStatus: string;
		lastFetch: number;
	}

	let capturedPi: ExtensionAPI = pi;
	let capturedCtx: any = null;
	let requestRender: (() => void) | null = null;

	const CACHE_TTL = 5000;
	let refreshingRuntime = false;

	let runtimeState: RuntimeState = {
		branch: null,
		gitStatus: "",
		lastFetch: 0,
	};

	const getCwd = () => capturedCtx?.cwd || process.cwd();

	/**
	 * Parse git status --porcelain output into status flags
	 */
	const parseGitFlags = (porcelain: string): string => {
		let modified = false;
		let staged = false;
		let deleted = false;
		for (const line of porcelain.split("\n").filter(Boolean)) {
			if (/^ M|^AM|^MM/.test(line)) modified = true;
			if (/^A |^M /.test(line)) staged = true;
			if (/^ D|^D /.test(line)) deleted = true;
		}
		return `${modified ? "*" : ""}${staged ? "+" : ""}${deleted ? "-" : ""}`;
	};

	/**
	 * Fetch git branch and status
	 */
	const refreshRuntimeState = async () => {
		if (refreshingRuntime || Date.now() - runtimeState.lastFetch < CACHE_TTL) return;
		refreshingRuntime = true;
		const cwd = getCwd();
		try {
			let branch: string | null = null;
			let gitStatus = "";

			const rootResult = await SubprocessRunner.run("git", ["rev-parse", "--show-toplevel"], { cwd });
			const repoRoot = rootResult.code === 0 ? rootResult.stdout.trim() : null;

			if (repoRoot) {
				const branchResult = await SubprocessRunner.run("git", ["branch", "--show-current"], { cwd });
				branch = branchResult.code === 0 ? branchResult.stdout.trim() || null : null;

				const porcelainResult = await SubprocessRunner.run(
					"git",
					["--no-optional-locks", "status", "--porcelain"],
					{ cwd },
				);
				const baseFlags = porcelainResult.code === 0 ? parseGitFlags(porcelainResult.stdout) : "";

				let upstreamFlags = "";
				const abResult = await SubprocessRunner.run(
					"git",
					["--no-optional-locks", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
					{ cwd },
				);
				if (abResult.code === 0) {
					const [behindRaw, aheadRaw] = abResult.stdout.trim().split(/\s+/);
					const behind = Number(behindRaw || 0);
					const ahead = Number(aheadRaw || 0);
					if (ahead > 0 && behind > 0) upstreamFlags = "↕";
					else if (ahead > 0) upstreamFlags = "↑";
					else if (behind > 0) upstreamFlags = "↓";
				}

				gitStatus = `${baseFlags}${upstreamFlags}`;
			}

			runtimeState = {
				branch,
				gitStatus,
				lastFetch: Date.now(),
			};
			requestRender?.();
		} catch {
			// Fail soft — keep last known runtime state.
		} finally {
			refreshingRuntime = false;
		}
	};

	/**
	 * Format token counts (from original footer)
	 */
	const formatTokens = (count: number): string => {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1000000) return `${Math.round(count / 1000)}k`;
		if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
		return `${Math.round(count / 1000000)}M`;
	};


	let footerReapplyTimer: ReturnType<typeof setTimeout> | null = null;

	const applyCustomFooter = (ctx: any) => {
		capturedCtx = ctx;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => {
				runtimeState.lastFetch = 0;
				tui.requestRender();
			});

			return {
				dispose() {
					unsub();
					requestRender = null;
				},
				invalidate() {},
				render(width: number): string[] {
					refreshRuntimeState().catch(() => {});

					// === LINE 1: ~/path (branch *+↑) ===
					// Like original, no session name, but with git status flags
					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}

					// Use runtimeState branch (with git status) or fallback to footerData
					const branch = runtimeState.branch || footerData.getGitBranch();
					if (branch) {
						const branchWithStatus = runtimeState.gitStatus
							? `${branch} ${runtimeState.gitStatus}`
							: branch;
						pwd = `${pwd} (${branchWithStatus})`;
					}

					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

					// === LINE 2: XX%/window (provider) model • thinking ===
					const usage = ctx.getContextUsage();
					const model = ctx.model;

					const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
					const contextPercentValue = usage?.percent ?? 0;
					const contextPercent = usage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

					// Build left side: context %/window (color-coded like original)
					const contextDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}`
							: `${contextPercent}%/${formatTokens(contextWindow)}`;

					const colorizeUsage = (text: string) => {
						if (contextPercentValue > 90) return theme.fg("error", text);
						if (contextPercentValue > 70) return theme.fg("warning", text);
						return text;
					};

					// Build right side: (provider) model • thinking
					const modelName = model?.id || "no-model";
					const providerCount = footerData.getAvailableProviderCount();

					// Thinking level if model supports reasoning
					let rightSideWithoutProvider = modelName;
					if (model?.reasoning) {
						const thinkingLevel = capturedPi.getThinkingLevel() || "off";
						rightSideWithoutProvider =
							thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
					}

					// Prepend provider if >1
					let rightSide = rightSideWithoutProvider;
					if (providerCount > 1 && model) {
						rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
						if (visibleWidth(contextDisplay) + 3 + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
						}
					}

					// Keep provider/model adjacent to usage (no right-bound alignment)
					const separator = " ";
					const leftWidth = visibleWidth(contextDisplay);
					const separatorWidth = visibleWidth(separator);

					let line2: string;
					if (leftWidth >= width) {
						line2 = colorizeUsage(truncateToWidth(contextDisplay, width, ""));
					} else {
						const availableForRight = Math.max(0, width - leftWidth - separatorWidth);
						const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
						line2 = `${colorizeUsage(contextDisplay)}${theme.fg("dim", separator)}${theme.fg("dim", truncatedRight)}`;
					}

					return [pwdLine, line2];
				},
			};
		});
	};

	const scheduleFooterReapply = (ctx: any, delayMs = 40) => {
		if (footerReapplyTimer) clearTimeout(footerReapplyTimer);
		footerReapplyTimer = setTimeout(() => {
			applyCustomFooter(ctx);
			footerReapplyTimer = null;
		}, delayMs);
	};

	pi.on("session_start", async (_event, ctx) => {
		capturedCtx = ctx;
		runtimeState.lastFetch = 0;
		applyCustomFooter(ctx);
		scheduleFooterReapply(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		runtimeState.lastFetch = 0;
		scheduleFooterReapply(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		runtimeState.lastFetch = 0;
		scheduleFooterReapply(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		scheduleFooterReapply(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (footerReapplyTimer) {
			clearTimeout(footerReapplyTimer);
			footerReapplyTimer = null;
		}
	});

	// Bust caches immediately after relevant writes
	pi.on("tool_result", async (event: any) => {
		const cmd = event?.input?.command;
		if (!cmd) return undefined;

		if (/\bgit\s+/.test(cmd)) {
			runtimeState.lastFetch = 0;
			setTimeout(() => refreshRuntimeState().catch(() => {}), 200);
		}
		return undefined;
	});
}
