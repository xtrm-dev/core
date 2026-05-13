/**
 * Unified machine-bootstrap phase for managed third-party dependencies.
 *
 * Models all external CLIs used by the XTRM workflow in a single registry.
 * Provides inventory -> plan -> install -> verify lifecycle.
 */

import { spawnSync } from 'child_process';
import path from 'node:path';
import kleur from 'kleur';
import { t } from '../utils/theme.js';

// ── Dependency Registry ───────────────────────────────────────────────────────

export interface ManagedDependency {
    /** Unique identifier */
    id: string;
    /** Binary name to check on PATH */
    cli: string;
    /** Flag to get version (e.g. '--version', 'version') */
    versionFlag: string;
    /** Human-readable name for display */
    displayName: string;
    /** One-line description */
    description: string;
    /** Required = workflow gates depend on it; recommended = enhances workflow */
    required: boolean;
    /** Install instructions per platform */
    install: PlatformInstall;
}

interface PlatformInstall {
    /** Default install command (all platforms) */
    default: InstallStep[];
    /** macOS-specific override */
    darwin?: InstallStep[];
}

interface InstallStep {
    cmd: string;
    args: string[];
    /** If true, run with sudo on Linux */
    sudo?: boolean;
}

const OFFICIAL_CLAUDE_PLUGINS = ['serena', 'context7'] as const;
const OFFICIAL_MARKETPLACE = 'claude-plugins-official';

const MANAGED_DEPS: ManagedDependency[] = [
    {
        id: 'bd',
        cli: 'bd',
        versionFlag: '--version',
        displayName: 'beads (bd)',
        description: 'git-backed issue tracker — workflow enforcement backend',
        required: true,
        install: {
            default: [{ cmd: 'npm', args: ['install', '-g', '@beads/bd'] }],
        },
    },
    {
        id: 'dolt',
        cli: 'dolt',
        versionFlag: 'version',
        displayName: 'dolt',
        description: 'SQL+git storage backend for beads',
        required: true,
        install: {
            darwin: [{ cmd: 'brew', args: ['install', 'dolt'] }],
            default: [
                {
                    cmd: 'bash',
                    args: ['-c', 'curl -L https://github.com/dolthub/dolt/releases/latest/download/install.sh | bash'],
                    sudo: true,
                },
            ],
        },
    },
    {
        id: 'bv',
        cli: 'bv',
        versionFlag: '--version',
        displayName: 'bv',
        description: 'graph-aware triage for beads issues',
        required: true,
        install: {
            default: [
                {
                    cmd: 'bash',
                    args: ['-c', 'curl -fsSL https://raw.githubusercontent.com/Jaggerxtrm/beads_viewer/main/scripts/install-bv.sh | bash'],
                },
            ],
        },
    },
    {
        id: 'oh-pi',
        cli: 'pi',
        versionFlag: '--version',
        displayName: 'oh-pi (pi)',
        description: 'Pi agent runtime',
        required: true,
        install: {
            default: [{ cmd: 'npm', args: ['install', '-g', 'oh-pi'] }],
        },
    },
    {
        id: 'pnpm',
        cli: 'pnpm',
        versionFlag: '--version',
        displayName: 'pnpm',
        description: 'fast package manager — required by Pi extensions',
        required: true,
        install: {
            default: [{ cmd: 'npm', args: ['install', '-g', 'pnpm'] }],
        },
    },
    {
        id: 'gitnexus',
        cli: 'gitnexus',
        versionFlag: '--version',
        displayName: 'gitnexus',
        description: 'code intelligence — call graph, impact analysis',
        required: false,
        install: {
            default: [{ cmd: 'npm', args: ['install', '-g', 'gitnexus'] }],
        },
    },
    {
        id: 'deepwiki',
        cli: 'deepwiki',
        versionFlag: '--version',
        displayName: 'deepwiki',
        description: 'AI-powered repo documentation',
        required: false,
        install: {
            default: [{ cmd: 'npm', args: ['install', '-g', '@seflless/deepwiki'] }],
        },
    },
    {
        id: 'ctx7',
        cli: 'ctx7',
        versionFlag: '--version',
        displayName: 'ctx7',
        description: 'Context7 CLI — library docs lookup for specialists',
        required: false,
        install: {
            default: [{ cmd: 'npm', args: ['install', '-g', 'ctx7'] }],
        },
    },
];

