/**
 * Worktree release — the in-session counterpart of `xt worktree reap`.
 *
 * `reap` reclaims trees nobody is using, judged by idle age. Release answers a
 * different question, asked by an operator whose cursor is over one pane: "this
 * agent says it is done — may this tree go now?" It therefore runs a stricter
 * predicate: no age exemption, and untracked and ignored work both count. It never
 * forces, never deletes a branch, and it removes the tree only after the pane has
 * been moved out of it.
 *
 * This module evaluates and describes. The tmux conversation and the removal live in
 * commands/worktree.ts so the predicate stays testable without a mutation path.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { livePidsFor, readProcessCwds } from './worktree-reap.js';

/**
 * Every decision, refusal and failure lands here — a keystroke leaves a trace.
 *
 * The log lives with the rest of xt's runtime state, not in the temp directory: a
 * temp-dir log is swept by the host and its mere creation is a test-suite leak
 * (CORE-2612). The path is resolved per call so a test that moves HOME sees it.
 */
export function releaseLogPath(): string {
    const state = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
    return join(state, 'xt', 'worktree-release.log');
}

/** Bounded nudge: a pane message has room for a handful of names, not a manifest. */
export const MAX_NAMED_PATHS = 20;

/**
 * Blocker kinds an agent can clear itself. The nudge is typed only for these; every
 * other blocker is a refusal the operator reads. One list, so the pane path and the
 * predicate cannot drift apart.
 */
export const NUDGEABLE_KINDS: ReadonlySet<string> = new Set([
    'dirty', 'ignored-work', 'skip-worktree', 'unpushed', 'detached-head', 'held-by-process',
]);

/**
 * Foreground commands an agent pane may run. A shell is not an agent: typing into it
 * would execute the nudge text as a command.
 */
export const AGENT_PANE_COMMANDS: readonly string[] = ['node', 'claude', 'codex', 'pi'];

/**
 * Regenerable segments. An ignored path inside one of these holds no work; it is the
 * same set `worktree reap` reclaims, plus the caches adjacent to it.
 */
const REGENERABLE_SEGMENTS = new Set([
    'node_modules', 'dist', '__pycache__', '.pytest_cache', '.venv', 'venv', '.gitnexus', '.next', '.turbo',
]);

/**
 * Known xtrm runtime state, rewritten by tooling on every session. Mirrors the
 * `WORK_EXCLUDED_NAMES` rationale in worktree-reap.ts.
 */
const RUNTIME_STATE_FILES = new Set([
    '.xtrm/session-meta.json', '.xtrm/debug.db', '.xtrm/.last-reap-sweep',
    '.xtrm/skills/state.json', '.substrate-issue',
]);
const RUNTIME_STATE_PREFIXES = ['.xtrm/state/', '.xtrm/cache/'];

/** Scaffolding whose churn is tooling output, not work. */
const SCAFFOLD_PREFIXES = ['.beads/', '.xtrm/', '.claude/', '.pi/'];
const SCAFFOLD_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);

/** Launcher-created links inside `.specialists/` — examined, never created or followed here. */
const SPECIALISTS_LINKS = ['default', 'user'] as const;

const PANE_RE = /^%\d+$/;
const CLIENT_RE = /^[A-Za-z0-9/_.-]+$/;

/** tmux expands format values into a shell; a bad value is refused before it is used. */
export function validatePaneId(value: string): string | null {
    return PANE_RE.test(value) ? null : `pane id must match %<number>, got '${value}'`;
}

export function validateClientName(value: string): string | null {
    return CLIENT_RE.test(value) ? null : `client name must match [A-Za-z0-9/_.-]+, got '${value}'`;
}

