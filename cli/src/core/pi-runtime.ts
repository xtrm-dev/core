/**
 * Unified Pi runtime service: extensions + packages + config.
 *
 * Models all Pi-related installation in a single registry.
 * Provides inventory -> plan -> sync/repair -> verify lifecycle.
 *
 * Unifies the previously split flows:
 * - pi-install.ts (runPiInstall) — non-interactive sync
 * - install-pi.ts (createInstallPiCommand) — interactive setup
 *
 * Solves xtrm-920d: mirror sync removes stale extensions from target.
 */

import { spawnSync } from 'child_process';
import fs from 'fs-extra';
import kleur from 'kleur';
import path from 'path';
import { homedir } from 'node:os';
import { t, sym } from '../utils/theme.js';
import { resolveSkillsRoot } from './skills-layout.js';
import { validateSkillsInvariants } from './skill-discovery.js';

import { hasProjectScopedSkillsContent } from './project-skills-content.js';

// Resolve xtrm-tools package root from __dirname (cli/dist/ -> ../..)
declare const __dirname: string;

const MANAGED_PI_EXTENSION_SOURCE_CANDIDATES = [
    ['packages', 'pi-extensions', 'extensions'],
    ['.xtrm', 'extensions'],
] as const;
const MANAGED_PI_EXTENSION_MANIFEST_CANDIDATES = [
    ['packages', 'pi-extensions', 'src', 'manifest.json'],
] as const;
const MANAGED_PI_THEME_SOURCE_CANDIDATES = [
    ['packages', 'pi-extensions', 'themes', 'xtrm-ui'],
    ['.xtrm', 'themes', 'xtrm-ui'],
] as const;

function resolveFirstExistingPath(
    rootDir: string,
    candidates: readonly (readonly string[])[],
): string | null {
    for (const candidate of candidates) {
        const candidatePath = path.join(rootDir, ...candidate);
        if (fs.existsSync(candidatePath)) {
            return candidatePath;
        }
    }

    return null;
}

function resolvePkgRoot(): string {
    const candidates = [
        path.resolve(__dirname, '../..'),
        path.resolve(__dirname, '../../..'),
    ];
    for (const candidateRoot of candidates) {
        if (resolveFirstExistingPath(candidateRoot, MANAGED_PI_EXTENSION_SOURCE_CANDIDATES)) {
            return candidateRoot;
        }
    }
    return candidates[0];
}

type PiExtensionManifestEntry = {
    readonly id: string;
    readonly displayName: string;
    readonly required: boolean;
};

type PiExtensionManifest = {
    readonly active: readonly PiExtensionManifestEntry[];
    readonly disabled: Readonly<Record<string, string>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadPiExtensionManifest(pkgRoot: string): PiExtensionManifest {
    const manifestPath = resolveFirstExistingPath(pkgRoot, MANAGED_PI_EXTENSION_MANIFEST_CANDIDATES);
    if (!manifestPath) return { active: [], disabled: {} };

    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!isRecord(parsed) || !Array.isArray(parsed.active) || !isRecord(parsed.disabled)) {
        throw new Error(`Invalid managed Pi extension manifest: ${manifestPath}`);
    }

    const activeEntries: readonly unknown[] = parsed.active;
    const active = activeEntries.map((entry) => {
        if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.displayName !== 'string' || typeof entry.required !== 'boolean') {
            throw new Error(`Invalid active managed Pi extension entry in ${manifestPath}`);
        }
        return { id: entry.id, displayName: entry.displayName, required: entry.required };
    });
    const disabled = Object.fromEntries(Object.entries(parsed.disabled).map(([id, reason]) => {
        if (typeof reason !== 'string' || reason.length === 0) {
            throw new Error(`Invalid managed Pi extension reason for '${id}' in ${manifestPath}`);
        }
        return [id, reason];
    }));

    return { active, disabled };
}

const MANAGED_PI_EXTENSION_MANIFEST = loadPiExtensionManifest(resolvePkgRoot());

export function resolveManagedPiExtensionsSourceDir(pkgRoot: string = resolvePkgRoot()): string | null {
    return resolveFirstExistingPath(pkgRoot, MANAGED_PI_EXTENSION_SOURCE_CANDIDATES);
}

function resolveManagedPiThemesSourceDir(pkgRoot: string = resolvePkgRoot()): string | null {
    return resolveFirstExistingPath(pkgRoot, MANAGED_PI_THEME_SOURCE_CANDIDATES);
}

export function resolveManagedPiCoreSourceDir(pkgRoot: string = resolvePkgRoot()): string | null {
    return resolveFirstExistingPath(pkgRoot, [
        ['packages', 'pi-extensions', 'src', 'core'],
    ]);
}

const PI_AGENT_DIR = process.env.PI_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
const MANAGED_XTRM_THEME_FILES = [
    'xtrm-dark.json',
    'xtrm-dark-flattools.json',
    'xtrm-light.json',
    'xtrm-light-flattools.json',
] as const;

export async function syncManagedPiThemes(
    sourceDir: string | null,
    dryRun: boolean,
    log?: (message: string) => void,
    themeDir = path.join(PI_AGENT_DIR, 'themes'),
): Promise<boolean> {
    if (!sourceDir || !await fs.pathExists(sourceDir)) return false;

    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- name is a closed package-owned allowlist.
    const missing = MANAGED_XTRM_THEME_FILES.filter((name) => !fs.existsSync(path.join(sourceDir, name)));
    if (missing.length > 0) {
        throw new Error(`Missing managed Pi theme files: ${missing.join(', ')}`);
    }

    const needsSync = await Promise.all(MANAGED_XTRM_THEME_FILES.map(async (name) => {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- name is a closed package-owned allowlist.
        const target = path.join(themeDir, name);
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const expected = path.relative(themeDir, path.join(sourceDir, name));
        const current = await fs.readlink(target).catch(() => null);
        return current !== expected;
    })).then(results => results.some(Boolean));

    if (!needsSync) return false;
    if (dryRun) {
        log?.(`[DRY RUN] sync XTRM Pi themes → ${themeDir}`);
        return true;
    }

    await fs.ensureDir(themeDir);
    for (const name of MANAGED_XTRM_THEME_FILES) {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- name is a closed package-owned allowlist.
        const target = path.join(themeDir, name);
        await fs.remove(target);
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- name is a closed package-owned allowlist.
        await fs.symlink(path.relative(themeDir, path.join(sourceDir, name)), target);
    }
    log?.('Synced XTRM Pi themes');
    return true;
}

const PI_MCP_ADAPTER_OVERRIDE_DIR = path.join(PI_AGENT_DIR, 'extensions', 'pi-mcp-adapter');
const PI_MCP_ADAPTER_REQUIRED_ENTRY = 'commands.js';

async function resolveGlobalNpmRootDir(): Promise<string | null> {
    const result = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) return null;

    const npmRootDir = (result.stdout ?? '').trim();
    return npmRootDir.length > 0 ? npmRootDir : null;
}
const PROJECT_EXTENSIONS_ENTRY = '../.xtrm/extensions';
export const LEGACY_XTRM_SKILLS_ENTRIES = new Set([
    '../.xtrm/skills/active',
    '../.xtrm/skills/active/pi',
    '../.xtrm/skills/active/claude',
    '~/.xtrm/skills/active',
    '~/.xtrm/skills/active/pi',
    '~/.xtrm/skills/active/claude',
    '~/.xtrm/skills/default',
]);
const PROJECT_EXTENSION_PACKAGE_ID = 'npm:@jaggerxtrm/pi-extensions';
const PROJECT_EXTENSION_PACKAGE: ManagedPackage = {
    id: PROJECT_EXTENSION_PACKAGE_ID,
    displayName: '@jaggerxtrm/pi-extensions',
    required: true,
};
const CONFLICTING_PI_PACKAGE_IDS = new Set<string>(['npm:pi-dex']);
const LEGACY_PROJECT_EXTENSION_ENTRIES = new Set<string>([
    PROJECT_EXTENSIONS_ENTRY,
    '.xtrm/extensions',
]);