// ── Inventory ─────────────────────────────────────────────────────────────────

export interface DependencyStatus {
    dep: ManagedDependency;
    installed: boolean;
    version?: string;
}

export interface BootstrapPlan {
    deps: DependencyStatus[];
    missingRequired: DependencyStatus[];
    missingRecommended: DependencyStatus[];
    allRequiredPresent: boolean;
    allPresent: boolean;
}

// Directories that install steps may write to but may NOT be in PATH yet
// in the same process (notably on fresh CI runners where ~/.local/bin is
// only added by .profile, which non-interactive shells don't source).
// We extend PATH once on module load so spawnSync can find them.
const FALLBACK_BIN_DIRS = [
    `${process.env.HOME ?? ''}/.local/bin`,
    '/usr/local/bin',
    '/opt/homebrew/bin',
].filter(Boolean);

(function extendPathOnce(): void {
    const currentPath = process.env.PATH ?? '';
    const existing = new Set(currentPath.split(path.delimiter));
    const additions = FALLBACK_BIN_DIRS.filter(dir => !existing.has(dir));
    if (additions.length > 0) {
        process.env.PATH = [currentPath, ...additions].filter(Boolean).join(path.delimiter);
    }
})();

function checkDep(dep: ManagedDependency): DependencyStatus {
    const result = spawnSync(dep.cli, [dep.versionFlag], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
    });

    if (result.status !== 0) {
        return { dep, installed: false };
    }

    const version = (result.stdout ?? '').trim().split('\n')[0]?.trim();
    return { dep, installed: true, version: version || undefined };
}

export function inventoryDeps(): BootstrapPlan {
    const deps = MANAGED_DEPS.map(checkDep);
    const missingRequired = deps.filter(d => !d.installed && d.dep.required);
    const missingRecommended = deps.filter(d => !d.installed && !d.dep.required);

    return {
        deps,
        missingRequired,
        missingRecommended,
        allRequiredPresent: missingRequired.length === 0,
        allPresent: deps.every(d => d.installed),
    };
}

// ── Plan Rendering ────────────────────────────────────────────────────────────

export function renderBootstrapPlan(plan: BootstrapPlan): void {
    console.log(kleur.bold('\n  Machine Bootstrap'));
    console.log(kleur.dim('  ' + '-'.repeat(50)));

    for (const status of plan.deps) {
        const { dep, installed, version } = status;
        const icon = installed ? kleur.green('  ✓') : (dep.required ? kleur.yellow('  +') : kleur.dim('  ○'));
        const label = dep.displayName.padEnd(20);
        const tag = dep.required ? '' : kleur.dim(' (recommended)');

        if (installed) {
            const ver = version ? kleur.dim(` ${version}`) : '';
            console.log(`${icon} ${label}${ver}`);
        } else {
            console.log(`${icon} ${label}${kleur.white('will install')}${tag}`);
        }
    }

    console.log(kleur.dim('  ' + '-'.repeat(50)));

    const { missingRequired, missingRecommended } = plan;
    if (missingRequired.length === 0 && missingRecommended.length === 0) {
        console.log(t.success('  All dependencies present.\n'));
    } else {
        const parts: string[] = [];
        if (missingRequired.length > 0) {
            parts.push(`${missingRequired.length} required`);
        }
        if (missingRecommended.length > 0) {
            parts.push(`${missingRecommended.length} recommended`);
        }
        console.log(kleur.dim(`  ${parts.join(', ')} to install\n`));
    }
}

// ── Execution ─────────────────────────────────────────────────────────────────

interface ExecuteOpts {
    /** Install recommended deps too (not just required) */
    includeRecommended?: boolean;
    /** Dry run — print what would happen but don't run anything */
    dryRun?: boolean;
}

export interface BootstrapResult {
    installed: string[];
    failed: string[];
    skipped: string[];
}

function getInstallSteps(dep: ManagedDependency): InstallStep[] {
    if (process.platform === 'darwin' && dep.install.darwin) {
        return dep.install.darwin;
    }
    return dep.install.default;
}

