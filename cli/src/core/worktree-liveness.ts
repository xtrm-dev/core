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
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

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
    /** Total budget for every tmux query; a DoS bound, not a tuning knob. */
    tmuxBudgetMs?: number;
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
export const TMUX_QUERY_BUDGET_MS = 55;
/** Slice per socket, so several sockets still get an answer inside the budget. */
const TMUX_SOCKET_SLICE_MS = 20;
/** The xt CLI is not a pre-tool hook: its destructive paths may wait long enough
 * for a cold or loaded server to answer, about 2 s in total (N6). */
export const TMUX_QUERY_BUDGET_CLI_MS = 2000;

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

    const readSocket = (socket: string, slice: number) => spawnSync('tmux', ['-S', socket, 'list-panes', '-a', '-F', PANE_FORMAT], {
        encoding: 'utf8',
        timeout: slice,
        env: { ...(options.env ?? process.env), TMUX: '' },
    });

    for (const socket of sockets) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            warnings.push(`tmux query budget of ${options.tmuxBudgetMs ?? TMUX_QUERY_BUDGET_MS} ms exhausted; ${socket} not queried`);
            continue;
        }
        const slice = Math.min(options.commandTimeoutMs ?? TMUX_SOCKET_SLICE_MS, remaining);
        let result = readSocket(socket, slice);
        // A real server can miss a 20 ms slice on a loaded host, so one retry may use
        // the rest of the budget: a cold server answers, a hung one is reported as a
        // warning when the budget runs out. The deadline still caps the whole read.
        if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' && slice >= TMUX_SOCKET_SLICE_MS) {
            const again = deadline - Date.now();
            if (again > 0) result = readSocket(socket, again);
        }
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
    const { panes, warnings } = readTmuxPanes({ tmuxBudgetMs: TMUX_QUERY_BUDGET_CLI_MS, ...options });
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

/**
 * How deep a nested program is followed: `bash -c "bash -c '...'"`. Past this
 * depth the text is not parsed again, so a removal verb in it blocks as an
 * unbounded target: the parser cannot see what it names (audit round 3).
 */
export function canonicalPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

/** One removal the guard can see in a command, with the targets it names. */
export type RemovalOperation = {
    kind: 'git-worktree-remove' | 'rm' | 'find-delete' | 'warning';
    targets: string[];
    raw: string;
    /** `null` when the directory could not be resolved: never fall back to the caller's cwd. */
    cwd?: string | null;
    warning?: string;
};

/** The git global options that matter before a subcommand. */
interface GitPrefix {
    subcommandAt: number;
    aliases: Map<string, string>;
    envAliases: Set<string>;
    /** The `-C` operands, in order: each one changes the directory (N2). */
    chdirs: string[];
}

/** Shared parse budget, so a fan-out of scripts cannot run long (N7, R4). */
interface ParseContext {
    visited: Set<string>;
    deadline: number;
    unchecked?: number;
    expired: boolean;
}

interface ParseState {
    cwd: string | null;
    ctx: ParseContext;
    /** The environment the shell runs with: `HOME=` changes what `~` means (R7). */
    env: NodeJS.ProcessEnv;
}

type RecordOperation = (
    kind: 'git-worktree-remove' | 'rm' | 'find-delete',
    targets: string[],
    extra?: Record<string, unknown>,
    at?: string | null,
) => void;

const MAX_NESTING = 3;
const MAX_SCRIPT_BYTES = 64 * 1024;
/** Total time spent following script files in one command: a fan-out of scripts
 * that each source the next must not turn the hook into a scanner (N7). */
const PARSE_BUDGET_MS = 40;
/** Scripts a spent fan-out budget may still check for a verb before it blocks
 * the unknown remainder instead (R4). */
const MAX_UNCHECKED_SCRIPTS = 8;
/** Git subcommands that are not aliases: a lookup runs only for an unknown one,
 * so `git status` never costs a spawn (R8). */
