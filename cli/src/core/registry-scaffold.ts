import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'path';
import crypto from 'node:crypto';
import { t } from '../utils/theme.js';
import { checkDrift } from './drift.js';
import { confirmDestructiveAction } from '../utils/confirmation.js';
import { shouldUseGlobalSkills } from './global-skills-flag.js';
import { INSTALLER_MANIFEST_FILENAME, readManifestJson } from './installer-manifest.js';
import { resolveGlobalSkillsRoot } from './skills-layout.js';

declare const __dirname: string;

export interface RegistryFileEntry {
    hash: string;
    version: string;
}

export interface RegistryAsset {
    source_dir: string;
    install_mode: 'copy' | 'symlink';
    install_scope?: 'global' | 'project';
    files: Record<string, RegistryFileEntry>;
}

export interface RegistryManifest {
    version: string;
    assets: Record<string, RegistryAsset>;
}

export interface InstallStats {
    installed: number;
    upToDate: number;
    driftedSkipped: number;
    forced: number;
    expectedInstalls: number;
    missingSourceSkipped: number;
}

function formatMissingSources(missingSources: readonly string[]): string {
    return missingSources.map(sourcePath => '    • ' + sourcePath).join('\n');
}

export const USER_OWNED_PATHS: readonly string[] = [
    'skills/user/',
];

export function isUserOwnedPath(relativePath: string): boolean {
    return USER_OWNED_PATHS.some(userOwnedPath => userOwnedPath.endsWith('/')
        ? relativePath.startsWith(userOwnedPath)
        : relativePath === userOwnedPath);
}

export function resolvePackageRoot(): string {
    const candidates = [
        path.resolve(__dirname, '../..'),
        path.resolve(__dirname, '../../..'),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, '.xtrm', 'registry.json'))) {
            return candidate;
        }
    }

    throw new Error('Failed to locate package root: .xtrm/registry.json not found.');
}

export function toPosix(value: string): string {
    return value.replace(/\\/g, '/');
}

export function stripXtrmPrefix(sourceDir: string): string {
    return sourceDir.replace(/^\.xtrm\/?/, '');
}

export function toUserRelativePath(sourceDir: string, filePath: string): string {
    return toPosix(path.posix.join(stripXtrmPrefix(sourceDir), filePath));
}

export function isSkillsDefaultPath(relativePath: string): boolean {
    return relativePath.startsWith('skills/default/');
}

function resolveInstalledPath(userXtrmDir: string, relativePath: string, overrideRoots?: Record<string, string>): string {
    if (relativePath.startsWith('skills/default/')) {
        const skillsRoot = overrideRoots?.skills;
        if (skillsRoot) {
            // Canonical registry relative paths generated from package payload.
            // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
            return path.join(skillsRoot, relativePath.slice('skills/default/'.length));
        }
    }

    if (relativePath.startsWith('skills/optional/')) {
        const optionalSkillsRoot = overrideRoots?.skills_optional;
        if (optionalSkillsRoot) {
            // Canonical registry relative paths generated from package payload.
            // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
            return path.join(optionalSkillsRoot, relativePath.slice('skills/optional/'.length));
        }
    }

    // Canonical registry relative paths generated from package payload.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    return path.join(userXtrmDir, relativePath);
}

