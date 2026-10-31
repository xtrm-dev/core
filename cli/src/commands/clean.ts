import { Command } from 'commander';
import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'path';
import { homedir } from 'os';
import { t } from '../utils/theme.js';
import { findProjectRoot } from '../utils/repo-root.js';
import { confirmDestructiveAction } from '../utils/confirmation.js';
import { runPluginEraCleanup } from '../core/plugin-era-cleanup.js';
import { getGlobalSkillsOverrideRoots } from '../core/global-skills-flag.js';
import {
    ALLOW_LARGE_PRUNE_ENV,
    pruneRetiredManagedSkills,
    resolvePackageRoot,
    type RegistryManifest,
} from '../core/registry-scaffold.js';

interface CleanHooksResult {
    removed: string[];
    updatedSettings: string[];
    preserved: string[];
}

interface CleanSkillsResult {
    removed: string[];
    refused: boolean;
    preserved: string[];
}

interface CleanResult {
    hooksRemoved: string[];
    settingsUpdated: string[];
    skillsRemoved: string[];
    preserved: string[];
}

async function cleanHooks(
    dryRun: boolean,
    repoRoot: string,
): Promise<CleanHooksResult> {
    const cleanup = await runPluginEraCleanup({
        dryRun,
        yes: true,
        scope: 'all',
        repoRoot,
    });

    return {
        removed: cleanup.planned
            .filter(operation => operation.type === 'delete-path')
            .map(operation => operation.label)
            .sort((left, right) => left.localeCompare(right)),
        updatedSettings: cleanup.planned
            .filter(operation => operation.type === 'delete-json-map-entries')
            .map(operation => operation.label)
            .sort((left, right) => left.localeCompare(right)),
        preserved: ['~/.claude/hooks/* (unknown entries preserved; directory not scanned)'],
    };
}

async function cleanSkills(
    dryRun: boolean,
    projectRoot: string,
): Promise<CleanSkillsResult> {
    const packageRoot = resolvePackageRoot();
    const registryPath = path.join(packageRoot, '.xtrm', 'registry.json');
    const registry = await fs.readJson(registryPath) as RegistryManifest;
    const userXtrmDir = path.join(homedir(), '.xtrm');
    const pruneResult = await pruneRetiredManagedSkills({
        userXtrmDir,
        registry,
        dryRun,
        overrideRoots: getGlobalSkillsOverrideRoots(projectRoot),
        registrySource: registryPath,
    });
    if (pruneResult.refused) {
        console.log(kleur.yellow(`  Refused to prune ${pruneResult.refused.retired.length} retired skill(s): ${pruneResult.refused.reason}. Re-run with ${ALLOW_LARGE_PRUNE_ENV}=1 to confirm.`));
    }

    return {
        refused: pruneResult.refused !== undefined,
        removed: pruneResult.removed
            .map(name => `~/.xtrm/skills/default/${name}`)
            .sort((left, right) => left.localeCompare(right)),
        preserved: ['~/.xtrm/skills/active/* (unknown entries preserved; only proven managed links are pruned)'],
    };
}

const CLEAN_DEPRECATION = 'xt clean is deprecated — use: xt update [--apply] --repo <path> (planned removal: v0.13.0)';

export function createCleanCommand(): Command {
    return new Command('clean')
        .description('[deprecated] Remove xtrm-owned legacy artifacts; use xt update [--apply] (planned removal: v0.13.0)')
        .option('--dry-run', 'Preview what would be removed without making changes', false)
        .option('--hooks-only', 'Only clean hooks, skip skills', false)
        .option('--skills-only', 'Only clean skills, skip hooks', false)
        .option('-y, --yes', 'Skip confirmation prompt', false)
        .action(async (opts) => {
            console.error(CLEAN_DEPRECATION);
            const { dryRun, hooksOnly, skillsOnly, yes } = opts;
            const projectRoot = await findProjectRoot();

            console.log(t.bold('\n  XTRM Clean — Remove Managed Legacy Artifacts\n'));

            if (dryRun) {
                console.log(kleur.yellow('  DRY RUN — No changes will be made\n'));
            }

            if (!dryRun) {
                const confirmed = await confirmDestructiveAction({
                    yes,
                    message: 'Remove xtrm-owned legacy hooks/plugins and retired skills?',
                    initial: false,
                });
                if (!confirmed) {
                    console.log(kleur.dim('  Cancelled\n'));
                    return;
                }
            }

            const result: CleanResult = {
                hooksRemoved: [],
                settingsUpdated: [],
                skillsRemoved: [],
                preserved: [],
            };

            if (!skillsOnly) {
                console.log(kleur.bold('  Scanning xtrm-managed legacy hooks and plugin artifacts...'));
                const hooks = await cleanHooks(dryRun, projectRoot);
                result.hooksRemoved = hooks.removed;
                result.settingsUpdated = hooks.updatedSettings;
                result.preserved.push(...hooks.preserved);

                for (const label of hooks.removed) {
                    console.log(kleur.red(`    ${dryRun ? '[DRY RUN] would remove' : 'removed'} managed ${label}`));
                }
                for (const label of hooks.updatedSettings) {
                    console.log(kleur.red(`    ${dryRun ? '[DRY RUN] would update' : 'updated'} managed ${label}`));
                }
                if (hooks.removed.length === 0 && hooks.updatedSettings.length === 0) {
                    console.log(kleur.dim('    ✓ No xtrm-owned legacy hook/plugin artifacts found'));
                }
            }

            if (!hooksOnly) {
                console.log(kleur.bold('\n  Scanning xtrm-managed retired skills...'));
                const skills = await cleanSkills(dryRun, projectRoot);
                result.skillsRemoved = skills.removed;
                result.preserved.push(...skills.preserved);

                for (const skill of skills.removed) {
                    console.log(kleur.red(`    ${dryRun ? '[DRY RUN] would remove' : 'removed'} managed ${skill}`));
                }
                if (skills.removed.length === 0 && !skills.refused) {
                    console.log(kleur.dim('    ✓ No retired managed skills found'));
                }
            }

            console.log(kleur.bold('\n  Ownership outcome:'));
            for (const preserved of result.preserved) {
                console.log(kleur.green(`    ✓ preserved ${preserved}`));
            }

            const totalRemoved = result.hooksRemoved.length + result.skillsRemoved.length;
            const totalUpdates = result.settingsUpdated.length;
            if (totalRemoved === 0 && totalUpdates === 0) {
                console.log(t.boldGreen('\n  ✓ No xtrm-owned legacy artifacts required cleanup\n'));
                return;
            }

            console.log(kleur.bold('\n  Summary:'));
            if (totalRemoved > 0) {
                console.log(kleur.red(`    ${totalRemoved} managed artifact(s) ${dryRun ? 'would be removed' : 'removed'}`));
            }
            if (totalUpdates > 0) {
                console.log(kleur.red(`    ${totalUpdates} managed settings file(s) ${dryRun ? 'would be updated' : 'updated'}`));
            }

            if (!dryRun) {
                console.log(t.boldGreen('\n  ✓ Cleanup complete\n'));
                console.log(kleur.dim('  Run `xt update --apply --repo <path>` to repair canonical components\n'));
            } else {
                console.log(kleur.yellow('\n  ℹ Dry run — run without --dry-run to apply changes\n'));
            }
        });
}
