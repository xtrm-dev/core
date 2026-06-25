import kleur from 'kleur';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { t } from '../utils/theme.js';

declare const __dirname: string;

/**
 * Hook-command path prefix for per-project settings.json. Claude Code expands
 * $CLAUDE_PROJECT_DIR to the project root at runtime, so committed settings.json stays
 * portable across machines and checkout locations. Do NOT replace with an absolute path:
 * a baked-in absolute path breaks hooks for every other developer who pulls the repo.
 */
const PROJECT_HOOKS_DIR_REF = '$CLAUDE_PROJECT_DIR/.xtrm/hooks';

interface NativeHooksConfig {
    hooks: Record<string, HookWrapper[]>;
    statusLine?: {
        script?: string;
    };
}

interface CommandHook {
    type: 'command';
    command: string;
    timeout?: number;
}

interface HookWrapper {
    matcher?: string;
    hooks: CommandHook[];
}

interface ClaudeSettings {
    permissions?: {
        allow?: string[];
        defaultMode?: string;
    };
    model?: string;
    skillSuggestions?: {
        enabled?: boolean;
    };
    hooks?: Record<string, HookWrapper[]>;
    statusLine?: {
        type: 'command';
        command: string;
    };
    [key: string]: unknown;
}

export interface ClaudeRuntimeSyncOptions {
    repoRoot: string;
    dryRun?: boolean;
    isGlobal?: boolean;
    prune?: boolean;
}

export interface ClaudeRuntimeSyncResult {
    settingsPath: string;
    hooksEventsWritten: number;
    hooksEntriesWritten: number;
    wroteSettings: boolean;
}

export function renderClaudeRuntimePlanSummary(): void {
    console.log(kleur.bold('\n  Claude Runtime Sync'));
    console.log(`${kleur.cyan('  •')}  read canonical hooks: .xtrm/config/hooks.json`);
    console.log(`${kleur.cyan('  •')}  resolve project hooks dir: <project>/.xtrm/hooks`);
    console.log(`${kleur.cyan('  •')}  write generated hooks into Claude settings.json`);
    console.log(`${kleur.cyan('  •')}  preserve existing settings (permissions/model/skillSuggestions)`);
}

