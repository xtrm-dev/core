import crypto from 'node:crypto';
import kleur from 'kleur';
import fs from 'fs-extra';
import fsSync from 'node:fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { t } from '../utils/theme.js';
import { appendHookLog, hashValue, resolveGlobalHooksConfigPath, resolveGlobalHooksRoot } from './global-hooks-bootstrap.js';
import { shouldUseGlobalHooks } from './global-hooks-flag.js';
import { filterGloballyCoveredHooks, planLegacyHookDedupe } from './legacy-hook-dedupe.js';
import { writeJsonAtomic } from '../utils/atomic-write.js';

declare const __dirname: string;

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
    _source?: string;
    _xtrm?: HookOwnershipMetadata;
}

interface HookOwnershipMetadata {
    version: string;
    hash: string;
}

interface HookWrapper {
    matcher?: string;
    hooks: CommandHook[];
    _source?: string;
    _xtrm?: HookOwnershipMetadata;
}

export interface HookRuntimeSettingsShape {
    hooks?: Record<string, HookWrapper[]>;
    statusLine?: {
        type: 'command';
        command: string;
    };
    [key: string]: unknown;
}

interface ClaudeSettings extends HookRuntimeSettingsShape {
    permissions?: {
        allow?: string[];
        defaultMode?: string;
    };
    model?: string;
    skillSuggestions?: {
        enabled?: boolean;
    };
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

export interface ReconcileProjectHooksResult {
    settingsPath: string;
    changed: boolean;
    hooksEntries: number;
    /** Generated registrations skipped at project scope (already covered globally). */
    skippedGloballyCovered?: number;
}

export interface ReconcileGlobalClaudeHooksResult {
    settingsPath: string;
    changed: boolean;
    hooksEntries: number;
}

interface SafeMergeResult {
    readonly settings: HookRuntimeSettingsShape;
    readonly changed: boolean;
    readonly hooksEntries: number;
    /** Untagged wrappers dropped because every command targets a retired ~/.xtrm/hooks file. */
    readonly retiredRemoved: readonly RetiredHookRemoval[];
}

export interface RetiredHookRemoval {
    readonly event: string;
    readonly command: string;
}

const XTRM_GLOBAL_SOURCE = 'xtrm-global';

// XTRM-602: hook files that xt once registered as standalone hooks and has
// since folded into dispatch.mjs or removed. Older installs left untagged
// (no _source) wrappers for these in settings.json; they survive the owned-hook
// merge as foreign entries and make the event spawn a second process. An
// untagged wrapper is dropped only when every command in it resolves under
// ~/.xtrm/hooks to a file on this list. Never match by name alone, and never
// add a file here without the commit that retired its registration.
// XTRM-606: bare `bd` command hooks (for example the bulk `prime`
// diagnostic) are NOT listed here. A repo-wide history search found no commit
// whose code registers a bare bd command in settings.json — only docs prose,
// the installer next-steps print and the Bash permission allowlist ever
// referenced it — so bare bd entries are foreign residue and stay (the
// runtime-sync global-guard test asserts exactly that).
const RETIRED_HOOK_FILES: ReadonlySet<string> = new Set([
    // Registered by 617a74fe (#525); folded into dispatch.mjs event by 93c90513 (XTRM-592, #683).
    'inbox-reminder-stop.mjs',
    // Registered by 7196cdc7 (XTRM-569); folded into dispatch.mjs by 93c90513 (XTRM-592, #683).
    'agent-host-reporter.mjs',
    // Registered by 8ded3f2b (#17); every canonical registration removed by f949b33f (xtrm-6qu.8).
    'beads-stop-gate.mjs',
    // Registered by d6eb19db (#41) on Stop; retired with the bd-memory stack by 959c7718 (#639).
    'beads-memory-gate.mjs',
    // Registered by 8ded3f2b (#17); replaced by the beads-memory-gate Stop hook by d6eb19db (#41).
    'beads-close-memory-prompt.mjs',
    // Registered by 8ded3f2b (#17); every canonical registration removed by f949b33f (xtrm-6qu.8).
    'beads-edit-gate.mjs',
    // Registered by 8ded3f2b (#17); every canonical registration removed by f949b33f (xtrm-6qu.8).
    'beads-commit-gate.mjs',
    // Registered by 6d89ac99 (#76); every canonical registration removed by f949b33f (xtrm-6qu.8).
    'beads-claim-sync.mjs',
    // Registered by 9a3ccad5 (#61); every canonical registration removed by f949b33f (xtrm-6qu.8).
    'beads-compact-save.mjs',
    // Registered by 9a3ccad5 (#61); every canonical registration removed by f949b33f (xtrm-6qu.8).
    'beads-compact-restore.mjs',
    // beads-gate-utils.mjs / beads-gate-core.mjs / beads-gate-messages.mjs and
    // beads-status-cache.mjs are intentionally absent: they shipped under
    // ~/.xtrm/hooks as shared payload modules but were never registered as hook
    // commands, so an untagged wrapper targeting one of them is not a known
    // residue shape.
]);

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

