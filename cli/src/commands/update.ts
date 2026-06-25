import { Command } from 'commander';
import kleur from 'kleur';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { checkDrift } from '../core/drift.js';
import { resolvePackageRoot } from '../core/registry-scaffold.js';
import { assureXtManagedPiPackages } from '../core/pi-runtime.js';
import { scanXtrmRepos } from '../core/repo-discovery.js';
import { isStrictRegistryMode, runInstall } from './install.js';
import { ensureBeadsSharedServerEnabled, hasBeadsDir } from '../core/beads-shared-server.js';
import { ensureBdAutoStagePatch, summarizeBdAutoStagePatch } from '../core/bd-auto-stage-patch.js';
import { printDependencyMaintenanceSummary, runDependencyMaintenance, type DependencyMaintenanceSummary } from '../core/dependency-maintenance.js';
import { ensureServiceSkills } from '../core/service-skills-ensure.js';
import { reconcileProjectClaudeHooks } from '../core/claude-runtime-sync.js';
import { resolveMainProjectRoot } from '../utils/repo-root.js';

type UpdateStatus = 'refreshed' | 'already-current' | 'failed' | 'skipped' | 'incomplete';

interface RepoUpdateResult {
    repo: string;
    status: UpdateStatus;
    reason?: string;
    maintenance?: DependencyMaintenanceSummary;
}

interface UpdateOpts {
    root?: string;
    repo?: string;
    json?: boolean;
    apply?: boolean;
    allRepos?: boolean;
    strictRegistry?: boolean;
}

interface ResolvedTargets {
    /** Repos ready for the normal update flow (have .xtrm/ + registry.json). */
    targets: string[];
    /** Repos with .xtrm/ but no registry.json. Surfaced as warnings; never auto-fixed. */
    incomplete: string[];
}

async function resolveTargetRepos(opts: Pick<UpdateOpts, 'root' | 'repo' | 'allRepos'>): Promise<ResolvedTargets> {
    if (opts.repo) return { targets: [path.resolve(opts.repo)], incomplete: [] };
    if (opts.allRepos) {
        const roots = ['~/dev', '~/projects'].map(p => p.replace(/^~/, process.env.HOME ?? ''));
        const scans = await Promise.all(roots.map(root => scanXtrmRepos(path.resolve(root)).catch(() => ({ managed: [], incomplete: [] }))));
        return {
            targets: [...new Set(scans.flatMap(scan => scan.managed))],
            incomplete: [...new Set(scans.flatMap(scan => scan.incomplete))],
        };
    }
    if (opts.root) {
        const scan = await scanXtrmRepos(path.resolve(opts.root));
        return { targets: scan.managed, incomplete: scan.incomplete };
    }
    // xtrm-6ofgm: default to the MAIN checkout, not a worktree dir. When invoked
    // from .xtrm/worktrees/<name>/, process.cwd() is the worktree path; baking
    // that into hook command strings in .claude/settings.json crashes every hook
    // once the worktree is removed.
    return { targets: [resolveMainProjectRoot(process.cwd())], incomplete: [] };
}

function getCurrentPackageRegistryPath(): string {
    return path.join(resolvePackageRoot(), '.xtrm', 'registry.json');
}

