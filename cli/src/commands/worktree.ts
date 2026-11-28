import { Command } from 'commander';
import kleur from 'kleur';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { SessionMeta } from '../utils/worktree-session.js';
import { canonicalWorktreePath, removeLaunchLedger } from '../core/session-launch.js';
import { unregisterPluginsForWorktree } from '../utils/worktree-session.js';
import { t } from '../utils/theme.js';
import { resolveDefaultBranchRef } from '../utils/worktree-base.js';
import { confirmDestructiveAction } from '../utils/confirmation.js';
import type { ReapCandidate, ReapPlan } from '../core/worktree-reap.js';
import {
    evaluateWorktree,
    formatBytes,
    livePidsFor,
    parseDurationDays,
    readProcessCwds,
    summarize,
} from '../core/worktree-reap.js';
import { gatherKeybindingProbes, installKeybinding, releasePane } from '../core/worktree-release-pane.js';
import {
    callerProcessIds,
    callerWorktreeRoot,
    createLivenessProbe,
    formatWorktreeHolders,
    isCallerWorktree,
    livenessReport,
    logLivenessOverride,
    type WorktreeLiveness,
} from '../core/worktree-liveness.js';

export interface WorktreeInfo {
    path: string;
    branch: string;
    head: string;
    prunable: boolean;
    runtime?: 'claude' | 'pi' | 'codex';
    launchedAt?: string;
    lastLogMsg?: string;
    lastLogTime?: Date;
    nestedInPath?: string;
}

export type PrClassification =
    | 'no-pr'
    | 'clean'
    | 'needs-rebase'
    | 'conflicted'
    | 'blocked'
    | 'closed'
    | 'unknown';

export interface PrStatus {
    component: 'xt.pr_status';
    branch: string;
    state: string | null;
    merge_state: string | null;
    classification: PrClassification;
    outcome: 'ok' | 'no_pr' | 'error';
    pr_url?: string;
    pr_number?: number;
    head_sha?: string;
    base_sha?: string;
    base_ref?: string;
    remediation: string;
    error?: string;
}

export interface PrAuditFinding {
    component: 'xt.pr_audit.finding';
    repo: string;
    branch: string;
    pr_url?: string;
    pr_number?: number;
    state: string | null;
    merge_state: string | null;
    classification: PrClassification;
    outcome: PrStatus['outcome'];
    suggested_action: string;
    suggestion_command: string;
    checked_at_ms: number;
    error?: string;
}

export interface PrAuditReport {
    component: 'xt.pr_audit';
    repo: string;
    checked_at_ms: number;
    findings: PrAuditFinding[];
    summary: Record<PrClassification, number>;
}

export interface BranchGcFinding {
    component: 'xt.branch_gc.finding';
    repo: string;
    branch: string;
    pr_state: string | null;
    classification: PrClassification;
    action: 'delete' | 'skip';
    reason: string;
    outcome: 'dry_run' | 'pending' | 'deleted' | 'skipped' | 'failed';
    checked_at_ms: number;
    command?: string;
    pr_url?: string;
    pr_number?: number;
    error?: string;
}

export interface BranchGcReport {
    component: 'xt.branch_gc';
    repo: string;
    checked_at_ms: number;
    mode: 'dry_run' | 'apply';
    prefixes: string[];
    findings: BranchGcFinding[];
    summary: { delete: number; skip: number; deleted: number; failed: number };
}

export type RestartAuditFindingKind =
    | 'orphaned-managed-dir'
    | 'prunable-worktree'
    | 'branch-without-worktree'
    | 'pr-attention'
    | 'closed-pr-branch';

export interface RestartAuditFinding {
    component: 'xt.restart_audit.finding';
    repo: string;
    worktree_path: string | null;
    branch: string | null;
    pr_classification: PrClassification | null;
    finding_kind: RestartAuditFindingKind;
    suggested_action: string;
    suggestion_command: string;
    checked_at_ms: number;
    pr_url?: string;
    pr_number?: number;
    error?: string;
}

export interface RestartAuditReport {
    component: 'xt.restart_audit';
    repo: string;
    checked_at_ms: number;
    prefixes: string[];
    findings: RestartAuditFinding[];
    summary: Record<RestartAuditFindingKind, number>;
}

interface GitHubPrView {
    state?: string | null;
    url?: string | null;
    number?: number | null;
    mergeStateStatus?: string | null;
    mergeable?: string | null;
    headRefOid?: string | null;
    baseRefOid?: string | null;
    baseRefName?: string | null;
}

interface RawWorktreeInfo {
    path: string;
    branch?: string;
    head?: string;
    prunable: boolean;
}

function git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return {
        ok: r.status === 0,
        out: (r.stdout ?? '').trim(),
        err: (r.stderr ?? '').trim(),
    };
}

function parseGitWorktreeList(repoRoot: string): RawWorktreeInfo[] {
    const r = git(['worktree', 'list', '--porcelain'], repoRoot);
    if (!r.ok) return [];

    const worktrees: RawWorktreeInfo[] = [];
    let current: Partial<RawWorktreeInfo> = {};

    for (const line of r.out.split('\n')) {
        if (line.startsWith('worktree ')) {
            if (current.path) {
                worktrees.push({
                    path: current.path,
                    branch: current.branch,
                    head: current.head,
                    prunable: Boolean(current.prunable),
                });
            }
            current = { path: line.slice('worktree '.length), prunable: false };
            continue;
        }

        if (line.startsWith('HEAD ')) {
            current.head = line.slice('HEAD '.length);
            continue;
        }

        if (line.startsWith('branch ')) {
            current.branch = line.slice('branch '.length);
            continue;
        }

        if (line === 'prunable') {
            current.prunable = true;
        }
    }

    if (current.path) {
        worktrees.push({
            path: current.path,
            branch: current.branch,
            head: current.head,
            prunable: Boolean(current.prunable),
        });
    }

    return worktrees;
}

function detectNestedParents(paths: string[]): Map<string, string> {
    const nested = new Map<string, string>();
    const sorted = [...paths].sort((a, b) => a.length - b.length);

    for (const childPath of sorted) {
        for (const parentPath of sorted) {
            if (childPath === parentPath) continue;
            if (childPath.startsWith(`${parentPath}${sep}`)) {
                nested.set(childPath, parentPath);
                break;
            }
        }
    }

    return nested;
}

/** Parse `git worktree list --porcelain` output into WorktreeInfo array */
export function listXtWorktrees(repoRoot: string): WorktreeInfo[] {
    const allWorktrees = parseGitWorktreeList(repoRoot);
    // xt-managed worktrees are identified by location (the managed root), not
    // by branch prefix: session branches follow the per-issue convention
    // (feature/<id>-slug, fix/…), and only older sessions used xt/ branches.
    const managedRoot = resolve(join(repoRoot, '.xtrm', 'worktrees'));
    const xtWorktrees = allWorktrees.filter(wt =>
        wt.branch?.startsWith('refs/heads/xt/')
        || (wt.path.startsWith(`${managedRoot}${sep}`) && resolve(wt.path) !== managedRoot)
    );
    const nestedParents = detectNestedParents(xtWorktrees.map(wt => wt.path));

    const worktrees: WorktreeInfo[] = xtWorktrees.map(wt => ({
        path: wt.path,
        branch: wt.branch ?? '',
        head: wt.head ?? '',
        prunable: wt.prunable,
        nestedInPath: nestedParents.get(wt.path),
    }));

    // Enrich with session meta and last git activity
    for (const wt of worktrees) {
        try {
            const metaFile = existsSync(join(wt.path, '.xtrm', 'session-meta.json'))
                ? join(wt.path, '.xtrm', 'session-meta.json')
                : join(wt.path, '.session-meta.json');
            const raw = readFileSync(metaFile, 'utf8');
            const meta = JSON.parse(raw) as SessionMeta;
            wt.runtime = meta.runtime;
            wt.launchedAt = meta.launchedAt;
        } catch {
            // no meta — older worktree
        }

        const logR = spawnSync('git', ['log', '-1', '--format=%ci\x1f%s', 'HEAD'], {
            cwd: wt.path,
            encoding: 'utf8',
            stdio: 'pipe',
        });

        if (logR.status === 0 && logR.stdout.trim()) {
            const sepIdx = logR.stdout.trim().indexOf('\x1f');
            if (sepIdx !== -1) {
                wt.lastLogTime = new Date(logR.stdout.slice(0, sepIdx).trim());
                wt.lastLogMsg = logR.stdout.slice(sepIdx + 1).trim();
            }
        }
    }

    return worktrees;
}

function getManagedWorktreeRoot(repoRoot: string): string {
    return join(repoRoot, '.xtrm', 'worktrees');
}

function listOrphanManagedDirs(repoRoot: string): string[] {
    const managedRoot = getManagedWorktreeRoot(repoRoot);
    if (!existsSync(managedRoot)) return [];

    const activePaths = new Set(parseGitWorktreeList(repoRoot).map(wt => resolve(wt.path)));
    const orphans: string[] = [];

    for (const entry of readdirSync(managedRoot)) {
        const fullPath = join(managedRoot, entry);
        let isDirectory = false;
        try {
            isDirectory = statSync(fullPath).isDirectory();
        } catch {
            continue;
        }

        if (!isDirectory) continue;
        if (!activePaths.has(resolve(fullPath))) {
            orphans.push(fullPath);
        }
    }

    return orphans.sort();
}

function runGitWorktreePrune(repoRoot: string): { ok: boolean; message: string } {
    const prune = git(['worktree', 'prune', '--expire', 'now'], repoRoot);
    return {
        ok: prune.ok,
        message: prune.ok ? 'pruned stale git worktree metadata' : prune.err || 'git worktree prune failed',
    };
}

/** Runs one git command; injectable so a git failure is a case a test can reach. */
export type GitProbe = (args: string[]) => { status: number | null; stdout?: unknown };

/** Check if a branch has been merged into the default branch */
export function isMergedIntoMain(
    branch: string,
    repoRoot: string,
    head?: string,
    spawn: GitProbe = (args) => {
        const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
        return { status: r.status, stdout: r.stdout };
    },
): boolean {
    const branchShort = branch.replace('refs/heads/', '');
    // CORE-2340: resolve the default branch dynamically instead of assuming
    // origin/main (same resolution order as worktree branch creation).
    const baseRef = resolveDefaultBranchRef(repoRoot) ?? 'origin/main';

    if (!branchShort) {
        // A detached worktree has no branch for `--merged` to answer about, and
        // the empty name must never count as merged: `''.includes('')` is true,
        // which classified twelve detached checkouts as removal targets whatever
        // their HEAD held. Ask the commit instead, and refuse when there is none.
        const sha = (head ?? '').trim();
        if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
        const ancestor = spawn(['merge-base', '--is-ancestor', sha, baseRef]);
        return ancestor.status === 0;
    }

    const r = spawn(['branch', '--merged', baseRef, '--list', branchShort]);
    // A git failure is not an answer. Saying "not merged" keeps the tree, which is
    // the safe direction; saying "merged" would hand it to a deletion loop.
    if (r.status !== 0) return false;
    return branchLineMatches(String(r.stdout ?? ''), branchShort);
}