export function runExternalPiToolPatch(pkgRoot: string, dryRun: boolean, log?: (message: string) => void): void {
    const scriptPath = path.join(pkgRoot, 'scripts', 'patch-external-pi-tools.mjs');
    if (!fs.existsSync(scriptPath)) return;

    if (dryRun) {
        log?.(`[DRY RUN] node ${scriptPath}`);
        return;
    }

    const result = spawnSync('node', [scriptPath], { encoding: 'utf8' });
    if (result.status !== 0) {
        const stderr = (result.stderr ?? '').trim();
        if (stderr) log?.(`external tool patch failed: ${stderr}`);
    } else {
        log?.('external tool compact/spacing patches applied');
    }
}

// ── Extension Registry ───────────────────────────────────────────────────────

export interface ManagedExtension {
    /** Extension directory name */
    id: string;
    /** Human-readable name */
    displayName: string;
    /** Required for XTRM workflow */
    required: boolean;
}

const MANAGED_EXTENSIONS: ManagedExtension[] = MANAGED_PI_EXTENSION_MANIFEST.active.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    required: entry.required,
}));
const MANAGED_PI_EXTENSION_IDS = new Set(MANAGED_EXTENSIONS.map((extension) => extension.id));
const MANAGED_PI_EXTENSION_OWNED_IDS = new Set([
    ...MANAGED_PI_EXTENSION_IDS,
    ...Object.keys(MANAGED_PI_EXTENSION_MANIFEST.disabled),
]);

// ── Package Registry ─────────────────────────────────────────────────────────

export interface ManagedPackage {
    /** Package ID as used by Pi: npm:<spec> or git:<repo>. */
    id: string;
    /** Human-readable name */
    displayName: string;
    /** Required for the core XTRM workflow; optional packages are still managed. */
    required: boolean;
}

const MANAGED_PACKAGES: ManagedPackage[] = [
    { id: 'npm:pi-gitnexus', displayName: 'pi-gitnexus', required: true },
    { id: 'npm:@robhowley/pi-structured-return', displayName: 'pi-structured-return', required: true },
    { id: 'npm:@aliou/pi-guardrails', displayName: 'pi-guardrails', required: false },
    { id: 'npm:@narumitw/pi-goal', displayName: 'pi-goal', required: false },
    { id: 'git:github.com/DietrichGebert/ponytail', displayName: 'ponytail', required: false },
    { id: 'npm:@tintinweb/pi-tasks', displayName: 'pi-tasks', required: false },
    { id: 'npm:pi-background-tasks@latest', displayName: 'pi-background-tasks', required: true },
    { id: 'npm:pi-mcp-adapter', displayName: 'pi-mcp-adapter', required: true },
    { id: 'npm:pi-mermaid-viewer', displayName: 'pi-mermaid-viewer', required: false },
    { id: 'npm:@jaggerxtrm/pi-service-knowledge', displayName: 'pi-service-knowledge', required: true },
    { id: 'npm:pi-intercom', displayName: 'pi-intercom', required: true },
    { id: 'git:github.com/alonw0/pi-claude-link', displayName: 'pi-claude-link', required: true },
    { id: 'npm:pi-ast-grep', displayName: 'pi-ast-grep', required: true },
];

const PROJECT_REQUIRED_PACKAGE_IDS = [
    PROJECT_EXTENSION_PACKAGE_ID,
    ...MANAGED_PACKAGES.map(pkg => pkg.id),
];

export function getXtManagedPiPackages(): ManagedPackage[] {
    return [PROJECT_EXTENSION_PACKAGE, ...MANAGED_PACKAGES];
}

// ── Inventory ─────────────────────────────────────────────────────────────────

export interface ExtensionStatus {
    ext: ManagedExtension;
    installed: boolean;
    hash?: string;
    stale?: boolean;
}

export interface PackageStatus {
    pkg: ManagedPackage;
    installed: boolean;
}

export type PiPackageFreshnessState = 'missing' | 'current' | 'outdated' | 'version-unknown';

export interface PiPackageAssuranceStatus {
    pkg: ManagedPackage;
    npmPackageName: string;
    installedVersion: string | null;
    expectedVersion: string | null;
    state: PiPackageFreshnessState;
}

export interface PiPackageAssuranceResult {
    statuses: PiPackageAssuranceStatus[];
    missing: PiPackageAssuranceStatus[];
    outdated: PiPackageAssuranceStatus[];
    installed: string[];
    refreshed: string[];
    failed: string[];
}

export interface XtManagedPiPackageDoctorIssue {
    pkg: ManagedPackage;
    npmPackageName: string;
    installedVersion: string | null;
    expectedVersion: string | null;
    state: PiPackageFreshnessState;
    remediation: string;
}

export interface XtManagedPiPackageDoctorReport {
    issues: XtManagedPiPackageDoctorIssue[];
    missing: XtManagedPiPackageDoctorIssue[];
    outdated: XtManagedPiPackageDoctorIssue[];
    ok: XtManagedPiPackageDoctorIssue[];
    hasIssues: boolean;
}

export interface PiPackageVersionInfo {
    installedVersion: string | null;
    expectedVersion: string | null;
}

export type PiPackageVersionProvider = (
    piPackageId: string,
    npmPackageName: string,
    pkg: ManagedPackage,
) => PiPackageVersionInfo | Promise<PiPackageVersionInfo>;

export interface PiPackageFreshnessStatus {
    pkg: ManagedPackage;
    npmPackageName: string;
    installedVersion: string | null;
    expectedVersion: string | null;
    state: PiPackageFreshnessState;
}

export interface PiRuntimePlan {
    extensions: ExtensionStatus[];
    packages: PackageStatus[];
    missingExtensions: ExtensionStatus[];
    staleExtensions: ExtensionStatus[];
    orphanedExtensions: string[];
    missingPackages: PackageStatus[];
    allRequiredPresent: boolean;
    allPresent: boolean;
}

/**
 * npm package name without Pi's `npm:` prefix or an install selector.
 * Examples:
 *   npm:foo@latest       -> foo
 *   npm:@scope/pkg@next -> @scope/pkg
 */
export function parseNpmPackageName(piPackageId: string): string | null {
    if (!piPackageId.startsWith('npm:')) return null;
    const spec = piPackageId.slice('npm:'.length).trim();
    if (!spec) return null;

    if (spec.startsWith('@')) {
        const slashIndex = spec.indexOf('/');
        if (slashIndex === -1) return spec;
        const selectorIndex = spec.indexOf('@', slashIndex + 1);
        return selectorIndex === -1 ? spec : spec.slice(0, selectorIndex);
    }

    const selectorIndex = spec.lastIndexOf('@');
    return selectorIndex > 0 ? spec.slice(0, selectorIndex) : spec;
}

export function normalizePiPackageIdentity(piPackageId: string): string {
    const npmPackageName = parseNpmPackageName(piPackageId);
    if (npmPackageName) return `npm:${npmPackageName}`;
    if (piPackageId.startsWith('git:')) {
        return piPackageId.split('#', 1)[0].replace(/\.git$/, '');
    }
    return piPackageId;
}

function isPiPackageInstalled(piPackageId: string, installedPackageIds: readonly string[]): boolean {
    const expected = normalizePiPackageIdentity(piPackageId);
    return installedPackageIds.some((installed) => normalizePiPackageIdentity(installed) === expected);
}

