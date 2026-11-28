/**
 * Worktree liveness and removal-command parsing for the Pi Bash guard
 * (CORE-2814).
 *
 * A worktree is live when a process's cwd is inside it, or a tmux pane on any
 * reachable server reports `pane_current_path` or `@agent_worktree` inside it.
 * The plain-ESM twin in `.xtrm/hooks/worktree-liveness.mjs` and the TypeScript
 * implementation in `cli/src/core/worktree-liveness.ts` carry the same
 * algorithm; the Pi package cannot import either, because it ships on its own.
 *
 * Failure policy: an unreadable /proc entry counts as not live and a failed
 * tmux query is a warning, never a block by itself. Nothing here throws.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

export interface WorktreeHolder {
	kind: "process" | "pane";
	pid: number;
	command: string;
	pane?: string;
	path: string;
	socket?: string;
}

export interface WorktreeLiveness {
	path: string;
	live: boolean;
	holders: WorktreeHolder[];
	warnings: string[];
}

export interface PaneRecord {
	paneId: string;
	panePid: number;
	paneCommand: string;
	panePath: string;
	agentWorktree: string;
	socket: string;
}

export interface WorktreeInUseOptions {
	procRoot?: string;
	cwds?: Map<string, number[]>;
	panes?: PaneRecord[];
	tmuxSockets?: string[];
	skipTmux?: boolean;
	env?: NodeJS.ProcessEnv;
	uid?: number;
	readCommand?: (pid: number) => string;
	commandTimeoutMs?: number;
}

const PANE_FORMAT = ["#{pane_id}", "#{pane_pid}", "#{pane_current_command}", "#{pane_current_path}", "#{@agent_worktree}"].join("\t");

function isInside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(`${parent}${sep}`);
}

/** Map every readable process cwd on this host. Unreadable entries are skipped. */
export function readProcessCwds(procRoot = "/proc"): Map<string, number[]> {
	const cwds = new Map<string, number[]>();
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch {
		return cwds;
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		let target: string;
		try {
			target = readlinkSync(join(procRoot, entry, "cwd"));
		} catch {
			continue;
		}
		const existing = cwds.get(target);
		if (existing) existing.push(pid);
		else cwds.set(target, [pid]);
	}
	return cwds;
}

export function readProcessCommand(pid: number, procRoot = "/proc"): string {
	try {
		const raw = readFileSync(join(procRoot, String(pid), "cmdline"), "utf8");
		const command = raw.replace(/\0/g, " ").trim();
		if (command) return command.slice(0, 160);
	} catch {
		// fall through
	}
	try {
		return readFileSync(join(procRoot, String(pid), "comm"), "utf8").trim().slice(0, 160);
	} catch {
		return "(unknown)";
	}
}

export function discoverTmuxSockets(
    env: NodeJS.ProcessEnv = process.env,
    uid = typeof process.getuid === 'function' ? process.getuid() : 0,
): string[] {
    const base = env.TMUX_TMPDIR && env.TMUX_TMPDIR.length > 0 ? env.TMUX_TMPDIR : '/tmp';
    const isSocket = (candidate: string): boolean => {
        try {
            return lstatSync(candidate).isSocket();
        } catch {
            return false;
        }
    };

    // The cheap, bounded set first: the caller's own server and this uid's
    // default server. Scanning every socket in the tmp dir means one tmux spawn
    // per stale test socket (~150 on this host) for no liveness gain, because a
    // stale socket cannot host a pane.
    const preferred: string[] = [];
    const tmuxEnv = env.TMUX?.split(',')[0];
    if (tmuxEnv) preferred.push(tmuxEnv);
    const defaultSocket = join(base, `tmux-${uid}`, 'default');
    if (isSocket(defaultSocket)) preferred.push(defaultSocket);

    const existing = preferred.filter(isSocket);
    if (existing.length > 0) return [...new Set(existing)];

    // No live server in the bounded set: fall back to discovery for a private
    // socket, capped so a directory full of dead probes cannot dominate a call.
    const sockets: string[] = [];
    const addSocketEntries = (dir: string): void => {
        let entries;
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
            if (sockets.length >= 20) return;
            const full = join(dir, name);
            if (isSocket(full)) sockets.push(full);
        }
    };
    addSocketEntries(base);
    addSocketEntries(join(base, `tmux-${uid}`));

    return [...new Set(sockets)];
}

export function readTmuxPanes(options: WorktreeInUseOptions = {}): { panes: PaneRecord[]; warnings: string[] } {
	if (options.panes) return { panes: options.panes, warnings: [] };
	if (options.skipTmux) return { panes: [], warnings: [] };

	const sockets = options.tmuxSockets ?? discoverTmuxSockets(options.env ?? process.env, options.uid);
	const panes: PaneRecord[] = [];
	const warnings: string[] = [];

	for (const socket of sockets) {
		const result = spawnSync("tmux", ["-S", socket, "list-panes", "-a", "-F", PANE_FORMAT], {
			encoding: "utf8",
			timeout: options.commandTimeoutMs ?? 1500,
			env: { ...(options.env ?? process.env), TMUX: "" },
		});
		if (result.error || result.status !== 0) {
			const detail = result.error?.message ?? (result.stderr ?? "").trim() ?? `exit ${result.status ?? "unknown"}`;
			warnings.push(`tmux list-panes on ${socket} failed: ${detail.split("\n")[0]}`);
			continue;
		}
		for (const line of (result.stdout ?? "").split("\n")) {
			if (!line.trim()) continue;
			const [paneId = "", panePid = "", paneCommand = "", panePath = "", agentWorktree = ""] = line.split("\t");
			panes.push({
				paneId,
				panePid: Number.parseInt(panePid, 10) || 0,
				paneCommand,
				panePath,
				agentWorktree,
				socket,
			});
		}
	}

	return { panes, warnings };
}

