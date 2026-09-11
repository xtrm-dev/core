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
import { ensureAgentsSkillsSymlink, ensureUserAgentsSkillsSymlink } from '../core/skills-scaffold.js';
import { ensureGlobalSkillsBootstrapped, logBootstrapTrigger } from '../core/global-skills-bootstrap.js';
import { ensureGlobalHooksBootstrapped } from '../core/global-hooks-bootstrap.js';
import { reconcileGlobalClaudeHooks } from '../core/claude-runtime-sync.js';
import { reconcileGlobalPiHooks } from '../core/pi-runtime-hooks.js';
import { shouldUseGlobalHooks } from '../core/global-hooks-flag.js';
import { ensureServiceSkills } from '../core/service-skills-ensure.js';
import { inventoryDeps, renderBootstrapPlan, runMachineBootstrapPhase, type BootstrapPlan } from '../core/machine-bootstrap.js';
import { runInitVerification, renderVerificationSummary } from '../core/init-verification.js';
import { assertRuntimeSkillsViews } from '../core/skills-runtime-views.js';
import { getGlobalSkillsOverrideRoots } from '../core/global-skills-flag.js';
import { syncPiMcpConfig, syncProjectMcpConfig } from '../core/project-mcp-sync.js';
import { getContext } from '../core/context.js';
import { calculateDiff } from '../core/diff.js';
import { findRepoRoot } from '../utils/repo-root.js';
import { confirmDestructiveAction } from '../utils/confirmation.js';
import { printDependencyMaintenanceSummary, runDependencyMaintenance } from '../core/dependency-maintenance.js';
import { createSbProject, defaultStateDbPath, executePlanCommands, getSbProjectLink, getSbVersion, linkSbProject, parseCreateProjectFlag, resolveSubstrateSource, runSetupCheck, runSetupPlan } from '../core/substrate.js';
import { migrationBlockedReason, planSubstrateMigration } from '../core/substrate-migration.js';

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


// ─── Inventory types ──────────────────────────────────────────────────────────

interface InitInventory {
    projectRoot: string;
    bootstrapPlan: BootstrapPlan;
    skillsChanges: number;
    needsSubstrateInit: boolean;
    /** Read-only link state: null when sb is unavailable. */
    substrateLink: { linked: boolean; projectId: string | null } | null;
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

    // Project state (read-only): Substrate-first. The sb CLI must answer
    // `--version` and the ADR-grounded state.db must exist. Link state is
    // read here too so non-interactive runs fail before ANY mutation.
    const sbAvailable = getSbVersion().available;
    const needsSubstrateInit = !sbAvailable || !await fs.pathExists(defaultStateDbPath());
    let substrateLink: InitInventory['substrateLink'] = null;
    if (sbAvailable) {
        try {
            const link = getSbProjectLink(projectRoot);
            substrateLink = { linked: link.ok, projectId: link.projectId };
        } catch {
            substrateLink = { linked: false, projectId: null };
        }
    }

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

    return { projectRoot, bootstrapPlan, skillsChanges, needsSubstrateInit, substrateLink, needsGitNexus, projectTypes };
}

// ── Phase 2: Plan ─────────────────────────────────────────────────────────────
// Renders a consolidated view of all changes before any mutations occur.

// ── Phase 2: Plan Rendering ─────────────────────────────────────────────────
// Shows a consolidated view of all changes before any mutations occur.
// Each phase section matches the execution order in runProjectInit.

