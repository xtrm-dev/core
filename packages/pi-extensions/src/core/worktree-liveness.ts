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
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
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
	/** Holders whose presence is legitimate (a release's own pane and ancestry). */
	exemptPids?: Iterable<number>;
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
		// The kernel renders a cwd whose directory was removed as "<path> (deleted)",
		// which would never equal the real directory.
		if (target.endsWith(" (deleted)")) target = target.slice(0, -" (deleted)".length);
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

/**
 * Find the processes and panes that live inside `worktreePath`.
 *
 * It answers "does another process use this tree". It is not an identity authority:
 * whether a pane owns a tree stays with `readAgentIdentity` in
 * `worktree-release-pane.ts`. `exemptPids` names the holders whose presence is
 * legitimate — `xt worktree release` runs while its pane's agent and its own ancestry
 * sit inside — and only the remaining holders make the tree live.
 */
export function worktreeInUse(worktreePath: string, options: WorktreeInUseOptions = {}): WorktreeLiveness {
	// /proc/<pid>/cwd is kernel-real; a repo root reached through a symlink would
	// otherwise never match a holder.
	const path = canonicalPath(worktreePath);
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

	const exempt = options.exemptPids ? new Set(options.exemptPids) : null;
	const blocking = exempt && exempt.size > 0 ? holders.filter((holder) => !exempt.has(holder.pid)) : holders;
	blocking.sort((a, b) => a.pid - b.pid || a.kind.localeCompare(b.kind));
	return { path, live: blocking.length > 0, holders: blocking, warnings };
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

const MAX_NESTING = 3;
const SHELL_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "}", "done", "fi"]);
/** Wrappers that run another command; the real command follows them. */
const WRAPPERS = new Set(["command", "builtin", "nohup", "time", "exec", "env", "sudo", "xargs", "nice", "timeout", "stdbuf", "ionice"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
/** Wrapper options that take a separate value, per wrapper: `sudo -p prompt` takes
 * one, `command -p` does not, so a shared table hides the wrapped command. */
const WRAPPER_OPERAND_FLAGS: Record<string, Set<string>> = {
	command: new Set(),
	builtin: new Set(),
	exec: new Set(["-a"]),
	nohup: new Set(),
	time: new Set(["-f", "-o", "--format", "--output"]),
	env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
	sudo: new Set(["-u", "-g", "-p", "-C", "-h", "-r", "-t", "-U", "-T", "-D", "-R", "-a", "--user", "--group", "--prompt", "--close-from", "--host", "--role", "--type", "--other-user", "--chdir", "--auth-type"]),
	xargs: new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars"]),
	nice: new Set(["-n", "--adjustment"]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
	ionice: new Set(["-c", "-n", "-p", "-P", "-u"]),
};

function wrapperSkipsOperand(wrapper: string, token: string): boolean {
	const flags = WRAPPER_OPERAND_FLAGS[wrapper];
	return flags ? flags.has(token) : false;
}
/** A redirection token consumes its operand, which is a file, never a target:
 * `git worktree remove 2>/dev/null --force <path>` removes <path>. */
const REDIRECTION = /^(\d*|&)(>>?|<<?)(.*)$/;

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
	kind: "git-worktree-remove" | "rm" | "find-delete" | "script" | "shell";
	targets: string[];
	raw: string;
	/** The nested program of a `sh -c` / `eval` operation. */
	program?: string;
}

/** Filesystem identity: a symlinked target and a trailing slash both resolve to
 * the directory the process actually uses. Missing paths fall back to resolve(). */
export function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function stripRedirections(tokens: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "&>" || token === "&>>") {
			i += 1;
			continue;
		}
		const match = REDIRECTION.exec(token);
		if (match) {
			if (!match[3] && i + 1 < tokens.length) i += 1;
			continue;
		}
		out.push(token);
	}
	return out;
}

/** Index of the command word after wrappers, their options and assignments. */
function commandIndex(tokens: string[]): number {
	let start = 0;
	for (;;) {
		if (start >= tokens.length) return start;
		const base = basename(tokens[start]);
		if (!WRAPPERS.has(base)) break;
		start += 1;
		while (start < tokens.length) {
			const token = tokens[start];
			if (/^\d+[smhd]?$/.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
				start += 1;
				continue;
			}
			if (!token.startsWith("-")) break;
			start += wrapperSkipsOperand(base, token) ? 2 : 1;
		}
	}
	while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start += 1;
	return start;
}

