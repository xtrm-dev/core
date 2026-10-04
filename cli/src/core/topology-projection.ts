/**
 * Aggregated topology projection — audit ~/dev/11.md P2-05.
 *
 * Joins tmux pane -> interactive runtime -> role -> coordinator -> specialist
 * jobs -> issue -> worktree -> branch -> integration target -> pull request, and
 * emits one `xtrm.topology.projection.v1` snapshot. Issues come from Substrate
 * (`sb`), the issue authority, since XTRM-629; the pane field keeps the v1 name
 * `bead`.
 *
 * Collection is three steps so the agent host's live feed (topology-feed.ts) can
 * rerun only the cheap one: `readPanes()` is the single `tmux list-panes -a`
 * pass, `collectEnrichment()` reads the slower sources, and `joinProjection()`
 * is a pure join of the two. `collectProjection()` runs all three once.
 *
 * READ-ONLY, BY CONSTRUCTION. Every fact is read live at invocation from the
 * owning system's published CLI surface; nothing is cached, materialized, or
 * written back, and this module holds no state between calls. The audit's
 * non-goal — "do not persist a duplicate mutable graph" — is met by there being
 * no store to persist into: `collectProjection()` is a pure function of the
 * world plus a command runner.
 *
 * The only commands this module may issue are the ones in READ_ONLY_COMMANDS
 * below. Argv is built exclusively from that table, so there is no code path
 * that can issue a mutating command — the guarantee is structural, and the test
 * suite asserts the recorded argv against the same table.
 *
 * Why the source CLIs and not the databases: `sp ps --json`, `sb --json issue
 * show` and `xtmux topology --json` are published contracts; .specialists/db/observability.db and
 * the xtmux state DB are private schemas owned by other repos. Reading them
 * directly would couple Core to another project's internals and would add a
 * native sqlite dependency to a CLI that has none.
 */

import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
    TopologyAgentSession,
    TopologyBead,
    TopologyJob,
    TopologyPane,
    TopologyPaneAgent,
    TopologyProjectionV1,
    TopologyPullRequest,
    TopologySource,
    TopologySourceName,
    TopologyWorktree,
} from '@xtrm/contracts';

const execFileAsync = promisify(execFile);

/**
 * Field separator for the tmux format string.
 *
 * Tab, not the "obvious" ASCII unit separator: tmux escapes non-printable bytes
 * in format output as a literal backslash-octal sequence, so U+001F arrives as
 * the four characters \037 and every row fails to split. Tab passes through
 * verbatim, and git forbids control characters in ref names, so a branch can
 * never contain one.
 */
const SEP = '\t';

/**
 * tmux format fields, in argv order. `@agent_*` are the lineage pane options
 * Core's launcher writes (PR #465); tmux expands user options inside format
 * strings, so one `list-panes -a` call retrieves the whole fleet plus its
 * lineage instead of N `show-options` round trips.
 */
const PANE_FIELDS = [
    'pane_id',
    'session_id',
    'session_name',
    'window_id',
    'pane_current_command',
    'pane_current_path',
    '@agent_state',
    '@agent_role',
    '@agent_task',
    '@agent_bead',
    '@agent_worktree',
    '@agent_branch',
    '@agent_parent_session',
    '@agent_parent_pane',
    '@agent_instance_id',
    'window_index',
    'pane_index',
    'window_active',
    'pane_active',
    // Free text, so last: a tab inside a window name rejoins instead of
    // shifting every later column.
    'window_name',
] as const;

const PANE_FORMAT = PANE_FIELDS.map((f) => `#{${f}}`).join(SEP);

/**
 * Every command this module is permitted to run. Argv is taken from here rather
 * than assembled ad hoc, which is what makes "this never mutates anything" a
 * property of the code instead of a property of the review.
 */