async function updateRepo(repoRoot: string, opts: UpdateOpts): Promise<RepoUpdateResult> {
    const registryPath = getCurrentPackageRegistryPath();
    const userXtrmDir = path.join(repoRoot, '.xtrm');

    try {
        if (!(await fs.pathExists(registryPath))) {
            return { repo: repoRoot, status: 'failed', reason: `missing package registry at ${registryPath}` };
        }

        const drift = await checkDrift(registryPath, userXtrmDir);
        const hasBeads = await hasBeadsDir(repoRoot);
        const sharedServer = hasBeads
            ? await ensureBeadsSharedServerEnabled(repoRoot, false)
            : { changed: false, state: 'not-applicable' as const };
        const bdPatch = hasBeads
            ? await ensureBdAutoStagePatch(repoRoot, false)
            : { changed: false, config: 'not-applicable' as const, hook: 'not-applicable' as const, warnings: [] };
        const maintenancePlan = await runDependencyMaintenance(repoRoot, false);
        const maintenanceNeedsApply = maintenancePlan.bdDoctor.state === 'failed'
            || maintenancePlan.gitnexusIndex.state === 'outdated'
            || maintenancePlan.tools.some(tool => tool.state === 'outdated' || tool.state === 'missing');
        const registryChanges = drift.missing.length > 0 || drift.drifted.length > 0 || sharedServer.changed;
        const hasChanges = registryChanges || bdPatch.changed || maintenanceNeedsApply;

        if (!opts.apply) {
            return {
                repo: repoRoot,
                status: hasChanges ? 'refreshed' : 'already-current',
                reason: hasChanges ? `missing=${drift.missing.length}, drifted=${drift.drifted.length}, ${summarizeBdAutoStagePatch(bdPatch)}` : undefined,
                maintenance: maintenancePlan,
            };
        }

        if (registryChanges) {
            await runInstall({
                force: true,
                yes: true,
                dryRun: false,
                projectRoot: repoRoot,
                skipMachineBootstrap: true,
                skipClaudeRuntimeSync: true,
                strictRegistry: isStrictRegistryMode(opts),
            });
        }

        // Foolproof service-skills migration: runs AFTER skills install so the latest
        // migrator is present. Registry-gated + idempotent — a no-op in non-service
        // repos and on already-migrated ones, but it still migrates a package-current
        // repo that is on the OLD service layout (which xt update otherwise misses).
        const serviceSkills = await ensureServiceSkills(repoRoot, { apply: true });

        // Reconcile .claude/settings.json hooks against canonical hooks.json on every
        // apply. runInstall is invoked with skipClaudeRuntimeSync (and is not invoked at
        // all when no registry files drifted), so newly-added xtrm-managed hooks — e.g.
        // the service-skills activation/cataloger/drift hooks shipped in 0.8.2 — would
        // otherwise stay dormant in existing consumers (xtrm-0p7bp). This is idempotent:
        // a no-op when the wired hooks already match canonical, so already-current repos
        // self-heal without churn.
        const hookSync = await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });

        if (!hasChanges && serviceSkills.alreadyCurrent && !hookSync.changed) {
            return { repo: repoRoot, status: 'already-current', maintenance: maintenancePlan };
        }

        const appliedPatch = hasBeads ? await ensureBdAutoStagePatch(repoRoot, true) : bdPatch;
        const maintenance = await runDependencyMaintenance(repoRoot, true);

        const serviceSkillsReason = serviceSkills.migratedPacks.length > 0
            ? `, service-skills migrated: ${serviceSkills.migratedPacks.join(',')}`
            : '';
        const hookSyncReason = hookSync.changed ? ', claude hooks rewired' : '';
        return {
            repo: repoRoot,
            status: 'refreshed',
            reason: `missing=${drift.missing.length}, drifted=${drift.drifted.length}, ${summarizeBdAutoStagePatch(appliedPatch)}${serviceSkillsReason}${hookSyncReason}`,
            maintenance,
        };
    } catch (error) {
        return {
            repo: repoRoot,
            status: 'failed',
            reason: formatRegistrySourceMismatchReason(error, isStrictRegistryMode(opts)),
        };
    }
}

function formatRegistrySourceMismatchReason(error: unknown, strictRegistry: boolean): string {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = 'Registry/source mismatch: missing package source files.';
    if (!message.startsWith(prefix)) {
        return message;
    }

    if (strictRegistry || process.env.DEBUG === 'true') {
        return message;
    }

    const paths = message
        .split('\n')
        .slice(1)
        .map(line => line.trim().replace(/^•\s*/, ''))
        .filter(Boolean);
    const visiblePaths = paths.slice(0, 3);
    const remaining = paths.length - visiblePaths.length;
    return `${prefix} ${visiblePaths.join(', ')}${remaining > 0 ? ` (+${remaining} more)` : ''}`;
}

function printPiPackages(packageAssurance: Awaited<ReturnType<typeof assureXtManagedPiPackages>>): void {
    if (packageAssurance.missing.length === 0 && packageAssurance.outdated.length === 0) {
        return;
    }

    console.log(kleur.bold('\n  Pi Packages'));
    console.log(kleur.dim('  ' + '-'.repeat(50)));
    for (const status of packageAssurance.statuses) {
        if (status.state === 'current') continue;
        console.log(`${status.state.padEnd(10)} ${status.pkg.displayName}`);
    }
}

