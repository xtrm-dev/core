/**
 * Worktree reaper — out-of-band, safe-by-construction reclaim of abandoned worktrees.
 *
 * A worktree is reapable only when ALL safety conditions hold. Every condition that
 * fails is reported by name; nothing is removed on a failed condition and no flag
 * skips the predicate. The predicate was hand-validated against 317 live worktrees
 * during incident mercury-market-data-9kjj4 with zero false positives.
 *
 * This module evaluates and measures only. Removal lives in commands/worktree.ts so
 * the predicate stays testable without a filesystem mutation path.
 */

import { spawnSync } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * Paths excluded from the "recent work" and "git clean" tests.
 *
 * This list is the feature. Agent tooling rewrites AGENTS.md, CLAUDE.md and
 * .beads/interactions.jsonl on every session, so without these exclusions the dirty
 * test measures scaffolding churn instead of work: 209 of 317 worktrees read as
 * "dirty" while holding nothing.
 */
export const WORK_EXCLUDED_NAMES: readonly string[] = [
    'node_modules',
    '.venv',
    'venv',
    '.git',
    '.beads',
    '.xtrm',
    '.specialists',
    '.claude',
    '.pi',
    'AGENTS.md',
    'CLAUDE.md',
];

/** Regenerable build artifacts. Hold no work; reclaimable independently of the worktree. */
export const ARTIFACT_DIR_NAMES: readonly string[] = ['node_modules', '.venv', 'venv', '.gitnexus'];

/** Fail-closed bound on the source walk. A truncated scan is reported, never treated as clean. */
export const MAX_SCAN_ENTRIES = 200_000;

const EXCLUDED = new Set(WORK_EXCLUDED_NAMES);
const ARTIFACTS = new Set(ARTIFACT_DIR_NAMES);

export type ReapConditionName =
    | 'not-current-worktree'
    | 'no-live-process'
    | 'no-recent-work'
    | 'git-clean'
    | 'no-unpushed-commits'
    | 'scan-complete';

export interface ReapCondition {
    name: ReapConditionName;
    pass: boolean;
    detail: string;
}

export interface ArtifactEntry {
    path: string;
    bytes: number;
}

export interface WorktreeScan {
    /** Newest mtime among files that count as work (exclusions applied). */
    newestWorkMtimeMs: number | null;
    /** Path of the file that set newestWorkMtimeMs — makes the exclusion list auditable. */
    newestWorkPath: string | null;
    sourceBytes: number;
    artifacts: ArtifactEntry[];
    artifactBytes: number;
    /** Entries not owned by this uid. Unprivileged reclaim cannot remove them. */
    rootOwnedPaths: string[];
    rootOwnedBytes: number;
    truncated: boolean;
    entriesScanned: number;
}

export interface ReapCandidate {
    component: 'xt.worktree_reap.candidate';
    repo: string;
    path: string;
    branch: string | null;
    isMainWorktree: boolean;
    conditions: ReapCondition[];
    failed: ReapConditionName[];
    /** All conditions hold: the whole worktree may be removed. */
    reapable: boolean;
    /** No live process and idle past the artifact threshold: artifacts may be reclaimed. */
    artifactsReclaimable: boolean;
    idleDays: number | null;
    totalBytes: number;
    artifactBytes: number;
    artifacts: ArtifactEntry[];
    blockedBytes: number;
    rootOwnedPaths: string[];
    scanTruncated: boolean;
    livePids: number[];
}

export interface ReapPlan {
    component: 'xt.worktree_reap';
    checked_at_ms: number;
    mode: 'dry_run' | 'apply';
    artifact_threshold_days: number;
    worktree_threshold_days: number;
    repos: string[];
    candidates: ReapCandidate[];
    summary: {
        checked: number;
        reapable: number;
        artifacts_only: number;
        held: number;
        reclaimable_bytes: number;
        artifact_bytes: number;
        blocked_bytes: number;
        root_owned_trees: number;
        scan_truncated: number;
    };
}

/** Parse `7d`, `12h`, `30m` or a bare number of days into days. */
export function parseDurationDays(input: string | number | undefined, fallback: number): number {
    if (input === undefined || input === null || input === '') return fallback;
    if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : fallback;

    const match = /^(\d+(?:\.\d+)?)\s*([dhm]?)$/i.exec(input.trim());
    if (!match) return fallback;

    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) return fallback;

    switch ((match[2] ?? 'd').toLowerCase()) {
        case 'h': return value / 24;
        case 'm': return value / 1440;
        default: return value;
    }
}