export const READ_ONLY_COMMANDS = {
    xtmux: { bin: 'xtmux', args: ['topology', '--json'], timeoutMs: 5_000 },
    tmux: { bin: 'tmux', args: ['list-panes', '-a', '-F', PANE_FORMAT], timeoutMs: 5_000 },
    specialists: { bin: 'sp', args: ['ps', '--json'], timeoutMs: 10_000 },
    /**
     * One `show` per distinct issue ref a pane names, ref appended as the last
     * argv element after ISSUE_REF_PATTERN accepted it. `issue list --json` is
     * per project and ~0.5 MB for one board, so a ref lookup is the bounded read.
     */
    substrate: { bin: 'sb', args: ['--json', 'issue', 'show'], timeoutMs: 5_000 },
    git: { bin: 'git', args: ['worktree', 'list', '--porcelain'], timeoutMs: 5_000 },
    github: {
        bin: 'gh',
        args: [
            'pr', 'list', '--state', 'all', '--limit', '100', '--json',
            'number,state,url,title,headRefName,baseRefName,isDraft,mergedAt',
        ],
        timeoutMs: 15_000,
    },
} as const satisfies Record<TopologySourceName, { bin: string; args: readonly string[]; timeoutMs: number }>;

export type RunOutcome =
    | { kind: 'ok'; stdout: string }
    /** Binary is not on PATH. Not a bug — the host simply does not have it. */
    | { kind: 'missing' }
    | { kind: 'timeout' }
    /** stdout is kept when the binary printed a machine envelope before failing (`sb --json`). */
    | { kind: 'failed'; reason: string; stdout?: string };

export type CommandRunner = (
    bin: string,
    args: readonly string[],
    opts: { timeoutMs: number; cwd?: string },
) => Promise<RunOutcome>;

/**
 * Default runner. Bounded on both axes: `timeout` kills a hung source, and
 * `maxBuffer` caps a runaway one. Neither can take down the projection — a
 * failing source degrades to one `sources[]` entry.
 */
export const defaultRunner: CommandRunner = async (bin, args, { timeoutMs, cwd }) => {
    try {
        const { stdout } = await execFileAsync(bin, [...args], {
            timeout: timeoutMs,
            cwd,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            // Inherit nothing on stdin: a source CLI that decides to prompt must
            // fail fast rather than hang the projection waiting for a keystroke.
            windowsHide: true,
        } as Parameters<typeof execFileAsync>[2]);
        return { kind: 'ok', stdout: String(stdout) };
    } catch (error) {
        const err = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string; stdout?: string };
        if (err.code === 'ENOENT') return { kind: 'missing' };
        if (err.killed) return { kind: 'timeout' };
        const reason = firstLine(err.stderr) || err.message || 'unknown failure';
        return err.stdout ? { kind: 'failed', reason, stdout: String(err.stdout) } : { kind: 'failed', reason };
    }
};