    if (isGlobal) {
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        if (shouldUseGlobalHooks()) {
            const hookResult = await reconcileGlobalClaudeHooks({ dryRun });
            return {
                settingsPath: hookResult.settingsPath,
                hooksEventsWritten: hookResult.changed ? 1 : 0,
                hooksEntriesWritten: hookResult.hooksEntries,
                wroteSettings: hookResult.changed,
            };
        }

        console.log(t.muted('  ↻ Global install: skipping hook sync (project .claude/settings.json owns hooks)'));
        console.log(t.label(`  • global settings preserved: ${settingsPath}`));
        // xtrm-tzzud item 2: ~/.claude/settings.json.statusLine is written on the
        // global path only. The project path below used to call this on every
        // exit, so a project-scoped `xt claude sync` mutated a global setting.
        // Global coverage is unchanged: the other global exit goes through
        // reconcileGlobalClaudeHooks, which calls it on both of its exits, and
        // init/install/update/bootstrap all invoke that separately.
        await ensureGlobalStatusLine();
        return {
            settingsPath,
            hooksEventsWritten: 0,
            hooksEntriesWritten: 0,
            wroteSettings: false,
        };
    }

    const packageRoot = await resolvePackageRoot();
    const hooksConfigPath = path.join(packageRoot, '.xtrm', 'config', 'hooks.json');
    const settingsTemplatePath = path.join(packageRoot, '.xtrm', 'config', 'settings.json');
    const hooksConfig = await fs.readJson(hooksConfigPath) as NativeHooksConfig;
    const projectHooksDir = path.join(repoRoot, '.xtrm', 'hooks');
    const generatedHooks = resolveHooksForProjectRuntime(hooksConfig.hooks ?? {}, projectHooksDir);
    const generatedStatusLine = resolveStatusLineForProjectRuntime(hooksConfig.statusLine, projectHooksDir);
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');

    const hasExistingSettings = await fs.pathExists(settingsPath);
    const baseSettings = await readBaseSettings(settingsTemplatePath);
    const existingSettings = hasExistingSettings ? await readSettings(settingsPath) : {};
    // Global-only hooks direction: never (re-)write a registration the global
    // install already covers — a project copy would fire twice (fatal for the
    // stateful beads gates). Same guard as reconcileProjectClaudeHooks; fail-open
    // without a readable global baseline. Pre-existing residue is cured on the
    // reconcile path by planLegacyHookDedupe.
    const coverage = await filterGloballyCoveredHooks(repoRoot, generatedHooks);
    for (const skip of coverage.skipped) {
        console.log(t.muted(`  ↻ hook covered globally, skipped at project scope: ${skip.event} ${skip.command.slice(0, 80)}`));
        if (skip.drift) console.log(t.muted(`    ↳ ${skip.drift}`));
    }
    // xtrm-61cdl: preserve third-party (unmanaged) wrappers on merge instead of
    // wholesale-replacing the project settings.json hooks map. Applies to both
    // shouldUseGlobalHooks() branches — the mode toggle only affects which paths
    // get rewritten, not whether we clobber user hooks.
    const filteredHooks = mergeProjectOwnedHooks(existingSettings.hooks ?? {}, coverage.hooks, projectHooksDir);