function renderInitPlan(inventory: InitInventory): void {
    const { bootstrapPlan, skillsChanges, needsSubstrateInit, substrateLink, needsGitNexus, projectTypes } = inventory;

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
        needsSubstrateInit ? 'sb project create/link — resolve Substrate project + state.db' : null,
        needsGitNexus ? 'gitnexus analyze — build code index' : null,
        'AGENTS.md + CLAUDE.md — workflow headers',
    ].filter(Boolean) as string[];
    for (const action of projActions) {
        console.log(`${kleur.cyan('  •')}  ${action}`);
    }
    if (substrateLink?.linked) {
        console.log(kleur.dim(`  ✓  linked to Substrate project ${substrateLink.projectId ?? ''}`));
    } else if (substrateLink) {
        console.log(kleur.yellow('  ⚠  no Substrate project linked — non-interactive runs require --sb-project or --sb-create-project'));
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
// Initializes project-level tooling: Substrate project/state.db, GitNexus
// index, CLAUDE.md / AGENTS.md instruction headers and service-skills hook
// wiring.

async function runProjectBootstrap(projectRoot: string, isGitRepo: boolean): Promise<{ substrateLinked: boolean }> {
    // Atomicity: the link was resolved at Phase 3.5 before any mutation;
    // re-verify here and fail closed (zero Phase 7 writes) on drift.
    if (isGitRepo) {
        const substrate = await runSubstrateInitForProject(projectRoot);
        if (!substrate.linked) return { substrateLinked: false };
        // xtrm-utdq1: seed .gitignore with the runtime-state block so fresh
        // repos never accidentally track state.json, worktree gitlinks, .pi/skills,
        // .xtrm/cache, or the statusline claim file. Idempotent — no-op if the
        // marker is already present.
        const { ensureRuntimeGitignoreBlock } = await import('../utils/git-staging.js');
        const { written } = await ensureRuntimeGitignoreBlock(projectRoot);
        if (written) {
            console.log(kleur.dim('  gitignore: seeded xtrm runtime-state block'));
        }
    }
    await injectProjectInstructionHeaders(projectRoot);
    if (isGitRepo) {
        await runGitNexusInitForProject(projectRoot);
    }
    // Foolproof, registry-gated service-skills migration (no-op in non-service repos).
    const serviceSkills = await ensureServiceSkills(projectRoot, { apply: true });
    for (const note of serviceSkills.notes) {
        console.log(`  ${note}`);
    }
    // Note: ensureAgentsSkillsSymlink runs in Phase 6b (before gitnexus init)
    return { substrateLinked: true };
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
        console.log(kleur.yellow('\n  ⚠ Not a git repository — git-dependent phases (substrate project link, gitnexus) will be skipped'));
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
//   4. Machine Bootstrap  — install missing system tools (sb, pi, pnpm)
//   5. Claude Runtime     — .xtrm hook wiring into .claude/settings.json
//   6. Pi Runtime         — .xtrm registry scaffold + extensions + packages + skills sync
//   7. Project Bootstrap  — sb project init, gitnexus index, CLAUDE.md/AGENTS.md headers, service hook wiring
//   8. Verification       — unified summary of all phase outcomes
//   9. Next Steps         — guidance based on verification result

export async function runProjectInit(opts: InstallOpts = {}): Promise<void> {
    // Run-local intent state: never leaks across concurrent calls.
    let collectedIntent: CollectedProjectIntent | null = null;
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

    // ── Phase 3.4: migration detection + pure identity validation ─────────
    // Read-only and mutation-free: a legacy board, conflicting flags, a
    // malformed create value, or missing identity (non-interactive) fails
    // here — before enrollment mutates npm/Pi/Claude state. Interactive
    // runs proceed to the Phase 3.5 prompt. Mirrors resolveSubstrateProject
    // without executing anything.
    {
        const legacy = await planSubstrateMigration(projectRoot);
        if (legacy.needed) {
            const blocked = migrationBlockedReason(legacy);
            console.log(kleur.red(`  ✗ substrate migration required: ${blocked ?? legacy.reason}`));
            process.exitCode = 1;
            return;
        }
        const intentError = validateProjectIntent(opts);
        if (intentError) {
            console.log(kleur.red(`  ✗ ${intentError}`));
            process.exitCode = 1;
            return;
        }
        // Link state is read once: both gates below share one probe.
        const preLink = !opts.sbProject && !opts.sbCreateProject ? getSbProjectLink(projectRoot) : null;
        if (preLink && !preLink.ok && (effectiveYes || !hasInteractiveTTY())) {
            console.log(kleur.red('  ✗ no Substrate project linked: re-run with --sb-project <id> to link, or --sb-create-project <PREFIX:Name> to create and link'));
            process.exitCode = 1;
            return;
        }
        // Interactive runs collect the operator's identity intent HERE, not
        // after enrollment: cancellation can never leave a partial install.
        // Semantic id existence still waits for sb at Phase 3.5b.
        if (preLink && !preLink.ok) {
            const intent = await promptProjectIntent();
            if (!intent.ok) {
                console.log(kleur.red(`  ✗ ${intent.error}`));
                process.exitCode = 1;
                return;
            }
            collectedIntent = intent.intent;
        }
    }

    // ── Phase 3.5a: Substrate source enrollment ─────────────────────────────
    // Provisions sb + Pi/Claude integrations from the authorized local
    // source BEFORE anything that assumes them. Fails closed with exact
    // remediation when no source resolves or enrollment is incomplete.
    // enrolledSetupTs carries the canonical source into Phase 9.
    let enrolledSetupTs: string | undefined;
    let enrolledDir: string | undefined;
    {
        const enrollment = await enrollSubstrateIntegrations(projectRoot, opts);
        if (!enrollment.ok) {
            console.log(kleur.red('  ✗ Substrate enrollment failed — init cannot complete Substrate-first setup.'));
            process.exitCode = 1;
            return;
        }
        enrolledSetupTs = enrollment.setupTs;
        enrolledDir = enrollment.dir;
    }

    // Substrate-first hard gate (§40): every later phase assumes `sb`.
    // Enrollment above provisions it; this gate is defense in depth.
    if (!getSbVersion().available) {
        console.log(kleur.red('  ✗ sb CLI not found after enrollment; Substrate-first setup cannot proceed.'));
        console.log(kleur.dim('    Set XTRM_SB_BIN to a local @xtrm/substrate `sb` entry (or put `sb` on PATH), then re-run xtrm init.'));
        process.exitCode = 1;
        return;
    }

    // ── Phase 3.5b: Substrate project resolution ────────────────────────────
    // Invalid or missing identity fails here — after the operator confirmed,
    // but before machine bootstrap, runtime sync, registry, and project
    // bootstrap (all mutations). Interactive runs prompt here, not Phase 7.
    {
        const project = await resolveSubstrateProject(projectRoot, opts, !effectiveYes && hasInteractiveTTY(), collectedIntent);
        if (!project.linked) {
            console.log(kleur.red('  ✗ Substrate project not resolved — init cannot complete Substrate-first setup.'));
            process.exitCode = 1;
            return;
        }
    }

    // ── Phase 4: Machine Bootstrap ───────────────────────────────────────────
    // Install missing system tools that workflow gates and the Claude runtime
    // depend on. Uses the pre-computed plan from Phase 1 inventory.
    await runMachineBootstrapPhase({ dryRun: false });

    // ── Phase 5: Claude Runtime Sync (.xtrm hooks wiring) ───────────────────
    await runClaudeRuntimeSyncPhase({ repoRoot: projectRoot, dryRun: false, isGlobal: false });

    // ── Phase 6: Registry scaffold (.xtrm files copy) ───────────────────────
    const packageRoot = getPackageRoot();
    const pkgJson = await fs.readJson(path.join(packageRoot, 'package.json')) as { version?: string };
    await logBootstrapTrigger({
        command: 'init',
        cwd: process.cwd(),
        pkgVersion: pkgJson.version ?? '0.0.0',
    });
    await ensureGlobalSkillsBootstrapped(packageRoot, opts.force ? { force: true } : {});
    if (shouldUseGlobalHooks()) {
        await ensureGlobalHooksBootstrapped(packageRoot, opts.force ? { force: true } : {});
        await reconcileGlobalClaudeHooks();
        await reconcileGlobalPiHooks();
    }
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
        overrideRoots: getGlobalSkillsOverrideRoots(),
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
    if (opts.force) {
        await ensureUserAgentsSkillsSymlink({ force: true });
    } else {
        await ensureUserAgentsSkillsSymlink();
    }
    const skillsActivation = opts.force
        ? await ensureAgentsSkillsSymlink(projectRoot, { force: true })
        : await ensureAgentsSkillsSymlink(projectRoot);
    if (skillsActivation.activatedClaudeSkills === skillsActivation.activatedPiSkills
        && skillsActivation.activatedPiSkills === skillsActivation.activatedCodexSkills) {
        console.log(kleur.green(`  ✓ Reconciled ${skillsActivation.activatedClaudeSkills} runtime skills`));
    } else {
        console.log(kleur.green(`  ✓ Activated runtime skills → claude:${skillsActivation.activatedClaudeSkills}, pi:${skillsActivation.activatedPiSkills}, codex:${skillsActivation.activatedCodexSkills}`));
    }
    await assertRuntimeSkillsViews(projectRoot, { scope: 'both' });

    // ── Phase 7: Project Bootstrap ───────────────────────────────────────────
    // Initialize the Substrate project, inject CLAUDE.md/AGENTS.md instruction
    // headers, and ensure the GitNexus code intelligence index is current.
    // An unlinked project fails the run: §40 requires create-or-resolve.
    const bootstrap = await runProjectBootstrap(projectRoot, isGitRepo);
    if (!bootstrap.substrateLinked) {
        console.log(kleur.red('  ✗ Substrate project not linked — init cannot complete Substrate-first setup.'));
        process.exitCode = 1;
        return;
    }

    // ── Phase 8: Dependency maintenance ──────────────────────────────────────
    // Check sb/gitnexus freshness, run the sb doctor gate, and refresh stale
    // GitNexus indexes as part of the single init summary.
    const dependencyMaintenance = await runDependencyMaintenance(projectRoot, true);
    printDependencyMaintenanceSummary(dependencyMaintenance);

    // ── Phase 9: Verification ────────────────────────────────────────────────
    // Unified verification across all phases: machine, Claude, Pi, project.
    // Phase 9 verifies the exact source this run enrolled (threaded
    // through), never a conflicting ambient authority.
    const verification = await runInitVerification(projectRoot, enrolledSetupTs, enrolledDir);
    renderVerificationSummary(verification);

    // ── Phase 9: Summary ─────────────────────────────────────────────────────
    if (verification.allPassed) {
        console.log(kleur.bold('  Next steps:'));
        console.log(kleur.white('    • Quality gates are active globally'));
        console.log(kleur.white('    • Run `xt pi`, `xt claude`, or `xt codex` to start a worktree session'));
        if (inventory.projectTypes.length > 0) {
            console.log(kleur.white(`    • Project types: ${inventory.projectTypes.join(', ')}`));
        }
    } else {
        console.log(kleur.bold('  Troubleshooting:'));
        console.log(kleur.white('    • Re-run `xtrm init` to retry incomplete phases'));
        console.log(kleur.white('    • Run `xt doctor` for the combined runtime and project diagnosis'));
    }
    console.log('');
}

// Substrate-first project init (ADR section 40): sb --version gate, state.db
// presence, then explicit create-or-resolve + link with verified flags
// (`sb project create --prefix/--name`, `sb project link [--project]`).
// No legacy Beads-stack state is created here: no workspace init, no Dolt
// setup, no triage-tool install.
/**
 * Enroll Substrate integrations from the authorized local source (contract
 * #174, A8 consumes — never invents — this surface). With an explicit
 * `--substrate-dir`/XTRM_SUBSTRATE_DIR source: validate via plan (read-only,
 * exit 2 on invalid), execute the emitted native commands verbatim in order
 * aborting on first nonzero, then require a green setup check. Without a
 * source: verify-only through any resolvable setup.ts — a green check means
 * already enrolled and init proceeds; anything else fails closed with the
 * exact source remediation. Never auto-installs, never guesses.
 */
async function enrollSubstrateIntegrations(
    projectRoot: string,
    opts: { substrateDir?: string } = {},
): Promise<{ ok: boolean; setupTs?: string; dir?: string }> {
    console.log(kleur.bold('Enrolling Substrate integrations...'));
    const fail = (message: string): { ok: boolean } => {
        console.log(kleur.red(`  ✗ ${message}`));
        return { ok: false };
    };
    // Canonical setup source selected by this run: threaded into Phase 9
    // verification so verify can never drift to a conflicting authority
    // (XTRM_SUBSTRATE_DIR B / XTRM_SUBSTRATE_SETUP) after enrollment from A.
    const canonicalSource = (setupTs: string): string => {
        try {
            return fs.realpathSync(setupTs);
        } catch {
            return setupTs;
        }
    };

    const source = resolveSubstrateSource({ substrateDir: opts.substrateDir, cwd: projectRoot });
    if (!source.setupTs) {
        return fail(`${source.error ?? 'no substrate source'}; re-run with --substrate-dir <checkout> or set XTRM_SUBSTRATE_DIR`);
    }
    if (!source.dir) {
        // No explicit source: verify-only. A green check proves an existing
        // enrollment (e.g. global link); anything else fails closed.
        const check = runSetupCheck({ setupTs: source.setupTs, cwd: projectRoot });
        if (!check.ok) {
            return fail(`Substrate integrations not enrolled (${check.error ?? 'setup check failed'}); re-run with --substrate-dir <checkout> or set XTRM_SUBSTRATE_DIR`);
        }
        reportEnrollmentHealth(check.report);
        return { ok: true, setupTs: canonicalSource(source.setupTs as string), dir: source.dir ?? undefined };
    }

    const plan = runSetupPlan({ setupTs: source.setupTs, cwd: projectRoot, dir: source.dir });
    if (!plan.ok) {
        return fail(`substrate source rejected (${plan.error ?? 'plan failed'}); check XTRM_SUBSTRATE_DIR/--substrate-dir points at a reviewed @xtrm/substrate checkout`);
    }
    console.log(kleur.dim(`  ✓ install plan validated (${plan.commands.length} native commands)`));
    // Pin the plan to the validated source: canonical realpaths must match
    // (symlink aliases compare canonically). A plan answering for another
    // dir fails closed before command 1.
    try {
        const answered = fs.realpathSync(plan.dir as string);
        const validated = fs.realpathSync(source.dir as string);
        if (answered !== validated) {
            return fail(`substrate source mismatch: plan answers for ${plan.dir}, validated ${source.dir}`);
        }
    } catch (error) {
        return fail(`substrate source unreadable (${error instanceof Error ? error.message : String(error)})`);
    }
    const executed = executePlanCommands(plan.commands, { cwd: projectRoot });
    for (const result of executed.results) {
        if (result.ok) console.log(kleur.dim(`  ✓ ${result.label}`));
        else console.log(kleur.red(`  ✗ ${result.label} failed: ${result.error ?? 'unknown error'}`));
    }
    if (!executed.ok) {
        return fail(`enrollment aborted at '${executed.failedLabel ?? 'unknown step'}'; fix the failure and re-run xtrm init`);
    }
    const check = runSetupCheck({ setupTs: source.setupTs, cwd: projectRoot, dir: plan.dir ?? source.dir });
    if (!check.ok) {
        return fail(`enrollment incomplete (${check.error ?? 'setup check failed'}); fix the failure and re-run xtrm init`);
    }
    reportEnrollmentHealth(check.report);
    return { ok: true, setupTs: canonicalSource(source.setupTs as string), dir: plan.dir ?? source.dir ?? undefined };
}

function reportEnrollmentHealth(report: { claude?: Array<{ name: string; ok: boolean }>; pi?: Array<{ name: string; ok: boolean }>; naming?: { beadsRemnants?: string[]; duplicates?: boolean } } | null): void {
    if (!report) return;
    const claudeOk = (report.claude ?? []).filter(c => c.ok).length;
    const claudeTotal = (report.claude ?? []).length;
    const piOk = (report.pi ?? []).length > 0 && (report.pi ?? []).every(c => c.ok);
    console.log(kleur.dim(`  ✓ integrations healthy (claude ${claudeOk}/${claudeTotal}, pi ${piOk ? 'ok' : 'see details'})`));
    const remnants = report.naming?.beadsRemnants ?? [];
    if (remnants.length > 0) {
        console.log(kleur.yellow(`  ⚠ stale Beads remnants: ${remnants.join(', ')}`));
    }
    if (report.naming?.duplicates) {
        console.log(kleur.yellow('  ⚠ duplicate substrate plugin registrations'));
    }
}

/**
 * Pure project-identity validation: no sb calls, no mutations. Shared by
 * the Phase 3.4 pre-enrollment gate and resolveSubstrateProject below.
 */
function validateProjectIntent(opts: { sbProject?: string; sbCreateProject?: string }): string | null {
    if (opts.sbProject && opts.sbCreateProject) {
        return 'pass only one of --sb-project or --sb-create-project, not both';
    }
    if (opts.sbCreateProject && !parseCreateProjectFlag(opts.sbCreateProject)) {
        return `--sb-create-project wants PREFIX:Name, got ${JSON.stringify(opts.sbCreateProject)}`;
    }
    return null;
}

/**
 * Resolve the Substrate project link BEFORE any mutation phase.
 * Runs at Phase 3.5 (after confirm, before machine bootstrap): flags and
 * interactive prompts are honored here so invalid or missing identity fails
 * before unrelated mutations. Project identity always comes from the
 * operator — init never invents it.
 */
type CollectedProjectIntent =
    | { kind: 'link'; projectId: string }
    | { kind: 'create'; prefix: string; name: string };



/**
 * Prompt the operator for project identity intent (no sb mutations: intent
 * only). Cancellation or empty values fail closed before enrollment.
 */
async function promptProjectIntent(): Promise<{ ok: true; intent: CollectedProjectIntent } | { ok: false; error: string }> {
    const { action } = await prompts({
        type: 'select',
        name: 'action',
        message: 'No Substrate project is linked to this checkout.',
        choices: [
            { title: 'Create a new project', value: 'create' },
            { title: 'Link an existing project', value: 'link' },
            { title: 'Skip for now (fail init; link later with --sb-project)', value: 'skip' },
        ],
        initial: 0,
    });
    if (action === 'link') {
        const { projectId } = await prompts({
            type: 'text',
            name: 'projectId',
            message: 'Substrate project id to link:',
        });
        if (!projectId || !String(projectId).trim()) {
            return { ok: false, error: 'no project id given; re-run with --sb-project <id>' };
        }
        return { ok: true, intent: { kind: 'link', projectId: String(projectId).trim() } };
    }
    if (action === 'create') {
        const { prefix, name } = await prompts([
            { type: 'text', name: 'prefix', message: 'Project prefix (e.g. PROOF):' },
            { type: 'text', name: 'name', message: 'Project name:' },
        ]);
        const parsed = parseCreateProjectFlag(`${prefix ?? ''}:${name ?? ''}`);
        if (!parsed) {
            return { ok: false, error: 'prefix and name are both required; re-run with --sb-create-project <PREFIX:Name>' };
        }
        return { ok: true, intent: { kind: 'create', prefix: parsed.prefix, name: parsed.name } };
    }
    return { ok: false, error: 'init stopping unlinked — link later with `xt init --sb-project <id>`' };
}

async function resolveSubstrateProject(
    projectRoot: string,
    opts: { sbProject?: string; sbCreateProject?: string },
    interactive: boolean,
    preIntent: CollectedProjectIntent | null = null,
): Promise<{ linked: boolean; projectId?: string }> {
    const fail = (message: string): { linked: boolean } => {
        console.log(kleur.red(`  ✗ ${message}`));
        return { linked: false };
    };

    if (!getSbVersion().available) {
        return fail('sb CLI not found; cannot resolve the Substrate project');
    }

    // The sb store cannot open without its parent dir; ensure it here so
    // create/link attempts below don't fail on a missing directory.
    // Authorized by the confirm gate above; Phase 7 re-verifies.
    try {
        await fs.ensureDir(path.dirname(defaultStateDbPath()));
    } catch (error) {
        return fail(`cannot prepare state.db directory (${error instanceof Error ? error.message : String(error)})`);
    }

    // No `project list` verb exists (only create|link|unlink) — link state
    // comes from `sb doctor --json`.
    const current = getSbProjectLink(projectRoot);
    if (current.ok && current.projectId && !opts.sbProject && !opts.sbCreateProject) {
        console.log(kleur.dim(`  ✓ checkout linked to Substrate project ${current.projectId} (via ${current.source ?? 'unknown'})`));
        return { linked: true, projectId: current.projectId };
    }

    const intentError = validateProjectIntent(opts);
    if (intentError) {
        return fail(intentError);
    }

    if (opts.sbProject) {
        const link = linkSbProject({ project: opts.sbProject, cwd: projectRoot });
        if (link.ok) {
            console.log(kleur.dim(`  ✓ checkout linked to Substrate project ${opts.sbProject}`));
            return { linked: true, projectId: opts.sbProject };
        }
        return fail(`sb project link --project ${opts.sbProject} failed (${link.error ?? 'unknown error'})`);
    }

    if (opts.sbCreateProject) {
        // Shape validated above (and at Phase 3.4); re-parse defensively.
        const parsed = parseCreateProjectFlag(opts.sbCreateProject);
        if (!parsed) {
            return fail(`--sb-create-project wants PREFIX:Name, got ${JSON.stringify(opts.sbCreateProject)}`);
        }
        const created = createSbProject({ prefix: parsed.prefix, name: parsed.name, cwd: projectRoot });
        if (!created.ok) {
            return fail(`sb project create failed (${created.error ?? 'unknown error'})`);
        }
        // Never issue a bare link: without the created id the follow-up is
        // ambiguous in a non-empty store. Fail closed instead.
        if (!created.projectId) {
            return fail('sb project create returned no project id; link explicitly with --sb-project <id>');
        }
        const link = linkSbProject({ project: created.projectId, cwd: projectRoot });
        if (!link.ok) {
            return fail(`project created but link failed (${link.error ?? 'unknown error'}); run sb project link manually`);
        }
        console.log(kleur.dim(`  ✓ created and linked Substrate project ${parsed.prefix} (${parsed.name})`));
        return { linked: true };
    }

    if (!interactive) {
        return fail('no Substrate project linked: re-run with --sb-project <id> to link, or --sb-create-project <PREFIX:Name> to create and link');
    }

    // Intent collected pre-enrollment at Phase 3.4 executes here with no
    // second prompt. Fallback prompts below only fire if link state changed
    // mid-run after 3.4 (defense in depth).
    if (preIntent?.kind === 'link') {
        const link = linkSbProject({ project: preIntent.projectId, cwd: projectRoot });
        if (!link.ok) {
            return fail(`sb project link failed (${link.error ?? 'unknown error'})`);
        }
        console.log(kleur.dim(`  ✓ checkout linked to Substrate project ${preIntent.projectId}`));
        return { linked: true, projectId: preIntent.projectId };
    }
    if (preIntent?.kind === 'create') {
        const created = createSbProject({ prefix: preIntent.prefix, name: preIntent.name, cwd: projectRoot });
        if (!created.ok) {
            return fail(`sb project create failed (${created.error ?? 'unknown error'})`);
        }
        if (!created.projectId) {
            return fail('sb project create returned no project id; link explicitly with --sb-project <id>');
        }
        const link = linkSbProject({ project: created.projectId, cwd: projectRoot });
        if (!link.ok) {
            return fail(`project created but link failed (${link.error ?? 'unknown error'}); run sb project link manually`);
        }
        console.log(kleur.dim(`  ✓ created and linked Substrate project ${preIntent.prefix} (${preIntent.name})`));
        return { linked: true };
    }

    const { action } = await prompts({
        type: 'select',
        name: 'action',
        message: 'No Substrate project is linked to this checkout.',
        choices: [
            { title: 'Create a new project', value: 'create' },
            { title: 'Link an existing project', value: 'link' },
            { title: 'Skip for now (fail init; link later with --sb-project)', value: 'skip' },
        ],
        initial: 0,
    });
    if (action === 'link') {
        const { projectId } = await prompts({
            type: 'text',
            name: 'projectId',
            message: 'Substrate project id to link:',
        });
        if (!projectId || !String(projectId).trim()) {
            return fail('no project id given; re-run with --sb-project <id>');
        }
        const link = linkSbProject({ project: String(projectId).trim(), cwd: projectRoot });
        if (!link.ok) {
            return fail(`sb project link failed (${link.error ?? 'unknown error'})`);
        }
        console.log(kleur.dim(`  ✓ checkout linked to Substrate project ${String(projectId).trim()}`));
        return { linked: true, projectId: String(projectId).trim() };
    }
    if (action === 'create') {
        const { prefix, name } = await prompts([
            { type: 'text', name: 'prefix', message: 'Project prefix (e.g. PROOF):' },
            { type: 'text', name: 'name', message: 'Project name:' },
        ]);
        const parsed = parseCreateProjectFlag(`${prefix ?? ''}:${name ?? ''}`);
        if (!parsed) {
            return fail('prefix and name are both required; re-run with --sb-create-project <PREFIX:Name>');
        }
        const created = createSbProject({ prefix: parsed.prefix, name: parsed.name, cwd: projectRoot });
        if (!created.ok) {
            return fail(`sb project create failed (${created.error ?? 'unknown error'})`);
        }
        // Never issue a bare link: without the created id the follow-up is
        // ambiguous in a non-empty store. Fail closed instead.
        if (!created.projectId) {
            return fail('sb project create returned no project id; link explicitly with --sb-project <id>');
        }
        const link = linkSbProject({ project: created.projectId, cwd: projectRoot });
        if (!link.ok) {
            return fail(`project created but link failed (${link.error ?? 'unknown error'}); run sb project link manually`);
        }
        console.log(kleur.dim(`  ✓ created and linked Substrate project ${parsed.prefix} (${parsed.name})`));
        return { linked: true };
    }
    console.log(kleur.yellow('  ⚠ init stopping unlinked — link later with `xt init --sb-project <id>`'));
    return { linked: false };
}

// Substrate-first project verification (ADR section 40, Phase 7): re-check
// the link resolved at Phase 3.5 (verified flags). Unlinked here means state
// changed mid-run — fail closed. No prompts, no creation at this stage.
async function runSubstrateInitForProject(projectRoot: string): Promise<{ linked: boolean; projectId?: string }> {
    console.log(kleur.bold('Running Substrate initialization (sb project)...'));
    const fail = (message: string): { linked: boolean } => {
        console.log(kleur.red(`  ✗ ${message}`));
        return { linked: false };
    };

    const version = getSbVersion();
    if (!version.available) {
        return fail('sb CLI not found; cannot initialize the Substrate project. Set XTRM_SB_BIN to a local @xtrm/substrate `sb` entry (or put `sb` on PATH), then re-run xtrm init');
    }
    console.log(kleur.dim(`  ✓ sb available${version.version ? ` (${version.version})` : ''}`));

    const stateDb = defaultStateDbPath();
    if (await fs.pathExists(stateDb)) {
        console.log(kleur.dim(`  ✓ state.db present (${stateDb})`));
    } else {
        // The schema is owned by Substrate: only ensure the parent dir exists
        // here; the first sb command that opens the store initializes it.
        await fs.ensureDir(path.dirname(stateDb));
        console.log(kleur.yellow(`  ⚠ state.db not present (${stateDb}) — the next sb command initializes it`));
    }

    const current = getSbProjectLink(projectRoot);
    if (current.ok && current.projectId) {
        console.log(kleur.dim(`  ✓ checkout linked to Substrate project ${current.projectId} (via ${current.source ?? 'unknown'})`));
        return { linked: true, projectId: current.projectId };
    }
    return fail('checkout is not linked to a Substrate project (link state changed since Phase 3.5); re-run xtrm init');

    // NOTE: Claude plugin / Pi extension enrollment is owned by xtrm-6qu.13.
    // No enrollment display lives here; `xt doctor` reports integration
    // health via setup.ts once the installer pipeline lands.
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
        // gitnexus analyze unconditionally writes 6 skills into
        // <project>/.claude/skills/gitnexus/<skill-name>/SKILL.md. Because
        // xtrm makes .claude/skills a symlink to .xtrm/skills/active/, those
        // writes land in active/gitnexus/ as a non-symlink directory, which
        // breaks the flat-active-view invariant and trips activeReady (see
        // skills-runtime-views.ts hasOnlyValidSymlinkEntries). Remove the
        // pollution — the same skills are already vendored as flat entries
        // under .xtrm/skills/default/ and symlinked into active/ correctly
        // (xtrm-wbfd). projectRoot is derived from git rev-parse or an
        // internal opts.projectRoot; not user input.
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const gitnexusPollutionPath = path.join(projectRoot, '.claude', 'skills', 'gitnexus');
        try {
            fs.removeSync(gitnexusPollutionPath);
        } catch {
            // Non-fatal: if the dir wasn't created or we lack permissions,
            // activeReady will still warn; that's no worse than today.
        }
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