/**
 * Map every readable process cwd on the host.
 *
 * /proc/<pid>/cwd is readable only for processes this uid can ptrace, so the map
 * covers our own processes. That is the population that owns worktrees; a worktree
 * held by another user's process also fails the mtime and git conditions in practice.
 */
export function readProcessCwds(procRoot = '/proc', options: { strict?: boolean } = {}): Map<string, number[]> {
    const cwds = new Map<string, number[]>();

    let entries: string[];
    try {
        entries = readdirSync(procRoot);
    } catch (error) {
        // A caller whose decision is "is anything alive in this directory" cannot
        // tell an empty map from an unreadable one, so it must be able to refuse
        // instead of assuming nothing is in use.
        if (options.strict) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`cannot enumerate process working directories under ${procRoot}: ${message}`);
        }
        return cwds;
    }

    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);

        let target: string;
        try {
            target = readlinkSync(join(procRoot, entry, 'cwd'));
        } catch {
            continue; // not ours, or exited between readdir and readlink
        }

        const existing = cwds.get(target);
        if (existing) existing.push(pid);
        else cwds.set(target, [pid]);
    }

    return cwds;
}

function isInside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(`${parent}${sep}`);
}

/** Pids whose cwd is inside `worktreePath`. */
export function livePidsFor(worktreePath: string, cwds: Map<string, number[]>): number[] {
    const root = resolve(worktreePath);
    const pids: number[] = [];

    for (const [cwd, cwdPids] of cwds) {
        if (isInside(cwd, root)) pids.push(...cwdPids);
    }

    return [...new Set(pids)].sort((a, b) => a - b);
}

function duBytes(path: string): number {
    const r = spawnSync('du', ['-sb', '--', path], { encoding: 'utf8', stdio: 'pipe' });
    if (r.status !== 0 && !r.stdout) return 0;
    const first = (r.stdout ?? '').split('\n')[0] ?? '';
    const bytes = Number(first.split('\t')[0]);
    return Number.isFinite(bytes) ? bytes : 0;
}

/**
 * Detect entries this uid does not own.
 *
 * Containerised builds leave root-owned trees that unprivileged reclaim cannot remove;
 * this blocked reclaim three separate times during the incident. Probe cheaply with
 * `-quit`, and only pay for the byte count when the probe hits.
 */
function findRootOwned(path: string, uid: number): { paths: string[]; bytes: number } {
    // Prune the directories that hold *other* registered worktrees, so a nested worktree's
    // root-owned tree is attributed to that worktree alone. Without this the parent and the
    // child both report the same bytes and the blocked total is double counted.
    const prune = ['-name', '.git', '-o', '-name', '.xtrm', '-o', '-name', '.worktrees'];
    const scope = [path, '(', ...prune, ')', '-prune', '-o', '!', '-user', String(uid)];

    const probe = spawnSync('find', [...scope, '-print', '-quit'], {
        encoding: 'utf8', stdio: 'pipe',
    });

    const hit = (probe.stdout ?? '').trim();
    if (!hit) return { paths: [], bytes: 0 };

    const full = spawnSync('find', [...scope, '-printf', '%s\\t%p\\n'], {
        encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024,
    });

    let bytes = 0;
    const paths: string[] = [];
    for (const line of (full.stdout ?? '').split('\n')) {
        if (!line) continue;
        const tab = line.indexOf('\t');
        if (tab === -1) continue;
        const size = Number(line.slice(0, tab));
        if (Number.isFinite(size)) bytes += size;
        if (paths.length < 10) paths.push(line.slice(tab + 1));
    }

    return { paths: paths.length > 0 ? paths : [hit], bytes };
}

/**
 * Walk the worktree once: newest work mtime, source size, artifact dirs, root-owned trees.
 *
 * Artifact directories are recorded and not descended into — `du` sizes them in C.
 */
