/**
 * XTRM footer: single-line status HUD — git HEAD/branch, context, model,
 * token usage and cache rate.
 *
 * The HUD renders through pure, theme-injected helpers in `hud.ts`, so it stays
 * one line at every width and never fabricates a metric a provider does not
 * report. Git data comes from a detached-ish refresh loop (cached, async via
 * SubprocessRunner): rendering never blocks on git.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { SubprocessRunner } from "../../src/core";
import {
  gitContextFrom,
  renderHud,
  summarizeHudUsage,
  type GitContext,
  type HudEntry,
  type HudUsage,
  type HudState,
  EMPTY_GIT,
} from "./hud.ts";

// Lane 2 (hook cleanup): the retired beads-status-cache.mjs payload is deleted.
// The footer is git-only; no beads cache module is ever loaded.
const CACHE_TTL = 5000;
const REFRESH_TIMEOUT_MS = 2000;
const TOOL_RESULT_REFRESH_DELAY_MS = 200;
const FOOTER_REAPPLY_DELAY_MS = 40;

export type FooterSectionRenderer = (width: number) => string[];

const footerSections = new Map<string, FooterSectionRenderer>();
let footerDisabled = false;
/**
 * Latest live footer render trigger (CORE-2436 I5): sections like the
 * intercom waiting chip change outside the footer's own refresh causes
 * (git, branch, tool results), so they call requestFooterRender() after
 * updating their store. Null when no footer is applied; never throws.
 */
let activeRequestRender: (() => void) | null = null;

/** Re-render the footer now when one is applied; a silent no-op otherwise. */
export function requestFooterRender(): void {
  try {
    activeRequestRender?.();
  } catch {
    /* render is best effort */
  }
}

// Fleet composition seam (unitAI-beqby.2): registers lines rendered below the
// statusline. Re-registering a key replaces it. When the footer is
// absent/disabled the call is a silent no-op returning a no-op unregister.
export function registerFooterSection(key: string, renderBelow: FooterSectionRenderer): () => void {
	const noop = (): void => {};
	if (footerDisabled) return noop;
	if (typeof key !== "string" || !key || typeof renderBelow !== "function") return noop;
	footerSections.set(key, renderBelow);
	return () => {
		if (footerSections.get(key) === renderBelow) footerSections.delete(key);
	};
}

// Fleet hook publication (unitAI-plbug): the fleet looks up
// globalThis.__registerFooterSection and falls back to belowEditor when absent.
// Publish on load, clear on unload. Never throws; silent without globalThis.
function publishFooterHook(): void {
	try {
		if (typeof globalThis === "undefined") return;
		(globalThis as Record<string, unknown>).__registerFooterSection = registerFooterSection;
	} catch {
		// Silent: hook publication must never break load.
	}
}

function clearFooterHook(): void {
	try {
		if (typeof globalThis === "undefined") return;
		const g = globalThis as Record<string, unknown>;
		if (g.__registerFooterSection === registerFooterSection) delete g.__registerFooterSection;
	} catch {
		// Silent: hook cleanup must never break unload.
	}
}

publishFooterHook();

function parseGitFlags(porcelain: string): string {
	let modified = false;
	let staged = false;
	let deleted = false;
	for (const line of porcelain.split("\n").filter(Boolean)) {
		if (/^ M|^AM|^MM/.test(line)) modified = true;
		if (/^A |^M /.test(line)) staged = true;
		if (/^ D|^D /.test(line)) deleted = true;
	}
	return `${modified ? "*" : ""}${staged ? "+" : ""}${deleted ? "-" : ""}`;
}

/** Session usage totals, cached until the session tree changes. */
let usageCache: { key: string; usage: HudUsage } | null = null;

function readUsage(ctx: any): HudUsage {
	const sessionManager = ctx?.sessionManager;
	const entries: HudEntry[] = sessionManager?.getEntries?.() ?? [];
	const leaf = sessionManager?.getLeafId?.() ?? "";
	const key = `${entries.length}:${leaf}`;
	if (usageCache?.key === key) return usageCache.usage;
	const usage = summarizeHudUsage(entries);
	usageCache = { key, usage };
	return usage;
}