/**
 * Whether `stdout` of `git branch --list` names exactly this branch.
 *
 * A substring test was the shape of the empty-name defect one branch over: the
 * answer must be about the branch asked, so the comparison is per line and exact
 * rather than `stdout.includes(name)`. Today `--list` happens to be exact, which is
 * why this is a seam rather than a live regression — the predicate must not depend
 * on git's pattern matching continuing to behave that way.
 */
export function branchLineMatches(stdout: string, branchShort: string): boolean {
    return stdout
        .split('\n')
        .map(line => line.replace(/^[*+]\s*/, '').trim())
        .filter(Boolean)
        .includes(branchShort);
}

/**
 * A worktree whose content is already on the base branch, by branch, HEAD, or merged PR.
 *
 * The PR lookup is injectable because the branchless case is a refusal, and a refusal
 * with no falsifier is a comment: `getPrStatus('')` would otherwise be reached by any
 * future edit that moved the guard below it.
 */
export function isMergedWorktree(
    wt: WorktreeInfo,
    repoRoot: string,
    prState: (branch: string, repoRoot: string) => { state: string } = getPrStatus as (branch: string, repoRoot: string) => { state: string },
): boolean {
    if (isMergedIntoMain(wt.branch, repoRoot, wt.head)) return true;
    // A detached worktree has no branch for the PR lookup to ask about, and asking
    // about "" would answer about nothing while looking like an answer.
    if (!wt.branch) return false;
    return prState(wt.branch, repoRoot).state === 'MERGED';
}

export interface CleanTarget {
    path: string;
    branch: string;
    livePids: number[];
}

export interface CleanPlan {
    removable: CleanTarget[];
    skippedLive: CleanTarget[];
    /** Kept because they are not merged. Printed with that reason, never silently dropped. */
    unmerged: CleanTarget[];
}

/**
 * Split merged worktrees into removable and skipped-while-live.
 *
 * `clean` used to take the merge predicate alone, so every merged worktree was a
 * target even when the session that owns it was still running in it — the exact
 * moment `clean` is documented to be used. The liveness predicate existed for
 * `reap` and was simply not consulted here; both decisions now come from one call
 * so `--dry-run` and `--yes` cannot disagree about which trees they mean.
 */
export function selectCleanTargets(
    worktrees: WorktreeInfo[],
    merged: (wt: WorktreeInfo) => boolean,
    cwds: Map<string, number[]>,
): CleanPlan {
    const removable: CleanTarget[] = [];
    const skippedLive: CleanTarget[] = [];
    const unmerged: CleanTarget[] = [];

    for (const wt of worktrees) {
        if (!merged(wt)) {
            // Printed rather than dropped: "not a target" and "not examined" look the same in
            // a list that only shows what will be removed, and a detached tree whose HEAD is
            // unmerged is exactly the case a reader needs to see named.
            unmerged.push({ path: wt.path, branch: wt.branch.replace('refs/heads/', ''), livePids: [] });
            continue;
        }
        const livePids = livePidsFor(wt.path, cwds);
        const target: CleanTarget = {
            path: wt.path,
            branch: wt.branch.replace('refs/heads/', ''),
            livePids,
        };
        if (livePids.length > 0) skippedLive.push(target);
        else removable.push(target);
    }

    return { removable, skippedLive, unmerged };
}

/**
 * Classify orphan managed directories by the same liveness predicate.
 *
 * The sweep used to delete every directory `git worktree list` did not name, which
 * is not the same set as "nobody is working in it": a directory whose git metadata
 * was pruned while a session still runs there looks exactly like a dead one. The
 * process table answers that question, so it is asked here as it is for worktrees.
 */
export function selectOrphanTargets(orphans: string[], cwds: Map<string, number[]>): CleanPlan {
    const removable: CleanTarget[] = [];
    const skippedLive: CleanTarget[] = [];

    for (const path of orphans) {
        const livePids = livePidsFor(path, cwds);
        const target: CleanTarget = { path, branch: "", livePids };
        if (livePids.length > 0) skippedLive.push(target);
        else removable.push(target);
    }

    return { removable, skippedLive, unmerged: [] };
}

export interface CleanScanInput {
    worktrees: WorktreeInfo[];
    orphans: string[];
    merged: (wt: WorktreeInfo) => boolean;
    readTable?: () => Map<string, number[]> | null;
}

export interface CleanScan {
    plan: CleanPlan;
    orphans: CleanTarget[];
    /**
     * Orphan directories kept because a process is running inside them. Kept apart
     * from `plan.skippedLive`: an orphan is not a merged worktree and has no branch,
     * so printing it under that heading tells the reader something untrue.
     */
    orphansSkippedLive: CleanTarget[];
}

/**
 * One scan for both worktrees and orphan directories, refused as a whole.
 *
 * The scan is a unit because the refusal is: a caller that could read the table for
 * the worktrees and substitute an empty map for the orphans would delete work in the
 * window it exists to protect. `null` means the table could not be read and nothing
 * may be classified — the predicate is never consulted, so the answer cannot look
 * like "no targets".
 */
export function scanCleanTargets(input: CleanScanInput): CleanScan | null {
    const readTable = input.readTable ?? readProcessTableOrRefuse;
    const cwds = readTable();
    if (cwds === null) return null;

    const plan = selectCleanTargets(input.worktrees, input.merged, cwds);
    const orphanPlan = selectOrphanTargets(input.orphans, cwds);

    return {
        plan: {
            removable: plan.removable,
            skippedLive: plan.skippedLive,
            unmerged: plan.unmerged,
        },
        orphans: orphanPlan.removable,
        orphansSkippedLive: orphanPlan.skippedLive,
    };
}

export interface CleanRemovalResult {
    removed: string[];
    /** In use when the table was re-read: the only condition that can flip between scan and delete. */
    becameLive: string[];
    /** The table could not be read, so removal was refused rather than guessed. */
    unreadable: string[];
}

export interface CleanRemovalOptions {
    readCwds?: () => Map<string, number[]>;
    remove?: (path: string) => { ok: boolean; message: string };
    /** The caller already decided and logged an explicit live override. */
    forceLive?: boolean;
    /** Fresh liveness read per target, panes included. Takes precedence over `readCwds`. */
    liveness?: (path: string) => WorktreeLiveness;
    /** Pids of the caller's own ancestry, never a reason to keep a tree. */
    exemptPids?: ReadonlySet<number>;
}

/**
 * Remove targets, re-reading liveness immediately before each removal.
 *
 * Extracted so the re-read is testable: while the loop lived inside the `clean`
 * action, deleting the re-read, swallowing its throw, or deleting the liveness
 * branch each left the whole suite green. `readCwds` and `remove` are injectable for
 * the same reason a seam exists anywhere — a decision that cannot be made to fail is
 * not a decision.
 */
export function applyCleanRemoval(
    repoRoot: string,
    targets: CleanTarget[],
    options: CleanRemovalOptions = {},
): CleanRemovalResult {
    const readCwds = options.readCwds ?? (() => readProcessCwds('/proc', { strict: true }));
    const remove = options.remove ?? ((path: string) => removeWorktreeEntry(repoRoot, path));
    const result: CleanRemovalResult = { removed: [], becameLive: [], unreadable: [] };

    for (const target of targets) {
        let liveNow: number[];
        try {
            const liveness = options.liveness?.(target.path);
            liveNow = liveness
                ? liveness.holders.filter(holder => !options.exemptPids?.has(holder.pid)).map(holder => holder.pid)
                : livePidsFor(target.path, readCwds());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(kleur.yellow(`  ⚠ Kept ${target.path}: ${message}`));
            result.unreadable.push(target.path);
            continue;
        }
        if (liveNow.length > 0 && !options.forceLive) {
            console.log(kleur.yellow(`  ⚠ Kept ${target.path}: became live during the scan (pids ${liveNow.join(',')})`));
            result.becameLive.push(target.path);
            continue;
        }
        const removal = remove(target.path);
        if (removal.ok) {
            result.removed.push(target.path);
            console.log(t.success(`  ✓ ${removal.message}`));
        } else {
            console.log(kleur.yellow(`  ⚠ ${removal.message}`));
        }
    }

    return result;
}

function normalizeBranchName(branch: string): string {
    return branch.replace('refs/heads/', '');
}

function redactGhError(value: string): string {
    return value
        .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-token]')
        .replace(/(token|authorization|password)=([^\s]+)/gi, '$1=[redacted]')
        .trim()
        .slice(0, 500);
}

function remediationFor(classification: PrClassification): string {
    switch (classification) {
        case 'no-pr':
            return 'open a PR or skip PR drift remediation for this branch';
        case 'clean':
            return 'no PR drift remediation needed';
        case 'needs-rebase':
            return 'rebase branch onto the PR base and push with --force-with-lease';
        case 'conflicted':
            return 'manual conflict resolution required before rebase/merge can continue';
        case 'blocked':
            return 'inspect GitHub checks/review/draft status before merge or rebase automation';
        case 'closed':
            return 'PR is closed or merged; branch may be eligible for cleanup after local checks';
        case 'unknown':
            return 'retry gh PR status lookup or inspect the PR manually';
    }
}

export function classifyPrStatus(
    state: string | null | undefined,
    mergeStateStatus: string | null | undefined,
    mergeable?: string | null,
): PrClassification {
    const normalizedState = state?.toUpperCase() ?? null;
    if (!normalizedState) return 'no-pr';
    if (normalizedState === 'CLOSED' || normalizedState === 'MERGED') return 'closed';
    if (normalizedState !== 'OPEN') return 'unknown';

    const mergeState = mergeStateStatus?.toUpperCase() ?? null;
    switch (mergeState) {
        case 'CLEAN':
        case 'HAS_HOOKS':
            return 'clean';
        case 'BEHIND':
            return 'needs-rebase';
        case 'DIRTY':
            return 'conflicted';
        case 'BLOCKED':
        case 'DRAFT':
        case 'UNSTABLE':
            return 'blocked';
    }

    const normalizedMergeable = mergeable?.toUpperCase() ?? null;
    if (normalizedMergeable === 'MERGEABLE') return 'clean';
    if (normalizedMergeable === 'CONFLICTING') return 'conflicted';

    return 'unknown';
}

function resolveBaseSha(repoRoot: string, baseRefName: string | null | undefined): string | null {
    if (!baseRefName) return null;
    const refResult = git(['rev-parse', `origin/${baseRefName}`], repoRoot);
    return refResult.ok && refResult.out ? refResult.out : null;
}

