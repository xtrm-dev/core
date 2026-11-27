import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'path';
import { resolveMainProjectRoot } from '../utils/repo-root.js';
import { getContext } from '../core/context.js';
import { t } from '../utils/theme.js';
import { runPiInstall } from './pi-install.js';
import type { PiSyncResult } from '../core/pi-runtime.js';
import { runClaudeRuntimeSyncPhase } from '../core/claude-runtime-sync.js';
import { runPluginEraCleanup } from '../core/plugin-era-cleanup.js';
import { ensureAgentsSkillsSymlink, ensureUserAgentsSkillsSymlink } from '../core/skills-scaffold.js';
import { ensureGlobalSkillsBootstrapped, logBootstrapTrigger } from '../core/global-skills-bootstrap.js';
import { ensureGlobalHooksBootstrapped } from '../core/global-hooks-bootstrap.js';
import { reconcileGlobalClaudeHooks } from '../core/claude-runtime-sync.js';
import { reconcileGlobalPiHooks } from '../core/pi-runtime-hooks.js';
import { shouldUseGlobalHooks } from '../core/global-hooks-flag.js';
import { assertRuntimeSkillsViews } from '../core/skills-runtime-views.js';
import { getGlobalSkillsOverrideRoots, shouldUseGlobalSkills } from '../core/global-skills-flag.js';
import {
    runMachineBootstrapPhase,
} from '../core/machine-bootstrap.js';
import {
    installFromRegistry,
    resolvePackageRoot,
    scaffoldSkillsDefaultFromPackage,
    ALLOW_LARGE_PRUNE_ENV,
    pruneRetiredManagedSkills,
    pruneRetiredOptionalSkills,
    type InstallStats,
    type RegistryManifest,
} from '../core/registry-scaffold.js';
import { syncPiMcpConfig, syncProjectMcpConfig } from '../core/project-mcp-sync.js';
import { ensureBeadsSharedServerEnabled } from '../core/beads-shared-server.js';
import { Command } from 'commander';
import {
    checkoutConfigPath,
    renderCheckoutReport,
    runCheckoutPhase,
    type CheckoutReport,
} from '../core/checkout-bootstrap.js';

export interface InstallOpts {
    dryRun?: boolean;
    yes?: boolean;
    force?: boolean;
    prune?: boolean;
    backport?: boolean;
    global?: boolean;
    strictRegistry?: boolean;
    substrateDir?: string;
    projectRoot?: string;
    /** Override the resolved package root (source of .xtrm/registry.json + skills payload). Test hermetics; production callers omit this. */
    packageRoot?: string;
    /** Skip machine bootstrap (sb/pi/pnpm/...) — used by the init orchestrator which handles it in a dedicated phase. */
    skipMachineBootstrap?: boolean;
    /** Skip Claude runtime sync (hooks/settings wiring). */
    skipClaudeRuntimeSync?: boolean;
    /** Update performs global Pi package assurance once after all repo reconciliations. */
    skipGlobalPiPackageAssurance?: boolean;
    /** Update applies the external Pi tool patch once after all repo reconciliations. */
    skipExternalPiToolPatch?: boolean;
    /** Update performs the global system-prompt sync once after all repo reconciliations. */
    skipGlobalPromptSync?: boolean;
}

export interface InstallResult {
    piRuntime?: PiSyncResult;
}

function printNextSteps(): void {
    const d = (s: string) => kleur.dim(s);
    const b = (s: string) => kleur.bold(s);

    console.log(b('  Next steps\n'));

    console.log(d('  In your project:'));
    console.log(`  xtrm init                     ${d('initialize Substrate + code intelligence for this repo')}`);
    console.log(`  sb --version                  ${d('verify the Substrate CLI')}`);
    console.log(`  sb doctor                     ${d('check state.db health + project link')}`);
    console.log(`  sb help --json                ${d('discover current command semantics; do not rely on stale copies')}`);
    console.log(`  xt skills list --global --json ${d('inspect the active XTRM skill surface')}`);

    console.log('');
    console.log(d('  Worktree workflow:'));
    console.log(`  xt pi                         ${d('launch Pi in a sandboxed worktree')}`);
    console.log(`  xt claude                     ${d('launch Claude Code in a sandboxed worktree')}`);
    console.log(`  xt codex                      ${d('launch Codex in a sandboxed worktree')}`);
    console.log(`  xt end --dry-run              ${d('preview PR title, body, and linked issues')}`);
    console.log(`  xt end                        ${d('push branch, open PR, clean up worktree')}`);

    console.log('');
    console.log(d('  Reference:'));
    console.log(`  xtrm status                   ${d('check installed vs repo')}`);
    console.log(`  xtrm docs show                ${d('browse all documentation')}`);
    console.log('');
}