function commitAllReposPatch(repoRoot: string): { ok: boolean; message: string } | null {
    const status = spawnGit(repoRoot, ['status', '--short']);
    if (status.status !== 0) return { ok: false, message: `git status failed: ${(status.stderr || status.stdout || '').trim()}` };
    if (!status.stdout.trim()) return null;

    const add = spawnGit(repoRoot, ['add', '-A']);
    if (add.status !== 0) return { ok: false, message: `git add failed: ${(add.stderr || add.stdout || '').trim()}` };

    const commit = spawnGit(repoRoot, ['commit', '-m', 'chore: apply bd auto-stage patch (xtrm-tools auto-applied)']);
    if (commit.status !== 0) return { ok: false, message: `git commit failed: ${(commit.stderr || commit.stdout || '').trim()}` };
    const hash = spawnGit(repoRoot, ['rev-parse', '--short', 'HEAD']);
    return { ok: true, message: `committed ${hash.stdout.trim()}` };
}

function spawnGit(repoRoot: string, args: string[]) {
    return spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 120000,
    });
}

function printTable(rows: RepoUpdateResult[]): void {
    const widths = rows.reduce((acc, row) => ({
        repo: Math.max(acc.repo, row.repo.length),
        status: Math.max(acc.status, row.status.length),
    }), { repo: 4, status: 6 });

    console.log(kleur.bold(`  ${'repo'.padEnd(widths.repo)}  ${'status'.padEnd(widths.status)}  reason`));
    for (const row of rows) {
        console.log(`${row.repo.padEnd(widths.repo)}  ${row.status.padEnd(widths.status)}  ${row.reason ?? ''}`);
    }
}

export function createUpdateCommand(): Command {
    return new Command('update')
        .description('Refresh xtrm-managed files and assure global xt Pi packages for one repo or many; missing or outdated packages are refreshed on --apply. Alias for init-era repo refresh; see xtrm init for full bootstrap.')
        .option('--apply', 'Write changes with install force mode', false)
        .option('--strict-registry', 'Fail on registry/source mismatch or missing registry source files', false)
        .option('--root <dir>', 'Walk root and update every repo with .xtrm/registry.json')
        .option('--all-repos', 'Sweep ~/dev and ~/projects for xtrm-managed repos (dry-run by default; --apply patches and commits each changed repo)', false)
        .option('--repo <path>', 'Target one repo path instead of cwd')
        .option('--json', 'Print JSON output', false)
        .action(async (opts) => {
            const typedOpts = opts as UpdateOpts;
            const { targets, incomplete } = await resolveTargetRepos(typedOpts);
            const rows: RepoUpdateResult[] = [];
            for (const repo of targets) {
                const row = await updateRepo(repo, typedOpts);
                if (typedOpts.allRepos && typedOpts.apply && row.status === 'refreshed') {
                    const commitResult = commitAllReposPatch(repo);
                    if (commitResult) {
                        row.reason = [row.reason, commitResult.message].filter(Boolean).join('; ');
                        if (!commitResult.ok) row.status = 'failed';
                    }
                }
                rows.push(row);
            }

            // Surface incomplete repos (have .xtrm/ but no registry.json).
            // Never auto-fix — would be destructive without explicit opt-in.
            for (const repo of incomplete) {
                rows.push({
                    repo,
                    status: 'incomplete',
                    reason: 'missing .xtrm/registry.json — run `xt init` or `xt install` to repair',
                });
            }

            const packageAssurance = await assureXtManagedPiPackages(Boolean(typedOpts.apply));

            if (opts.json) {
                console.log(JSON.stringify({ repos: rows, packages: packageAssurance }, null, 2));
            } else {
                printTable(rows);
                for (const row of rows) {
                    if (row.maintenance) printDependencyMaintenanceSummary(row.maintenance);
                }
                printPiPackages(packageAssurance);
            }

            if (rows.some(row => row.status === 'failed') || packageAssurance.failed.length > 0) {
                process.exitCode = 1;
            }
        });
}