function buildPrStatus(branch: string, pr: GitHubPrView | null, repoRoot: string, error?: string): PrStatus {
    const branchShort = normalizeBranchName(branch);

    if (error) {
        return {
            component: 'xt.pr_status',
            branch: branchShort,
            state: null,
            merge_state: null,
            classification: 'unknown',
            outcome: 'error',
            remediation: remediationFor('unknown'),
            error,
        };
    }

    if (!pr) {
        return {
            component: 'xt.pr_status',
            branch: branchShort,
            state: null,
            merge_state: null,
            classification: 'no-pr',
            outcome: 'no_pr',
            remediation: remediationFor('no-pr'),
        };
    }

    const state = pr.state?.toUpperCase() ?? null;
    const mergeState = pr.mergeStateStatus?.toUpperCase() ?? null;
    const classification = classifyPrStatus(state, mergeState, pr.mergeable);
    const baseSha = pr.baseRefOid ?? resolveBaseSha(repoRoot, pr.baseRefName);

    return {
        component: 'xt.pr_status',
        branch: branchShort,
        state,
        merge_state: mergeState,
        classification,
        outcome: 'ok',
        ...(pr.url ? { pr_url: pr.url } : {}),
        ...(typeof pr.number === 'number' ? { pr_number: pr.number } : {}),
        ...(pr.headRefOid ? { head_sha: pr.headRefOid } : {}),
        ...(baseSha ? { base_sha: baseSha } : {}),
        ...(pr.baseRefName ? { base_ref: pr.baseRefName } : {}),
        remediation: remediationFor(classification),
    };
}

/** Check if a branch has a PR and classify GitHub merge-state drift. */
export function getPrStatus(branch: string, repoRoot: string): PrStatus {
    const branchShort = normalizeBranchName(branch);
    const r = spawnSync('gh', [
        'pr',
        'list',
        '--head',
        branchShort,
        '--state',
        'all',
        '--json',
        'state,url,number,mergeStateStatus,mergeable,headRefOid,baseRefName',
        '--limit',
        '1',
    ], {
        cwd: repoRoot, encoding: 'utf8', stdio: 'pipe',
    });

    if (r.status !== 0) {
        return buildPrStatus(branchShort, null, repoRoot, redactGhError(r.stderr || 'gh pr list failed'));
    }

    try {
        const data = JSON.parse(r.stdout ?? '[]') as GitHubPrView[];
        if (!Array.isArray(data) || data.length === 0) return buildPrStatus(branchShort, null, repoRoot);
        return buildPrStatus(branchShort, data[0] ?? null, repoRoot);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return buildPrStatus(branchShort, null, repoRoot, redactGhError(message));
    }
}


function suggestedActionFor(status: PrStatus): string {
    switch (status.classification) {
        case 'no-pr':
            return 'open PR if this branch is still active';
        case 'clean':
            return 'no operator action required';
        case 'needs-rebase':
            return 'rebase branch onto the PR base, then push with --force-with-lease';
        case 'conflicted':
            return 'operator must resolve conflicts manually';
        case 'blocked':
            return 'operator must inspect blocked checks/reviews/draft state';
        case 'closed':
            return 'review for safe worktree cleanup';
        case 'unknown':
            return 'operator must inspect PR status manually';
    }
}

function suggestionCommandFor(repoRoot: string, status: PrStatus): string {
    const branch = status.branch;
    const prRef = status.pr_number ? String(status.pr_number) : status.pr_url;

    switch (status.classification) {
        case 'needs-rebase': {
            const baseRef = status.base_ref ?? 'main';
            return `git -C ${repoRoot} checkout ${branch} && git -C ${repoRoot} rebase origin/${baseRef} && git -C ${repoRoot} push --force-with-lease`;
        }
        case 'conflicted':
        case 'blocked':
            return prRef ? `gh pr view ${prRef} --web` : `gh pr list --head ${branch} --state all`;
        case 'closed':
            return 'xt worktree clean --dry-run';
        case 'unknown':
            return `gh pr list --head ${branch} --state all --json state,url,number,mergeStateStatus,mergeable`;
        case 'no-pr':
            return `gh pr create --head ${branch}`;
        case 'clean':
            return 'none';
    }
}

function emptyPrAuditSummary(): Record<PrClassification, number> {
    return {
        'no-pr': 0,
        clean: 0,
        'needs-rebase': 0,
        conflicted: 0,
        blocked: 0,
        closed: 0,
        unknown: 0,
    };
}

export function auditWorktreePrs(repoRoot: string, checkedAtMs = Date.now()): PrAuditReport {
    const findings = listXtWorktrees(repoRoot).map((wt): PrAuditFinding => {
        const status = getPrStatus(wt.branch, repoRoot);
        return {
            component: 'xt.pr_audit.finding',
            repo: repoRoot,
            branch: status.branch,
            ...(status.pr_url ? { pr_url: status.pr_url } : {}),
            ...(typeof status.pr_number === 'number' ? { pr_number: status.pr_number } : {}),
            state: status.state,
            merge_state: status.merge_state,
            classification: status.classification,
            outcome: status.outcome,
            suggested_action: suggestedActionFor(status),
            suggestion_command: suggestionCommandFor(repoRoot, status),
            checked_at_ms: checkedAtMs,
            ...(status.error ? { error: status.error } : {}),
        };
    });

    const summary = emptyPrAuditSummary();
    for (const finding of findings) {
        summary[finding.classification] += 1;
    }

    return {
        component: 'xt.pr_audit',
        repo: repoRoot,
        checked_at_ms: checkedAtMs,
        findings,
        summary,
    };
}

function isAttentionFinding(finding: PrAuditFinding): boolean {
    return ['needs-rebase', 'conflicted', 'blocked', 'unknown'].includes(finding.classification);
}

function printPrAuditHuman(report: PrAuditReport): void {
    console.log(t.bold('\n  xt worktree PR audit\n'));
    console.log(kleur.dim(`  repo: ${report.repo}`));
    console.log(kleur.dim(`  checked_at_ms: ${report.checked_at_ms}`));
    console.log(kleur.dim(`  worktrees checked: ${report.findings.length}`));

    const attention = report.findings.filter(isAttentionFinding);
    console.log(kleur.dim(`  operator attention: ${attention.length}`));

    if (report.findings.length === 0) {
        console.log(kleur.dim('\n  No xt worktrees found\n'));
        return;
    }

    for (const finding of report.findings) {
        const marker = isAttentionFinding(finding) ? kleur.yellow('!') : kleur.green('✓');
        const pr = finding.pr_url ? ` ${kleur.dim(finding.pr_url)}` : '';
        console.log(`\n  ${marker} ${kleur.bold(finding.branch)} ${finding.classification}${pr}`);
        if (finding.merge_state) console.log(kleur.dim(`    merge_state: ${finding.merge_state}`));
        console.log(kleur.dim(`    action: ${finding.suggested_action}`));
        console.log(kleur.dim(`    command: ${finding.suggestion_command}`));
        if (finding.error) console.log(kleur.dim(`    error: ${finding.error}`));
    }

    console.log('');
}


function normalizeBranchGcPrefixes(input: string | undefined): string[] {
    const prefixes = (input ?? 'xt/')
        .split(',')
        .map(prefix => prefix.trim())
        .filter(Boolean)
        .map(prefix => prefix.endsWith('/') || prefix.endsWith('*') ? prefix.replace(/\*$/, '') : `${prefix}/`);

    return prefixes.length > 0 ? [...new Set(prefixes)] : ['xt/'];
}

function listManagedBranches(repoRoot: string, prefixes: string[]): string[] {
    const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repoRoot);
    if (!branches.ok) return [];

    return branches.out
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .filter(branch => prefixes.some(prefix => branch.startsWith(prefix)))
        .sort();
}

function checkedOutBranches(repoRoot: string): Set<string> {
    return new Set(parseGitWorktreeList(repoRoot)
        .map(wt => wt.branch ? normalizeBranchName(wt.branch) : null)
        .filter((branch): branch is string => Boolean(branch)));
}

function branchGcReason(status: PrStatus, isCheckedOut: boolean): string {
    if (isCheckedOut) return 'branch is checked out in a worktree; remove/finish the worktree first';
    if (status.state === 'MERGED') return 'PR is merged';
    if (status.state === 'CLOSED') return 'PR is closed';

    switch (status.classification) {
        case 'closed':
            return 'PR is safely closed';
        case 'no-pr':
            return 'no PR found for branch';
        case 'unknown':
            return status.error ? `unknown PR state: ${status.error}` : 'unknown PR state';
        case 'clean':
        case 'needs-rebase':
        case 'conflicted':
        case 'blocked':
            return `PR is active (${status.classification})`;
    }
}

function buildBranchGcFinding(repoRoot: string, branch: string, status: PrStatus, checkedAtMs: number, isCheckedOut: boolean): BranchGcFinding {
    const shouldDelete = !isCheckedOut && (status.state === 'MERGED' || status.state === 'CLOSED' || status.classification === 'closed');

    return {
        component: 'xt.branch_gc.finding',
        repo: repoRoot,
        branch,
        pr_state: status.state,
        classification: status.classification,
        action: shouldDelete ? 'delete' : 'skip',
        reason: branchGcReason(status, isCheckedOut),
        outcome: shouldDelete ? 'dry_run' : 'skipped',
        checked_at_ms: checkedAtMs,
        ...(shouldDelete ? { command: `git -C ${repoRoot} branch -D ${branch}` } : {}),
        ...(status.pr_url ? { pr_url: status.pr_url } : {}),
        ...(typeof status.pr_number === 'number' ? { pr_number: status.pr_number } : {}),
        ...(status.error ? { error: status.error } : {}),
    };
}

function summarizeBranchGc(findings: BranchGcFinding[]): BranchGcReport['summary'] {
    return {
        delete: findings.filter(finding => finding.action === 'delete').length,
        skip: findings.filter(finding => finding.action === 'skip').length,
        deleted: findings.filter(finding => finding.outcome === 'deleted').length,
        failed: findings.filter(finding => finding.outcome === 'failed').length,
    };
}

export function planBranchGc(repoRoot: string, prefixes: string[], checkedAtMs = Date.now()): BranchGcReport {
    const checkedOut = checkedOutBranches(repoRoot);
    const findings = listManagedBranches(repoRoot, prefixes).map(branch => {
        const status = getPrStatus(branch, repoRoot);
        return buildBranchGcFinding(repoRoot, branch, status, checkedAtMs, checkedOut.has(branch));
    });

    return {
        component: 'xt.branch_gc',
        repo: repoRoot,
        checked_at_ms: checkedAtMs,
        mode: 'dry_run',
        prefixes,
        findings,
        summary: summarizeBranchGc(findings),
    };
}

