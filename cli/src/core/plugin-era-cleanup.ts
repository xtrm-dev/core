import kleur from 'kleur';
import fs from 'fs-extra';
import { existsSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { confirmDestructiveAction } from '../utils/confirmation.js';
import { resolveGlobalHooksConfigPath } from './global-hooks-bootstrap.js';

export type CleanupScope = 'global' | 'project' | 'all';

type CleanupOperationType = 'delete-path' | 'delete-json-map-entries' | 'prune-hook-rows';

interface JsonMapEntryDelete {
  parentKey: string;
  entryKey: string;
}

interface HookRowDelete {
  eventName: string;
  index: number;
  hookName: string;
  scriptPath: string;
}

interface CleanupOperation {
  scope: Exclude<CleanupScope, 'all'>;
  type: CleanupOperationType;
  targetPath: string;
  label: string;
  mapEntryDeletes?: readonly JsonMapEntryDelete[];
  hookRowDeletes?: readonly HookRowDelete[];
}

export interface RunPluginEraCleanupOptions {
  dryRun?: boolean;
  yes?: boolean;
  scope?: CleanupScope;
  repoRoot?: string;
}

export interface CleanupResult {
  dryRun: boolean;
  scopesProcessed: Array<Exclude<CleanupScope, 'all'>>;
  planned: CleanupOperation[];
  removedPaths: string[];
  updatedSettings: string[];
}

const LEGACY_PLUGIN_INSTALL_ID = 'xtrm-tools@xtrm-tools';
const LEGACY_MARKETPLACE_ID = 'xtrm-tools';

const SETTINGS_MAP_ENTRY_DELETES: readonly JsonMapEntryDelete[] = [
  { parentKey: 'enabledPlugins', entryKey: LEGACY_PLUGIN_INSTALL_ID },
  { parentKey: 'extraKnownMarketplaces', entryKey: LEGACY_MARKETPLACE_ID },
];

const INSTALLED_PLUGINS_FILE_ENTRY_DELETES: readonly JsonMapEntryDelete[] = [
  { parentKey: '', entryKey: LEGACY_PLUGIN_INSTALL_ID },
];

const KNOWN_MARKETPLACES_FILE_ENTRY_DELETES: readonly JsonMapEntryDelete[] = [
  { parentKey: '', entryKey: LEGACY_MARKETPLACE_ID },
];

// Retired extension ids stay in this set so stale global installs are still
// cleaned: membership drives on-disk cleanup, not registration.
// (xtrm-loader retired with the bd-memory retirement; manifest.json records it.)
const XTRM_MANAGED_PI_EXTENSIONS = new Set([
  'beads',
  'session-flow',
  'quality-gates',
  'service-skills',
  'xtrm-loader',
  'custom-footer',
  'plan-mode',
  'auto-update',
  'compact-header',
  'git-checkpoint',
  'xtrm-ui',
  'core',
]);

const LEGACY_PROJECT_HOOK_FILES: Array<{ legacyFile: string; duplicatePath: string }> = [
  { legacyFile: 'hook-config.json', duplicatePath: path.join('.xtrm', 'config', 'hooks.json') },
  { legacyFile: 'quality-check.cjs', duplicatePath: path.join('.xtrm', 'hooks', 'quality-check.cjs') },
  { legacyFile: 'quality-check.py', duplicatePath: path.join('.xtrm', 'hooks', 'quality-check.py') },
];

export const PLUGIN_ERA_ARTIFACTS = {
  settingsMapEntryDeletes: SETTINGS_MAP_ENTRY_DELETES,
  installedPluginsEntry: LEGACY_PLUGIN_INSTALL_ID,
  knownMarketplaceEntry: LEGACY_MARKETPLACE_ID,
  piExtensionIds: Array.from(XTRM_MANAGED_PI_EXTENSIONS),
  legacyProjectHookFiles: LEGACY_PROJECT_HOOK_FILES.map((entry) => entry.legacyFile),
} as const;

export async function runPluginEraCleanup(opts: RunPluginEraCleanupOptions = {}): Promise<CleanupResult> {
  const dryRun = opts.dryRun ?? false;
  const yes = opts.yes ?? false;
  const scope = opts.scope ?? 'all';
  const repoRoot = opts.repoRoot ?? process.cwd();

  const scopes = resolveScopes(scope);
  const managedAgentSkills = await getManagedAgentSkillNames(repoRoot);

  const operations = await planCleanupOperations({
    repoRoot,
    scopes,
    managedAgentSkills,
  });

  if (operations.length === 0) {
    console.log(kleur.dim('  ✓ Plugin-era prune: nothing to remove'));
    return {
      dryRun,
      scopesProcessed: scopes,
      planned: [],
      removedPaths: [],
      updatedSettings: [],
    };
  }

  console.log(kleur.bold('\n  Plugin-era cleanup (--prune)'));
  printCleanupPlan(operations, dryRun);

  const removedPaths: string[] = [];
  const updatedSettings: string[] = [];

  for (const currentScope of scopes) {
    const scopeOperations = operations.filter((operation) => operation.scope === currentScope);
    if (scopeOperations.length === 0) {
      continue;
    }

    if (!dryRun) {
      const confirmed = await confirmDestructiveAction({
        yes,
        initial: false,
        message: `Apply plugin-era cleanup for ${currentScope} scope?`,
      });

      if (!confirmed) {
        console.log(kleur.yellow(`  ↷ Skipped ${currentScope} cleanup by user choice`));
        continue;
      }
    }

    for (const operation of scopeOperations) {
      if (operation.type === 'delete-path') {
        if (!dryRun) {
          await fs.remove(operation.targetPath);
        }
        removedPaths.push(operation.targetPath);
      }

      if (operation.type === 'delete-json-map-entries') {
        if (!dryRun) {
          await deleteJsonMapEntries(operation.targetPath, operation.mapEntryDeletes ?? []);
        }
        updatedSettings.push(operation.targetPath);
      }

      if (operation.type === 'prune-hook-rows') {
        if (!dryRun) {
          await pruneHookRows(operation.targetPath, operation.hookRowDeletes ?? []);
        }
        updatedSettings.push(operation.targetPath);
      }
    }
  }

  return {
    dryRun,
    scopesProcessed: scopes,
    planned: operations,
    removedPaths,
    updatedSettings,
  };
}

function resolveScopes(scope: CleanupScope): Array<Exclude<CleanupScope, 'all'>> {
  if (scope === 'all') {
    return ['global', 'project'];
  }
  return [scope];
}

async function planCleanupOperations(params: {
  repoRoot: string;
  scopes: Array<Exclude<CleanupScope, 'all'>>;
  managedAgentSkills: ReadonlySet<string>;
}): Promise<CleanupOperation[]> {
  const operations: CleanupOperation[] = [];

  if (params.scopes.includes('global')) {
    operations.push(...await planGlobalOperations(params.managedAgentSkills));
  }

  if (params.scopes.includes('project')) {
    operations.push(...await planProjectOperations(params.repoRoot));
  }

  return operations;
}

async function planGlobalOperations(managedAgentSkills: ReadonlySet<string>): Promise<CleanupOperation[]> {
  const operations: CleanupOperation[] = [];

  const claudeDir = path.join(os.homedir(), '.claude');
  const pluginDir = path.join(claudeDir, 'plugins');
  const claudeSettingsPath = path.join(claudeDir, 'settings.json');

  const xtrmPluginDataDir = path.join(pluginDir, 'data', 'xtrm-tools-xtrm-tools');
  if (await fs.pathExists(xtrmPluginDataDir)) {
    operations.push({
      scope: 'global',
      type: 'delete-path',
      targetPath: xtrmPluginDataDir,
      label: '~/.claude/plugins/data/xtrm-tools-xtrm-tools/',
    });
  }

  const xtrmPluginCacheDir = path.join(pluginDir, 'cache', 'xtrm-tools');
  if (await fs.pathExists(xtrmPluginCacheDir)) {
    operations.push({
      scope: 'global',
      type: 'delete-path',
      targetPath: xtrmPluginCacheDir,
      label: '~/.claude/plugins/cache/xtrm-tools/',
    });
  }

  const xtrmPluginMarketplaceDir = path.join(pluginDir, 'marketplaces', 'xtrm-tools');
  if (await fs.pathExists(xtrmPluginMarketplaceDir)) {
    operations.push({
      scope: 'global',
      type: 'delete-path',
      targetPath: xtrmPluginMarketplaceDir,
      label: '~/.claude/plugins/marketplaces/xtrm-tools/',
    });
  }

  const installedPluginsPath = path.join(pluginDir, 'installed_plugins.json');
  if (await hasJsonMapEntries(installedPluginsPath, INSTALLED_PLUGINS_FILE_ENTRY_DELETES)) {
    operations.push({
      scope: 'global',
      type: 'delete-json-map-entries',
      targetPath: installedPluginsPath,
      label: '~/.claude/plugins/installed_plugins.json key: xtrm-tools@xtrm-tools',
      mapEntryDeletes: INSTALLED_PLUGINS_FILE_ENTRY_DELETES,
    });
  }

  const knownMarketplacesPath = path.join(pluginDir, 'known_marketplaces.json');
  if (await hasJsonMapEntries(knownMarketplacesPath, KNOWN_MARKETPLACES_FILE_ENTRY_DELETES)) {
    operations.push({
      scope: 'global',
      type: 'delete-json-map-entries',
      targetPath: knownMarketplacesPath,
      label: '~/.claude/plugins/known_marketplaces.json key: xtrm-tools',
      mapEntryDeletes: KNOWN_MARKETPLACES_FILE_ENTRY_DELETES,
    });
  }

  if (await hasJsonMapEntries(claudeSettingsPath, SETTINGS_MAP_ENTRY_DELETES)) {
    operations.push({
      scope: 'global',
      type: 'delete-json-map-entries',
      targetPath: claudeSettingsPath,
      label: '~/.claude/settings.json entries: enabledPlugins[xtrm-tools@xtrm-tools], extraKnownMarketplaces[xtrm-tools]',
      mapEntryDeletes: SETTINGS_MAP_ENTRY_DELETES,
    });
  }

  operations.push(...await planMissingHookRows({
    scope: 'global',
    filePath: resolveGlobalHooksConfigPath(),
  }));

  const piExtensionsDir = path.join(os.homedir(), '.pi', 'agent', 'extensions');
  operations.push(...await planManagedDirectoryEntryDeletes({
    scope: 'global',
    baseDir: piExtensionsDir,
    managedNames: XTRM_MANAGED_PI_EXTENSIONS,
    labelPrefix: '~/.pi/agent/extensions/',
  }));

  return operations;
}

async function planProjectOperations(repoRoot: string): Promise<CleanupOperation[]> {
  const operations: CleanupOperation[] = [];

  const claudeSettingsPath = path.join(repoRoot, '.claude', 'settings.json');
  operations.push(...await planMissingHookRows({
    scope: 'project',
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    filePath: path.join(repoRoot, '.xtrm', 'config', 'hooks.json'),
  }));

  if (await hasJsonMapEntries(claudeSettingsPath, SETTINGS_MAP_ENTRY_DELETES)) {
    operations.push({
      scope: 'project',
      type: 'delete-json-map-entries',
      targetPath: claudeSettingsPath,
      label: '.claude/settings.json entries: enabledPlugins[xtrm-tools@xtrm-tools], extraKnownMarketplaces[xtrm-tools]',
      mapEntryDeletes: SETTINGS_MAP_ENTRY_DELETES,
    });
  }

  const projectHooksDir = path.join(repoRoot, '.claude', 'hooks');
  for (const { legacyFile, duplicatePath } of LEGACY_PROJECT_HOOK_FILES) {
    const legacyPath = path.join(projectHooksDir, legacyFile);
    const canonicalPath = path.join(repoRoot, duplicatePath);

    if (!await fs.pathExists(legacyPath)) {
      continue;
    }

    if (!await fs.pathExists(canonicalPath)) {
      continue;
    }

    operations.push({
      scope: 'project',
      type: 'delete-path',
      targetPath: legacyPath,
      label: `.claude/hooks/${legacyFile}`,
    });
  }

  return operations;
}

async function planManagedDirectoryEntryDeletes(params: {
  scope: Exclude<CleanupScope, 'all'>;
  baseDir: string;
  managedNames: ReadonlySet<string>;
  labelPrefix: string;
}): Promise<CleanupOperation[]> {
  if (!await fs.pathExists(params.baseDir)) {
    return [];
  }

  const entries = await fs.readdir(params.baseDir);
  return entries
    .filter((entry) => params.managedNames.has(entry))
    .map((entry) => ({
      scope: params.scope,
      type: 'delete-path' as const,
      targetPath: path.join(params.baseDir, entry),
      label: `${params.labelPrefix}${entry}`,
    }));
}

function printCleanupPlan(operations: CleanupOperation[], dryRun: boolean): void {
  const byScope: Record<Exclude<CleanupScope, 'all'>, CleanupOperation[]> = {
    global: [],
    project: [],
  };

  for (const operation of operations) {
    byScope[operation.scope].push(operation);
  }

  for (const [scopeName, scopeOps] of Object.entries(byScope) as Array<[Exclude<CleanupScope, 'all'>, CleanupOperation[]]>) {
    if (scopeOps.length === 0) {
      continue;
    }

    console.log(kleur.cyan(`  ${scopeName}:`));
    for (const operation of scopeOps) {
      const action = operation.type === 'delete-json-map-entries'
        ? 'update'
        : operation.type === 'prune-hook-rows' ? 'prune' : 'delete';
      const prefix = dryRun ? '[DRY RUN] would' : 'will';
      console.log(kleur.dim(`    • ${prefix} ${action} ${operation.label}`));
    }
  }
  console.log('');
}

async function hasJsonMapEntries(filePath: string, deletes: readonly JsonMapEntryDelete[]): Promise<boolean> {
  const record = await readJsonObject(filePath);
  if (!record) {
    return false;
  }

  return deletes.some(({ parentKey, entryKey }) => hasJsonMapEntry(record, parentKey, entryKey));
}

function hasJsonMapEntry(record: Record<string, unknown>, parentKey: string, entryKey: string): boolean {
  if (parentKey.length === 0) {
    return entryKey in record;
  }

  const parent = record[parentKey];
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
    return false;
  }

  return entryKey in (parent as Record<string, unknown>);
}

