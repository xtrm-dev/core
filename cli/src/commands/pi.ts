import { Command } from 'commander';
import kleur from 'kleur';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import fs from 'fs-extra';
import { findRepoRoot } from '../utils/repo-root.js';
import { t } from '../utils/theme.js';
import { runPiInstall } from './pi-install.js';
import {
    ensureCorePackageSymlink,
    inventoryPiRuntime,
    remediateStalePiMcpAdapterOverride,
    resolveManagedPiCoreSourceDir,
    resolveManagedPiExtensionsSourceDir,
} from '../core/pi-runtime.js';
import { createInstallPiCommand } from './install-pi.js';
import { launchWorktreeSession } from '../utils/worktree-session.js';
import { confirmDestructiveAction } from '../utils/confirmation.js';

const PI_AGENT_DIR = process.env.PI_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
const RETIRED_PI_COMMANDS = new Set(['install']);
const RETIRED_PI_INSTALL_REDIRECT = 'xt pi install is retired — run: xt update --apply --repo <path> (planned removal: v0.13.0)';

const EXTENSION_PACKAGE_ID = 'npm:@jaggerxtrm/pi-extensions';

interface PiProjectPointer {
    hasProjectSettings: boolean;
    // xtrm-xnymw: `npm:@jaggerxtrm/pi-extensions` is global-only. The per-repo
    // entry must NEVER be present, so its presence is drift, not health.
    hasProjectPackageDrift: boolean;
    pointsToXtrmExtensions: boolean;
    globalDeclaresExtensionPackage: boolean;
}

function resolveProjectRoot(): string {
    const gitResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe',
    });
    return gitResult.status === 0 ? (gitResult.stdout ?? '').trim() : process.cwd();
}

function hasSettingsEntry(entries: unknown, expectedEntry: string): boolean {
    if (!Array.isArray(entries)) return false;
    return entries.some((entry) => {
        if (typeof entry !== 'string') return false;
        return entry.replace(/\\/g, '/') === expectedEntry;
    });
}

async function globalDeclaresExtensionPackage(): Promise<boolean> {
    try {
        const settings = await fs.readJson(path.join(PI_AGENT_DIR, 'settings.json')) as { packages?: unknown };
        const packages = Array.isArray(settings.packages)
            ? settings.packages.filter((entry): entry is string => typeof entry === 'string')
            : [];
        return packages.includes(EXTENSION_PACKAGE_ID);
    } catch {
        return false;
    }
}

async function getPiProjectPointer(projectRoot: string): Promise<PiProjectPointer> {
    const settingsPath = path.join(projectRoot, '.pi', 'settings.json');
    const hasSettingsFile = await fs.pathExists(settingsPath);
    const globalDeclares = await globalDeclaresExtensionPackage();

    if (!hasSettingsFile) {
        return {
            hasProjectSettings: false,
            hasProjectPackageDrift: false,
            pointsToXtrmExtensions: false,
            globalDeclaresExtensionPackage: globalDeclares,
        };
    }

    try {
        const settings = await fs.readJson(settingsPath) as { extensions?: unknown; packages?: unknown };
        const packageEntries = Array.isArray(settings.packages)
            ? settings.packages.filter((entry): entry is string => typeof entry === 'string')
            : [];

        return {
            hasProjectSettings: true,
            hasProjectPackageDrift: packageEntries.includes(EXTENSION_PACKAGE_ID),
            pointsToXtrmExtensions: hasSettingsEntry(settings.extensions, '../.xtrm/extensions'),
            globalDeclaresExtensionPackage: globalDeclares,
        };
    } catch {
        return {
            hasProjectSettings: true,
            hasProjectPackageDrift: false,
            pointsToXtrmExtensions: false,
            globalDeclaresExtensionPackage: globalDeclares,
        };
    }
}