export function scanWorktree(worktreePath: string, uid = process.getuid?.() ?? -1): WorktreeScan {
    const scan: WorktreeScan = {
        newestWorkMtimeMs: null,
        newestWorkPath: null,
        sourceBytes: 0,
        artifacts: [],
        artifactBytes: 0,
        rootOwnedPaths: [],
        rootOwnedBytes: 0,
        truncated: false,
        entriesScanned: 0,
    };

    const queue: string[] = [worktreePath];

    while (queue.length > 0) {
        const dir = queue.pop() as string;

        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as Dirent[];
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (scan.entriesScanned >= MAX_SCAN_ENTRIES) {
                scan.truncated = true;
                break;
            }
            scan.entriesScanned += 1;

            const full = join(dir, entry.name);

            if (entry.isDirectory()) {
                if (ARTIFACTS.has(entry.name)) {
                    const bytes = duBytes(full);
                    scan.artifacts.push({ path: full, bytes });
                    scan.artifactBytes += bytes;
                    continue;
                }
                if (EXCLUDED.has(entry.name)) continue;
                queue.push(full);
                continue;
            }

            if (!entry.isFile()) continue; // symlinks, sockets, fifos hold no work

            let stat: Stats;
            try {
                stat = lstatSync(full);
            } catch {
                continue;
            }

            scan.sourceBytes += stat.size;
            if (EXCLUDED.has(entry.name)) continue;

            const mtime = stat.mtimeMs;
            if (scan.newestWorkMtimeMs === null || mtime > scan.newestWorkMtimeMs) {
                scan.newestWorkMtimeMs = mtime;
                scan.newestWorkPath = full;
            }
        }

        if (scan.truncated) break;
    }

    if (uid >= 0) {
        const rootOwned = findRootOwned(worktreePath, uid);
        scan.rootOwnedPaths = rootOwned.paths;
        scan.rootOwnedBytes = rootOwned.bytes;
    }

    return scan;
}

function git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** Path portion of a `git status --short` line, accounting for rename arrows and quoting. */
export function statusLinePath(line: string): string {
    const body = line.slice(3).trim();
    const arrow = body.indexOf(' -> ');
    const path = arrow === -1 ? body : body.slice(arrow + 4);
    return path.replace(/^"|"$/g, '');
}

/** True when the path's first or any segment is excluded scaffolding. */
export function isExcludedPath(path: string): boolean {
    return path.split('/').some(segment => EXCLUDED.has(segment));
}

/**
 * `git status --short` entries that survive the scaffolding exclusions.
 *
 * The output is read untrimmed on purpose: the XY status prefix is fixed-width and an
 * unstaged modification starts with a space, so trimming shifts every path by one
 * character and silently corrupts the exclusion match.
 */
export function dirtyPaths(worktreePath: string): string[] {
    const status = spawnSync('git', ['status', '--short'], {
        cwd: worktreePath, encoding: 'utf8', stdio: 'pipe',
    });
    if (status.status !== 0) return [];

    return (status.stdout ?? '')
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(statusLinePath)
        .filter(Boolean)
        .filter(path => !isExcludedPath(path));
}

/**
 * Commits present locally but not on the remote.
 *
 * Falls back to ancestry against origin/HEAD when the branch has no upstream, per the
 * contract: zero unpushed commits vs upstream, OR the branch is an ancestor of origin/HEAD.
 */
export function unpushedCommits(worktreePath: string): { count: number | null; detail: string } {
    const upstream = git(['rev-list', '--count', '@{upstream}..HEAD'], worktreePath);
    if (upstream.ok) {
        const count = Number(upstream.out);
        return Number.isFinite(count)
            ? { count, detail: count === 0 ? 'upstream up to date' : `${count} commit(s) ahead of upstream` }
            : { count: null, detail: 'could not parse rev-list output' };
    }

    for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
        const exists = git(['rev-parse', '--verify', '--quiet', ref], worktreePath);
        if (!exists.ok || !exists.out) continue;

        const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', ref], {
            cwd: worktreePath, encoding: 'utf8', stdio: 'pipe',
        });

        return ancestor.status === 0
            ? { count: 0, detail: `no upstream; HEAD is an ancestor of ${ref}` }
            : { count: null, detail: `no upstream and HEAD is not an ancestor of ${ref}` };
    }

    return { count: null, detail: 'no upstream and no origin ref to compare against' };
}

export interface EvaluateOptions {
    repoRoot: string;
    worktreePath: string;
    branch: string | null;
    isMainWorktree: boolean;
    currentPath: string;
    cwds: Map<string, number[]>;
    worktreeThresholdDays: number;
    artifactThresholdDays: number;
    now?: number;
}

