// XTRM-571: PRD §36.7 tool origin rules 1-6, from sourceInfo shapes recorded from Pi 1.0.0
// (pi.getAllTools() in a live session, 2026-10-03) plus the §36.12 item 4 Claude rule.

import { describe, expect, it } from 'vitest';
import type { AgentToolSource } from '@xtrm/contracts';
import { classifyClaudeTool, packageNameFromSpec, ToolOriginClassifier } from '../core/agent-host-origin.js';

const NPM = '/home/op/.pi/agent/npm/node_modules';
const pkg = (source: string, baseDir: string, file = 'index.ts', scope: 'user' | 'project' = 'user'): AgentToolSource => ({
    sourceInfo: { path: `${baseDir}/${file}`, source, scope, origin: 'package', baseDir },
});
const builtin = (name: string): AgentToolSource => ({
    sourceInfo: { path: `builtin:${name}`, source: 'builtin', scope: 'temporary', origin: 'top-level' },
});

const manifests: Record<string, { name?: string; version?: string }> = {
    [`${NPM}/pi-mcp-adapter`]: { name: 'pi-mcp-adapter', version: '2.38.0' },
    [`${NPM}/pi-ast-grep`]: { name: 'pi-ast-grep', version: '0.1.0' },
    [`${NPM}/pi-intercom`]: { name: 'pi-intercom', version: '0.16.0' },
    [`${NPM}/@jaggerxtrm/pi-extensions`]: { name: '@jaggerxtrm/pi-extensions', version: '1.4.0' },
    '/home/op/.pi/agent/git/github.com/alonw0/pi-claude-link': { name: 'pi-claude-link', version: '0.1.0' },
};

function classifier(reads: string[] = []) {
    return new ToolOriginClassifier({
        readManifest: (dir) => {
            reads.push(dir);
            return manifests[dir] ?? null;
        },
    });
}