    const mergedSettings: ClaudeSettings = hasExistingSettings
        ? { ...existingSettings, hooks: filteredHooks }
        : { ...baseSettings, hooks: filteredHooks };

    if (generatedStatusLine) {
        mergedSettings.statusLine = generatedStatusLine;
    }

    if (prune) {
        delete mergedSettings.enabledPlugins;
        delete mergedSettings.extraKnownMarketplaces;
    }

    const hooksEventsWritten = Object.keys(filteredHooks).length;
    const hooksEntriesWritten = countHookEntries(filteredHooks);

    if (dryRun) {
        return { settingsPath, hooksEventsWritten, hooksEntriesWritten, wroteSettings: false };
    }

    const existingSerialized = hasExistingSettings ? JSON.stringify(existingSettings) : '';
    const mergedSerialized = JSON.stringify(mergedSettings);
    if (existingSerialized === mergedSerialized) {
        return { settingsPath, hooksEventsWritten, hooksEntriesWritten, wroteSettings: false };
    }

    await writeJsonAtomic(settingsPath, mergedSettings);

    return { settingsPath, hooksEventsWritten, hooksEntriesWritten, wroteSettings: true };
}

export async function reconcileProjectClaudeHooks(
    repoRoot: string,
    opts: { dryRun?: boolean } = {},
): Promise<ReconcileProjectHooksResult> {
    const { dryRun = false } = opts;
    const packageRoot = await resolvePackageRoot();
    const hooksConfigPath = path.join(packageRoot, '.xtrm', 'config', 'hooks.json');
    const settingsTemplatePath = path.join(packageRoot, '.xtrm', 'config', 'settings.json');
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');

    const hooksConfig = await fs.readJson(hooksConfigPath) as NativeHooksConfig;
    const projectHooksDir = path.join(repoRoot, '.xtrm', 'hooks');
    const generatedHooks = resolveHooksForProjectRuntime(hooksConfig.hooks ?? {}, projectHooksDir);
    const generatedStatusLine = resolveStatusLineForProjectRuntime(hooksConfig.statusLine, projectHooksDir);
    // Global-only hooks direction: never (re-)write a registration the global
    // install already covers — a project copy would fire twice (fatal for the
    // stateful beads gates). Fail-open without a readable global baseline.
    // Pre-existing residue is still cured by planLegacyHookDedupe below.
    const coverage = await filterGloballyCoveredHooks(repoRoot, generatedHooks);
    for (const skip of coverage.skipped) {
        console.log(t.muted(`  ↻ hook covered globally, skipped at project scope: ${skip.event} ${skip.command.slice(0, 80)}`));
        if (skip.drift) console.log(t.muted(`    ↳ ${skip.drift}`));
    }
    const generatedHooksToWrite = coverage.hooks;
    const existingHooks = await readExistingHooks(settingsPath);
    // XTRM-602: mergeProjectOwnedHooks already drops every untagged .xtrm/hooks
    // wrapper at project scope; report the retired ones so the removal is visible.
    reportRetiredHookRemovals(findRetiredHookWrappers(existingHooks, path.resolve(os.homedir(), '.xtrm', 'hooks')), dryRun);
    // xtrm-61cdl: preserve third-party (unmanaged) wrappers on reconcile.
    const mergedHooks = mergeProjectOwnedHooks(existingHooks, generatedHooksToWrite, projectHooksDir);
    // xtrm-v1yck: drop registrations the global install already covers byte-for-byte.
    // Fail-open — without a readable global baseline nothing is provably redundant.
    const dedupe = await planLegacyHookDedupe(repoRoot, mergedHooks);
    if (dedupe.skipped) {
        console.log(t.muted(`  ↻ hook dedupe skipped: ${dedupe.skipped}`));
    } else if (dedupe.planned.length > 0) {
        console.log(t.label(`  • removed ${dedupe.planned.length} hook registration(s) already covered globally`));
    }
    const hooksToWrite = dedupe.hooks;
    const hooksEntries = countHookEntries(hooksToWrite);
    const skippedGloballyCovered = coverage.skipped.length;

    const hasExistingSettings = await fs.pathExists(settingsPath);
    const existingSettings = hasExistingSettings ? await readSettings(settingsPath) : {};
    const baseSettings = hasExistingSettings ? existingSettings : await readBaseSettings(settingsTemplatePath);
    const nextSettings: ClaudeSettings = { ...baseSettings, hooks: hooksToWrite };
    if (generatedStatusLine && !nextSettings.statusLine) {
        nextSettings.statusLine = generatedStatusLine;
    }

    if (JSON.stringify(existingSettings) === JSON.stringify(nextSettings)) {
        return { settingsPath, changed: false, hooksEntries, skippedGloballyCovered };
    }

    if (dryRun) {
        return { settingsPath, changed: true, hooksEntries, skippedGloballyCovered };
    }

    await writeJsonAtomic(settingsPath, nextSettings);
    return { settingsPath, changed: true, hooksEntries, skippedGloballyCovered };
}