/** Keep `sources[].reason` to one line and free of command output / secrets. */
function firstLine(text: string | undefined): string {
    if (!text) return '';
    // Node runtime warnings (`sb` prints an ExperimentalWarning) are not the cause.
    const line = text.split('\n').map((l) => l.trim())
        .find((l) => l && !/ExperimentalWarning|--trace-warnings/.test(l)) ?? '';
    return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

export interface CollectOptions {
    /** Repo root for git/gh queries. Defaults to process.cwd(). */
    cwd?: string;
    /** Skip GitHub — the slowest, rate-limited source. Recorded as unavailable. */
    includeGithub?: boolean;
    /** `sources[].reason` when GitHub is skipped. */
    githubSkipReason?: string;
    runner?: CommandRunner;
    now?: () => number;
}

/** One source's raw result plus the ledger entry describing how it went. */
export interface SourceRead<T> {
    entry: TopologySource;
    data: T | null;
}

async function readSource<T>(
    name: TopologySourceName,
    parse: (stdout: string) => T,
    opts: { runner: CommandRunner; cwd?: string; now: () => number },
): Promise<SourceRead<T>> {
    const { bin, args, timeoutMs } = READ_ONLY_COMMANDS[name];
    const started = opts.now();
    const outcome = await opts.runner(bin, args, { timeoutMs, cwd: opts.cwd });
    const duration_ms = Math.max(0, opts.now() - started);

    if (outcome.kind === 'missing') {
        return { entry: { name, status: 'unavailable', reason: `${bin} not found on PATH`, duration_ms }, data: null };
    }
    if (outcome.kind === 'timeout') {
        return { entry: { name, status: 'error', reason: `${bin} timed out after ${timeoutMs}ms`, duration_ms }, data: null };
    }
    if (outcome.kind === 'failed') {
        return { entry: { name, status: 'error', reason: outcome.reason, duration_ms }, data: null };
    }
    try {
        return { entry: { name, status: 'ok', reason: null, duration_ms }, data: parse(outcome.stdout) };
    } catch (error) {
        // Parsed-but-unusable is an error, not unavailability: the binary is
        // present and answered, so a shape mismatch is a real signal.
        const reason = error instanceof Error ? error.message : 'unparseable output';
        return { entry: { name, status: 'error', reason: firstLine(reason), duration_ms }, data: null };
    }
}

// ── source parsers ──────────────────────────────────────────────────────────

export interface RawPane {
    pane_id: string;
    session_id: string;
    session_name: string;
    window_id: string | null;
    window_index: number | null;
    window_name: string | null;
    window_active: boolean | null;
    pane_index: number | null;
    pane_active: boolean | null;
    current_command: string;
    current_path: string;
    agent: TopologyPaneAgent | null;
}

export function parsePanes(stdout: string): RawPane[] {
    const panes: RawPane[] = [];
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const cols = line.split(SEP);
        if (cols.length < PANE_FIELDS.length) continue;
        const [
            pane_id, session_id, session_name, window_id, current_command, current_path,
            state, role, task, bead_id, worktree, branch, parent_session_id, parent_pane_id, instance_id,
            window_index, pane_index, window_active, pane_active,
        ] = cols;
        const window_name = cols.slice(PANE_FIELDS.length - 1).join(SEP);
        // A pane is an xtrm-launched agent only if it carries lineage. A plain
        // shell gets `agent: null` rather than an object of empty strings —
        // "not an agent" and "an agent with no role" are different facts.
        const lineage = [state, role, task, bead_id, worktree, branch, parent_session_id];
        const agent: TopologyPaneAgent | null = lineage.some(Boolean)
            ? {
                state: blankToNull(state),
                role: blankToNull(role),
                task: blankToNull(task),
                bead_id: blankToNull(bead_id),
                worktree: blankToNull(worktree),
                branch: blankToNull(branch),
                parent_session_id: blankToNull(parent_session_id),
                parent_pane_id: blankToNull(parent_pane_id),
                instance_id: blankToNull(instance_id),
            }
            : null;
        panes.push({
            pane_id,
            session_id,
            session_name,
            window_id: blankToNull(window_id),
            window_index: intOrNull(window_index),
            window_name,
            window_active: flagOrNull(window_active),
            pane_index: intOrNull(pane_index),
            pane_active: flagOrNull(pane_active),
            current_command,
            current_path,
            agent,
        });
    }
    return panes;
}

const blankToNull = (v: string | undefined): string | null => (v && v.length > 0 ? v : null);
const intOrNull = (v: string | undefined): number | null => (v && /^\d+$/.test(v) ? Number(v) : null);
const flagOrNull = (v: string | undefined): boolean | null => (v === '1' ? true : v === '0' ? false : null);

/** Host identity from the xtmux topology snapshot; panes come from tmux. */
export function parseXtmuxHost(stdout: string): { host_id: string; tmux_server_id: string | null } {
    const parsed = JSON.parse(stdout) as { host?: { host_id?: string; tmux_server_id?: string } };
    return {
        host_id: parsed.host?.host_id || hostname(),
        tmux_server_id: parsed.host?.tmux_server_id ?? null,
    };
}

export function parseJobs(stdout: string): TopologyJob[] {
    const parsed = JSON.parse(stdout) as { flat?: unknown[] };
    const rows = Array.isArray(parsed.flat) ? parsed.flat : [];
    return rows.map((row) => {
        const r = row as Record<string, unknown>;
        const job_id = String(r.id ?? '');
        return {
            job_id,
            specialist: str(r.specialist) ?? '',
            // Specialists owns this vocabulary; Core passes it through rather
            // than remapping it into a Core-flavoured enum that would drift.
            status: str(r.status) ?? 'unknown',
            bead_id: str(r.bead_id),
            epic_id: str(r.epic_id),
            chain_id: str(r.chain_id),
            chain_root_job_id: str(r.chain_root_job_id),
            is_chain_root: r.chain_root_job_id ? String(r.chain_root_job_id) === job_id : true,
            branch: str(r.branch),
            worktree_path: str(r.worktree_path),
            integration_target_branch: null,
            started_at_ms: typeof r.started_at_ms === 'number' ? r.started_at_ms : null,
            owning_pane_id: null,
        } satisfies TopologyJob;
    }).filter((j) => j.job_id.length > 0);
}