const KNOWN_GIT_SUBCOMMANDS = new Set<string>([
  'add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'checkout',
  'cherry-pick', 'clean', 'clone', 'commit', 'config', 'describe', 'diff', 'fetch',
  'format-patch', 'fsck', 'gc', 'grep', 'help', 'init', 'log', 'ls-files', 'maintenance',
  'merge', 'mv', 'notes', 'prune', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote',
  'reset', 'restore', 'revert', 'rev-parse', 'rm', 'shortlog', 'show', 'sparse-checkout',
  'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index',
  'update-ref', 'version', 'whatchanged', 'worktree',
]);
const SHELL_KEYWORDS = new Set<string>(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'done', 'fi']);
/** Wrappers that run another command; the real command follows them. */
const WRAPPERS = new Set<string>([
  'command', 'builtin', 'nohup', 'time', 'exec', 'env', 'sudo', 'xargs', 'nice', 'timeout',
  'stdbuf', 'ionice', 'setsid', 'flock', 'parallel',
]);
const SHELLS = new Set<string>(['sh', 'bash', 'dash', 'zsh', 'ksh']);
/** Wrapper options that take a separate value, per wrapper: `sudo -p prompt` takes
 * one, `command -p` does not, so a shared table hides the wrapped command. */
const WRAPPER_OPERAND_FLAGS: Record<string, Set<string>> = {
  command: new Set<string>(),
  builtin: new Set<string>(),
  exec: new Set<string>(['-a']),
  nohup: new Set<string>(),
  time: new Set<string>(['-f', '-o', '--format', '--output']),
  env: new Set<string>(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set<string>(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-T', '-D', '-R', '-a', '--user', '--group', '--prompt', '--close-from', '--host', '--role', '--type', '--other-user', '--chdir', '--auth-type']),
  xargs: new Set<string>(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars']),
  nice: new Set<string>(['-n', '--adjustment']),
  timeout: new Set<string>(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set<string>(['-i', '-o', '-e', '--input', '--output', '--error']),
  ionice: new Set<string>(['-c', '-n', '-p', '-P', '-u']),
  setsid: new Set<string>(),
  flock: new Set<string>(['-w', '-E', '--timeout', '--conflict-exit-code']),
  parallel: new Set<string>(['-j', '--jobs', '-S', '--sshlogin', '--sshloginfile', '--colsep', '--delimiter', '-n', '--max-args', '-L', '--max-lines', '--header', '--results', '--tmpdir', '--joblog', '--timeout', '--retries', '--delay', '--load', '--memfree', '-I', '--replace', '--block', '-N']),
};

/** GNU rm accepts every unambiguous abbreviation of `--recursive` (R2). */
function isRecursiveFlag(arg: string): boolean {
  if (/^-[A-Za-z]*[rR]/.test(arg)) return true;
  return arg.length >= 4 && arg.startsWith('--') && '--recursive'.startsWith(arg);
}

function wrapperSkipsOperand(wrapper: string, token: string): boolean {
  // A directory flag takes a value on every wrapper, so the value is not the
  // command word (audit round 3).
  if (token === '-C' || token === '--chdir' || token === '-D') return true;
  const flags: Set<string> | undefined = WRAPPER_OPERAND_FLAGS[wrapper];
  return flags ? flags.has(token) : false;
}
/** A redirection token consumes its operand, which is a file, never a target:
 * `git worktree remove 2>/dev/null --force <path>` removes <path>. */
const REDIRECTION = /^(\d*|&)(>>?|<<?)(.*)$/;
/** find actions that run a command; a `rm` inside one removes the searched tree. */
const EXEC_ACTIONS = new Set<string>(['-exec', '-execdir', '-ok', '-okdir']);
/** Commands that delete the file they are given, so `find ... -exec <word>` still
 * removes the tree's contents even without a recursive flag (R3). */
const DELETE_WORDS = new Set<string>(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'trash-put']);
function isDeleteWord(word: string): boolean {
  return DELETE_WORDS.has(word.split('/').pop() ?? word);
}
/** True when text names a removal, matched at token level: a raw-text scan
 * blocks `git push --delete`, `git branch --delete` and a quoted argument that
 * happens to say "worktree remove" (N3). */
export function hasRemovalVerb(text: string): boolean {
  return removalOperations(String(text ?? ''), MAX_NESTING, null).some(op => op.kind !== 'warning');
}

/** The escapes `$'...'` decodes; enough that a removal verb and a path inside
 * one survive, and every other escape keeps its character. */
function ansiEscape(ch: string): string {
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'a': return '\x07';
    case 'b': return '\b';
    case 'f': return '\f';
    case 'v': return '\v';
    case 'e': return '\x1b';
    default: return ch;
  }
}

function tokenize(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let hasToken = false;
  let quote = null;
  let quoteAnsi = false;
  let i = 0;

  const pushToken = () => {
    if (hasToken) {
      tokens.push(token);
      token = '';
      hasToken = false;
    }
  };
  const pushSegment = () => {
    pushToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };

  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        quoteAnsi = false;
      } else if (ch === '\\' && (quote === '"' || quoteAnsi) && i + 1 < command.length) {
        token += quoteAnsi ? ansiEscape(command[i + 1]) : command[i + 1];
        i += 1;
      } else {
        token += ch;
      }
      i += 1;
      continue;
    }
    // `$'...'` (ANSI-C) and `$"..."` (locale) are one quoted word, and the
    // prefix is not part of its text: reading `$'...'` as a word beginning with
    // `$` let `bash -c $'git worktree remove --force <live>'` through.
    if (ch === '$' && (command[i + 1] === "'" || command[i + 1] === '"')) {
      quote = command[i + 1];
      quoteAnsi = quote === "'";
      hasToken = true;
      i += 2;
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

/** Program text of `$(...)` and backtick substitutions: they run before the
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

/** The bound of a target the shell expands: the directory of its complete
 * literal components. `build/$CONFIG` bounds to `build`, `dist/*` to `dist`,
 * `out/x$Y` to `out`, `.xtrm/worktrees/*` to `.xtrm/worktrees`. Null means
 * unbounded: a bare `$X`, `~` or a path with no known cwd could be anything.
 * A partial last component is dropped, never used as the bound (N5). */
export function targetBound(target: string | undefined, cwd: string | null): string | null {
  if (!target) return cwd ?? null;
  const unresolvedAt = target.search(/[$`*?[\]{}~]/);
  if (unresolvedAt === 0) return null;
  const literal = unresolvedAt < 0 ? target : target.slice(0, unresolvedAt);
  const base = /\/$/.test(literal) ? literal : literal.slice(0, literal.lastIndexOf('/') + 1);
  if (base === '') return cwd ?? null;
  if (base.startsWith('/')) return canonicalPath(base.replace(/\/+$/, '') || '/');
  if (!cwd) return null;
  return canonicalPath(resolve(cwd, base.replace(/\/+$/, '') || '.'));
}

/** The directory a `git -C` / `env -C` / `sudo -D` operand names; null when it
 * cannot be known, so everything after it is unresolvable too (N2). */
function changeDirectory(cwd: string | null, dir: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const expanded = expandHome(dir, env);
  if (!expanded || targetIsUnresolved(expanded)) return null;
  if (expanded.startsWith('/')) return canonicalPath(expanded);
  return cwd ? canonicalPath(resolve(cwd, expanded)) : null;
}

/** `$HOME` and `~` come from the environment, so they resolve rather than
 * leaving every target unbounded (N4). */
export function expandHome(token: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.HOME;
  if (!home || typeof token !== 'string') return token;
  if (token === '~') return home;
  if (token.startsWith('~/')) return `${home}/${token.slice(2)}`;
  if (token === '$HOME' || token === '${HOME}') return home;
  if (token.startsWith('$HOME/')) return `${home}/${token.slice(6)}`;
  if (token.startsWith('${HOME}/')) return `${home}/${token.slice(8)}`;
  return token;
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
const GIT_GLOBAL_OPERAND_FLAGS = new Set<string>(['-c', '--config', '--config-env', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--shallow-file', '--attr-source']);

function addGitAlias(config: string, aliases: Map<string, string>, envAliases: Set<string>, fromEnv = false): void {
  const eq = config.indexOf('=');
  if (eq <= 0) return;
  const match = ALIAS_KEY.exec(config.slice(0, eq));
  if (!match) return;
  if (fromEnv) {
    envAliases.add(match[1]);
    return;
  }
  aliases.set(match[1], config.slice(eq + 1));
}

/** Walk the git global options; return the subcommand position and alias table. */
function parseGitPrefix(tokens: string[], from: number): GitPrefix {
  const aliases = new Map<string, string>();
  const envAliases = new Set<string>();
  const chdirs: string[] = [];
  let i = from;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === '-C') {
      chdirs.push(tokens[i + 1] ?? '');
      i += 2;
      continue;
    }
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
  return { subcommandAt: i, aliases, envAliases, chdirs };
}

function gitRemovalOperations(
    tokens: string[],
    start: number,
    record: RecordOperation,
    operations: RemovalOperation[],
    depth: number,
    cwd: string | null,
    ctx: ParseContext | null,
    env: NodeJS.ProcessEnv = process.env,
): RemovalOperation[] {
  const { subcommandAt, aliases, envAliases, chdirs } = parseGitPrefix(tokens, start + 1);
  // `git -C <dir> worktree remove <relative>` removes a path relative to <dir>.
  let gitCwd = cwd;
  for (const dir of chdirs) gitCwd = changeDirectory(gitCwd, dir, env);
  const subcommand = tokens[subcommandAt] ?? '';
  const args = tokens.slice(subcommandAt + 1);
  const aliasValue = aliases.get(subcommand);
  if (aliasValue !== undefined) {
    const program = aliasValue.startsWith('!')
      ? `${aliasValue.slice(1)} ${args.join(' ')}`
      : `git ${aliasValue} ${args.join(' ')}`;
    operations.push(...removalOperations(program, depth + 1, gitCwd, ctx));
    return operations;
  }
  if (envAliases.has(subcommand)) {
    record('git-worktree-remove', args.filter(token => !token.startsWith('-')), {}, gitCwd);
    return operations;
  }
  if (subcommand !== 'worktree' || args[0] !== 'remove') {
    // A persisted alias is authoritative too: `git rmlive <path>` in a repo that
    // sets `alias.rmlive` (R8). Only an unknown subcommand costs a lookup, and
    // the lookup is bounded by the parse budget.
    if (ctx && subcommand && !KNOWN_GIT_SUBCOMMANDS.has(subcommand) && Date.now() <= ctx.deadline) {
      const key = `git-alias\0${gitCwd ?? ''}\0${subcommand}`;
      if (!ctx.visited.has(key)) {
        ctx.visited.add(key);
        const value = gitIn(gitCwd, ['config', '--get', `alias.${subcommand}`]);
        const alias = value ? value.trim() : '';
        if (alias) {
          const program = alias.startsWith('!')
            ? `${alias.slice(1)} ${args.join(' ')}`
            : `git ${alias} ${args.join(' ')}`;
          operations.push(...removalOperations(program, depth + 1, gitCwd, ctx));
        }
      }
    }
    return operations;
  }
  const target = args.slice(1).find(token => !token.startsWith('-'));
  record('git-worktree-remove', target ? [target] : [], {}, gitCwd);
  return operations;
}

/** A script the parser can read is parsed as its own program; one it cannot read
 * (a missing file, a non-shell binary, an executable the guard cannot name) is
 * allowed, never guessed at (N4). */
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

/** Read a script once, inside the parse budget. A second read of the same path
 * would only repeat its operations, and a fan-out past the deadline stops the
 * walk with one warning (N7). */
function readScriptProgram(
    token: string | undefined,
    cwd: string | null,
    state: ParseState,
    operations: RemovalOperation[],
): string | null {
  const path = localScript(expandHome(token), cwd);
  if (!path) return null;
  if (state.ctx.visited.has(path)) return null;
  state.ctx.visited.add(path);
  const program = readScript(path);
  if (program === null) return null;
  if (Date.now() > state.ctx.deadline) {
    state.ctx.unchecked = (state.ctx.unchecked ?? 0) + 1;
    if (!state.ctx.expired) {
      state.ctx.expired = true;
      // The budget is spent, so the rest is not parsed. It is still checked for a
      // removal verb, and a chain longer than MAX_UNCHECKED_SCRIPTS blocks the
      // unknown remainder instead of allowing it (R4).
      operations.push({
        kind: 'warning',
        targets: [],
        raw: '',
        warning: `script fan-out budget spent (${PARSE_BUDGET_MS} ms): remaining scripts were checked for a removal verb only`,
      });
    }
    if (mentionsRemovalVerb(program) || state.ctx.unchecked > MAX_UNCHECKED_SCRIPTS) {
      operations.push({ kind: 'rm', targets: [], raw: '', cwd: state.cwd ?? undefined });
    }
    return null;
  }
  return program;
}

function localScript(token: string | undefined, cwd: string | null): string | null {
  if (!token || targetIsUnresolved(token)) return null;
  if (token.startsWith('/')) return token;
  return cwd ? resolve(cwd, token) : null;
}

/** Track `cd` / `pushd` through `&&`, `;` and `||`: a relative target after a
 * `cd` is relative to the new directory, and an unresolvable `cd` makes it
 * unknown. */
function trackDirectory(rest: string[], state: ParseState): void {
  const target = rest.find(token => token !== '-P' && token !== '-L' && !token.startsWith('-'));
  if (!target || target === '-') {
    state.cwd = null;
    return;
  }
  const expanded = expandHome(target) ?? target;
  if (targetIsUnresolved(expanded)) {
    state.cwd = null;
    return;
  }
  if (expanded.startsWith('/')) {
    state.cwd = resolve(expanded);
    return;
  }
  state.cwd = state.cwd ? resolve(state.cwd, expanded) : null;
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
    // The first group is the command; `{}` stands for each argument of the
    // others, so `parallel rm -rf {} ::: <live>` removes <live> (R1).
    const [command, ...arguments_] = groups;
    if (command && command.length > 0) {
      const args = arguments_.flat();
      const template = command.join(' ');
      if (args.length > 0 && template.includes('{}')) {
        for (const arg of args) {
          operations.push(...removalOperations(template.split('{}').join(arg), depth + 1, state.cwd, state.ctx));
        }
      } else {
        operations.push(...removalOperations(template, depth + 1, state.cwd, state.ctx));
      }
    }
    return operations;
  }

  // `HOME=/x rm -rf ~` changes what `~` means for this command (R7).
  for (const token of unfiltered) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (!assignment) break;
    if (assignment[1] === 'HOME') state.env = { ...state.env, HOME: assignment[2] };
  }

  // `env -S "<command>"` runs the string as a command, so the string is the
  // command word and the flags before it are env's own (R5).
  if ((unfiltered[0] ?? '').split('/').pop() === 'env') {
    for (let i = 1; i < unfiltered.length; i += 1) {
      const token = unfiltered[i];
      const program = token === '-S' || token === '--split-string'
        ? unfiltered[i + 1]
        : (token.startsWith('-S') && token.length > 2 ? token.slice(2) : null);
      if (program) {
        operations.push(...removalOperations(program, depth + 1, state.cwd, state.ctx));
        return operations;
      }
      if (!token.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) break;
    }
  }

  const start = commandIndex(unfiltered);
  const commandName = unfiltered[start];
  if (!commandName) return operations;
  const name = commandName.split('/').pop() ?? commandName;
  const rest = unfiltered.slice(start + 1);
  // `env -C dir cmd` and `sudo -D dir cmd` change the directory the wrapped
  // command runs in, so a relative target after them is relative to dir (N2).
  let opCwd = state.cwd;
  let wrapperName = '';
  for (let i = 0; i < start; i += 1) {
    const token = unfiltered[i];
    const base = token.split('/').pop() ?? token;
    if (WRAPPERS.has(base)) {
      wrapperName = base;
      continue;
    }
    if (token.startsWith('--chdir=')) {
      opCwd = changeDirectory(opCwd, token.slice('--chdir='.length), state.env);
      continue;
    }
    // Every wrapper may name the directory the wrapped command runs in:
    // `env -C`, `command -C`, `sudo -D`, `--chdir[=dir]`, and the joined forms
    // `env -C<dir>` / `sudo -D<dir>` (audit round 3, R6).
    if (token.startsWith('-C') && token.length > 2) {
      opCwd = changeDirectory(opCwd, token.slice(2), state.env);
      continue;
    }
    if (wrapperName === 'sudo' && token.startsWith('-D') && token.length > 2) {
      opCwd = changeDirectory(opCwd, token.slice(2), state.env);
      continue;
    }
    if (token === '-C' || token === '--chdir' || (wrapperName === 'sudo' && token === '-D')) {
      opCwd = changeDirectory(opCwd, unfiltered[i + 1], state.env);
      continue;
    }
    // `env -S "<command>"` runs the string as a command (R5).
    if (wrapperName === 'env' && (token === '-S' || token === '--split-string' || token.startsWith('-S'))) {
      const program = token === '-S' || token === '--split-string' ? unfiltered[i + 1] : token.slice(2);
      if (program) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx));
    }
  }
  const record: RecordOperation = (kind, targets, extra = {}, at = opCwd) => {
    operations.push({ kind, targets: targets.map(target => expandHome(target, state.env) ?? target), raw: raw.join(' '), cwd: at, ...extra });
  };

  if (name === 'cd' || name === 'pushd') {
    trackDirectory(rest, state);
    return operations;
  }

  // `export HOME=/x` changes it for the commands that follow (R7).
  if (name === 'export') {
    for (const token of rest) {
      const assignment = /^HOME=(.*)$/.exec(token);
      if (assignment) state.env = { ...state.env, HOME: assignment[1] };
    }
    return operations;
  }

  // A command word the shell computes, such as `$(which rm) -rf live`: the
  // executable is unknown, so a removal flag in the arguments makes it a removal
  // of the literal arguments.
  if (/[$`]/.test(name) && rest.some(token => isRecursiveFlag(token))) {
    record('rm', rest.filter(token => !token.startsWith('-') && !/[$`]/.test(token)));
    return operations;
  }

  // A command word that is more than one word is a command string, not a
  // program path (`env -S "<command>"` leaves it as the command word) (R5).
  if (/\s/.test(commandName)) {
    operations.push(...removalOperations(commandName, depth + 1, opCwd, state.ctx));
    return operations;
  }

  if (SHELLS.has(name) || name === 'eval') {
    const cIndex = name === 'eval' ? -1 : rest.findIndex(token => /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
    if (name === 'eval' || cIndex >= 0) {
      const program = name === 'eval' ? rest.join(' ') : rest[cIndex + 1];
      if (program) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx));
      return operations;
    }
    // `bash < script`, `bash script`: the program text comes from a file.
    const scriptToken = rest.find(token => !token.startsWith('-') && !token.startsWith('<'));
    const program = readScriptProgram(inputRedirect(raw) ?? scriptToken, state.cwd, state, operations);
    if (program !== null) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx));
    return operations;
  }

  if (name === 'source' || name === '.') {
    const program = readScriptProgram(rest.find(token => !token.startsWith('-')), state.cwd, state, operations);
    if (program !== null) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx));
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
      if (group.length > 0) operations.push(...removalOperations(group.join(' '), depth + 1, opCwd, state.ctx));
    }
    return operations;
  }

  if (name === 'git') return gitRemovalOperations(unfiltered, start, record, operations, depth, opCwd, state.ctx, state.env);

  if (name === 'rm') {
    const args = rest;
    const recursive = args.some(arg => isRecursiveFlag(arg));
    if (recursive) record('rm', args.filter(arg => !arg.startsWith('-')));
    return operations;
  }

  if (name === 'find') {
    const args = rest;
    const root = args.find(token => !token.startsWith('-') && !token.startsWith('(')) ?? '.';
    if (args.includes('-delete')) record('find-delete', [root]);
    for (let i = 0; i < args.length; i += 1) {
      if (!EXEC_ACTIONS.has(args[i])) continue;
      // The payload is a command, parsed the same way as any other. `{}` is the
      // file find selected, so it stands for find's start path: the search root
      // is what a removal there would destroy (R3).
      const payload: string[] = [];
      for (let j = i + 1; j < args.length; j += 1) {
        const token = args[j];
        if (token === ';' || token === '+' || token === '\\;') break;
        payload.push(token.split('{}').join(root));
      }
      if (payload.length === 0) continue;
      const nested = operationsFromSegment(payload, depth, { cwd: opCwd, ctx: state.ctx, env: state.env });
      if (nested.some(op => op.kind !== 'warning') || payload.some(isDeleteWord)) record('find-delete', [root]);
    }
  }

  // An executable the parser cannot name, such as `./script.sh`: read it as a
  // script. This runs AFTER the known verbs, so `/usr/bin/git worktree remove`
  // and `/bin/rm -rf` are recognised by their basename, never read as a script.
  // One it cannot read is allowed: an unknown executable is not a removal (N4).
  if (commandName.includes('/')) {
    const program = readScriptProgram(commandName, state.cwd, state, operations);
    if (program !== null) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx));
  }
  return operations;
}

/**
 * Removal operations in a shell command, in execution order.
 * `targets` is always an array; an empty array or an unresolved entry means the
 * path is not statically known, and `cwd` says what a relative one is relative to.
 */
export function removalOperations(
    command: string,
    depth = 0,
    cwd: string | null = null,
    ctx: ParseContext | null = null,
): RemovalOperation[] {
  const context: ParseContext = ctx ?? { visited: new Set<string>(), deadline: Date.now() + PARSE_BUDGET_MS, expired: false };
  const operations: RemovalOperation[] = [];
  // Past the cap the text is checked for a removal verb but not parsed, so a
  // literal target deeper than the cap blocks as an unbounded one instead of
  // slipping through (audit round 3).
  if (depth > MAX_NESTING) {
    if (mentionsRemovalVerb(command)) {
      operations.push({ kind: 'rm', targets: [], raw: String(command), cwd: cwd ?? undefined });
    }
    return operations;
  }
  const state: ParseState = { cwd, ctx: context, env: { ...process.env } };
  for (const raw of tokenize(command)) operations.push(...operationsFromSegment(raw, depth, state));
  for (const program of substitutionPrograms(command)) {
    operations.push(...removalOperations(program, depth + 1, cwd, context));
  }
  return operations;
}

/** Token-level removal check on text that is not parsed further (the nesting
 * cap). It asks whether the words name a removal, so a quoted argument still
 * does not count (N3). */
function mentionsRemovalVerb(text: string): boolean {
  let remaining = String(text ?? '');
  // A `bash -c` at the cap hides one more level, so follow the wrapper chain a
  // bounded number of rounds without parsing the rest of the command.
  for (let round = 0; round < 8 && remaining; round += 1) {
    let program = null;
    for (const raw of tokenize(remaining)) {
      const tokens = stripRedirections(raw);
      const start = commandIndex(tokens);
      const name = (tokens[start] ?? '').split('/').pop() ?? '';
      const rest = tokens.slice(start + 1);
      if (name === 'rm' && rest.some(arg => isRecursiveFlag(arg))) return true;
      if (name === 'find' && (rest.includes('-delete') || (rest.includes('rm') && rest.some(arg => EXEC_ACTIONS.has(arg))))) return true;
      if (name === 'git' && rest.some((arg, index) => arg === 'worktree' && rest[index + 1] === 'remove')) return true;
      if (SHELLS.has(name) || name === 'eval') {
        const cIndex = name === 'eval' ? -1 : rest.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
        const nested = name === 'eval' ? rest.join(' ') : rest[cIndex + 1];
        if (nested) program = nested;
      }
    }
    if (!program) return false;
    remaining = program;
  }
  return false;
}

function gitIn(cwd: string | null, args: string[]): string | null {
  if (!cwd) return null;
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1500 } as const);
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? '';
}

/** Every worktree the repository the command runs in registers. Used only to
 * bound a target whose path the shell decides; a literal target is judged
 * against the holders themselves, whatever repo they work in (R1). */
function registeredWorktrees(cwd: string | null): string[] {
  const output = cwd ? gitIn(cwd, ['worktree', 'list', '--porcelain']) : null;
  if (!output) return [];
  return output.split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => canonicalPath(line.slice('worktree '.length).trim()))
    .filter(Boolean);
}

/**
 * A target whose only unresolved part is a glob in its final component is
 * expanded against the filesystem, so `./*.log` is judged by the files it
 * matches while `.xtrm/worktrees/*` still matches a live tree (R1). null means
 * it is not that shape and the bound rule applies.
 */
export function expandTrailingGlob(target: string, cwd: string | null): string[] | null {
  if (!/[*?]/.test(target)) return null;
  const slash = target.lastIndexOf('/');
  const dirPart = slash < 0 ? '.' : (target.slice(0, slash) || '/');
  const pattern = target.slice(slash + 1);
  if (!pattern || targetIsUnresolved(dirPart) || /[$`[\]{}]/.test(pattern)) return null;
  const dir = isAbsolute(dirPart) ? canonicalPath(dirPart) : (cwd ? canonicalPath(resolve(cwd, dirPart)) : null);
  if (!dir) return null;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  const matcher = new RegExp(`^${source}$`);
  return entries.filter(entry => matcher.test(entry)).map(entry => canonicalPath(`${dir}/${entry}`));
}