function appendLog(line: string): void {
    try {
        const target = releaseLogPath();
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        appendFileSync(target, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {
        // A log that cannot be written must not change a decision.
    }
}

export function logRelease(line: string): void {
    appendLog(line);
}

function git(args: string[], cwd: string, timeoutMs = 30_000): { ok: boolean; out: string; err: string } {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** One entry of `git status --porcelain=v1 -z`. */
export interface StatusEntry {
    status: string;
    path: string;
    /** Rename/copy source, when the entry carries two paths. */
    from?: string;
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * A rename occupies two NUL-separated fields: the entry line carries one path and the
 * next field carries the other. Both are returned and both are classified — which one
 * is old and which is new does not change whether the tree holds work.
 */
export function parseStatusZ(stdout: string): StatusEntry[] {
    const fields = stdout.split('\0');
    const entries: StatusEntry[] = [];

    for (let i = 0; i < fields.length; i += 1) {
        const field = fields[i];
        if (!field || field.length < 4) continue;

        const status = field.slice(0, 2);
        const path = field.slice(3);
        if (/[RC]/.test(status) && i + 1 < fields.length) {
            const next = fields[i + 1];
            if (next) {
                entries.push({ status, path, from: next });
                i += 1;
                continue;
            }
        }
        entries.push({ status, path });
    }

    return entries;
}

export interface ClassifyContext {
    worktree: string;
    repoRoot: string;
    /** `.specialists/<name>` entries verified as the launcher's own links. */
    exemptLinks: ReadonlySet<string>;
}

/**
 * The launcher's `.specialists/{default,user}` links, and only those.
 *
 * A symlink is exempt only when `lstat` says it is a symlink and its target is exactly
 * the relative path the launcher writes. A real directory named `user` (found in one
 * live worktree) is somebody's data and blocks.
 */
export function launcherLinks(worktree: string, repoRoot: string): Set<string> {
    const links = new Set<string>();

    for (const name of SPECIALISTS_LINKS) {
        const target = join(worktree, '.specialists', name);
        const source = join(repoRoot, '.specialists', name);
        const expected = relative(dirname(target), source);

        try {
            if (!lstatSync(target).isSymbolicLink()) continue;
            if (readlinkSync(target) === expected) links.add(name);
        } catch {
            // Absent: nothing to exempt.
        }
    }

    return links;
}

/** True when the path is scaffolding the predicate deliberately ignores. */
export function isScaffoldPath(path: string, ctx: ClassifyContext): boolean {
    if (SCAFFOLD_FILES.has(path)) return true;
    if (SCAFFOLD_PREFIXES.some(prefix => path.startsWith(prefix))) return true;

    if (path === '.specialists' || path.startsWith('.specialists/')) {
        const sub = path.slice('.specialists/'.length).split('/')[0] ?? '';
        return ctx.exemptLinks.has(sub);
    }

    return false;
}

/** Classify a tracked/untracked path: scaffolding is exempt, everything else is work. */
export function classifyPath(path: string, ctx: ClassifyContext): 'exempt' | 'work' {
    return isScaffoldPath(path, ctx) ? 'exempt' : 'work';
}

/**
 * Classify an ignored path. Regenerable artifacts and known runtime state are exempt;
 * anything else (`*.db`, `.env`, a data directory) is work that only a human may delete.
 */
export function classifyIgnored(path: string, ctx: ClassifyContext): 'exempt' | 'artifact' | 'work' {
    if (path.split('/').some(segment => REGENERABLE_SEGMENTS.has(segment))) return 'artifact';
    if (RUNTIME_STATE_FILES.has(path)) return 'exempt';
    if (RUNTIME_STATE_PREFIXES.some(prefix => path.startsWith(prefix))) return 'exempt';
    if (isScaffoldPath(path, ctx)) return 'exempt';
    return 'work';
}

export type ReleaseBlockerKind =
    | 'not-managed'
    | 'not-registered'
    | 'main-checkout'
    | 'detached-head'
    | 'locked'
    | 'submodule'
    | 'dirty'
    | 'ignored-work'
    | 'skip-worktree'
    | 'unpushed'
    | 'expected-head'
    | 'held-by-process'
    | 'unreadable';

export interface ReleaseBlocker {
    kind: ReleaseBlockerKind;
    detail: string;
    /** Paths a nudge must name. Empty for blockers that are not about files. */
    paths: string[];
}

export interface ReleaseFacts {
    worktree: string;
    repoRoot: string;
    branch: string | null;
    head: string | null;
    dirty: string[];
    ignoredWork: string[];
    skipWorktree: string[];
    exemptLinks: string[];
    livePids: number[];
    pushed: string;
}

export interface ReleaseCheck {
    worktree: string;
    repoRoot: string;
    ok: boolean;
    blockers: ReleaseBlocker[];
    facts: ReleaseFacts;
}

/** Process parent map from /proc, for telling an agent's own tree apart from other users. */
export function readPpidMap(procRoot = '/proc'): Map<number, number> {
    const ppids = new Map<number, number>();
    const entries = readdirSync(procRoot);
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const stat = readFileSync(join(procRoot, entry, 'stat'), 'utf8');
            const close = stat.lastIndexOf(')');
            if (close === -1) continue;
            const rest = stat.slice(close + 2).split(' ');
            const ppid = Number(rest[1]);
            if (Number.isFinite(ppid)) ppids.set(Number(entry), ppid);
        } catch {
            // Exited between readdir and read.
        }
    }
    return ppids;
}

/** `rootPid` and all of its descendants. */
export function processTree(rootPid: number, ppids: Map<number, number>): Set<number> {
    const tree = new Set<number>([rootPid]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const [pid, ppid] of ppids) {
            if (tree.has(pid) || !tree.has(ppid)) continue;
            tree.add(pid);
            grew = true;
        }
    }
    return tree;
}

/** This process and its ancestors — the release command always stands inside the tree. */
export function selfAncestry(ppids: Map<number, number>, pid = process.pid): Set<number> {
    const chain = new Set<number>();
    let current: number | undefined = pid;
    while (current && current > 0 && !chain.has(current)) {
        chain.add(current);
        current = ppids.get(current);
    }
    return chain;
}

interface WorktreeListEntry {
    path: string;
    branch: string | null;
    locked: boolean;
}

function parseWorktreeList(stdout: string): WorktreeListEntry[] {
    const entries: WorktreeListEntry[] = [];
    let current: WorktreeListEntry | null = null;

    for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
            if (current) entries.push(current);
            current = { path: line.slice('worktree '.length).trim(), branch: null, locked: false };
            continue;
        }
        if (!current) continue;
        if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).trim();
        else if (line.trim() === 'locked' || line.startsWith('locked ')) current.locked = true;
    }
    if (current) entries.push(current);
    return entries;
}

