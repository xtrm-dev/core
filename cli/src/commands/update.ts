import { Command } from 'commander';
import kleur from 'kleur';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { checkDrift } from '../core/drift.js';
import { resolvePackageRoot } from '../core/registry-scaffold.js';
import { ensureGlobalSkillsBootstrapped, logBootstrapTrigger } from '../core/global-skills-bootstrap.js';
import { ensureGlobalHooksBootstrapped } from '../core/global-hooks-bootstrap.js';
import { getGlobalSkillsOverrideRoots, shouldUseGlobalSkills } from '../core/global-skills-flag.js';
import { shouldUseGlobalHooks } from '../core/global-hooks-flag.js';
import { reconcileGlobalClaudeHooks } from '../core/claude-runtime-sync.js';
import { reconcileGlobalPiHooks } from '../core/pi-runtime-hooks.js';
import { assureXtManagedPiPackages, runExternalPiToolPatch } from '../core/pi-runtime.js';
import { printGlobalPromptSyncSummary, syncGlobalPrompts } from '../core/global-prompt-sync.js';
import { scanXtrmRepos } from '../core/repo-discovery.js';
import { isStrictRegistryMode, runInstall } from './install.js';
import { printDependencyMaintenanceSummary, runDependencyMaintenance, type DependencyMaintenanceSummary } from '../core/dependency-maintenance.js';
import { migrationBlockedReason, planSubstrateMigration, type MigrationPlan } from '../core/substrate-migration.js';
import { ensureServiceSkills } from '../core/service-skills-ensure.js';
import { ensureAgentsSkillsSymlink, ensureUserAgentsSkillsSymlink } from '../core/skills-scaffold.js';
import { reconcileProjectClaudeHooks } from '../core/claude-runtime-sync.js';
import { resolveMainProjectRoot } from '../utils/repo-root.js';
import { printNudgeOnce } from '../utils/nudge.js';
import { stageMigrationChanges } from '../utils/git-staging.js';

type UpdateStatus = 'refreshed' | 'already-current' | 'failed' | 'skipped' | 'incomplete';

interface RepoUpdateResult {
    repo: string;
    status: UpdateStatus;
    reason?: string;
    maintenance?: DependencyMaintenanceSummary;
    migration?: {
        needed: boolean;
        status: string;
        reason: string;
    };
    piRuntime?: {
        changed: boolean;
        failed: string[];
    };
}