export function createPiCommand(): Command {
    const cmd = new Command('pi')
        .description('Launch a Pi session in a sandboxed worktree, or manage the Pi runtime')
        .argument('[name]', 'Optional session name — used as xt/<name> branch (random if omitted)')
        .option('--role <name>', 'Launch pi as a specialist role (resolved via `sp view <name>`); creates a named tmux session with @agent_task metadata')
        .option('--bead <id>', 'Bind a bead to the session and auto-populate its assignee as pi/<slug> from runtime-origin. With --role it renders the tracked task as the initial user prompt (mutually exclusive with --prompt there); without --role it is metadata only — @agent_bead pane option + XTMUX_AGENT_BEAD — and combines freely with --prompt')
        .option('--prompt <text>', 'Use <text> as the initial user prompt. A leading /skill:<name> is the supported way to load a skill on turn 1')
        .option('--no-attach', 'Create tmux session detached; print `session_name:pane_id` on stdout and exit (default: attach)')
        .option('--json', 'With --no-attach: emit one xtrm.command-outcome.v1 JSON object instead of human launch output')
        .option('--model <name>', 'Forward `--model <name>` to pi; with --role, overrides specialist.execution.model')
        .option('--thinking <level>', 'Forward `--thinking <level>` to pi; with --role, overrides specialist.execution.thinking_level')
        .option('--skill <name-or-path>', 'Load an additional skill at startup (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
        .option('--new-session', 'Inside $TMUX: force a fresh tmux session instead of running in the current pane (default outside $TMUX)')
        .option('--ns', 'Alias for --new-session')
        .option('--parent <target>', 'With --role: override @agent_parent_session on the target pane (target = tmux session name, id, or #{session_id})')
        .option('--child', 'With --role: explicit form of the auto-behavior — @agent_parent_session = current pane\'s session_id')
        .option('--reuse', 'With --role + --new-session (or outside $TMUX): if a session named role-<slug>[-<bead>] already exists, attach to it instead of auto-suffixing a fresh one')
        .option('--subordinate', 'Canonical subordinate-coordinator launch: implies --new-session --no-attach and parents the child to the current session. Requires --role; still gets its own worktree and branch')
        .option('--base <ref>', 'Start the worktree branch at <ref> (e.g. origin/stable for hotfixes). Default: fresh origin/<default>, fetched first (CORE-2340)')
        .allowExcessArguments(true)
        .allowUnknownOption(true)
        .addHelpText('after', `
Passthrough:
  Everything after \`--\` is forwarded verbatim to the pi runtime, with or
  without --role. xt-owned flags (--session-dir, --name, --system-prompt,
  --append-system-prompt, --skill) are rejected; batch-mode flags (--print,
  --list-models, --export, --mode) are dropped with a warning.

Examples:
  $ xt pi demo --no-attach --prompt 'inspect the failing build' --model openai-codex/gpt-5.6-luna
  $ xt pi worker --no-attach --skill multiplexing --prompt 'leggi /tmp/brief.txt e seguilo'
  $ xt pi worker --no-attach --bead xyz --prompt 'work this bead'   # bead as pane metadata
  $ xt pi coord --role chain-coordinator --bead xyz --subordinate   # subordinate coordinator (P0-05)
  $ xt pi --role researcher --bead xyz -- --gitnexus-cmd 'foo bar'
  $ xt pi --role chain-coordinator --model openai-codex/gpt-5.4 -- --thinking medium
  $ xt pi --role reviewer --prompt 'review the auth changes in cli/src/auth/'
  $ xt pi --role planner                          # skills-only prime; pane idles
`)
        .action(async (name: string | undefined, opts: {
            role?: string;
            bead?: string;
            prompt?: string;
            attach?: boolean;
            json?: boolean;
            model?: string;
            thinking?: string;
            skill?: string[];
            newSession?: boolean;
            ns?: boolean;
            parent?: string;
            child?: boolean;
            reuse?: boolean;
            subordinate?: boolean;
            base?: string;
        }) => {
            // Everything after `--` is forwarded verbatim to pi (with guards
            // enforced in the launcher). This is the primary escape hatch for
            // any pi flag not first-classed here.
            const dashIdx = process.argv.indexOf('--');
            const passthrough = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : [];
            await launchWorktreeSession({
                runtime: 'pi',
                name,
                role: opts.role,
                bead: opts.bead,
                prompt: opts.prompt,
                attach: opts.attach,
                json: Boolean(opts.json),
                model: opts.model,
                thinking: opts.thinking,
                skills: opts.skill,
                newSession: Boolean(opts.newSession || opts.ns),
                parent: opts.parent,
                child: Boolean(opts.child),
                reuse: Boolean(opts.reuse),
                subordinate: Boolean(opts.subordinate),
                base: opts.base,
                passthrough,
            });
        });

    for (const commandName of RETIRED_PI_COMMANDS) {
        const tombstone = new Command(commandName)
            .description('Retired maintenance token; use xt update --apply (planned removal: v0.13.0)')
            .helpOption(false)
            .allowUnknownOption(true)
            .allowExcessArguments(true)
            .action(() => {
                console.error(RETIRED_PI_INSTALL_REDIRECT);
                process.exitCode = 1;
            });
        cmd.addCommand(tombstone, { hidden: true });
    }

    // 'setup' = interactive first-time API key + OAuth config
    const piSetup = createInstallPiCommand();
    piSetup.name('setup');
    piSetup.description('Configure Pi credentials and complete first-time setup');
    cmd.addCommand(piSetup);

    cmd.command('status')
        .description('Check Pi version and extension deployment drift')
        .action(async () => {
            console.log(t.bold('\n  Pi Runtime Status\n'));

            const piResult = spawnSync('pi', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
            if (piResult.status === 0) {
                console.log(t.success(`  ✓ pi ${piResult.stdout.trim()} installed`));
            } else {
                console.log(kleur.red('  ✗ pi not found — run: xt pi setup'));
                console.log('');
                return;
            }

            const projectRoot = resolveProjectRoot();
            const pointer = await getPiProjectPointer(projectRoot);

            const bundleRoot = await findRepoRoot();
            const sourceDir = resolveManagedPiExtensionsSourceDir(bundleRoot);
            const globalTargetDir = path.join(PI_AGENT_DIR, 'extensions');

            if (!sourceDir || !await fs.pathExists(sourceDir)) {
                console.log(kleur.dim('  ○ managed extensions not bundled in this install\n'));
                return;
            }

            const plan = await inventoryPiRuntime(sourceDir, globalTargetDir);
            const pkgOk = plan.packages.filter(s => s.installed).length;
            const legacyScoped = pointer.pointsToXtrmExtensions;
            // In package mode the npm entrypoint supplies extensions; loose
            // mirrors under ~/.pi/agent/extensions are legacy and their
            // absence is CORRECT. Only orphans (extra mirrors) still matter —
            // they collide with the npm package on tool names.
            const packageMode = pointer.globalDeclaresExtensionPackage && !legacyScoped;
            const mirrorInventoryRelevant = !legacyScoped && !packageMode;

            if (legacyScoped) {
                console.log(kleur.dim('  Scope:      project (legacy ../.xtrm/extensions pointer)'));
            } else {
                console.log(kleur.dim(`  Scope:      global${packageMode ? ' (package mode)' : ''}`));
                if (mirrorInventoryRelevant) {
                    const extOk = plan.extensions.filter(s => s.installed && !s.stale).length;
                    console.log(kleur.dim(`  Extensions: ${extOk}/${plan.extensions.length} up-to-date`));
                }
            }

            console.log(kleur.dim(`  Registration: ${EXTENSION_PACKAGE_ID} (${pointer.globalDeclaresExtensionPackage ? 'global' : 'not declared globally'})`));
            console.log(kleur.dim(`  Packages:   ${pkgOk}/${plan.packages.length} installed`));

            if (plan.missingPackages.length > 0) {
                const names = plan.missingPackages.map(s => s.pkg.displayName).join(', ');
                console.log(kleur.yellow(`  Packages:   ${names}`));
            }

            if (mirrorInventoryRelevant) {
                if (plan.missingExtensions.length > 0) {
                    const names = plan.missingExtensions.map(s => s.ext.displayName).join(', ');
                    console.log(kleur.yellow(`  Missing:    ${names}`));
                }
                if (plan.staleExtensions.length > 0) {
                    const names = plan.staleExtensions.map(s => s.ext.displayName).join(', ');
                    console.log(kleur.yellow(`  Stale:      ${names}`));
                }
            }
            if (!legacyScoped && plan.orphanedExtensions.length > 0) {
                const suffix = packageMode ? ' (collide with npm package — remove)' : '';
                console.log(kleur.red(`  Orphaned:   ${plan.orphanedExtensions.join(', ')}${suffix}`));
            }

            const hasMirrorDrift = mirrorInventoryRelevant && !plan.allPresent;
            const hasOrphanCollision = packageMode && plan.orphanedExtensions.length > 0;
            const hasPackageDrift = plan.missingPackages.length > 0;
            const hasGlobalRegistrationDrift = !pointer.globalDeclaresExtensionPackage;

            if (!pointer.hasProjectPackageDrift && !hasMirrorDrift && !hasOrphanCollision && !hasPackageDrift && !hasGlobalRegistrationDrift) {
                console.log(t.success('\n  ✓ Pi runtime configuration looks healthy\n'));
                return;
            }

            if (pointer.hasProjectPackageDrift) {
                console.log(kleur.red(`  Settings:   .pi/settings.json declares ${EXTENSION_PACKAGE_ID}; this package is global-only. Run xt update --apply.`));
            }
            if (hasGlobalRegistrationDrift) {
                console.log(kleur.yellow(`  Settings:   ${EXTENSION_PACKAGE_ID} is not declared in ~/.pi/agent/settings.json (add via xt update --apply).`));
            }

            console.log(kleur.dim('\n  → run: xt update --apply --repo <path>\n'));
        });

    cmd.command('doctor')
        .description('[deprecated] Use xt doctor for runtime diagnosis (planned removal: v0.13.0)')
        .action(async () => {
            console.error('xt pi doctor is deprecated — use: xt doctor (planned removal: v0.13.0)');
            console.log(t.bold('\n  Pi Doctor\n'));

            let allOk = true;

            const piResult = spawnSync('pi', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
            if (piResult.status === 0) {
                console.log(t.success(`  ✓ pi ${piResult.stdout.trim()} installed`));
            } else {
                console.log(kleur.red('  ✗ pi not found — run: xt pi setup'));
                allOk = false;
            }

            const pnpmResult = spawnSync('pnpm', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
            if (pnpmResult.status === 0) {
                console.log(t.success(`  ✓ pnpm ${pnpmResult.stdout.trim()} installed`));
            } else {
                console.log(kleur.yellow('  ⚠ pnpm not found'));
                allOk = false;
            }

            const configFiles = ['models.json', 'auth.json', 'settings.json'];
            const missingConfig = configFiles.filter(f => !fs.existsSync(path.join(PI_AGENT_DIR, f)));
            if (missingConfig.length === 0) {
                console.log(t.success('  ✓ config files present'));
            } else {
                console.log(kleur.yellow(`  ⚠ missing config: ${missingConfig.join(', ')}`));
                allOk = false;
            }

            const projectRoot = resolveProjectRoot();
            const pointer = await getPiProjectPointer(projectRoot);
            const bundleRoot = await findRepoRoot();
            const sourceDir = resolveManagedPiExtensionsSourceDir(bundleRoot);
            const coreSourceDir = resolveManagedPiCoreSourceDir(bundleRoot);
            const globalTargetDir = path.join(PI_AGENT_DIR, 'extensions');

            try {
                const staleOverride = await remediateStalePiMcpAdapterOverride(false);
                if (staleOverride.stale && staleOverride.remediated) {
                    console.log(t.success('  ✓ removed stale ~/.pi/agent/extensions/pi-mcp-adapter override'));
                } else if (staleOverride.stale) {
                    console.log(kleur.yellow('  ⚠ stale ~/.pi/agent/extensions/pi-mcp-adapter override detected'));
                    allOk = false;
                } else {
                    console.log(t.success('  ✓ pi-mcp-adapter override check passed'));
                }
            } catch (error) {
                console.log(kleur.yellow(`  ⚠ failed to remediate pi-mcp-adapter override: ${error}`));
                allOk = false;
            }

            try {
                const coreStatus = coreSourceDir
                    ? await ensureCorePackageSymlink(coreSourceDir, projectRoot, false)
                    : 'missing-source';
                if (coreStatus === 'repaired' || coreStatus === 'created') {
                    console.log(t.success('  ✓ repaired .xtrm/extensions/node_modules/@xtrm/pi-core symlink'));
                } else if (coreStatus === 'ok') {
                    console.log(t.success('  ✓ @xtrm/pi-core symlink is healthy'));
                } else if (coreStatus === 'missing-source') {
                    console.log(kleur.dim('  ○ @xtrm/pi-core source not bundled in this install'));
                }
            } catch (error) {
                console.log(kleur.yellow(`  ⚠ failed to ensure @xtrm/pi-core symlink: ${error}`));
                allOk = false;
            }

            if (!sourceDir || !await fs.pathExists(sourceDir)) {
                console.log(kleur.dim('  ○ managed extensions not bundled in this install'));
            } else {
                const plan = await inventoryPiRuntime(sourceDir, globalTargetDir);

                if (!pointer.hasProjectSettings) {
                    console.log(kleur.yellow('  ⚠ missing .pi/settings.json; run xt update --apply to bootstrap project Pi settings'));
                    allOk = false;
                } else if (pointer.hasProjectPackageDrift) {
                    console.log(kleur.red(`  ✗ .pi/settings.json declares ${EXTENSION_PACKAGE_ID}; this package is global-only. Run xt update --apply.`));
                    allOk = false;
                } else if (pointer.pointsToXtrmExtensions) {
                    console.log(kleur.yellow('  ⚠ legacy ../.xtrm/extensions pointer detected; run xt update --apply to migrate'));
                    allOk = false;
                }

                if (pointer.globalDeclaresExtensionPackage) {
                    console.log(t.success(`  ✓ ${EXTENSION_PACKAGE_ID} registered globally`));
                } else {
                    console.log(kleur.yellow(`  ⚠ ${EXTENSION_PACKAGE_ID} not declared in ~/.pi/agent/settings.json`));
                    allOk = false;
                }

                // Codex P2: in global package mode the npm entrypoint supplies
                // the managed extensions; loose mirrors under
                // ~/.pi/agent/extensions are legacy and their absence is
                // CORRECT — do not report it as drift. Orphaned mirrors still
                // matter because they collide with the npm package on tool
                // names (this is exactly what broke Pi tonight).
                const packageMode = pointer.globalDeclaresExtensionPackage && !pointer.pointsToXtrmExtensions;
                if (packageMode) {
                    if (plan.orphanedExtensions.length > 0) {
                        console.log(kleur.red(`  ✗ orphaned extension mirrors (collide with npm package): ${plan.orphanedExtensions.join(', ')}`));
                        allOk = false;
                    } else {
                        console.log(t.success('  ✓ global package mode: no legacy extension mirrors'));
                    }
                } else if (plan.missingExtensions.length === 0 && plan.staleExtensions.length === 0 && plan.orphanedExtensions.length === 0) {
                    console.log(t.success(`  ✓ global extensions deployed (${plan.extensions.length})`));
                } else {
                    if (plan.missingExtensions.length > 0 || plan.staleExtensions.length > 0) {
                        console.log(kleur.yellow(`  ⚠ extension drift (${plan.missingExtensions.length} missing, ${plan.staleExtensions.length} stale)`));
                        allOk = false;
                    }
                    if (plan.orphanedExtensions.length > 0) {
                        console.log(kleur.red(`  ✗ orphaned extensions: ${plan.orphanedExtensions.join(', ')}`));
                        allOk = false;
                    }
                }

                if (plan.missingPackages.length === 0) {
                    console.log(t.success(`  ✓ packages installed (${plan.packages.length})`));
                } else {
                    console.log(kleur.yellow(`  ⚠ ${plan.missingPackages.length} package(s) missing`));
                    allOk = false;
                }
            }

            console.log('');
            if (allOk) {
                console.log(t.boldGreen('  ✓ All checks passed\n'));
            } else {
                console.log(kleur.yellow('  ⚠ Some checks failed — run: xt pi reload\n'));
            }
        });

    cmd.command('reload')
        .description('[deprecated] Re-sync Pi runtime; use xt update --apply --repo <path> (planned removal: v0.13.0)')
        .option('-y, --yes', 'Skip confirmation prompt', false)
        .action(async (opts: { yes: boolean }) => {
            console.error('xt pi reload is deprecated — use: xt update --apply --repo <path> (planned removal: v0.13.0)');
            const confirmed = await confirmDestructiveAction({
                yes: opts.yes,
                message: 'Re-sync Pi runtime and remove orphaned extensions?',
                initial: true,
            });
            if (!confirmed) {
                console.log(kleur.dim('  Cancelled\n'));
                return;
            }

            await runPiInstall(false, false, resolveProjectRoot());
        });

    return cmd;
}