export async function runClaudeRuntimeSyncPhase(opts: ClaudeRuntimeSyncOptions): Promise<ClaudeRuntimeSyncResult> {
    const { repoRoot, dryRun = false, isGlobal = false, prune = false } = opts;

    console.log(t.bold('\n  ⚙  xtrm-tools  (Claude hooks wiring)'));
    warnIfOutdated();

    const packageRoot = await resolvePackageRoot();
    const hooksConfigPath = path.join(packageRoot, '.xtrm', 'config', 'hooks.json');
    const settingsTemplatePath = path.join(packageRoot, '.xtrm', 'config', 'settings.json');

    const hooksConfig = await fs.readJson(hooksConfigPath) as NativeHooksConfig;
    // Per-project settings.json must reference $CLAUDE_PROJECT_DIR so the generated file
    // is portable: it is committed and shared across machines/checkout locations, and an
    // absolute path baked in here breaks every other developer's hooks. Only the global
    // (~/.claude/settings.json) install keeps an absolute path, since it is per-machine.
    const projectHooksDir = isGlobal
        ? path.join(repoRoot, '.xtrm', 'hooks')
        : PROJECT_HOOKS_DIR_REF;
    const generatedHooks = resolveHooksForProjectRuntime(hooksConfig.hooks ?? {}, projectHooksDir);
    const generatedStatusLine = resolveStatusLineForProjectRuntime(hooksConfig.statusLine, projectHooksDir);

    const settingsPath = isGlobal
        ? path.join(os.homedir(), '.claude', 'settings.json')
        : path.join(repoRoot, '.claude', 'settings.json');

    const hasExistingSettings = await fs.pathExists(settingsPath);
    const baseSettings = await readBaseSettings(settingsTemplatePath);
    const existingSettings = hasExistingSettings ? await readSettings(settingsPath) : {};

    const mergedSettings: ClaudeSettings = hasExistingSettings
        ? { ...existingSettings, hooks: generatedHooks }
        : { ...baseSettings, hooks: generatedHooks };

    if (generatedStatusLine) {
        mergedSettings.statusLine = generatedStatusLine;
    }

    if (prune) {
        delete mergedSettings.enabledPlugins;
        delete mergedSettings.extraKnownMarketplaces;
    }

    const hooksEventsWritten = Object.keys(generatedHooks).length;
    const hooksEntriesWritten = countHookEntries(generatedHooks);

    console.log(t.label(`  • hooks source: ${hooksConfigPath}`));

    console.log(t.label(`  • target settings: ${settingsPath}`));

    if (hasExistingSettings) {
        console.log(t.muted('  ↻ Existing settings found; merging and replacing only hooks section'));
        if (Array.isArray(existingSettings.permissions?.allow)) {
            console.log(t.muted(`  ↻ Preserved permissions.allow (${existingSettings.permissions.allow.length} entries)`));
        }
        if (typeof existingSettings.model === 'string') {
            console.log(t.muted(`  ↻ Preserved model (${existingSettings.model})`));
        }
        if (typeof existingSettings.skillSuggestions?.enabled === 'boolean') {
            console.log(t.muted(`  ↻ Preserved skillSuggestions.enabled (${existingSettings.skillSuggestions.enabled})`));
        }
    } else {
        console.log(t.muted('  ↻ No existing settings found; creating with template defaults + generated hooks'));
    }

    if (dryRun) {
        console.log(kleur.dim(`  [DRY RUN] Would write ${hooksEntriesWritten} hook commands across ${hooksEventsWritten} events`));
        console.log(kleur.dim('  [DRY RUN] Hooks section would be replaced entirely'));
        if (prune) {
            console.log(kleur.dim('  [DRY RUN] Plugin-era settings keys would be removed (enabledPlugins, extraKnownMarketplaces)'));
        }
        console.log('');
        return {
            settingsPath,
            hooksEventsWritten,
            hooksEntriesWritten,
            wroteSettings: false,
        };
    }

    await fs.ensureDir(path.dirname(settingsPath));
    await fs.writeJson(settingsPath, mergedSettings, { spaces: 2 });

    console.log(t.success(`  ✓ Wrote ${hooksEntriesWritten} hook commands across ${hooksEventsWritten} events`));
    if (prune) {
        console.log(t.success('  ✓ Removed plugin-era settings keys (enabledPlugins, extraKnownMarketplaces)'));
    }
    console.log(t.success('  ✓ Claude settings hooks synced\n'));

    await ensureGlobalStatusLine();

    return {
        settingsPath,
        hooksEventsWritten,
        hooksEntriesWritten,
        wroteSettings: true,
    };
}

export interface ReconcileProjectHooksResult {
    settingsPath: string;
    changed: boolean;
    hooksEntries: number;
}

/**
 * Reconcile a project's .claude/settings.json hooks section against the canonical
 * .xtrm/config/hooks.json, idempotently.
 *
 * `xt update --apply` copies the canonical hooks.json into the consumer's .xtrm but
 * skips the heavy claude-runtime-sync phase, so newly-added xtrm-managed hooks (e.g.
 * the service-skills SessionStart/PreToolUse/PostToolUse hooks shipped in 0.8.2) never
 * reach the consumer's settings.json and stay dormant (xtrm-0p7bp). This focused
 * reconciler wires them on every apply: it preserves all non-hook settings keys
 * (permissions/model/skillSuggestions/etc.), is a quiet no-op when the wired hooks
 * already match canonical, and does NOT perform the npm-version check or global
 * statusLine side effects that runClaudeRuntimeSyncPhase does — so it is cheap to run
 * per-repo across a fleet update.
 */
