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
import { rebuildAllRuntimeActiveViews } from './skills-materializer.js';

// Resolve xtrm-tools package root from __dirname (cli/dist/ -> ../..)
declare const __dirname: string;

const MANAGED_PI_EXTENSION_SOURCE_CANDIDATES = [
    ['packages', 'pi-extensions', 'extensions'],
    ['.xtrm', 'extensions'],
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

export function resolveManagedPiExtensionsSourceDir(pkgRoot: string = resolvePkgRoot()): string | null {
    return resolveFirstExistingPath(pkgRoot, MANAGED_PI_EXTENSION_SOURCE_CANDIDATES);
}

export function resolveManagedPiCoreSourceDir(pkgRoot: string = resolvePkgRoot()): string | null {
    return resolveFirstExistingPath(pkgRoot, [
        ['packages', 'pi-extensions', 'src', 'core'],
        ['.xtrm', 'extensions', 'core'],
    ]);
}

const PI_AGENT_DIR = process.env.PI_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
const PI_MCP_ADAPTER_OVERRIDE_DIR = path.join(PI_AGENT_DIR, 'extensions', 'pi-mcp-adapter');
const PI_MCP_ADAPTER_REQUIRED_ENTRY = 'commands.js';
const PROJECT_EXTENSIONS_ENTRY = '../.xtrm/extensions';
const PROJECT_SKILLS_ENTRY = '../.xtrm/skills/active';
const PROJECT_EXTENSION_PACKAGE_ID = 'npm:@jaggerxtrm/pi-extensions';
const CONFLICTING_PI_PACKAGE_IDS = new Set<string>(['npm:pi-dex']);
const LEGACY_PROJECT_EXTENSION_ENTRIES = new Set<string>([
    PROJECT_EXTENSIONS_ENTRY,
    '.xtrm/extensions',
]);

function runExternalPiToolPatch(pkgRoot: string, dryRun: boolean, log?: (message: string) => void): void {
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
    /** Is this a library (excluded from settings.json packages list) */
    isLibrary?: boolean;
    /** Required for XTRM workflow */
    required: boolean;
}

const MANAGED_EXTENSIONS: ManagedExtension[] = [
    { id: 'core', displayName: '@xtrm/pi-core', isLibrary: true, required: true },
    { id: 'auto-session-name', displayName: 'auto-session-name', required: false },
    { id: 'auto-update', displayName: 'auto-update', required: false },
    { id: 'beads', displayName: 'beads', required: true },
    { id: 'compact-header', displayName: 'compact-header', required: false },
    { id: 'custom-footer', displayName: 'custom-footer', required: true },
    { id: 'custom-provider-qwen-cli', displayName: 'custom-provider-qwen-cli', required: false },
    { id: 'git-checkpoint', displayName: 'git-checkpoint', required: false },
    { id: 'lsp-bootstrap', displayName: 'lsp-bootstrap', required: false },
    { id: 'pi-serena-compact', displayName: 'pi-serena-compact', required: false },
    { id: 'quality-gates', displayName: 'quality-gates', required: true },
    { id: 'service-skills', displayName: 'service-skills', required: false },
    { id: 'session-flow', displayName: 'session-flow', required: true },
    { id: 'xtrm-loader', displayName: 'xtrm-loader', required: true },
    { id: 'xtrm-ui', displayName: 'xtrm-ui', required: true },
];

// ── Package Registry ─────────────────────────────────────────────────────────

export interface ManagedPackage {
    /** Package ID as used by pi (e.g., 'npm:pi-gitnexus') */
    id: string;
    /** Human-readable name */
    displayName: string;
    /** Required for XTRM workflow */
    required: boolean;
}

const MANAGED_PACKAGES: ManagedPackage[] = [
    { id: 'npm:pi-gitnexus', displayName: 'pi-gitnexus', required: true },
    { id: 'npm:pi-serena-tools', displayName: 'pi-serena-tools', required: true },
    { id: 'npm:@zenobius/pi-worktrees', displayName: 'pi-worktrees', required: true },
    { id: 'npm:@robhowley/pi-structured-return', displayName: 'pi-structured-return', required: true },
    { id: 'npm:@aliou/pi-guardrails', displayName: 'pi-guardrails', required: false },
    { id: 'npm:@aliou/pi-processes', displayName: 'pi-processes', required: true },
    { id: 'npm:pi-mcp-adapter', displayName: 'pi-mcp-adapter', required: true },
];

const ALWAYS_GLOBAL_INSTALL_PACKAGE_IDS = new Set<string>([
    'npm:pi-gitnexus',
    'npm:pi-serena-tools',
]);

const PROJECT_REQUIRED_PACKAGE_IDS = [
    PROJECT_EXTENSION_PACKAGE_ID,
    ...MANAGED_PACKAGES.map(pkg => pkg.id),
];

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

export interface PiRuntimePlan {
    extensions: ExtensionStatus[];
    packages: PackageStatus[];
    missingExtensions: ExtensionStatus[];
    staleExtensions: ExtensionStatus[];
    orphanedExtensions: string[];  // Extensions in target not in source (xtrm-920d)
    missingPackages: PackageStatus[];
    allRequiredPresent: boolean;
    allPresent: boolean;
}

/**
 * Parse `pi list` output to get installed package names.
 */
function getInstalledPiPackages(): string[] {
    const result = spawnSync('pi', ['list'], { encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) return [];

    const output = result.stdout;
    const packages: string[] = [];

    // Collect npm: packages from both User and Project sections
    // Project-scoped installs go to .pi/npm/node_modules/
    for (const line of output.split('\n')) {
        const match = line.match(/^\s+(npm:[\w\-/@]+)/);
        if (match) packages.push(match[1]);
    }

    return packages.sort();
}

/**
 * List extension directories in a target directory.
 */
async function listInstalledExtensions(targetDir: string): Promise<string[]> {
    if (!await fs.pathExists(targetDir)) return [];
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    return entries
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => e.name)
        .sort();
}

/**
 * Full inventory of Pi runtime state.
 */
export async function inventoryPiRuntime(
    sourceDir: string,
    targetDir: string,
): Promise<PiRuntimePlan> {
    // Extension inventory
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

        if (!srcExists) {
            // Extension not bundled in source — skip
            continue;
        }

        if (!dstExists) {
            const status: ExtensionStatus = { ext, installed: false };
            extensionStatuses.push(status);
            missingExtensions.push(status);
            continue;
        }

        // Stale detection: if dstPath is a symlink, verify it resolves to srcPath.
        // If it's a real copy (legacy), treat as stale so it gets replaced with a symlink.
        // Skip stale check when srcPath === dstPath (verification mode: Pi reads extensions
        // directly from source dir, no copy/symlink needed).
        let isStale = false;
        if (srcPath !== dstPath) {
            const dstStat = await fs.lstat(dstPath);
            if (dstStat.isSymbolicLink()) {
                const linkTarget = await fs.readlink(dstPath);
                const resolvedTarget = path.resolve(path.dirname(dstPath), linkTarget);
                isStale = resolvedTarget !== path.resolve(srcPath);
            } else {
                // Real copy — replace with symlink
                isStale = true;
            }
        }
        const status: ExtensionStatus = {
            ext,
            installed: true,
            stale: isStale,
        };
        extensionStatuses.push(status);

        if (isStale) {
            staleExtensions.push(status);
        }
    }

    // Detect orphaned extensions (in target but not in source registry)
    const managedIds = new Set(MANAGED_EXTENSIONS.map(e => e.id));
    for (const name of installedExtNames) {
        if (!managedIds.has(name)) {
            orphanedExtensions.push(name);
        }
    }

    // Package inventory
    const installedPkgIds = getInstalledPiPackages();
    const packageStatuses: PackageStatus[] = [];
    const missingPackages: PackageStatus[] = [];

    for (const pkg of MANAGED_PACKAGES) {
        const isInstalled = installedPkgIds.includes(pkg.id);
        const status: PackageStatus = { pkg, installed: isInstalled };
        packageStatuses.push(status);

        if (!isInstalled) {
            missingPackages.push(status);
        }
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

// ── Plan Rendering ───────────────────────────────────────────────────────────

export function renderPiRuntimePlan(plan: PiRuntimePlan): void {
    console.log(kleur.bold('\n  Pi Runtime'));
    console.log(kleur.dim('  ' + '-'.repeat(50)));

    // Extensions
    const extTotal = plan.extensions.length;
    const extOk = plan.extensions.filter(s => s.installed && !s.stale).length;

    console.log(kleur.dim(`  Extensions: ${extOk}/${extTotal} up-to-date`));

    if (plan.missingExtensions.length > 0) {
        const names = plan.missingExtensions.map(s => s.ext.displayName).join(', ');
        console.log(kleur.yellow(`  Missing:    ${names}`));
    }

    if (plan.staleExtensions.length > 0) {
        const names = plan.staleExtensions.map(s => s.ext.displayName).join(', ');
        console.log(kleur.yellow(`  Stale:      ${names}`));
    }

    if (plan.orphanedExtensions.length > 0) {
        const names = plan.orphanedExtensions.join(', ');
        console.log(kleur.red(`  Orphaned:   ${names} (will remove)`));
    }

    // Packages
    const pkgTotal = plan.packages.length;
    const pkgOk = plan.packages.filter(s => s.installed).length;

    console.log(kleur.dim(`  Packages:   ${pkgOk}/${pkgTotal} installed`));

    if (plan.missingPackages.length > 0) {
        const names = plan.missingPackages.map(s => s.pkg.displayName).join(', ');
        console.log(kleur.yellow(`  Missing:    ${names}`));
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
            const names = optionalMissing.map(s => 
                'ext' in s ? s.ext.displayName : s.pkg.displayName
            ).join(', ');
            console.log(kleur.dim(`  ○ Optional not installed: ${names}\n`));
        } else {
            console.log('');
        }
    } else {
        console.log(kleur.yellow('  ⚠ Missing required items.\n'));
    }
}

// ── Sync Execution ───────────────────────────────────────────────────────────

export interface PiSyncOptions {
    /** Dry run — print what would happen but don't write */
    dryRun?: boolean;
    /** Install to global ~/.pi/agent/ (default: project-scoped) */
    isGlobal?: boolean;
    /** Project root for project-scoped installs */
    projectRoot?: string;
    /** Remove orphaned extensions (xtrm-920d mirror behavior) */
    removeOrphaned?: boolean;
    /** Log function for progress messages */
    log?: (message: string) => void;
}

export interface PiSyncResult {
    extensionsAdded: string[];
    extensionsUpdated: string[];
    extensionsRemoved: string[];
    packagesInstalled: string[];
    failed: string[];
}

function getProjectRequiredPackageStatuses(installedPkgIds: readonly string[]): PackageStatus[] {
    return PROJECT_REQUIRED_PACKAGE_IDS.map((packageId) => {
        const managed = MANAGED_PACKAGES.find((pkg) => pkg.id === packageId);
        const pkg: ManagedPackage = managed ?? {
            id: PROJECT_EXTENSION_PACKAGE_ID,
            displayName: '@jaggerxtrm/pi-extensions',
            required: true,
        };

        return {
            pkg,
            installed: installedPkgIds.includes(packageId),
        };
    });
}

function mergePiSyncResults(base: PiSyncResult, incoming: PiSyncResult): PiSyncResult {
    return {
        extensionsAdded: [...base.extensionsAdded, ...incoming.extensionsAdded],
        extensionsUpdated: [...base.extensionsUpdated, ...incoming.extensionsUpdated],
        extensionsRemoved: [...base.extensionsRemoved, ...incoming.extensionsRemoved],
        packagesInstalled: [...base.packagesInstalled, ...incoming.packagesInstalled],
        failed: [...base.failed, ...incoming.failed],
    };
}

function parseNpmPackageName(piPackageId: string): string | null {
    if (!piPackageId.startsWith('npm:')) return null;
    const npmPackageName = piPackageId.slice(4).trim();
    return npmPackageName.length > 0 ? npmPackageName : null;
}

async function isPackagePresentInPiAgent(agentDir: string, piPackageId: string): Promise<boolean> {
    const npmPackageName = parseNpmPackageName(piPackageId);
    if (!npmPackageName) return false;

    const packageDir = path.join(agentDir, 'npm', 'node_modules', npmPackageName);
    return fs.pathExists(packageDir);
}

const NPMJS_REGISTRY_URL = 'https://registry.npmjs.org';

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
    if (!shouldRetryPiInstallViaNpmjs(piPackageId, output)) {
        return [];
    }

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
): Promise<{ installed: string[]; failed: string[] }> {
    const installed: string[] = [];
    const failed: string[] = [];

    const packagesToEnsure = MANAGED_PACKAGES.filter(pkg => ALWAYS_GLOBAL_INSTALL_PACKAGE_IDS.has(pkg.id));

    for (const pkg of packagesToEnsure) {
        if (await isPackagePresentInPiAgent(agentDir, pkg.id)) {
            continue;
        }

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

/**
 * Ensure @xtrm/pi-core is resolvable from .xtrm/extensions/node_modules/@xtrm/pi-core.
 * Creates a symlink pointing to the actual core source (not a mirror).
 */
export type CoreSymlinkStatus = 'missing-source' | 'ok' | 'created' | 'repaired' | 'would-create' | 'would-repair';

export async function ensureCorePackageSymlink(
    coreSrcDir: string,    // path to .xtrm/extensions/core (the actual source)
    projectRoot: string,
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<CoreSymlinkStatus> {
    if (!await fs.pathExists(coreSrcDir)) return 'missing-source';

    // Place symlink in .xtrm/extensions/node_modules/@xtrm/pi-core so that
    // Node.js module resolution from any extension under .xtrm/extensions/
    // can find @xtrm/pi-core by traversing up to .xtrm/extensions/node_modules/.
    // (.pi/node_modules/ is NOT on the resolution path from .xtrm/extensions/.)
    const extensionsDir = path.join(projectRoot, '.xtrm', 'extensions');
    const nodeModulesDir = path.join(extensionsDir, 'node_modules', '@xtrm');
    const symlinkPath = path.join(nodeModulesDir, 'pi-core');
    const expectedTarget = path.resolve(coreSrcDir);

    // Use lstat (not pathExists) so we detect broken symlinks too
    const existing = await fs.lstat(symlinkPath).catch(() => null);
    if (existing) {
        if (existing.isSymbolicLink()) {
            const currentLinkTarget = await fs.readlink(symlinkPath);
            const resolvedTarget = path.resolve(path.dirname(symlinkPath), currentLinkTarget);
            if (resolvedTarget === expectedTarget) {
                return 'ok';
            }
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
}

export async function remediateStalePiMcpAdapterOverride(
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<PiMcpAdapterOverrideCheck> {
    const stat = await fs.lstat(PI_MCP_ADAPTER_OVERRIDE_DIR).catch(() => null);
    if (!stat) {
        return {
            path: PI_MCP_ADAPTER_OVERRIDE_DIR,
            found: false,
            stale: false,
            remediated: false,
        };
    }

    if (stat.isSymbolicLink()) {
        return {
            path: PI_MCP_ADAPTER_OVERRIDE_DIR,
            found: true,
            stale: false,
            remediated: false,
        };
    }

    const hasRequiredEntry = await fs.pathExists(path.join(PI_MCP_ADAPTER_OVERRIDE_DIR, PI_MCP_ADAPTER_REQUIRED_ENTRY));
    if (stat.isDirectory() && hasRequiredEntry) {
        return {
            path: PI_MCP_ADAPTER_OVERRIDE_DIR,
            found: true,
            stale: false,
            remediated: false,
        };
    }

    const reason = stat.isDirectory()
        ? `missing ${PI_MCP_ADAPTER_REQUIRED_ENTRY}`
        : 'not a directory/symlink';

    if (dryRun) {
        log?.(kleur.dim(`[DRY RUN] would remove stale pi-mcp-adapter override (${reason})`));
        return {
            path: PI_MCP_ADAPTER_OVERRIDE_DIR,
            found: true,
            stale: true,
            remediated: false,
            reason,
        };
    }

    await fs.remove(PI_MCP_ADAPTER_OVERRIDE_DIR);
    log?.(kleur.dim(`Removed stale pi-mcp-adapter override (${reason})`));
    return {
        path: PI_MCP_ADAPTER_OVERRIDE_DIR,
        found: true,
        stale: true,
        remediated: true,
        reason,
    };
}

export async function runPiLaunchPreflight(
    projectRoot: string,
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<PiLaunchPreflightResult> {
    const staleOverride = await remediateStalePiMcpAdapterOverride(dryRun, log);
    const coreSymlinkStatus = await ensureCorePackageSymlink(
        path.join(projectRoot, '.xtrm', 'extensions', 'core'),
        projectRoot,
        dryRun,
        log,
    );

    return {
        coreSymlinkStatus,
        staleOverride,
    };
}

/**
 * Update .pi/settings.json with extension package paths.
 * Pi only auto-discovers global extensions — project-scoped needs settings.json.
 */
function isXtrmExtensionsSetting(entry: string): boolean {
    const normalizedEntry = entry.replaceAll('\\', '/').replace(/\/$/, '');
    return normalizedEntry === PROJECT_EXTENSIONS_ENTRY || normalizedEntry === '.xtrm/extensions';
}

async function cleanupLegacyProjectExtensionCopies(
    projectRoot: string,
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<{ removed: string[]; failed: string[] }> {
    const piSettingsPath = path.join(projectRoot, '.pi', 'settings.json');

    let existingSettings: { extensions?: string[] } = {};
    try {
        existingSettings = await fs.readJson(piSettingsPath);
    } catch {
        return { removed: [], failed: [] };
    }

    const pointsToXtrmExtensions = (existingSettings.extensions ?? []).some(isXtrmExtensionsSetting);
    if (!pointsToXtrmExtensions) return { removed: [], failed: [] };

    const legacyExtensionsDir = path.join(projectRoot, '.pi', 'extensions');
    if (!await fs.pathExists(legacyExtensionsDir)) return { removed: [], failed: [] };

    const removed: string[] = [];
    const failed: string[] = [];

    for (const ext of MANAGED_EXTENSIONS) {
        const legacyExtPath = path.join(legacyExtensionsDir, ext.id);
        const legacyStat = await fs.lstat(legacyExtPath).catch(() => null);
        if (!legacyStat || legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) {
            continue;
        }

        if (dryRun) {
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

    return { removed, failed };
}

type PiSettingsShape = Record<string, unknown> & {
    extensions?: unknown;
    skills?: unknown;
    packages?: unknown;
};

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
}

export function pruneConflictingPiPackageEntries(entries: readonly string[]): { kept: string[]; removed: string[] } {
    const kept: string[] = [];
    const removed: string[] = [];

    for (const entry of entries) {
        if (CONFLICTING_PI_PACKAGE_IDS.has(entry)) {
            removed.push(entry);
            continue;
        }
        kept.push(entry);
    }

    return { kept, removed };
}

async function pruneConflictingPiPackagesFromSettings(
    settingsPath: string,
    scopeLabel: string,
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<string[]> {
    if (!await fs.pathExists(settingsPath)) {
        return [];
    }

    let existingSettings: PiSettingsShape = {};
    try {
        existingSettings = await fs.readJson(settingsPath) as PiSettingsShape;
    } catch {
        return [];
    }

    const existingPackages = normalizeStringArray(existingSettings.packages);
    const { kept, removed } = pruneConflictingPiPackageEntries(existingPackages);
    if (removed.length === 0) {
        return [];
    }

    if (dryRun) {
        log?.(kleur.dim(`[DRY RUN] would remove conflicting Pi package(s) from ${scopeLabel}: ${removed.join(', ')}`));
        return removed;
    }

    await fs.writeJson(settingsPath, { ...existingSettings, packages: kept }, { spaces: 2 });
    log?.(kleur.dim(`Removed conflicting Pi package(s) from ${scopeLabel}: ${removed.join(', ')}`));
    return removed;
}

async function cleanupConflictingPiPackageSettings(
    projectRoot: string,
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<void> {
    await pruneConflictingPiPackagesFromSettings(
        path.join(PI_AGENT_DIR, 'settings.json'),
        '~/.pi/agent/settings.json',
        dryRun,
        log,
    );
    await pruneConflictingPiPackagesFromSettings(
        path.join(projectRoot, '.pi', 'settings.json'),
        `${projectRoot}/.pi/settings.json`,
        dryRun,
        log,
    );
}

async function updatePiSettings(
    projectRoot: string,
    dryRun: boolean,
    log?: (message: string) => void,
): Promise<void> {
    const piDirPath = path.join(projectRoot, '.pi');
    const piSettingsPath = path.join(piDirPath, 'settings.json');

    if (dryRun) {
        log?.(kleur.dim(`[DRY RUN] would ensure .pi/settings.json with ${PROJECT_EXTENSION_PACKAGE_ID}`));
        return;
    }

    await fs.ensureDir(piDirPath);

    let existingSettings: PiSettingsShape = {};
    try {
        existingSettings = await fs.readJson(piSettingsPath) as PiSettingsShape;
    } catch {
        existingSettings = {};
    }

    const LEGACY_PACKAGE_IDS = new Set(['npm:@xtrm/pi-extensions', './extensions/']);
    const existingProjectPackages = normalizeStringArray(existingSettings.packages)
        .filter((entry) => !LEGACY_PACKAGE_IDS.has(entry) && !entry.startsWith('./extensions/'));
    const { kept: existingPackages } = pruneConflictingPiPackageEntries(existingProjectPackages);
    if (!existingPackages.includes(PROJECT_EXTENSION_PACKAGE_ID)) {
        existingPackages.push(PROJECT_EXTENSION_PACKAGE_ID);
    }

    const existingSkills = normalizeStringArray(existingSettings.skills)
        .filter((entry) => entry !== PROJECT_SKILLS_ENTRY);
    existingSkills.unshift(PROJECT_SKILLS_ENTRY);

    const existingExtensions = normalizeStringArray(existingSettings.extensions)
        .filter((entry) => !LEGACY_PROJECT_EXTENSION_ENTRIES.has(entry));

    const nextSettings: PiSettingsShape = {
        ...existingSettings,
        extensions: existingExtensions,
        skills: existingSkills,
        packages: existingPackages,
    };

    await fs.writeJson(piSettingsPath, nextSettings, { spaces: 2 });
    log?.(kleur.dim(`Updated .pi/settings.json → ${PROJECT_EXTENSION_PACKAGE_ID} + ${PROJECT_SKILLS_ENTRY}`));
}

/**
 * Execute Pi runtime sync.
 */
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
    };

    // Ensure target directory exists
    if (!dryRun) {
        await fs.ensureDir(targetDir);
    }

    // Sync missing + stale extensions
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
            // Remove stale copy/symlink, then create a relative symlink into .xtrm/extensions
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

    // Remove orphaned extensions (xtrm-920d)
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

    // Install missing packages (always global at ~/.pi/agent/npm/)
    for (const status of plan.missingPackages) {
        const { pkg } = status;
        const installArgs = ['install', pkg.id];

        if (dryRun) {
            log(`[DRY RUN] pi ${installArgs.join(' ')}`);
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
                for (const hint of getPiPackageInstallFailureHint(pkg.id, installAttempt.output)) {
                    log(kleur.yellow(`  → ${hint}`));
                }
            }
        } catch (err) {
            result.failed.push(pkg.id);
            log(kleur.red(`✗ ${pkg.displayName}: ${err}`));
        }
    }

    return result;
}

// ── Full Sync Flow ───────────────────────────────────────────────────────────

export interface PiRuntimeOptions {
    dryRun?: boolean;
    isGlobal?: boolean;
    projectRoot?: string;
}

/**
 * Run full Pi runtime sync flow: inventory -> plan -> sync.
 *
 * Global installs mirror extension directories into ~/.pi/agent/extensions/.
 * Project installs use package-based extension registration via `pi install npm:@jaggerxtrm/pi-extensions`.
 */
export async function runPiRuntimeSync(opts: PiRuntimeOptions = {}): Promise<PiSyncResult> {
    const { dryRun = false, isGlobal = false, projectRoot } = opts;

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
    };

    if (!sourceDir || !await fs.pathExists(sourceDir)) {
        console.log(kleur.dim('\n  Managed extensions: skipped (not bundled in npm package)\n'));
        return result;
    }

    const preflight = await runPiLaunchPreflight(resolvedProjectRoot, dryRun, log);
    if (preflight.staleOverride.remediated) {
        result.extensionsRemoved.push('pi-mcp-adapter');
    }

    await cleanupConflictingPiPackageSettings(resolvedProjectRoot, dryRun, log);

    if (isGlobal) {
        const targetDir = path.join(PI_AGENT_DIR, 'extensions');
        const plan = await inventoryPiRuntime(sourceDir, targetDir);
        renderPiRuntimePlan(plan);
        if (plan.allPresent) return result;

        const synced = await executePiSync(plan, sourceDir, targetDir, {
            dryRun,
            isGlobal: true,
            removeOrphaned: true,
        });
        return mergePiSyncResults(result, synced);
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
        const names = missingPackages.map((status) => status.pkg.displayName).join(', ');
        console.log(kleur.yellow(`  Missing:    ${names}`));
    }
    console.log(kleur.dim('  ' + '-'.repeat(50)));

    const legacyCleanup = await cleanupLegacyProjectExtensionCopies(resolvedProjectRoot, dryRun, log);
    result.extensionsRemoved.push(...legacyCleanup.removed);
    result.failed.push(...legacyCleanup.failed);

    // Clean stale global extension symlinks from pre-package-mode installs
    const globalExtDir = path.join(PI_AGENT_DIR, 'extensions');
    if (await fs.pathExists(globalExtDir)) {
        const MANAGED_EXT_IDS = new Set(MANAGED_EXTENSIONS.map(e => e.id));
        const STALE_SYMLINKS = new Set([...MANAGED_EXT_IDS, 'core', 'gitnexus', 'serena']);
        const globalEntries = await fs.readdir(globalExtDir, { withFileTypes: true });
        for (const entry of globalEntries) {
            if (entry.isSymbolicLink() && STALE_SYMLINKS.has(entry.name)) {
                if (!dryRun) {
                    await fs.remove(path.join(globalExtDir, entry.name));
                }
                result.extensionsRemoved.push(entry.name);
                log(`Removed stale global symlink: ${entry.name}`);
            }
        }
        const staleNodeModules = path.join(globalExtDir, 'node_modules');
        if (await fs.pathExists(staleNodeModules)) {
            if (!dryRun) {
                await fs.remove(staleNodeModules);
            }
            log('Removed stale global extensions/node_modules');
        }
    }

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
            for (const hint of getPiPackageInstallFailureHint(pkg.id, installAttempt.output)) {
                log(kleur.yellow(`  → ${hint}`));
            }
        } catch (err) {
            result.failed.push(pkg.id);
            log(kleur.red(`✗ ${pkg.displayName}: ${err}`));
        }
    }

    const alwaysGlobalInstallResult = await ensureAlwaysGlobalPiPackages(dryRun, log);
    result.packagesInstalled.push(...alwaysGlobalInstallResult.installed);
    result.failed.push(...alwaysGlobalInstallResult.failed);

    const skillsRoot = resolveSkillsRoot(resolvedProjectRoot);
    if (await fs.pathExists(path.join(skillsRoot, 'default'))) {
        const invariantViolations = await validateSkillsInvariants(skillsRoot);
        if (invariantViolations.length > 0) {
            const summary = invariantViolations.map((violation) => `${violation.code}: ${violation.message}`).join('; ');
            throw new Error(`Skills invariants failed. ${summary}`);
        }

        if (!dryRun) {
            await rebuildAllRuntimeActiveViews(skillsRoot);
        }
    }

    runExternalPiToolPatch(pkgRoot, dryRun, log);

    await updatePiSettings(resolvedProjectRoot, dryRun, log);

    const requiredFailed = missingPackages.filter((status) => status.pkg.required && result.failed.includes(status.pkg.id));
    if (requiredFailed.length === 0) {
        console.log(t.success('  ✓ All required items present.\n'));
    } else {
        console.log(kleur.yellow('  ⚠ Missing required items.\n'));
    }

    return result;
}