/** Evaluate every safety condition. Nothing here mutates the filesystem. */
export function evaluateWorktree(opts: EvaluateOptions): ReapCandidate {
    const now = opts.now ?? Date.now();
    const path = resolve(opts.worktreePath);
    const scan = scanWorktree(path);
    const livePids = livePidsFor(path, opts.cwds);

    const isCurrent = isInside(resolve(opts.currentPath), path) || opts.isMainWorktree;
    const idleMs = scan.newestWorkMtimeMs === null ? null : now - scan.newestWorkMtimeMs;
    const idleDays = idleMs === null ? null : idleMs / 86_400_000;
    const dirty = dirtyPaths(path);
    const unpushed = unpushedCommits(path);

    const idlePastWorktreeThreshold = idleDays === null || idleDays >= opts.worktreeThresholdDays;
    const idlePastArtifactThreshold = idleDays === null || idleDays >= opts.artifactThresholdDays;

    const conditions: ReapCondition[] = [
        {
            name: 'not-current-worktree',
            pass: !isCurrent,
            detail: opts.isMainWorktree
                ? 'main worktree — never reapable'
                : isCurrent ? 'this is the current worktree' : 'not the current worktree',
        },
        {
            name: 'no-live-process',
            pass: livePids.length === 0,
            detail: livePids.length === 0 ? 'no process cwd inside' : `pids ${livePids.join(',')} have cwd inside`,
        },
        {
            name: 'no-recent-work',
            pass: idlePastWorktreeThreshold,
            detail: idleDays === null
                ? 'no work files after exclusions'
                : `newest work file ${idleDays.toFixed(1)}d old (${scan.newestWorkPath})`,
        },
        {
            name: 'git-clean',
            pass: dirty.length === 0,
            detail: dirty.length === 0
                ? 'clean after scaffolding exclusions'
                : `${dirty.length} dirty path(s): ${dirty.slice(0, 3).join(', ')}`,
        },
        {
            name: 'no-unpushed-commits',
            pass: unpushed.count === 0,
            detail: unpushed.detail,
        },
        {
            name: 'scan-complete',
            pass: !scan.truncated,
            detail: scan.truncated
                ? `scan bounded at ${MAX_SCAN_ENTRIES} entries — treated as unsafe`
                : `${scan.entriesScanned} entries scanned`,
        },
    ];

    const failed = conditions.filter(condition => !condition.pass).map(condition => condition.name);

    // Artifacts are regenerable, so their reclaim needs only that nothing is using the
    // worktree right now and that it is idle past the artifact threshold. The whole-worktree
    // conditions do not gate it: the safe win must not wait on the risky one.
    const artifactsReclaimable =
        !isCurrent
        && livePids.length === 0
        && !scan.truncated
        && idlePastArtifactThreshold
        && scan.artifacts.length > 0;

    return {
        component: 'xt.worktree_reap.candidate',
        repo: opts.repoRoot,
        path,
        branch: opts.branch,
        isMainWorktree: opts.isMainWorktree,
        conditions,
        failed,
        reapable: failed.length === 0,
        artifactsReclaimable,
        idleDays,
        totalBytes: scan.sourceBytes + scan.artifactBytes,
        artifactBytes: scan.artifactBytes,
        artifacts: scan.artifacts,
        blockedBytes: scan.rootOwnedBytes,
        rootOwnedPaths: scan.rootOwnedPaths,
        scanTruncated: scan.truncated,
        livePids,
    };
}

export function summarize(candidates: ReapCandidate[]): ReapPlan['summary'] {
    const reapable = candidates.filter(candidate => candidate.reapable);
    const artifactsOnly = candidates.filter(candidate => !candidate.reapable && candidate.artifactsReclaimable);

    return {
        checked: candidates.length,
        reapable: reapable.length,
        artifacts_only: artifactsOnly.length,
        held: candidates.filter(candidate => !candidate.reapable && !candidate.artifactsReclaimable).length,
        // Root-owned bytes are subtracted, never absorbed: a reclaim total that counts
        // bytes unprivileged removal cannot free is the exact failure this reaper must
        // not reproduce. They are carried separately in blocked_bytes and escalated.
        reclaimable_bytes: Math.max(
            0,
            reapable.reduce((sum, candidate) => sum + candidate.totalBytes - candidate.blockedBytes, 0)
            + artifactsOnly.reduce((sum, candidate) => sum + candidate.artifactBytes - candidate.blockedBytes, 0),
        ),
        artifact_bytes: candidates.reduce((sum, candidate) => sum + candidate.artifactBytes, 0),
        blocked_bytes: candidates.reduce((sum, candidate) => sum + candidate.blockedBytes, 0),
        root_owned_trees: candidates.filter(candidate => candidate.rootOwnedPaths.length > 0).length,
        scan_truncated: candidates.filter(candidate => candidate.scanTruncated).length,
    };
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(1)}${units[unit]}`;
}