export function executeBootstrap(plan: BootstrapPlan, opts: ExecuteOpts = {}): BootstrapResult {
    const { includeRecommended = true, dryRun = false } = opts;
    const result: BootstrapResult = { installed: [], failed: [], skipped: [] };

    const toInstall = plan.deps.filter(d => {
        if (d.installed) return false;
        if (d.dep.required) return true;
        return includeRecommended;
    });

    if (toInstall.length === 0) return result;

    console.log(kleur.bold('\n  Installing dependencies...'));

    for (const status of toInstall) {
        const { dep } = status;
        const steps = getInstallSteps(dep);

        if (dryRun) {
            for (const step of steps) {
                const prefix = step.sudo ? 'sudo ' : '';
                console.log(kleur.dim(`  [DRY RUN] ${prefix}${step.cmd} ${step.args.join(' ')}`));
            }
            result.skipped.push(dep.id);
            continue;
        }

        console.log(kleur.dim(`\n  Installing ${dep.displayName}...`));

        let ok = true;
        for (const step of steps) {
            const cmd = step.sudo && process.platform !== 'darwin' ? 'sudo' : step.cmd;
            const args = step.sudo && process.platform !== 'darwin'
                ? [step.cmd, ...step.args]
                : step.args;

            const r = spawnSync(cmd, args, { stdio: 'inherit' });
            if (r.status !== 0) {
                ok = false;
                break;
            }
        }

        if (ok) {
            console.log(t.success(`  ✓ ${dep.displayName} installed`));
            result.installed.push(dep.id);
        } else {
            const installHint = steps.map(s => `${s.cmd} ${s.args.join(' ')}`).join(' && ');
            console.log(kleur.yellow(`  ⚠ Failed to install ${dep.displayName}. Run manually: ${installHint}`));
            result.failed.push(dep.id);
        }
    }

    // Mark deps that weren't in toInstall (recommended skipped)
    for (const d of plan.deps) {
        if (!d.installed && !toInstall.some(t => t.dep.id === d.dep.id)) {
            result.skipped.push(d.dep.id);
        }
    }

    return result;
}

// ── Verification ──────────────────────────────────────────────────────────────

export function verifyBootstrap(): BootstrapPlan {
    const plan = inventoryDeps();

    if (plan.allPresent) {
        console.log(t.success('\n  ✓ All managed dependencies verified.\n'));
    } else if (plan.allRequiredPresent) {
        const missing = plan.missingRecommended.map(d => d.dep.displayName).join(', ');
        console.log(t.success('\n  ✓ All required dependencies verified.'));
        console.log(kleur.dim(`  ○ Recommended not installed: ${missing}\n`));
    } else {
        const missing = plan.missingRequired.map(d => d.dep.displayName).join(', ');
        console.log(kleur.yellow(`\n  ⚠ Missing required dependencies: ${missing}`));
        console.log(kleur.dim('  Re-run xtrm init to install them.\n'));
    }

    return plan;
}

function normalizePluginName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
        return '';
    }

    if (trimmed.startsWith('@')) {
        return trimmed;
    }

    const atIndex = trimmed.indexOf('@');
    return atIndex === -1 ? trimmed : trimmed.slice(0, atIndex);
}

function readInstalledOfficialPlugins(): Set<string> | null {
    const listResult = spawnSync('claude', ['plugin', 'list', '--json'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000,
    });

    if (listResult.status !== 0) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(listResult.stdout ?? '[]');
    } catch {
        return null;
    }

    if (!Array.isArray(parsed)) {
        return null;
    }

    const installedNames = new Set<string>();
    for (const entry of parsed) {
        const rawName = typeof entry === 'string'
            ? entry
            : (entry && typeof entry === 'object' && 'name' in entry && typeof (entry as { name: unknown }).name === 'string')
                ? (entry as { name: string }).name
                : '';

        const normalized = normalizePluginName(rawName);
        if (normalized) {
            installedNames.add(normalized);
        }
    }

    return installedNames;
}