/** One-line HUD for the active session; exported for tests. */
export function buildFooterHud(input: {
	git: GitContext;
	contextPercent?: number | null;
	contextWindow?: number;
	modelId?: string;
	provider?: string;
	showProvider?: boolean;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage: HudUsage;
}): HudState {
	return {
		git: input.git,
		contextPercent: input.contextPercent,
		contextWindow: input.contextWindow,
		modelId: input.modelId,
		provider: input.provider,
		showProvider: input.showProvider,
		reasoning: input.reasoning,
		thinkingLevel: input.thinkingLevel,
		usage: input.usage,
	};
}

export default function registerCustomFooter(pi: ExtensionAPI): void {
	publishFooterHook();
	let capturedCtx: any = null;
	let requestRender: (() => void) | null = null;
	let branchChangeUnsub: (() => void) | null = null;
	let footerReapplyTimer: ReturnType<typeof setTimeout> | null = null;
	let runtimeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let refreshingRuntime = false;
	let runtimeState: {
		git: GitContext;
		lastFetch: number;
	} = { git: EMPTY_GIT, lastFetch: 0 };

	const cwd = () => capturedCtx?.cwd || process.cwd();
	const run = (command: string, args: string[], timeoutMs = REFRESH_TIMEOUT_MS) =>
		SubprocessRunner.run(command, args, { cwd: cwd(), timeoutMs });

	const gitRunner = async (args: readonly string[]): Promise<string | null> => {
		const result = await run("git", [...args]);
		return result.code === 0 ? result.stdout : null;
	};

	const refreshRuntime = async (): Promise<void> => {
		if (refreshingRuntime || Date.now() - runtimeState.lastFetch < CACHE_TTL) return;
		refreshingRuntime = true;
		try {
			// Every probe runs with the session cwd, so a linked worktree reports
			// its own branch and HEAD, never the parent repository's.
			const toplevel = await gitRunner(["rev-parse", "--show-toplevel"]);
			const git = toplevel?.trim()
				? gitContextFrom({
					toplevel,
					branch: await gitRunner(["branch", "--show-current"]),
					head: await gitRunner(["rev-parse", "--short", "HEAD"]),
				})
				: EMPTY_GIT;
			let gitFlags = "";
			if (git.repo) {
				const porcelainResult = await run("git", ["--no-optional-locks", "status", "--porcelain"]);
				if (porcelainResult.code === 0) gitFlags = parseGitFlags(porcelainResult.stdout);
				const abResult = await run("git", ["--no-optional-locks", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
				if (abResult.code === 0) {
					const [behind, ahead] = abResult.stdout.trim().split(/\s+/).map(Number);
					gitFlags += ahead > 0 && behind > 0 ? "↕" : ahead > 0 ? "↑" : behind > 0 ? "↓" : "";
				}
				if (!git.branch) {
					// Detached HEAD has no branch to flag; the short HEAD names it.
					gitFlags = gitFlags.replace(/[↕↑↓]/g, "");
				}
			}
			runtimeState = { git: { ...git, flags: gitFlags || undefined }, lastFetch: Date.now() };
			requestRender?.();
		} finally {
			refreshingRuntime = false;
		}
	};

	const scheduleRuntimeRefresh = (delayMs = 0): void => {
		if (runtimeRefreshTimer) return;
		runtimeRefreshTimer = setTimeout(() => {
			runtimeRefreshTimer = null;
			void refreshRuntime();
		}, delayMs);
	};

	const applyFooter = (ctx: any): void => {
		capturedCtx = ctx;
		if (typeof ctx.ui?.setFooter !== "function") {
			footerDisabled = true;
			return;
		}
		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			const instanceRender = () => tui.requestRender();
			requestRender = instanceRender;
			activeRequestRender = instanceRender;
			branchChangeUnsub?.();
			const unsubscribe = footerData.onBranchChange(() => {
				runtimeState.lastFetch = 0;
				scheduleRuntimeRefresh();
			});
			branchChangeUnsub = unsubscribe;
			return {
				dispose() {
					unsubscribe?.();
					if (branchChangeUnsub === unsubscribe) branchChangeUnsub = null;
					if (requestRender === instanceRender) requestRender = null;
					if (activeRequestRender === instanceRender) activeRequestRender = null;
				},
				invalidate() {},
				render(width: number): string[] {
					const usage = ctx.getContextUsage();
					const model = ctx.model;
					// Pi's footer provider resolves the session cwd too, so it can fill
					// the branch before the first asynchronous git refresh lands. The
					// provider never supplies a parent-repo branch for a worktree.
					const providerBranch = footerData.getGitBranch?.() ?? undefined;
					const git = runtimeState.git.repo
						? { ...runtimeState.git, branch: runtimeState.git.branch ?? providerBranch }
						: providerBranch
							? { repo: true, branch: providerBranch }
							: runtimeState.git;
					const hud = buildFooterHud({
						git,
						contextPercent: usage?.percent ?? null,
						contextWindow: usage?.contextWindow ?? model?.contextWindow,
						modelId: model?.id,
						provider: model?.provider,
						showProvider: footerData.getAvailableProviderCount() > 1,
						reasoning: Boolean(model?.reasoning),
						thinkingLevel: pi.getThinkingLevel?.() ?? undefined,
						usage: readUsage(ctx),
					});
					const line = renderHud(hud, width, theme, truncateToWidth);
					const lines = line ? [line] : [];
					for (const renderBelow of footerSections.values()) {
						try {
							for (const sectionLine of renderBelow(width) ?? []) lines.push(truncateToWidth(sectionLine, width));
						} catch {
							// A faulty section must never break the statusline.
						}
					}
					return lines;
				},
			};
		});
	};

	const reapplyFooter = (ctx: any): void => {
		if (footerReapplyTimer) clearTimeout(footerReapplyTimer);
		footerReapplyTimer = setTimeout(() => {
			applyFooter(ctx);
			footerReapplyTimer = null;
		}, FOOTER_REAPPLY_DELAY_MS);
	};

	const reset = (): void => {
		runtimeState = { git: EMPTY_GIT, lastFetch: 0 };
		usageCache = null;
	};

	pi.on("session_start", async (_event, ctx) => {
		capturedCtx = ctx;
		reset();
		applyFooter(ctx);
		reapplyFooter(ctx);
		scheduleRuntimeRefresh();
	});
	// Pi 1.0 has no session_switch/session_fork events. /new, /resume and /fork
	// replace the runtime and emit session_start (reason new|resume|fork) with a
	// fresh ctx, so the handler above already covers them. session_before_* would
	// run against the outgoing ctx, which the replacement invalidates.
	pi.on("model_select", async (_event, ctx) => reapplyFooter(ctx));
	pi.on("agent_settled", async () => {
		// Usage only changes with a settled turn; refresh once so the HUD shows
		// the numbers of the turn the operator just watched.
		usageCache = null;
		requestRender?.();
	});
	pi.on("tool_result", async (event: any) => {
		const command = event?.input?.command;
		if (!command) return undefined;
		if (/\bgit\s+/.test(command)) {
			runtimeState.lastFetch = 0;
			scheduleRuntimeRefresh(TOOL_RESULT_REFRESH_DELAY_MS);
		}
		return undefined;
	});
	pi.on("session_shutdown", async () => {
		clearFooterHook();
		for (const timer of [footerReapplyTimer, runtimeRefreshTimer]) if (timer) clearTimeout(timer);
		footerReapplyTimer = runtimeRefreshTimer = null;
		branchChangeUnsub?.();
		branchChangeUnsub = null;
		requestRender = null;
		activeRequestRender = null;
		footerDisabled = false;
		usageCache = null;
	});
}