export async function reconcileGlobalClaudeHooks(opts: { dryRun?: boolean } = {}): Promise<ReconcileGlobalClaudeHooksResult> {
    const { dryRun = false } = opts;
    const startedAt = Date.now();
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const hooksConfig = await readGlobalHooksConfig(resolveGlobalHooksConfigPath());
    const generatedHooks = resolveHooksForGlobalRuntime(hooksConfig.hooks ?? {}, resolveGlobalHooksRoot());

    await appendHookLog({
        timestamp: new Date().toISOString(),
        component: 'hooks-migration',
        event: 'hook.reconcile.start',
        source: hashValue(settingsPath),
        action: 'claude',
        outcome: 'ok',
        durationMs: 0,
    });

    const currentSettings = await readSettings(settingsPath);
    const mergeResult = await safeMergeOwnedHookSettings(currentSettings, generatedHooks, { dryRun });
    reportRetiredHookRemovals(mergeResult.retiredRemoved, dryRun);
    if (!mergeResult.changed) {
        await ensureGlobalStatusLine();
        await appendHookLog({
            timestamp: new Date().toISOString(),
            component: 'hooks-migration',
            event: 'hook.reconcile.ok',
            source: hashValue(settingsPath),
            action: 'claude',
            outcome: 'skipped',
            durationMs: Date.now() - startedAt,
        });
        return { settingsPath, changed: false, hooksEntries: mergeResult.hooksEntries };
    }

    if (!dryRun) {
        await writeJsonAtomic(settingsPath, mergeResult.settings);
    }

    await ensureGlobalStatusLine();
    await appendHookLog({
        timestamp: new Date().toISOString(),
        component: 'hooks-migration',
        event: 'hook.reconcile.ok',
        source: hashValue(settingsPath),
        action: 'claude',
        outcome: 'ok',
        durationMs: Date.now() - startedAt,
    });
    return { settingsPath, changed: !dryRun, hooksEntries: mergeResult.hooksEntries };
}

async function ensureGlobalStatusLine(): Promise<void> {
    const homeDir = os.homedir();
    const statuslineHookPath = path.join(homeDir, '.xtrm', 'hooks', 'statusline.mjs');
    const globalSettingsPath = path.join(homeDir, '.claude', 'settings.json');
    if (!await fs.pathExists(statuslineHookPath)) {
        return;
    }

    const settings = await readSettings(globalSettingsPath);
    const expectedCommand = `node "${statuslineHookPath}"`;
    const currentCommand = (settings.statusLine as { command?: string } | undefined)?.command;
    if (currentCommand === expectedCommand) {
        return;
    }

    settings.statusLine = { type: 'command', command: expectedCommand };
    await writeJsonAtomic(globalSettingsPath, settings);
}

export async function readGlobalHooksConfig(hooksConfigPath: string): Promise<NativeHooksConfig> {
    return await fs.readJson(hooksConfigPath) as NativeHooksConfig;
}

export function resolveHooksForGlobalRuntime(hooks: Record<string, HookWrapper[]>, globalHooksDir: string): Record<string, HookWrapper[]> {
    const normalizedHooksDir = normalizeHookCommandPath(globalHooksDir);
    return resolveHooksForRuntime(hooks, normalizedHooksDir);
}