function ensureOfficialMarketplace(): void {
    // Register claude-plugins-official if not already present.
    // This can be wiped by --prune or a fresh Claude install.
    const listResult = spawnSync('claude', ['plugin', 'marketplace', 'list'], {
        encoding: 'utf8', stdio: 'pipe', timeout: 10000,
    });

    const output = listResult.stdout ?? '';
    if (output.includes(OFFICIAL_MARKETPLACE)) return;

    spawnSync('claude', [
        'plugin', 'marketplace', 'add',
        'https://github.com/anthropics/claude-plugins-official.git',
    ], { stdio: 'inherit', timeout: 120000 });
}

function tryInstallOfficialPlugin(pluginName: string): boolean {
    const directInstall = spawnSync('claude', ['plugin', 'install', pluginName, '--scope', 'user'], { stdio: 'inherit' });
    if (directInstall.status === 0) {
        return true;
    }

    const marketplaceQualified = `${pluginName}@${OFFICIAL_MARKETPLACE}`;
    const marketplaceInstall = spawnSync('claude', ['plugin', 'install', marketplaceQualified, '--scope', 'user'], { stdio: 'inherit' });
    return marketplaceInstall.status === 0;
}

function ensureOfficialPlugins(dryRun: boolean): void {
    const installed = readInstalledOfficialPlugins();
    if (!installed) {
        console.log(kleur.yellow('  ⚠ Could not determine Claude plugin state; skipping official plugin install check.'));
        return;
    }

    const missing = OFFICIAL_CLAUDE_PLUGINS.filter(pluginName => !installed.has(pluginName));
    if (missing.length === 0) {
        console.log(kleur.dim('  ✓ Official Claude plugins already installed: serena, context7'));
        return;
    }

    console.log(kleur.bold('\n  Ensuring official Claude plugins...'));
    ensureOfficialMarketplace();

    for (const pluginName of missing) {
        if (dryRun) {
            console.log(kleur.dim(`  [DRY RUN] claude plugin install ${pluginName} --scope user`));
            continue;
        }

        console.log(kleur.dim(`  Installing ${pluginName}...`));
        const installedOk = tryInstallOfficialPlugin(pluginName);
        if (installedOk) {
            console.log(t.success(`  ✓ ${pluginName} installed`));
        } else {
            console.log(kleur.yellow(`  ⚠ Failed to install ${pluginName}. Try: claude plugin install ${pluginName}@${OFFICIAL_MARKETPLACE}`));
        }
    }
}

// ── Convenience: Full Bootstrap Flow ──────────────────────────────────────────
// Runs inventory -> plan -> execute -> verify in one call.
// Used by the init orchestrator's machine-bootstrap phase.

export async function runMachineBootstrapPhase(opts: { dryRun?: boolean } = {}): Promise<BootstrapResult> {
    const plan = inventoryDeps();
    renderBootstrapPlan(plan);

    if (plan.allPresent) {
        ensureOfficialPlugins(opts.dryRun ?? false);
        return { installed: [], failed: [], skipped: [] };
    }

    const result = executeBootstrap(plan, {
        includeRecommended: true,
        dryRun: opts.dryRun,
    });

    if (!opts.dryRun) {
        verifyBootstrap();
    }

    ensureOfficialPlugins(opts.dryRun ?? false);

    return result;
}

// ── Individual Check Helpers (backward compat) ────────────────────────────────
// These thin wrappers preserve the existing function signatures used across the
// codebase so callers don't need immediate refactoring.

export function isBeadsInstalled(): boolean {
    return checkDep(MANAGED_DEPS.find(d => d.id === 'bd')!).installed;
}

export function isDoltInstalled(): boolean {
    return checkDep(MANAGED_DEPS.find(d => d.id === 'dolt')!).installed;
}

export function isBvInstalled(): boolean {
    return checkDep(MANAGED_DEPS.find(d => d.id === 'bv')!).installed;
}

export function isDeepwikiInstalled(): boolean {
    return checkDep(MANAGED_DEPS.find(d => d.id === 'deepwiki')!).installed;
}

export function isPiInstalled(): boolean {
    return checkDep(MANAGED_DEPS.find(d => d.id === 'oh-pi')!).installed;
}

export function isPnpmInstalled(): boolean {
    return checkDep(MANAGED_DEPS.find(d => d.id === 'pnpm')!).installed;
}

export function isGitNexusInstalled(): boolean {
    return checkDep(MANAGED_DEPS.find(d => d.id === 'gitnexus')!).installed;
}