async function planMissingHookRows(params: {
  scope: Exclude<CleanupScope, 'all'>;
  filePath: string;
}): Promise<CleanupOperation[]> {
  const record = await readJsonObject(params.filePath);
  if (!record || !record.hooks || typeof record.hooks !== 'object' || Array.isArray(record.hooks)) {
    return [];
  }

  const hookRowDeletes: HookRowDelete[] = [];
  for (const [eventName, rows] of Object.entries(record.hooks as Record<string, unknown>)) {
    if (!Array.isArray(rows)) {
      continue;
    }

    rows.forEach((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        return;
      }

      const scriptPath = (row as Record<string, unknown>).scriptPath;
      if (typeof scriptPath !== 'string' || existsSync(scriptPath)) {
        return;
      }

      const hookName = typeof (row as Record<string, unknown>).name === 'string'
        ? (row as Record<string, unknown>).name as string
        : eventName;
      console.warn(`WARN: pruning hook ${hookName}; missing script ${scriptPath}`);
      hookRowDeletes.push({ eventName, index, hookName, scriptPath });
    });
  }

  if (hookRowDeletes.length === 0) {
    return [];
  }

  return [{
    scope: params.scope,
    type: 'prune-hook-rows',
    targetPath: params.filePath,
    label: `${params.filePath}: ${hookRowDeletes.length} missing hook script(s)`,
    hookRowDeletes,
  }];
}

