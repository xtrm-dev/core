/**
 * Worktree liveness guard (CORE-2814).
 *
 * Blocks a Bash tool call that removes a worktree another live process is using:
 * `git worktree remove [--force]`, `rm -r`/`rm -rf`, `find ... -delete` or
 * `find ... -exec rm ...`.
 *
 * Why: on 2026-11-28 a Pi session ran
 *   git worktree list | awk '/xt-pi-/{print $1}' | while read w; do git worktree remove --force "$w"; done
 * and force-removed 16 worktrees, two of them in use by live panes, discarding
 * their uncommitted work.
 *
 * The guard reads the command the way a shell would, as far as a bounded parser
 * can: wrappers (sudo, env, xargs, setsid, flock, parallel, timeout, ...), git
 * global options and same-command aliases, `sh -c` / `eval` / script files,
 * `$(...)` and backtick substitution, `cd` / `pushd` through `&&`, `;` and `||`.
 * A literal target is checked directly. A target the shell resolves at run time
 * is bounded by the directory of its literal prefix, complete components only:
 * `build/$CONFIG` bounds to `build`, and a bound that merely contains a nested
 * live worktree is not at risk, so `rm -rf dist/*` is allowed in any tree. `$HOME`
 * and `~` are expanded from the environment, so they are literal. A
 * bare `$X` cannot be bounded and blocks while any live worktree exists.
 * Removal is recognised at token level, never by raw text. `env -C` and
 * `git -C` change the directory following targets are relative to. Being inside
 * your own worktree exempts only your own pid ancestry, never another holder in
 * the same tree.
 *
 * Known limits, by design: an interpreter the parser cannot read (`python -c
 * ...shutil.rmtree`, `perl -e unlink`, `node -e ...`, `rsync --delete`, a
 * compiled binary) is invisible unless its text names a removal verb. An
 * executable or script the guard cannot read is treated as unknown and allowed.
 * Script fan-out keeps a visited set and a 40 ms parse budget. The guard is
 * defence in depth, not a sandbox.
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
import { isAbsolute, resolve } from "node:path";

import {
	callerProcessIds,
	canonicalPath,
	expandHome,
	formatWorktreeHolders,
	readProcessCwds,
	readTmuxPanes,
	removalOperations,
	targetBound,
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
	return root ? canonicalPath(root) : null;
}

function registeredWorktrees(cwd: string): string[] {
	const out = gitOutput(["worktree", "list", "--porcelain"], cwd);
	if (!out) return [];
	return out
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim())
		.filter(Boolean);
}

function isInside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(`${parent}/`);
}

function blockReason(holderLines: readonly string[], detail: string | null, warnings: readonly string[]): string {
	const lines = ["🚫 Worktree liveness guard (CORE-2814): this command removes a worktree a live process is using."];
	if (holderLines.length > 0) lines.push("", ...holderLines);
	if (detail) lines.push("", detail);
	lines.push(
		"",
		"Removing a live worktree discards another session's uncommitted work.",
		"Stop the holder first, or target a worktree that is not in use.",
	);
	if (warnings.length > 0) lines.push("", ...warnings.map((warning) => `note: ${warning}`));
	return lines.join("\n");
}

export interface WorktreeGuardOptions {
	/** tmux sockets to read; tests pass `[]` so ambient servers cannot decide the answer. */
	tmuxSockets?: string[];
}

interface EvaluationContext {
	cwd: string;
	ownPids: Set<number>;
	panes: Awaited<ReturnType<typeof readTmuxPanes>>["panes"];
	warnings: string[];
	probe: (path: string) => ReturnType<typeof worktreeInUse>;
	holdersOutside: (path: string) => ReturnType<typeof worktreeInUse>["holders"];
	livePaths: string[];
}