/** Parse `pi list` output to get installed npm/git package IDs. */
function getInstalledPiPackages(): string[] {
    const result = spawnSync('pi', ['list'], { encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) return [];

    const packages: string[] = [];
    for (const line of (result.stdout ?? '').split('\n')) {
        const match = line.match(/^\s+((?:npm|git):\S+)/);
        if (match) packages.push(match[1].replace(/[),;]+$/, ''));
    }

    return [...new Set(packages)].sort();
}

async function listInstalledExtensions(targetDir: string): Promise<string[]> {
    if (!await fs.pathExists(targetDir)) return [];
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    return entries
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => e.name)
        .sort();
}

export async function inventoryPiRuntime(
    sourceDir: string,
    targetDir: string,
): Promise<PiRuntimePlan> {
    const installedExtNames = await listInstalledExtensions(targetDir);
    const extensionStatuses: ExtensionStatus[] = [];
    const missingExtensions: ExtensionStatus[] = [];
    const staleExtensions: ExtensionStatus[] = [];
    const orphanedExtensions: string[] = [];

    for (const ext of MANAGED_EXTENSIONS) {
        const srcPath = path.join(sourceDir, ext.id);
        const dstPath = path.join(targetDir, ext.id);

        const srcExists = await fs.pathExists(srcPath);
        const dstExists = await fs.pathExists(dstPath);
        if (!srcExists) continue;

        if (!dstExists) {
            const status: ExtensionStatus = { ext, installed: false };
            extensionStatuses.push(status);
            missingExtensions.push(status);
            continue;
        }

        let isStale = false;
        if (srcPath !== dstPath) {
            const dstStat = await fs.lstat(dstPath);
            if (dstStat.isSymbolicLink()) {
                const linkTarget = await fs.readlink(dstPath);
                const resolvedTarget = path.resolve(path.dirname(dstPath), linkTarget);
                isStale = resolvedTarget !== path.resolve(srcPath);
            } else {
                isStale = true;
            }
        }
        const status: ExtensionStatus = { ext, installed: true, stale: isStale };
        extensionStatuses.push(status);
        if (isStale) staleExtensions.push(status);
    }

    for (const name of installedExtNames) {
        if (!MANAGED_PI_EXTENSION_IDS.has(name) && MANAGED_PI_EXTENSION_OWNED_IDS.has(name)) {
            orphanedExtensions.push(name);
        }
    }

    const installedPkgIds = getInstalledPiPackages();
    const packageStatuses: PackageStatus[] = [];
    const missingPackages: PackageStatus[] = [];

    for (const pkg of MANAGED_PACKAGES) {
        const isInstalled = isPiPackageInstalled(pkg.id, installedPkgIds);
        const status: PackageStatus = { pkg, installed: isInstalled };
        packageStatuses.push(status);
        if (!isInstalled) missingPackages.push(status);
    }

    const allRequiredPresent =
        missingExtensions.every(s => !s.ext.required) &&
        staleExtensions.every(s => !s.ext.required) &&
        missingPackages.every(s => !s.pkg.required);

    const allPresent =
        missingExtensions.length === 0 &&
        staleExtensions.length === 0 &&
        orphanedExtensions.length === 0 &&
        missingPackages.length === 0;

    return {
        extensions: extensionStatuses,
        packages: packageStatuses,
        missingExtensions,
        staleExtensions,
        orphanedExtensions,
        missingPackages,
        allRequiredPresent,
        allPresent,
    };
}

export function renderPiRuntimePlan(plan: PiRuntimePlan): void {
    console.log(kleur.bold('\n  Pi Runtime'));
    console.log(kleur.dim('  ' + '-'.repeat(50)));

    const extTotal = plan.extensions.length;
    const extOk = plan.extensions.filter(s => s.installed && !s.stale).length;
    console.log(kleur.dim(`  Extensions: ${extOk}/${extTotal} up-to-date`));

    if (plan.missingExtensions.length > 0) {
        console.log(kleur.yellow(`  Missing:    ${plan.missingExtensions.map(s => s.ext.displayName).join(', ')}`));
    }
    if (plan.staleExtensions.length > 0) {
        console.log(kleur.yellow(`  Stale:      ${plan.staleExtensions.map(s => s.ext.displayName).join(', ')}`));
    }
    if (plan.orphanedExtensions.length > 0) {
        console.log(kleur.red(`  Orphaned:   ${plan.orphanedExtensions.join(', ')} (will remove)`));
    }

    const pkgTotal = plan.packages.length;
    const pkgOk = plan.packages.filter(s => s.installed).length;
    console.log(kleur.dim(`  Packages:   ${pkgOk}/${pkgTotal} installed`));
    if (plan.missingPackages.length > 0) {
        console.log(kleur.yellow(`  Missing:    ${plan.missingPackages.map(s => s.pkg.displayName).join(', ')}`));
    }

    console.log(kleur.dim('  ' + '-'.repeat(50)));
    if (plan.allPresent) {
        console.log(t.success('  ✓ All extensions and packages present.\n'));
    } else if (plan.allRequiredPresent) {
        console.log(t.success('  ✓ All required items present.'));
        const optionalMissing = [
            ...plan.missingExtensions.filter(s => !s.ext.required),
            ...plan.missingPackages.filter(s => !s.pkg.required),
        ];
        if (optionalMissing.length > 0) {
            const names = optionalMissing.map(s => 'ext' in s ? s.ext.displayName : s.pkg.displayName).join(', ');
            console.log(kleur.dim(`  ○ Managed optional items not installed: ${names}\n`));
        } else {
            console.log('');
        }
    } else {
        console.log(kleur.yellow('  ⚠ Missing required items.\n'));
    }
}

export interface PiSyncOptions {
    dryRun?: boolean;
    isGlobal?: boolean;
    projectRoot?: string;
    removeOrphaned?: boolean;
    log?: (message: string) => void;
}

export interface PiSyncResult {
    extensionsAdded: string[];
    extensionsUpdated: string[];
    extensionsRemoved: string[];
    packagesInstalled: string[];
    failed: string[];
    changed: boolean;
}

function getProjectRequiredPackageStatuses(installedPkgIds: readonly string[]): PackageStatus[] {
    return PROJECT_REQUIRED_PACKAGE_IDS.map((packageId) => {
        const managed = getXtManagedPiPackages().find((pkg) => pkg.id === packageId);
        const pkg: ManagedPackage = managed ?? PROJECT_EXTENSION_PACKAGE;
        return { pkg, installed: isPiPackageInstalled(packageId, installedPkgIds) };
    });
}

function mergePiSyncResults(base: PiSyncResult, incoming: PiSyncResult): PiSyncResult {
    return {
        extensionsAdded: [...base.extensionsAdded, ...incoming.extensionsAdded],
        extensionsUpdated: [...base.extensionsUpdated, ...incoming.extensionsUpdated],
        extensionsRemoved: [...base.extensionsRemoved, ...incoming.extensionsRemoved],
        packagesInstalled: [...base.packagesInstalled, ...incoming.packagesInstalled],
        failed: [...base.failed, ...incoming.failed],
        changed: Boolean(base.changed || incoming.changed),
    };
}

function classifyPiPackageFreshness(info: PiPackageVersionInfo): PiPackageFreshnessState {
    if (!info.installedVersion) return 'missing';
    if (!info.expectedVersion) return 'version-unknown';
    return info.installedVersion === info.expectedVersion ? 'current' : 'outdated';
}

