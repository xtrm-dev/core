import { Command } from 'commander';
import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'path';
import { homedir } from 'os';
import { t, sym } from '../utils/theme.js';
import { findRepoRoot } from '../utils/repo-root.js';
import { confirmDestructiveAction } from '../utils/confirmation.js';

// Canonical hooks (files in ~/.claude/hooks/)
const CANONICAL_HOOKS = new Set([
    'using-xtrm-reminder.mjs',
    'beads-gate-core.mjs',
    'beads-gate-utils.mjs',
    'beads-gate-messages.mjs',
    'beads-edit-gate.mjs',
    'beads-commit-gate.mjs',
    'beads-stop-gate.mjs',
    'beads-memory-gate.mjs',
    'beads-claim-sync.mjs',
    'beads-compact-save.mjs',
    'beads-compact-restore.mjs',
    'worktree-boundary.mjs',
    'statusline.mjs',
    'quality-check.cjs',
    'quality-check-env.mjs',
    'quality-check.py',
    'xtrm-logger.mjs',
    'xtrm-tool-logger.mjs',
    'xtrm-session-logger.mjs',
    'gitnexus',  // directory
    'README.md',
]);

const ACTIVE_SKILLS_RUNTIMES = ['claude', 'pi'] as const;

// Directories/files to always ignore
const IGNORED_ITEMS = new Set([
    '__pycache__',
    '.DS_Store',
    'Thumbs.db',
    '.gitkeep',
    'node_modules',
]);

interface CleanResult {
    hooksRemoved: string[];
    skillsRemoved: string[];
    cacheRemoved: string[];
}

async function cleanHooks(dryRun: boolean): Promise<{ removed: string[]; cache: string[] }> {
    const hooksDir = path.join(homedir(), '.claude', 'hooks');
    const removed: string[] = [];
    const cache: string[] = [];

    if (!await fs.pathExists(hooksDir)) {
        return { removed, cache };
    }

    const entries = await fs.readdir(hooksDir);

    for (const entry of entries) {
        // Skip ignored items but track them for cache cleanup
        if (IGNORED_ITEMS.has(entry)) {
            if (!dryRun) {
                const fullPath = path.join(hooksDir, entry);
                await fs.remove(fullPath);
            }
            cache.push(entry);
            continue;
        }

        // Check if it's canonical
        if (CANONICAL_HOOKS.has(entry)) {
            continue;
        }

        // Check if it's a file we should remove
        const fullPath = path.join(hooksDir, entry);
        const stat = await fs.stat(fullPath);

        // Only remove files, not arbitrary directories (except cache dirs)
        if (stat.isFile() || (stat.isDirectory() && IGNORED_ITEMS.has(entry))) {
            if (!dryRun) {
                await fs.remove(fullPath);
            }
            removed.push(entry);
        }
    }

    return { removed, cache };
}

async function cleanSkills(dryRun: boolean): Promise<string[]> {
    const removed: string[] = [];
    const skillsRoot = path.join(homedir(), '.xtrm', 'skills');

    for (const runtime of ACTIVE_SKILLS_RUNTIMES) {
        const activeRoot = path.join(skillsRoot, 'active', runtime);
        if (!await fs.pathExists(activeRoot)) {
            continue;
        }

        const entries = await fs.readdir(activeRoot);
        for (const entry of entries) {
            if (IGNORED_ITEMS.has(entry)) {
                continue;
            }

            const entryPath = path.join(activeRoot, entry);
            const stat = await fs.lstat(entryPath).catch(() => null);
            if (!stat) {
                continue;
            }

            if (!stat.isSymbolicLink()) {
                if (!dryRun) {
                    await fs.remove(entryPath);
                }
                removed.push(`active/${runtime}/${entry} (non-symlink)`);
                continue;
            }

            const linkTarget = await fs.readlink(entryPath).catch(() => null);
            if (!linkTarget) {
                if (!dryRun) {
                    await fs.remove(entryPath);
                }
                removed.push(`active/${runtime}/${entry} (broken-link)`);
                continue;
            }

            const resolvedTarget = path.resolve(path.dirname(entryPath), linkTarget);
            if (!await fs.pathExists(resolvedTarget)) {
                if (!dryRun) {
                    await fs.remove(entryPath);
                }
                removed.push(`active/${runtime}/${entry} (dangling)`);
            }
        }
    }

    const legacyAgentsSkills = path.join(homedir(), '.agents', 'skills');
    if (await fs.pathExists(legacyAgentsSkills)) {
        if (!dryRun) {
            await fs.remove(legacyAgentsSkills);
        }
        removed.push('.agents/skills (deprecated)');
    }

    return removed;
}