async function renderSummaryCard(stats: InstallStats, isDryRun: boolean): Promise<void> {
    const boxen = (await import('boxen')).default;

    const lines = [
        kleur.bold('  ✓ Runtime maintenance complete'),
        '',
        `  ${t.label('Expected installs')} ${stats.expectedInstalls}`,
        `  ${t.label('Installed')} ${stats.installed}`,
        `  ${t.label('Up-to-date')} ${stats.upToDate}`,
        `  ${t.label('Drift skipped')} ${stats.driftedSkipped}`,
        `  ${t.label('Forced')} ${stats.forced}`,
        `  ${t.label('Missing source skipped')} ${stats.missingSourceSkipped}`,
        ...(isDryRun ? ['', kleur.dim('  Dry run — no changes written')] : []),
    ];

    console.log('\n' + boxen(lines.join('\n'), {
        padding: { top: 1, bottom: 1, left: 1, right: 3 },
        borderStyle: 'round',
        borderColor: 'gray',
    }) + '\n');
}

export { isSbInstalled, isDeepwikiInstalled } from '../core/machine-bootstrap.js';

/**
 * Local-checkout phase entry point shared by `xt install`, `xt update` and
 * `xt doctor`. Silent when the machine has no checkout configuration and the
 * caller did not ask for it. Returns null when the phase did not run.
 */
export function runCheckoutPhaseForCli(opts: {
    fromCheckouts?: boolean;
    check?: boolean;
    home?: string | null;
    quiet?: boolean;
}): CheckoutReport | null {
    let report: CheckoutReport | null;
    try {
        report = runCheckoutPhase({
            fromCheckouts: opts.fromCheckouts,
            check: opts.check,
            home: opts.home ?? null,
            log: (line) => {
                if (!opts.quiet) console.log(kleur.dim(`  • ${line}`));
            },
        });
    } catch (error) {
        console.error(kleur.red(`  ✗ checkout phase: ${(error as Error).message}`));
        throw error;
    }
    if (!report) return null;
    if (!opts.quiet) {
        console.log('');
        for (const line of renderCheckoutReport(report)) console.log(line);
        console.log('');
    }
    return report;
}

export interface InstallCommandOpts {
    fromCheckouts?: boolean;
    check?: boolean;
    home?: string;
    dryRun?: boolean;
    yes?: boolean;
    json?: boolean;
}

/**
 * `xt install` — the machine bootstrap verb of the build order. It runs the
 * same machine → runtime payload engine as `xt init` and, when the machine is
 * configured for local checkouts (or `--from-checkouts` is passed), the
 * checkout phase that clones/fast-forwards/links them.
 *
 * `--check` runs the checkout phase alone and writes nothing.
 */
export function createInstallCommand(): Command {
    return new Command('install')
        .description('Machine bootstrap: runtimes and payloads, plus local checkouts (clone, fast-forward, npm link)')
        .option('--from-checkouts', 'Run the local-checkout phase even when this machine has no checkouts.json', false)
        .option('--check', 'Report checkout drift only; change nothing', false)
        .option('--home <dir>', 'Install against this home instead of the current one (rehearsal)')
        .option('--dry-run', 'Preview changes without making any modifications', false)
        .option('-y, --yes', 'Skip confirmation prompts', false)
        .option('--json', 'Print the checkout report as JSON', false)
        .action(async (opts: InstallCommandOpts) => {
            if (opts.check) {
                const report = runCheckoutPhaseForCli({
                    fromCheckouts: opts.fromCheckouts,
                    check: true,
                    home: opts.home ?? null,
                    quiet: Boolean(opts.json),
                });
                if (!report) {
                    console.error(kleur.yellow(`  ○ no checkout configuration at ${checkoutConfigPath()}; nothing to check`));
                    console.error(kleur.dim('    add one, or run: xt install --from-checkouts --check'));
                    process.exitCode = 1;
                    return;
                }
                if (opts.json) console.log(JSON.stringify(report, null, 2));
                if (!report.ok) process.exitCode = 1;
                return;
            }

            await runInstall({ dryRun: opts.dryRun, yes: opts.yes, projectRoot: getProjectRoot() });
            const report = runCheckoutPhaseForCli({
                fromCheckouts: opts.fromCheckouts,
                check: false,
                home: opts.home ?? null,
                quiet: Boolean(opts.json),
            });
            if (!report) {
                console.log(kleur.dim('  checkouts: not configured on this machine (see docs/local-checkouts.md)'));
                return;
            }
            if (opts.json) console.log(JSON.stringify(report, null, 2));
            if (!report.ok) process.exitCode = 1;
        });
}