describe('ToolOriginClassifier (PRD §36.7 rules 1-6)', () => {
    it('rule 1: coordination tools keep their transport extension and version', () => {
        const c = classifier();
        expect(c.classifyPi('intercom', pkg('npm:pi-intercom', `${NPM}/pi-intercom`))).toEqual({
            class: 'coordination',
            extension: 'npm:pi-intercom',
            version: '0.16.0',
        });
        expect(
            c.classifyPi('claude-link', pkg('git:github.com/alonw0/pi-claude-link', '/home/op/.pi/agent/git/github.com/alonw0/pi-claude-link')),
        ).toMatchObject({ class: 'coordination', extension: 'git:github.com/alonw0/pi-claude-link' });
    });

    it('rule 1: coordination is keyed by registering source plus name, not by name alone', () => {
        const c = classifier();
        // Same tool name registered by a different package is not coordination.
        expect(c.classifyPi('intercom', pkg('npm:pi-ast-grep', `${NPM}/pi-ast-grep`))).toEqual({
            class: 'extension',
            extension: 'npm:pi-ast-grep',
            version: '0.1.0',
        });
        // Specialists over MCP, both MCP paths.
        const builtinMcp = { ...builtin('mcp'), namespace: { name: 'mcp__specialists' } };
        expect(c.classifyPi('mcp__specialists__specialist_dispatch', builtinMcp)).toEqual({
            class: 'coordination',
            server: 'specialists',
            extension: 'builtin:mcp',
        });
        expect(c.classifyPi('mcp__specialists__substrate_issue', builtinMcp)).toEqual({ class: 'mcp', server: 'specialists' });
        expect(
            c.classifyPi('mcp', pkg('npm:pi-mcp-adapter', `${NPM}/pi-mcp-adapter`), { server: 'specialists', tool: 'specialist_reply' }),
        ).toEqual({ class: 'coordination', server: 'specialists', extension: 'npm:pi-mcp-adapter', version: '2.38.0' });
        // A coordination tool name on another MCP server stays mcp.
        expect(
            c.classifyPi('mcp', pkg('npm:pi-mcp-adapter', `${NPM}/pi-mcp-adapter`), { server: 'other', tool: 'specialist_reply' }),
        ).toEqual({ class: 'mcp', server: 'other' });
    });

    it('rule 2: builtin:mcp with namespace mcp__github is mcp with server github', () => {
        const tool = { ...builtin('mcp'), namespace: { name: 'mcp__github', description: 'GitHub MCP server' } };
        expect(classifier().classifyPi('mcp__github__search_code', tool)).toEqual({ class: 'mcp', server: 'github' });
        expect(classifier().classifyPi('mcp__github__search_code', builtin('mcp'))).toEqual({ class: 'mcp', server: 'unknown' });
    });

    it('rule 3: builtin:read and other built-ins are native', () => {
        expect(classifier().classifyPi('read', builtin('read'))).toEqual({ class: 'native' });
        expect(classifier().classifyPi('tool_search', builtin('tool-search'))).toEqual({ class: 'native' });
    });

    it('rule 4: pi-mcp-adapter tools are mcp; server from namespace, else proxy args, else unknown', () => {
        const adapter = pkg('npm:pi-mcp-adapter', `${NPM}/pi-mcp-adapter`);
        const c = classifier();
        expect(c.classifyPi('context7_query', { ...adapter, namespace: { name: 'mcp__context7' } })).toEqual({
            class: 'mcp',
            server: 'context7',
        });
        expect(c.classifyPi('mcp', adapter, { server: 'everything', tool: 'echo', args: {} })).toEqual({ class: 'mcp', server: 'everything' });
        expect(c.classifyPi('mcp', adapter, { search: 'echo' })).toEqual({ class: 'mcp', server: 'unknown' });
        expect(c.classifyPi('mcp', adapter)).toEqual({ class: 'mcp', server: 'unknown' });
        // A direct tool with toolPrefix none: no namespace, never a guessed server.
        expect(c.classifyPi('query_docs', adapter, { server: 'context7' })).toEqual({ class: 'mcp', server: 'unknown' });
        expect(c.classifyPi('mcpScript', adapter)).toEqual({ class: 'mcp', server: 'unknown' });
        // The class is never taken from the name: an mcp__-named tool from another package is an extension.
        expect(c.classifyPi('mcp__github__x', pkg('npm:pi-ast-grep', `${NPM}/pi-ast-grep`))).toMatchObject({ class: 'extension' });
    });

    it('rule 5: a package extension carries its package and version, read once per package', () => {
        const reads: string[] = [];
        const c = classifier(reads);
        const ext = pkg('npm:@jaggerxtrm/pi-extensions', `${NPM}/@jaggerxtrm/pi-extensions`, 'src/index.ts');
        // An extension overriding a built-in name is still the extension.
        expect(c.classifyPi('read', ext)).toEqual({ class: 'extension', extension: 'npm:@jaggerxtrm/pi-extensions', version: '1.4.0' });
        c.classifyPi('bash', ext);
        c.classifyPi('edit', ext);
        expect(reads).toEqual([`${NPM}/@jaggerxtrm/pi-extensions`]);
        // A top-level extension file without package.json: package, no version.
        const local: AgentToolSource = {
            sourceInfo: { path: '/tmp/x/probe.ts', source: 'local', scope: 'temporary', origin: 'top-level', baseDir: '/tmp/x' },
        };
        expect(c.classifyPi('probe', local)).toEqual({ class: 'extension', extension: 'local' });
    });

    it('rule 6: sdk or no record is extension unknown', () => {
        const sdk: AgentToolSource = { sourceInfo: { path: '<sdk>', source: 'sdk', scope: 'temporary', origin: 'top-level' } };
        expect(classifier().classifyPi('custom', sdk)).toEqual({ class: 'extension', extension: 'unknown' });
        expect(classifier().classifyPi('custom', undefined)).toEqual({ class: 'extension', extension: 'unknown' });
    });

    it('falls back to the package spec when package.json has no name', () => {
        expect(packageNameFromSpec('npm:pi-background-tasks@latest')).toBe('pi-background-tasks');
        expect(packageNameFromSpec('npm:@scope/name@1.2.0')).toBe('@scope/name');
        expect(packageNameFromSpec('npm:@scope/name')).toBe('@scope/name');
        expect(packageNameFromSpec('git:github.com/alonw0/pi-claude-link@v1')).toBe('pi-claude-link');
        expect(packageNameFromSpec('https://github.com/o/pi-intercom.git')).toBe('pi-intercom');
        const c = new ToolOriginClassifier({ readManifest: () => null });
        expect(c.classifyPi('intercom', pkg('npm:pi-intercom@0.16.0', '/nowhere'))).toEqual({
            class: 'coordination',
            extension: 'npm:pi-intercom@0.16.0',
        });
    });
});

describe('classifyClaudeTool (PRD §36.12 item 4)', () => {
    it('built-ins are native, mcp__<server>__<tool> is mcp, the subagent tool is coordination', () => {
        expect(classifyClaudeTool('Read')).toEqual({ class: 'native' });
        expect(classifyClaudeTool('mcp__plugin_context-mode_context-mode__ctx_execute')).toEqual({
            class: 'mcp',
            server: 'plugin_context-mode_context-mode',
        });
        expect(classifyClaudeTool('mcp__specialists__specialist_dispatch')).toEqual({ class: 'coordination', server: 'specialists' });
        expect(classifyClaudeTool('Agent')).toEqual({ class: 'coordination' });
    });
});
