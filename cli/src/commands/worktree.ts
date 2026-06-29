import { Command } from 'commander';
import kleur from 'kleur';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { SessionMeta } from '../utils/worktree-session.js';
import { unregisterPluginsForWorktree } from '../utils/worktree-session.js';
import { t } from '../utils/theme.js';
import { confirmDestructiveAction } from '../utils/confirmation.js';

export interface WorktreeInfo {
    path: string;
    branch: string;
    head: string;
    prunable: boolean;
    runtime?: 'claude' | 'pi';
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
    const xtWorktrees = allWorktrees.filter(wt => wt.branch?.startsWith('refs/heads/xt/'));
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

/** Check if a branch has been merged into main */
function isMergedIntoMain(branch: string, repoRoot: string): boolean {
    const branchShort = branch.replace('refs/heads/', '');
    const r = spawnSync('git', ['branch', '--merged', 'origin/main', '--list', branchShort], {
        cwd: repoRoot, encoding: 'utf8', stdio: 'pipe',
    });
    return (r.stdout ?? '').includes(branchShort);
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

function removeWorktreeEntry(repoRoot: string, worktreePath: string): { ok: boolean; message: string } {
    const remove = git(['worktree', 'remove', worktreePath, '--force'], repoRoot);
    if (!remove.ok) {
        return { ok: false, message: remove.err || `could not remove ${worktreePath}` };
    }

    unregisterPluginsForWorktree(worktreePath);
    clearStatuslineClaim(repoRoot);
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
                const merged = isMergedIntoMain(wt.branch, repoRoot);
                const status = merged ? kleur.green('merged') : kleur.yellow('open');
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

            if (nested.length === 0 && orphanDirs.length === 0 && prunable.length === 0) {
                console.log(t.success('\n  ✓ No stale worktree issues detected\n'));
                return;
            }

            console.log(kleur.bold('\n  Remediation:'));
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
        .action(async (opts: { yes: boolean; dryRun: boolean; orphans: boolean }) => {
            const repoRoot = getRepoRoot(process.cwd());
            const worktrees = listXtWorktrees(repoRoot);
            const merged = worktrees.filter(wt =>
                isMergedIntoMain(wt.branch, repoRoot) ||
                getPrStatus(wt.branch, repoRoot).state === 'MERGED'
            );
            const orphanDirs = opts.orphans ? listOrphanManagedDirs(repoRoot) : [];

            if (merged.length === 0 && orphanDirs.length === 0 && !opts.orphans) {
                console.log(kleur.dim('\n  No merged xt worktrees to clean\n'));
                return;
            }

            if (merged.length === 0 && orphanDirs.length === 0 && opts.orphans) {
                console.log(kleur.dim('\n  No merged worktrees or orphaned directories found\n'));
                console.log(kleur.dim('  (git worktree prune would still run in apply mode)\n'));
                if (opts.dryRun) return;
            }

            console.log(t.bold('\n  xt worktree clean\n'));

            if (merged.length > 0) {
                console.log(kleur.bold(`  ${merged.length} merged worktree(s):`));
                for (const wt of merged) {
                    console.log(kleur.dim(`    - ${wt.path} (${wt.branch.replace('refs/heads/', '')})`));
                }
            }

            if (opts.orphans) {
                console.log(kleur.bold(`\n  ${orphanDirs.length} orphaned managed director(y/ies):`));
                for (const orphan of orphanDirs) {
                    console.log(kleur.dim(`    - ${orphan}`));
                }
                console.log(kleur.dim('    - git worktree prune --expire now'));
            }

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

            let removedCount = 0;

            for (const wt of merged) {
                const result = removeWorktreeEntry(repoRoot, wt.path);
                if (result.ok) {
                    removedCount += 1;
                    console.log(t.success(`  ✓ ${result.message}`));
                } else {
                    console.log(kleur.yellow(`  ⚠ ${result.message}`));
                }
            }

            if (opts.orphans) {
                for (const orphan of orphanDirs) {
                    try {
                        rmSync(orphan, { recursive: true, force: true });
                        removedCount += 1;
                        unregisterPluginsForWorktree(orphan);
                        console.log(t.success(`  ✓ Removed orphan directory ${orphan}`));
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.log(kleur.yellow(`  ⚠ Could not remove ${orphan}: ${message}`));
                    }
                }

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

    cmd.command('remove <name>')
        .description('Manually remove a specific xt worktree by branch name or path')
        .option('-y, --yes', 'Skip confirmation', false)
        .action(async (name: string, opts: { yes: boolean }) => {
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

            const doRemove = await confirmDestructiveAction({
                yes: opts.yes,
                message: `Remove ${target.path}?`,
                initial: false,
            });

            if (!doRemove) {
                console.log(kleur.dim('  Cancelled\n'));
                return;
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