export async function hashFile(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

export async function scaffoldSkillsDefaultFromPackage(params: {
    packageRoot: string;
    userXtrmDir: string;
    dryRun: boolean;
}): Promise<'copy' | 'noop'> {
    const { packageRoot, userXtrmDir, dryRun } = params;
    const sourceDir = path.join(packageRoot, '.xtrm', 'skills', 'default');
    const targetDir = path.join(userXtrmDir, 'skills', 'default');
    const repoRoot = path.dirname(userXtrmDir);

    if (shouldUseGlobalSkills(repoRoot)) {
        const globalSkillsRoot = resolveGlobalSkillsRoot();
        const hasGlobalTree = await fs.pathExists(path.join(globalSkillsRoot, 'default'))
            && await fs.pathExists(path.join(globalSkillsRoot, 'optional'));
        if (hasGlobalTree) {
            return 'noop';
        }
    }

    const stat = await fs.lstat(targetDir).catch(() => null);
    if (stat) {
        if (stat.isSymbolicLink()) {
            const [sourceRealPath, targetRealPath] = await Promise.all([
                fs.realpath(sourceDir).catch(() => null),
                fs.realpath(targetDir).catch(() => null),
            ]);

            if (sourceRealPath && targetRealPath && sourceRealPath === targetRealPath) {
                return 'noop'; // current package/dev symlink, leave it alone
            }

            if (dryRun) {
                return 'noop';
            }

            // Broken or stale symlink — remove and re-scaffold from the current package payload.
            await fs.remove(targetDir);
        } else {
            return 'noop'; // real directory, leave it alone
        }
    }

    if (dryRun) {
        return 'noop';
    }

    await fs.ensureDir(path.dirname(targetDir));
    await fs.copy(sourceDir, targetDir);
    return 'copy';
}

function getAssetInstallScope(asset: RegistryAsset): 'global' | 'project' {
    return asset.install_scope ?? 'project';
}

export function collectManagedDefaultSkillNames(registry: RegistryManifest): Set<string> {
    const names = new Set<string>();
    for (const asset of Object.values(registry.assets)) {
        if (asset.source_dir !== '.xtrm/skills/default') continue;
        for (const filePath of Object.keys(asset.files)) {
            const first = filePath.split('/')[0];
            if (first) names.add(first);
        }
    }
    return names;
}

function collectTopLevelNames(relPaths: readonly string[]): Set<string> {
    const names = new Set<string>();
    for (const relPath of relPaths) {
        const first = relPath.split('/')[0];
        if (first) names.add(first);
    }
    return names;
}

async function readPreviouslyManagedDefaultSkillNames(userXtrmDir: string, defaultRoot: string): Promise<Set<string>> {
    const globalDefaultRoot = path.join(resolveGlobalSkillsRoot(), 'default');
    // Canonical path comparison only; this does not access a resolved user path.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    if (path.resolve(defaultRoot) === path.resolve(globalDefaultRoot)) {
        const manifestPath = path.join(resolveGlobalSkillsRoot(), INSTALLER_MANIFEST_FILENAME);
        const manifest = await readManifestJson<{ default?: string[] }>(manifestPath, {});
        return collectTopLevelNames(manifest.default ?? []);
    }

    // userXtrmDir is the caller-selected .xtrm scope; only its fixed registry child is read.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const snapshotPath = path.join(userXtrmDir, 'registry.json');
    const snapshot = await readManifestJson<RegistryManifest | null>(snapshotPath, null);
    return snapshot ? collectManagedDefaultSkillNames(snapshot) : new Set<string>();
}

async function isDirLike(entryPath: string, entryStat: import('fs').Stats): Promise<boolean> {
    if (entryStat.isDirectory()) return true;
    if (!entryStat.isSymbolicLink()) return false;
    const resolved = await fs.stat(entryPath).catch(() => null);
    return Boolean(resolved?.isDirectory());
}

export async function pruneRetiredManagedSkills(params: {
    userXtrmDir: string;
    registry: RegistryManifest;
    dryRun: boolean;
    overrideRoots?: Record<string, string>;
}): Promise<{ removed: string[] }> {
    const { userXtrmDir, registry, dryRun, overrideRoots } = params;

    // Prune where installFromRegistry would write: honor the same skills override root.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const defaultRoot = overrideRoots?.skills ?? path.join(userXtrmDir, 'skills', 'default');

    const rootStat = await fs.lstat(defaultRoot).catch(() => null);
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        return { removed: [] };
    }

    const managedNames = collectManagedDefaultSkillNames(registry);
    if (managedNames.size === 0) {
        // No default skills asset in this registry (e.g. project snapshot under global mode).
        // Refuse to prune — we can't distinguish retired vs simply not-in-scope.
        return { removed: [] };
    }

    const previouslyManagedNames = await readPreviouslyManagedDefaultSkillNames(userXtrmDir, defaultRoot);
    if (previouslyManagedNames.size === 0) {
        return { removed: [] };
    }
    const retiredManagedNames = new Set(
        [...previouslyManagedNames].filter(name => !managedNames.has(name)),
    );
    if (retiredManagedNames.size === 0) {
        return { removed: [] };
    }

    const onDisk = await fs.readdir(defaultRoot);
    const removed: string[] = [];

    for (const name of onDisk) {
        if (!retiredManagedNames.has(name)) continue;

        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const entryPath = path.join(defaultRoot, name);
        const entryStat = await fs.lstat(entryPath).catch(() => null);
        if (!entryStat) continue;
        if (!(await isDirLike(entryPath, entryStat))) continue;

        removed.push(name);
        if (!dryRun) {
            await fs.remove(entryPath);
        }
    }

    // Sweep matching active-view symlinks that point at the pruned default entries.
    // User-owned active content (real dirs, or symlinks pointing outside the default root) is untouched.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const activeRoot = path.join(userXtrmDir, 'skills', 'active');
    const activeStat = await fs.lstat(activeRoot).catch(() => null);
    if (activeStat?.isDirectory() && !activeStat.isSymbolicLink()) {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const resolvedDefaultRoot = path.resolve(defaultRoot);
        for (const name of removed) {
            // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
            const activeEntry = path.join(activeRoot, name);
            const linkStat = await fs.lstat(activeEntry).catch(() => null);
            if (!linkStat || !linkStat.isSymbolicLink()) continue;
            const linkTarget = await fs.readlink(activeEntry).catch(() => null);
            if (!linkTarget) continue;
            // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
            const resolvedTarget = path.resolve(path.dirname(activeEntry), linkTarget);
            // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
            if (resolvedTarget === path.join(resolvedDefaultRoot, name)) {
                if (!dryRun) {
                    await fs.remove(activeEntry);
                }
            }
        }
    }

    return { removed };
}