/** The git config key that defines an alias: `alias.<name>`, or a qualified form. */
const ALIAS_KEY = /^(?:.*\.)?alias\.([^.=]+)$/;
/** Git global options that take a separate value before the subcommand. */
const GIT_GLOBAL_OPERAND_FLAGS = new Set(["-c", "--config", "--config-env", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--shallow-file", "--attr-source"]);

function addGitAlias(config: string, aliases: Map<string, string>, envAliases: Set<string>, fromEnv = false): void {
	const eq = config.indexOf("=");
	if (eq <= 0) return;
	const match = ALIAS_KEY.exec(config.slice(0, eq));
	if (!match) return;
	if (fromEnv) {
		// `--config-env=<key>=<VAR>` keeps the value in the environment, so an
		// invocation of that alias cannot be resolved statically.
		envAliases.add(match[1]);
		return;
	}
	aliases.set(match[1], config.slice(eq + 1));
}

interface GitPrefix {
	subcommandAt: number;
	aliases: Map<string, string>;
	envAliases: Set<string>;
}

/** Walk the git global options; return the subcommand position and alias table. */
function parseGitPrefix(tokens: string[], from: number): GitPrefix {
	const aliases = new Map<string, string>();
	const envAliases = new Set<string>();
	let i = from;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === "-c" || token === "--config") {
			addGitAlias(tokens[i + 1] ?? "", aliases, envAliases);
			i += 2;
			continue;
		}
		if (token.startsWith("-c") && token.length > 2) {
			addGitAlias(token.slice(2), aliases, envAliases);
			i += 1;
			continue;
		}
		if (token === "--config-env") {
			addGitAlias(tokens[i + 1] ?? "", aliases, envAliases, true);
			i += 2;
			continue;
		}
		if (token.startsWith("--config-env=")) {
			addGitAlias(token.slice("--config-env=".length), aliases, envAliases, true);
			i += 1;
			continue;
		}
		if (!token.startsWith("-")) break;
		i += GIT_GLOBAL_OPERAND_FLAGS.has(token) ? 2 : 1;
	}
	return { subcommandAt: i, aliases, envAliases };
}

/** `git -c alias.x='worktree remove --force' x <path>` removes <path>: expand the
 * alias defined in the same command, and treat an environment-supplied alias as
 * unresolved. */
function gitRemovalOperations(
	tokens: string[],
	start: number,
	record: (kind: RemovalOperation["kind"], targets: string[], extra?: Partial<RemovalOperation>) => void,
	operations: RemovalOperation[],
	depth: number,
): RemovalOperation[] {
	const { subcommandAt, aliases, envAliases } = parseGitPrefix(tokens, start + 1);
	const subcommand = tokens[subcommandAt] ?? "";
	const args = tokens.slice(subcommandAt + 1);
	const aliasValue = aliases.get(subcommand);
	if (aliasValue !== undefined) {
		if (depth >= MAX_NESTING) return operations;
		const program = aliasValue.startsWith("!")
			? `${aliasValue.slice(1)} ${args.join(" ")}`
			: `git ${aliasValue} ${args.join(" ")}`;
		operations.push(...removalOperations(program, depth + 1));
		return operations;
	}
	if (envAliases.has(subcommand)) {
		record("git-worktree-remove", args.filter((token) => !token.startsWith("-")));
		return operations;
	}
	if (subcommand !== "worktree" || args[0] !== "remove") return operations;
	const target = args.slice(1).find((token) => !token.startsWith("-"));
	record("git-worktree-remove", target ? [target] : []);
	return operations;
}

function operationsFromSegment(raw: string[], depth: number): RemovalOperation[] {
	const operations: RemovalOperation[] = [];
	const tokens = stripRedirections(raw.filter((token) => !SHELL_KEYWORDS.has(token)));
	const start = commandIndex(tokens);
	const commandName = tokens[start];
	if (!commandName) return operations;
	const name = basename(commandName);
	const rest = tokens.slice(start + 1);
	const record = (kind: RemovalOperation["kind"], targets: string[], extra: Partial<RemovalOperation> = {}): void => {
		operations.push({ kind, targets, raw: raw.join(" "), ...extra });
	};

	if (SHELLS.has(name) || name === "eval") {
		const cIndex = name === "eval" ? -1 : rest.findIndex((token) => /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
		if (name === "eval" || cIndex >= 0) {
			const program = name === "eval" ? rest.join(" ") : rest[cIndex + 1];
			if (program) {
				record("shell", [], { program });
				if (depth < MAX_NESTING) operations.push(...removalOperations(program, depth + 1));
			}
			return operations;
		}
		const script = rest.find((token) => !token.startsWith("-"));
		if (script) record("script", [script]);
		return operations;
	}

	if (name === "git") {
		return gitRemovalOperations(tokens, start, record, operations, depth);
	}

	if (name === "rm") {
		const args = stripRedirections(rest);
		const recursive = args.some((arg) => arg === "--recursive" || /^-[A-Za-z]*[rR]/.test(arg));
		if (recursive) record("rm", args.filter((arg) => !arg.startsWith("-")));
		return operations;
	}

	if (name === "find") {
		const args = stripRedirections(rest);
		if (!args.includes("-delete")) return operations;
		const root = args.find((token) => !token.startsWith("-"));
		record("find-delete", root ? [root] : []);
	}
	return operations;
}

/**
 * Removal operations in a shell command, in execution order.
 * `targets` is always an array; an empty array or an unresolved entry means the
 * path is not statically known.
 */
export function removalOperations(command: string, depth = 0): RemovalOperation[] {
	const operations: RemovalOperation[] = [];
	for (const raw of tokenize(command)) operations.push(...operationsFromSegment(raw, depth));
	return operations;
}
