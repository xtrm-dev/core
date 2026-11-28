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

import { spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

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
    /** Total budget for every tmux query; a DoS bound, not a tuning knob. */
    tmuxBudgetMs?: number;
    env?: NodeJS.ProcessEnv;
    uid?: number;
    readCommand?: (pid: number) => string;
    commandTimeoutMs?: number;
    /** Holders whose presence is legitimate (a release's own pane and ancestry). */
    exemptPids?: Iterable<number>;
}

const PANE_FORMAT = ['#{pane_id}', '#{pane_pid}', '#{pane_current_command}', '#{pane_current_path}', '#{@agent_worktree}'].join('\t');

function isInside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(`${parent}${sep}`);
}

function resolvePath(value: string): string {
    return resolve(value);
}


/** Map every readable process cwd on this host. Unreadable entries are skipped. */
export function readProcessCwds(procRoot = '/proc'): Map<string, number[]> {
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
            target = readlinkSync(join(procRoot, entry, 'cwd'));
        } catch {
            continue;
        }
        // The kernel renders a cwd whose directory was removed as "<path> (deleted)",
        // which would never equal the real directory.
        if (target.endsWith(' (deleted)')) target = target.slice(0, -' (deleted)'.length);
        const existing = cwds.get(target);
        if (existing) existing.push(pid);
        else cwds.set(target, [pid]);
    }
    return cwds;
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

/** Total time a hook may spend asking tmux. Three hung sockets stay bounded. */
export const TMUX_QUERY_BUDGET_MS = 250;
/** Slice per socket, so several sockets still get an answer inside the budget. */
const TMUX_SOCKET_SLICE_MS = 60;

/** A socket this process may trust: it is a socket, this uid owns it, and its
 * directory is owner-only. A world-writable directory can point a guard at a
 * server someone else controls, and a scan of /tmp at large is the DoS the
 * audit found. */
function trustedSocket(socket: string, uid: number): boolean {
    try {
        const stat = lstatSync(socket);
        if (!stat.isSocket()) return false;
        if (typeof stat.uid === 'number' && stat.uid !== uid) return false;
        return trustedOwnerOnlyDir(dirname(socket), uid);
    } catch {
        return false;
    }
}

function trustedOwnerOnlyDir(dir: string, uid: number): boolean {
    try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) return false;
        if (typeof stat.uid === 'number' && stat.uid !== uid) return false;
        return (stat.mode & 0o077) === 0;
    } catch {
        return false;
    }
}

/**
 * Sockets of every tmux server this user can reach.
 *
 * `$TMUX` names the server hosting the caller. Everything else is discovered by
 * listing `<TMUX_TMPDIR>/tmux-<uid>` (tmux's own layout), so a server started
 * with `-S <full path>` is found when its socket lives there. A private
 * `TMUX_TMPDIR` is scanned as given: that is where a test puts a socket.
 *
 * A directory is only scanned when this uid owns it and its mode is 0700. That
 * rule alone keeps a scan out of /tmp at large, where any user may leave a
 * socket that makes the guard wait on a server it does not control.
 */
export function discoverTmuxSockets(
    env: NodeJS.ProcessEnv = process.env,
    uid = typeof process.getuid === 'function' ? process.getuid() : 0,
): string[] {
    const base = env.TMUX_TMPDIR && env.TMUX_TMPDIR.length > 0 ? env.TMUX_TMPDIR : '/tmp';
    const tmuxEnv = env.TMUX?.split(',')[0];

    // The cheap, bounded set first: the caller's own server and this uid's
    // default server. Scanning every socket in the tmp dir means one tmux spawn
    // per stale test socket (~150 on this host) for no liveness gain, because a
    // stale socket cannot host a pane.
    const preferred: string[] = [];
    if (tmuxEnv && trustedSocket(tmuxEnv, uid)) preferred.push(tmuxEnv);
    const defaultSocket = join(base, `tmux-${uid}`, 'default');
    if (trustedSocket(defaultSocket, uid)) preferred.push(defaultSocket);
    if (preferred.length > 0) return [...new Set(preferred)];

    // No live server in the bounded set: fall back to the owner-only directories
    // for a private socket, capped so a directory full of dead probes cannot
    // dominate a call. /tmp itself (mode 1777) is never scanned unless the caller
    // set TMUX_TMPDIR to a directory only they can write.
    const sockets: string[] = [];
    const addSocketEntries = (dir: string): void => {
        if (!trustedOwnerOnlyDir(dir, uid)) return;
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (sockets.length >= 20) return;
            const full = join(dir, entry.name);
            if (trustedSocket(full, uid)) sockets.push(full);
        }
    };
    addSocketEntries(join(base, `tmux-${uid}`));
    if (base !== '/tmp') addSocketEntries(base);

    return [...new Set(sockets)];
}