export async function reconcileProjectClaudeHooks(
    repoRoot: string,
    opts: { dryRun?: boolean } = {},
): Promise<ReconcileProjectHooksResult> {
    const { dryRun = false } = opts;
    const packageRoot = await resolvePackageRoot();
    const hooksConfigPath = path.join(packageRoot, '.xtrm', 'config', 'hooks.json');
    const settingsTemplatePath = path.join(packageRoot, '.xtrm', 'config', 'settings.json');
    // repoRoot is the xt-managed project root; segments are literals — not user-controlled.
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json'); // nosemgrep

    const hooksConfig = await fs.readJson(hooksConfigPath) as NativeHooksConfig;
    // Always per-project (xt update --apply across a fleet): reference $CLAUDE_PROJECT_DIR
    // so the reconciled settings.json stays portable across machines and checkouts.
    const projectHooksDir = PROJECT_HOOKS_DIR_REF;
    const generatedHooks = resolveHooksForProjectRuntime(hooksConfig.hooks ?? {}, projectHooksDir);
    const generatedStatusLine = resolveStatusLineForProjectRuntime(hooksConfig.statusLine, projectHooksDir);
    const hooksEntries = countHookEntries(generatedHooks);

    const hasExistingSettings = await fs.pathExists(settingsPath);
    const existingSettings = hasExistingSettings ? await readSettings(settingsPath) : {};
    const baseSettings = hasExistingSettings ? existingSettings : await readBaseSettings(settingsTemplatePath);

    // Idempotency: skip the write entirely when the wired hooks already match canonical.
    const hooksAlreadyCurrent = hasExistingSettings
        && JSON.stringify(existingSettings.hooks ?? {}) === JSON.stringify(generatedHooks);
    if (hooksAlreadyCurrent) {
        return { settingsPath, changed: false, hooksEntries };
    }

    if (dryRun) {
        return { settingsPath, changed: true, hooksEntries };
    }

    const mergedSettings: ClaudeSettings = { ...baseSettings, hooks: generatedHooks };
    if (generatedStatusLine && !mergedSettings.statusLine) {
        mergedSettings.statusLine = generatedStatusLine;
    }

    await fs.ensureDir(path.dirname(settingsPath));
    await fs.writeJson(settingsPath, mergedSettings, { spaces: 2 });

    return { settingsPath, changed: true, hooksEntries };
}

/**
 * Wire ~/.xtrm/hooks/statusline.mjs into ~/.claude/settings.json as the statusLine command.
 * Runs on every Claude runtime sync (global and project-level) to keep the global setting current.
 */
async function ensureGlobalStatusLine(): Promise<void> {
    const homeDir = os.homedir();
    const statuslineHookPath = path.join(homeDir, '.xtrm', 'hooks', 'statusline.mjs');
    const globalSettingsPath = path.join(homeDir, '.claude', 'settings.json');

    if (!await fs.pathExists(statuslineHookPath)) {
        return;
    }

    const expectedCommand = `node "${statuslineHookPath}"`;
    const settings = await readSettings(globalSettingsPath);
    const currentCommand = (settings.statusLine as { command?: string } | undefined)?.command;

    if (currentCommand === expectedCommand) {
        return;
    }

    settings.statusLine = { type: 'command', command: expectedCommand };
    await fs.ensureDir(path.dirname(globalSettingsPath));
    await fs.writeJson(globalSettingsPath, settings, { spaces: 2 });
    console.log(t.success(`  ✓ Wired statusline → ~/.xtrm/hooks/statusline.mjs`));
}


function resolveHooksForProjectRuntime(hooks: Record<string, HookWrapper[]>, projectHooksDir: string): Record<string, HookWrapper[]> {
    const normalizedHooksDir = normalizeHookCommandPath(projectHooksDir);
    const rewrittenHooks: Record<string, HookWrapper[]> = {};

    for (const [eventName, wrappers] of Object.entries(hooks)) {
        const wrapperList = Array.isArray(wrappers) ? wrappers : [wrappers as HookWrapper];
        rewrittenHooks[eventName] = wrapperList.map(wrapper => ({
            ...wrapper,
            hooks: wrapper.hooks.map(hook => {
                if (hook.type !== 'command') {
                    return hook;
                }
                return {
                    ...hook,
                    command: rewritePluginRootCommandToProjectHookPath(hook.command, normalizedHooksDir),
                };
            }),
        }));
    }

    return rewrittenHooks;
}

function resolveStatusLineForProjectRuntime(statusLineConfig: NativeHooksConfig['statusLine'], projectHooksDir: string): ClaudeSettings['statusLine'] | undefined {
    if (!statusLineConfig?.script) {
        return undefined;
    }

    const normalizedHooksDir = normalizeHookCommandPath(projectHooksDir);
    const resolvedScriptPath = resolveStatusLineScriptPath(statusLineConfig.script, normalizedHooksDir);

    return {
        type: 'command',
        command: buildScriptCommand(statusLineConfig.script, resolvedScriptPath),
    };
}

