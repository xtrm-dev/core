import path from 'path';
import fs from 'fs-extra';
import kleur from 'kleur';
import { safeMergeConfig } from '../utils/atomic-config.js';
import { ConfigAdapter } from '../utils/config-adapter.js';
import { syncMcpServersWithCli, loadCanonicalMcpConfig, detectAgent } from '../utils/sync-mcp-cli.js';
import { hashDirectory } from '../utils/hash.js';
import { createBackup, restoreBackup, cleanupBackup, type BackupInfo } from './rollback.js';
import type { ChangeSet } from '../types/config.js';

const LEGACY_BASH_ALLOWLISTS = new Set(['Bash(bd:*)', 'Bash(git:*)']);
const SAFE_BD_BASH_ALLOWLIST = [
    'Bash(bd show:*)',
    'Bash(bd list:*)',
    'Bash(bd ready:*)',
    'Bash(bd stats:*)',
    'Bash(bd search:*)',
];
const SAFE_GIT_BASH_ALLOWLIST = [
    'Bash(git status:*)',
    'Bash(git log:*)',
    'Bash(git diff:*)',
    'Bash(git show:*)',
    'Bash(git fetch:*)',
];

async function normalizeLegacyBashAllowlist(settingsPath: string, isDryRun: boolean): Promise<boolean> {
    if (!(await fs.pathExists(settingsPath))) return false;

    const settings = await fs.readJson(settingsPath);
    const allow = settings?.permissions?.allow;
    if (!Array.isArray(allow)) return false;

    const hasLegacy = allow.some((entry: unknown) =>
        typeof entry === 'string' && LEGACY_BASH_ALLOWLISTS.has(entry),
    );
    if (!hasLegacy) return false;

    const filteredAllow = allow.filter((entry: unknown) =>
        !(typeof entry === 'string' && LEGACY_BASH_ALLOWLISTS.has(entry)),
    );

    const safeEntries = [...SAFE_BD_BASH_ALLOWLIST, ...SAFE_GIT_BASH_ALLOWLIST];
    for (const entry of safeEntries) {
        if (!filteredAllow.includes(entry)) filteredAllow.push(entry);
    }

    if (isDryRun) {
        console.log(kleur.dim('      (Would replace legacy Bash(bd:*)/Bash(git:*) allowlist entries)'));
        return true;
    }

    settings.permissions.allow = filteredAllow;
    await fs.writeJson(settingsPath, settings, { spaces: 2 });
    console.log(kleur.dim('      (Replaced legacy Bash(bd:*)/Bash(git:*) allowlist entries)'));
    return true;
}

/**
 * Sync MCP servers for a list of targets, once per unique agent type.
 * Call this explicitly before per-target file sync loops.
 */
export async function syncMcpForTargets(
    repoRoot: string,
    targets: string[],
    isDryRun: boolean = false,
    selectedMcpServers?: string[],
): Promise<number> {
    const synced = new Set<string>();
    let count = 0;

    for (const target of targets) {
        const agent = detectAgent(target);
        if (!agent || synced.has(agent)) continue;

        const coreConfig = loadCanonicalMcpConfig(repoRoot);
        const mcpToSync: any = { mcpServers: { ...coreConfig.mcpServers } };

        if (selectedMcpServers && selectedMcpServers.length > 0) {
            const optionalConfig = loadCanonicalMcpConfig(repoRoot, true);
            for (const name of selectedMcpServers) {
                if (optionalConfig.mcpServers[name]) {
                    mcpToSync.mcpServers[name] = optionalConfig.mcpServers[name];
                }
            }
        }

        if (!isDryRun) {
            await syncMcpServersWithCli(agent, mcpToSync, isDryRun, false);
        } else {
            console.log(kleur.cyan(`  [DRY RUN] MCP sync for ${agent}`));
        }
        synced.add(agent);
        count++;
    }

    return count;
}

/**
 * Execute a sync plan based on changeset and mode
 */

function extractHookCommandPath(command: string): string | null {
    const quoted = command.match(/"([^"]+)"/);
    if (quoted?.[1]) return quoted[1];

    const singleQuoted = command.match(/'([^']+)'/);
    if (singleQuoted?.[1]) return singleQuoted[1];

    const bare = command.trim().split(/\s+/).slice(1).join(' ').trim();
    return bare || null;
}

