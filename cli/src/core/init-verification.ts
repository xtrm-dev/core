/**
 * Unified verification for xtrm init phases.
 *
 * Summarizes outcomes from all installer phases in one place:
 * - Machine bootstrap (third-party CLIs)
 * - Claude runtime (.xtrm hooks wired into settings.json)
 * - Pi runtime (extensions + packages)
 * - Project bootstrap (beads, GitNexus, instruction headers)
 */

import { spawnSync } from 'child_process';
import fs from 'fs-extra';
import kleur from 'kleur';
import os from 'os';
import path from 'path';
import { t, sym } from '../utils/theme.js';
import { inventoryDeps, type BootstrapPlan } from './machine-bootstrap.js';
import { inventoryPiRuntime, resolveManagedPiExtensionsSourceDir, type PiRuntimePlan } from './pi-runtime.js';
import { checkRuntimeSkillsViews } from './skills-runtime-views.js';

interface CommandHook {
    type?: string;
    command?: string;
}

interface HookWrapper {
    hooks?: CommandHook[];
}

interface ClaudeSettings {
    hooks?: Record<string, HookWrapper[]>;
}

export interface VerificationResult {
    machineBootstrap: {
        allRequiredPresent: boolean;
        missingRequired: string[];
    };
    claudeRuntime: {
        hooksWired: boolean;
        hooksEvents: number;
        hookCommands: number;
        settingsPath: string;
    };
    piRuntime: {
        allRequiredPresent: boolean;
        missingExtensions: string[];
        missingPackages: string[];
    };
    skillsRuntime: {
        activeReady: boolean;
        claudePointerReady: boolean;
        piPointerReady: boolean;
        hasDeprecatedAgentsSkillsPath: boolean;
    };
    projectBootstrap: {
        beadsInitialized: boolean;
        gitnexusIndexed: boolean;
        instructionHeaders: boolean;
    };
    allPassed: boolean;
}

// ── Phase-specific checks ────────────────────────────────────────────────────

function verifyMachineBootstrap(): BootstrapPlan {
    return inventoryDeps();
}

function countHookCommands(hooks: Record<string, HookWrapper[]>): number {
    let count = 0;

    for (const wrappers of Object.values(hooks)) {
        for (const wrapper of wrappers) {
            count += wrapper.hooks?.length ?? 0;
        }
    }

    return count;
}

function hasXtrmHookCommand(hooks: Record<string, HookWrapper[]>): boolean {
    for (const wrappers of Object.values(hooks)) {
        for (const wrapper of wrappers) {
            for (const hook of wrapper.hooks ?? []) {
                if (hook.type !== 'command') continue;
                if (typeof hook.command !== 'string') continue;
                const normalizedCommand = hook.command.replace(/\\/g, '/');
                if (normalizedCommand.includes('/.xtrm/hooks/')) return true;
            }
        }
    }

    return false;
}

function readClaudeSettingsVerification(settingsPath: string): {
    hooksWired: boolean;
    hooksEvents: number;
    hookCommands: number;
    settingsPath: string;
} {
    try {
        const settings = fs.readJsonSync(settingsPath) as ClaudeSettings;
        const hooks = settings.hooks ?? {};
        const hooksEvents = Object.keys(hooks).length;
        const hookCommands = countHookCommands(hooks);
        const hooksWired = hooksEvents > 0 && hookCommands > 0 && hasXtrmHookCommand(hooks);

        return {
            hooksWired,
            hooksEvents,
            hookCommands,
            settingsPath,
        };
    } catch {
        return {
            hooksWired: false,
            hooksEvents: 0,
            hookCommands: 0,
            settingsPath,
        };
    }
}

