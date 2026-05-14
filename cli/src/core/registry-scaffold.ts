import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'path';
import crypto from 'node:crypto';
import { t } from '../utils/theme.js';
import { checkDrift } from './drift.js';
import { confirmDestructiveAction } from '../utils/confirmation.js';

declare const __dirname: string;

export interface RegistryFileEntry {
    hash: string;
    version: string;
}

export interface RegistryAsset {
    source_dir: string;
    install_mode: 'copy' | 'symlink';
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
    'memory.md',
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
}): Promise<InstallStats> {
    const { packageRoot, registry, userXtrmDir, dryRun, force, yes, strictRegistry = false } = params;
    const registryPath = path.join(packageRoot, '.xtrm', 'registry.json');

    const drift = await checkDrift(registryPath, userXtrmDir);
    const expectedHashes = buildExpectedHashes(registry);

    const missingSet = new Set(drift.missing);
    const upToDateSet = new Set(drift.upToDate);
    const driftedSet = new Set(drift.drifted);

    if (!force) {
        const driftedSkills = drift.drifted.filter(isSkillsDefaultPath);
        if (driftedSkills.length > 0) {
            console.log(kleur.yellow('\n  ⚠ Drift detected in .xtrm files (local modifications preserved by default):'));
            for (const relativePath of driftedSkills.slice(0, 10)) {
                const absolutePath = path.join(userXtrmDir, relativePath);
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
                const absolutePath = path.join(userXtrmDir, relativePath);
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

    for (const asset of Object.values(registry.assets)) {
        for (const [filePath] of Object.entries(asset.files)) {
            const relativePath = toUserRelativePath(asset.source_dir, filePath);
            const sourcePath = path.join(packageRoot, asset.source_dir, filePath);
            const targetPath = path.join(userXtrmDir, relativePath);

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
    if (!dryRun) {
        // Both inputs internal: userXtrmDir resolved by getContext from package
        // config; 'registry.json' is a hardcoded filename. No user input here.
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const targetRegistryPath = path.join(userXtrmDir, 'registry.json');
        await fs.copy(registryPath, targetRegistryPath, { overwrite: true });
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