/**
 * Is the branch already on the remote?
 *
 * Three ways, in order of cost: an upstream that is up to date; HEAD reachable from
 * origin/HEAD; or a merged pull request whose head is exactly this commit. The third
 * exists because this repository squash-merges and deletes the remote branch, so the
 * first two both fail on work that is safely merged.
 */
function pushedStateWith(
    worktree: string,
    branch: string | null,
    head: string,
    lookup: PullRequestLookup,
): { pass: boolean; detail: string } {
    const upstream = git(['rev-list', '--count', '@{upstream}..HEAD'], worktree);
    if (upstream.ok) {
        const count = Number(upstream.out);
        if (Number.isFinite(count)) {
            return count === 0
                ? { pass: true, detail: 'upstream is up to date' }
                : { pass: false, detail: `${count} commit(s) ahead of upstream` };
        }
    }

    for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
        const exists = git(['rev-parse', '--verify', '--quiet', ref], worktree);
        if (!exists.ok || !exists.out) continue;
        const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', ref], {
            cwd: worktree, encoding: 'utf8', stdio: 'pipe',
        });
        if (ancestor.status === 0) return { pass: true, detail: `HEAD is an ancestor of ${ref}` };
    }

    if (!branch) return { pass: false, detail: 'no upstream, no origin ref, and no branch to look a pull request up by' };

    return lookup(worktree, branch, head);
}

type PullRequestLookup = (worktree: string, branch: string, head: string) => { pass: boolean; detail: string };

/** The network lookup, isolated so a test can answer it without `gh`. */
function lookupPullRequest(worktree: string, branch: string, head: string): { pass: boolean; detail: string } {
    const gh = spawnSync('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'state,headRefOid,number', '--limit', '5'], {
        cwd: worktree, encoding: 'utf8', stdio: 'pipe', timeout: 20_000,
    });
    if (gh.status !== 0) {
        // Unknown is a block: a network failure must never read as "already pushed".
        return { pass: false, detail: `no upstream and gh could not confirm a pull request: ${(gh.stderr ?? '').trim().split('\n')[0] || 'unknown error'}` };
    }

    let prs: { state?: string; headRefOid?: string; number?: number }[] = [];
    try {
        prs = JSON.parse(gh.stdout || '[]') as typeof prs;
    } catch {
        return { pass: false, detail: 'no upstream and gh returned unparseable output' };
    }

    const merged = prs.find(pr => pr.state === 'MERGED' && pr.headRefOid === head);
    if (merged) return { pass: true, detail: `merged as PR #${merged.number} with this head` };

    const anyHead = prs.find(pr => pr.headRefOid === head);
    if (anyHead) return { pass: false, detail: `pull request for this head is ${anyHead.state ?? 'unknown'}, not MERGED` };
    return { pass: false, detail: 'no upstream, not an ancestor of origin, and no pull request carries this head' };
}