function verifyClaudeRuntime(projectRoot: string): {
    hooksWired: boolean;
    hooksEvents: number;
    hookCommands: number;
    settingsPath: string;
} {
    const projectSettingsPath = path.join(projectRoot, '.claude', 'settings.json');
    const fallbackSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const candidatePaths = projectSettingsPath === fallbackSettingsPath
        ? [projectSettingsPath]
        : [projectSettingsPath, fallbackSettingsPath];

    let fallbackResult = {
        hooksWired: false,
        hooksEvents: 0,
        hookCommands: 0,
        settingsPath: projectSettingsPath,
    };

    for (const settingsPath of candidatePaths) {
        if (!fs.pathExistsSync(settingsPath)) {
            continue;
        }

        const result = readClaudeSettingsVerification(settingsPath);
        if (result.hooksWired) {
            return result;
        }

        if (result.hookCommands > fallbackResult.hookCommands || result.hooksEvents > fallbackResult.hooksEvents) {
            fallbackResult = result;
        }
    }

    return fallbackResult;
}

async function verifyPiRuntime(projectRoot: string): Promise<PiRuntimePlan> {
    const sourceDir = resolveManagedPiExtensionsSourceDir();

    if (!sourceDir || !await fs.pathExists(sourceDir)) {
        // Not bundled — return empty plan
        return {
            extensions: [],
            packages: [],
            missingExtensions: [],
            staleExtensions: [],
            orphanedExtensions: [],
            missingPackages: [],
            allRequiredPresent: true,
            allPresent: true,
        };
    }

    // Project installs are package-based; verification only needs the managed
    // package inventory. Pass sourceDir as targetDir so extension checks remain
    // satisfied without requiring a mirrored .pi/extensions tree.
    void projectRoot;
    return await inventoryPiRuntime(sourceDir, sourceDir);
}

function verifyProjectBootstrap(projectRoot: string): { beadsInitialized: boolean; gitnexusIndexed: boolean; instructionHeaders: boolean } {
    const beadsInitialized = fs.pathExistsSync(path.join(projectRoot, '.beads'));

    const gnStatus = spawnSync('gitnexus', ['status'], { cwd: projectRoot, encoding: 'utf8', timeout: 5000 });
    const gnText = `${gnStatus.stdout ?? ''}\n${gnStatus.stderr ?? ''}`.toLowerCase();
    const gitnexusIndexed = gnStatus.status === 0 &&
        !gnText.includes('stale') &&
        !gnText.includes('not indexed') &&
        !gnText.includes('missing');

    const agentsMd = fs.pathExistsSync(path.join(projectRoot, 'AGENTS.md'));
    const claudeMd = fs.pathExistsSync(path.join(projectRoot, 'CLAUDE.md'));
    const instructionHeaders = agentsMd || claudeMd;

    return { beadsInitialized, gitnexusIndexed, instructionHeaders };
}

// ── Full verification ─────────────────────────────────────────────────────────

