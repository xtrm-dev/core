import { Command } from 'commander';
import kleur from 'kleur';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { t } from '../utils/theme.js';
import { unregisterPluginsForWorktree } from '../utils/worktree-session.js';
import { confirmDestructiveAction } from '../utils/confirmation.js';

interface EndOptions {
    draft: boolean;
    keep: boolean;
    yes: boolean;
    dryRun: boolean;
}

interface EndIssue {
    id: string;
    title: string;
    description: string;
    reason: string;
}

function git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function bd(args: string[], cwd: string): { ok: boolean; out: string } {
    const r = spawnSync('bd', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

function npm(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
    const r = spawnSync('npm', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function resolveMainRepoRoot(cwd: string): string {
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

function clearStatuslineClaim(repoRoot: string): void {
    try {
        const claimFile = join(repoRoot, '.xtrm', 'statusline-claim');
        if (existsSync(claimFile)) unlinkSync(claimFile);
    } catch {
        // non-fatal
    }
}

interface WorktreeCleanupResult {
    removed: boolean;
    alreadyMissing: boolean;
    warnings: string[];
}

function cleanupWorktreePath(worktreePath: string, repoRoot: string): WorktreeCleanupResult {
    const warnings: string[] = [];
    const removeResult = spawnSync(
        'git',
        ['worktree', 'remove', worktreePath, '--force'],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
    );

    if (removeResult.status !== 0) {
        const errorText = (removeResult.stderr ?? '').trim();
        if (errorText) warnings.push(errorText);
    }

    const pruneResult = spawnSync('git', ['worktree', 'prune', '--expire', 'now'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
    });
    if (pruneResult.status !== 0 && (pruneResult.stderr ?? '').trim()) {
        warnings.push((pruneResult.stderr ?? '').trim());
    }

    const isMissing = !existsSync(worktreePath);
    if (isMissing) {
        return {
            removed: true,
            alreadyMissing: removeResult.status !== 0,
            warnings,
        };
    }

    try {
        rmSync(worktreePath, { recursive: true, force: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Could not remove directory ${worktreePath}: ${message}`);
    }

    return {
        removed: !existsSync(worktreePath),
        alreadyMissing: false,
        warnings,
    };
}

// Common conventional-commit scope words that are never beads IDs
const CONVENTIONAL_SCOPES = new Set([
    'feat', 'fix', 'chore', 'docs', 'test', 'tests', 'refactor', 'style',
    'perf', 'ci', 'build', 'revert', 'wip', 'auth', 'api', 'ui', 'db',
    'merge', 'memory', 'end', 'sync', 'core', 'cli', 'hooks', 'skills',
]);

/** Extract beads issue IDs from commit messages like "reason (xtrm-skg2)" or "reason (8jr5.8)" */
function extractIssueIds(commitLog: string): string[] {
    // Require at least one hyphen so single-word scopes like (auth) are excluded
    const matches = commitLog.matchAll(/\(([a-z][a-z0-9]*-[a-z0-9]+(?:\.[0-9]+)?)\)/gi);
    return [...new Set(
        [...matches]
            .map(m => m[1].toLowerCase())
            .filter(id => !CONVENTIONAL_SCOPES.has(id)),
    )];
}

function normalizePrTitle(input: string): string {
    const trimmed = input.trim().replace(/[.\s]+$/g, '');
    if (!trimmed) return 'Update worktree session';
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function isGenericPrTitle(title: string): boolean {
    return /^(session changes|update|updates|misc|wip|work in progress)$/i.test(title.trim());
}

/** Infer a PR title from the commit log (first meaningful commit) with a file-based fallback. */
function inferTitleFromCommitsOrFiles(commitLog: string, changedFiles: string[]): string {
    // Try the first commit message subject line
    const firstCommit = commitLog.split('\n')[0]?.replace(/^[a-f0-9]+ /, '').trim() ?? '';
    if (firstCommit && !isGenericPrTitle(firstCommit)) {
        return normalizePrTitle(firstCommit);
    }

    // File-based fallback: derive from dominant changed area
    const hasCli = changedFiles.some(f => f.startsWith('cli/src/'));
    const hasTests = changedFiles.some(f => f.startsWith('cli/test/'));
    const hasHooks = changedFiles.some(f => f.startsWith('hooks/'));
    const hasSkills = changedFiles.some(f => f.startsWith('skills/'));
    const hasDocs = changedFiles.some(f => f.startsWith('docs/') || f === 'README.md' || f === 'XTRM-GUIDE.md');
    const hasConfig = changedFiles.some(f => f.startsWith('config/'));

    if (hasCli && hasTests) return 'Update CLI with tests';
    if (hasCli && hasHooks) return 'Update CLI and hooks';
    if (hasCli) return 'Update CLI';
    if (hasHooks) return 'Update hooks';
    if (hasSkills) return 'Update skills';
    if (hasDocs) return 'Update documentation';
    if (hasConfig) return 'Update config';

    return 'Update worktree session';
}

/** Generate PR title from issue data, with deterministic fallback if issue-derived titles are too generic. */
function buildPrTitle(issues: EndIssue[], changedFiles: string[], commitLog: string): string {
    if (issues.length === 0) return inferTitleFromCommitsOrFiles(commitLog, changedFiles);

    if (issues.length === 1) {
        const single = normalizePrTitle(issues[0].title || issues[0].reason || issues[0].id);
        return isGenericPrTitle(single) ? inferTitleFromCommitsOrFiles(commitLog, changedFiles) : single;
    }

    // Multiple issues: first issue title + count, fall back to commit/file inference
    const multi = normalizePrTitle(issues[0].title || issues[0].reason || issues[0].id);
    return isGenericPrTitle(multi)
        ? inferTitleFromCommitsOrFiles(commitLog, changedFiles)
        : `${multi} (+${issues.length - 1} more)`;
}

function getChangedFilesSinceBase(cwd: string, defaultBranch: string, pathspec?: string): string[] {
    const args = ['diff', '--name-only', `origin/${defaultBranch}..HEAD`];
    if (pathspec) args.push('--', pathspec);
    const result = git(args, cwd);
    return result.out.split('\n').map(line => line.trim()).filter(Boolean);
}

function maybeRebuildCliDist(cwd: string, defaultBranch: string): void {
    const changedCliSources = getChangedFilesSinceBase(cwd, defaultBranch, 'cli/src/');
    if (changedCliSources.length === 0) return;

    console.log(kleur.dim('  cli/src changed in this session — rebuilding cli/dist...'));
    const buildResult = npm(['run', 'build', '--workspace', 'cli', '--ignore-scripts'], cwd);
    if (!buildResult.ok) {
        const details = [buildResult.out, buildResult.err].filter(Boolean).join('\n');
        console.error(kleur.red(`
  ✗ Auto-rebuild failed:
${details ? `
${details}
` : ''}`));
        process.exit(1);
    }

    git(['add', 'cli/dist'], cwd);
    const stagedDist = git(['diff', '--cached', '--name-only', '--', 'cli/dist/'], cwd).out
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    if (stagedDist.length === 0) {
        console.log(t.success('  ✓ cli/dist already up to date'));
        return;
    }

    const commitResult = git(['commit', '-m', 'chore: rebuild dist after source changes'], cwd);
    if (!commitResult.ok) {
        console.error(kleur.red(`
  ✗ Could not commit rebuilt cli/dist:
  ${commitResult.err}
`));
        process.exit(1);
    }

    console.log(t.success(`  ✓ Rebuilt cli/dist and committed ${stagedDist.length} file(s)`));
}

export function findBeadsSymlinkIntroductions(cwd: string, upstream: string): string[] {
    const diffResult = git(['diff', '--raw', `${upstream}..HEAD`, '--', '.beads/'], cwd);
    if (!diffResult.ok) {
        console.warn(kleur.yellow('  ⚠ Could not inspect .beads diff for symlink mode changes; continuing safely.'));
        return [];
    }

    return [...new Set(
        diffResult.out
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .flatMap(line => {
                const match = line.match(/^:[0-9]{6} ([0-9]{6}) [0-9a-f]{7,40} [0-9a-f]{7,40} ([A-Z]+(?:[0-9]+)?)\t(.+)$/);
                if (!match) return [];
                const destinationMode = match[1];
                const path = match[3];
                return destinationMode === '120000' && path.startsWith('.beads/') ? [path] : [];
            }),
    )];
}

function printBeadsSymlinkGuardError(paths: string[], upstream: string): void {
    console.error(kleur.red('\n  ✗ Refusing to push: .beads symlink mode change detected\n'));
    for (const path of paths) {
        console.error(kleur.red(`    ${path}`));
    }
    console.error(kleur.dim(`\n  Recover with:
    git restore --source=${upstream} -- .beads/\n  Then re-run: xt end\n`));
}

/** Generate PR body from issues, commit log, diff stat */
function buildPrBody(
    issues: Array<{ id: string; title: string; description: string; reason: string }>,
    commitLog: string,
    diffStat: string,
    branch: string,
): string {
    const lines: string[] = [];

    lines.push('## What');
    if (issues.length > 0) {
        for (const issue of issues) {
            lines.push(`- **${issue.id}**: ${issue.title}`);
            if (issue.description) lines.push(`  ${issue.description.split('\n')[0]}`);
        }
    } else {
        lines.push(`Session branch: \`${branch}\``);
    }

    if (issues.some(i => i.reason)) {
        lines.push('', '## Why');
        for (const issue of issues) {
            if (issue.reason) lines.push(`- ${issue.id}: ${issue.reason}`);
        }
    }

    if (commitLog) {
        lines.push('', '## Changes');
        const commits = commitLog.split('\n').slice(0, 20);
        lines.push(...commits.map(c => `- ${c}`));
        if (commitLog.split('\n').length > 20) lines.push('- *(and more...)*');
    }

    if (diffStat) {
        lines.push('', '## Files changed');
        lines.push('```');
        lines.push(diffStat);
        lines.push('```');
    }

    if (issues.length > 0) {
        lines.push('', `Closes: ${issues.map(i => i.id).join(' ')}`);
    }

    return lines.join('\n');
}

export function createEndCommand(): Command {
    return new Command('end')
        .description('Close session: rebase, push, open PR, link beads issues, clean up worktree')
        .option('--draft', 'Open PR as draft', false)
        .option('--keep', 'Keep worktree after PR creation (default: prompt)', false)
        .option('-y, --yes', 'Skip confirmation prompts', false)
        .option('--dry-run', 'Preview PR title, body, and linked issues without pushing or creating PR', false)
        .action(async (opts: EndOptions) => {
            const cwd = process.cwd();

            // 1. Gate: must be in an xt worktree (branch starts with xt/)
            const branchResult = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
            const branch = branchResult.out;

            if (!branch.startsWith('xt/')) {
                console.error(kleur.red(
                    `\n  ✗ Not in an xt worktree (current branch: ${branch})\n` +
                    `  xt end must be run from inside a worktree created by xt claude/pi\n`
                ));
                process.exit(1);
            }

            // 2. Gate: no uncommitted changes
            const statusResult = git(['status', '--porcelain'], cwd);
            if (statusResult.out.length > 0) {
                console.error(kleur.red(
                    '\n  ✗ Uncommitted changes detected. Commit or stash before running xt end.\n'
                ));
                console.error(kleur.dim(statusResult.out));
                process.exit(1);
            }

            console.log(t.bold(`\n  xt end — closing session on ${branch}\n`));

            // 3. Detect default branch (avoids hardcoding main vs master)
            let defaultBranch = 'main';
            const symRef = git(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd);
            if (symRef.ok && symRef.out) {
                defaultBranch = symRef.out.replace('origin/', '');
            } else if (git(['rev-parse', '--verify', 'origin/master'], cwd).ok) {
                defaultBranch = 'master';
            }

            // 4. Collect closed issues from commit log
            const logResult = git(['log', `origin/${defaultBranch}..HEAD`, '--oneline'], cwd);
            const issueIds = extractIssueIds(logResult.out);

            const issues: EndIssue[] = [];
            for (const id of issueIds) {
                const queryResult = bd(['query', `id=${id}`, '--all', '--json'], cwd);
                if (queryResult.ok) {
                    try {
                        const data = JSON.parse(queryResult.out);
                        const first = Array.isArray(data) ? data[0] : data;
                        if (first) {
                            issues.push({
                                id,
                                title: first.title ?? id,
                                description: first.description ?? '',
                                reason: first.close_reason ?? '',
                            });
                            continue;
                        }
                    } catch {
                        // fall through to id-only record
                    }
                }
                issues.push({ id, title: id, description: '', reason: '' });
            }

            if (issues.length > 0) {
                console.log(t.success(`  ✓ Found ${issues.length} closed issue(s): ${issueIds.join(', ')}`));
            } else if (issueIds.length > 0) {
                console.log(kleur.yellow(`  ⚠ Found issue references in commits but could not load bead details: ${issueIds.join(', ')}`));
            } else {
                console.log(kleur.dim('  ○ No beads issues found in commit log'));
            }

            // 5. Dry-run: build PR preview from local state and exit before any destructive steps
            if (opts.dryRun) {
                const fullLog = git(['log', `origin/${defaultBranch}..HEAD`, '--oneline'], cwd).out;
                const diffStat = git(['diff', `origin/${defaultBranch}`, '--stat'], cwd).out;
                const changedFiles = git(['diff', `origin/${defaultBranch}`, '--name-only'], cwd).out.split('\n').filter(Boolean);
                const prTitle = buildPrTitle(issues, changedFiles, fullLog);
                const prBody = buildPrBody(issues, fullLog, diffStat, branch);

                console.log(t.bold('\n  [DRY RUN] PR preview\n'));
                console.log(`  ${kleur.bold('Title:')} ${prTitle}`);
                if (issues.length > 0) {
                    console.log(`  ${kleur.bold('Issues:')} ${issueIds.join(', ')}`);
                }
                console.log(`\n  ${kleur.bold('Body:')}`);
                for (const line of prBody.split('\n')) {
                    console.log(`  ${kleur.dim(line)}`);
                }
                console.log(t.accent('\n  [DRY RUN] No changes made — re-run without --dry-run to push and create PR\n'));
                return;
            }

            // 6. Fetch to ensure origin/<default> is current
            console.log(kleur.dim(`  Fetching origin/${defaultBranch}...`));
            git(['fetch', 'origin', defaultBranch], cwd);

            // 7. Rebase
            console.log(kleur.dim(`  Rebasing onto origin/${defaultBranch}...`));
            const rebaseResult = git(['rebase', `origin/${defaultBranch}`], cwd);
            if (!rebaseResult.ok) {
                const conflicts = git(['diff', '--name-only', '--diff-filter=U'], cwd).out;
                console.error(kleur.red('\n  ✗ Rebase conflicts detected:\n'));
                if (conflicts) {
                    for (const f of conflicts.split('\n')) console.error(kleur.yellow(`    ${f}`));
                }
                console.error(kleur.dim(
                    '\n  Resolve conflicts, then:\n' +
                    '    git add <files> && git rebase --continue\n' +
                    '  Then re-run: xt end\n'
                ));
                process.exit(1);
            }
            console.log(t.success(`  ✓ Rebased onto origin/${defaultBranch}`));

            // 8. Rebuild generated CLI bundle if session commits touched cli/src/
            maybeRebuildCliDist(cwd, defaultBranch);

            // 9. Guard: refuse .beads symlink introductions before push
            const beadsSymlinkPaths = findBeadsSymlinkIntroductions(cwd, `origin/${defaultBranch}`);
            if (beadsSymlinkPaths.length > 0) {
                printBeadsSymlinkGuardError(beadsSymlinkPaths, `origin/${defaultBranch}`);
                process.exit(1);
            }

            // 10. Push (force-with-lease = safe after rebase)
            const pushConfirmed = await confirmDestructiveAction({
                yes: opts.yes,
                message: `Force-push ${branch} to origin with --force-with-lease?`,
                initial: false,
            });
            if (!pushConfirmed) {
                console.log(kleur.dim('  Cancelled\n'));
                return;
            }

            console.log(kleur.dim('  Pushing branch...'));
            const pushResult = git(['push', 'origin', branch, '--force-with-lease'], cwd);
            if (!pushResult.ok) {
                console.error(kleur.red(`\n  ✗ Push failed:\n  ${pushResult.err}\n`));
                process.exit(1);
            }
            console.log(t.success(`  ✓ Pushed ${branch}`));

            // 9. Build PR content
            const fullLog = git(['log', `origin/${defaultBranch}..HEAD`, '--oneline'], cwd).out;
            const diffStat = git(['diff', `origin/${defaultBranch}`, '--stat'], cwd).out;
            const changedFiles = git(['diff', `origin/${defaultBranch}`, '--name-only'], cwd).out.split('\n').filter(Boolean);
            const prTitle = buildPrTitle(issues, changedFiles, fullLog);
            const prBody = buildPrBody(issues, fullLog, diffStat, branch);

            // 10. Create PR
            console.log(kleur.dim('  Creating PR...'));
            const prArgs = ['pr', 'create', '--title', prTitle, '--body', prBody];
            if (opts.draft) prArgs.push('--draft');

            const prResult = spawnSync('gh', prArgs, { cwd, encoding: 'utf8', stdio: 'pipe' });
            if (prResult.status !== 0) {
                console.error(kleur.red(`\n  ✗ PR creation failed:\n  ${prResult.stderr?.trim()}\n`));
                process.exit(1);
            }
            const prUrl = prResult.stdout.trim();
            console.log(t.success(`  ✓ PR created: ${prUrl}`));

            // 11. Beads linkage: add PR URL to each closed issue's notes
            for (const issue of issues) {
                bd(['update', issue.id, '--notes', `PR: ${prUrl}`], cwd);
            }
            if (issues.length > 0) {
                console.log(t.success(`  ✓ Linked PR to ${issues.length} issue(s)`));
            }

            // 12. Worktree cleanup
            if (!opts.keep) {
                const doRemove = await confirmDestructiveAction({
                    yes: opts.yes,
                    message: `Remove local worktree at ${cwd}?`,
                    initial: false,
                });

                if (doRemove) {
                    const repoRoot = resolveMainRepoRoot(cwd);
                    const cleanup = cleanupWorktreePath(cwd, repoRoot);

                    if (cleanup.removed) {
                        unregisterPluginsForWorktree(cwd);
                        clearStatuslineClaim(repoRoot);
                        if (cleanup.alreadyMissing) {
                            console.log(t.success('  ✓ Worktree already absent; cleaned stale git metadata'));
                        } else {
                            console.log(t.success('  ✓ Worktree removed'));
                        }
                    } else {
                        console.log(kleur.yellow('  ⚠ Worktree cleanup incomplete — manual remediation required:'));
                        console.log(kleur.dim(`    git -C ${repoRoot} worktree remove ${cwd} --force`));
                        console.log(kleur.dim(`    git -C ${repoRoot} worktree prune --expire now`));
                    }

                    for (const warning of cleanup.warnings) {
                        console.log(kleur.dim(`    ${warning}`));
                    }
                }
            }

            console.log(t.boldGreen('\n  ✓ Session closed\n'));
            console.log(kleur.dim(`  PR: ${prUrl}`));
            console.log(kleur.dim('  Merge: review and merge when CI is green\n'));
        });
}