export interface ReleaseCheckOptions {
    worktree: string;
    repoRoot: string;
    /** Pin the commit the caller validated; a different HEAD refuses. */
    expectHead?: string | null;
    procRoot?: string;
    /** The pane's own process tree: it is about to be respawned out of the tree. */
    allowedPids?: Iterable<number>;
    /** Test seam for the pull-request lookup; production uses `gh pr list`. */
    prLookup?: PullRequestLookup;
}

/** Evaluate every release condition. Nothing here mutates the filesystem. */
export function checkRelease(opts: ReleaseCheckOptions): ReleaseCheck {
    const worktree = resolve(opts.worktree);
    const repoRoot = resolve(opts.repoRoot);
    const blockers: ReleaseBlocker[] = [];
    const facts: ReleaseFacts = {
        worktree, repoRoot, branch: null, head: null,
        dirty: [], ignoredWork: [], skipWorktree: [], exemptLinks: [], livePids: [],
        pushed: 'not checked',
    };

    const managedRoot = join(repoRoot, '.xtrm', 'worktrees');
    if (!(worktree === managedRoot || worktree.startsWith(`${managedRoot}${sep}`))) {
        blockers.push({ kind: 'not-managed', detail: `not under ${managedRoot}`, paths: [worktree] });
        return { worktree, repoRoot, ok: false, blockers, facts };
    }

    const list = git(['worktree', 'list', '--porcelain'], repoRoot);
    if (!list.ok) {
        blockers.push({ kind: 'unreadable', detail: `git worktree list failed: ${list.err || 'unknown error'}`, paths: [] });
        return { worktree, repoRoot, ok: false, blockers, facts };
    }

    const entries = parseWorktreeList(list.out);
    const entry = entries.find(item => resolve(item.path) === worktree);
    if (!entry) {
        blockers.push({ kind: 'not-registered', detail: 'not registered by git — already released', paths: [] });
        return { worktree, repoRoot, ok: false, blockers, facts };
    }
    if (entries[0] && resolve(entries[0].path) === worktree) {
        blockers.push({ kind: 'main-checkout', detail: 'this is the main checkout', paths: [] });
        return { worktree, repoRoot, ok: false, blockers, facts };
    }
    if (entry.locked) blockers.push({ kind: 'locked', detail: 'git worktree is locked', paths: [] });

    const branchRef = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktree);
    if (!branchRef.ok || !branchRef.out) {
        blockers.push({ kind: 'detached-head', detail: 'HEAD is detached', paths: [] });
    } else {
        facts.branch = branchRef.out;
    }

    const head = git(['rev-parse', 'HEAD'], worktree);
    facts.head = head.ok ? head.out : null;
    if (!head.ok) blockers.push({ kind: 'unreadable', detail: 'cannot read HEAD', paths: [] });

    if (opts.expectHead && facts.head && opts.expectHead !== facts.head) {
        blockers.push({
            kind: 'expected-head',
            detail: `HEAD moved since the check: expected ${opts.expectHead.slice(0, 12)}, found ${facts.head.slice(0, 12)}`,
            paths: [],
        });
    }

    if (existsSync(join(worktree, '.gitmodules'))) {
        blockers.push({ kind: 'submodule', detail: 'a submodule can hold work invisible to git status', paths: [] });
    }

    const exempt = launcherLinks(worktree, repoRoot);
    facts.exemptLinks = [...exempt];
    const ctx: ClassifyContext = { worktree, repoRoot, exemptLinks: exempt };

    const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], {
        cwd: worktree, encoding: 'utf8', stdio: 'pipe', timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
    });
    if (status.status !== 0) {
        // Fail closed: an unreadable status is not a clean tree.
        blockers.push({ kind: 'unreadable', detail: `git status failed: ${(status.stderr ?? '').trim() || 'unknown error'}`, paths: [] });
    } else {
        for (const item of parseStatusZ(status.stdout ?? '')) {
            const paths = item.from ? [item.path, item.from] : [item.path];
            if (item.status.startsWith('!!')) {
                for (const path of paths) {
                    if (classifyIgnored(path, ctx) === 'work') facts.ignoredWork.push(path);
                }
                continue;
            }
            for (const path of paths) {
                if (classifyPath(path, ctx) === 'work') facts.dirty.push(path);
            }
        }
    }
    facts.dirty = [...new Set(facts.dirty)];
    facts.ignoredWork = [...new Set(facts.ignoredWork)];

    if (facts.dirty.length > 0) {
        blockers.push({
            kind: 'dirty',
            detail: `${facts.dirty.length} changed path(s) hold work`,
            paths: facts.dirty.slice(0, MAX_NAMED_PATHS),
        });
    }
    if (facts.ignoredWork.length > 0) {
        blockers.push({
            kind: 'ignored-work',
            detail: `${facts.ignoredWork.length} ignored path(s) hold data, not regenerable artifacts`,
            paths: facts.ignoredWork.slice(0, MAX_NAMED_PATHS),
        });
    }

    const tracked = git(['ls-files', '-v'], worktree, 60_000);
    if (!tracked.ok) {
        blockers.push({ kind: 'unreadable', detail: `git ls-files failed: ${tracked.err || 'unknown error'}`, paths: [] });
    } else {
        for (const line of tracked.out.split('\n')) {
            if (line.length < 3) continue;
            const flag = line[0] ?? '';
            const path = line.slice(2);
            const skip = flag === 'S';
            const assume = flag >= 'a' && flag <= 'z';
            if (!skip && !assume) continue;
            // The launcher sets skip-worktree on its own links so checkpoints do not
            // capture phantom deletions; that is expected, not hidden work. Exempt only
            // a path under a link this checkout actually has as a launcher symlink — the
            // same test `isScaffoldPath` uses. A tracked file a user hid with
            // skip-worktree under a real `.specialists/user` directory must still block.
            if (isScaffoldPath(path, ctx)) continue;
            facts.skipWorktree.push(path);
        }
    }
    if (facts.skipWorktree.length > 0) {
        blockers.push({
            kind: 'skip-worktree',
            detail: `${facts.skipWorktree.length} path(s) are hidden from git status by skip-worktree/assume-unchanged`,
            paths: facts.skipWorktree.slice(0, MAX_NAMED_PATHS),
        });
    }

    if (facts.head) {
        const pushed = pushedStateWith(worktree, facts.branch, facts.head, opts.prLookup ?? lookupPullRequest);
        facts.pushed = pushed.detail;
        if (!pushed.pass) blockers.push({ kind: 'unpushed', detail: pushed.detail, paths: [] });
    }

    // Liveness: this process (and the pane it was launched from) stands inside the tree
    // by construction; anyone else inside it is a user whose work would vanish.
    const allowed = new Set<number>(opts.allowedPids ?? []);
    let cwds: Map<string, number[]> | null = null;
    try {
        cwds = readProcessCwds(opts.procRoot ?? '/proc', { strict: true });
        const ppids = readPpidMap(opts.procRoot ?? '/proc');
        for (const pid of selfAncestry(ppids)) allowed.add(pid);
    } catch (error) {
        blockers.push({
            kind: 'unreadable',
            detail: `cannot read the process table: ${error instanceof Error ? error.message : String(error)}`,
            paths: [],
        });
    }

    if (cwds) {
        facts.livePids = livePidsFor(worktree, cwds).filter(pid => !allowed.has(pid));
        if (facts.livePids.length > 0) {
            blockers.push({
                kind: 'held-by-process',
                detail: `pids ${facts.livePids.slice(0, 10).join(',')} have a working directory inside`,
                paths: [],
            });
        }
    }

    return { worktree, repoRoot, ok: blockers.length === 0, blockers, facts };
}