async function filterHooksByInstalledScripts(hooksConfig: any): Promise<any> {
    if (!hooksConfig || typeof hooksConfig !== 'object' || !hooksConfig.hooks) {
        return hooksConfig;
    }

    for (const [event, wrappers] of Object.entries(hooksConfig.hooks)) {
        if (!Array.isArray(wrappers)) continue;

        const keptWrappers: any[] = [];
        for (const wrapper of wrappers) {
            if (!wrapper || !Array.isArray(wrapper.hooks)) continue;

            const keptInner: any[] = [];
            for (const inner of wrapper.hooks) {
                const command = inner?.command;
                if (typeof command !== 'string' || !command.trim()) continue;

                const scriptPath = extractHookCommandPath(command);
                if (!scriptPath) continue;

                if (await fs.pathExists(scriptPath)) {
                    keptInner.push(inner);
                }
            }

            if (keptInner.length > 0) {
                keptWrappers.push({ ...wrapper, hooks: keptInner });
            }
        }

        hooksConfig.hooks[event] = keptWrappers;
    }

    return hooksConfig;
}

export async function executeSync(
    repoRoot: string,
    systemRoot: string,
    changeSet: ChangeSet,
    mode: 'copy' | 'symlink' | 'prune',
    actionType: 'sync' | 'backport',
    isDryRun: boolean = false,
    options?: { force?: boolean },
): Promise<number> {
    const categories: Array<keyof ChangeSet> = ['skills', 'hooks', 'config'];

    let count = 0;
    const adapter = new ConfigAdapter(systemRoot);
    const backups: BackupInfo[] = [];
    const newHashes: Record<string, string> = {};

    try {

        for (const category of categories) {
            const itemsToProcess: string[] = [];

            if (actionType === 'sync') {
                const cat = changeSet[category] as any;
                itemsToProcess.push(...cat.missing);
                itemsToProcess.push(...cat.outdated);

                if (options?.force) {
                    itemsToProcess.push(...cat.drifted);
                }

                if (mode === 'prune') {
                    for (const itemToDelete of cat.drifted || []) {
                        const dest = path.join(systemRoot, category, itemToDelete);
                        console.log(kleur.red(`  [x] PRUNING ${category}/${itemToDelete}`));
                        if (!isDryRun) {
                            if (await fs.pathExists(dest)) {
                                backups.push(await createBackup(dest));
                                await fs.remove(dest);
                            }
                        }
                        count++;
                    }
                }
            } else if (actionType === 'backport') {
                const cat = changeSet[category] as any;
                itemsToProcess.push(...cat.drifted);
            }

            for (const item of itemsToProcess) {
                let src: string, dest: string;

                if (category === 'config' && item === 'settings.json' && actionType === 'sync') {
                    src = path.join(repoRoot, 'config', 'settings.json');
                    dest = path.join(systemRoot, 'settings.json');

                    console.log(kleur.gray(`  --> config/settings.json`));

                    if (!isDryRun && await fs.pathExists(dest)) {
                        backups.push(await createBackup(dest));
                    }

                    const repoConfig = await fs.readJson(src);
                    let finalRepoConfig = resolveConfigPaths(repoConfig, systemRoot);

                    const hooksSrc = path.join(repoRoot, 'config', 'hooks.json');
                    if (await fs.pathExists(hooksSrc)) {
                        const hooksRaw = await fs.readJson(hooksSrc);
                        const hooksAdapted = await filterHooksByInstalledScripts(adapter.adaptHooksConfig(hooksRaw));
                        if (hooksAdapted.hooks) {
                            // hooks.json is the canonical source — replace template hooks entirely
                            // hooks.json is canonical source — replace template hooks entirely
                            finalRepoConfig.hooks = hooksAdapted.hooks;
                            if (!isDryRun) console.log(kleur.dim(`      (Injected hooks)`));
                        }
                        if (hooksAdapted.statusLine) {
                            finalRepoConfig.statusLine = hooksAdapted.statusLine;
                        }
                    }

                    if (fs.existsSync(dest)) {
                        const localConfig = await fs.readJson(dest);
                        const resolvedLocalConfig = resolveConfigPaths(localConfig, systemRoot);

                        if (mode === 'prune') {
                            if (localConfig.mcpServers && finalRepoConfig.mcpServers) {
                                const canonicalServers = new Set(Object.keys(finalRepoConfig.mcpServers));
                                for (const serverName of Object.keys(localConfig.mcpServers)) {
                                    if (!canonicalServers.has(serverName)) {
                                        delete localConfig.mcpServers[serverName];
                                        if (!isDryRun) console.log(kleur.red(`      (Pruned local MCP server: ${serverName})`));
                                    }
                                }
                            }
                        }

                        if (mode === 'prune' && !isDryRun) {
                            console.log(kleur.dim(`      (--prune: replacing canonical hook events wholesale)`));
                        }

                        const mergeResult = await safeMergeConfig(dest, finalRepoConfig, {
                            backupOnSuccess: false,
                            preserveComments: true,
                            dryRun: isDryRun,
                            resolvedLocalConfig: resolvedLocalConfig,
                            pruneHooks: mode === 'prune',
                        });

                        if (mergeResult.updated) {
                            console.log(kleur.blue(`      (Configuration safely merged)`));
                        }

                        await normalizeLegacyBashAllowlist(dest, isDryRun);
                    } else {
                        if (!isDryRun) {
                            await fs.ensureDir(path.dirname(dest));
                            await fs.writeJson(dest, finalRepoConfig, { spaces: 2 });
                        }
                        console.log(kleur.green(`      (Created new configuration)`));
                    }
                    count++;
                    continue;
                }

                const repoPath = path.join(repoRoot, category);
                const systemPath = path.join(systemRoot, category);

                if (actionType === 'backport') {
                    src = path.join(systemPath, item);
                    dest = path.join(repoPath, item);
                } else {
                    src = path.join(repoPath, item);
                    dest = path.join(systemPath, item);
                }

                console.log(kleur.gray(`  ${actionType === 'backport' ? '<--' : '-->'} ${category}/${item}`));

                if (!isDryRun && actionType === 'sync' && await fs.pathExists(dest)) {
                    backups.push(await createBackup(dest));
                }

                if (mode === 'symlink' && actionType === 'sync' && category !== 'config') {
                    if (!isDryRun) {
                        if (process.platform === 'win32') {
                            console.log(kleur.yellow('  ⚠ Symlinks require Developer Mode on Windows — falling back to copy.'));
                            await fs.remove(dest);
                            await fs.copy(src, dest);
                        } else {
                            await fs.remove(dest);
                            await fs.ensureSymlink(src, dest);
                        }
                    }
                } else {
                    if (!isDryRun) {
                        await fs.remove(dest);
                        await fs.copy(src, dest);
                    }
                }

                // Record repo hash so future drift checks can distinguish
                // "user modified" from "repo updated" without relying on mtime
                if (!isDryRun && actionType === 'sync') {
                    newHashes[`${category}/${item}`] = await hashDirectory(src);
                }

                count++;
            }
        }

        if (!isDryRun && actionType === 'sync') {
            const manifestPath = path.join(systemRoot, '.jaggers-sync-manifest.json');
            const existing = await fs.pathExists(manifestPath)
                ? await fs.readJson(manifestPath)
                : {};
            await fs.writeJson(manifestPath, {
                ...existing,
                lastSync: new Date().toISOString(),
                repoRoot,
                items: count,
                fileHashes: { ...(existing.fileHashes ?? {}), ...newHashes },
            }, { spaces: 2 });
        }

        for (const backup of backups) {
            await cleanupBackup(backup);
        }

        return count;

    } catch (error: any) {
        console.error(kleur.red(`\nSync failed, rolling back ${backups.length} changes...`));
        for (const backup of backups) {
            try {
                await restoreBackup(backup);
            } finally {
                await cleanupBackup(backup);
            }
        }
        throw error;
    }
}



function resolveConfigPaths(config: any, targetDir: string): any {
    const newConfig = JSON.parse(JSON.stringify(config));

    function recursiveReplace(obj: any) {
        for (const key in obj) {
            if (typeof obj[key] === 'string') {
                let val = obj[key];
                // Resolve $HOME and ~ to actual home directory for comparison
                // but only match absolute paths, not env-var paths like "$HOME/..."
                if (!val.startsWith('$') && !val.startsWith('~')) {
                    if (val.match(/\/[^\s"']+\/hooks\//)) {
                        const hooksDir = path.join(targetDir, 'hooks');
                        let replacementDir = `${hooksDir}/`;
                        if (process.platform === 'win32') {
                            replacementDir = replacementDir.replace(/\\/g, '/');
                        }
                        obj[key] = val.replace(/(\/[^\s"']+\/hooks\/)/g, replacementDir);
                    }
                }
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                recursiveReplace(obj[key]);
            }
        }
    }

    recursiveReplace(newConfig);
    return newConfig;
}