interface UpdateOpts {
    root?: string;
    repo?: string;
    json?: boolean;
    apply?: boolean;
    allRepos?: boolean;
    strictRegistry?: boolean;
    force?: boolean;
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

async function printSkillsMigrationNudge(repoRoot: string): Promise<void> {
    const legacyDefaultRoot = path.join(repoRoot, '.xtrm', 'skills', 'default');
    const legacyOptionalRoot = path.join(repoRoot, '.xtrm', 'skills', 'optional');
    const hasLegacyProjectSkills = await fs.pathExists(legacyDefaultRoot) || await fs.pathExists(legacyOptionalRoot);

    if (!hasLegacyProjectSkills) {
        return;
    }

    await printNudgeOnce('skills-global-migration', [
        kleur.yellow('  ⚠ Project-scoped default/optional skills remain on disk; xt update no longer re-syncs them when XTRM_GLOBAL_SKILLS=1.'),
        kleur.yellow('    Run `xt migrate skills` to clean legacy project payloads.'),
        kleur.yellow('    Docs: https://github.com/Jaggerxtrm/xtrm-tools/blob/main/docs/skills-registry-exploration.md'),
    ]);
}

async function updateRepo(repoRoot: string, opts: UpdateOpts): Promise<RepoUpdateResult> {
    const packageRoot = resolvePackageRoot();
    const registryPath = path.join(packageRoot, '.xtrm', 'registry.json');
    const userXtrmDir = path.join(repoRoot, '.xtrm');

    try {
        if (!(await fs.pathExists(registryPath))) {
            return { repo: repoRoot, status: 'failed', reason: `missing package registry at ${registryPath}` };
        }

        // ADR 43 gate FIRST (read-only): the migration decision precedes
        // every mutation below — log trigger, global bootstrap, registry
        // install, skills, hooks, maintenance, and staging. The gate sits
        // here (not after the bootstrap block) so the per-repo blocked path
        // is itself zero-mutation even if fleet preflight is ever bypassed.
        const earlyMigrationPlan: MigrationPlan = await planSubstrateMigration(repoRoot);
        // Amended A8/A9 contract: A8 never activates the legacy import.
        // Any needed migration fails closed here with exact remediation.
        // Import activation + verifier + cleanup are owned by xtrm-6qu.9.
        if (opts.apply && earlyMigrationPlan.needed) {
            const blocked = migrationBlockedReason(earlyMigrationPlan);
            const gateMaintenance = await runDependencyMaintenance(repoRoot, false);
            return {
                repo: repoRoot,
                status: 'failed',
                reason: `substrate migration required: ${blocked ?? earlyMigrationPlan.reason}`,
                maintenance: gateMaintenance,
                migration: { needed: true, status: 'blocked', reason: blocked ?? earlyMigrationPlan.reason },
                piRuntime: undefined,
            };
        }

        const pkgJson = await fs.readJson(path.join(packageRoot, 'package.json')) as { version?: string };
        if (opts.apply) {
            await logBootstrapTrigger({
                command: 'update',
                cwd: process.cwd(),
                pkgVersion: pkgJson.version ?? '0.0.0',
            });
            await ensureGlobalSkillsBootstrapped(packageRoot, opts.force ? { force: true } : {});
            await ensureUserAgentsSkillsSymlink({ force: true });
            if (shouldUseGlobalHooks()) {
                await ensureGlobalHooksBootstrapped(packageRoot, opts.force ? { force: true } : {});
                await reconcileGlobalClaudeHooks();
                await reconcileGlobalPiHooks();
            }
            if (shouldUseGlobalSkills(repoRoot)) {
                await printSkillsMigrationNudge(repoRoot);
            }
        }

        const drift = await checkDrift(registryPath, userXtrmDir, opts.apply ? getGlobalSkillsOverrideRoots(repoRoot) : undefined);
        // Substrate migration owns legacy Beads state now (ADR section 42).
        // Detection ran read-only above; application follows the gate below.
        // No Beads-state maintenance runs in either mode.
        const migrationPlan: MigrationPlan = earlyMigrationPlan;
        const maintenancePlan = await runDependencyMaintenance(repoRoot, false);
        const maintenanceNeedsApply = maintenancePlan.substrateDoctor.state === 'failed'
            || maintenancePlan.gitnexusIndex.state === 'outdated'
            || maintenancePlan.tools.some(tool => tool.state === 'outdated' || tool.state === 'missing');
        const registryChanges = drift.missing.length > 0 || drift.drifted.length > 0;
        // migrationPending is always false here in apply mode: the ADR 43
        // gate above already returned for needed migrations. It remains for
        // dry-run display ('substrate migration pending', read-only).
        const migrationPending = migrationPlan.needed && !opts.apply;
        const migrationSummary = { needed: migrationPlan.needed, status: 'planned', reason: migrationPlan.reason };
        let installResult: Awaited<ReturnType<typeof runInstall>>;
        try {
            installResult = await runInstall({
                force: Boolean(opts.apply),
                yes: true,
                dryRun: !opts.apply,
                projectRoot: repoRoot,
                skipMachineBootstrap: true,
                skipClaudeRuntimeSync: true,
                skipGlobalPiPackageAssurance: true,
                skipExternalPiToolPatch: true,
                // Global system-prompt preflight runs exactly once per update command,
                // before repo resolution and reconciliation — never once per repo (xtrm-3ljgz.2).
                skipGlobalPromptSync: true,
                strictRegistry: isStrictRegistryMode(opts),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.startsWith('Registry/source mismatch:')) throw error;
            throw new Error(`Pi reconciliation failed: ${message}`);
        }
        const piRuntime = installResult?.piRuntime;
        const piRuntimeResult = piRuntime
            ? { changed: Boolean(piRuntime.changed), failed: [...piRuntime.failed] }
            : undefined;
        const runtimeChanged = piRuntimeResult?.changed ?? false;
        const runtimeFailed = piRuntimeResult?.failed ?? [];
        const hasChanges = registryChanges || migrationPending || maintenanceNeedsApply || runtimeChanged;

        if (!opts.apply) {
            return {
                repo: repoRoot,
                status: hasChanges ? 'refreshed' : 'already-current',
                reason: hasChanges
                    ? [
                        `missing=${drift.missing.length}, drifted=${drift.drifted.length}`,
                        migrationPending ? `substrate migration pending: ${migrationPlan.reason}` : '',
                        runtimeChanged ? 'Pi runtime repair pending' : '',
                    ].filter(Boolean).join(', ')
                    : undefined,
                maintenance: maintenancePlan,
                migration: migrationSummary,
                piRuntime: piRuntimeResult,
            };
        }

        // Foolproof service-skills migration: runs AFTER skills install so the latest
        // migrator is present. Registry-gated + idempotent — a no-op in non-service
        // repos and on already-migrated ones, but it still migrates a package-current
        // repo that is on the OLD service layout (which xt update otherwise misses).
        const serviceSkills = await ensureServiceSkills(repoRoot, { apply: true });
        await fs.remove(path.join(repoRoot, '.xtrm', 'skills', 'active'));
        await ensureAgentsSkillsSymlink(repoRoot);

        // Reconcile .claude/settings.json hooks against canonical hooks.json on every
        // apply. runInstall skips this phase so update can keep its project hook
        // reconciliation explicit and idempotent.
        const hookSync = await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });

        if (runtimeFailed.length > 0) {
            return {
                repo: repoRoot,
                status: 'failed',
                reason: `Pi reconciliation failed: ${runtimeFailed.join(', ')}`,
                maintenance: maintenancePlan,
                migration: migrationSummary,
                piRuntime: piRuntimeResult,
            };
        }

        if (!hasChanges && serviceSkills.alreadyCurrent && !hookSync.changed) {
            return {
                repo: repoRoot,
                status: 'already-current',
                maintenance: maintenancePlan,
                migration: migrationSummary,
                piRuntime: piRuntimeResult,
            };
        }

        const maintenance = await runDependencyMaintenance(repoRoot, true);

        // xtrm-utdq1: stage tracked modifications (hook-path rewrites, retired
        // asset removals) and drop runtime state from the index. Never commits.
        // Empty-tree, non-git, and clean-tree cases are all no-ops.
        const stageResult = await stageMigrationChanges(repoRoot);

        const serviceSkillsReason = serviceSkills.migratedPacks.length > 0
            ? `, service-skills migrated: ${serviceSkills.migratedPacks.join(',')}`
            : '';
        const hookSyncReason = hookSync.changed ? ', claude hooks rewired' : '';
        const runtimeReason = runtimeChanged ? ', Pi runtime repaired' : '';
        const migrationReason = migrationSummary.needed ? `, substrate migration: ${migrationSummary.status}` : '';
        const stageReason = stageResult.filesStaged > 0
            ? `, ${stageResult.filesStaged} file(s) staged`
            : '';
        return {
            repo: repoRoot,
            status: 'refreshed',
            reason: `missing=${drift.missing.length}, drifted=${drift.drifted.length}${migrationReason}${runtimeReason}${serviceSkillsReason}${hookSyncReason}${stageReason}`,
            maintenance,
            migration: migrationSummary,
            piRuntime: piRuntimeResult,
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

    const commit = spawnGit(repoRoot, ['commit', '-m', 'chore: apply substrate migration + registry refresh (xt update --apply)']);
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

/**
 * Fleet preflight (apply mode only, read-only): plan every target's AND
 * every incomplete repo's migration BEFORE any global/repo mutation.
 * Incomplete repos (`.xtrm/` without `registry.json`) are included because
 * an incomplete repo can still carry a legacy `.beads` board. A single
 * blocked repo aborts the whole run — global skills/hooks/package cutover
 * must never strand a legacy board that cannot migrate (ADR 43).
 */
async function preflightFleetMigration(repos: string[]): Promise<Array<{ repo: string; blocked: string | null }>> {
    const results: Array<{ repo: string; blocked: string | null }> = [];
    for (const repo of repos) {
        try {
            const plan = await planSubstrateMigration(repo);
            results.push({ repo, blocked: migrationBlockedReason(plan) });
        } catch (error) {
            // Fail-closed: an unreadable board blocks the fleet, never slips through.
            results.push({ repo, blocked: `migration preflight failed: ${error instanceof Error ? error.message : String(error)}` });
        }
    }
    return results;
}

export function createUpdateCommand(): Command {
    return new Command('update')
        .description('Routine refresh and repair for xtrm-managed files, runtimes, hooks, skills, and packages')
        .option('--apply', 'Write changes with forced registry mode', false)
        .option('--force', 'Force global payload refresh; retained for the deprecated xt bootstrap alias', false)
        .option('--strict-registry', 'Fail on registry/source mismatch or missing registry source files', false)
        .option('--root <dir>', 'Walk root and update every repo with .xtrm/registry.json')
        .option('--all-repos', 'Sweep ~/dev and ~/projects for xtrm-managed repos (dry-run by default; --apply patches and commits each changed repo)', false)
        .option('--repo <path>', 'Target one repo path instead of cwd')
        .option('--json', 'Print JSON output', false)
        .action(async (opts) => {
            const typedOpts = opts as UpdateOpts;
            const { targets, incomplete } = await resolveTargetRepos(typedOpts);
            const rows: RepoUpdateResult[] = [];
            // Fleet gate BEFORE apply-mode globals (prompts, packages, hooks):
            // zero global/repo/runtime mutation while any target is blocked.
            // Incomplete repos are preflighted too: an incomplete `.xtrm/`
            // repo can still carry a legacy `.beads` board.
            if (typedOpts.apply) {
                const preflightTargets = await preflightFleetMigration(targets);
                const preflightIncomplete = await preflightFleetMigration(incomplete);
                const blocked = [...preflightTargets, ...preflightIncomplete].filter(entry => entry.blocked);
                if (blocked.length > 0) {
                    const blockers = blocked.map(entry => entry.repo).join(', ');
                    for (const repo of targets) {
                        const hit = blocked.find(entry => entry.repo === repo);
                        rows.push(hit
                            ? { repo, status: 'failed', reason: `substrate migration required: ${hit.blocked}` }
                            : { repo, status: 'skipped', reason: `not attempted: fleet preflight blocked by ${blockers}` });
                    }
                    for (const repo of incomplete) {
                        const hit = blocked.find(entry => entry.repo === repo);
                        rows.push(hit
                            ? { repo, status: 'failed', reason: `substrate migration required: ${hit.blocked}` }
                            : {
                                repo,
                                status: 'incomplete',
                                reason: 'missing .xtrm/registry.json — run `xt init` to bootstrap or `xt update --apply --repo <path>` to repair',
                            });
                    }
                    if (typedOpts.json) {
                        // Same keys as the normal path (packages/promptSync null:
                        // skipped stages), plus the abort cause.
                        console.log(JSON.stringify({ repos: rows, packages: null, promptSync: null, fleetPreflightBlocked: blockers }, null, 2));
                    } else {
                        printTable(rows);
                    }
                    process.exitCode = 1;
                    return;
                }
            }
            const promptSync = await syncGlobalPrompts({ dryRun: !typedOpts.apply });
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
                    reason: 'missing .xtrm/registry.json — run `xt init` to bootstrap or `xt update --apply --repo <path>` to repair',
                });
            }

            // Post-loop globals stay behind the same gate: a migration-blocked
            // row means a legacy board is stranded, so global package/tool
            // cutover is skipped (report-only assurance instead of mutation).
            const migrationStranded = rows.some(row => row.migration?.status === 'blocked');
            const packageAssurance = await assureXtManagedPiPackages(!Boolean(typedOpts.apply) || migrationStranded);
            if (typedOpts.apply && !migrationStranded) runExternalPiToolPatch(resolvePackageRoot(), false);

            if (opts.json) {
                console.log(JSON.stringify({ repos: rows, packages: packageAssurance, promptSync }, null, 2));
            } else {
                printTable(rows);
                for (const row of rows) {
                    if (row.maintenance) printDependencyMaintenanceSummary(row.maintenance);
                }
                printPiPackages(packageAssurance);
                printGlobalPromptSyncSummary(promptSync);
            }

            // Blocked migrations map to 'failed' rows; 'incomplete' rows are
            // also nonzero (a repo that cannot even be read is not success).
            if (rows.some(row => row.status === 'failed' || row.status === 'incomplete') || packageAssurance.failed.length > 0) {
                process.exitCode = 1;
            }
        });
}
