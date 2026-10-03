/**
 * Tool origin classification of the XTRM agent host (PRD xtrm-app §36.7, §36.12 item 4; XTRM-571).
 *
 * The class comes from the tool's registration record, never from the tool name alone.
 * Pi sessions send `tool: {sourceInfo, namespace?}` raw with each tool event (XTRM-564);
 * the rules below apply in the §36.7 order. Claude sessions use their own registration
 * scheme (§36.12 item 4).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentToolOrigin, AgentToolSource } from '@xtrm/contracts';

/**
 * Coordination tools (§36.7 rule 1), keyed by registering source plus tool name.
 * `extension` matches the registering Pi package by name; `mcpServer` matches the MCP
 * server that registers the tool, whichever MCP path (rule 2 or 4) transports it.
 */
export const COORDINATION_TOOLS: readonly (
    | { extension: string; tools: readonly string[] }
    | { mcpServer: string; tools: readonly string[] }
)[] = [
    { extension: 'pi-intercom', tools: ['intercom', 'contact_supervisor'] },
    { extension: 'pi-claude-link', tools: ['claude-link'] },
    {
        mcpServer: 'specialists',
        tools: [
            'specialist_dispatch',
            'specialist_reply',
            'specialist_resume',
            'specialist_retry',
            'specialist_status',
            'specialist_steer',
            'specialist_stop_activation',
        ],
    },
];

const MCP_ADAPTER_PACKAGE = 'pi-mcp-adapter';
/** The pi-mcp-adapter proxy tool; its target server is a call argument. */
const MCP_ADAPTER_PROXY_TOOL = 'mcp';
const UNKNOWN = 'unknown';
/** Claude's subagent tool (§36.12 item 4); `Task` is its earlier name. */
const CLAUDE_SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

interface PackageManifest {
    name?: string;
    version?: string;
}

export type ManifestReader = (baseDir: string) => PackageManifest | null;

function readManifest(baseDir: string): PackageManifest | null {
    try {
        const parsed = JSON.parse(readFileSync(path.join(baseDir, 'package.json'), 'utf8')) as Record<string, unknown>;
        return {
            ...(typeof parsed.name === 'string' && parsed.name ? { name: parsed.name } : {}),
            ...(typeof parsed.version === 'string' && parsed.version ? { version: parsed.version } : {}),
        };
    } catch {
        return null;
    }
}

/** Package name from a Pi package spec: `npm:@scope/name@1.2.0`, `git:github.com/o/name@ref`, or a path. */
export function packageNameFromSpec(spec: string): string {
    if (spec.startsWith('npm:')) {
        const body = spec.slice(4);
        const at = body.indexOf('@', body.startsWith('@') ? 1 : 0);
        return at === -1 ? body : body.slice(0, at);
    }
    const tail = spec.replace(/[#@][^/]*$/, '').replace(/\/+$/, '').split(/[/\\]/).pop() ?? spec;
    return tail.replace(/\.git$/, '') || spec;
}

function mcpServerFromNamespace(namespace: AgentToolSource['namespace']): string | undefined {
    const name = namespace?.name;
    return name?.startsWith('mcp__') && name.length > 5 ? name.slice(5) : undefined;
}

function stripPrefix(value: string, prefix: string): string {
    return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Claude tool classes (§36.12 item 4): `mcp__<server>__<tool>` is Claude's own registration scheme. */
export function classifyClaudeTool(toolName: string): AgentToolOrigin {
    if (toolName.startsWith('mcp__')) {
        const rest = toolName.slice(5);
        const sep = rest.indexOf('__');
        const server = sep > 0 ? rest.slice(0, sep) : '';
        const tool = sep > 0 ? rest.slice(sep + 2) : '';
        if (server && tool) {
            if (isCoordinationMcpTool(server, [tool])) return { class: 'coordination', server };
            return { class: 'mcp', server };
        }
    }
    if (CLAUDE_SUBAGENT_TOOLS.has(toolName)) return { class: 'coordination' };
    return { class: 'native' };
}

function isCoordinationMcpTool(server: string, candidates: readonly string[]): boolean {
    return COORDINATION_TOOLS.some(
        (entry) => 'mcpServer' in entry && entry.mcpServer === server && candidates.some((c) => entry.tools.includes(c)),
    );
}

export class ToolOriginClassifier {
    private readonly manifests = new Map<string, PackageManifest | null>();
    private readonly readManifest: ManifestReader;

    constructor(options: { readManifest?: ManifestReader } = {}) {
        this.readManifest = options.readManifest ?? readManifest;
    }

    /** Classify one Pi tool call from its raw registration record and, for the MCP proxy tool, its args. */
    classifyPi(toolName: string, tool: AgentToolSource | undefined, args?: unknown): AgentToolOrigin {
        const info = tool?.sourceInfo;
        // Rule 6: no record, or registered through the SDK.
        if (!info || info.source === 'sdk') return { class: 'extension', extension: UNKNOWN };

        // Rule 2: Pi's built-in MCP client.
        if (info.path === 'builtin:mcp') {
            const server = mcpServerFromNamespace(tool.namespace) ?? UNKNOWN;
            if (server !== UNKNOWN && isCoordinationMcpTool(server, [stripPrefix(toolName, `mcp__${server}__`)])) {
                return { class: 'coordination', server, extension: info.path };
            }
            return { class: 'mcp', server };
        }
        // Rule 3: other built-ins.
        if (info.source === 'builtin') return { class: 'native' };

        const manifest = info.baseDir ? this.manifest(info.baseDir) : null;
        const packageName = manifest?.name ?? packageNameFromSpec(info.source);
        const transport = { extension: info.source, ...(manifest?.version ? { version: manifest.version } : {}) };

        // Rule 4: the pi-mcp-adapter package.
        if (packageName === MCP_ADAPTER_PACKAGE) {
            const callArgs = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
            const server =
                mcpServerFromNamespace(tool.namespace) ??
                (toolName === MCP_ADAPTER_PROXY_TOOL ? nonEmptyString(callArgs.server) : undefined) ??
                UNKNOWN;
            // The MCP tool name: the proxy's `tool` argument, else the direct tool without its server prefix.
            const candidates = [
                nonEmptyString(callArgs.tool) ?? '',
                stripPrefix(toolName, `mcp__${server}__`),
                stripPrefix(toolName, `${server}_`),
            ];
            if (server !== UNKNOWN && isCoordinationMcpTool(server, candidates)) {
                return { class: 'coordination', server, ...transport };
            }
            return { class: 'mcp', server };
        }

        // Rule 1 for extension-transported coordination tools.
        const coordination = COORDINATION_TOOLS.some(
            (entry) => 'extension' in entry && entry.extension === packageName && entry.tools.includes(toolName),
        );
        // Rule 5: any other extension (package or top-level).
        return { class: coordination ? 'coordination' : 'extension', ...transport };
    }

    /** package.json is read once per package directory and cached, including a miss. */
    private manifest(baseDir: string): PackageManifest | null {
        if (!this.manifests.has(baseDir)) this.manifests.set(baseDir, this.readManifest(baseDir));
        return this.manifests.get(baseDir) ?? null;
    }
}