function applyBranchGc(report: BranchGcReport): BranchGcReport {
    const findings = report.findings.map(finding => {
        if (finding.action !== 'delete') return finding;

        const result = git(['branch', '-D', finding.branch], report.repo);
        if (result.ok) {
            return { ...finding, outcome: 'deleted' as const };
        }

        return {
            ...finding,
            outcome: 'failed' as const,
            error: redactGhError(result.err || `failed to delete ${finding.branch}`),
        };
    });

    return {
        ...report,
        mode: 'apply',
        findings,
        summary: summarizeBranchGc(findings),
    };
}

function printBranchGcHuman(report: BranchGcReport): void {
    console.log(t.bold('\n  xt worktree branch GC\n'));
    console.log(kleur.dim(`  repo: ${report.repo}`));
    console.log(kleur.dim(`  mode: ${report.mode}`));
    console.log(kleur.dim(`  prefixes: ${report.prefixes.join(', ')}`));
    console.log(kleur.dim(`  branches checked: ${report.findings.length}`));
    console.log(kleur.dim(`  delete candidates: ${report.summary.delete}`));

    if (report.findings.length === 0) {
        console.log(kleur.dim('\n  No managed branches found\n'));
        return;
    }

    for (const finding of report.findings) {
        const marker = finding.action === 'delete' ? kleur.yellow('delete') : kleur.dim('skip');
        const outcome = finding.outcome === 'dry_run' ? 'dry-run' : finding.outcome;
        console.log(`\n  ${marker} ${kleur.bold(finding.branch)} ${kleur.dim(`(${outcome})`)}`);
        console.log(kleur.dim(`    pr_state: ${finding.pr_state ?? 'null'} classification: ${finding.classification}`));
        console.log(kleur.dim(`    reason: ${finding.reason}`));
        if (finding.command) console.log(kleur.dim(`    command: ${finding.command}`));
        if (finding.error) console.log(kleur.dim(`    error: ${finding.error}`));
    }

    if (report.mode === 'dry_run' && report.summary.delete > 0) {
        console.log(kleur.yellow('\n  Dry run — no branches deleted. Re-run with --apply --yes to delete candidates.\n'));
    } else {
        console.log('');
    }
}


function emptyRestartAuditSummary(): Record<RestartAuditFindingKind, number> {
    return {
        'orphaned-managed-dir': 0,
        'prunable-worktree': 0,
        'branch-without-worktree': 0,
        'pr-attention': 0,
        'closed-pr-branch': 0,
    };
}

function restartAuditFinding(
    repoRoot: string,
    checkedAtMs: number,
    finding: Omit<RestartAuditFinding, 'component' | 'repo' | 'checked_at_ms'>,
): RestartAuditFinding {
    return {
        component: 'xt.restart_audit.finding',
        repo: repoRoot,
        checked_at_ms: checkedAtMs,
        ...finding,
    };
}

function isPrAttentionClassification(classification: PrClassification): boolean {
    return ['needs-rebase', 'conflicted', 'blocked', 'unknown'].includes(classification);
}

export function restartAudit(repoRoot: string, prefixes: string[], checkedAtMs = Date.now()): RestartAuditReport {
    const findings: RestartAuditFinding[] = [];
    const worktrees = listXtWorktrees(repoRoot);
    const worktreeByBranch = new Map<string, WorktreeInfo>();

    for (const wt of worktrees) {
        const branch = normalizeBranchName(wt.branch);
        worktreeByBranch.set(branch, wt);

        if (wt.prunable) {
            findings.push(restartAuditFinding(repoRoot, checkedAtMs, {
                worktree_path: wt.path,
                branch,
                pr_classification: null,
                finding_kind: 'prunable-worktree',
                suggested_action: 'prune stale git worktree metadata after verifying no active session owns it',
                suggestion_command: `git -C ${repoRoot} worktree prune --expire now`,
            }));
        }
    }

    for (const orphanPath of listOrphanManagedDirs(repoRoot)) {
        findings.push(restartAuditFinding(repoRoot, checkedAtMs, {
            worktree_path: orphanPath,
            branch: null,
            pr_classification: null,
            finding_kind: 'orphaned-managed-dir',
            suggested_action: 'inspect orphaned managed directory, then run orphan cleanup if safe',
            suggestion_command: 'xt worktree clean --orphans --dry-run',
        }));
    }

    for (const branch of listManagedBranches(repoRoot, prefixes)) {
        const status = getPrStatus(branch, repoRoot);
        const wt = worktreeByBranch.get(branch);
        const baseFields = {
            worktree_path: wt?.path ?? null,
            branch,
            pr_classification: status.classification,
            ...(status.pr_url ? { pr_url: status.pr_url } : {}),
            ...(typeof status.pr_number === 'number' ? { pr_number: status.pr_number } : {}),
            ...(status.error ? { error: status.error } : {}),
        };

        if (!wt) {
            findings.push(restartAuditFinding(repoRoot, checkedAtMs, {
                ...baseFields,
                finding_kind: 'branch-without-worktree',
                suggested_action: 'inspect branch owner/state; if PR is closed, branch-gc can propose cleanup',
                suggestion_command: `xt worktree branch-gc --prefix ${prefixes.join(',')} --json`,
            }));
        }

        if (isPrAttentionClassification(status.classification)) {
            findings.push(restartAuditFinding(repoRoot, checkedAtMs, {
                ...baseFields,
                finding_kind: 'pr-attention',
                suggested_action: suggestedActionFor(status),
                suggestion_command: suggestionCommandFor(repoRoot, status),
            }));
        }

        if (status.classification === 'closed') {
            findings.push(restartAuditFinding(repoRoot, checkedAtMs, {
                ...baseFields,
                finding_kind: 'closed-pr-branch',
                suggested_action: wt
                    ? 'PR is closed; finish/remove the worktree before branch cleanup'
                    : 'PR is closed; branch-gc can propose safe local branch cleanup',
                suggestion_command: wt ? 'xt worktree clean --dry-run' : `xt worktree branch-gc --prefix ${prefixes.join(',')} --json`,
            }));
        }
    }

    const summary = emptyRestartAuditSummary();
    for (const finding of findings) {
        summary[finding.finding_kind] += 1;
    }

    return {
        component: 'xt.restart_audit',
        repo: repoRoot,
        checked_at_ms: checkedAtMs,
        prefixes,
        findings,
        summary,
    };
}

function printRestartAuditHuman(report: RestartAuditReport): void {
    console.log(t.bold('\n  xt worktree restart audit\n'));
    console.log(kleur.dim(`  repo: ${report.repo}`));
    console.log(kleur.dim(`  checked_at_ms: ${report.checked_at_ms}`));
    console.log(kleur.dim(`  prefixes: ${report.prefixes.join(', ')}`));
    console.log(kleur.dim(`  findings: ${report.findings.length}`));

    if (report.findings.length === 0) {
        console.log(t.success('\n  ✓ No restart reconciliation findings\n'));
        return;
    }

    for (const finding of report.findings) {
        console.log(`\n  ${kleur.yellow('!')} ${kleur.bold(finding.finding_kind)}`);
        console.log(kleur.dim(`    branch: ${finding.branch ?? 'null'}`));
        console.log(kleur.dim(`    worktree_path: ${finding.worktree_path ?? 'null'}`));
        console.log(kleur.dim(`    pr_classification: ${finding.pr_classification ?? 'null'}`));
        console.log(kleur.dim(`    action: ${finding.suggested_action}`));
        console.log(kleur.dim(`    command: ${finding.suggestion_command}`));
        if (finding.error) console.log(kleur.dim(`    error: ${finding.error}`));
    }

    console.log('');
}

/** Every worktree registered in this repo, including specialist `.worktrees/<beadId>/*` trees. */
function listAllWorktrees(repoRoot: string): { path: string; branch: string | null; isMain: boolean }[] {
    const raw = parseGitWorktreeList(repoRoot);
    const mainPath = resolve(repoRoot);

    return raw.map(wt => ({
        path: wt.path,
        branch: wt.branch ? normalizeBranchName(wt.branch) : null,
        isMain: resolve(wt.path) === mainPath,
    }));
}

/** Git repositories one level under each root. Worktrees span repos, so a per-repo sweep leaks. */
function discoverRepos(roots: string[]): string[] {
    const repos: string[] = [];

    for (const root of roots) {
        if (!existsSync(root)) continue;

        let entries: string[];
        try {
            entries = readdirSync(root);
        } catch {
            continue;
        }

        for (const entry of entries) {
            const candidate = join(root, entry);
            try {
                if (!statSync(candidate).isDirectory()) continue;
            } catch {
                continue;
            }
            if (existsSync(join(candidate, '.git'))) repos.push(candidate);
        }
    }

    return [...new Set(repos)].sort();
}

/**
 * One wording for both destructive actions. `clean` and `reap` delete worktrees, so both
 * must refuse when the process table cannot be read; printing two different sentences for
 * the same condition is how a reader concludes one of them is advisory.
 */
export function refuseWithoutProcessTable(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.log(kleur.red(`\n  ✖ ${message}`));
    console.log(kleur.dim('  Nothing was removed: without the process table this command cannot tell a live worktree from an idle one.\n'));
    process.exitCode = 1;
}

/**
 * Refuse every path a live process or tmux pane is using (CORE-2814), naming the
 * holders. Returns the paths that may proceed. `--force-live` overrides and is
 * logged; the caller's own worktree is exempt because `xt end` removes it while
 * still standing in it.
 */
export function keepLivePaths(
    paths: string[],
    opts: { command: string; repoRoot: string; forceLive: boolean },
    probe: (path: string) => WorktreeLiveness = createLivenessProbe(),
): string[] {
    const ownPids = callerProcessIds();
    const callerRoot = callerWorktreeRoot();
    const keep: string[] = [];

    for (const path of paths) {
        if (isCallerWorktree(path, callerRoot)) {
            keep.push(path);
            continue;
        }
        const liveness = probe(path);
        const holders = liveness.holders.filter(holder => !ownPids.has(holder.pid));
        if (holders.length === 0) {
            keep.push(path);
            continue;
        }
        const report = livenessReport({ ...liveness, holders });
        if (opts.forceLive) {
            const logPath = logLivenessOverride({
                repoRoot: opts.repoRoot,
                command: opts.command,
                path,
                holders,
                warnings: liveness.warnings,
            });
            console.log(kleur.yellow(`  ⚠ Removing live worktree ${path} (${opts.command} --force-live)${logPath ? `; logged to ${logPath}` : ''}`));
            for (const line of report) console.log(kleur.dim(`      ${line}`));
            keep.push(path);
            continue;
        }
        console.log(kleur.red(`  ✖ Refusing ${path}: ${holders.length} live holder(s) inside`));
        for (const line of report) console.log(kleur.dim(`      ${line}`));
    }

    return keep;
}