export async function runInitVerification(projectRoot: string): Promise<VerificationResult> {
    const machinePlan = verifyMachineBootstrap();
    const claudeResult = verifyClaudeRuntime(projectRoot);
    const piPlan = await verifyPiRuntime(projectRoot);
    const projectResult = verifyProjectBootstrap(projectRoot);
    const skillsRuntimeResult = await checkRuntimeSkillsViews(projectRoot);

    const allPassed =
        machinePlan.allRequiredPresent &&
        claudeResult.hooksWired &&
        piPlan.allRequiredPresent &&
        skillsRuntimeResult.activeReady &&
        skillsRuntimeResult.claudePointerReady &&
        skillsRuntimeResult.piPointerReady &&
        projectResult.beadsInitialized;

    return {
        machineBootstrap: {
            allRequiredPresent: machinePlan.allRequiredPresent,
            missingRequired: machinePlan.missingRequired.map(d => d.dep.displayName),
        },
        claudeRuntime: claudeResult,
        piRuntime: {
            allRequiredPresent: piPlan.allRequiredPresent,
            missingExtensions: piPlan.missingExtensions.filter(s => s.ext.required).map(s => s.ext.displayName),
            missingPackages: piPlan.missingPackages.filter(s => s.pkg.required).map(s => s.pkg.displayName),
        },
        skillsRuntime: {
            activeReady: skillsRuntimeResult.activeReady,
            claudePointerReady: skillsRuntimeResult.claudePointerReady,
            piPointerReady: skillsRuntimeResult.piPointerReady,
            hasDeprecatedAgentsSkillsPath: skillsRuntimeResult.hasDeprecatedAgentsSkillsPath,
        },
        projectBootstrap: projectResult,
        allPassed,
    };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

export function renderVerificationSummary(result: VerificationResult): void {
    console.log(kleur.bold('\n  Verification Summary'));
    console.log(kleur.dim('  ' + '─'.repeat(50)));

    // Machine bootstrap
    const mbIcon = result.machineBootstrap.allRequiredPresent ? sym.ok : sym.warn;
    const mbLabel = 'Machine Bootstrap';
    if (result.machineBootstrap.allRequiredPresent) {
        console.log(`  ${mbIcon} ${mbLabel}`);
    } else {
        const missing = result.machineBootstrap.missingRequired.join(', ');
        console.log(`  ${mbIcon} ${mbLabel} — missing: ${missing}`);
    }

    // Claude runtime
    const crIcon = result.claudeRuntime.hooksWired ? sym.ok : sym.warn;
    const crLabel = 'Claude Runtime';
    if (result.claudeRuntime.hooksWired) {
        console.log(`  ${crIcon} ${crLabel}`);
    } else {
        console.log(`  ${crIcon} ${crLabel} — missing .xtrm/hooks wiring in ${result.claudeRuntime.settingsPath}`);
    }

    // Pi runtime
    const prIcon = result.piRuntime.allRequiredPresent ? sym.ok : sym.warn;
    const prLabel = 'Pi Runtime';
    if (result.piRuntime.allRequiredPresent) {
        console.log(`  ${prIcon} ${prLabel}`);
    } else {
        const parts: string[] = [];
        if (result.piRuntime.missingExtensions.length > 0) {
            parts.push(`extensions: ${result.piRuntime.missingExtensions.join(', ')}`);
        }
        if (result.piRuntime.missingPackages.length > 0) {
            parts.push(`packages: ${result.piRuntime.missingPackages.join(', ')}`);
        }
        console.log(`  ${prIcon} ${prLabel} — ${parts.join('; ')}`);
    }

    // Skills runtime
    const skillsParts: string[] = [];
    if (!result.skillsRuntime.activeReady) skillsParts.push('active');
    if (!result.skillsRuntime.claudePointerReady) skillsParts.push('.claude/skills pointer');
    if (!result.skillsRuntime.piPointerReady) skillsParts.push('.pi settings skills pointer');
    const srIcon = skillsParts.length === 0 ? sym.ok : sym.warn;
    if (skillsParts.length === 0) {
        console.log(`  ${srIcon} Skills Runtime`);
    } else {
        console.log(`  ${srIcon} Skills Runtime — incomplete: ${skillsParts.join(', ')}`);
    }
    if (result.skillsRuntime.hasDeprecatedAgentsSkillsPath) {
        console.log(`  ${sym.warn} Deprecated path present: .agents/skills`);
    }

    // Project bootstrap
    const pbParts: string[] = [];
    if (!result.projectBootstrap.beadsInitialized) pbParts.push('beads');
    if (!result.projectBootstrap.gitnexusIndexed) pbParts.push('gitnexus');
    if (!result.projectBootstrap.instructionHeaders) pbParts.push('headers');
    const pbIcon = pbParts.length === 0 ? sym.ok : sym.warn;
    const pbLabel = 'Project Bootstrap';
    if (pbParts.length === 0) {
        console.log(`  ${pbIcon} ${pbLabel}`);
    } else {
        console.log(`  ${pbIcon} ${pbLabel} — incomplete: ${pbParts.join(', ')}`);
    }

    console.log(kleur.dim('  ' + '─'.repeat(50)));

    if (result.allPassed) {
        console.log(t.success('\n  ✓ All phases verified successfully.\n'));
    } else {
        console.log(t.warning('\n  ⚠ Some phases incomplete. Re-run `xtrm init` to fix.\n'));
    }
}
