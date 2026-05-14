import { Command } from 'commander';
import kleur from 'kleur';
import path from 'path';
import fs from 'fs-extra';
import prompts from 'prompts';
import { spawnSync } from 'child_process';
import type { InstallOpts } from './install.js';
import { runPiInstall } from './pi-install.js';
import { runClaudeRuntimeSyncPhase, renderClaudeRuntimePlanSummary } from '../core/claude-runtime-sync.js';
import {
    installFromRegistry,
    resolvePackageRoot,
    scaffoldSkillsDefaultFromPackage,
    type RegistryManifest,
} from '../core/registry-scaffold.js';
import { runPluginEraCleanup } from '../core/plugin-era-cleanup.js';
import { ensureAgentsSkillsSymlink } from '../core/skills-scaffold.js';
import { inventoryDeps, renderBootstrapPlan, runMachineBootstrapPhase, type BootstrapPlan } from '../core/machine-bootstrap.js';
import { runInitVerification, renderVerificationSummary } from '../core/init-verification.js';
import { assertRuntimeSkillsViews } from '../core/skills-runtime-views.js';
import { syncPiMcpConfig, syncProjectMcpConfig } from '../core/project-mcp-sync.js';
import { getContext } from '../core/context.js';
import { calculateDiff } from '../core/diff.js';
import { findRepoRoot } from '../utils/repo-root.js';
import { confirmDestructiveAction } from '../utils/confirmation.js';

let cachedPackageRoot: string | undefined;

function getPackageRoot(): string {
    cachedPackageRoot ??= resolvePackageRoot();
    return cachedPackageRoot;
}

function getMcpCoreConfigPath(): string {
    return path.join(getPackageRoot(), '.xtrm', 'config', 'claude.mcp.json');
}

function getInstructionsDir(): string {
    return path.join(getPackageRoot(), '.xtrm', 'config', 'instructions');
}

const XTRM_BLOCK_START = '<!-- xtrm:start -->';
const XTRM_BLOCK_END = '<!-- xtrm:end -->';
const syncedProjectMcpRoots = new Set<string>();

interface ProjectDetectionResult {
    hasTypeScript: boolean;
    hasPython: boolean;
    dockerServices: string[];
    generatedRegistry: boolean;
    registryPath?: string;
}

function toServiceId(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'service';
}

