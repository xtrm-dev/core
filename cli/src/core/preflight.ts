import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { spawnSync } from 'child_process';
import { calculateDiff } from './diff.js';
import {
    loadCanonicalMcpConfig,
    getCurrentServers,
    detectAgent,
} from '../utils/sync-mcp-cli.js';
import type { ChangeSet, ChangeSetCategory } from '../types/config.js';
import type { AgentName } from '../utils/sync-mcp-cli.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface FileItem {
    name: string;
    status: 'missing' | 'outdated' | 'drifted';
    category: string;
}

export interface McpItem {
    name: string;
    installed: boolean;
}

export interface TargetPlan {
    target: string;
    label: string;
    agent: string | null;
    files: FileItem[];
    mcpCore: McpItem[];
    changeSet: ChangeSet;
}

export interface OptionalServerItem {
    name: string;
    description: string;
    prerequisite?: string;
    installCmd?: string;
    postInstallMessage?: string;
}

export interface PreflightPlan {
    targets: TargetPlan[];
    optionalServers: OptionalServerItem[];
    repoRoot: string;
    syncMode: 'copy' | 'symlink' | 'prune';
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getCandidatePaths(): Array<{ label: string; path: string }> {
    const home = os.homedir();
    return [
        { label: '~/.claude (hooks + skills)', path: path.join(home, '.claude') },
        { label: '~/.agents/skills', path: path.join(home, '.agents', 'skills') },
    ];
}

export function isBinaryAvailable(binary: string): boolean {
    // Uses spawnSync (not shell exec) to avoid shell injection; binary is always
    // a hard-coded internal constant, never user-supplied input.
    const result = spawnSync('which', [binary], { stdio: 'pipe' });
    return result.status === 0;
}

// ── Main export ────────────────────────────────────────────────────────────

type TargetResult = TargetPlan | null;

function isTargetPlan(target: TargetResult): target is TargetPlan {
    return target !== null;
}

export async function runPreflight(
    repoRoot: string,
    prune = false
): Promise<PreflightPlan> {
    const candidates = getCandidatePaths();

    // Fix 4: Hoist canonical MCP config load outside the per-target map (read once, not N times)
    const canonicalMcp = loadCanonicalMcpConfig(repoRoot);

    // Run all target checks in parallel
    const targetResults: TargetResult[] = await Promise.all(
        candidates.map(async (c): Promise<TargetResult> => {
            // Fix 1: Per-target error isolation — one bad target doesn't abort the whole preflight
            try {
                const exists = await fs.pathExists(c.path);
                if (!exists) return null;

                const agent = detectAgent(c.path);

                const changeSet = await calculateDiff(repoRoot, c.path, prune);

                // Fix 3: Use proper ChangeSetCategory type cast instead of `cat as any`
                const files: FileItem[] = [];
                for (const [category, cat] of Object.entries(changeSet) as [string, ChangeSetCategory][]) {
                    for (const name of cat.missing)  files.push({ name, status: 'missing',  category });
                    for (const name of cat.outdated) files.push({ name, status: 'outdated', category });
                    for (const name of cat.drifted)  files.push({ name, status: 'drifted',  category });
                }

                const installedMcp = agent ? getCurrentServers(agent) : [];
                const mcpCore: McpItem[] = Object.keys(canonicalMcp.mcpServers || {}).map(name => ({
                    name,
                    installed: installedMcp.includes(name),
                }));

                return { target: c.path, label: c.label, agent, files, mcpCore, changeSet };
            } catch (err) {
                console.warn(`⚠ Preflight skipped ${c.label}: ${(err as Error).message}`);
                return null;
            }
        })
    );

    const targets = targetResults.filter(isTargetPlan);

    // Fix 2: Gather all actually installed MCP servers (across all agents, core + optional)
    // allInstalledMcp previously only contained core server names from mcpCore — optional servers
    // installed via CLI were never excluded from the optionalServers list.
    const allInstalledMcp = new Set<string>();
    for (const t of targets) {
        if (t.agent) {
            const installed = getCurrentServers(t.agent as AgentName);
            for (const name of installed) allInstalledMcp.add(name);
        }
    }

    // Load optional servers config
    const optionalConfig = loadCanonicalMcpConfig(repoRoot, true);

    const optionalServers: OptionalServerItem[] = Object.entries(optionalConfig.mcpServers || {})
        .filter(([name]) => !allInstalledMcp.has(name))
        .map(([name, server]: [string, any]) => ({
            name,
            description: server._notes?.description || '',
            prerequisite: server._notes?.prerequisite,
            installCmd: server._notes?.install_cmd,
            postInstallMessage: server._notes?.post_install_message,
        }));

    const syncMode: 'copy' | 'symlink' | 'prune' = prune ? 'prune' : 'copy';
    return { targets, optionalServers, repoRoot, syncMode };
}