function resolveStatusLineScriptPath(script: string, normalizedHooksDir: string): string {
    const pluginRootPattern = /^(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT)\/hooks\/(.+)$/;
    const pluginRootMatch = script.match(pluginRootPattern);
    if (pluginRootMatch?.[1]) {
        return normalizeHookCommandPath(path.join(normalizedHooksDir, pluginRootMatch[1]));
    }

    return normalizeHookCommandPath(path.join(normalizedHooksDir, script));
}

function buildScriptCommand(scriptName: string, resolvedPath: string): string {
    const ext = path.extname(scriptName).toLowerCase();
    if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
        return `node "${resolvedPath}"`;
    }
    if (ext === '.sh') {
        return `bash "${resolvedPath}"`;
    }

    const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
    return `${pythonBin} "${resolvedPath}"`;
}

function rewritePluginRootCommandToProjectHookPath(command: string, normalizedHooksDir: string): string {
    const pluginRootPatterns = [
        /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^\s"']+)/g,
        /\$CLAUDE_PLUGIN_ROOT\/hooks\/([^\s"']+)/g,
    ];

    let rewrittenCommand = command;
    for (const pattern of pluginRootPatterns) {
        rewrittenCommand = rewrittenCommand.replace(pattern, (_match, relativePath: string) => {
            const normalizedRelativePath = relativePath.replace(/\\/g, '/');
            const absoluteHookPath = path.join(normalizedHooksDir, normalizedRelativePath);
            return `"${normalizeHookCommandPath(absoluteHookPath)}"`;
        });
    }

    return rewrittenCommand;
}

function normalizeHookCommandPath(targetPath: string): string {
    return targetPath.replace(/\\/g, '/');
}

function countHookEntries(hooks: Record<string, HookWrapper[]>): number {
    let count = 0;
    for (const wrappers of Object.values(hooks)) {
        count += wrappers.length;
    }
    return count;
}


async function readSettings(settingsPath: string): Promise<ClaudeSettings> {
    try {
        return await fs.readJson(settingsPath) as ClaudeSettings;
    } catch {
        return {};
    }
}

async function readBaseSettings(settingsTemplatePath: string): Promise<ClaudeSettings> {
    try {
        return await fs.readJson(settingsTemplatePath) as ClaudeSettings;
    } catch {
        return {
            permissions: {
                allow: [],
                defaultMode: 'default',
            },
            skillSuggestions: {
                enabled: true,
            },
        };
    }
}

async function resolvePackageRoot(): Promise<string> {
    const candidates = [
        path.resolve(__dirname, '../..'),
        path.resolve(__dirname, '../../..'),
    ];

    for (const candidate of candidates) {
        const hooksConfigPath = path.join(candidate, '.xtrm', 'config', 'hooks.json');
        if (await fs.pathExists(hooksConfigPath)) {
            return candidate;
        }
    }

    throw new Error('Failed to locate xtrm-tools package root (.xtrm/config/hooks.json not found).');
}

function warnIfOutdated(): void {
    try {
        const localPkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
        const result = spawnSync('npm', ['show', 'xtrm-tools', 'version', '--json'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 5000,
        });
        if (result.status !== 0 || !result.stdout) return;

        const npmVersion: string = JSON.parse(result.stdout.trim());
        const parse = (v: string) => v.split('.').map(Number);
        const [lMaj, lMin, lPat] = parse(localPkg.version);
        const [rMaj, rMin, rPat] = parse(npmVersion);
        const isNewer = rMaj > lMaj || (rMaj === lMaj && rMin > lMin) || (rMaj === lMaj && rMin === lMin && rPat > lPat);
        if (isNewer) {
            console.log(t.warning(`  ⚠  npm has a newer version (${npmVersion} > ${localPkg.version})`));
            console.log(t.label('     Run: npm install -g xtrm-tools@latest'));
        }
    } catch {
        // network failure or parse error — silently skip
    }
}
