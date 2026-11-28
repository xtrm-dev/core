/**
 * Shared worktree liveness check (CORE-2814).
 *
 * A worktree is live when a process's cwd on this host is inside it, or when a
 * tmux pane on any reachable server reports `pane_current_path` or
 * `@agent_worktree` inside it. Removal paths (`xt worktree remove`, `clean`,
 * `reap`, `end`) and both agent pre-tool guards refuse a live worktree and name
 * the holders.
 *
 * Failure policy is per the contract: an unreadable /proc entry counts as not
 * live, and a tmux query failure is reported in `warnings` but does not by
 * itself make a worktree live. The check therefore never throws; it answers
 * with the evidence it could read.
 *
 * The plain-ESM twin at `.xtrm/hooks/worktree-liveness.mjs` carries the same
 * algorithm for the Claude PreToolUse hook, which cannot import this file: the
 * hook ships beside `cli/dist`, not `cli/src`. A parity test keeps the two
 * answers identical on the same fixture.
 */

import { spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { readProcessCwds } from './worktree-reap.js';

export interface WorktreeHolder {
    kind: 'process' | 'pane';
    pid: number;
    /** Process command line, or the pane's current command. */
    command: string;
    /** tmux pane id (for example `%12`) when the holder is a pane. */
    pane?: string;
    /** Observed cwd, or the pane path that named this worktree. */
    path: string;
    /** tmux socket the pane was read from. */
    socket?: string;
}

export interface WorktreeLiveness {
    path: string;
    live: boolean;
    holders: WorktreeHolder[];
    /** Detection problems (a tmux server that did not answer). Never a blocker by itself. */
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
    /** Pre-read process table; when given, /proc is not read again. */
    cwds?: Map<string, number[]>;
    /** Pre-read panes; when given, tmux is not queried. */
    panes?: PaneRecord[];
    /** Explicit tmux sockets. Disables discovery, so tests never touch the live server. */
    tmuxSockets?: string[];
    skipTmux?: boolean;
    env?: NodeJS.ProcessEnv;
    uid?: number;
    readCommand?: (pid: number) => string;
    commandTimeoutMs?: number;
}

const PANE_FORMAT = ['#{pane_id}', '#{pane_pid}', '#{pane_current_command}', '#{pane_current_path}', '#{@agent_worktree}'].join('\t');

function isInside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(`${parent}${sep}`);
}

function resolvePath(value: string): string {
    return resolve(value);
}

/** Read a process command line for a holder message. Best effort and bounded. */
export function readProcessCommand(pid: number, procRoot = '/proc'): string {
    try {
        const raw = readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8');
        const command = raw.replace(/\0/g, ' ').trim();
        if (command) return command.slice(0, 160);
    } catch {
        // fall through to comm
    }
    try {
        return readFileSync(join(procRoot, String(pid), 'comm'), 'utf8').trim().slice(0, 160);
    } catch {
        return '(unknown)';
    }
}

/**
 * Sockets of every tmux server this user can reach.
 *
 * `$TMUX` names the server hosting the caller. Everything else is discovered by
 * listing `<TMUX_TMPDIR>/tmux-<uid>` (tmux's own layout), so a server started
 * with `-S <full path>` is found when its socket lives there. Direct children of
 * `TMUX_TMPDIR` are included too: that is where a test may put a socket.
 */
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