async function appendGlobalSkillsSkipLog(asset: string, count: number): Promise<void> {
    const logPath = path.join(path.dirname(resolveGlobalSkillsRoot()), 'logs', 'skills-migration.jsonl');
    await fs.ensureDir(path.dirname(logPath));
    await fs.appendFile(logPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        component: 'skills-bootstrap',
        event: 'install.skip.global-managed',
        asset,
        count,
    })}\n`);
}

function createProjectRegistrySnapshot(registry: RegistryManifest, repoRoot?: string): RegistryManifest {
    if (!shouldUseGlobalSkills(repoRoot)) {
        return registry;
    }

    const assets = Object.fromEntries(
        Object.entries(registry.assets).filter(([, asset]) => getAssetInstallScope(asset) !== 'global'),
    );

    return {
        ...registry,
        assets,
    };
}

export function buildExpectedHashes(registry: RegistryManifest): Map<string, string> {
    const expected = new Map<string, string>();

    for (const asset of Object.values(registry.assets)) {
        for (const [filePath, fileEntry] of Object.entries(asset.files)) {
            expected.set(toUserRelativePath(asset.source_dir, filePath), fileEntry.hash);
        }
    }

    return expected;
}

export async function installFromRegistry(params: {
    packageRoot: string;
    registry: RegistryManifest;
    userXtrmDir: string;
    dryRun: boolean;
    force: boolean;
    yes: boolean;
    strictRegistry?: boolean;
    overrideRoots?: Record<string, string>;
}): Promise<InstallStats> {
    const { packageRoot, registry, userXtrmDir, dryRun, force, yes, strictRegistry = false, overrideRoots } = params;
    const registryPath = path.join(packageRoot, '.xtrm', 'registry.json');
    const installRepoRoot = path.dirname(userXtrmDir);

    const drift = await checkDrift(registryPath, userXtrmDir, overrideRoots);
    const expectedHashes = buildExpectedHashes(registry);

    const missingSet = new Set(drift.missing);
    const upToDateSet = new Set(drift.upToDate);
    const driftedSet = new Set(drift.drifted);

    if (!force) {
        const driftedSkills = drift.drifted.filter(isSkillsDefaultPath);
        if (driftedSkills.length > 0) {
            console.log(kleur.yellow('\n  ⚠ Drift detected in .xtrm files (local modifications preserved by default):'));
            for (const relativePath of driftedSkills.slice(0, 10)) {
                const absolutePath = resolveInstalledPath(userXtrmDir, relativePath, overrideRoots);
                const actualHash = await hashFile(absolutePath);
                const expectedHash = expectedHashes.get(relativePath) ?? 'unknown';
                console.log(kleur.yellow(`    • ${relativePath}`));
                console.log(kleur.dim(`      expected ${expectedHash.slice(0, 12)}…  actual ${actualHash.slice(0, 12)}…`));
            }
        }

        const nonSkillDrifted = drift.drifted.filter(relativePath => !isSkillsDefaultPath(relativePath));
        if (nonSkillDrifted.length > 0) {
            if (driftedSkills.length === 0) {
                console.log(kleur.yellow('\n  ⚠ Drift detected in .xtrm files (local modifications preserved by default):'));
            }
            for (const relativePath of nonSkillDrifted.slice(0, 20)) {
                const absolutePath = resolveInstalledPath(userXtrmDir, relativePath, overrideRoots);
                const actualHash = await hashFile(absolutePath);
                const expectedHash = expectedHashes.get(relativePath) ?? 'unknown';
                console.log(kleur.yellow(`    • ${relativePath}`));
                console.log(kleur.dim(`      expected ${expectedHash.slice(0, 12)}…  actual ${actualHash.slice(0, 12)}…`));
            }
        }

        if (drift.drifted.length > 20) {
            console.log(kleur.dim(`    … and ${drift.drifted.length - 20} more`));
        }
    }

    if (force && drift.drifted.length > 0 && !yes) {
        const confirmed = await confirmDestructiveAction({
            yes,
            message: `Overwrite ${drift.drifted.length} drifted .xtrm file(s)?`,
            initial: true,
        });

        if (!confirmed) {
            console.log(t.muted('  Install cancelled.\n'));
            return {
                installed: 0,
                upToDate: drift.upToDate.length,
                driftedSkipped: drift.drifted.length,
                forced: 0,
                expectedInstalls: 0,
                missingSourceSkipped: 0,
            };
        }
    }

    let installed = 0;
    let forced = 0;
    let expectedInstalls = 0;
    let missingSourceSkipped = 0;
    const missingSources: string[] = [];

    for (const [assetKey, asset] of Object.entries(registry.assets)) {
        const installScope = getAssetInstallScope(asset);
        const isGlobalManaged = shouldUseGlobalSkills(installRepoRoot) && installScope === 'global';
        const assetRoot = overrideRoots?.[assetKey];

        if (isGlobalManaged) {
            await appendGlobalSkillsSkipLog(assetKey, Object.keys(asset.files).length);
        }

        for (const [filePath] of Object.entries(asset.files)) {
            const relativePath = toUserRelativePath(asset.source_dir, filePath);
            const sourcePath = path.join(packageRoot, asset.source_dir, filePath);
            const targetPath = assetRoot
                // Canonical registry paths from package payload + controlled override roots.
                // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
                ? path.join(assetRoot, filePath)
                // Canonical registry relative paths generated from package payload.
                // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
                : path.join(userXtrmDir, relativePath);

            if (isUserOwnedPath(relativePath)) {
                continue;
            }

            if (upToDateSet.has(relativePath)) {
                continue;
            }

            const isMissing = missingSet.has(relativePath);
            const isDrifted = driftedSet.has(relativePath);

            if (!isMissing && !isDrifted) {
                continue;
            }

            if (isDrifted && !force) {
                continue;
            }

            if (isDrifted && force) {
                forced += 1;
            }

            expectedInstalls += 1;

            const sourceExists = await fs.pathExists(sourcePath);
            if (!sourceExists) {
                missingSourceSkipped += 1;
                const missingSource = toPosix(path.relative(packageRoot, sourcePath));
                missingSources.push(missingSource);
                console.log(kleur.yellow(`  ⚠ Skipping missing source file: ${missingSource}`));
                continue;
            }

            if (dryRun) {
                const action = isDrifted ? 'overwrite' : 'install';
                console.log(kleur.dim(`  [DRY RUN] would ${action} ${relativePath}`));
                installed += 1;
                continue;
            }

            await fs.ensureDir(path.dirname(targetPath));
            await fs.copy(sourcePath, targetPath, { overwrite: true });
            installed += 1;
        }
    }

    if (strictRegistry && missingSources.length > 0) {
        throw new Error([
            'Registry/source mismatch: missing package source files.',
            formatMissingSources(missingSources),
        ].join('\n'));
    }

    // Snapshot the package registry into the target .xtrm/ so `xt update
    // --root` and downstream tooling can identify this repo as managed.
    // Without this, freshly-init'd repos show as "incomplete" until the
    // operator manually copies registry.json from the xtrm-tools package
    // (see xtrm-ya2i).
    //
    // xtrm-5ts3l: when the "project" being installed into IS the xtrm-tools
    // source repo (packageRoot === installRepoRoot), the snapshot target
    // path IS the source registry itself. Filtered snapshotting-into-self
    // would strip every global-scoped asset (hooks/skills/skills_optional)
    // from the master registry — leaving only `config`. Skip in that case:
    // the source registry is already authoritative and never needs seeding.
    // installRepoRoot is derived from userXtrmDir (getContext); packageRoot is
    // resolvePackageRoot(). Both internal, not user input.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    if (!dryRun && path.resolve(installRepoRoot) !== path.resolve(packageRoot)) {
        await fs.ensureDir(userXtrmDir);
        // Both inputs internal: userXtrmDir resolved by getContext from package
        // config; 'registry.json' is a hardcoded filename. No user input here.
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const targetRegistryPath = path.join(userXtrmDir, 'registry.json');
        await fs.writeJson(targetRegistryPath, createProjectRegistrySnapshot(registry, installRepoRoot), { spaces: 2 });
        await fs.appendFile(targetRegistryPath, '\n');
    }

    return {
        installed,
        upToDate: upToDateSet.size,
        driftedSkipped: force ? 0 : driftedSet.size,
        forced,
        expectedInstalls,
        missingSourceSkipped,
    };
}