/**
 * The one way to obtain the process table for a destructive action. It prints the shared
 * refusal and returns null when the table cannot be read, so a caller cannot forget the
 * check: `planReap` requires the map as an input, which means both `clean` and `reap` have
 * to come through here to get one.
 */
export function readProcessTableOrRefuse(procRoot = '/proc'): Map<string, number[]> | null {
    try {
        return readProcessCwds(procRoot, { strict: true });
    } catch (error) {
        refuseWithoutProcessTable(error);
        return null;
    }
}

export interface ReapOptions {
    repos: string[];
    currentPath: string;
    artifactThresholdDays: number;
    worktreeThresholdDays: number;
    now?: number;
    /** Read through `readProcessTableOrRefuse`; required so no caller can plan blind. */
    cwds: Map<string, number[]>;
    /** CORE-2814: pane/cwd holders the process table alone cannot see. */
    liveness?: (path: string) => WorktreeLiveness;
    ownPids?: Set<number>;
    /** Report a live candidate as reapable anyway; the override is logged at apply time. */
    forceLive?: boolean;
}

export function planReap(opts: ReapOptions): ReapPlan {
    const cwds = opts.cwds;
    const checkedAtMs = opts.now ?? Date.now();
    const candidates: ReapCandidate[] = [];

    // Two repo directories can register the same worktree path — a clone and a copy of the
    // same repo both list it. Evaluating it twice double-counts its bytes and makes the
    // second removal fail against a path the first one already removed.
    const seen = new Set<string>();

    for (const repoRoot of opts.repos) {
        for (const wt of listAllWorktrees(repoRoot)) {
            if (!existsSync(wt.path)) continue;

            const key = resolve(wt.path);
            if (seen.has(key)) continue;
            seen.add(key);

            let candidate = evaluateWorktree({
                repoRoot,
                worktreePath: wt.path,
                branch: wt.branch,
                isMainWorktree: wt.isMain,
                currentPath: opts.currentPath,
                cwds,
                artifactThresholdDays: opts.artifactThresholdDays,
                worktreeThresholdDays: opts.worktreeThresholdDays,
                now: checkedAtMs,
            });

            const holders = opts.liveness
                ? opts.liveness(candidate.path).holders.filter(holder => !opts.ownPids?.has(holder.pid))
                : [];
            if (holders.length > 0) {
                const detail = `${opts.forceLive ? '--force-live' : 'in use'}: ${formatWorktreeHolders(holders).join('; ')}`;
                const live = Boolean(opts.forceLive);
                candidate = {
                    ...candidate,
                    reapable: live && candidate.reapable,
                    artifactsReclaimable: live && candidate.artifactsReclaimable,
                    conditions: candidate.conditions.map(condition => condition.name === 'no-live-process'
                        ? { name: 'no-live-process' as const, pass: live, detail }
                        : condition),
                };
            }

            candidates.push(candidate);
        }
    }

    return {
        component: 'xt.worktree_reap',
        checked_at_ms: checkedAtMs,
        mode: 'dry_run',
        artifact_threshold_days: opts.artifactThresholdDays,
        worktree_threshold_days: opts.worktreeThresholdDays,
        repos: opts.repos,
        candidates,
        summary: summarize(candidates),
    };
}

export interface ReapOutcome {
    component: 'xt.worktree_reap.outcome';
    path: string;
    action: 'worktree-removed' | 'artifacts-reclaimed' | 'held' | 'failed';
    freed_bytes: number;
    blocked_bytes: number;
    detail: string;
}

/**
 * Execute the plan bottom-up on the risk ladder: regenerable artifacts first, whole
 * worktrees second. Root-owned trees are reported and escalated, never absorbed into
 * the reclaim total.
 */
export interface ApplyReapOptions {
    procRoot?: string;
    /** CORE-2814: pane/cwd liveness re-read for every candidate before removal. */
    liveness?: (path: string) => WorktreeLiveness;
    ownPids?: Set<number>;
    forceLive?: boolean;
    command?: string;
    repoRoot?: string;
}

