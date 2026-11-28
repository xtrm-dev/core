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
	expandTrailingGlob,
	formatWorktreeHolders,
	readProcessCommand,
	readProcessCwds,
	readTmuxPanes,
	removalOperations,
	targetBound,
	targetIsUnresolved,
	type WorktreeHolder,
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
	ownRoot: string | null;
	holders: WorktreeHolder[];
	describe: (holders: readonly WorktreeHolder[]) => string[];
	holdersInside: (path: string) => WorktreeHolder[];
	atRisk: (bound: string) => WorktreeHolder[];
	liveTreeHolders: WorktreeHolder[];
	warnings: string[];
}

function evaluateCommand(command: string, ctx: EvaluationContext): string | null {
	const parsed = removalOperations(command, 0, ctx.cwd);
	if (parsed.length === 0) return null;
	ctx.warnings.push(...parsed.filter((operation) => operation.kind === "warning").map((operation) => operation.warning ?? "parse warning"));
	const operations = parsed.filter((operation) => operation.kind !== "warning");
	if (operations.length === 0) return null;

	const check = (rawTarget: string, opCwd: string | null, kind: string): string | null => {
		const target = expandHome(rawTarget);
		if (targetIsUnresolved(target)) {
			// A glob in the final component names real files: each match is a literal.
			const matches = expandTrailingGlob(target ?? "", opCwd);
			if (matches !== null) {
				for (const match of matches) {
					const found = ctx.holdersInside(match);
					if (found.length > 0) return blockReason(ctx.describe(found), `${kind} would remove ${match}.`, ctx.warnings);
				}
				return null;
			}
			const bound = targetBound(target, opCwd);
			if (bound === null) {
				if (ctx.liveTreeHolders.length === 0) return null;
				return blockReason(
					ctx.describe(ctx.liveTreeHolders),
					`The target ${JSON.stringify(target)} cannot be bounded statically: use a literal path, or stop the live holder first.`,
					ctx.warnings,
				);
			}
			// Any holder under the bound, or a live worktree inside it, is at risk.
			// A bound that merely contains a nested live worktree is not (N1, N5, R1).
			const found = ctx.atRisk(bound);
			if (found.length === 0) return null;
			return blockReason(ctx.describe(found), `The target ${JSON.stringify(target)} resolves inside or around ${bound}.`, ctx.warnings);
		}
		const resolved = isAbsolute(target ?? "") ? canonicalPath(target ?? "") : opCwd ? canonicalPath(resolve(opCwd, target ?? "")) : null;
		if (!resolved) {
			if (ctx.liveTreeHolders.length === 0) return null;
			return blockReason(
				[],
				`The target ${JSON.stringify(target)} is relative to a directory the guard could not resolve: use a literal path.`,
				ctx.warnings,
			);
		}
		// Another holder inside the target blocks, even when the target is the
		// caller's own worktree: only an empty own worktree may be removed.
		const found = ctx.holdersInside(resolved);
		if (found.length > 0) return blockReason(ctx.describe(found), `${kind} would remove ${resolved}.`, ctx.warnings);
		return null;
	};

	for (const operation of operations) {
		const opCwd = operation.cwd === undefined ? ctx.cwd : operation.cwd;
		if (operation.targets.length === 0) {
			if (ctx.liveTreeHolders.length === 0) continue;
			return blockReason(
				ctx.describe(ctx.liveTreeHolders),
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
	// Fast path: no removal shape, so /proc and tmux are never touched.
	if (removalOperations(command, 0, cwd).length === 0) return null;

	const ownPids = callerProcessIds();
	const ownRoot = worktreeRoot(cwd);
	const cwds = readProcessCwds("/proc");
	const { panes, warnings } = readTmuxPanes({ procRoot: "/proc", tmuxSockets: options.tmuxSockets });
	// Every holder, whatever repository it works in: a target is judged against the
	// holders themselves, never against a list from the caller's repo, so a
	// removal aimed at another repo's worktrees is judged the same (R1).
	const holders: WorktreeHolder[] = [];
	const seen = new Set<string>();
	const addHolder = (holder: WorktreeHolder) => {
		// A pane holder and its process holder share pid and path; the kind keeps both.
		const key = `${holder.kind}\0${holder.pid}\0${holder.path}`;
		if (seen.has(key)) return;
		seen.add(key);
		holders.push(holder);
	};
	// readProcessCwds keys by cwd path and holds the pids seen there.
	for (const [path, pids] of cwds) {
		for (const pid of pids) {
			if (ownPids.has(pid)) continue;
			addHolder({ kind: "process", pid, command: "", path });
		}
	}
	for (const pane of panes) {
		if (pane.panePid && ownPids.has(pane.panePid)) continue;
		for (const path of [pane.panePath, pane.agentWorktree]) {
			if (!path) continue;
			addHolder({
				kind: "pane",
				pid: pane.panePid ?? 0,
				command: pane.paneCommand ?? "",
				pane: pane.paneId,
				path,
				socket: pane.socket,
			});
		}
	}
	// The command line of a holder is read only when a block is built.
	const describe = (list: readonly WorktreeHolder[]) =>
		formatWorktreeHolders(list.map((holder) => (holder.command ? holder : { ...holder, command: readProcessCommand(holder.pid) })));
	const holdersInside = (path: string) => holders.filter((holder) => isInside(holder.path, path));
	// The trees an unknowable target can reach: the worktrees this repo registers
	// and every pane's agent worktree. Outside a repo there is no list, so any
	// managed worktree holder is reachable (R1).
	const worktreePaths = new Set(panes.map((pane) => pane.agentWorktree).filter(Boolean));
	const reachable = [...registeredWorktrees(cwd).map((path) => canonicalPath(path)), ...worktreePaths];
	const liveTreeHolders = reachable.length > 0 || ownRoot !== null
		? holders.filter((holder) => reachable.some((tree) => isInside(holder.path, tree)))
		: holders.filter((holder) => holder.kind === "pane" || holder.path.includes("/.xtrm/worktrees/"));
	const atRisk = (bound: string) => holders.filter((holder) => isInside(holder.path, bound) || isInside(bound, holder.path));

	const ctx: EvaluationContext = { cwd, ownRoot, holders, describe, holdersInside, atRisk, liveTreeHolders, warnings };
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