/**
 * An issue ref as panes publish it (`@agent_bead`): `XTRM-629`, `CORE-10.2`,
 * or a legacy Beads id such as `xtrm-d1fod.3`. Anything else is never passed to
 * `sb`, so a pane option cannot smuggle a flag into the argv.
 */
export const ISSUE_REF_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+(?:\.[0-9]+)*$/;
/** Upper bound on `sb` lookups per enrichment; refs past it keep status `unknown`. */
export const MAX_ISSUE_REFS = 64;
const ISSUE_LOOKUP_CONCURRENCY = 8;

/**
 * One `sb --json issue show` envelope. Substrate resolves refs across projects,
 * so a pane in another repository still gets its real issue state. A ref
 * Substrate does not know (a legacy Beads id) resolves to null, which the join
 * reports as status `unknown` — a missing issue is not a source failure.
 */
export function parseSubstrateIssue(ref: string, stdout: string): TopologyBead | null {
    const envelope = JSON.parse(stdout) as { ok?: unknown; data?: Record<string, unknown>; error?: unknown };
    if (envelope.ok !== true) {
        const message = typeof envelope.error === 'string' ? envelope.error : 'issue lookup failed';
        if (/unresolvable|not found|unknown (?:ref|issue)/i.test(message)) return null;
        throw new Error(message);
    }
    const data = envelope.data ?? {};
    const locator = str(data.locator);
    const dot = locator ? locator.lastIndexOf('.') : -1;
    return {
        id: ref,
        status: str(data.lifecycleState) ?? 'unknown',
        title: str(data.title),
        issue_type: str(data.kind),
        priority: typeof data.priority === 'number' ? data.priority : null,
        parent_id: locator && dot > 0 ? locator.slice(0, dot) : null,
    };
}

/**
 * Resolve the given refs through Substrate, bounded in count and concurrency.
 * Ledger: `unavailable` when `sb` is absent, `error` when any lookup failed (the
 * resolved issues are still returned), `ok` otherwise — including no refs.
 */