/** Read every pane on every reachable server. A failed server becomes a warning. */
export function readTmuxPanes(options: WorktreeInUseOptions = {}): { panes: PaneRecord[]; warnings: string[] } {
    if (options.panes) return { panes: options.panes, warnings: [] };
    if (options.skipTmux) return { panes: [], warnings: [] };

    const sockets = options.tmuxSockets ?? discoverTmuxSockets(options.env ?? process.env, options.uid);
    const panes: PaneRecord[] = [];
    const warnings: string[] = [];

    for (const socket of sockets) {
        const result = spawnSync('tmux', ['-S', socket, 'list-panes', '-a', '-F', PANE_FORMAT], {
            encoding: 'utf8',
            timeout: options.commandTimeoutMs ?? 1500,
            env: { ...(options.env ?? process.env), TMUX: '' },
        });
        if (result.error || result.status !== 0) {
            const detail = result.error?.message
                ?? (result.stderr ?? '').trim()
                ?? `exit ${result.status ?? 'unknown'}`;
            warnings.push(`tmux list-panes on ${socket} failed: ${detail.split('\n')[0]}`);
            continue;
        }

        for (const line of (result.stdout ?? '').split('\n')) {
            if (!line.trim()) continue;
            const [paneId = '', panePid = '', paneCommand = '', panePath = '', agentWorktree = ''] = line.split('\t');
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
 * Passing `cwds` and `panes` makes the answer depend only on that evidence, which
 * is what tests use. A probe created once and reused for many paths is the cheap
 * shape for `clean` and `reap`; a removal re-reads right before it acts.
 */
export function worktreeInUse(worktreePath: string, options: WorktreeInUseOptions = {}): WorktreeLiveness {
    const path = resolvePath(worktreePath);
    const cwds = options.cwds ?? readProcessCwds(options.procRoot ?? '/proc');
    const readCommand = options.readCommand ?? ((pid: number) => readProcessCommand(pid, options.procRoot ?? '/proc'));
    const { panes, warnings } = readTmuxPanes(options);

    const holders: WorktreeHolder[] = [];
    const seen = new Set<string>();

    for (const [cwd, pids] of cwds) {
        if (!isInside(cwd, path)) continue;
        for (const pid of pids) {
            const key = `process:${pid}`;
            if (seen.has(key)) continue;
            seen.add(key);
            holders.push({ kind: 'process', pid, command: readCommand(pid), path: cwd });
        }
    }

    for (const pane of panes) {
        const panePath = pane.panePath && isInside(resolvePath(pane.panePath), path) ? pane.panePath : '';
        const agentPath = pane.agentWorktree && isInside(resolvePath(pane.agentWorktree), path) ? pane.agentWorktree : '';
        if (!panePath && !agentPath) continue;
        const key = `pane:${pane.socket}:${pane.paneId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        holders.push({
            kind: 'pane',
            pid: pane.panePid,
            command: pane.paneCommand || 'tmux',
            pane: pane.paneId,
            path: panePath || agentPath,
            socket: pane.socket,
        });
    }

    holders.sort((a, b) => a.pid - b.pid || a.kind.localeCompare(b.kind));
    return { path, live: holders.length > 0, holders, warnings };
}

/** One human line per holder, for a refusal message that names who is there. */
export function formatWorktreeHolders(holders: readonly WorktreeHolder[]): string[] {
    return holders.map(holder => {
        if (holder.kind === 'pane') {
            return `tmux pane ${holder.pane ?? '(unknown)'} (pid ${holder.pid}, ${holder.command}) at ${holder.path}`;
        }
        return `pid ${holder.pid} (${holder.command}) cwd ${holder.path}`;
    });
}

export function describeLiveness(liveness: WorktreeLiveness): string {
    return [`${liveness.path} is in use:`, ...formatWorktreeHolders(liveness.holders).map(line => `  - ${line}`)].join('\n');
}

/**
 * Pids on the caller's ancestry chain (self, shell, agent). `xt end` runs inside
 * the worktree it removes, so its own chain is the caller, not another user.
 */
export function callerProcessIds(start = process.pid, procRoot = '/proc'): Set<number> {
    const ids = new Set<number>();
    let pid = start;

    for (let depth = 0; depth < 64 && pid > 0; depth += 1) {
        if (ids.has(pid)) break;
        ids.add(pid);
        let stat: string;
        try {
            stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
        } catch {
            break;
        }
        // comm may contain spaces and parentheses, so parse after the last ')'.
        const tail = stat.slice(stat.lastIndexOf(')') + 1).trim();
        const ppid = Number.parseInt(tail.split(/\s+/)[1] ?? '', 10);
        if (!Number.isFinite(ppid) || ppid <= 0) break;
        pid = ppid;
    }

    return ids;
}

/** Holders that are not the caller's own process chain. */
export function otherHolders(liveness: WorktreeLiveness, ownPids: ReadonlySet<number>): WorktreeHolder[] {
    return liveness.holders.filter(holder => !ownPids.has(holder.pid));
}

/**
 * Append an override record before a live worktree is removed anyway.
 *
 * Deliberately a plain JSONL file under the repo's `.xtrm/logs`: the CLI runs on
 * Node 18, where `node:sqlite` (the hooks' debug.db) is not available. Logging
 * failure never blocks the removal the operator asked for.
 */
export function logLivenessOverride(input: {
    repoRoot: string;
    command: string;
    path: string;
    holders: readonly WorktreeHolder[];
    warnings?: readonly string[];
}): string | null {
    const logPath = join(input.repoRoot, '.xtrm', 'logs', 'worktree-liveness-overrides.jsonl');
    try {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, `${JSON.stringify({
            timestamp: new Date().toISOString(),
            component: 'xt.worktree.liveness-override',
            command: input.command,
            path: input.path,
            holders: input.holders,
            warnings: input.warnings ?? [],
        })}\n`);
        return logPath;
    } catch {
        return null;
    }
}

/** A probe that reads the process table and tmux panes once, then answers per path. */
export function createLivenessProbe(options: WorktreeInUseOptions = {}): (path: string) => WorktreeLiveness {
    const cwds = options.cwds ?? readProcessCwds(options.procRoot ?? '/proc');
    const { panes, warnings } = readTmuxPanes(options);
    return (path: string) => {
        const answer = worktreeInUse(path, { ...options, cwds, panes, skipTmux: true });
        return warnings.length > 0 ? { ...answer, warnings: [...warnings, ...answer.warnings] } : answer;
    };
}

/**
 * Root of the worktree the caller is standing in. `xt end` removes that tree and
 * the guards must not refuse it for the caller's own shell; every other live
 * holder still blocks. Returns null when git cannot answer.
 */
export function callerWorktreeRoot(cwd = process.cwd()): string | null {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        timeout: 1500,
    });
    if (result.error || result.status !== 0) return null;
    const root = (result.stdout ?? '').trim();
    return root ? resolve(root) : null;
}

/** True only for the caller's own worktree — never for a parent that contains it. */
export function isCallerWorktree(path: string, callerRoot: string | null): boolean {
    return callerRoot !== null && resolve(path) === callerRoot;
}

/** Holder rows plus read warnings, one string per line for a refusal message. */
export function livenessReport(liveness: WorktreeLiveness): string[] {
    return [
        ...formatWorktreeHolders(liveness.holders),
        ...liveness.warnings.map((warning) => `warning: ${warning}`),
    ];
}

// ---------------------------------------------------------------------------
// Removal-command parsing
//
// The CLI needs the same answer as the two agent guards for its own tests and
// for the parity check; the hook and Pi copies are byte-equivalent algorithms.
// ---------------------------------------------------------------------------

const MAX_NESTING = 3;
const MAX_SCRIPT_BYTES = 64 * 1024;
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'done', 'fi']);
/** Wrappers that run another command; the real command follows them. */
const WRAPPERS = new Set(['command', 'builtin', 'nohup', 'time', 'exec', 'env', 'sudo', 'xargs', 'nice', 'timeout', 'stdbuf', 'ionice']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
/** Wrapper options that take a value, so the value is not read as the command. */
const WRAPPER_OPERAND_FLAGS = new Set(['-u', '-g', '-p', '-C', '-h', '-n', '-I', '-L', '-P', '-s', '-E', '-d', '-a', '-i', '-o', '-e', '--unset', '--user', '--group']);
/** A redirection token consumes its operand, which is a file, never a target:
 * `git worktree remove 2>/dev/null --force <path>` removes <path>. */
const REDIRECTION = /^(\d*|&)(>>?|<<?)(.*)$/;

function tokenize(command: string): string[][] {
    const segments: string[][] = [];
    let tokens: string[] = [];
    let token = '';
    let hasToken = false;
    let quote: string | null = null;
    let i = 0;

    const pushToken = (): void => {
        if (hasToken) {
            tokens.push(token);
            token = '';
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
            } else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
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
        if (ch === '\\' && i + 1 < command.length) {
            token += command[i + 1];
            hasToken = true;
            i += 2;
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\r') {
            pushToken();
            i += 1;
            continue;
        }
        if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
            pushSegment();
            i += 1;
            continue;
        }
        if (ch === '#' && !hasToken) {
            while (i < command.length && command[i] !== '\n') i += 1;
            continue;
        }
        token += ch;
        hasToken = true;
        i += 1;
    }
    pushSegment();
    return segments;
}

/** True when the shell, not the text, decides the path (`$w`, `$(...)`, a glob). */
export function targetIsUnresolved(target: string | undefined): boolean {
    if (!target) return true;
    return /[$`*?[\]{}~]/.test(target);
}

export interface RemovalOperation {
    kind: 'git-worktree-remove' | 'rm' | 'find-delete' | 'script' | 'shell';
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
        if (token === '&>' || token === '&>>') {
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
        const base = tokens[start].split('/').pop() ?? tokens[start];
        if (!WRAPPERS.has(base)) break;
        start += 1;
        while (start < tokens.length) {
            const token = tokens[start];
            if (/^\d+[smhd]?$/.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
                start += 1;
                continue;
            }
            if (!token.startsWith('-')) break;
            start += WRAPPER_OPERAND_FLAGS.has(token) ? 2 : 1;
        }
    }
    while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start += 1;
    return start;
}

function operationsFromSegment(raw: string[], depth: number): RemovalOperation[] {
    const operations: RemovalOperation[] = [];
    const tokens = stripRedirections(raw.filter(token => !SHELL_KEYWORDS.has(token)));
    const start = commandIndex(tokens);
    const commandName = tokens[start];
    if (!commandName) return operations;
    const name = commandName.split('/').pop() ?? commandName;
    const rest = tokens.slice(start + 1);
    const record = (kind: RemovalOperation['kind'], targets: string[], extra: Partial<RemovalOperation> = {}): void => {
        operations.push({ kind, targets, raw: raw.join(' '), ...extra });
    };

    if (SHELLS.has(name) || name === 'eval') {
        const cIndex = name === 'eval' ? -1 : rest.findIndex(token => /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
        if (name === 'eval' || cIndex >= 0) {
            const program = name === 'eval' ? rest.join(' ') : rest[cIndex + 1];
            if (program) {
                record('shell', [], { program });
                if (depth < MAX_NESTING) operations.push(...removalOperations(program, depth + 1));
            }
            return operations;
        }
        const script = rest.find(token => !token.startsWith('-'));
        if (script) record('script', [script]);
        return operations;
    }

    if (name === 'git') {
        const worktreeAt = tokens.indexOf('worktree', start + 1);
        if (worktreeAt < 0 || tokens[worktreeAt + 1] !== 'remove') return operations;
        const target = tokens.slice(worktreeAt + 2).find(token => !token.startsWith('-'));
        record('git-worktree-remove', target ? [target] : []);
        return operations;
    }

    if (name === 'rm') {
        const args = stripRedirections(rest);
        const recursive = args.some(arg => arg === '--recursive' || /^-[A-Za-z]*[rR]/.test(arg));
        if (recursive) record('rm', args.filter(arg => !arg.startsWith('-')));
        return operations;
    }

    if (name === 'find') {
        const args = stripRedirections(rest);
        if (!args.includes('-delete')) return operations;
        const root = args.find(token => !token.startsWith('-'));
        record('find-delete', root ? [root] : []);
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