export function worktreeInUse(worktreePath: string, options: WorktreeInUseOptions = {}): WorktreeLiveness {
	const path = resolve(worktreePath);
	const cwds = options.cwds ?? readProcessCwds(options.procRoot ?? "/proc");
	const readCommand = options.readCommand ?? ((pid: number) => readProcessCommand(pid, options.procRoot ?? "/proc"));
	const { panes, warnings } = readTmuxPanes(options);

	const holders: WorktreeHolder[] = [];
	const seen = new Set<string>();

	for (const [cwd, pids] of cwds) {
		if (!isInside(cwd, path)) continue;
		for (const pid of pids) {
			const key = `process:${pid}`;
			if (seen.has(key)) continue;
			seen.add(key);
			holders.push({ kind: "process", pid, command: readCommand(pid), path: cwd });
		}
	}

	for (const pane of panes) {
		const panePath = pane.panePath && isInside(resolve(pane.panePath), path) ? pane.panePath : "";
		const agentPath = pane.agentWorktree && isInside(resolve(pane.agentWorktree), path) ? pane.agentWorktree : "";
		if (!panePath && !agentPath) continue;
		const key = `pane:${pane.socket}:${pane.paneId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		holders.push({
			kind: "pane",
			pid: pane.panePid,
			command: pane.paneCommand || "tmux",
			pane: pane.paneId,
			path: panePath || agentPath,
			socket: pane.socket,
		});
	}

	holders.sort((a, b) => a.pid - b.pid || a.kind.localeCompare(b.kind));
	return { path, live: holders.length > 0, holders, warnings };
}

export function formatWorktreeHolders(holders: readonly WorktreeHolder[]): string[] {
	return holders.map((holder) =>
		holder.kind === "pane"
			? `tmux pane ${holder.pane ?? "(unknown)"} (pid ${holder.pid}, ${holder.command}) at ${holder.path}`
			: `pid ${holder.pid} (${holder.command}) cwd ${holder.path}`,
	);
}

export function callerProcessIds(start = process.pid, procRoot = "/proc"): Set<number> {
	const ids = new Set<number>();
	let pid = start;
	for (let depth = 0; depth < 64 && pid > 0; depth += 1) {
		if (ids.has(pid)) break;
		ids.add(pid);
		let stat: string;
		try {
			stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
		} catch {
			break;
		}
		const tail = stat.slice(stat.lastIndexOf(")") + 1).trim();
		const ppid = Number.parseInt(tail.split(/\s+/)[1] ?? "", 10);
		if (!Number.isFinite(ppid) || ppid <= 0) break;
		pid = ppid;
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Removal-command parsing
// ---------------------------------------------------------------------------

const SHELL_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "}", "done", "fi"]);
const WRAPPERS = new Set(["command", "builtin", "nohup", "time", "exec"]);

function tokenize(command: string): string[][] {
	const segments: string[][] = [];
	let tokens: string[] = [];
	let token = "";
	let hasToken = false;
	let quote: string | null = null;
	let i = 0;

	const pushToken = (): void => {
		if (hasToken) {
			tokens.push(token);
			token = "";
			hasToken = false;
		}
	};
	const pushSegment = (): void => {
		pushToken();
		if (tokens.length) segments.push(tokens);
		tokens = [];
	};

	while (i < command.length) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				token += command[i + 1];
				i += 1;
			} else {
				token += ch;
			}
			i += 1;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			hasToken = true;
			i += 1;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			token += command[i + 1];
			hasToken = true;
			i += 2;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			pushToken();
			i += 1;
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
			pushSegment();
			i += 1;
			continue;
		}
		if (ch === "#" && !hasToken) {
			while (i < command.length && command[i] !== "\n") i += 1;
			continue;
		}
		token += ch;
		hasToken = true;
		i += 1;
	}
	pushSegment();
	return segments;
}

export function targetIsUnresolved(target: string | undefined): boolean {
	if (!target) return true;
	return /[$`*?[\]{}~]/.test(target);
}

export interface RemovalOperation {
	kind: "git-worktree-remove" | "rm" | "find-delete";
	targets: string[];
	raw: string;
}

/** Removal operations in a shell command, in execution order. */
export function removalOperations(command: string): RemovalOperation[] {
	const operations: RemovalOperation[] = [];

	for (const raw of tokenize(command)) {
		const tokens = raw.filter((token) => !SHELL_KEYWORDS.has(token));
		let start = 0;
		while (start < tokens.length && WRAPPERS.has(tokens[start])) start += 1;
		while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start += 1;
		const commandName = tokens[start];
		if (!commandName) continue;

		const name = basename(commandName);

		if (name === "git") {
			const worktreeAt = tokens.indexOf("worktree", start + 1);
			if (worktreeAt < 0 || tokens[worktreeAt + 1] !== "remove") continue;
			const target = tokens.slice(worktreeAt + 2).find((token) => !token.startsWith("-"));
			operations.push({ kind: "git-worktree-remove", targets: target ? [target] : [], raw: raw.join(" ") });
			continue;
		}

		if (name === "rm") {
			const args = tokens.slice(start + 1);
			const recursive = args.some((arg) => arg === "--recursive" || /^-[A-Za-z]*[rR]/.test(arg));
			if (!recursive) continue;
			operations.push({ kind: "rm", targets: args.filter((arg) => !arg.startsWith("-")), raw: raw.join(" ") });
			continue;
		}

		if (name === "find") {
			const args = tokens.slice(start + 1);
			if (!args.includes("-delete")) continue;
			const root = args.find((token) => !token.startsWith("-"));
			operations.push({ kind: "find-delete", targets: root ? [root] : [], raw: raw.join(" ") });
		}
	}

	return operations;
}
