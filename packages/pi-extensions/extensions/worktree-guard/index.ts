/**
 * Worktree liveness guard (CORE-2814).
 *
 * Blocks a Bash tool call that removes a worktree another live process is using:
 * `git worktree remove [--force]`, `rm -r`/`rm -rf`, `find ... -delete`.
 *
 * Why: on 2026-11-28 a Pi session ran
 *   git worktree list | awk '/xt-pi-/{print $1}' | while read w; do git worktree remove --force "$w"; done
 * and force-removed 16 worktrees, two of them in use by live panes, discarding
 * their uncommitted work. A literal path is checked directly; a path the shell
 * resolves at run time is checked against every registered worktree, because
 * that loop form is the incident this guard exists for.
 *
 * `git worktree prune` is allowed by design: it removes metadata of missing
 * directories and never a live tree.
 *
 * The guard fails open. A command with no removal shape is allowed before any
 * /proc or tmux scan; a detection error that has already blocked nothing allows
 * the command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
	callerProcessIds,
	canonicalPath,
	formatWorktreeHolders,
	readProcessCwds,
	readTmuxPanes,
	removalOperations,
	targetIsUnresolved,
	worktreeInUse,
} from "../../src/core/worktree-liveness.ts";

function gitOutput(args: string[], cwd: string): string | null {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1500 });
	if (result.error || result.status !== 0) return null;
	return result.stdout ?? "";
}

function worktreeRoot(cwd: string): string | null {
	const root = gitOutput(["rev-parse", "--show-toplevel"], cwd)?.trim();
	return root ? resolve(root) : null;
}

function registeredWorktrees(cwd: string): string[] {
	const out = gitOutput(["worktree", "list", "--porcelain"], cwd);
	if (!out) return [];
	return out
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim())
		.filter(Boolean)
		.map((path) => resolve(path));
}

function blockReason(lines: readonly string[]): string {
	return [
		"🚫 Worktree liveness guard (CORE-2814): this command removes a worktree a live process is using.",
		...lines.map((line) => `  - ${line}`),
		"",
		"Removing a live worktree discards another session's uncommitted work.",
		"Stop the holder first, or target a worktree that is not in use.",
	].join("\n");
}

/**
 * Decide one Bash command. Returns null to allow, or the block reason.
 * Exported so the tests exercise the guard without a Pi runtime.
 */
export interface WorktreeGuardOptions {
	/** tmux sockets to read; tests pass `[]` so ambient servers cannot decide the answer. */
	tmuxSockets?: string[];
}

interface EvaluationContext {
	cwd: string;
	ownWorktree: string | null;
	ownPids: Set<number>;
	panes: Awaited<ReturnType<typeof readTmuxPanes>>["panes"];
	warnings: string[];
	notes: string[];
	probe: (path: string) => ReturnType<typeof worktreeInUse>;
}

const MAX_NESTING = 3;
const MAX_SCRIPT_BYTES = 64 * 1024;

/** Read a script the command would run; null when unreadable or not a file. */
function readScript(path: string): string | null {
	try {
		if (!statSync(path).isFile()) return null;
		return readFileSync(path, "utf8").slice(0, MAX_SCRIPT_BYTES);
	} catch {
		return null;
	}
}

function warningLines(ctx: EvaluationContext): string[] {
	return [...ctx.warnings, ...ctx.notes].map((warning) => `warning: ${warning}`);
}

function evaluateCommand(command: string, ctx: EvaluationContext, depth = 0): string | null {
	const operations = removalOperations(command, depth);
	const literalTargets: string[] = [];
	const unresolved: string[] = [];

	for (const operation of operations) {
		if (operation.kind === "script") {
			for (const target of operation.targets) {
				const scriptPath = resolve(ctx.cwd, target);
				const contents = readScript(scriptPath);
				if (contents === null) {
					ctx.notes.push(`could not read script ${scriptPath}`);
					continue;
				}
				const inner = evaluateCommand(contents, ctx, depth + 1);
				if (inner) return inner;
			}
			continue;
		}
		if (operation.targets.length === 0) unresolved.push(operation.raw);
		for (const target of operation.targets) {
			if (targetIsUnresolved(target)) unresolved.push(target);
			else literalTargets.push(resolve(ctx.cwd, target));
		}
	}

	const holderLines: string[] = [];
	for (const target of [...new Set(literalTargets)]) {
		const canonical = canonicalPath(target);
		if (ctx.ownWorktree && canonical === ctx.ownWorktree) continue;
		const liveness = ctx.probe(canonical);
		const others = liveness.holders.filter((holder) => !ctx.ownPids.has(holder.pid));
		if (others.length === 0) continue;
		holderLines.push(
			...formatWorktreeHolders(others).map((line) => `${target}: ${line}`),
			...liveness.warnings.map((warning) => `${target}: warning: ${warning}`),
		);
	}
	if (holderLines.length > 0) return blockReason([...holderLines, ...warningLines(ctx)]);

	if (unresolved.length > 0) {
		const candidates = new Set(registeredWorktrees(ctx.cwd).map((candidate) => canonicalPath(candidate)));
		for (const pane of ctx.panes) {
			if (pane.agentWorktree) candidates.add(canonicalPath(pane.agentWorktree));
		}

		const liveLines: string[] = [];
		for (const candidate of candidates) {
			if (ctx.ownWorktree && candidate === ctx.ownWorktree) continue;
			const liveness = ctx.probe(candidate);
			const others = liveness.holders.filter((holder) => !ctx.ownPids.has(holder.pid));
			if (others.length === 0) continue;
			liveLines.push(...formatWorktreeHolders(others).map((line) => `${candidate}: ${line}`));
		}

		if (liveLines.length > 0) {
			return blockReason([
				`the command removes a path it resolves at run time (${unresolved[0]})`,
				...liveLines,
				...warningLines(ctx),
			]);
		}
	}

	return null;
}

/**
 * Decide one Bash command. Returns null to allow, or the block reason.
 * Exported so the tests exercise the guard without a Pi runtime.
 */
export function worktreeGuardReason(
	command: string,
	cwd: string = process.cwd(),
	options: WorktreeGuardOptions = {},
): string | null {
	if (!command) return null;
	if (removalOperations(command).length === 0) return null;

	const ownWorktreeRoot = worktreeRoot(cwd);
	const ownPids = callerProcessIds();
	const cwds = readProcessCwds("/proc");
	const { panes, warnings } = readTmuxPanes({ procRoot: "/proc", tmuxSockets: options.tmuxSockets });
	const ctx: EvaluationContext = {
		cwd,
		ownWorktree: ownWorktreeRoot ? canonicalPath(ownWorktreeRoot) : null,
		ownPids,
		panes,
		warnings,
		notes: [],
		probe: (path) => worktreeInUse(path, { cwds, panes, skipTmux: true }),
	};

	return evaluateCommand(command, ctx);
}

export default function worktreeGuardExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		try {
			const reason = worktreeGuardReason(event.input.command, ctx.cwd);
			if (reason) return { block: true, reason };
		} catch {
			// Fail open on a detection error: the guard must never wedge a session.
		}
		return;
	});
}
