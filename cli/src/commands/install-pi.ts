/**
 * Interactive Pi setup command (xtrm pi setup).
 *
 * Handles first-time Pi configuration: API keys, OAuth providers.
 * For extension/package sync, delegates to unified pi-runtime service.
 *
 * @see cli/src/core/pi-runtime.ts
 */

import { Command } from 'commander';
import kleur from 'kleur';
import prompts from 'prompts';
import fs from 'fs-extra';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { findRepoRoot } from '../utils/repo-root.js';
import { t, sym } from '../utils/theme.js';
import { inventoryPiRuntime, executePiSync, renderPiRuntimePlan, resolveManagedPiExtensionsSourceDir } from '../core/pi-runtime.js';
import { isPiInstalled, isPnpmInstalled } from '../core/machine-bootstrap.js';

const PI_AGENT_DIR = process.env.PI_AGENT_DIR || path.join(homedir(), '.pi', 'agent');

interface SchemaField { key: string; label: string; hint: string; secret: boolean; required: boolean; }
interface OAuthProvider { key: string; instruction: string; }
interface InstallSchema { fields: SchemaField[]; oauth_providers: OAuthProvider[]; packages: string[]; }

export const EXTRA_PI_CONFIGS = ['pi-worktrees-settings.json'];

export async function copyExtraConfigs(srcDir: string, destDir: string): Promise<void> {
    for (const name of EXTRA_PI_CONFIGS) {
        const src = path.join(srcDir, name);
        const dest = path.join(destDir, name);
        if (await fs.pathExists(src) && !await fs.pathExists(dest)) {
            await fs.copy(src, dest);
        }
    }
}