async function pruneHookRows(filePath: string, deletes: readonly HookRowDelete[]): Promise<void> {
  const record = await readJsonObject(filePath);
  if (!record || !record.hooks || typeof record.hooks !== 'object' || Array.isArray(record.hooks)) {
    return;
  }

  const rowsByEvent = new Map<string, Set<number>>();
  for (const deletion of deletes) {
    const indexes = rowsByEvent.get(deletion.eventName) ?? new Set<number>();
    indexes.add(deletion.index);
    rowsByEvent.set(deletion.eventName, indexes);
  }

  const hooks = record.hooks as Record<string, unknown>;
  for (const [eventName, indexes] of rowsByEvent) {
    const rows = hooks[eventName];
    if (!Array.isArray(rows)) {
      continue;
    }
    hooks[eventName] = rows.filter((_row, index) => !indexes.has(index));
    if ((hooks[eventName] as unknown[]).length === 0) {
      delete hooks[eventName];
    }
  }

  await fs.writeJson(filePath, record, { spaces: 2 });
}

async function deleteJsonMapEntries(filePath: string, deletes: readonly JsonMapEntryDelete[]): Promise<void> {
  const record = await readJsonObject(filePath);
  if (!record) {
    return;
  }

  let changed = false;

  for (const { parentKey, entryKey } of deletes) {
    if (parentKey.length === 0) {
      if (entryKey in record) {
        delete record[entryKey];
        changed = true;
      }
      continue;
    }

    const parent = record[parentKey];
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) {
      continue;
    }

    const parentRecord = parent as Record<string, unknown>;
    if (!(entryKey in parentRecord)) {
      continue;
    }

    delete parentRecord[entryKey];
    changed = true;

    if (Object.keys(parentRecord).length === 0) {
      delete record[parentKey];
    }
  }

  if (!changed) {
    return;
  }

  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, record, { spaces: 2 });
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  if (!await fs.pathExists(filePath)) {
    return null;
  }

  try {
    const parsed = await fs.readJson(filePath) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function getManagedAgentSkillNames(repoRoot: string): Promise<Set<string>> {
  const candidates = [
    path.join(repoRoot, '.xtrm', 'skills', 'default'),
    path.resolve(__dirname, '..', '..', '.xtrm', 'skills', 'default'),
    path.resolve(__dirname, '..', '..', '..', '.xtrm', 'skills', 'default'),
  ];

  for (const candidate of candidates) {
    if (!await fs.pathExists(candidate)) {
      continue;
    }

    const entries = await fs.readdir(candidate);
    const managed = new Set<string>();

    for (const entry of entries) {
      const entryPath = path.join(candidate, entry);
      if ((await fs.stat(entryPath)).isDirectory()) {
        managed.add(entry);
      }
    }

    if (managed.size > 0) {
      return managed;
    }
  }

  return new Set<string>();
}