export function applyReap(plan: ReapPlan, options: ApplyReapOptions = {}): { plan: ReapPlan; outcomes: ReapOutcome[] } {
    const outcomes: ReapOutcome[] = [];
    const removed: string[] = [];

    // Re-read process cwds now. Scanning the host takes tens of seconds, so the reading
    // taken during planning is already stale by the time anything is deleted: an agent that
    // attached to an idle worktree mid-scan would have it removed underneath them. This is
    // the one condition that can flip inside that window — idle age, cleanliness and push
    // state cannot become unsafe in a minute, but "in use right now" can.
    //
    // The re-read narrows the window; it does not close it. A process that attaches between
    // this read and the `git worktree remove` call still loses its worktree. Closing it would
    // mean holding the directory open or re-checking after removal, and neither is available
    // to a shell command.
    //
    // It is STRICT: an unreadable table here would answer "no pids" for every candidate, and
    // the loop below would then remove worktrees that are in use — the defect this command
    // refuses for at planning time, arriving one step later.
    const cwdsNow = readProcessCwds(options.procRoot ?? '/proc', { strict: true });

    for (const candidate of plan.candidates) {
        const livePids = livePidsFor(candidate.path, cwdsNow);
        const holders = options.liveness
            ? options.liveness(candidate.path).holders.filter(holder => !options.ownPids?.has(holder.pid))
            : [];
        if (holders.length > 0 && (candidate.reapable || candidate.artifactsReclaimable)) {
            if (options.forceLive) {
                const logPath = logLivenessOverride({
                    repoRoot: options.repoRoot ?? plan.repos[0] ?? candidate.repo,
                    command: options.command ?? 'xt worktree reap',
                    path: candidate.path,
                    holders,
                });
                console.log(kleur.yellow(`  ⚠ Removing live worktree ${candidate.path} (--force-live)${logPath ? `; logged to ${logPath}` : ''}`));
            } else {
                outcomes.push({
                    component: 'xt.worktree_reap.outcome',
                    path: candidate.path,
                    action: 'held',
                    freed_bytes: 0,
                    blocked_bytes: 0,
                    detail: `in use: ${formatWorktreeHolders(holders).join('; ')}`,
                });
                continue;
            }
        }
        if (livePids.length > 0 && (candidate.reapable || candidate.artifactsReclaimable)) {
            outcomes.push({
                component: 'xt.worktree_reap.outcome',
                path: candidate.path,
                action: 'held',
                freed_bytes: 0,
                blocked_bytes: 0,
                detail: `became live during the scan: pids ${livePids.join(',')} have cwd inside`,
            });
            continue;
        }

        // A worktree nested under one already removed went with its parent. Reporting that
        // as a failure would understate the reclaim and invent a problem that does not exist.
        if (removed.some(parent => candidate.path.startsWith(`${parent}${sep}`))) {
            outcomes.push({
                component: 'xt.worktree_reap.outcome',
                path: candidate.path,
                action: 'worktree-removed',
                freed_bytes: 0,
                blocked_bytes: 0,
                detail: 'removed together with its parent worktree; bytes counted there',
            });
            continue;
        }

        if (candidate.reapable) {
            if (candidate.blockedBytes > 0) {
                outcomes.push({
                    component: 'xt.worktree_reap.outcome',
                    path: candidate.path,
                    action: 'held',
                    freed_bytes: 0,
                    blocked_bytes: candidate.blockedBytes,
                    detail: `root-owned tree blocks unprivileged removal: ${candidate.rootOwnedPaths.slice(0, 3).join(', ')}`,
                });
                continue;
            }

            const result = removeWorktreeEntry(candidate.repo, candidate.path);
            if (result.ok) removed.push(candidate.path);

            outcomes.push({
                component: 'xt.worktree_reap.outcome',
                path: candidate.path,
                action: result.ok ? 'worktree-removed' : 'failed',
                freed_bytes: result.ok ? candidate.totalBytes : 0,
                blocked_bytes: 0,
                detail: result.message,
            });
            continue;
        }

        if (candidate.artifactsReclaimable) {
            let freed = 0;
            let blocked = 0;
            const failures: string[] = [];

            for (const artifact of candidate.artifacts) {
                try {
                    rmSync(artifact.path, { recursive: true, force: true });
                    freed += artifact.bytes;
                } catch (error) {
                    blocked += artifact.bytes;
                    failures.push(`${artifact.path}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            outcomes.push({
                component: 'xt.worktree_reap.outcome',
                path: candidate.path,
                action: failures.length === candidate.artifacts.length && failures.length > 0 ? 'failed' : 'artifacts-reclaimed',
                freed_bytes: freed,
                blocked_bytes: blocked,
                detail: failures.length > 0
                    ? `held by: ${failures.slice(0, 2).join('; ')}`
                    : `reclaimed ${candidate.artifacts.length} artifact dir(s); held by ${candidate.failed.join(', ')}`,
            });
            continue;
        }

        outcomes.push({
            component: 'xt.worktree_reap.outcome',
            path: candidate.path,
            action: 'held',
            freed_bytes: 0,
            blocked_bytes: candidate.blockedBytes,
            detail: candidate.failed.length > 0 ? `failed: ${candidate.failed.join(', ')}` : 'nothing to reclaim',
        });
    }

    // Children removed with a parent leave stale admin entries behind. Without this the
    // next sweep re-lists paths that no longer exist and reports them as failures.
    if (removed.length > 0) {
        for (const repoRoot of plan.repos) runGitWorktreePrune(repoRoot);
    }

    return { plan: { ...plan, mode: 'apply' }, outcomes };
}

function resolveXtBinary(): string {
    const which = spawnSync('which', ['xt'], { encoding: 'utf8', stdio: 'pipe' });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
    return `${process.execPath} ${process.argv[1] ?? 'xt'}`;
}

export interface ReapTimerUnit {
    path: string;
    content: string;
}

/**
 * Install the out-of-band sweep.
 *
 * Modes are set explicitly with chmod, never inherited and never via `cp -p`: this
 * shell runs umask 077 and a preserved mode has already caused a production outage.
 */
export function installReapTimer(opts: {
    artifactsOlderThan: string;
    worktreesOlderThan: string;
    roots: string;
    dryRun: boolean;
}): { units: ReapTimerUnit[]; messages: string[] } {
    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    const exec = `${resolveXtBinary()} worktree reap --all-repos --roots ${opts.roots} --artifacts-older-than ${opts.artifactsOlderThan} --worktrees-older-than ${opts.worktreesOlderThan} --apply --yes`;

    const units: ReapTimerUnit[] = [
        {
            path: join(unitDir, 'xt-worktree-reap.service'),
            content: `[Unit]
Description=xt worktree reap — reclaim abandoned worktrees and regenerable artifacts
Documentation=https://github.com/xtrm-dev/core

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=${exec}
`,
        },
        {
            path: join(unitDir, 'xt-worktree-reap.timer'),
            content: `[Unit]
Description=Run xt worktree reap daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
`,
        },
    ];

    if (opts.dryRun) return { units, messages: [] };

    mkdirSync(unitDir, { recursive: true, mode: 0o755 });
    chmodSync(unitDir, 0o755);

    for (const unit of units) {
        writeFileSync(unit.path, unit.content, 'utf8');
        chmodSync(unit.path, 0o644);
    }

    const messages: string[] = [];
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'xt-worktree-reap.timer']]) {
        const r = spawnSync('systemctl', args, { encoding: 'utf8', stdio: 'pipe' });
        messages.push(r.status === 0
            ? `systemctl ${args.join(' ')} ok`
            : `systemctl ${args.join(' ')} failed: ${(r.stderr ?? '').trim() || 'unknown error'}`);
    }

    return { units, messages };
}

function printReapHuman(plan: ReapPlan, outcomes: ReapOutcome[] | null): void {
    console.log(t.bold('\n  xt worktree reap\n'));
    console.log(kleur.dim(`  mode: ${plan.mode}`));
    console.log(kleur.dim(`  repos: ${plan.repos.length}`));
    console.log(kleur.dim(`  thresholds: artifacts ${plan.artifact_threshold_days}d, worktrees ${plan.worktree_threshold_days}d`));
    console.log(kleur.dim(`  worktrees checked: ${plan.summary.checked}`));

    for (const candidate of plan.candidates) {
        const label = candidate.reapable
            ? kleur.yellow('reap')
            : candidate.artifactsReclaimable ? kleur.cyan('artifacts') : kleur.dim('hold');
        const idle = candidate.idleDays === null ? 'no work files' : `${candidate.idleDays.toFixed(1)}d idle`;

        console.log(`\n  ${label} ${kleur.bold(candidate.branch ?? candidate.path)}`);
        console.log(kleur.dim(`    path: ${candidate.path}`));
        console.log(kleur.dim(`    ${idle} · total ${formatBytes(candidate.totalBytes)} · artifacts ${formatBytes(candidate.artifactBytes)}`));

        for (const condition of candidate.conditions) {
            const mark = condition.pass ? kleur.green('✓') : kleur.red('✗');
            console.log(kleur.dim(`    ${mark} ${condition.name}: ${condition.detail}`));
        }

        if (candidate.rootOwnedPaths.length > 0) {
            console.log(kleur.red(`    ⚠ root-owned: ${formatBytes(candidate.blockedBytes)} blocked — escalate`));
            for (const path of candidate.rootOwnedPaths.slice(0, 3)) {
                console.log(kleur.dim(`      ${path}`));
            }
        }
    }

    console.log(t.bold('\n  summary'));
    console.log(kleur.dim(`    reapable worktrees:  ${plan.summary.reapable}`));
    console.log(kleur.dim(`    artifact-only:       ${plan.summary.artifacts_only}`));
    console.log(kleur.dim(`    held:                ${plan.summary.held}`));
    console.log(kleur.dim(`    reclaimable:         ${formatBytes(plan.summary.reclaimable_bytes)}`));
    console.log(kleur.dim(`    artifacts on disk:   ${formatBytes(plan.summary.artifact_bytes)}`));

    if (plan.summary.blocked_bytes > 0) {
        console.log(kleur.red(`    BLOCKED (root-owned): ${formatBytes(plan.summary.blocked_bytes)} across ${plan.summary.root_owned_trees} tree(s) — escalate, not reclaimable unprivileged`));
    }
    if (plan.summary.scan_truncated > 0) {
        console.log(kleur.yellow(`    scan truncated:      ${plan.summary.scan_truncated} worktree(s) exceeded the entry bound and were held`));
    }

    if (outcomes) {
        const freed = outcomes.reduce((sum, outcome) => sum + outcome.freed_bytes, 0);
        console.log(t.boldGreen(`\n  ✓ freed ${formatBytes(freed)}`));
        for (const outcome of outcomes.filter(o => o.action !== 'held')) {
            console.log(kleur.dim(`    ${outcome.action} ${outcome.path} (${formatBytes(outcome.freed_bytes)}) ${outcome.detail}`));
        }
        console.log('');
        return;
    }

    console.log(kleur.yellow('\n  Dry run — nothing removed. Re-run with --apply --yes to reclaim.\n'));
}

function removeWorktreeEntry(repoRoot: string, worktreePath: string): { ok: boolean; message: string } {
    // CORE-2792 review (item 4): the ledger is keyed by the canonical path, and
    // realpath cannot answer once the directory is gone — resolve it first.
    const ledgerPath = canonicalWorktreePath(worktreePath);
    const remove = git(['worktree', 'remove', worktreePath, '--force'], repoRoot);
    if (!remove.ok) {
        return { ok: false, message: remove.err || `could not remove ${worktreePath}` };
    }

    unregisterPluginsForWorktree(worktreePath);
    clearStatuslineClaim(repoRoot);
    // CORE-2792: the launch ledger names this path, so it goes with the worktree.
    removeLaunchLedger(homedir(), ledgerPath);
    return { ok: true, message: `Removed ${worktreePath}` };
}

export function getRepoRoot(cwd: string): string {
    const commonDirResult = git(['rev-parse', '--git-common-dir'], cwd);
    if (commonDirResult.ok && commonDirResult.out) {
        const commonDir = isAbsolute(commonDirResult.out)
            ? commonDirResult.out
            : resolve(cwd, commonDirResult.out);
        return commonDir.endsWith('/.git') || commonDir.endsWith('\\.git')
            ? dirname(commonDir)
            : commonDir;
    }

    const fallback = git(['rev-parse', '--show-toplevel'], cwd);
    return fallback.ok && fallback.out ? fallback.out : cwd;
}

/**
 * Print every class the clean plan computed, with its reason.
 *
 * Split out of the action so the printed lines have a falsifier: the plan was
 * pinned while the only lines a user reads were not, and deleting them left the
 * suite green. A classification the reader never sees is the same defect as one
 * the planner never made.
 */
export function printCleanPlan(plan: CleanPlan, orphansSkippedLive: CleanTarget[] = []): void {
    const { removable, skippedLive, unmerged } = plan;

    if (removable.length > 0) {
        console.log(kleur.bold(`  ${removable.length} merged worktree(s):`));
        for (const wt of removable) {
            console.log(kleur.dim(`    - ${wt.path} (${wt.branch})`));
        }
    }

    if (skippedLive.length > 0) {
        console.log(kleur.bold(`\n  ${skippedLive.length} merged worktree(s) kept, in use right now:`));
        for (const wt of skippedLive) {
            console.log(kleur.dim(`    - ${wt.path} (${wt.branch || 'detached'}) in use: pids ${wt.livePids.join(',')}`));
        }
        console.log(kleur.dim('    A live worktree is removed after its session ends, or with `xt worktree remove`.'));
    }

    if (unmerged.length > 0) {
        console.log(kleur.bold(`\n  ${unmerged.length} worktree(s) kept, not merged:`));
        for (const wt of unmerged) {
            console.log(kleur.dim(`    - ${wt.path} (${wt.branch || 'detached'}) not merged into the default branch`));
        }
    }

    if (orphansSkippedLive.length > 0) {
        console.log(kleur.bold(`\n  ${orphansSkippedLive.length} orphaned director(y/ies) kept, in use right now:`));
        for (const orphan of orphansSkippedLive) {
            console.log(kleur.dim(`    - ${orphan.path} in use: pids ${orphan.livePids.join(',')}`));
        }
        console.log(kleur.dim('    A directory in use is removed after the process inside it ends.'));
    }
}

/**
 * True when the scan found nothing at all, kept or removable. A scan whose only
 * finding is a live orphan is NOT empty: it found something, and saying so is the
 * whole point of keeping it. Extracted so the guard can be tested; inside the
 * action it was reachable only by running the command.
 */
export function cleanScanIsEmpty(scan: CleanScan): boolean {
    return scan.plan.removable.length === 0
        && scan.plan.skippedLive.length === 0
        && scan.plan.unmerged.length === 0
        && scan.orphans.length === 0
        && scan.orphansSkippedLive.length === 0;
}

/**
 * Everything `clean` prints about the plan: the banner, the worktree classes and
 * the orphan class. The orphan list is passed to `printCleanPlan` HERE rather than
 * at the call site, so the two classes cannot be separated again by a caller.
 */
export function renderCleanPlan(scan: CleanScan, opts: { orphans: boolean }): void {
    console.log(t.bold('\n  xt worktree clean\n'));
    printCleanPlan(
        { removable: scan.plan.removable, skippedLive: scan.plan.skippedLive, unmerged: scan.plan.unmerged },
        scan.orphansSkippedLive,
    );

    if (opts.orphans) {
        console.log(kleur.bold(`\n  ${scan.orphans.length} orphaned managed director(y/ies):`));
        for (const orphan of scan.orphans) {
            console.log(kleur.dim(`    - ${orphan.path}`));
        }
        console.log(kleur.dim('    - git worktree prune --expire now'));
    }
}

/**
 * The status `xt worktree list` prints for one worktree.
 *
 * The HEAD is passed for a detached tree: without it the predicate answers off an
 * empty branch name and `list` says "open" for a tree `clean` calls removable.
 * Extracted so the call site has a falsifier — dropping `wt.head` here reddens a
 * test instead of silently reintroducing the disagreement.
 */
export function worktreeListStatus(wt: WorktreeInfo, repoRoot: string): 'merged' | 'open' {
    return isMergedIntoMain(wt.branch, repoRoot, wt.head) ? 'merged' : 'open';
}

export function createWorktreeCommand(): Command {
    const cmd = new Command('worktree')
        .description('Manage xt session worktrees');

    cmd.command('list')
        .description('List all active xt/* worktrees with status')
        .action(async () => {
            const repoRoot = getRepoRoot(process.cwd());
            const worktrees = listXtWorktrees(repoRoot);

            if (worktrees.length === 0) {
                console.log(kleur.dim('\n  No xt worktrees found\n'));
                return;
            }

            console.log(t.bold(`\n  xt worktrees (${worktrees.length})\n`));
            for (const wt of worktrees) {
                const branch = wt.branch.replace('refs/heads/', '');
                const slug = branch.replace('xt/', '');
                // The HEAD is passed for a detached tree: without it the answer is "open" for a
                // tree whose HEAD is an ancestor of the base, and `clean` calls that removable.
                const status = worktreeListStatus(wt, repoRoot) === 'merged' ? kleur.green('merged') : kleur.yellow('open');
                const prunable = wt.prunable ? kleur.dim(' [prunable]') : '';
                const runtimeBadge = wt.runtime ? kleur.cyan(` [${wt.runtime}]`) : '';
                const nestedBadge = wt.nestedInPath ? kleur.red(' [nested]') : '';
                const timeStr = wt.lastLogTime
                    ? kleur.dim(wt.lastLogTime.toLocaleString())
                    : wt.launchedAt
                        ? kleur.dim(new Date(wt.launchedAt).toLocaleString())
                        : '';
                const logLine = wt.lastLogMsg ? kleur.dim(`  "${wt.lastLogMsg}"`) : '';

                console.log(`  ${status}${runtimeBadge}${nestedBadge} ${kleur.bold(branch)}${prunable}`);
                if (timeStr) console.log(`    last activity: ${timeStr}${logLine}`);
                console.log(kleur.dim(`    path: ${wt.path}`));
                console.log(kleur.dim(`    resume: xt attach ${slug}`));
                if (wt.nestedInPath) {
                    console.log(kleur.red(`    nested under: ${wt.nestedInPath}`));
                    console.log(kleur.dim('    remediation: xt worktree clean --orphans --dry-run'));
                }
                console.log('');
            }
        });

    cmd.command('audit-prs')
        .description('Audit xt worktree PR merge-state and operator attention items (audit-only)')
        .option('--json', 'Print machine-readable audit report', false)
        .action((opts: { json: boolean }) => {
            const repoRoot = getRepoRoot(process.cwd());
            const report = auditWorktreePrs(repoRoot);

            if (opts.json) {
                console.log(JSON.stringify(report, null, 2));
                return;
            }

            printPrAuditHuman(report);
        });

    cmd.command('branch-gc')
        .description('Dry-run or apply deletion of managed branches whose PRs are closed or merged')
        .option('--prefix <prefixes>', 'Comma-separated managed branch prefixes (default: xt/)', 'xt/')
        .option('--apply', 'Delete candidates (default is dry-run)', false)
        .option('-y, --yes', 'Skip confirmation prompt with --apply', false)
        .option('--json', 'Print machine-readable branch GC report', false)
        .action(async (opts: { prefix: string; apply: boolean; yes: boolean; json: boolean }) => {
            const repoRoot = getRepoRoot(process.cwd());
            const prefixes = normalizeBranchGcPrefixes(opts.prefix);
            let report = planBranchGc(repoRoot, prefixes);

            if (opts.apply && report.summary.delete > 0) {
                const doDelete = await confirmDestructiveAction({
                    yes: opts.yes,
                    message: `Delete ${report.summary.delete} managed branch(es)?`,
                    initial: false,
                });

                if (doDelete) {
                    report = applyBranchGc(report);
                }
            }

            if (opts.json) {
                console.log(JSON.stringify(report, null, 2));
                return;
            }

            printBranchGcHuman(report);
        });

    cmd.command('restart-audit')
        .description('Restart-safe audit of managed worktrees, branches, and PR drift (audit-only)')
        .option('--prefix <prefixes>', 'Comma-separated managed branch prefixes (default: xt/)', 'xt/')
        .option('--json', 'Print machine-readable restart audit report', false)
        .action((opts: { prefix: string; json: boolean }) => {
            const repoRoot = getRepoRoot(process.cwd());
            const prefixes = normalizeBranchGcPrefixes(opts.prefix);
            const report = restartAudit(repoRoot, prefixes);

            if (opts.json) {
                console.log(JSON.stringify(report, null, 2));
                return;
            }

            printRestartAuditHuman(report);
        });

    cmd.command('doctor')
        .description('Diagnose stale/nested/orphaned worktree state and suggest remediation')
        .action(() => {
            const repoRoot = getRepoRoot(process.cwd());
            const xtWorktrees = listXtWorktrees(repoRoot);
            const orphanDirs = listOrphanManagedDirs(repoRoot);
            const prunable = xtWorktrees.filter(wt => wt.prunable);
            const nested = xtWorktrees.filter(wt => Boolean(wt.nestedInPath));

            console.log(t.bold('\n  xt worktree doctor\n'));
            console.log(kleur.dim(`  repo: ${repoRoot}`));
            console.log(kleur.dim(`  active xt worktrees: ${xtWorktrees.length}`));
            console.log(kleur.dim(`  prunable entries:    ${prunable.length}`));
            console.log(kleur.dim(`  nested entries:      ${nested.length}`));
            console.log(kleur.dim(`  orphan dirs:         ${orphanDirs.length}`));

            if (nested.length > 0) {
                console.log(kleur.red('\n  Nested worktree roots detected:'));
                for (const wt of nested) {
                    console.log(kleur.red(`    - ${wt.path}`));
                    if (wt.nestedInPath) console.log(kleur.dim(`      parent: ${wt.nestedInPath}`));
                }
            }

            if (orphanDirs.length > 0) {
                console.log(kleur.yellow('\n  Orphaned .xtrm/worktrees directories:'));
                for (const orphan of orphanDirs) {
                    console.log(kleur.yellow(`    - ${orphan}`));
                }
            }

            // prefix+X is a separate install surface: report it here so a missing snippet is
            // visible from the same command that reports worktree state.
            const keybinding = gatherKeybindingProbes();
            const keybindingFailing = keybinding.filter(probe => !probe.ok).length;
            console.log(kleur.bold('\n  prefix+X release binding:'));
            for (const probe of keybinding) {
                const mark = probe.ok ? t.success('  ✓') : kleur.red('  ✗');
                console.log(`${mark} ${probe.label}: ${probe.detail}`);
            }

            if (nested.length === 0 && orphanDirs.length === 0 && prunable.length === 0 && keybindingFailing === 0) {
                console.log(t.success('\n  ✓ No stale worktree issues detected\n'));
                return;
            }

            console.log(kleur.bold('\n  Remediation:'));
            if (keybindingFailing > 0) console.log(kleur.dim('    xt worktree install-keybinding'));
            console.log(kleur.dim('    xt worktree clean --orphans --dry-run'));
            console.log(kleur.dim('    xt worktree clean --orphans --yes'));
            console.log(kleur.dim(`    git -C ${repoRoot} worktree prune --expire now`));
            console.log('');
        });

    cmd.command('clean')
        .description('Remove merged xt worktrees and optionally sweep stale/orphaned worktree state')
        .option('-y, --yes', 'Skip confirmation prompt', false)
        .option('--dry-run', 'Preview clean targets without removing anything', false)
        .option('--orphans', 'Also prune stale git worktree metadata and remove orphan .xtrm/worktrees dirs', false)
        .option('--force-live', 'Remove targets a live process or tmux pane is using (logged)', false)
        .action(async (opts: { yes: boolean; dryRun: boolean; orphans: boolean; forceLive: boolean }) => {
            const repoRoot = getRepoRoot(process.cwd());
            const worktrees = listXtWorktrees(repoRoot);

            // A worktree whose session is still running is not a cleanup target, and
            // the process table is the only thing that knows. `scanCleanTargets` refuses
            // as a whole when it cannot be read: an empty map and an unreadable one look
            // alike, and the difference is somebody's uncommitted work.
            const scan = scanCleanTargets({
                worktrees,
                orphans: opts.orphans ? listOrphanManagedDirs(repoRoot) : [],
                merged: wt => isMergedWorktree(wt, repoRoot),
            });
            if (scan === null) return;

            const skippedLive = scan.plan.skippedLive;
            const unmerged = scan.plan.unmerged;

            // CORE-2814: the process table cannot see a tmux pane parked in a worktree,
            // and the pane is the case that lost work on 2026-11-28. Check both holder
            // kinds before this plan is printed, so --dry-run and --yes agree.
            const removalProbe = createLivenessProbe();
            // --force-live also promotes the trees the process-table pre-pass kept,
            // which is the only way an explicit override can reach them.
            const candidates = opts.forceLive
                ? [...scan.plan.removable, ...scan.plan.skippedLive, ...scan.orphans]
                : [...scan.plan.removable, ...scan.orphans];
            const requested = candidates.map(target => target.path);
            const allowed = new Set(keepLivePaths(requested, {
                command: 'xt worktree clean',
                repoRoot,
                forceLive: opts.forceLive,
            }, removalProbe));
            const merged = candidates
                .filter(target => scan.plan.removable.includes(target) || scan.plan.skippedLive.includes(target))
                .filter(target => allowed.has(target.path));
            const orphanPlan = { removable: scan.orphans.filter(target => allowed.has(target.path)) };
            const orphanDirs = orphanPlan.removable.map(orphan => orphan.path);
            const refusedCount = requested.length - allowed.size;
            if (refusedCount > 0) {
                console.log(kleur.yellow(`\n  ${refusedCount} target(s) kept: in use by a live process or tmux pane\n`));
            }

            if (cleanScanIsEmpty(scan)) {
                if (!opts.orphans) {
                    console.log(kleur.dim('\n  No merged xt worktrees to clean\n'));
                    return;
                }
                console.log(kleur.dim('\n  No merged worktrees or orphaned directories found\n'));
                console.log(kleur.dim('  (git worktree prune would still run in apply mode)\n'));
                if (opts.dryRun) return;
            }

            renderCleanPlan(scan, { orphans: opts.orphans });

            if (opts.dryRun) {
                console.log(kleur.yellow('\n  ℹ Dry run — no changes applied\n'));
                return;
            }

            const totalTargets = merged.length + orphanDirs.length;
            const doRemove = await confirmDestructiveAction({
                yes: opts.yes,
                message: `Apply cleanup for ${totalTargets} item(s)?`,
                initial: true,
            });

            if (!doRemove) {
                console.log(kleur.dim('  Cancelled\n'));
                return;
            }

            // TOCTOU (CORE-2814): re-read processes and panes after the prompt. The
            // probe is built here, so both reads are fresh. applyCleanRemoval keeps its
            // own last-moment process check below this one.
            const lateProbe = createLivenessProbe();
            const stillAllowed = new Set(keepLivePaths(merged.map(target => target.path), {
                command: 'xt worktree clean',
                repoRoot,
                forceLive: opts.forceLive,
            }, lateProbe));
            const lateMerged = merged.filter(target => stillAllowed.has(target.path));
            const lateOrphans = { removable: orphanPlan.removable.filter(target => stillAllowed.has(target.path)) };
            if (lateMerged.length + lateOrphans.removable.length < merged.length + orphanPlan.removable.length) {
                console.log(kleur.yellow('\n  Some targets became live while waiting for confirmation and were kept\n'));
            }

            const removal = applyCleanRemoval(repoRoot, lateMerged, {
                forceLive: opts.forceLive,
                liveness: lateProbe,
                exemptPids: callerProcessIds(),
            });
            let removedCount = removal.removed.length;

            if (opts.orphans) {
                const orphanRemoval = applyCleanRemoval(repoRoot, lateOrphans.removable, {
                    forceLive: opts.forceLive,
                    liveness: lateProbe,
                    exemptPids: callerProcessIds(),
                    remove: (path) => {
                        if (!existsSync(path)) return { ok: true, message: `Removed orphan directory ${path}` };
                        try {
                            rmSync(path, { recursive: true, force: true });
                            return { ok: true, message: `Removed orphan directory ${path}` };
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            return { ok: false, message: `Could not remove ${path}: ${message}` };
                        }
                    },
                });
                for (const path of orphanRemoval.removed) unregisterPluginsForWorktree(path);
                removedCount += orphanRemoval.removed.length;

                const pruneResult = runGitWorktreePrune(repoRoot);
                if (pruneResult.ok) {
                    console.log(t.success(`  ✓ ${pruneResult.message}`));
                } else {
                    console.log(kleur.yellow(`  ⚠ ${pruneResult.message}`));
                }
            }

            if (removedCount === 0) {
                console.log(kleur.yellow('\n  ⚠ Nothing was removed\n'));
                return;
            }

            console.log(t.boldGreen(`\n  ✓ Cleanup complete (${removedCount} item(s) removed)\n`));
        });

    cmd.command('reap')
        .description('Reclaim abandoned worktrees and regenerable artifacts under a validated safety predicate')
        .option('--artifacts-older-than <age>', 'Reclaim node_modules/.venv/.gitnexus past this idle age', '7d')
        .option('--worktrees-older-than <age>', 'Remove whole worktrees past this idle age', '14d')
        .option('--all-repos', 'Sweep every git repo under --roots, not just the current one', false)
        .option('--roots <dirs>', 'Comma-separated parents to discover repos in with --all-repos', join(homedir(), 'dev'))
        .option('--apply', 'Reclaim (default is dry-run)', false)
        .option('-y, --yes', 'Skip confirmation with --apply', false)
        .option('--dry-run', 'Explicit dry run (default)', false)
        .option('--json', 'Print machine-readable reap plan', false)
        .option('--force-live', 'Reap candidates a live process or tmux pane is using (logged)', false)
        .action(async (opts: {
            artifactsOlderThan: string;
            worktreesOlderThan: string;
            allRepos: boolean;
            roots: string;
            apply: boolean;
            yes: boolean;
            dryRun: boolean;
            json: boolean;
            forceLive: boolean;
        }) => {
            const currentPath = process.cwd();
            const repos = opts.allRepos
                ? discoverRepos(opts.roots.split(',').map(root => root.trim()).filter(Boolean))
                : [getRepoRoot(currentPath)];

            const cwds = readProcessTableOrRefuse();
            if (cwds === null) return;

            let plan: ReapPlan;
            try {
                plan = planReap({
                    repos,
                    currentPath,
                    artifactThresholdDays: parseDurationDays(opts.artifactsOlderThan, 7),
                    worktreeThresholdDays: parseDurationDays(opts.worktreesOlderThan, 14),
                    cwds,
                    liveness: createLivenessProbe(),
                    ownPids: callerProcessIds(),
                    forceLive: opts.forceLive,
                });
            } catch (error) {
                refuseWithoutProcessTable(error);
                return;
            }

            let outcomes: ReapOutcome[] | null = null;
            const hasWork = plan.summary.reapable > 0 || plan.summary.artifacts_only > 0;

            if (opts.apply && !opts.dryRun && hasWork) {
                const proceed = await confirmDestructiveAction({
                    yes: opts.yes,
                    message: `Reap ${plan.summary.reapable} worktree(s) and artifacts from ${plan.summary.artifacts_only} more (${formatBytes(plan.summary.reclaimable_bytes)})?`,
                    initial: false,
                });

                if (proceed) {
                    let applied: { plan: ReapPlan; outcomes: ReapOutcome[] };
                    try {
                        applied = applyReap(plan, {
                            liveness: createLivenessProbe(),
                            ownPids: callerProcessIds(),
                            forceLive: opts.forceLive,
                            command: 'xt worktree reap',
                            repoRoot: repos[0],
                        });
                    } catch (error) {
                        refuseWithoutProcessTable(error);
                        return;
                    }
                    plan = applied.plan;
                    outcomes = applied.outcomes;
                }
            }

            if (opts.json) {
                console.log(JSON.stringify({ ...plan, ...(outcomes ? { outcomes } : {}) }, null, 2));
                return;
            }

            printReapHuman(plan, outcomes);
        });

    cmd.command('install-timer')
        .description('Install the systemd user timer that runs xt worktree reap out of band')
        .option('--artifacts-older-than <age>', 'Artifact reclaim threshold for the timer', '7d')
        .option('--worktrees-older-than <age>', 'Worktree reclaim threshold for the timer', '14d')
        .option('--roots <dirs>', 'Comma-separated repo parents to sweep', join(homedir(), 'dev'))
        .option('--dry-run', 'Print the unit files without writing them', false)
        .action((opts: { artifactsOlderThan: string; worktreesOlderThan: string; roots: string; dryRun: boolean }) => {
            const result = installReapTimer(opts);

            if (opts.dryRun) {
                console.log(t.bold('\n  xt worktree reap timer (dry run)\n'));
                for (const unit of result.units) {
                    console.log(kleur.dim(`  ── ${unit.path} (mode 0644)`));
                    console.log(unit.content);
                }
                return;
            }

            console.log(t.bold('\n  xt worktree reap timer\n'));
            for (const unit of result.units) {
                console.log(t.success(`  ✓ wrote ${unit.path}`));
            }
            for (const message of result.messages) {
                console.log(kleur.dim(`    ${message}`));
            }
            console.log('');
        });

    cmd.command('release')
        .description('Release the worktree of an agent pane: remove it when git state allows, otherwise nudge the agent')
        .option('--pane <id>', 'tmux pane id (the binding passes #{pane_id})')
        .option('--client <name>', 'tmux client that must answer the confirmation (the binding passes #{client_name})')
        .option('--dry-run', 'Check the worktree and print the verdict without removing anything', false)
        .action(async (opts: { pane?: string; client?: string; dryRun: boolean }) => {
            if (!opts.pane) {
                console.error(kleur.red('\n  ✗ --pane is required (the tmux binding passes #{pane_id})\n'));
                process.exit(1);
            }

            const outcome = await releasePane({
                paneId: opts.pane,
                client: opts.client,
                dryRun: opts.dryRun,
            });

            // Inside tmux the operator sees the verdict in the status line; this JSON is for
            // --dry-run, scripts, and a run outside tmux.
            if (opts.dryRun || !process.env.TMUX) {
                console.log(JSON.stringify({
                    action: outcome.action,
                    detail: outcome.detail,
                    worktree: outcome.worktree ?? null,
                    branch: outcome.branch ?? null,
                    blockers: outcome.blockers,
                }, null, 2));
            }

            if (outcome.action === 'refused') process.exitCode = 1;
        });

    cmd.command('install-keybinding')
        .description('Install the tmux prefix+X binding that releases the agent pane worktree')
        .option('--dry-run', 'Print the snippet without writing anything', false)
        .option('-y, --yes', 'Skip confirmation', false)
        .action(async (opts: { dryRun: boolean; yes: boolean }) => {
            let result;
            try {
                result = await installKeybinding({ dryRun: opts.dryRun, yes: opts.yes });
            } catch (error) {
                console.error(kleur.red(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`));
                process.exit(1);
            }

            if (opts.dryRun) {
                console.log(t.bold('\n  xt worktree release keybinding (dry run)\n'));
                console.log(kleur.dim(`  ── ${result.snippetPath} (mode 0644)`));
                console.log(`\n${result.messages.join('\n')}`);
                return;
            }

            console.log(t.bold('\n  xt worktree release keybinding\n'));
            for (const path of result.written) {
                console.log(t.success(`  ✓ wrote ${path}`));
            }
            for (const message of result.messages) {
                console.log(kleur.dim(`    ${message}`));
            }
            console.log(kleur.dim('\n  Press prefix+X in an agent pane; the tree is removed only when git state allows.\n'));
        });

    cmd.command('remove <name>')
        .description('Manually remove a specific xt worktree by branch name or path')
        .option('-y, --yes', 'Skip confirmation', false)
        .option('--force-live', 'Remove a worktree a live process or tmux pane is using (logged)', false)
        .action(async (name: string, opts: { yes: boolean; forceLive: boolean }) => {
            const repoRoot = getRepoRoot(process.cwd());
            const worktrees = listXtWorktrees(repoRoot);
            const target = worktrees.find(wt =>
                wt.path === name ||
                wt.branch === `refs/heads/${name}` ||
                wt.branch === `refs/heads/xt/${name}`
            );

            if (!target) {
                console.error(kleur.red(`\n  ✗ No xt worktree found matching "${name}"\n`));
                console.log(kleur.dim('  Run: xt worktree list\n'));
                process.exit(1);
            }

            const allowed = keepLivePaths([target.path], {
                command: 'xt worktree remove',
                repoRoot,
                forceLive: opts.forceLive,
            });
            if (allowed.length === 0) {
                console.error(kleur.red(`\n  ✗ Refused: ${target.path} is in use by a live process or tmux pane\n`));
                console.error(kleur.dim('  Stop the holder, or add --force-live to remove it anyway.\n'));
                process.exit(1);
            }

            const doRemove = await confirmDestructiveAction({
                yes: opts.yes,
                message: `Remove ${target.path}?`,
                initial: false,
            });

            if (!doRemove) {
                console.log(kleur.dim('  Cancelled\n'));
                return;
            }

            // TOCTOU (CORE-2814): a holder can appear while the prompt waits, so the
            // last read happens here, immediately before the removal.
            const recheck = keepLivePaths([target.path], {
                command: 'xt worktree remove',
                repoRoot,
                forceLive: opts.forceLive,
            }, createLivenessProbe());
            if (recheck.length === 0) {
                console.error(kleur.red(`\n  ✗ Refused: ${target.path} became live while waiting for confirmation\n`));
                console.error(kleur.dim('  Stop the holder, or add --force-live to remove it anyway.\n'));
                process.exit(1);
            }

            const result = removeWorktreeEntry(repoRoot, target.path);
            if (!result.ok) {
                console.error(kleur.red(`\n  ✗ Failed: ${result.message}\n`));
                process.exit(1);
            }

            console.log(t.success(`\n  ✓ ${result.message}\n`));
        });

    return cmd;
}

/** Clear the shared statusline claim file at repo root so no ghost claim shows after worktree removal. */
function clearStatuslineClaim(repoRoot: string): void {
    try {
        const claimFile = join(repoRoot, '.xtrm', 'statusline-claim');
        if (existsSync(claimFile)) unlinkSync(claimFile);
    } catch {
        // non-fatal
    }
}