export async function readSubstrateIssues(
    refs: readonly string[],
    opts: { runner: CommandRunner; now: () => number },
): Promise<SourceRead<Map<string, TopologyBead>>> {
    const { bin, args, timeoutMs } = READ_ONLY_COMMANDS.substrate;
    const started = opts.now();
    const wanted = [...new Set(refs)].filter((ref) => ISSUE_REF_PATTERN.test(ref)).slice(0, MAX_ISSUE_REFS);
    const issues = new Map<string, TopologyBead>();
    const failures: string[] = [];
    let missing = false;
    let next = 0;
    const worker = async () => {
        while (next < wanted.length && !missing) {
            const ref = wanted[next++];
            const outcome = await opts.runner(bin, [...args, ref], { timeoutMs });
            if (outcome.kind === 'missing') { missing = true; return; }
            if (outcome.kind === 'timeout') { failures.push(`${ref}: ${bin} timed out after ${timeoutMs}ms`); continue; }
            const stdout = outcome.stdout;
            if (!stdout) { failures.push(`${ref}: ${outcome.kind === 'failed' ? outcome.reason : 'no output'}`); continue; }
            try {
                const issue = parseSubstrateIssue(ref, stdout);
                if (issue) issues.set(ref, issue);
            } catch (error) {
                failures.push(`${ref}: ${firstLine(error instanceof Error ? error.message : 'unparseable output')}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(ISSUE_LOOKUP_CONCURRENCY, wanted.length) }, worker));
    const duration_ms = Math.max(0, opts.now() - started);
    if (missing) {
        return { entry: { name: 'substrate', status: 'unavailable', reason: `${bin} not found on PATH`, duration_ms }, data: null };
    }
    if (failures.length > 0) {
        const reason = firstLine(`${failures.length} of ${wanted.length} issue lookups failed: ${failures[0]}`);
        return { entry: { name: 'substrate', status: 'error', reason, duration_ms }, data: issues };
    }
    return { entry: { name: 'substrate', status: 'ok', reason: null, duration_ms }, data: issues };
}

export function parseWorktrees(stdout: string): TopologyWorktree[] {
    const trees: TopologyWorktree[] = [];
    let current: Partial<TopologyWorktree> & { path?: string } = {};
    const flush = () => {
        if (current.path) {
            trees.push({
                path: current.path,
                branch: current.branch ?? null,
                head_sha: current.head_sha ?? null,
                detached: current.detached ?? false,
                shared_by_pane_ids: [],
            });
        }
        current = {};
    };
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) { flush(); continue; }
        if (trimmed.startsWith('worktree ')) { flush(); current.path = trimmed.slice('worktree '.length); }
        else if (trimmed.startsWith('HEAD ')) current.head_sha = trimmed.slice('HEAD '.length);
        else if (trimmed.startsWith('branch ')) current.branch = trimmed.slice('branch '.length).replace(/^refs\/heads\//, '');
        else if (trimmed === 'detached') current.detached = true;
    }
    flush();
    return trees;
}

export function parsePullRequests(stdout: string): Map<string, TopologyPullRequest> {
    const rows = JSON.parse(stdout) as unknown;
    const byBranch = new Map<string, TopologyPullRequest>();
    if (!Array.isArray(rows)) return byBranch;
    for (const row of rows) {
        const r = row as Record<string, unknown>;
        const head_branch = str(r.headRefName);
        const number = typeof r.number === 'number' ? r.number : null;
        if (!head_branch || number === null) continue;
        const pr: TopologyPullRequest = {
            number,
            state: str(r.state) ?? 'UNKNOWN',
            url: str(r.url),
            title: str(r.title),
            head_branch,
            base_branch: str(r.baseRefName),
            is_draft: typeof r.isDraft === 'boolean' ? r.isDraft : null,
            merged_at: str(r.mergedAt),
            checks_state: null,
        };
        // Newest PR per branch wins: a recycled branch name would otherwise
        // report a stale closed PR as the branch's current state.
        const existing = byBranch.get(head_branch);
        if (!existing || pr.number > existing.number) byBranch.set(head_branch, pr);
    }
    return byBranch;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function mergeWorktreeReads(reads: SourceRead<TopologyWorktree[]>[]): SourceRead<TopologyWorktree[]> {
    const trees = new Map<string, TopologyWorktree>();
    for (const read of reads) {
        for (const tree of read.data ?? []) trees.set(tree.path, tree);
    }

    const failures = reads.filter((read) => read.entry.status !== 'ok');
    const relevantFailures = failures.filter((read) => !/not a git repository/i.test(read.entry.reason ?? ''));
    const allUnavailable = relevantFailures.length === reads.length && relevantFailures.every((read) => read.entry.status === 'unavailable');
    return {
        entry: {
            name: 'git',
            status: relevantFailures.length === 0 ? 'ok' : allUnavailable ? 'unavailable' : 'error',
            reason: relevantFailures.length === 0
                ? null
                : relevantFailures.map((read) => read.entry.reason).filter(Boolean).join('; '),
            duration_ms: reads.reduce((total, read) => total + read.entry.duration_ms, 0),
        },
        data: trees.size > 0 || relevantFailures.length < reads.length ? [...trees.values()] : null,
    };
}

// ── the join ────────────────────────────────────────────────────────────────

/** Longest-prefix match: the most specific worktree containing this path. */
function worktreeForPath(trees: TopologyWorktree[], target: string | null): TopologyWorktree | null {
    if (!target) return null;
    let best: TopologyWorktree | null = null;
    for (const tree of trees) {
        if (target === tree.path || target.startsWith(tree.path + path.sep)) {
            if (!best || tree.path.length > best.path.length) best = tree;
        }
    }
    return best;
}

/** The single `tmux list-panes -a` pass: the only read the live feed repeats per tmux event. */
export function readPanes(options: Pick<CollectOptions, 'runner' | 'now'> = {}): Promise<SourceRead<RawPane[]>> {
    return readSource('tmux', parsePanes, { runner: options.runner ?? defaultRunner, now: options.now ?? (() => Date.now()) });
}

/** Everything the join needs besides the pane list. Never mutated by the join. */
export interface TopologyEnrichment {
    xtmux: SourceRead<{ host_id: string; tmux_server_id: string | null }>;
    jobs: SourceRead<TopologyJob[]>;
    issues: SourceRead<Map<string, TopologyBead>>;
    worktrees: SourceRead<TopologyWorktree[]>;
    pullRequests: SourceRead<Map<string, TopologyPullRequest>>;
}

/** Issue refs and filesystem paths a pane list asks the enrichment to cover. */
export function enrichmentKeys(rawPanes: readonly RawPane[]): { refs: string[]; paths: string[] } {
    const refs = new Set<string>();
    const paths = new Set<string>();
    for (const pane of rawPanes) {
        if (pane.agent?.bead_id) refs.add(pane.agent.bead_id);
        if (pane.current_path) paths.add(pane.current_path);
        if (pane.agent?.worktree) paths.add(pane.agent.worktree);
    }
    return { refs: [...refs].sort(), paths: [...paths].sort() };
}

/**
 * Read the slower sources for a pane list. Git worktrees are queried from the
 * invocation repository and from any pane path outside that initial inventory;
 * this keeps the common case to one git call while making cross-repo panes
 * visible instead of silently treating their worktrees as missing.
 */
export async function collectEnrichment(rawPanes: readonly RawPane[], options: CollectOptions = {}): Promise<TopologyEnrichment> {
    const runner = options.runner ?? defaultRunner;
    const now = options.now ?? (() => Date.now());
    const cwd = options.cwd ?? process.cwd();
    const includeGithub = options.includeGithub ?? true;
    const ctx = { runner, cwd, now };
    const keys = enrichmentKeys(rawPanes);

    const [xtmux, jobs, issues, initialTreeRead, pullRequests] = await Promise.all([
        readSource('xtmux', parseXtmuxHost, ctx),
        readSource('specialists', parseJobs, ctx),
        readSubstrateIssues(keys.refs, ctx),
        readSource('git', parseWorktrees, ctx),
        includeGithub
            ? readSource('github', parsePullRequests, ctx)
            : Promise.resolve<SourceRead<Map<string, TopologyPullRequest>>>({
                entry: { name: 'github', status: 'unavailable', reason: options.githubSkipReason ?? 'skipped by --no-github', duration_ms: 0 },
                data: null,
            }),
    ]);

    const knownTrees = initialTreeRead.data ?? [];
    const extraRepoPaths = keys.paths.filter((candidate) => !worktreeForPath(knownTrees, candidate));
    const extraTreeReads = await Promise.all(extraRepoPaths.map((repoPath) =>
        readSource('git', parseWorktrees, { ...ctx, cwd: repoPath })));
    const worktrees = mergeWorktreeReads([initialTreeRead, ...extraTreeReads]);
    return { xtmux, jobs, issues, worktrees, pullRequests };
}

export interface JoinOptions {
    now?: () => number;
    /** Agent host sessions by tmux pane id (the host's registry); absent outside the host. */
    agentSessions?: ReadonlyMap<string, TopologyAgentSession>;
}

/** Pure join of one pane read with an enrichment. Neither input is mutated. */
export function joinProjection(
    paneRead: SourceRead<RawPane[]>,
    enrichment: TopologyEnrichment,
    options: JoinOptions = {},
): TopologyProjectionV1 {
    const now = options.now ?? (() => Date.now());
    const rawPanes = paneRead.data ?? [];
    const rawJobs = enrichment.jobs.data ?? [];
    const issues = enrichment.issues.data ?? new Map<string, TopologyBead>();
    // Fresh copies: the feed joins one enrichment many times, and
    // shared_by_pane_ids is per join.
    const worktrees = (enrichment.worktrees.data ?? []).map((tree) => ({ ...tree, shared_by_pane_ids: [] as string[] }));
    const prs = enrichment.pullRequests.data ?? new Map<string, TopologyPullRequest>();
    const jobs = rawJobs.map((job) => {
        const pull_request = job.branch ? prs.get(job.branch) : undefined;
        return pull_request ? { ...job, pull_request } : job;
    });

    // Worktree collisions: every pane whose cwd resolves into a worktree. Length
    // > 1 is the shared-checkout hazard the multiplexing doctrine warns about.
    for (const pane of rawPanes) {
        const tree = worktreeForPath(worktrees, pane.current_path);
        if (tree) (tree.shared_by_pane_ids ??= []).push(pane.pane_id);
    }

    const claimedJobs = new Set<string>();
    const usedWorktrees = new Set<string>();

    const panes: TopologyPane[] = rawPanes.map((raw) => {
        const agent = raw.agent;
        const worktree = worktreeForPath(worktrees, agent?.worktree ?? raw.current_path);
        if (worktree) usedWorktrees.add(worktree.path);

        // A job belongs to a pane when they share a bead (directly or via the
        // pane's bead being the job's epic), or when the pane is sitting IN the
        // job's own worktree.
        //
        // The worktree test is exact equality, deliberately. "Job worktree is
        // nested under the pane's" looks more generous but is wrong: specialist
        // worktrees live under the repo root, so any pane sitting at the root
        // would claim every running job in the repo regardless of ownership.
        // Observed on a live host — a plain `diff` shell at the repo root
        // adopted an unrelated reviewer job. Bead identity is the real key;
        // this only catches a pane parked inside the job's checkout.
        const paneBeadId = agent?.bead_id ?? null;
        const paneWorktreePath = worktree?.path ?? null;
        const paneJobs = jobs
            .filter((job) => {
                if (claimedJobs.has(job.job_id)) return false;
                if (paneBeadId && (job.bead_id === paneBeadId || job.epic_id === paneBeadId)) return true;
                if (paneWorktreePath && job.worktree_path === paneWorktreePath) return true;
                return false;
            })
            .map((job) => {
                claimedJobs.add(job.job_id);
                return {
                    ...job,
                    owning_pane_id: raw.pane_id,
                    // The coordinator's branch IS the integration target its
                    // chains derive from (audit P1-03).
                    integration_target_branch: agent?.branch ?? null,
                } satisfies TopologyJob;
            });

        const branch = agent?.branch ?? worktree?.branch ?? null;

        return {
            pane_id: raw.pane_id,
            session_id: raw.session_id,
            session_name: raw.session_name,
            window_id: raw.window_id,
            window_index: raw.window_index,
            window_name: raw.window_name,
            window_active: raw.window_active,
            pane_index: raw.pane_index,
            pane_active: raw.pane_active,
            agent_session: options.agentSessions?.get(raw.pane_id) ?? null,
            current_command: raw.current_command,
            current_path: raw.current_path,
            agent,
            jobs: paneJobs,
            bead: paneBeadId ? issues.get(paneBeadId) ?? { id: paneBeadId, status: 'unknown' } : null,
            worktree,
            pull_request: branch ? prs.get(branch) ?? null : null,
        } satisfies TopologyPane;
    });

    return {
        schema_version: 'xtrm.topology.projection.v1',
        generated_at_ms: now(),
        host: {
            host_id: enrichment.xtmux.data?.host_id ?? hostname(),
            tmux_server_id: enrichment.xtmux.data?.tmux_server_id ?? null,
        },
        sources: [
            enrichment.xtmux.entry,
            paneRead.entry,
            enrichment.jobs.entry,
            enrichment.issues.entry,
            enrichment.worktrees.entry,
            enrichment.pullRequests.entry,
        ],
        panes,
        // Anything no live pane claimed. Without this a job whose coordinator
        // pane died, or a worktree whose session was killed, silently vanishes.
        orphans: {
            jobs: jobs.filter((job) => !claimedJobs.has(job.job_id)),
            worktrees: worktrees.filter((tree) => !usedWorktrees.has(tree.path)),
        },
    };
}

export async function collectProjection(options: CollectOptions = {}): Promise<TopologyProjectionV1> {
    // Issue refs and extra worktree paths come from the panes, so the pane
    // list is read first; the rest of the sources then run in parallel.
    const paneRead = await readPanes(options);
    const enrichment = await collectEnrichment(paneRead.data ?? [], options);
    return joinProjection(paneRead, enrichment, { now: options.now });
}