function resolveInstalledPiPackageJsonPath(
    agentDir: string,
    npmPackageName: string,
    npmRootDir?: string,
): string {
    const agentPackageJsonPath = path.join(agentDir, 'npm', 'node_modules', npmPackageName, 'package.json');
    if (fs.existsSync(agentPackageJsonPath) || !npmRootDir) return agentPackageJsonPath;
    return path.join(npmRootDir, npmPackageName, 'package.json');
}

export async function getInstalledPiPackageVersion(
    agentDir: string,
    npmPackageName: string,
    npmRootDir?: string,
): Promise<string | null> {
    const packageJsonPath = resolveInstalledPiPackageJsonPath(agentDir, npmPackageName, npmRootDir);
    if (!await fs.pathExists(packageJsonPath)) return null;

    try {
        const packageJson = await fs.readJson(packageJsonPath) as { version?: unknown };
        return typeof packageJson.version === 'string' ? packageJson.version : null;
    } catch {
        return null;
    }
}

const PI_PACKAGE_VERSION_LOOKUP_TIMEOUT_MS = 5000;
const NPMJS_REGISTRY_URL = 'https://registry.npmjs.org';

async function getExpectedPiPackageVersion(npmPackageName: string): Promise<string | null> {
    const result = spawnSync('npm', ['view', npmPackageName, 'version', '--registry', NPMJS_REGISTRY_URL], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: PI_PACKAGE_VERSION_LOOKUP_TIMEOUT_MS,
    });
    if (result.status !== 0) return null;
    const version = (result.stdout ?? '').trim();
    return version.length > 0 ? version : null;
}

export async function getManagedPiPackageFreshness(
    versionProvider: PiPackageVersionProvider,
    packages: readonly ManagedPackage[] = getXtManagedPiPackages(),
    installedPackageIds: readonly string[] = getInstalledPiPackages(),
): Promise<PiPackageFreshnessStatus[]> {
    const statuses: PiPackageFreshnessStatus[] = [];

    for (const pkg of packages) {
        const npmPackageName = parseNpmPackageName(pkg.id);
        if (!npmPackageName) {
            statuses.push({
                pkg,
                npmPackageName: '',
                installedVersion: null,
                expectedVersion: null,
                state: isPiPackageInstalled(pkg.id, installedPackageIds) ? 'current' : 'missing',
            });
            continue;
        }

        const info = await versionProvider(pkg.id, npmPackageName, pkg);
        const installedVersion = info.installedVersion ?? null;
        const expectedVersion = info.expectedVersion ?? null;
        statuses.push({
            pkg,
            npmPackageName,
            installedVersion,
            expectedVersion,
            state: classifyPiPackageFreshness({ installedVersion, expectedVersion }),
        });
    }

    return statuses;
}

export async function isPackagePresentInPiAgent(
    agentDir: string,
    piPackageId: string,
    npmRootDir?: string,
    installedPackageIds?: readonly string[],
): Promise<boolean> {
    const npmPackageName = parseNpmPackageName(piPackageId);
    if (!npmPackageName) {
        return isPiPackageInstalled(piPackageId, installedPackageIds ?? getInstalledPiPackages());
    }

    const agentPackageDir = path.join(agentDir, 'npm', 'node_modules', npmPackageName);
    if (await fs.pathExists(agentPackageDir)) return true;
    if (!npmRootDir) return false;
    return fs.pathExists(path.join(npmRootDir, npmPackageName));
}

interface PiPackageInstallResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

interface PiPackageInstallAttempt {
    status: number | null;
    output: string;
    retriedWithNpmjs: boolean;
}

export type PiPackageInstallRunner = (piPackageId: string, env?: NodeJS.ProcessEnv) => PiPackageInstallResult;

function runPiPackageInstall(piPackageId: string, env?: NodeJS.ProcessEnv): PiPackageInstallResult {
    const installResult = spawnSync('pi', ['install', piPackageId], {
        stdio: 'pipe',
        encoding: 'utf8',
        env,
    });

    return {
        status: installResult.status,
        stdout: installResult.stdout ?? '',
        stderr: installResult.stderr ?? '',
    };
}

function getPiPackageInstallOutput(result: PiPackageInstallResult): string {
    return `${result.stdout}\n${result.stderr}`.trim();
}

function buildNpmjsRegistryEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return {
        ...baseEnv,
        NPM_CONFIG_REGISTRY: NPMJS_REGISTRY_URL,
        npm_config_registry: NPMJS_REGISTRY_URL,
    };
}

export function shouldRetryPiInstallViaNpmjs(piPackageId: string, output: string): boolean {
    if (piPackageId !== PROJECT_EXTENSION_PACKAGE_ID) return false;
    const normalizedOutput = output.toLowerCase();
    return normalizedOutput.includes('npmmirror') && normalizedOutput.includes('404');
}

export function getPiPackageInstallFailureHint(piPackageId: string, output: string): string[] {
    if (!shouldRetryPiInstallViaNpmjs(piPackageId, output)) return [];
    return [
        `detected registry mirror 404 for ${piPackageId}`,
        `best fix: npm config set @jaggerxtrm:registry ${NPMJS_REGISTRY_URL}`,
    ];
}

function installPiPackageWithFallback(
    piPackageId: string,
    log?: (message: string) => void,
    installRunner: PiPackageInstallRunner = runPiPackageInstall,
): PiPackageInstallAttempt {
    const initialResult = installRunner(piPackageId);
    const initialOutput = getPiPackageInstallOutput(initialResult);

    if ((initialResult.status ?? 1) === 0) {
        return { status: initialResult.status, output: initialOutput, retriedWithNpmjs: false };
    }
    if (!shouldRetryPiInstallViaNpmjs(piPackageId, initialOutput)) {
        return { status: initialResult.status, output: initialOutput, retriedWithNpmjs: false };
    }

    log?.(kleur.dim(`Detected npmmirror 404 for ${piPackageId}; retrying via ${NPMJS_REGISTRY_URL}`));
    const retriedResult = installRunner(piPackageId, buildNpmjsRegistryEnv());
    const retriedOutput = getPiPackageInstallOutput(retriedResult);
    return {
        status: retriedResult.status,
        output: [initialOutput, retriedOutput].filter(Boolean).join('\n'),
        retriedWithNpmjs: true,
    };
}

export async function ensureAlwaysGlobalPiPackages(
    dryRun: boolean,
    log?: (message: string) => void,
    agentDir: string = PI_AGENT_DIR,
    installRunner: PiPackageInstallRunner = runPiPackageInstall,
    npmRootDir?: string | null,
    installedPackageIds?: readonly string[],
): Promise<{ installed: string[]; failed: string[] }> {
    const installed: string[] = [];
    const failed: string[] = [];
    const resolvedNpmRootDir = npmRootDir === undefined ? await resolveGlobalNpmRootDir() : npmRootDir;
    const resolvedInstalledPackageIds = installedPackageIds ?? getInstalledPiPackages();

    for (const pkg of getXtManagedPiPackages()) {
        if (await isPackagePresentInPiAgent(agentDir, pkg.id, resolvedNpmRootDir ?? undefined, resolvedInstalledPackageIds)) continue;

        if (dryRun) {
            log?.(`[DRY RUN] pi install ${pkg.id}`);
            continue;
        }

        const installAttempt = installPiPackageWithFallback(pkg.id, log, installRunner);
        if (installAttempt.status === 0) {
            installed.push(pkg.id);
            log?.(`${sym.ok} ${pkg.displayName} (global${installAttempt.retriedWithNpmjs ? ', npmjs fallback' : ''})`);
            continue;
        }

        failed.push(pkg.id);
        log?.(kleur.yellow(`⚠ ${pkg.displayName} — global install failed`));
        for (const hint of getPiPackageInstallFailureHint(pkg.id, installAttempt.output)) {
            log?.(kleur.yellow(`  → ${hint}`));
        }
    }

    return { installed, failed };
}