export function fillTemplate(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

export function readExistingPiValues(piAgentDir: string): Record<string, string> {
    const values: Record<string, string> = {};
    try {
        const auth = JSON.parse(require('fs').readFileSync(path.join(piAgentDir, 'auth.json'), 'utf8'));
        if (auth?.dashscope?.key) values['DASHSCOPE_API_KEY'] = auth.dashscope.key;
        if (auth?.zai?.key) values['ZAI_API_KEY'] = auth.zai.key;
    } catch { /* file doesn't exist or invalid */ }
    try {
        const models = JSON.parse(require('fs').readFileSync(path.join(piAgentDir, 'models.json'), 'utf8'));
        if (!values['DASHSCOPE_API_KEY'] && models?.providers?.dashscope?.apiKey) {
            values['DASHSCOPE_API_KEY'] = models.providers.dashscope.apiKey;
        }
    } catch { /* file doesn't exist or invalid */ }
    return values;
}

function ensurePnpm(): void {
    if (isPnpmInstalled()) {
        const v = spawnSync('pnpm', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
        console.log(t.success(`  ✓ pnpm ${v.stdout.trim()} already installed`));
        return;
    }
    console.log(kleur.yellow('\n  pnpm not found — installing via npm...'));
    const r = spawnSync('npm', ['install', '-g', 'pnpm'], { stdio: 'inherit' });
    if (r.status !== 0) {
        console.log(kleur.yellow('  ⚠ Failed to install pnpm. Run: npm install -g pnpm'));
    } else {
        console.log(t.success('  ✓ pnpm installed'));
    }
}

export function createInstallPiCommand(): Command {
    const cmd = new Command('pi');
    cmd
        .description('Install Pi coding agent with providers, extensions, and npm packages')
        .option('-y, --yes', 'Skip confirmation prompts', false)
        .option('--check', 'Check Pi extension deployment drift without writing changes', false)
        .option('--setup', 'Run first-time configuration (API keys, OAuth)', false)
        .action(async (opts) => {
            const { yes, check, setup } = opts;
            const repoRoot = await findRepoRoot();
            const piConfigDir = path.join(repoRoot, 'config', 'pi');

            // ── Drift Check Mode ──────────────────────────────────────────────────────
            if (check) {
                const sourceDir = resolveManagedPiExtensionsSourceDir();
                const targetDir = path.join(PI_AGENT_DIR, 'extensions');

                if (!sourceDir) {
                    console.log(kleur.dim('\n  Managed extensions: skipped (not bundled in npm package)\n'));
                    return;
                }

                const plan = await inventoryPiRuntime(sourceDir, targetDir);
                renderPiRuntimePlan(plan);

                const hasDrift = plan.missingExtensions.length > 0 || plan.staleExtensions.length > 0 || plan.orphanedExtensions.length > 0;
                if (hasDrift) {
                    console.error(kleur.red('  ✗ Pi runtime drift detected. Run `xtrm pi` to sync.\n'));
                    process.exit(1);
                }
                return;
            }

            // ── First-Time Setup Mode ───────────────────────────────────────────────────
            if (setup || !fs.pathExists(path.join(PI_AGENT_DIR, 'auth.json'))) {
                console.log(t.bold('\n  Pi Coding Agent Setup\n'));

                // Ensure pi is installed
                if (!isPiInstalled()) {
                    console.log(kleur.yellow('  pi not found — installing oh-pi globally...\n'));
                    const r = spawnSync('npm', ['install', '-g', 'oh-pi'], { stdio: 'inherit' });
                    if (r.status !== 0) {
                        console.error(kleur.red('\n  Failed to install oh-pi. Run: npm install -g oh-pi\n'));
                        process.exit(1);
                    }
                    console.log(t.success('  ✓ pi installed\n'));
                } else {
                    const v = spawnSync('pi', ['--version'], { encoding: 'utf8' });
                    console.log(t.success(`  ✓ pi ${v.stdout.trim()} already installed\n`));
                }

                // Ensure pnpm is installed
                console.log(t.bold('  pnpm\n'));
                ensurePnpm();

                // Load schema and configure API keys
                const schema: InstallSchema = await fs.readJson(path.join(piConfigDir, 'install-schema.json'));
                const existing = readExistingPiValues(PI_AGENT_DIR);
                const values: Record<string, string> = { ...existing };

                console.log(t.bold('\n  API Keys\n'));
                for (const field of schema.fields) {
                    if (existing[field.key]) {
                        console.log(t.success(`    ${sym.ok} ${field.label} [already set]`));
                        continue;
                    }
                    if (!field.required && !yes) {
                        const { include } = await prompts({
                            type: 'confirm',
                            name: 'include',
                            message: `  Configure ${field.label}? (optional)`,
                            initial: false
                        });
                        if (!include) continue;
                    }
                    const { value } = await prompts({
                        type: field.secret ? 'password' : 'text',
                        name: 'value',
                        message: `  ${field.label}`,
                        hint: field.hint,
                        validate: (v: string) => (field.required && !v) ? 'Required' : true
                    });
                    if (value) values[field.key] = value;
                }

                // Write config files
                await fs.ensureDir(PI_AGENT_DIR);
                console.log(t.muted(`\n  Writing config to ${PI_AGENT_DIR}`));

                for (const name of ['models.json', 'auth.json', 'settings.json']) {
                    const destPath = path.join(PI_AGENT_DIR, name);
                    if (name === 'auth.json' && await fs.pathExists(destPath) && !yes) {
                        const { overwrite } = await prompts({
                            type: 'confirm',
                            name: 'overwrite',
                            message: `  ${name} already exists — overwrite? (OAuth tokens will be lost)`,
                            initial: false
                        });
                        if (!overwrite) {
                            console.log(t.muted(`    skipped ${name}`));
                            continue;
                        }
                    }
                    const raw = await fs.readFile(path.join(piConfigDir, `${name}.template`), 'utf8');
                    await fs.writeFile(destPath, fillTemplate(raw, values), 'utf8');
                    console.log(t.success(`    ${sym.ok} ${name}`));
                }
            }

            // ── Extension & Package Sync ───────────────────────────────────────────────
            const sourceDir = resolveManagedPiExtensionsSourceDir();
            const targetDir = path.join(PI_AGENT_DIR, 'extensions');

            if (!sourceDir) {
                console.log(kleur.dim('\n  Managed extensions: skipped (not bundled in npm package)\n'));
            } else {
                const plan = await inventoryPiRuntime(sourceDir, targetDir);
                renderPiRuntimePlan(plan);

                if (!plan.allPresent) {
                    const result = await executePiSync(plan, sourceDir, targetDir, {
                        dryRun: false,
                        isGlobal: true,
                        removeOrphaned: true,
                        log: (msg) => console.log(kleur.dim(`    ${msg}`)),
                    });

                    const total = result.extensionsAdded.length + result.extensionsUpdated.length + result.packagesInstalled.length;
                    if (total > 0) {
                        console.log(t.success(`\n    ${sym.ok} Synced ${total} items`));
                    }
                }
            }

            // ── OAuth Instructions ──────────────────────────────────────────────────────
            console.log(t.bold('\n  OAuth (manual steps)\n'));
            const schema: InstallSchema = await fs.readJson(path.join(piConfigDir, 'install-schema.json'));
            for (const provider of schema.oauth_providers) {
                console.log(t.muted(`    ${provider.key}: ${provider.instruction}`));
            }

            console.log(t.boldGreen('\n  Pi setup complete\n'));
        });

    return cmd;
}