export interface ReleaseLogFields {
    action: 'prompted' | 'confirmed' | 'declined' | 'released' | 'refused' | 'nudged' | 'failed';
    pane?: string;
    client?: string;
    worktree?: string;
    branch?: string | null;
    head?: string | null;
    detail?: string;
}

/**
 * One tab-separated line per keystroke: a destructive action must be answerable after the
 * fact. `prompted` is written before the prompt blocks, so a killed process still leaves
 * a trace of the question that was asked.
 */
export function logEvent(fields: ReleaseLogFields): void {
    appendLog([
        fields.action,
        fields.pane ?? '',
        fields.client ?? '',
        fields.worktree ?? '',
        fields.branch ?? '',
        (fields.head ?? '').slice(0, 12),
        sanitizeInline(fields.detail ?? ''),
    ].join('\t'));
}

export interface NudgeInput {
    branch: string | null;
    blockers: ReleaseBlocker[];
}

/**
 * The nudge text. It names files and asks for one of two outcomes; it never tells an
 * agent to delete, clean or force anything, because the tree is about to be removed
 * and an agent acting on "remove .specialists/user/" with a trailing slash would
 * follow the launcher link into the main checkout.
 */
/**
 * One line, no control characters. A branch name, a path or a git message can carry a
 * newline; the nudge is pasted into an agent's prompt, so a newline inside a file name
 * would read as a second instruction.
 */
function sanitizeInline(value: string): string {
    const flat = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}