export async function assureXtManagedPiPackages(
    dryRun: boolean,
    log?: (message: string) => void,
    agentDir: string = PI_AGENT_DIR,
    installRunner: PiPackageInstallRunner = runPiPackageInstall,
    versionProvider?: PiPackageVersionProvider,
): Promise<PiPackageAssuranceResult> {
    const npmRootDir = await resolveGlobalNpmRootDir();
    const resolvedVersionProvider = versionProvider ?? (async (_piPackageId, npmPackageName) => ({
        installedVersion: await getInstalledPiPackageVersion(agentDir, npmPackageName, npmRootDir ?? undefined),
        expectedVersion: await getExpectedPiPackageVersion(npmPackageName),
    }));

    const statuses = await getManagedPiPackageFreshness(resolvedVersionProvider);
    const missing = statuses.filter((status) => status.state === 'missing');
    const outdated = statuses.filter((status) => status.state === 'outdated');
    const installed: string[] = [];
    const refreshed: string[] = [];
    const failed: string[] = [];

    for (const status of [...missing, ...outdated]) {
        if (dryRun) {
            log?.('[DRY RUN] pi install ' + status.pkg.id);
            continue;
        }

        const installAttempt = installPiPackageWithFallback(status.pkg.id, log, installRunner);
        if (installAttempt.status === 0) {
            if (status.state === 'missing') {
                installed.push(status.pkg.id);
                log?.(sym.ok + ' ' + status.pkg.displayName);
            } else {
                refreshed.push(status.pkg.id);
                log?.(sym.ok + ' ' + status.pkg.displayName + ' (refreshed)');
            }
            continue;
        }

        failed.push(status.pkg.id);
        log?.(kleur.yellow('⚠ ' + status.pkg.displayName + ' — ' + status.state + ' package update failed'));
        for (const hint of getPiPackageInstallFailureHint(status.pkg.id, installAttempt.output)) {
            log?.(kleur.yellow('  → ' + hint));
        }
    }

    return { statuses, missing, outdated, installed, refreshed, failed };
}

export async function getXtManagedPiPackageDoctorReport(
    versionProvider?: PiPackageVersionProvider,
): Promise<XtManagedPiPackageDoctorReport> {
    const npmRootDir = await resolveGlobalNpmRootDir();
    const resolvedVersionProvider = versionProvider ?? (async (_piPackageId, npmPackageName) => ({
        installedVersion: await getInstalledPiPackageVersion(PI_AGENT_DIR, npmPackageName, npmRootDir ?? undefined),
        expectedVersion: await getExpectedPiPackageVersion(npmPackageName),
    }));

    const statuses = await getManagedPiPackageFreshness(resolvedVersionProvider, getXtManagedPiPackages());
    const issues = statuses
        .filter((status) => status.state !== 'current')
        .map((status) => ({
            ...status,
            remediation: status.state === 'version-unknown'
                ? 'check network/npm registry, then rerun xt doctor'
                : 'pi install ' + status.pkg.id,
        }));

    const missing = issues.filter((issue) => issue.state === 'missing');
    const outdated = issues.filter((issue) => issue.state === 'outdated');
    const ok = statuses.filter((status) => status.state === 'current').map((status) => ({ ...status, remediation: '' }));

    return { issues, missing, outdated, ok, hasIssues: issues.length > 0 };
}

export type CoreSymlinkStatus = 'missing-source' | 'ok' | 'created' | 'repaired' | 'would-create' | 'would-repair';