function evaluateCommand(command: string, ctx: EvaluationContext): string | null {
	const parsed = removalOperations(command, 0, ctx.cwd);
	if (parsed.length === 0) return null;
	ctx.warnings.push(...parsed.filter((operation) => operation.kind === "warning").map((operation) => operation.warning ?? "parse warning"));
	const operations = parsed.filter((operation) => operation.kind !== "warning");
	if (operations.length === 0) return null;
	const liveHolders = (paths: readonly string[]) => paths.flatMap((path) => ctx.holdersOutside(path));

	const check = (rawTarget: string, opCwd: string | null, kind: string): string | null => {
		const target = expandHome(rawTarget) ?? rawTarget;
		if (targetIsUnresolved(target)) {
			const bound = targetBound(target, opCwd);
			if (bound === null) {
				if (ctx.livePaths.length === 0) return null;
				const holders = liveHolders(ctx.livePaths);
				return blockReason(
					holders.length > 0 ? formatWorktreeHolders(holders) : [],
					`The target ${JSON.stringify(target)} cannot be bounded statically: use a literal path, or stop the live holder first.`,
					ctx.warnings,
				);
			}
			// Equal to a live worktree, inside one, or an ancestor of one. A bound
			// that merely contains a nested live worktree is not at risk (N1, N5).
			const atRisk = ctx.livePaths.filter((path) => isInside(path, bound) || isInside(bound, path));
			if (atRisk.length === 0) return null;
			return blockReason(
				formatWorktreeHolders(liveHolders(atRisk)),
				`The target ${JSON.stringify(target)} resolves inside or around ${atRisk.join(", ")}.`,
				ctx.warnings,
			);
		}
		const resolved = isAbsolute(target) ? canonicalPath(target) : opCwd ? canonicalPath(resolve(opCwd, target)) : null;
		if (!resolved) {
			if (ctx.livePaths.length === 0) return null;
			return blockReason(
				[],
				`The target ${JSON.stringify(target)} is relative to a directory the guard could not resolve: use a literal path.`,
				ctx.warnings,
			);
		}
		// A literal target blocks on any holder inside it, even one attributed to a
		// nested worktree: removing the parent tree destroys that worktree too.
		const holders = ctx.holdersOutside(resolved);
		if (holders.length === 0) return null;
		return blockReason(formatWorktreeHolders(holders), `${kind} would remove ${resolved}.`, ctx.warnings);
	};

	for (const operation of operations) {
		const opCwd = operation.cwd === undefined ? ctx.cwd : operation.cwd;
		if (operation.targets.length === 0) {
			if (ctx.livePaths.length === 0) continue;
			return blockReason(
				formatWorktreeHolders(liveHolders(ctx.livePaths)),
				`${operation.kind} has no statically known target: use a literal path.`,
				ctx.warnings,
			);
		}
		for (const target of operation.targets) {
			const reason = check(target, opCwd, operation.kind);
			if (reason) return reason;
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
	if (!command || command.trim() === "") return null;
	if (removalOperations(command, 0, cwd).length === 0) return null;

	const ownPids = callerProcessIds();
	const cwds = readProcessCwds("/proc");
	const { panes, warnings } = readTmuxPanes({ procRoot: "/proc", tmuxSockets: options.tmuxSockets });
	const probe = (path: string) => worktreeInUse(path, { cwds, panes, skipTmux: true });
	const holdersOutside = (path: string) =>
		probe(path).holders.filter((holder) => !ownPids.has(holder.pid));

	const candidates = [
		...new Set([
			...registeredWorktrees(cwd).map((path) => canonicalPath(path)),
			...panes.map((pane) => pane.agentWorktree).filter(Boolean).map((path) => canonicalPath(path)),
		]),
	];
	// A holder inside a nested worktree belongs to that worktree, not to the tree
	// that contains it: the main checkout is not live because a session runs in
	// its .xtrm/worktrees/* (N1).
	const ownerOf = (holderPath: string) =>
		candidates
			.filter((path) => isInside(holderPath, path))
			.sort((a, b) => b.length - a.length)[0];
	const livePaths = candidates.filter((path) =>
		holdersOutside(path).some((holder) => ownerOf(holder.path) === path),
	);
	const ctx: EvaluationContext = { cwd, ownPids, panes, warnings, probe, holdersOutside, livePaths };

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