export function renderNudge(input: NudgeInput): string {
    const lines = [
        `XTRM release check: this worktree (branch ${sanitizeInline(input.branch ?? 'detached')}) is not ready to be removed.`,
    ];

    for (const blocker of input.blockers) {
        for (const path of blocker.paths.slice(0, MAX_NAMED_PATHS)) lines.push(`- ${sanitizeInline(path)} (${blocker.kind})`);
        // A blocker without paths (an unpushed commit, a detached HEAD) still needs its
        // reason: "commit and push" is useless when the work is already committed.
        if (blocker.paths.length === 0) lines.push(`- ${sanitizeInline(blocker.detail)}`);
    }

    lines.push(
        '',
        'Commit and push this work, or report why it must stay. Do not delete, clean or force anything —',
        'the release command removes the tree itself once it is clean and pushed. The operator presses prefix+X again after that.',
    );

    return lines.join('\n');
}

export interface KeybindingPaths {
    snippetPath: string;
    tmuxConfPath: string;
}

export function keybindingPaths(home = process.env.HOME ?? ''): KeybindingPaths {
    return {
        snippetPath: join(home, '.config', 'xtrm', 'tmux.conf'),
        tmuxConfPath: join(home, '.tmux.conf'),
    };
}

/** The managed snippet. The single-quoted run-shell form is the one that was tested. */
export function renderKeybindingSnippet(): string {
    return [
        '# xt worktree release — prefix+X reclaims the current pane\'s agent worktree.',
        '# Managed by `xt worktree install-keybinding`; edit the command only through that verb.',
        '#',
        '# Keep the single-quoted run-shell form. A related form observed on tmux 3.6a',
        '# (2026-11-25) — `bind X confirm-before -t "#{client_name}" ...` sourced from a',
        '# file — produced no prompt and no confirmation, while this form passed a',
        '# two-client test.',
        "bind X run-shell -b 'xt worktree release --pane #{pane_id} --client #{client_name}'",
        '',
    ].join('\n');
}

export const TMUX_SOURCE_MARKER = '# xt: worktree release keybinding';

export function sourceLine(paths: KeybindingPaths): string {
    return `source-file -q ${paths.snippetPath}`;
}

/** True when the tmux config already sources the snippet. Commented lines do not count. */
export function configSourcesSnippet(contents: string, paths: KeybindingPaths): boolean {
    const active = contents
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'))
        .join('\n');

    return active.includes(paths.snippetPath) || active.includes(sourceLine(paths));
}

export interface KeybindingProbe {
    label: string;
    ok: boolean;
    detail: string;
}

/**
 * Doctor probes. Pure over the facts the caller gathered, so a probe can be tested
 * without a tmux server. `binding` is `tmux list-keys` output or null when tmux is not
 * running; `xtOnPath` is null when the probe could not run.
 */
export function keybindingProbes(input: {
    snippetExists: boolean;
    snippetHasBinding: boolean;
    tmuxConfExists: boolean;
    tmuxConfSources: boolean;
    binding: string | null;
    xtOnPath: boolean | null;
}): KeybindingProbe[] {
    return [
        {
            label: 'release snippet',
            ok: input.snippetExists && input.snippetHasBinding,
            detail: input.snippetExists
                ? (input.snippetHasBinding ? 'present with the bind line' : 'present but no bind X line')
                : 'missing — run `xt worktree install-keybinding`',
        },
        {
            label: 'tmux.conf sources snippet',
            ok: input.tmuxConfSources,
            detail: input.tmuxConfSources ? 'sources the snippet' : (input.tmuxConfExists ? 'no source line' : 'no ~/.tmux.conf'),
        },
        {
            label: 'prefix X bound',
            // Not checked is not a failure: the doctor line must not report a broken
            // binding on a host where no tmux server is running.
            ok: input.binding === null || input.binding.includes('worktree release'),
            detail: input.binding === null
                ? 'tmux not running — not checked'
                : (input.binding.includes('worktree release') ? 'bound to xt worktree release' : (input.binding.trim() ? 'bound to something else' : 'unbound')),
        },
        {
            label: 'xt on tmux PATH',
            ok: input.xtOnPath !== false,
            detail: input.xtOnPath === null
                ? 'not checked (no tmux server)'
                : (input.xtOnPath ? 'resolves inside run-shell' : 'not found inside run-shell — the binding will fail'),
        },
    ];
}

/** Read a file defensively; a missing file is not an error for the probes. */
export function readTextIfExists(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