export async function ensureCorePackageSymlink(
    coreSrcDir: string,
    projectRoot: string,
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<CoreSymlinkStatus> {
    if (!await fs.pathExists(coreSrcDir)) return 'missing-source';

    const extensionsDir = path.join(projectRoot, '.xtrm', 'extensions');
    const nodeModulesDir = path.join(extensionsDir, 'node_modules', '@xtrm');
    const symlinkPath = path.join(nodeModulesDir, 'pi-core');
    const expectedTarget = path.resolve(coreSrcDir);

    const existing = await fs.lstat(symlinkPath).catch(() => null);
    if (existing) {
        if (existing.isSymbolicLink()) {
            const currentLinkTarget = await fs.readlink(symlinkPath);
            const resolvedTarget = path.resolve(path.dirname(symlinkPath), currentLinkTarget);
            if (resolvedTarget === expectedTarget) return 'ok';
        }

        if (dryRun) {
            log?.(kleur.dim('[DRY RUN] would repair @xtrm/pi-core symlink target'));
            return 'would-repair';
        }

        await fs.remove(symlinkPath);
        await fs.ensureDir(nodeModulesDir);
        const relTarget = path.relative(nodeModulesDir, coreSrcDir);
        await fs.symlink(relTarget, symlinkPath);
        log?.(kleur.dim('Repaired @xtrm/pi-core symlink → .xtrm/extensions/node_modules/@xtrm/pi-core'));
        return 'repaired';
    }

    if (dryRun) {
        log?.(kleur.dim('[DRY RUN] would create @xtrm/pi-core symlink'));
        return 'would-create';
    }

    await fs.ensureDir(nodeModulesDir);
    const relTarget = path.relative(nodeModulesDir, coreSrcDir);
    await fs.symlink(relTarget, symlinkPath);
    log?.(kleur.dim('Created @xtrm/pi-core symlink → .xtrm/extensions/node_modules/@xtrm/pi-core'));
    return 'created';
}

export interface PiMcpAdapterOverrideCheck {
    path: string;
    found: boolean;
    stale: boolean;
    remediated: boolean;
    reason?: string;
}

export interface PiLaunchPreflightResult {
    coreSymlinkStatus: CoreSymlinkStatus;
    staleOverride: PiMcpAdapterOverrideCheck;
    themesChanged: boolean;
}

export async function remediateStalePiMcpAdapterOverride(
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<PiMcpAdapterOverrideCheck> {
    const stat = await fs.lstat(PI_MCP_ADAPTER_OVERRIDE_DIR).catch(() => null);
    if (!stat) {
        return { path: PI_MCP_ADAPTER_OVERRIDE_DIR, found: false, stale: false, remediated: false };
    }

    if (stat.isSymbolicLink()) {
        return { path: PI_MCP_ADAPTER_OVERRIDE_DIR, found: true, stale: false, remediated: false };
    }

    const hasRequiredEntry = await fs.pathExists(path.join(PI_MCP_ADAPTER_OVERRIDE_DIR, PI_MCP_ADAPTER_REQUIRED_ENTRY));
    if (stat.isDirectory() && hasRequiredEntry) {
        return { path: PI_MCP_ADAPTER_OVERRIDE_DIR, found: true, stale: false, remediated: false };
    }

    const reason = stat.isDirectory() ? `missing ${PI_MCP_ADAPTER_REQUIRED_ENTRY}` : 'not a directory/symlink';
    if (dryRun) {
        log?.(kleur.dim(`[DRY RUN] would remove stale pi-mcp-adapter override (${reason})`));
        return { path: PI_MCP_ADAPTER_OVERRIDE_DIR, found: true, stale: true, remediated: false, reason };
    }

    await fs.remove(PI_MCP_ADAPTER_OVERRIDE_DIR);
    log?.(kleur.dim(`Removed stale pi-mcp-adapter override (${reason})`));
    return { path: PI_MCP_ADAPTER_OVERRIDE_DIR, found: true, stale: true, remediated: true, reason };
}

export async function runPiLaunchPreflight(
    projectRoot: string,
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<PiLaunchPreflightResult> {
    const themesChanged = await syncManagedPiThemes(resolveManagedPiThemesSourceDir(), dryRun, log);
    const staleOverride = await remediateStalePiMcpAdapterOverride(dryRun, log);
    const coreSymlinkStatus = await ensureCorePackageSymlink(
        path.join(projectRoot, '.xtrm', 'extensions', 'core'),
        projectRoot,
        dryRun,
        log,
    );

    return { coreSymlinkStatus, staleOverride, themesChanged };
}

function isXtrmExtensionsSetting(entry: string): boolean {
    const normalizedEntry = entry.replaceAll('\\', '/').replace(/\/$/, '');
    return normalizedEntry === PROJECT_EXTENSIONS_ENTRY || normalizedEntry === '.xtrm/extensions';
}

async function cleanupLegacyProjectExtensionCopies(
    projectRoot: string,
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<{ removed: string[]; failed: string[]; pending: string[] }> {
    const piSettingsPath = path.join(projectRoot, '.pi', 'settings.json');
    let existingSettings: { extensions?: string[] } = {};
    try {
        existingSettings = await fs.readJson(piSettingsPath);
    } catch {
        return { removed: [], failed: [], pending: [] };
    }

    const pointsToXtrmExtensions = (existingSettings.extensions ?? []).some(isXtrmExtensionsSetting);
    if (!pointsToXtrmExtensions) return { removed: [], failed: [], pending: [] };

    const legacyExtensionsDir = path.join(projectRoot, '.pi', 'extensions');
    if (!await fs.pathExists(legacyExtensionsDir)) return { removed: [], failed: [], pending: [] };

    const removed: string[] = [];
    const failed: string[] = [];
    const pending: string[] = [];

    for (const ext of MANAGED_EXTENSIONS) {
        const legacyExtPath = path.join(legacyExtensionsDir, ext.id);
        const legacyStat = await fs.lstat(legacyExtPath).catch(() => null);
        if (!legacyStat || legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) continue;

        if (dryRun) {
            pending.push(ext.id);
            log?.(kleur.dim(`[DRY RUN] - .pi/extensions/${ext.id} (legacy copy)`));
            continue;
        }

        try {
            await fs.remove(legacyExtPath);
            removed.push(ext.id);
            log?.(kleur.dim(`Removed legacy .pi/extensions/${ext.id}`));
        } catch (err) {
            failed.push(ext.id);
            log?.(kleur.red(`✗ Failed to remove legacy .pi/extensions/${ext.id}: ${err}`));
        }
    }

    return { removed, failed, pending };
}

type PiSettingsShape = Record<string, unknown> & {
    extensions?: unknown;
    skills?: unknown;
    packages?: unknown;
    theme?: unknown;
};

const LEGACY_XTRM_THEMES: Record<string, string> = {
    'pidex-dark': 'xtrm-dark',
    'pidex-light': 'xtrm-light',
    'pidex-dark-flattools': 'xtrm-dark-flattools',
    'pidex-light-flattools': 'xtrm-light-flattools',
};

function normalizeXtrmTheme(theme: unknown): unknown {
    return typeof theme === 'string' ? LEGACY_XTRM_THEMES[theme] ?? theme : theme;
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
}

function normalizePiSkillsEntries(existingSkills: readonly string[]): string[] {
    return existingSkills.filter((entry, index) => existingSkills.indexOf(entry) === index && !LEGACY_XTRM_SKILLS_ENTRIES.has(entry));
}

async function appendSkillsPointerLog(event: {
    readonly scope: 'global' | 'project';
    readonly target: string;
    readonly existing: string | null;
    readonly action: 'normalize';
    readonly outcome: 'ok';
}): Promise<void> {
    const logPath = path.join(homedir(), '.xtrm', 'logs', 'skills-migration.jsonl');
    await fs.ensureDir(path.dirname(logPath));
    await fs.appendFile(logPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        component: 'skills-bootstrap',
        event: `pointer.${event.action}`,
        scope: event.scope,
        target: event.target,
        existing: event.existing,
        action: event.action,
        outcome: event.outcome,
    })}\n`);
}

export function pruneConflictingPiPackageEntries(entries: readonly string[]): { kept: string[]; removed: string[] } {
    const kept: string[] = [];
    const removed: string[] = [];
    for (const entry of entries) {
        if (CONFLICTING_PI_PACKAGE_IDS.has(entry)) removed.push(entry);
        else kept.push(entry);
    }
    return { kept, removed };
}

async function pruneConflictingPiPackagesFromSettings(
    settingsPath: string,
    scopeLabel: string,
    dryRun: boolean,
    migrateXtrmPreferences = false,
    log?: (message: string) => void,
): Promise<string[]> {
    if (!await fs.pathExists(settingsPath)) return [];

    let existingSettings: PiSettingsShape = {};
    try {
        existingSettings = await fs.readJson(settingsPath) as PiSettingsShape;
    } catch {
        return [];
    }

    const existingPackages = normalizeStringArray(existingSettings.packages);
    const { kept, removed } = pruneConflictingPiPackageEntries(existingPackages);
    const theme = migrateXtrmPreferences ? normalizeXtrmTheme(existingSettings.theme) : existingSettings.theme;
    const themeChanged = theme !== existingSettings.theme;
    const hasObsoleteCompactSetting = migrateXtrmPreferences && 'xtrmExternalCompact' in existingSettings;
    if (removed.length === 0 && !themeChanged && !hasObsoleteCompactSetting) return [];

    if (dryRun) {
        if (removed.length > 0) log?.(kleur.dim(`[DRY RUN] would remove conflicting Pi package(s) from ${scopeLabel}: ${removed.join(', ')}`));
        if (themeChanged) log?.(kleur.dim(`[DRY RUN] would migrate Pi theme in ${scopeLabel}: ${String(existingSettings.theme)} → ${String(theme)}`));
        if (hasObsoleteCompactSetting) log?.(kleur.dim(`[DRY RUN] would remove obsolete xtrmExternalCompact from ${scopeLabel}`));
        return removed;
    }

    const nextSettings: PiSettingsShape = { ...existingSettings };
    if (removed.length > 0) nextSettings.packages = kept;
    if (themeChanged) nextSettings.theme = theme;
    if (hasObsoleteCompactSetting) delete nextSettings.xtrmExternalCompact;
    await fs.writeJson(settingsPath, nextSettings, { spaces: 2 });
    if (removed.length > 0) log?.(kleur.dim(`Removed conflicting Pi package(s) from ${scopeLabel}: ${removed.join(', ')}`));
    if (themeChanged) log?.(kleur.dim(`Migrated Pi theme in ${scopeLabel}: ${String(existingSettings.theme)} → ${String(theme)}`));
    return removed;
}

export async function cleanupConflictingPiPackageSettings(
    projectRoot: string,
    dryRun: boolean,
    isGlobal: boolean,
    log?: (message: string) => void,
    agentDir = PI_AGENT_DIR,
): Promise<string[]> {
    const globalRemoved = await pruneConflictingPiPackagesFromSettings(
        path.join(agentDir, 'settings.json'),
        '~/.pi/agent/settings.json',
        dryRun,
        isGlobal,
        log,
    );
    const projectRemoved = await pruneConflictingPiPackagesFromSettings(
        path.join(projectRoot, '.pi', 'settings.json'),
        `${projectRoot}/.pi/settings.json`,
        dryRun,
        true,
        log,
    );
    return [...globalRemoved, ...projectRemoved];
}

async function reconcileProjectExtensionPackageEntry(
    packages: readonly string[],
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<string[]> {
    const ensured = await ensureGlobalDeclaresExtensionPackage(dryRun, log);
    if (!ensured) return [...packages];
    return packages.filter((entry) => entry !== PROJECT_EXTENSION_PACKAGE_ID);
}

export function isManagedPiExtensionsPackageEntry(entry: string): boolean {
    if (entry === PROJECT_EXTENSION_PACKAGE_ID) return true;
    if (entry.startsWith('npm:') || entry.startsWith('git:') || entry.startsWith('file:')) return false;
    const normalized = entry.replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = normalized.split('/').filter(Boolean);
    const base = segments[segments.length - 1];
    if (base !== 'pi-extensions') return false;
    return segments.length === 1 || segments[segments.length - 2] === 'packages';
}

async function ensureGlobalDeclaresExtensionPackage(
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<boolean> {
    const settingsPath = path.join(PI_AGENT_DIR, 'settings.json');
    let settings: PiSettingsShape;
    try {
        settings = await fs.readJson(settingsPath) as PiSettingsShape;
    } catch (error) {
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno !== 'ENOENT') {
            const msg = `⚠ cannot ensure global registration of ${PROJECT_EXTENSION_PACKAGE_ID}: ${settingsPath} unreadable (${errno ?? (error as Error).message}). Leaving per-repo entry in place.`;
            console.error(msg);
            log?.(msg);
            return false;
        }
        settings = {};
    }

    const globalPackages = normalizeStringArray(settings.packages);
    if (globalPackages.some((entry) => isManagedPiExtensionsPackageEntry(entry))) return true;
    if (dryRun) return true;

    try {
        await fs.ensureDir(PI_AGENT_DIR);
        await fs.writeJson(settingsPath, { ...settings, packages: [...globalPackages, PROJECT_EXTENSION_PACKAGE_ID] }, { spaces: 2 });
        return true;
    } catch (error) {
        const msg = `⚠ cannot ensure global registration of ${PROJECT_EXTENSION_PACKAGE_ID}: write to ${settingsPath} failed (${(error as Error).message}). Leaving per-repo entry in place.`;
        console.error(msg);
        log?.(msg);
        return false;
    }
}

export async function updatePiSettings(
    projectRoot: string,
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<boolean> {
    const piDirPath = path.join(projectRoot, '.pi');
    const piSettingsPath = path.join(piDirPath, 'settings.json');

    let existingSettings: PiSettingsShape = {};
    try {
        existingSettings = await fs.readJson(piSettingsPath) as PiSettingsShape;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const LEGACY_PACKAGE_IDS = new Set(['npm:@xtrm/pi-extensions', './extensions/']);
    const existingProjectPackages = normalizeStringArray(existingSettings.packages)
        .filter((entry) => !LEGACY_PACKAGE_IDS.has(entry) && !entry.startsWith('./extensions/'));
    const { kept } = pruneConflictingPiPackageEntries(existingProjectPackages);
    const existingPackages = await reconcileProjectExtensionPackageEntry(kept, dryRun, log);

    const existingSkills = normalizeStringArray(existingSettings.skills);
    const normalizedSkills = normalizePiSkillsEntries(existingSkills);
    const existingExtensions = normalizeStringArray(existingSettings.extensions)
        .filter((entry) => !LEGACY_PROJECT_EXTENSION_ENTRIES.has(entry));

    const nextSettings: PiSettingsShape = {
        ...existingSettings,
        extensions: existingExtensions,
        packages: existingPackages,
        theme: normalizeXtrmTheme(existingSettings.theme),
    };
    if (normalizedSkills.length > 0) nextSettings.skills = normalizedSkills;
    else delete nextSettings.skills;
    delete nextSettings.xtrmExternalCompact;

    const changed = JSON.stringify(existingSettings) !== JSON.stringify(nextSettings);
    if (!changed) return false;

    if (dryRun) {
        log?.(kleur.dim('[DRY RUN] would repair .pi/settings.json'));
        return true;
    }

    if (JSON.stringify(existingSkills) !== JSON.stringify(normalizedSkills)) {
        await appendSkillsPointerLog({
            scope: 'project',
            target: normalizedSkills.join(','),
            existing: existingSkills.join(',') || null,
            action: 'normalize',
            outcome: 'ok',
        });
    }

    await fs.ensureDir(piDirPath);
    await fs.writeJson(piSettingsPath, nextSettings, { spaces: 2 });
    log?.(kleur.dim(`Updated .pi/settings.json → ${existingPackages.join(' + ') || 'no project packages'} + ${normalizedSkills.join(' + ')}`));
    return true;
}

export async function executePiSync(
    plan: PiRuntimePlan,
    sourceDir: string,
    targetDir: string,
    opts: PiSyncOptions = {},
): Promise<PiSyncResult> {
    const {
        dryRun = false,
        isGlobal = false,
        projectRoot,
        removeOrphaned = true,
        log = (msg) => console.log(kleur.dim(`    ${msg}`)),
    } = opts;

    const result: PiSyncResult = {
        extensionsAdded: [],
        extensionsUpdated: [],
        extensionsRemoved: [],
        packagesInstalled: [],
        failed: [],
        changed: false,
    };

    if (!dryRun) await fs.ensureDir(targetDir);

    const toSync = [...plan.missingExtensions, ...plan.staleExtensions];
    for (const status of toSync) {
        const { ext } = status;
        const srcPath = path.join(sourceDir, ext.id);
        const dstPath = path.join(targetDir, ext.id);

        if (dryRun) {
            log(`[DRY RUN] ${status.installed ? '↻' : '+'} ${ext.displayName}`);
            continue;
        }

        try {
            await fs.remove(dstPath);
            const relTarget = path.relative(targetDir, srcPath);
            await fs.symlink(relTarget, dstPath);
            if (status.installed) {
                result.extensionsUpdated.push(ext.id);
                log(`↻ ${ext.displayName} (symlinked)`);
            } else {
                result.extensionsAdded.push(ext.id);
                log(`+ ${ext.displayName} (symlinked)`);
            }
        } catch (err) {
            result.failed.push(ext.id);
            log(kleur.red(`✗ ${ext.displayName}: ${err}`));
        }
    }

    if (removeOrphaned && plan.orphanedExtensions.length > 0) {
        for (const orphanId of plan.orphanedExtensions) {
            const orphanPath = path.join(targetDir, orphanId);
            if (dryRun) {
                log(kleur.red(`[DRY RUN] - ${orphanId} (orphaned)`));
                continue;
            }
            try {
                await fs.remove(orphanPath);
                result.extensionsRemoved.push(orphanId);
                log(kleur.red(`- ${orphanId} (orphaned)`));
            } catch (err) {
                result.failed.push(orphanId);
                log(kleur.red(`✗ ${orphanId}: ${err}`));
            }
        }
    }

    for (const status of plan.missingPackages) {
        const { pkg } = status;
        if (dryRun) {
            log(`[DRY RUN] pi install ${pkg.id}`);
            continue;
        }

        try {
            const installAttempt = installPiPackageWithFallback(pkg.id, log);
            if (installAttempt.status === 0) {
                result.packagesInstalled.push(pkg.id);
                log(`${sym.ok} ${pkg.displayName}${installAttempt.retriedWithNpmjs ? ' (npmjs fallback)' : ''}`);
            } else {
                result.failed.push(pkg.id);
                log(kleur.yellow(`⚠ ${pkg.displayName} — install failed`));
                for (const hint of getPiPackageInstallFailureHint(pkg.id, installAttempt.output)) log(kleur.yellow(`  → ${hint}`));
            }
        } catch (err) {
            result.failed.push(pkg.id);
            log(kleur.red(`✗ ${pkg.displayName}: ${err}`));
        }
    }

    return result;
}

export interface PiRuntimeOptions {
    dryRun?: boolean;
    isGlobal?: boolean;
    projectRoot?: string;
    skipGlobalPackageAssurance?: boolean;
    skipExternalToolPatch?: boolean;
}

export async function runPiRuntimeSync(opts: PiRuntimeOptions = {}): Promise<PiSyncResult> {
    const {
        dryRun = false,
        isGlobal = false,
        projectRoot,
        skipGlobalPackageAssurance = false,
        skipExternalToolPatch = false,
    } = opts;

    const pkgRoot = resolvePkgRoot();
    const sourceDir = resolveManagedPiExtensionsSourceDir(pkgRoot);
    const resolvedProjectRoot = projectRoot || process.cwd();
    const log = (msg: string) => console.log(kleur.dim(`    ${msg}`));

    const result: PiSyncResult = {
        extensionsAdded: [],
        extensionsUpdated: [],
        extensionsRemoved: [],
        packagesInstalled: [],
        failed: [],
        changed: false,
    };

    if (!sourceDir || !await fs.pathExists(sourceDir)) {
        console.log(kleur.dim('\n  Managed extensions: skipped (not bundled in npm package)\n'));
        return result;
    }

    const preflight = await runPiLaunchPreflight(resolvedProjectRoot, dryRun, log);
    result.changed = preflight.themesChanged
        || (preflight.coreSymlinkStatus !== 'ok' && preflight.coreSymlinkStatus !== 'missing-source')
        || preflight.staleOverride.stale;
    if (preflight.staleOverride.remediated) result.extensionsRemoved.push('pi-mcp-adapter');

    const conflictingPackages = await cleanupConflictingPiPackageSettings(resolvedProjectRoot, dryRun, isGlobal, log);
    result.changed ||= conflictingPackages.length > 0;

    if (isGlobal) {
        const targetDir = path.join(PI_AGENT_DIR, 'extensions');
        const plan = await inventoryPiRuntime(sourceDir, targetDir);
        renderPiRuntimePlan(plan);

        if (!plan.allPresent) {
            result.changed = true;
            const synced = await executePiSync(plan, sourceDir, targetDir, {
                dryRun,
                isGlobal: true,
                removeOrphaned: true,
            });
            Object.assign(result, mergePiSyncResults(result, synced));
        }

        if (!skipGlobalPackageAssurance) {
            const alwaysGlobalInstallResult = await ensureAlwaysGlobalPiPackages(dryRun, log);
            result.packagesInstalled.push(...alwaysGlobalInstallResult.installed);
            result.failed.push(...alwaysGlobalInstallResult.failed);
        }
        result.changed ||= result.extensionsAdded.length > 0
            || result.extensionsUpdated.length > 0
            || result.extensionsRemoved.length > 0
            || result.packagesInstalled.length > 0;
        return result;
    }

    const installedPkgIds = getInstalledPiPackages();
    const packageStatuses = getProjectRequiredPackageStatuses(installedPkgIds);
    const missingPackages = packageStatuses.filter((status) => !status.installed);

    console.log(kleur.bold('\n  Pi Runtime'));
    console.log(kleur.dim('  ' + '-'.repeat(50)));
    const extensionPackageInstalled = packageStatuses.some(
        (status) => status.pkg.id === PROJECT_EXTENSION_PACKAGE_ID && status.installed,
    );
    console.log(kleur.dim(`  Extensions: ${extensionPackageInstalled ? 'package installed' : 'package missing'} (${PROJECT_EXTENSION_PACKAGE_ID})`));
    const pkgOk = packageStatuses.filter((status) => status.installed).length;
    console.log(kleur.dim(`  Packages:   ${pkgOk}/${packageStatuses.length} installed`));
    if (missingPackages.length > 0) {
        console.log(kleur.yellow(`  Missing:    ${missingPackages.map((status) => status.pkg.displayName).join(', ')}`));
    }
    console.log(kleur.dim('  ' + '-'.repeat(50)));

    const legacyCleanup = await cleanupLegacyProjectExtensionCopies(resolvedProjectRoot, dryRun, log);
    result.extensionsRemoved.push(...legacyCleanup.removed);
    result.failed.push(...legacyCleanup.failed);
    result.changed ||= legacyCleanup.removed.length > 0 || legacyCleanup.pending.length > 0;

    const globalExtDir = path.join(PI_AGENT_DIR, 'extensions');
    if (await fs.pathExists(globalExtDir)) {
        const globalEntries = await fs.readdir(globalExtDir, { withFileTypes: true });
        for (const entry of globalEntries) {
            if (entry.isSymbolicLink() && MANAGED_PI_EXTENSION_OWNED_IDS.has(entry.name)) {
                if (!dryRun) await fs.remove(path.join(globalExtDir, entry.name));
                result.extensionsRemoved.push(entry.name);
                log(`Removed stale global symlink: ${entry.name}`);
            }
        }
        const staleNodeModules = path.join(globalExtDir, 'node_modules');
        if (await fs.pathExists(staleNodeModules)) {
            if (!dryRun) await fs.remove(staleNodeModules);
            log('Removed stale global extensions/node_modules');
        }
    }

    result.changed ||= missingPackages.length > 0;

    if (!skipGlobalPackageAssurance) {
        for (const status of missingPackages) {
            const { pkg } = status;
            if (dryRun) {
                log(`[DRY RUN] pi install ${pkg.id}`);
                continue;
            }

            try {
                const installAttempt = installPiPackageWithFallback(pkg.id, log);
                if (installAttempt.status === 0) {
                    result.packagesInstalled.push(pkg.id);
                    log(`${sym.ok} ${pkg.displayName}${installAttempt.retriedWithNpmjs ? ' (npmjs fallback)' : ''}`);
                    continue;
                }

                result.failed.push(pkg.id);
                log(kleur.yellow(`⚠ ${pkg.displayName} — install failed`));
                for (const hint of getPiPackageInstallFailureHint(pkg.id, installAttempt.output)) log(kleur.yellow(`  → ${hint}`));
            } catch (err) {
                result.failed.push(pkg.id);
                log(kleur.red(`✗ ${pkg.displayName}: ${err}`));
            }
        }
    }

    if (!skipGlobalPackageAssurance) {
        const alwaysGlobalInstallResult = await ensureAlwaysGlobalPiPackages(dryRun, log);
        result.packagesInstalled.push(...alwaysGlobalInstallResult.installed);
        result.failed.push(...alwaysGlobalInstallResult.failed);
    }

    const skillsRoot = resolveSkillsRoot(resolvedProjectRoot);
    if (await fs.pathExists(path.join(skillsRoot, 'default'))) {
        const invariantViolations = await validateSkillsInvariants(skillsRoot);
        if (invariantViolations.length > 0) {
            const summary = invariantViolations.map((violation) => `${violation.code}: ${violation.message}`).join('; ');
            throw new Error(`Skills invariants failed. ${summary}`);
        }

        const activeSkillsPath = path.join(skillsRoot, 'active');
        if (await fs.pathExists(activeSkillsPath)) {
            result.changed = true;
            if (!dryRun) await fs.remove(activeSkillsPath);
        }
    }

    if (!skipExternalToolPatch) runExternalPiToolPatch(pkgRoot, dryRun, log);

    result.changed ||= await updatePiSettings(resolvedProjectRoot, dryRun, log);
    result.changed ||= result.extensionsAdded.length > 0
        || result.extensionsUpdated.length > 0
        || result.extensionsRemoved.length > 0
        || result.packagesInstalled.length > 0;

    const requiredFailed = missingPackages.filter((status) => status.pkg.required && result.failed.includes(status.pkg.id));
    if (requiredFailed.length === 0) console.log(t.success('  ✓ All required items present.\n'));
    else console.log(kleur.yellow('  ⚠ Missing required items.\n'));

    return result;
}