function resolveHooksForProjectRuntime(hooks: Record<string, HookWrapper[]>, projectHooksDir: string): Record<string, HookWrapper[]> {
    const normalizedHooksDir = normalizeHookCommandPath(projectHooksDir);
    return resolveHooksForRuntime(hooks, normalizedHooksDir);
}

// SEAM (lane 1 severed): the retired beads-* gates have no substrate-*
// successors yet. Disposition per ADR section 54 — beads-edit-gate becomes
// substrate-edit-gate, beads-commit-gate becomes the substrate
// provenance/commit gate, beads-claim-sync becomes native session/claim
// binding, beads-stop-gate becomes the Substrate continuity/active-work gate,
// beads-compact-save/restore become Journal mechanical checkpoint / Resume
// Capsule, beads-status-cache becomes a Substrate projection or is retired.
// Lane 1 status: live consumers severed (statusline git-only, loggers inline
// resolveCwd/resolveSessionId, custom-footer BEADS_RETIRED_LANE1, xtrm-logger
// anchored on .xtrm/). Payload files stay until lane 2 (deletion).
// The canonical template (.xtrm/config/hooks.json) no longer wires beads-*
// hooks; this resolver stays generic and wires whatever the template declares.
function resolveHooksForRuntime(hooks: Record<string, HookWrapper[]>, hooksDir: string): Record<string, HookWrapper[]> {
    const rewrittenHooks: Record<string, HookWrapper[]> = {};
    for (const [eventName, wrappers] of Object.entries(hooks)) {
        const wrapperList = Array.isArray(wrappers) ? wrappers : [wrappers as HookWrapper];
        rewrittenHooks[eventName] = wrapperList.map((wrapper) => {
            // Preserve unrecognized third-party wrapper shapes verbatim. Only
            // canonical command-hook arrays are ours to rewrite.
            if (!Array.isArray(wrapper.hooks)) {
                return wrapper;
            }
            return {
                ...wrapper,
                hooks: wrapper.hooks.map((hook) => hook.type !== 'command'
                    ? hook
                    : { ...hook, command: rewritePluginRootCommandToProjectHookPath(hook.command, hooksDir) }),
            };
        });
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
    return Object.values(hooks).reduce((count, wrappers) => count + wrappers.length, 0);
}

function stableHookHash(wrapper: HookWrapper): string {
    const canonical = {
        matcher: wrapper.matcher ?? null,
        // settings.json is an external/runtime boundary. Unknown third-party
        // wrapper shapes must remain hashable without being mistaken for a
        // valid generated wrapper or crashing reconciliation.
        hooks: Array.isArray(wrapper.hooks)
            ? wrapper.hooks.map((hook) => ({ type: hook.type, command: hook.command, timeout: hook.timeout ?? null }))
            : null,
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function tagOwnedWrapper(
    wrapper: HookWrapper,
    installedVersion: string,
    _existingWrapper?: HookWrapper,
): HookWrapper {
    return {
        ...wrapper,
        _source: XTRM_GLOBAL_SOURCE,
        _xtrm: {
            version: installedVersion,
            hash: stableHookHash(wrapper),
        },
        hooks: wrapper.hooks.map((hook) => ({ ...hook })),
    };
}

function hasSameCanonicalHooks(left?: HookWrapper, right?: HookWrapper): boolean {
    if (!left || !right) {
        return false;
    }

    return stableHookHash(left) === stableHookHash(right);
}

function isOwnedWrapper(wrapper: HookWrapper, canonicalHashes: Set<string>): boolean {
    if (wrapper._source === XTRM_GLOBAL_SOURCE) {
        return true;
    }

    const wrapperHash = wrapper._xtrm?.hash ?? stableHookHash(wrapper);
    return canonicalHashes.has(wrapperHash);
}

// Substrings that mark a command as xtrm-managed regardless of exact path shape.
// Covers: project .xtrm/hooks (rewritten from ${CLAUDE_PLUGIN_ROOT}), global ~/.xtrm/hooks,
// retired service-skills paths, and unrewritten plugin-root forms (both
// ${CLAUDE_PLUGIN_ROOT}/ and $CLAUDE_PLUGIN_ROOT/ — bare `CLAUDE_PLUGIN_ROOT`
// substring matches both, since the token only appears in xtrm-managed contexts).
const XTRM_MANAGED_COMMAND_MARKERS = [
    '/.xtrm/hooks/',
    '/.xtrm/skills/default/service-skills/scripts/',
    '/.claude/skills/service-skills/scripts/',
    'CLAUDE_PLUGIN_ROOT',
];

function isXtrmManagedCommand(command: string, projectHooksDir: string): boolean {
    if (typeof command !== 'string' || command.length === 0) {
        return false;
    }
    if (XTRM_MANAGED_COMMAND_MARKERS.some((marker) => command.includes(marker))) {
        return true;
    }
    // Handle out-of-tree project hooks dirs (unusual but supported).
    if (projectHooksDir && command.includes(projectHooksDir)) {
        return true;
    }
    return false;
}

function isProjectOwnedWrapper(wrapper: HookWrapper, canonicalHashes: Set<string>, projectHooksDir: string): boolean {
    if (isOwnedWrapper(wrapper, canonicalHashes)) {
        return true;
    }
    if (!Array.isArray(wrapper.hooks)) {
        return false;
    }
    return wrapper.hooks.some((hook) => isXtrmManagedCommand(hook.command ?? '', projectHooksDir));
}

// Merge canonical (generated) xtrm hooks with an existing project settings.json,
// preserving any wrapper that is NOT xtrm-managed (third-party integrations,
// per-repo scanners, user-local hooks). "xtrm-managed" is detected via
// stableHookHash match against the current canonical set OR command-path match
// against known xtrm-owned prefixes (`.xtrm/hooks/`, service-skills scripts,
// `${CLAUDE_PLUGIN_ROOT}/`). Stale xtrm hooks whose hash no longer matches are
// still dropped because their command still targets an xtrm-owned path — the
// canonical version replaces them. Third-party wrappers survive verbatim.
//
// Reported as xtrm-61cdl (xtmux-qa0): the previous wholesale-replace ate
// xtmux's auto-monitor hook three times in one week.
export function mergeProjectOwnedHooks(
    existingHooks: Record<string, HookWrapper[]>,
    generatedHooks: Record<string, HookWrapper[]>,
    projectHooksDir: string,
): Record<string, HookWrapper[]> {
    const canonicalHashes = new Set(Object.values(generatedHooks).flat().map((wrapper) => stableHookHash(wrapper)));
    const merged: Record<string, HookWrapper[]> = {};

    for (const [eventName, wrappers] of Object.entries(existingHooks)) {
        if (!Array.isArray(wrappers)) continue;
        const kept = wrappers.filter((wrapper) => !isProjectOwnedWrapper(wrapper, canonicalHashes, projectHooksDir));
        if (kept.length > 0) {
            merged[eventName] = kept;
        }
    }

    for (const [eventName, wrappers] of Object.entries(generatedHooks)) {
        merged[eventName] = merged[eventName] ? [...wrappers, ...merged[eventName]] : wrappers;
    }

    return merged;
}

export async function safeMergeOwnedHookSettings(
    currentSettings: HookRuntimeSettingsShape,
    generatedHooks: Record<string, HookWrapper[]>,
    opts: { dryRun?: boolean } = {},
): Promise<SafeMergeResult> {
    const installedVersion = await readInstalledVersion();
    const currentHooks = currentSettings.hooks ?? {};
    const taggedHooks = Object.fromEntries(
        Object.entries(generatedHooks).map(([eventName, wrappers]) => {
            const existingWrappers = currentHooks[eventName] ?? [];
            return [
                eventName,
                wrappers.map((wrapper) => tagOwnedWrapper(
                    wrapper,
                    installedVersion,
                    existingWrappers.find((existingWrapper) => hasSameCanonicalHooks(existingWrapper, wrapper)),
                )),
            ];
        }),
    ) as Record<string, HookWrapper[]>;
    const canonicalHashes = new Set(Object.values(taggedHooks).flat().map((wrapper) => wrapper._xtrm?.hash ?? stableHookHash(wrapper)));
    const mergedHooks: Record<string, HookWrapper[]> = {};
    const globalHooksRoot = path.resolve(os.homedir(), '.xtrm', 'hooks');
    const retiredRemoved: RetiredHookRemoval[] = [];

    for (const [eventName, wrappers] of Object.entries(taggedHooks)) {
        mergedHooks[eventName] = [...wrappers];
    }

    for (const [eventName, wrappers] of Object.entries(currentHooks)) {
        const mergedWrappers = mergedHooks[eventName] ?? [];
        for (const wrapper of wrappers) {
            const entryHash = stableHookHash(wrapper);
            if (wrapper._source === XTRM_GLOBAL_SOURCE || canonicalHashes.has(entryHash) || canonicalHashes.has(wrapper._xtrm?.hash ?? '')) {
                await appendHookLog({ timestamp: new Date().toISOString(), component: 'hooks-migration', event: 'hook.entry.owned-replaced', entryKey: eventName, source: hashValue(entryHash), action: 'replace', outcome: 'ok', durationMs: 0 });
                continue;
            }

            if (isRetiredHookWrapper(wrapper, globalHooksRoot)) {
                for (const hook of wrapper.hooks) retiredRemoved.push({ event: eventName, command: hook.command });
                await appendHookLog({ timestamp: new Date().toISOString(), component: 'hooks-migration', event: 'hook.entry.retired-removed', entryKey: eventName, source: hashValue(entryHash), action: 'remove', outcome: 'ok', durationMs: 0 });
                continue;
            }

            if (conflictsWithCanonical(wrapper, globalHooksRoot)) {
                console.warn(`[hook.entry.foreign] ${eventName} ${hashValue(entryHash)}`);
                await appendHookLog({ timestamp: new Date().toISOString(), component: 'hooks-migration', event: 'hook.entry.foreign-preserved', entryKey: eventName, source: hashValue(entryHash), action: 'preserve', outcome: 'ok', durationMs: 0 });
            }

            mergedWrappers.push(wrapper);
        }

        if (mergedWrappers.length > 0) {
            mergedHooks[eventName] = mergedWrappers;
        }
    }

    for (const [eventName, wrappers] of Object.entries(taggedHooks)) {
        for (const wrapper of wrappers) {
            await appendHookLog({ timestamp: new Date().toISOString(), component: 'hooks-migration', event: 'hook.entry.new-added', entryKey: eventName, source: hashValue(wrapper._xtrm?.hash ?? stableHookHash(wrapper)), action: 'add', outcome: 'ok', durationMs: 0 });
        }
    }

    const nextSettings: HookRuntimeSettingsShape = { ...currentSettings, hooks: mergedHooks };
    const changed = JSON.stringify(currentSettings) !== JSON.stringify(nextSettings);
    return { settings: nextSettings, changed: changed && !opts.dryRun, hooksEntries: countHookEntries(taggedHooks), retiredRemoved };
}

function reportRetiredHookRemovals(removals: readonly RetiredHookRemoval[], dryRun: boolean): void {
    const verb = dryRun ? 'would remove' : 'removed';
    for (const removal of removals) {
        console.log(t.label(`  • ${verb} retired hook: ${removal.event} ${removal.command.slice(0, 120)}`));
    }
}

// XTRM-602: list the untagged wrappers in a hooks map that isRetiredHookWrapper
// would drop, one entry per command.
export function findRetiredHookWrappers(hooks: Record<string, HookWrapper[]>, globalHooksRoot: string): RetiredHookRemoval[] {
    const removals: RetiredHookRemoval[] = [];
    for (const [eventName, wrappers] of Object.entries(hooks)) {
        if (!Array.isArray(wrappers)) continue;
        for (const wrapper of wrappers) {
            if (!isRetiredHookWrapper(wrapper, globalHooksRoot)) continue;
            for (const hook of wrapper.hooks) removals.push({ event: eventName, command: hook.command });
        }
    }
    return removals;
}

// True only for an untagged wrapper whose every hook is a command, and whose
// every path token in every command resolves under globalHooksRoot to a file on
// RETIRED_HOOK_FILES. Mixed wrappers, unlisted files and paths elsewhere are kept.
function isRetiredHookWrapper(wrapper: HookWrapper, globalHooksRoot: string): boolean {
    if (wrapper._source !== undefined || wrapper._xtrm !== undefined) {
        return false;
    }
    if (!Array.isArray(wrapper.hooks) || wrapper.hooks.length === 0) {
        return false;
    }
    return wrapper.hooks.every((hook) => {
        if (hook.type !== 'command' || typeof hook.command !== 'string') {
            return false;
        }
        const pathTokens = tokenizeCommand(hook.command).filter((token) => token.includes('/'));
        return pathTokens.length > 0 && pathTokens.every((token) => {
            const relativePath = relativeToGlobalHooksRoot(token, globalHooksRoot);
            return relativePath !== null && RETIRED_HOOK_FILES.has(relativePath.split(path.sep).join('/'));
        });
    });
}

function conflictsWithCanonical(wrapper: HookWrapper, globalHooksRoot: string): boolean {
    if (wrapper._source === XTRM_GLOBAL_SOURCE) {
        return true;
    }

    if (!Array.isArray(wrapper.hooks)) {
        return false;
    }

    return wrapper.hooks.some((hook) => typeof hook.command === 'string' && commandTargetsGlobalHook(hook.command, globalHooksRoot));
}

function commandTargetsGlobalHook(command: string, globalHooksRoot: string): boolean {
    return extractCommandPathTokens(command).some((token) => relativeToGlobalHooksRoot(token, globalHooksRoot) !== null);
}

// Path of a command token relative to globalHooksRoot, or null when the token
// does not resolve inside it. Both sides are realpath-resolved when they exist.
function relativeToGlobalHooksRoot(token: string, globalHooksRoot: string): string | null {
    let realRoot: string;
    try {
        realRoot = fsSync.realpathSync(globalHooksRoot);
    } catch {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        realRoot = path.resolve(globalHooksRoot);
    }

    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const resolvedTokenPath = path.resolve(expandTilde(token));
    let realTokenPath: string;
    try {
        realTokenPath = fsSync.realpathSync(resolvedTokenPath);
    } catch {
        // Missing file — treat lexical path as authoritative for containment;
        // a canonical hook path that resolves cleanly is trustworthy even if
        // the file has not been materialised yet.
        realTokenPath = resolvedTokenPath;
    }

    const relativePath = path.relative(realRoot, realTokenPath);
    if (relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
        return relativePath;
    }
    return null;
}

function tokenizeCommand(command: string): string[] {
    const matches = command.match(/"([^"]+)"|'([^']+)'|([^\s]+)/g) ?? [];
    return matches.map((match) => match.replace(/^['"]|['"]$/g, ''));
}

function extractCommandPathTokens(command: string): string[] {
    return tokenizeCommand(command).filter((token) => token.includes('.xtrm/hooks/'));
}

function expandTilde(targetPath: string): string {
    // Claude Code runs hook commands through a shell, so ~/, $HOME/ and ${HOME}/
    // all name the same home directory.
    const homePrefix = ['~/', '$HOME/', '${HOME}/'].find((prefix) => targetPath.startsWith(prefix));
    if (!homePrefix) {
        return targetPath;
    }

    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    return path.join(os.homedir(), targetPath.slice(homePrefix.length));
}

async function readExistingHooks(settingsPath: string): Promise<Record<string, HookWrapper[]>> {
    const settings = await readSettings(settingsPath);
    return settings.hooks ?? {};
}

async function readInstalledVersion(): Promise<string> {
    const packageRoot = await resolvePackageRoot();
    const pkg = await fs.readJson(path.join(packageRoot, 'package.json')) as { version?: string };
    return pkg.version ?? '0.0.0';
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
        return { permissions: { allow: [], defaultMode: 'default' }, skillSuggestions: { enabled: true } };
    }
}

async function resolvePackageRoot(): Promise<string> {
    const candidates = [path.resolve(__dirname, '../..'), path.resolve(__dirname, '../../..')];
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
        const result = spawnSync('npm', ['show', 'xtrm-tools', 'version', '--json'], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
        if (result.status !== 0 || !result.stdout) return;

        const npmVersion: string = JSON.parse(result.stdout.trim());
        const parse = (value: string) => value.split('.').map(Number);
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