function parseComposeServices(content: string): string[] {
    const lines = content.split('\n');
    const services = new Set<string>();

    let inServices = false;
    for (const line of lines) {
        const raw = line.replace(/\t/g, '    ');

        if (!inServices) {
            if (/^services:\s*$/.test(raw)) {
                inServices = true;
            }
            continue;
        }

        if (/^[^\s#].*:\s*$/.test(raw) && !/^services:\s*$/.test(raw)) {
            break;
        }

        const serviceMatch = raw.match(/^\s{2}([A-Za-z0-9._-]+):\s*(?:#.*)?$/);
        if (serviceMatch) {
            services.add(serviceMatch[1]);
        }
    }

    return [...services];
}

export async function detectProjectFeatures(projectRoot: string): Promise<ProjectDetectionResult> {
    const hasTypeScript = await fs.pathExists(path.join(projectRoot, 'tsconfig.json'));

    const hasPython =
        await fs.pathExists(path.join(projectRoot, 'pyproject.toml')) ||
        await fs.pathExists(path.join(projectRoot, 'setup.py')) ||
        await fs.pathExists(path.join(projectRoot, 'requirements.txt'));

    const composeCandidates = [
        'docker-compose.yml',
        'docker-compose.yaml',
        'compose.yml',
        'compose.yaml',
    ];

    const dockerServices = new Set<string>();
    for (const composeFile of composeCandidates) {
        const composePath = path.join(projectRoot, composeFile);
        if (!await fs.pathExists(composePath)) continue;

        try {
            const content = await fs.readFile(composePath, 'utf8');
            for (const service of parseComposeServices(content)) {
                dockerServices.add(service);
            }
        } catch {
            // Ignore malformed compose file and continue
        }
    }

    const hasDockerfile = await fs.pathExists(path.join(projectRoot, 'Dockerfile'));
    if (hasDockerfile && dockerServices.size === 0) {
        dockerServices.add(path.basename(projectRoot));
    }

    return {
        hasTypeScript,
        hasPython,
        dockerServices: [...dockerServices],
        generatedRegistry: false,
    };
}

export async function ensureServiceRegistry(projectRoot: string, services: string[]): Promise<{ generated: boolean; registryPath: string }> {
    const registryPath = path.join(projectRoot, 'service-registry.json');
    if (services.length === 0) {
        return { generated: false, registryPath };
    }

    const existedBefore = await fs.pathExists(registryPath);
    const now = new Date().toISOString();
    let registry: any = { version: '1.0.0', services: {} };

    if (existedBefore) {
        try {
            registry = await fs.readJson(registryPath);
            if (!registry.services || typeof registry.services !== 'object') {
                registry.services = {};
            }
        } catch {
            registry = { version: '1.0.0', services: {} };
        }
    }

    let changed = false;
    for (const serviceName of services) {
        const serviceId = toServiceId(serviceName);
        if (registry.services[serviceId]) continue;

        registry.services[serviceId] = {
            name: serviceName,
            description: `Detected from Docker configuration (${serviceName}).`,
            territory: [],
            skill_path: `.xtrm/skills/default/${serviceId}/SKILL.md`,
            last_sync: now,
        };
        changed = true;
    }

    if (changed || !existedBefore) {
        await fs.writeJson(registryPath, registry, { spaces: 2 });
    }

    return { generated: changed || !existedBefore, registryPath };
}

function resolveEnvVars(value: string): string {
    if (typeof value !== 'string') return value;
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] || '');
}

function hasClaudeCli(): boolean {
    const r = spawnSync('claude', ['--version'], { stdio: 'pipe' });
    return r.status === 0;
}

function buildProjectMcpArgs(name: string, server: any): string[] | null {
    const transport = server.type || (server.url?.includes('/sse') ? 'sse' : 'http');

    if (server.command) {
        const args = ['mcp', 'add', '-s', 'project'];
        if (server.env && typeof server.env === 'object') {
            for (const [k, v] of Object.entries(server.env)) {
                args.push('-e', `${k}=${resolveEnvVars(String(v))}`);
            }
        }
        args.push(name, '--', server.command, ...((server.args || []) as string[]));
        return args;
    }

    if (server.url || server.serverUrl) {
        const url = server.url || server.serverUrl;
        const args = ['mcp', 'add', '-s', 'project', '--transport', transport, name, url];
        if (server.headers && typeof server.headers === 'object') {
            for (const [k, v] of Object.entries(server.headers)) {
                args.push('--header', `${k}: ${resolveEnvVars(String(v))}`);
            }
        }
        return args;
    }

    return null;
}

async function syncProjectMcpServers(projectRoot: string): Promise<void> {
    if (syncedProjectMcpRoots.has(projectRoot)) return;
    syncedProjectMcpRoots.add(projectRoot);

    const mcpCoreConfigPath = getMcpCoreConfigPath();
    if (!await fs.pathExists(mcpCoreConfigPath)) return;

    console.log(kleur.bold('\n── Installing MCP (project scope) ─────────'));

    if (!hasClaudeCli()) {
        console.log(kleur.yellow('  ⚠ Claude CLI not found; skipping project-scope MCP registration.'));
        return;
    }

    const mcpConfig = await fs.readJson(mcpCoreConfigPath);
    const servers = Object.entries(mcpConfig?.mcpServers ?? {}) as Array<[string, any]>;
    if (servers.length === 0) {
        console.log(kleur.dim('  ℹ No core MCP servers configured.'));
        return;
    }

    let added = 0;
    let existing = 0;
    let failed = 0;

    for (const [name, server] of servers) {
        const args = buildProjectMcpArgs(name, server);
        if (!args) continue;

        const r = spawnSync('claude', args, {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (r.status === 0) {
            added++;
            console.log(`${kleur.green('  ✓')} ${name}`);
            continue;
        }

        const stderr = `${r.stderr || ''}`.toLowerCase();
        if (stderr.includes('already exists') || stderr.includes('already configured')) {
            existing++;
            console.log(kleur.dim(`  ✓ ${name} (already configured)`));
            continue;
        }

        failed++;
        console.log(kleur.red(`  ✗ ${name} (${(r.stderr || r.stdout || 'failed').toString().trim()})`));
    }

    console.log(kleur.dim(`  ↳ MCP project-scope result: ${added} added, ${existing} existing, ${failed} failed`));
}

export function upsertManagedBlock(
    fileContent: string,
    blockBody: string,
    startMarker: string = XTRM_BLOCK_START,
    endMarker: string = XTRM_BLOCK_END,
): string {
    const normalizedBody = blockBody.trim();
    const managedBlock = `${startMarker}\n${normalizedBody}\n${endMarker}`;
    const escapedStart = startMarker.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
    const escapedEnd = endMarker.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');

    // Greedy match from the FIRST start marker to the LAST end marker so any
    // duplicate-content + orphan-end-marker tail left behind by older lazy
    // (`*?`) versions of this function gets swept into the replacement
    // (xtrm-ya67). The lazy variant only consumed the first start..end pair,
    // leaving a duplicated header block + a free-floating end marker after it.
    // Markers are caller-supplied but pre-escaped via the replace() above; no
    // ReDoS surface from end-user input here.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const existingBlockPattern = new RegExp(`${escapedStart}[\\s\\S]*${escapedEnd}`, 'm');

    if (existingBlockPattern.test(fileContent)) {
        return fileContent.replace(existingBlockPattern, managedBlock);
    }

    const trimmed = fileContent.trimStart();
    if (!trimmed) return `${managedBlock}\n`;
    return `${managedBlock}\n\n${trimmed}`;
}

export async function injectProjectInstructionHeaders(projectRoot: string): Promise<void> {
    const targets = [
        { output: 'AGENTS.md', template: 'agents-top.md' },
        { output: 'CLAUDE.md', template: 'claude-top.md' },
    ];

    console.log(kleur.bold('Injecting xtrm agent instruction headers...'));

    for (const target of targets) {
        const templatePath = path.join(getInstructionsDir(), target.template);
        if (!await fs.pathExists(templatePath)) {
            console.log(kleur.yellow(`  ⚠ Missing template: ${target.template}`));
            continue;
        }

        const template = await fs.readFile(templatePath, 'utf8');
        const outputPath = path.join(projectRoot, target.output);
        const existing = await fs.pathExists(outputPath) ? await fs.readFile(outputPath, 'utf8') : '';
        const next = upsertManagedBlock(existing, template);

        if (next === existing) {
            console.log(kleur.dim(`  ✓ ${target.output} already up to date`));
            continue;
        }

        await fs.writeFile(outputPath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
        console.log(`${kleur.green('  ✓')} updated ${target.output}`);
    }
}

/**
 * Deep merge settings.json hooks without overwriting existing user hooks.
 * Appends new hooks to existing events intelligently.
 */
/**
 * Extract script filename from a hook command.
 */
function getScriptFilename(hook: any): string | null {
    const cmd = hook.command || hook.hooks?.[0]?.command || '';
    if (typeof cmd !== 'string') return null;
    // Match script filename including subdirectory (e.g., "gitnexus/gitnexus-hook.cjs")
    const m = cmd.match(/\/hooks\/([A-Za-z0-9_/-]+\.(?:py|cjs|mjs|js))/);
    if (m) return m[1];
    const m2 = cmd.match(/([A-Za-z0-9_-]+\.(?:py|cjs|mjs|js))(?!.*[A-Za-z0-9._-]+\.(?:py|cjs|mjs|js))/);
    return m2?.[1] ?? null;
}

/**
 * Prune hooks from settings.json that are NOT in the canonical config.
 * This removes stale entries from old versions before merging new ones.
 *
 * @param existing Current settings.json hooks
 * @param canonical Canonical hooks config from hooks.json
 * @returns Pruned settings with stale hooks removed
 */
export function pruneStaleHooks(
    existing: Record<string, any>,
    canonical: Record<string, any>,
): { result: Record<string, any>; removed: string[] } {
    const result = { ...existing };
    const removed: string[] = [];

    if (!result.hooks || typeof result.hooks !== 'object') {
        return { result, removed };
    }
    if (!canonical.hooks || typeof canonical.hooks !== 'object') {
        return { result, removed };
    }

    // Collect canonical script paths + basenames for this skill only.
    // We only prune hooks that look like stale variants of this skill's own scripts.
    const canonicalScripts = new Set<string>();
    const canonicalBasenames = new Set<string>();
    for (const hooks of Object.values(canonical.hooks)) {
        const hookList = Array.isArray(hooks) ? hooks : [hooks];
        for (const wrapper of hookList) {
            const innerHooks = wrapper.hooks || [wrapper];
            for (const hook of innerHooks) {
                const script = getScriptFilename(hook);
                if (!script) continue;
                canonicalScripts.add(script);
                canonicalBasenames.add(path.basename(script));
            }
        }
    }

    for (const [event, hooks] of Object.entries(result.hooks)) {
        if (!Array.isArray(hooks)) continue;

        const prunedWrappers: any[] = [];
        for (const wrapper of hooks) {
            const innerHooks = wrapper.hooks || [wrapper];
            const keptInner: any[] = [];

            for (const hook of innerHooks) {
                const script = getScriptFilename(hook);
                if (!script) {
                    keptInner.push(hook);
                    continue;
                }

                if (canonicalScripts.has(script)) {
                    keptInner.push(hook);
                    continue;
                }

                const sameSkillFamily = canonicalBasenames.has(path.basename(script));
                if (sameSkillFamily) {
                    removed.push(`${event}:${script}`);
                    continue;
                }

                // Foreign/non-related hook — preserve it.
                keptInner.push(hook);
            }

            if (keptInner.length > 0) {
                if (wrapper.hooks) {
                    prunedWrappers.push({ ...wrapper, hooks: keptInner });
                } else if (keptInner.length === 1) {
                    prunedWrappers.push(keptInner[0]);
                } else {
                    prunedWrappers.push({ ...wrapper, hooks: keptInner });
                }
            }
        }

        if (prunedWrappers.length > 0) {
            result.hooks[event] = prunedWrappers;
        } else {
            delete result.hooks[event];
        }
    }

    return { result, removed };
}

export function deepMergeHooks(existing: Record<string, any>, incoming: Record<string, any>): Record<string, any> {
    const result = { ...existing };

    if (!result.hooks) result.hooks = {};
    if (!incoming.hooks) return result;

    for (const [event, incomingHooks] of Object.entries(incoming.hooks)) {
        if (!result.hooks[event]) {
            // Event doesn't exist — add it
            result.hooks[event] = incomingHooks;
        } else {
            // Event exists — merge hooks intelligently
            const existingEventHooks = Array.isArray(result.hooks[event]) ? result.hooks[event] : [result.hooks[event]];
            const incomingEventHooks = Array.isArray(incomingHooks) ? incomingHooks : [incomingHooks];

            const getCommand = (h: any) => h.command || h.hooks?.[0]?.command;
            const getCommandKey = (cmd?: string): string | null => {
                if (!cmd || typeof cmd !== 'string') return null;
                const m = cmd.match(/([A-Za-z0-9._-]+\.(?:py|cjs|mjs|js))(?!.*[A-Za-z0-9._-]+\.(?:py|cjs|mjs|js))/);
                return m?.[1] ?? null;
            };
            const mergeMatcher = (existingMatcher: string, incomingMatcher: string): string => {
                const existingParts = existingMatcher.split('|').map((s: string) => s.trim()).filter(Boolean);
                const incomingParts = incomingMatcher.split('|').map((s: string) => s.trim()).filter(Boolean);
                const merged = [...existingParts];
                for (const part of incomingParts) {
                    if (!merged.includes(part)) merged.push(part);
                }
                return merged.join('|');
            };

            const mergedEventHooks = [...existingEventHooks];
            for (const incomingHook of incomingEventHooks) {
                const incomingCmd = getCommand(incomingHook);
                if (!incomingCmd) {
                    mergedEventHooks.push(incomingHook);
                    continue;
                }

                const incomingKey = getCommandKey(incomingCmd);
                const existingIndex = mergedEventHooks.findIndex((h: any) => {
                    const existingCmd = getCommand(h);
                    if (existingCmd === incomingCmd) return true;
                    if (!incomingKey) return false;
                    return getCommandKey(existingCmd) === incomingKey;
                });
                if (existingIndex === -1) {
                    mergedEventHooks.push(incomingHook);
                    continue;
                }

                const existingHook = mergedEventHooks[existingIndex];
                if (typeof existingHook.matcher === 'string' && typeof incomingHook.matcher === 'string') {
                    existingHook.matcher = mergeMatcher(existingHook.matcher, incomingHook.matcher);
                }
            }

            result.hooks[event] = mergedEventHooks;
        }
    }

    return result;
}

async function installServiceSkillHooks(_projectRoot: string): Promise<void> {
    // service-skills hooks are opt-in via `xt install service-skills`, not auto-wired on init.
}

// ─── Inventory types ──────────────────────────────────────────────────────────

interface InitInventory {
    projectRoot: string;
    bootstrapPlan: BootstrapPlan;
    skillsChanges: number;
    needsBdInit: boolean;
    needsGitNexus: boolean;
    projectTypes: string[];
}

// ── Phase 1: Preflight / Inventory ────────────────────────────────────────────
// Reads system state without making any changes. Produces the plan data.

async function runPreflight(projectRoot: string, opts: InstallOpts): Promise<InitInventory> {
    // Source repo for skills/hooks (bundled in npm package or git repo)
    let repoRoot: string;
    try {
        repoRoot = await findRepoRoot();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Compilation failed: ${message}`);
    }

    // Machine tool availability via unified bootstrap module (read-only)
    const bootstrapPlan = inventoryDeps();

    // Skills diff (read-only — no files written)
    // Note: repoRoot is the SOURCE (skills/ dir), target is derived from projectRoot
    let skillsChanges = 0;
    try {
        const ctx = await getContext({
            createMissingDirs: false,
            isGlobal: opts.global,
            projectRoot,  // Target project, not source repo
        });
        for (const target of ctx.targets) {
            try {
                const changeSet = await calculateDiff(repoRoot, target, false);
                skillsChanges += Object.values(changeSet).reduce(
                    (sum, c: any) => sum + c.missing.length + c.outdated.length, 0,
                ) as number;
            } catch { /* diff failure is non-fatal in inventory */ }
        }
    } catch { /* context failure is non-fatal */ }

    // Project state (read-only)
    const needsBdInit = !await fs.pathExists(path.join(projectRoot, '.beads'));

    const gitnexusStatus = spawnSync('gitnexus', ['status'], {
        cwd: projectRoot, encoding: 'utf8', timeout: 5000,
    });
    const gnText = `${gitnexusStatus.stdout ?? ''}\n${gitnexusStatus.stderr ?? ''}`.toLowerCase();
    const needsGitNexus = gitnexusStatus.status !== 0 ||
        gnText.includes('stale') || gnText.includes('not indexed') || gnText.includes('missing');

    const detected = await detectProjectFeatures(projectRoot);
    const projectTypes: string[] = [
        ...(detected.hasTypeScript ? ['TypeScript'] : []),
        ...(detected.hasPython ? ['Python'] : []),
    ];

    return { projectRoot, bootstrapPlan, skillsChanges, needsBdInit, needsGitNexus, projectTypes };
}

// ── Phase 2: Plan ─────────────────────────────────────────────────────────────
// Renders a consolidated view of all changes before any mutations occur.

// ── Phase 2: Plan Rendering ─────────────────────────────────────────────────
// Shows a consolidated view of all changes before any mutations occur.
// Each phase section matches the execution order in runProjectInit.

function renderInitPlan(inventory: InitInventory): void {
    const { bootstrapPlan, skillsChanges, needsBdInit, needsGitNexus, projectTypes } = inventory;

    console.log(kleur.bold('\n  xtrm init — Installation Plan'));
    console.log(kleur.dim('  ' + '─'.repeat(50)));

    // Phase 4: Machine Bootstrap
    renderBootstrapPlan(bootstrapPlan);

    // Phase 5: Claude Runtime Sync
    renderClaudeRuntimePlanSummary();

    // Phase 6: Pi Runtime Sync (extensions + packages)
    console.log(kleur.bold('\n  Pi Runtime'));
    console.log(kleur.dim('  ↻  extensions + packages sync'));
    console.log(kleur.dim('  ↻  .mcp.json + .pi/mcp.json sync from .xtrm/config/{claude.mcp.json,pi.mcp.json}'));

    // Phase 6b: Runtime skills materialization + runtime pointers
    console.log(kleur.bold('\n  Skills'));
    if (skillsChanges > 0) {
        console.log(`${kleur.cyan('  ↑')}  ${skillsChanges} change${skillsChanges !== 1 ? 's' : ''} pending`);
    } else {
        console.log(kleur.dim('  ✓  already up to date'));
    }

    // Phase 7: Project Bootstrap
    console.log(kleur.bold('\n  Project Bootstrap'));
    const projActions = [
        needsBdInit ? 'bd init — initialize beads workspace' : null,
        needsGitNexus ? 'gitnexus analyze — build code index' : null,
        'AGENTS.md + CLAUDE.md — workflow headers',
    ].filter(Boolean) as string[];
    for (const action of projActions) {
        console.log(`${kleur.cyan('  •')}  ${action}`);
    }

    // Phase 8: Verification (implicit)
    console.log(kleur.bold('\n  Verification'));
    console.log(kleur.dim('  ✓  unified summary after execution'));

    if (projectTypes.length > 0) {
        console.log(kleur.dim(`\n  Detected: ${projectTypes.join(', ')}`));
    }

    console.log(kleur.dim('\n  ' + '─'.repeat(50) + '\n'));
}

// ── Phase 3: Confirmation ─────────────────────────────────────────────────────
// Single gate before any mutations. All phases execute only after this confirms.

async function confirmInitPlan(yes: boolean): Promise<boolean> {
    return confirmDestructiveAction({
        yes,
        message: 'Proceed with xtrm init?',
        initial: true,
    });
}

// ── Phase 7: Project Bootstrap ────────────────────────────────────────────────
// Initializes project-level tooling: beads workspace, GitNexus index,
// CLAUDE.md / AGENTS.md instruction headers and service-skills hook wiring.

async function runProjectBootstrap(projectRoot: string, isGitRepo: boolean): Promise<void> {
    if (isGitRepo) {
        await runBdInitForProject(projectRoot);
    }
    await injectProjectInstructionHeaders(projectRoot);
    if (isGitRepo) {
        await runGitNexusInitForProject(projectRoot);
    }
    await installServiceSkillHooks(projectRoot);
    // Note: ensureAgentsSkillsSymlink runs in Phase 6b (before gitnexus init)
}

function hasInteractiveTTY(): boolean {
    return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function resolveInitProjectRoot(yes: boolean): Promise<{ projectRoot: string; isGitRepo: boolean; aborted: boolean }> {
    const cwd = path.resolve(process.cwd());

    let gitRoot: string;
    try {
        gitRoot = getProjectRoot();
    } catch {
        console.log(kleur.yellow('\n  ⚠ Not a git repository — git-dependent phases (beads, gitnexus) will be skipped'));
        console.log(kleur.dim('    Run git init first, then: gitnexus analyze\n'));
        return { projectRoot: cwd, isGitRepo: false, aborted: false };
    }

    const resolvedGitRoot = path.resolve(gitRoot);
    if (resolvedGitRoot === cwd) {
        return { projectRoot: resolvedGitRoot, isGitRepo: true, aborted: false };
    }

    console.log(kleur.yellow('\n  ⚠ CWD is not the git root.'));
    console.log(kleur.dim(`    CWD:      ${cwd}`));
    console.log(kleur.dim(`    Git root: ${resolvedGitRoot}`));

    if (yes) {
        console.log(kleur.dim('    --yes supplied; proceeding with the git root.\n'));
        return { projectRoot: resolvedGitRoot, isGitRepo: true, aborted: false };
    }

    if (!hasInteractiveTTY()) {
        console.log(kleur.red('    Non-interactive session cannot choose automatically.'));
        console.log(kleur.dim('    Re-run with --yes to proceed with the git root, or run from the git root directory.\n'));
        return { projectRoot: resolvedGitRoot, isGitRepo: true, aborted: true };
    }

    const { action } = await prompts({
        type: 'select',
        name: 'action',
        message: 'CWD is not the git root. Run git init here first, or continue targeting the git root?',
        choices: [
            { title: 'Abort and show instructions', value: 'abort' },
            { title: 'Run git init in CWD and use this directory', value: 'git-init' },
            { title: 'Proceed anyway and target the git root', value: 'proceed' },
        ],
        initial: 0,
    });

    if (action === 'git-init') {
        const initResult = spawnSync('git', ['init'], {
            cwd,
            encoding: 'utf8',
            timeout: 10000,
        });

        if (initResult.status !== 0) {
            if (initResult.stdout) process.stdout.write(initResult.stdout);
            if (initResult.stderr) process.stderr.write(initResult.stderr);
            console.log(kleur.red('\n  ✗ Failed to initialize git repository in CWD.'));
            console.log(kleur.dim('    Fix git init errors and re-run xtrm init.\n'));
            return { projectRoot: resolvedGitRoot, isGitRepo: true, aborted: true };
        }

        try {
            const refreshedGitRoot = getProjectRoot();
            console.log(kleur.green(`  ✓ Initialized git repo in CWD: ${refreshedGitRoot}`));
            return { projectRoot: path.resolve(refreshedGitRoot), isGitRepo: true, aborted: false };
        } catch {
            console.log(kleur.red('\n  ✗ git init succeeded, but git root could not be resolved.'));
            console.log(kleur.dim('    Re-run xtrm init from this directory.\n'));
            return { projectRoot: cwd, isGitRepo: true, aborted: true };
        }
    }

    if (action === 'proceed') {
        console.log(kleur.dim('    Proceeding with the existing git root.\n'));
        return { projectRoot: resolvedGitRoot, isGitRepo: true, aborted: false };
    }

    console.log(kleur.dim('\n  Init cancelled.'));
    console.log(kleur.dim(`  To initialize this directory as its own repo: cd ${cwd} && git init`));
    console.log(kleur.dim(`  To target the existing repo root: cd ${resolvedGitRoot} && xtrm init\n`));
    return { projectRoot: resolvedGitRoot, isGitRepo: true, aborted: true };
}

// ── Main Orchestrator ─────────────────────────────────────────────────────────
// Top-level entrypoint for `xtrm init`. Runs all phases in order:
//   1. Preflight          — inventory system state (read-only, no mutations)
//   2. Plan               — render a consolidated view of what will change
//   3. Confirm            — single gate; all mutations happen only after this
//   4. Machine Bootstrap  — install missing system tools (bd, dolt, bv, pi, pnpm)
//   5. Claude Runtime     — .xtrm hook wiring into .claude/settings.json
//   6. Pi Runtime         — .xtrm registry scaffold + extensions + packages + skills sync
//   7. Project Bootstrap  — bd init, gitnexus index, CLAUDE.md/AGENTS.md headers, service hook wiring
//   8. Verification       — unified summary of all phase outcomes
//   9. Next Steps         — guidance based on verification result

export async function runProjectInit(opts: InstallOpts = {}): Promise<void> {
    const { dryRun = false, yes = false } = opts;
    const effectiveYes = yes || process.argv.includes('--yes') || process.argv.includes('-y');

    const rootResolution = await resolveInitProjectRoot(effectiveYes);
    if (rootResolution.aborted) {
        return;
    }

    const projectRoot = rootResolution.projectRoot;
    const isGitRepo = rootResolution.isGitRepo;

    // ── Phase 1: Preflight / Inventory ──────────────────────────────────────
    const inventory = await runPreflight(projectRoot, opts);

    // ── Phase 2: Plan ────────────────────────────────────────────────────────
    renderInitPlan(inventory);

    if (dryRun) {
        console.log(kleur.dim('  Dry run — no changes written\n'));
        return;
    }

    // ── Phase 3: Confirmation (single gate for all mutations) ────────────────
    const ok = await confirmInitPlan(effectiveYes);
    if (!ok) {
        console.log(kleur.dim('  Init cancelled.\n'));
        return;
    }

    // ── Phase 4: Machine Bootstrap ───────────────────────────────────────────
    // Install missing system tools that workflow gates and the Claude runtime
    // depend on. Uses the pre-computed plan from Phase 1 inventory.
    await runMachineBootstrapPhase({ dryRun: false });

    // ── Phase 5: Claude Runtime Sync (.xtrm hooks wiring) ───────────────────
    await runClaudeRuntimeSyncPhase({ repoRoot: projectRoot, dryRun: false, isGlobal: false });

    // ── Phase 6: Registry scaffold (.xtrm files copy) ───────────────────────
    const packageRoot = getPackageRoot();
    const ctx = await getContext({
        createMissingDirs: true,
        isGlobal: opts.global,
        projectRoot,
    });
    const userXtrmDir = ctx.targets[0];
    const registryPath = path.join(packageRoot, '.xtrm', 'registry.json');
    const registry = await fs.readJson(registryPath) as RegistryManifest;

    const registryInstallStats = await installFromRegistry({
        packageRoot,
        registry,
        userXtrmDir,
        dryRun: false,
        force: false,
        yes: true,
    });
    if (registryInstallStats.missingSourceSkipped > 0) {
        console.log(kleur.yellow(`  ⚠ Registry/source mismatch: skipped ${registryInstallStats.missingSourceSkipped} missing source file${registryInstallStats.missingSourceSkipped === 1 ? '' : 's'}.`));
        console.log(kleur.yellow('    Init continued, but some skills/files may be absent until registry payload is corrected.'));
    }

    await scaffoldSkillsDefaultFromPackage({ packageRoot, userXtrmDir, dryRun: false });

    const mcpSync = await syncProjectMcpConfig(projectRoot, { preserveExistingFile: true });
    if (mcpSync.wroteFile) {
        const verb = mcpSync.createdFile ? 'Created' : 'Updated';
        console.log(kleur.dim(`  • ${verb} ${mcpSync.mcpPath} (+${mcpSync.addedServers.length} server${mcpSync.addedServers.length === 1 ? '' : 's'})`));
    } else if (mcpSync.preservedExistingFile) {
        console.log(kleur.dim(`  • Preserved existing ${mcpSync.mcpPath}`));
    } else {
        console.log(kleur.dim(`  • ${mcpSync.mcpPath} already up to date`));
    }
    for (const warning of mcpSync.missingEnvWarnings) {
        console.log(kleur.yellow(`  ⚠ MCP server ${warning}`));
    }

    // Optional plugin-era cleanup (matches install --prune behavior).
    if (opts.prune) {
        await runPluginEraCleanup({
            dryRun: false,
            yes: true,
            scope: 'all',
            repoRoot: projectRoot,
        });
    }

    // ── Phase 6a: Pi Runtime Sync (project MCP + extensions + packages) ──────
    const piMcpSync = await syncPiMcpConfig(projectRoot);
    if (piMcpSync.wroteFile) {
        const verb = piMcpSync.createdFile ? 'Created' : 'Updated';
        console.log(kleur.dim(`  • ${verb} ${piMcpSync.mcpPath} (+${piMcpSync.addedServers.length} server${piMcpSync.addedServers.length === 1 ? '' : 's'})`));
    } else {
        console.log(kleur.dim(`  • ${piMcpSync.mcpPath} already up to date`));
    }
    for (const warning of piMcpSync.missingEnvWarnings) {
        console.log(kleur.yellow(`  ⚠ Pi MCP server ${warning}`));
    }

    await runPiInstall(false, Boolean(opts.global), projectRoot);

    // ── Phase 6b: Rebuild runtime skills views + wire runtime pointers ───────
    const skillsActivation = opts.force
        ? await ensureAgentsSkillsSymlink(projectRoot, { force: true })
        : await ensureAgentsSkillsSymlink(projectRoot);
    if (skillsActivation.activatedClaudeSkills === skillsActivation.activatedPiSkills) {
        console.log(kleur.green(`  ✓ Activated ${skillsActivation.activatedClaudeSkills} default skills → .xtrm/skills/active`));
    } else {
        console.log(kleur.green(`  ✓ Activated runtime skills → claude:${skillsActivation.activatedClaudeSkills}, pi:${skillsActivation.activatedPiSkills}`));
    }
    await assertRuntimeSkillsViews(projectRoot);

    // ── Phase 7: Project Bootstrap ───────────────────────────────────────────
    // Initialize beads workspace, inject CLAUDE.md/AGENTS.md instruction
    // headers, and ensure the GitNexus code intelligence index is current.
    await runProjectBootstrap(projectRoot, isGitRepo);

    // ── Phase 8: Verification ────────────────────────────────────────────────
    // Unified verification across all phases: machine, Claude, Pi, project.
    const verification = await runInitVerification(projectRoot);
    renderVerificationSummary(verification);

    // ── Phase 9: Summary ─────────────────────────────────────────────────────
    if (verification.allPassed) {
        console.log(kleur.bold('  Next steps:'));
        console.log(kleur.white('    • Quality gates are active globally'));
        console.log(kleur.white('    • Run `xt pi` or `xt claude` to start a worktree session'));
        if (inventory.projectTypes.length > 0) {
            console.log(kleur.white(`    • Project types: ${inventory.projectTypes.join(', ')}`));
        }
    } else {
        console.log(kleur.bold('  Troubleshooting:'));
        console.log(kleur.white('    • Re-run `xtrm init` to retry incomplete phases'));
        console.log(kleur.white('    • Check individual tool status with `xt pi doctor` or `xt claude doctor`'));
    }
    console.log('');
}

async function runBdInitForProject(projectRoot: string): Promise<void> {

    console.log(kleur.bold('Running beads initialization (bd init)...'));

    const result = spawnSync('bd', ['init'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 15000,
    });

    if (result.error) {
        console.log(kleur.yellow(`  ⚠ Could not run bd init (${result.error.message})`));
        return;
    }

    if (result.status !== 0) {
        const text = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase();
        if (text.includes('already initialized')) {
            console.log(kleur.dim('  ✓ beads workspace already initialized'));
            return;
        }
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        console.log(kleur.yellow(`  ⚠ bd init exited with code ${result.status}`));
        return;
    }

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
}

async function runGitNexusInitForProject(projectRoot: string): Promise<void> {
    const gitnexusCheck = spawnSync('gitnexus', ['--version'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5000,
    });

    if (gitnexusCheck.status !== 0) {
        console.log(kleur.yellow('  ⚠ gitnexus not found; skipping index bootstrap'));
        console.log(kleur.dim('    Install with: npm install -g gitnexus'));
        return;
    }

    // Pre-check: git repo with at least one commit required for meaningful indexing
    const hasCommits = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5000,
    });
    if (hasCommits.status !== 0) {
        console.log(kleur.yellow('  ⚠ No commits yet — skipping gitnexus analyze'));
        console.log(kleur.dim('    Run manually after your first commit: gitnexus analyze'));
        return;
    }

    console.log(kleur.bold('Checking GitNexus index status...'));

    const status = spawnSync('gitnexus', ['status'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 10000,
    });

    const statusText = `${status.stdout || ''}\n${status.stderr || ''}`.toLowerCase();
    const needsAnalyze = status.status !== 0 ||
        statusText.includes('stale') ||
        statusText.includes('not indexed') ||
        statusText.includes('missing');

    if (!needsAnalyze) {
        console.log(kleur.dim('  ✓ GitNexus index is ready'));
        return;
    }

    console.log(kleur.bold('Running GitNexus indexing (gitnexus analyze)...'));
    const analyze = spawnSync('gitnexus', ['analyze'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 120000,
    });

    if (analyze.status === 0) {
        console.log(kleur.green('  ✓ GitNexus index updated'));
        return;
    }

    if (analyze.stdout) process.stdout.write(analyze.stdout);
    if (analyze.stderr) process.stderr.write(analyze.stderr);
    console.log(kleur.yellow(`  ⚠ gitnexus analyze exited with code ${analyze.status}`));
}

function getProjectRoot(): string {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        timeout: 5000,
    });
    if (result.status !== 0) {
        throw new Error('Not inside a git repository. Run this command from your target project directory.');
    }
    return path.resolve(result.stdout.trim());
}