export async function runMachineBootstrap(opts: { yes?: boolean } = {}): Promise<void> {
    await runMachineBootstrapPhase({ dryRun: false });
}

function getProjectRoot(): string {
    // xtrm-6ofgm: must resolve the MAIN checkout, not the worktree dir, so
    // hook command paths in .claude/settings.json never bake a worktree path.
    return resolveMainProjectRoot(process.cwd());
}

export function isStrictRegistryMode(opts: { strictRegistry?: boolean }): boolean {
    return opts.strictRegistry ?? process.env.XTRM_STRICT_REGISTRY === '1';
}

export async function runInstall(opts: InstallOpts = {}): Promise<InstallResult> {
    const {
        dryRun = false,
        yes = false,
        force = false,
        backport = false,
        prune = false,
        global: isGlobal = false,
        skipMachineBootstrap = false,
        skipClaudeRuntimeSync = false,
    } = opts;
    const strictRegistry = isStrictRegistryMode(opts);

    if (backport) {
        console.log(kleur.yellow('  ⚠ Backport mode is no longer supported in registry mode.'));
        return {};
    }

    const effectiveYes = yes || process.argv.includes('--yes') || process.argv.includes('-y');
    const packageRoot = opts.packageRoot ?? resolvePackageRoot();
    const projectRoot = opts.projectRoot ?? getProjectRoot();

    if (!skipMachineBootstrap) {
        await runMachineBootstrap({ yes: effectiveYes });
    }

    const ctx = await getContext({
        createMissingDirs: !dryRun,
        isGlobal,
        projectRoot,
    });
    const userXtrmDir = ctx.targets[0];

    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const pkgJson = await fs.readJson(path.join(packageRoot, 'package.json')) as { version?: string };
    await logBootstrapTrigger({
        command: 'install',
        cwd: process.cwd(),
        pkgVersion: pkgJson.version ?? '0.0.0',
    });
    if (!dryRun) {
        await ensureGlobalSkillsBootstrapped(packageRoot, force ? { force: true } : {});
        if (shouldUseGlobalHooks()) {
            await ensureGlobalHooksBootstrapped(packageRoot, force ? { force: true } : {});
            await reconcileGlobalClaudeHooks();
            await reconcileGlobalPiHooks();
        }
    }

    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const registryPath = path.join(packageRoot, '.xtrm', 'registry.json');
    const registry = await fs.readJson(registryPath) as RegistryManifest;

    console.log(kleur.bold('\n  ⚙  xtrm runtime maintenance (.xtrm registry scaffold)'));
    console.log(kleur.dim(`  • registry: ${registryPath}`));
    console.log(kleur.dim(`  • target: ${userXtrmDir}`));

    const scaffoldResult = await scaffoldSkillsDefaultFromPackage({
        packageRoot,
        userXtrmDir,
        dryRun,
    });
    if (scaffoldResult === 'copy') {
        console.log(kleur.dim('  • Repaired .xtrm/skills/default from package payload'));
    }

    const pruneResult = await pruneRetiredManagedSkills({
        userXtrmDir,
        registry,
        dryRun,
        overrideRoots: getGlobalSkillsOverrideRoots(projectRoot),
        registrySource: registryPath,
    });
    if (pruneResult.refused) {
        console.log(kleur.yellow(`  • Refused to prune ${pruneResult.refused.retired.length} retired skill(s): ${pruneResult.refused.reason}. Re-run with ${ALLOW_LARGE_PRUNE_ENV}=1 to confirm.`));
    }
    if (pruneResult.removed.length > 0) {
        const verb = dryRun ? 'Would remove' : 'Removed';
        console.log(kleur.dim(`  • ${verb} ${pruneResult.removed.length} retired managed skill(s): ${pruneResult.removed.join(', ')}`));
    }

    const optionalPrune = await pruneRetiredOptionalSkills({ userXtrmDir, dryRun });
    if (optionalPrune.removed.length > 0) {
        const verb = dryRun ? 'Would remove' : 'Removed';
        console.log(kleur.dim(`  • ${verb} ${optionalPrune.removed.length} retired optional skill(s): ${optionalPrune.removed.join(', ')}`));
    }

    const stats = await installFromRegistry({
        packageRoot,
        registry,
        userXtrmDir,
        dryRun,
        force,
        yes: effectiveYes,
        strictRegistry,
        overrideRoots: getGlobalSkillsOverrideRoots(projectRoot),
    });

    if (prune) {
        await runPluginEraCleanup({
            dryRun,
            yes: effectiveYes,
            scope: 'all',
            repoRoot: projectRoot,
        });
    }

    const mcpSync = await syncProjectMcpConfig(projectRoot, { dryRun });
    if (mcpSync.wroteFile) {
        const verb = mcpSync.createdFile ? 'Created' : 'Updated';
        console.log(kleur.dim(`  • ${verb} ${mcpSync.mcpPath} (+${mcpSync.addedServers.length} server${mcpSync.addedServers.length === 1 ? '' : 's'})`));
    } else {
        console.log(kleur.dim(`  • ${mcpSync.mcpPath} already up to date`));
    }
    for (const warning of mcpSync.missingEnvWarnings) {
        console.log(kleur.yellow(`  ⚠ MCP server ${warning}`));
    }

    const piMcpSync = await syncPiMcpConfig(projectRoot, { dryRun });
    if (piMcpSync.wroteFile) {
        const verb = piMcpSync.createdFile ? 'Created' : 'Updated';
        console.log(kleur.dim(`  • ${verb} ${piMcpSync.mcpPath} (+${piMcpSync.addedServers.length} server${piMcpSync.addedServers.length === 1 ? '' : 's'})`));
    } else {
        console.log(kleur.dim(`  • ${piMcpSync.mcpPath} already up to date`));
    }
    for (const warning of piMcpSync.missingEnvWarnings) {
        console.log(kleur.yellow(`  ⚠ Pi MCP server ${warning}`));
    }

    if (!skipClaudeRuntimeSync) {
        await runClaudeRuntimeSyncPhase({ repoRoot: projectRoot, dryRun, isGlobal, prune });
    }

    const piRuntime = await runPiInstall(dryRun, isGlobal, projectRoot, {
        skipGlobalPackageAssurance: opts.skipGlobalPiPackageAssurance,
        skipExternalToolPatch: opts.skipExternalPiToolPatch,
        skipGlobalPromptSync: opts.skipGlobalPromptSync,
    });

    if (!dryRun) {
        if (force) {
            await ensureUserAgentsSkillsSymlink({ force: true });
            await ensureAgentsSkillsSymlink(projectRoot, { force: true });
        } else {
            await ensureUserAgentsSkillsSymlink();
            await ensureAgentsSkillsSymlink(projectRoot);
        }
        await assertRuntimeSkillsViews(projectRoot, { scope: shouldUseGlobalSkills(projectRoot) ? 'global' : 'both' });
        await ensureBeadsSharedServerEnabled(projectRoot, true);
    }

    await renderSummaryCard(stats, dryRun);

    if (stats.missingSourceSkipped > 0) {
        const mismatchMessage = `Registry/source mismatch: ${stats.missingSourceSkipped} expected file${stats.missingSourceSkipped === 1 ? '' : 's'} were missing from package payload.`;
        if (strictRegistry) {
            throw new Error(mismatchMessage);
        }
        console.log(kleur.yellow(`  ⚠ ${mismatchMessage}`));
        console.log(kleur.yellow('    Install continued, but your runtime may be incomplete. Regenerate/publish registry assets to resolve.'));
        console.log('');
    }

    if (!dryRun) {
        printNextSteps();
    }

    return { piRuntime };
}