async function cleanOrphanedHookEntries(dryRun: boolean, repoRoot: string | null): Promise<string[]> {
    const settingsPath = path.join(homedir(), '.claude', 'settings.json');
    const removed: string[] = [];

    if (!await fs.pathExists(settingsPath)) {
        return removed;
    }

    let settings: any = {};
    try {
        settings = await fs.readJson(settingsPath);
    } catch {
        return removed;
    }

    if (!settings.hooks || typeof settings.hooks !== 'object') {
        return removed;
    }

    // Collect canonical script names from CANONICAL_HOOKS
    const canonicalScripts = new Set<string>();
    for (const hook of CANONICAL_HOOKS) {
        if (hook.endsWith('.py') || hook.endsWith('.mjs') || hook.endsWith('.cjs') || hook.endsWith('.js')) {
            canonicalScripts.add(hook);
        }
    }
    canonicalScripts.add('gitnexus/gitnexus-hook.cjs');

    // Build canonical wiring map from config/hooks.json: script -> Set<"event:::matcher|NONE">
    // Used to detect canonical scripts wired to wrong events or with stale matchers.
    const canonicalWiringKeys = new Map<string, Set<string>>();
    if (repoRoot) {
        const hooksJsonPath = path.join(repoRoot, 'config', 'hooks.json');
        try {
            if (await fs.pathExists(hooksJsonPath)) {
                const hooksJson = await fs.readJson(hooksJsonPath);
                for (const [event, entries] of Object.entries(hooksJson.hooks ?? {})) {
                    for (const entry of entries as any[]) {
                        const script: string = entry.script;
                        if (!script) continue;
                        const key = `${event}:::${entry.matcher ?? 'NONE'}`;
                        if (!canonicalWiringKeys.has(script)) canonicalWiringKeys.set(script, new Set());
                        canonicalWiringKeys.get(script)!.add(key);
                    }
                }
            }
        } catch { /* ignore, fall back to script-only check */ }
    }

    // Check each hook entry
    let modified = false;
    for (const [event, wrappers] of Object.entries(settings.hooks)) {
        if (!Array.isArray(wrappers)) continue;

        const keptWrappers: any[] = [];
        for (const wrapper of wrappers) {
            const innerHooks = wrapper.hooks || [wrapper];
            const keptInner: any[] = [];

            for (const hook of innerHooks) {
                const cmd = hook?.command || '';
                const m = cmd.match(/\/hooks\/([A-Za-z0-9_/-]+\.(?:py|cjs|mjs|js))/);
                const script = m?.[1];

                if (!script || canonicalScripts.has(script)) {
                    keptInner.push(hook);
                } else {
                    removed.push(`${event}:${script}`);
                    modified = true;
                }
            }

            if (keptInner.length > 0) {
                // Validate canonical wiring: check that this (event, matcher) combo exists in canonical source
                if (canonicalWiringKeys.size > 0) {
                    const firstCmd: string = keptInner[0]?.command || '';
                    const sm = firstCmd.match(/\/hooks\/([A-Za-z0-9_/-]+\.(?:py|cjs|mjs|js))/);
                    const script = sm?.[1];

                    if (script && canonicalScripts.has(script)) {
                        const validKeys = canonicalWiringKeys.get(script);
                        const wiringKey = `${event}:::${(wrapper.matcher as string | undefined) ?? 'NONE'}`;
                        if (validKeys && !validKeys.has(wiringKey)) {
                            removed.push(`${event}:${script} (stale wiring)`);
                            modified = true;
                            continue; // drop this wrapper
                        }
                    }
                }

                if (wrapper.hooks) {
                    keptWrappers.push({ ...wrapper, hooks: keptInner });
                } else if (keptInner.length === 1) {
                    keptWrappers.push(keptInner[0]);
                }
            }
        }

        if (keptWrappers.length > 0) {
            settings.hooks[event] = keptWrappers;
        } else {
            delete settings.hooks[event];
            modified = true;
        }
    }

    if (modified && !dryRun) {
        await fs.writeJson(settingsPath, settings, { spaces: 2 });
    }

    return removed;
}