/** Free text from a pane, safe to print in a refusal: no control characters,
 * bounded length. */
export function sanitizeHolderText(value: string, max = 120): string {
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Read every pane on every reachable server. The whole read has one deadline:
 * a hung socket costs its slice, never the hook's patience. A failed or skipped
 * server becomes a warning. */
export function readTmuxPanes(options: WorktreeInUseOptions = {}): { panes: PaneRecord[]; warnings: string[] } {
    if (options.panes) return { panes: options.panes, warnings: [] };
    if (options.skipTmux) return { panes: [], warnings: [] };

    const sockets = options.tmuxSockets ?? discoverTmuxSockets(options.env ?? process.env, options.uid);
    const panes: PaneRecord[] = [];
    const warnings: string[] = [];
    const deadline = Date.now() + (options.tmuxBudgetMs ?? TMUX_QUERY_BUDGET_MS);

    for (const socket of sockets) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            warnings.push(`tmux query budget of ${options.tmuxBudgetMs ?? TMUX_QUERY_BUDGET_MS} ms exhausted; ${socket} not queried`);
            continue;
        }
        const result = spawnSync('tmux', ['-S', socket, 'list-panes', '-a', '-F', PANE_FORMAT], {
            encoding: 'utf8',
            timeout: Math.min(options.commandTimeoutMs ?? TMUX_SOCKET_SLICE_MS, remaining),
            env: { ...(options.env ?? process.env), TMUX: '' },
        });
        if (result.error || result.status !== 0) {
            const detail = result.error?.message
                ?? (result.stderr ?? '').trim()
                ?? `exit ${result.status ?? 'unknown'}`;
            warnings.push(`tmux list-panes on ${socket} failed: ${sanitizeHolderText(detail.split('\n')[0])}`);
            continue;
        }

        for (const line of (result.stdout ?? '').split('\n')) {
            if (!line.trim()) continue;
            const [paneId = '', panePid = '', paneCommand = '', panePath = '', agentWorktree = ''] = line.split('\t');
            panes.push({
                paneId: sanitizeHolderText(paneId, 32),
                panePid: Number.parseInt(panePid, 10) || 0,
                paneCommand: sanitizeHolderText(paneCommand, 80),
                panePath: sanitizeHolderText(panePath, 240),
                agentWorktree: sanitizeHolderText(agentWorktree, 240),
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
 *
 * Passing `cwds` and `panes` makes the answer depend only on that evidence, which
 * is what tests use. A probe created once and reused for many paths is the cheap
 * shape for `clean` and `reap`; a removal re-reads right before it acts.
 */
export function worktreeInUse(worktreePath: string, options: WorktreeInUseOptions = {}): WorktreeLiveness {
    // /proc/<pid>/cwd is kernel-real; a repo root reached through a symlink would
    // otherwise never match a holder.
    const path = canonicalPath(worktreePath);
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

    const exempt = options.exemptPids ? new Set(options.exemptPids) : null;
    const blocking = exempt && exempt.size > 0 ? holders.filter(holder => !exempt.has(holder.pid)) : holders;
    blocking.sort((a, b) => a.pid - b.pid || a.kind.localeCompare(b.kind));
    return { path, live: blocking.length > 0, holders: blocking, warnings };
}

/** One human line per holder, for a refusal message that names who is there. */
export function formatWorktreeHolders(holders: readonly WorktreeHolder[]): string[] {
    return holders.map(holder => {
        if (holder.kind === 'pane') {
            return `tmux pane ${sanitizeHolderText(holder.pane ?? '(unknown)', 32)} (pid ${holder.pid}, ${sanitizeHolderText(holder.command)}) at ${sanitizeHolderText(holder.path, 240)}`;
        }
        return `pid ${holder.pid} (${sanitizeHolderText(holder.command)}) cwd ${sanitizeHolderText(holder.path, 240)}`;
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
const WRAPPERS = new Set([
    'command', 'builtin', 'nohup', 'time', 'exec', 'env', 'sudo', 'xargs', 'nice', 'timeout',
    'stdbuf', 'ionice', 'setsid', 'flock', 'parallel',
]);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
/** Wrapper options that take a separate value, per wrapper: `sudo -p prompt` takes
 * one, `command -p` does not, so a shared table hides the wrapped command. */
const WRAPPER_OPERAND_FLAGS: Record<string, Set<string>> = {
    command: new Set(),
    builtin: new Set(),
    exec: new Set(['-a']),
    nohup: new Set(),
    time: new Set(['-f', '-o', '--format', '--output']),
    env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
    sudo: new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-T', '-D', '-R', '-a', '--user', '--group', '--prompt', '--close-from', '--host', '--role', '--type', '--other-user', '--chdir', '--auth-type']),
    xargs: new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars']),
    nice: new Set(['-n', '--adjustment']),
    timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
    stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
    ionice: new Set(['-c', '-n', '-p', '-P', '-u']),
    setsid: new Set(),
    flock: new Set(['-w', '-E', '--timeout', '--conflict-exit-code']),
    parallel: new Set(['-j', '--jobs', '-S', '--sshlogin', '--sshloginfile', '--colsep', '--delimiter', '-n', '--max-args', '-L', '--max-lines', '--header', '--results', '--tmpdir', '--joblog', '--timeout', '--retries', '--delay', '--load', '--memfree', '-I', '--replace', '--block', '-N']),
};

function wrapperSkipsOperand(wrapper: string, token: string): boolean {
    const flags = WRAPPER_OPERAND_FLAGS[wrapper];
    return flags ? flags.has(token) : false;
}
/** A redirection token consumes its operand, which is a file, never a target:
 * `git worktree remove 2>/dev/null --force <path>` removes <path>. */
const REDIRECTION = /^(\d*|&)(>>?|<<?)(.*)$/;
/** find actions that run a command; a `rm` inside one removes the searched tree. */
const EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/** A removal verb in text the parser cannot turn into an operation. */
const REMOVAL_VERB = /(?:^|[\s;&|(])(?:[^\s;&|()]*\/)?rm\s+(?:-[A-Za-z]*[rR]|--recursive)\b|worktree\s+remove\b|-delete\b|-exec(?:dir)?\s+(?:[^\s;&|()]*\/)?rm\b/;

export function hasRemovalVerb(text: string): boolean {
    return REMOVAL_VERB.test(text);
}

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
                // `$(...)` is one word of the outer command, not a subshell of it: keep it
        // whole so the command word and target stay recognisable.
        if (ch === '$' && command[i + 1] === '(') {
            let depth = 0;
            let j = i + 1;
            for (; j < command.length; j += 1) {
                if (command[j] === '(') depth += 1;
                else if (command[j] === ')') {
                    depth -= 1;
                    if (depth === 0) break;
                }
            }
            if (j < command.length) {
                token += command.slice(i, j + 1);
                hasToken = true;
                i = j + 1;
                continue;
            }
        }
token += ch;
        hasToken = true;
        i += 1;
    }
    pushSegment();
    return segments;
}

/** Program text of `$(...)` and `` `...` `` substitutions: they run before the
 * command that contains them, so a removal inside one still removes. */
function substitutionPrograms(command: string): string[] {
    const programs: string[] = [];
    let i = 0;
    while (i < command.length) {
        if (command[i] === '`') {
            const end = command.indexOf('`', i + 1);
            if (end < 0) break;
            programs.push(command.slice(i + 1, end));
            i = end + 1;
            continue;
        }
        if (command[i] === '$' && command[i + 1] === '(') {
            let depth = 0;
            let j = i + 1;
            for (; j < command.length; j += 1) {
                if (command[j] === '(') depth += 1;
                else if (command[j] === ')') {
                    depth -= 1;
                    if (depth === 0) break;
                }
            }
            if (j >= command.length) break;
            programs.push(command.slice(i + 2, j));
            i = j + 1;
            continue;
        }
        i += 1;
    }
    return programs;
}

/** True when the shell, not the text, decides the path (`$w`, `$(...)`, a glob). */
export function targetIsUnresolved(target: string | undefined): boolean {
    if (!target) return true;
    return /[$`*?[\]{}~]/.test(target);
}

/** The literal directory prefix of a target the shell expands: `/tmp/x/$V`
 * bounds to `/tmp/x`, `../*` bounds to the parent. Null means unbounded: a bare
 * `$X`, `~`, or a relative target with no known cwd could be anything. */
export function targetBound(target: string | undefined, cwd: string | null): string | null {
    if (!target) return cwd;
    const unresolvedAt = target.search(/[$`*?[\]{}~]/);
    const literal = unresolvedAt < 0 ? target : target.slice(0, unresolvedAt);
    if (unresolvedAt === 0) return null; // `$X`, `~`, a leading glob
    if (literal.startsWith('/')) return literal.replace(/\/+$/, '') || '/';
    if (!cwd) return null;
    const trimmed = literal.replace(/\/+$/, '');
    return trimmed === '' ? cwd : resolve(cwd, trimmed);
}

export interface RemovalOperation {
    kind: 'git-worktree-remove' | 'rm' | 'find-delete' | 'script';
    targets: string[];
    raw: string;
    /** Working directory the targets are relative to; null when a `cd` made it
     * unknown. */
    cwd?: string | null;
    /** The nested program of a `sh -c` / `eval` / script file, when it was read. */
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

/** The file a redirection reads as the program: `bash < script.sh`. */
function inputRedirect(tokens: string[]): string | null {
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token === '<') return tokens[i + 1] ?? null;
        const match = /^<(.+)$/.exec(token);
        if (match) return match[1];
    }
    return null;
}

/** Index of the command word after wrappers, their options and assignments. */
function commandIndex(tokens: string[]): number {
    let start = 0;
    let flockOperand = false;
    for (;;) {
        if (start >= tokens.length) return start;
        const base = tokens[start].split('/').pop() ?? tokens[start];
        if (!WRAPPERS.has(base)) break;
        if (base === 'flock') flockOperand = true;
        start += 1;
        while (start < tokens.length) {
            const token = tokens[start];
            if (/^\d+[smhd]?$/.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
                start += 1;
                continue;
            }
            if (!token.startsWith('-')) break;
            start += wrapperSkipsOperand(base, token) ? 2 : 1;
        }
        // flock's next positional is the lock file, not the command.
        if (flockOperand && start < tokens.length && !tokens[start].startsWith('-')) {
            start += 1;
            flockOperand = false;
        }
    }
    while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start += 1;
    return start;
}

/** The git config key that defines an alias: `alias.<name>`, or a qualified form. */
const ALIAS_KEY = /^(?:.*\.)?alias\.([^.=]+)$/;
/** Git global options that take a separate value before the subcommand. */
const GIT_GLOBAL_OPERAND_FLAGS = new Set(['-c', '--config', '--config-env', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--shallow-file', '--attr-source']);

function addGitAlias(config: string, aliases: Map<string, string>, envAliases: Set<string>, fromEnv = false): void {
    const eq = config.indexOf('=');
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
        if (token === '-c' || token === '--config') {
            addGitAlias(tokens[i + 1] ?? '', aliases, envAliases);
            i += 2;
            continue;
        }
        if (token.startsWith('-c') && token.length > 2) {
            addGitAlias(token.slice(2), aliases, envAliases);
            i += 1;
            continue;
        }
        if (token === '--config-env') {
            addGitAlias(tokens[i + 1] ?? '', aliases, envAliases, true);
            i += 2;
            continue;
        }
        if (token.startsWith('--config-env=')) {
            addGitAlias(token.slice('--config-env='.length), aliases, envAliases, true);
            i += 1;
            continue;
        }
        if (!token.startsWith('-')) break;
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
    record: (kind: RemovalOperation['kind'], targets: string[], extra?: Partial<RemovalOperation>) => void,
    operations: RemovalOperation[],
    depth: number,
    cwd: string | null,
): RemovalOperation[] {
    const { subcommandAt, aliases, envAliases } = parseGitPrefix(tokens, start + 1);
    const subcommand = tokens[subcommandAt] ?? '';
    const args = tokens.slice(subcommandAt + 1);
    const aliasValue = aliases.get(subcommand);
    if (aliasValue !== undefined) {
        if (depth >= MAX_NESTING) return operations;
        const program = aliasValue.startsWith('!')
            ? `${aliasValue.slice(1)} ${args.join(' ')}`
            : `git ${aliasValue} ${args.join(' ')}`;
        operations.push(...removalOperations(program, depth + 1, cwd));
        return operations;
    }
    if (envAliases.has(subcommand)) {
        record('git-worktree-remove', args.filter(token => !token.startsWith('-')));
        return operations;
    }
    if (subcommand !== 'worktree' || args[0] !== 'remove') return operations;
    const target = args.slice(1).find(token => !token.startsWith('-'));
    record('git-worktree-remove', target ? [target] : []);
    return operations;
}

interface ParseState {
    cwd: string | null;
}

/** A script the parser can read is parsed as its own program; one it cannot read
 * (a missing file, a non-shell binary) is reported as a script operation. */
function readScript(path: string | null): string | null {
    if (!path) return null;
    try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return null;
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

function localScript(token: string | undefined, cwd: string | null): string | null {
    if (!token || targetIsUnresolved(token)) return null;
    if (token.startsWith('/')) return token;
    return cwd ? resolve(cwd, token) : null;
}

/** Track `cd` / `pushd` through `&&`, `;`, `||`: a relative target after a `cd`
 * is relative to the new directory, and an unresolvable `cd` makes it unknown. */
function trackDirectory(name: string, rest: string[], state: ParseState): void {
    const target = rest.find(token => token !== '-P' && token !== '-L' && !token.startsWith('-'));
    if (!target || target === '-') {
        state.cwd = null;
        return;
    }
    if (targetIsUnresolved(target)) {
        state.cwd = null;
        return;
    }
    if (target.startsWith('/')) {
        state.cwd = resolve(target);
        return;
    }
    state.cwd = state.cwd ? resolve(state.cwd, target) : null;
}

function operationsFromSegment(raw: string[], depth: number, state: ParseState): RemovalOperation[] {
    const operations: RemovalOperation[] = [];
    const unfiltered = stripRedirections(raw.filter(token => !SHELL_KEYWORDS.has(token)));

    // `parallel rm -rf {} ::: a b`: each `:::`-separated group is a command.
    const leading = unfiltered[0] ?? '';
    if (leading === 'parallel' || leading.endsWith('/parallel')) {
        const groups: string[][] = [[]];
        for (const token of unfiltered.slice(1)) {
            if (token === ':::') groups.push([]);
            else groups[groups.length - 1].push(token);
        }
        for (const group of groups) {
            if (group.length > 0 && depth < MAX_NESTING) operations.push(...removalOperations(group.join(' '), depth + 1, state.cwd));
        }
        return operations;
    }

    const start = commandIndex(unfiltered);
    const commandName = unfiltered[start];
    if (!commandName) return operations;
    const name = commandName.split('/').pop() ?? commandName;
    const rest = unfiltered.slice(start + 1);
    const record = (kind: RemovalOperation['kind'], targets: string[], extra: Partial<RemovalOperation> = {}): void => {
        operations.push({ kind, targets, raw: raw.join(' '), cwd: state.cwd, ...extra });
    };

    if (name === 'cd' || name === 'pushd') {
        trackDirectory(name, rest, state);
        return operations;
    }

    // A command word the shell computes, such as `$(which rm) -rf live`: the
    // executable is unknown, so a removal flag in the arguments makes it a
    // removal of the literal arguments.
    if (/[$`]/.test(name) && rest.some(token => token === '--recursive' || /^-[A-Za-z]*[rR]/.test(token))) {
        record('rm', rest.filter(token => !token.startsWith('-') && !/[$`]/.test(token)));
        return operations;
    }

    if (SHELLS.has(name) || name === 'eval') {
        const cIndex = name === 'eval' ? -1 : rest.findIndex(token => /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
        if (name === 'eval' || cIndex >= 0) {
            const program = name === 'eval' ? rest.join(' ') : rest[cIndex + 1];
            if (program && depth < MAX_NESTING) operations.push(...removalOperations(program, depth + 1, state.cwd));
            return operations;
        }
        // `bash < script`, `bash script`: the program text comes from a file.
        const scriptToken = rest.find(token => !token.startsWith('-') && !token.startsWith('<'));
        const program = readScript(localScript(inputRedirect(raw) ?? scriptToken, state.cwd));
        if (program !== null && depth < MAX_NESTING) operations.push(...removalOperations(program, depth + 1, state.cwd));
        else if (program === null && (scriptToken || inputRedirect(raw))) {
            record('script', [scriptToken ?? inputRedirect(raw) ?? '']);
        }
        return operations;
    }

    if (name === 'source' || name === '.') {
        const program = readScript(localScript(rest.find(token => !token.startsWith('-')), state.cwd));
        if (program !== null && depth < MAX_NESTING) operations.push(...removalOperations(program, depth + 1, state.cwd));
        return operations;
    }

    // `./script.sh` and any other executable file the parser can read.
    if (commandName.includes('/')) {
        const program = readScript(localScript(commandName, state.cwd));
        if (program !== null && depth < MAX_NESTING) operations.push(...removalOperations(program, depth + 1, state.cwd));
        else record('script', [commandName]);
        return operations;
    }

    if (name === 'parallel') {
        // `parallel rm -rf {} ::: a b`: each `:::`-separated group is a command.
        const groups: string[][] = [[]];
        for (const token of rest) {
            if (token === ':::') groups.push([]);
            else groups[groups.length - 1].push(token);
        }
        for (const group of groups) {
            if (group.length > 0 && depth < MAX_NESTING) operations.push(...removalOperations(group.join(' '), depth + 1, state.cwd));
        }
        return operations;
    }

    if (name === 'git') {
        return gitRemovalOperations(unfiltered, start, record, operations, depth, state.cwd);
    }

    if (name === 'rm') {
        const args = rest;
        const recursive = args.some(arg => arg === '--recursive' || /^-[A-Za-z]*[rR]/.test(arg));
        if (recursive) record('rm', args.filter(arg => !arg.startsWith('-')));
        return operations;
    }

    if (name === 'find') {
        const args = rest;
        const root = args.find(token => !token.startsWith('-') && !token.startsWith('(')) ?? '.';
        if (args.includes('-delete')) record('find-delete', [root]);
        for (let i = 0; i < args.length; i += 1) {
            if (!EXEC_ACTIONS.has(args[i])) continue;
            const sub = args.slice(i + 1).filter(token => token !== '{}' && token !== '+' && token !== ';');
            if (sub.some(token => token === 'rm' || token.endsWith('/rm')) || hasRemovalVerb(sub.join(' '))) {
                record('find-delete', [root]);
            }
        }
    }
    return operations;
}

/**
 * Removal operations in a shell command, in execution order.
 * `targets` is always an array; an empty array or an unresolved entry means the
 * path is not statically known, and `cwd` says what a relative one is relative to.
 */
export function removalOperations(command: string, depth = 0, cwd: string | null = null): RemovalOperation[] {
    const operations: RemovalOperation[] = [];
    const state: ParseState = { cwd };
    for (const raw of tokenize(command)) operations.push(...operationsFromSegment(raw, depth, state));
    if (depth < MAX_NESTING) {
        for (const program of substitutionPrograms(command)) {
            operations.push(...removalOperations(program, depth + 1, cwd));
        }
    }
    return operations;
}
