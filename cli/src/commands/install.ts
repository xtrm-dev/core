import { Command } from 'commander';
import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'path';
import { resolveMainProjectRoot } from '../utils/repo-root.js';
import { getContext } from '../core/context.js';
import { t } from '../utils/theme.js';
import { runPiInstall } from './pi-install.js';
import { runClaudeRuntimeSyncPhase } from '../core/claude-runtime-sync.js';
import { runPluginEraCleanup } from '../core/plugin-era-cleanup.js';
import { ensureAgentsSkillsSymlink } from '../core/skills-scaffold.js';
import { assertRuntimeSkillsViews } from '../core/skills-runtime-views.js';
import {
    runMachineBootstrapPhase,
} from '../core/machine-bootstrap.js';
import {
    installFromRegistry,
    resolvePackageRoot,
    scaffoldSkillsDefaultFromPackage,
    type InstallStats,
    type RegistryManifest,
} from '../core/registry-scaffold.js';
import { syncPiMcpConfig, syncProjectMcpConfig } from '../core/project-mcp-sync.js';
import { ensureBeadsSharedServerEnabled } from '../core/beads-shared-server.js';

export interface InstallOpts {
    dryRun?: boolean;
    yes?: boolean;
    force?: boolean;
    prune?: boolean;
    backport?: boolean;
    global?: boolean;
    strictRegistry?: boolean;
    projectRoot?: string;
    /** Skip machine bootstrap (beads/dolt/bv/deepwiki) — used by the init orchestrator which handles it in a dedicated phase. */
    skipMachineBootstrap?: boolean;
    /** Skip Claude runtime sync (hooks/settings wiring). */
    skipClaudeRuntimeSync?: boolean;
}

function printNextSteps(): void {
    const d = (s: string) => kleur.dim(s);
    const b = (s: string) => kleur.bold(s);

    console.log(b('  Next steps\n'));

    console.log(d('  In your project:'));
    console.log(`  xtrm init                     ${d('initialize beads + gitnexus for this repo')}`);
    console.log(`  bd prime                      ${d('load session context and available work')}`);
    console.log(`  bv --robot-triage             ${d('graph-aware triage — find highest-impact work')}`);
    console.log(`  bd update <id> --claim        ${d('claim an issue before editing any file')}`);
    console.log(`  bd close <id>                 ${d('close when done')}`);

    console.log('');
    console.log(d('  Worktree workflow:'));
    console.log(`  xt claude                     ${d('launch Claude Code in a sandboxed worktree')}`);
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
        kleur.bold('  ✓ Install complete'),
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

export { isBeadsInstalled, isDoltInstalled, isDeepwikiInstalled, isBvInstalled } from '../core/machine-bootstrap.js';

export function createInstallAllCommand(): Command {
    return new Command('all')
        .description('[deprecated] Use xtrm install')
        .option('--dry-run', 'Preview changes without making any modifications', false)
        .option('-y, --yes', 'Skip confirmation prompts', false)
        .option('--no-mcp', 'Skip MCP server registration', false)
        .option('--force', 'Overwrite locally drifted files', false)
        .action(async (_opts) => {
            console.log('xtrm install all is deprecated — use: xtrm install');
        });
}

export function createInstallBasicCommand(): Command {
    return new Command('basic')
        .description('[deprecated] Use xtrm install')
        .option('--dry-run', 'Preview changes without making any modifications', false)
        .option('-y, --yes', 'Skip confirmation prompts', false)
        .option('--no-mcp', 'Skip MCP server registration', false)
        .option('--force', 'Overwrite locally drifted files', false)
        .action(async (_opts) => {
            console.log('xtrm install basic is deprecated — use: xtrm install');
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

export async function runInstall(opts: InstallOpts = {}): Promise<void> {
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
        console.log(kleur.yellow('  ⚠ xtrm install --backport is no longer supported in registry mode.'));
        return;
    }

    const effectiveYes = yes || process.argv.includes('--yes') || process.argv.includes('-y');
    const packageRoot = resolvePackageRoot();
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

    const registryPath = path.join(packageRoot, '.xtrm', 'registry.json');
    const registry = await fs.readJson(registryPath) as RegistryManifest;

    console.log(kleur.bold('\n  ⚙  xtrm install (.xtrm registry scaffold)'));
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

    const stats = await installFromRegistry({
        packageRoot,
        registry,
        userXtrmDir,
        dryRun,
        force,
        yes: effectiveYes,
        strictRegistry,
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

    await runPiInstall(dryRun, isGlobal, projectRoot);

    if (!dryRun) {
        if (force) {
            await ensureAgentsSkillsSymlink(projectRoot, { force: true });
        } else {
            await ensureAgentsSkillsSymlink(projectRoot);
        }
        await assertRuntimeSkillsViews(projectRoot);
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
}

export function createInstallCommand(): Command {
    const installCmd = new Command('install')
        .description('[deprecated] Use xtrm init — project-scoped setup in one command')
        .option('--dry-run', 'Preview changes without making any modifications', false)
        .option('-y, --yes', 'Skip confirmation prompts', false)
        .option('--prune', 'Remove items not in the canonical repository', false)
        .option('--backport', 'Backport drifted local changes back to the repository', false)
        .option('--force', 'Overwrite locally drifted files', false)
        .option('--global', 'Install to user-global scope (~/.xtrm) instead of project-local', false)
        .option('--strict-registry', 'Fail on registry/source mismatch or missing registry source files', false)
        .action(async (opts) => {
            console.log(kleur.yellow('  ⚠  xtrm install is deprecated — use xtrm init\n'));
            await runInstall(opts);
        });

    installCmd.addCommand(createInstallAllCommand());
    installCmd.addCommand(createInstallBasicCommand());

    return installCmd;
}