export function createCleanCommand(): Command {
    return new Command('clean')
        .description('Remove orphaned hooks and skills not in the canonical repository')
        .option('--dry-run', 'Preview what would be removed without making changes', false)
        .option('--hooks-only', 'Only clean hooks, skip skills', false)
        .option('--skills-only', 'Only clean skills, skip hooks', false)
        .option('-y, --yes', 'Skip confirmation prompt', false)
        .action(async (opts) => {
            const { dryRun, hooksOnly, skillsOnly, yes } = opts;

            console.log(t.bold('\n  XTRM Clean — Remove Orphaned Components\n'));

            if (dryRun) {
                console.log(kleur.yellow('  DRY RUN — No changes will be made\n'));
            }

            if (!dryRun) {
                const confirmed = await confirmDestructiveAction({
                    yes,
                    message: 'Remove orphaned hooks/skills and stale hook wiring entries?',
                    initial: false,
                });
                if (!confirmed) {
                    console.log(kleur.dim('  Cancelled\n'));
                    return;
                }
            }

            const result: CleanResult = {
                hooksRemoved: [],
                skillsRemoved: [],
                cacheRemoved: [],
            };

            // Clean hooks
            if (!skillsOnly) {
                console.log(kleur.bold('  Scanning ~/.claude/hooks/...'));
                const { removed, cache } = await cleanHooks(dryRun);
                result.hooksRemoved = removed;
                result.cacheRemoved = cache;

                if (removed.length > 0) {
                    for (const f of removed) {
                        console.log(kleur.red(`    ✗ ${f}`));
                    }
                } else {
                    console.log(kleur.dim('    ✓ No orphaned hooks found'));
                }

                if (cache.length > 0) {
                    console.log(kleur.dim(`    ↳ Cleaned ${cache.length} cache directory(ies)`));
                }

                // Clean orphaned hook entries in settings.json
                console.log(kleur.bold('\n  Scanning settings.json for orphaned hook entries...'));
                let repoRoot: string | null = null;
                try { repoRoot = await findRepoRoot(); } catch { /* not in repo context */ }
                const orphanedEntries = await cleanOrphanedHookEntries(dryRun, repoRoot);
                if (orphanedEntries.length > 0) {
                    for (const entry of orphanedEntries) {
                        console.log(kleur.red(`    ✗ ${entry}`));
                    }
                } else {
                    console.log(kleur.dim('    ✓ No orphaned hook entries found'));
                }
            }

            // Clean skills
            if (!hooksOnly) {
                console.log(kleur.bold('\n  Scanning ~/.xtrm/skills/active and deprecated ~/.agents/skills/...'));
                result.skillsRemoved = await cleanSkills(dryRun);

                if (result.skillsRemoved.length > 0) {
                    for (const d of result.skillsRemoved) {
                        console.log(kleur.red(`    ✗ ${d}/`));
                    }
                } else {
                    console.log(kleur.dim('    ✓ No orphaned skills found'));
                }
            }

            // Summary
            const totalRemoved = result.hooksRemoved.length + result.skillsRemoved.length + result.cacheRemoved.length;

            if (totalRemoved === 0) {
                console.log(t.boldGreen('\n  ✓ All components are canonical — nothing to clean\n'));
                return;
            }

            console.log(kleur.bold('\n  Summary:'));
            if (result.hooksRemoved.length > 0) {
                console.log(kleur.red(`    ${result.hooksRemoved.length} orphaned hook(s)`));
            }
            if (result.skillsRemoved.length > 0) {
                console.log(kleur.red(`    ${result.skillsRemoved.length} orphaned skill(s)`));
            }
            if (result.cacheRemoved.length > 0) {
                console.log(kleur.dim(`    ${result.cacheRemoved.length} cache director(y/ies)`));
            }

            if (!dryRun) {
                console.log(t.boldGreen('\n  ✓ Cleanup complete\n'));
                console.log(kleur.dim('  Run `xtrm install all -y` to reinstall canonical components\n'));
            } else {
                console.log(kleur.yellow('\n  ℹ Dry run — run without --dry-run to apply changes\n'));
            }
        });
}