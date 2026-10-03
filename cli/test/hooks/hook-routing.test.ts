import { describe, it, expect } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';

import { resolvePackageRoot } from '../../src/core/registry-scaffold.js';
import { EDIT_TOOLS, PRE_TOOLS, GITNEXUS_TOOLS, JS_EXTS } from '../../../.xtrm/hooks/hook-routing.mjs';

// CORE-2339: the dispatcher's tool routing is the only thing deciding whether a
// check runs for a call. Before this module the sets lived inline in dispatch.mjs
// and nothing asserted them, so an edit could silently drop an enforcement path.
// These tests pin them against the two things they must agree with: the policy
// matchers they replaced, and the tool names the gitnexus hook understands.

describe('hook routing tables (.xtrm/hooks/hook-routing.mjs)', () => {
    it('EDIT_TOOLS matches $WRITE_TOOLS in the policy compiler', () => {
        const compiler = fs.readFileSync(
            path.join(resolvePackageRoot(), 'scripts', 'compile-policies.mjs'), 'utf8');
        const block = compiler.slice(compiler.indexOf('const WRITE_TOOLS = ['));
        const parsed = JSON.parse('[' + block.slice(block.indexOf('[') + 1, block.indexOf(']')).trim().replace(/'/g, '"').replace(/,\s*$/, '') + ']');
        expect(EDIT_TOOLS).toEqual(parsed);
    });

    it('PRE_TOOLS keeps the guard tools of the former PreToolUse matcher', () => {
        // Until XTRM-592 the compiled matcher was $WRITE_TOOLS|Agent. The agent host
        // reporter needs every tool, so the matcher is now empty and PRE_TOOLS alone
        // decides which tools pay for guard work inside `dispatch.mjs pre`.
        expect([...PRE_TOOLS].sort()).toEqual([...EDIT_TOOLS, 'Agent'].sort());
        const hooks = fs.readJsonSync(path.join(resolvePackageRoot(), '.xtrm', 'config', 'hooks.json')) as {
            hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
        };
        const pre = hooks.hooks.PreToolUse ?? [];
        expect(pre).toHaveLength(1);
        expect(pre[0].matcher ?? '').toBe('');
        expect(pre[0].hooks).toHaveLength(1);
        expect(pre[0].hooks[0].command).toContain('dispatch.mjs pre');
    });

    it('GITNEXUS_TOOLS covers every tool gitnexus-hook.cjs can extract from', () => {
        const hook = fs.readFileSync(
            path.join(resolvePackageRoot(), '.xtrm', 'hooks', 'gitnexus', 'gitnexus-hook.cjs'), 'utf8');
        // Every tool the hook branches on must be routed to it.
        for (const tool of ['Bash', 'Grep', 'Glob', 'Read']) {
            expect(GITNEXUS_TOOLS, `${tool} is handled by the hook but not routed`).toContain(tool);
        }
        // The Serena branches are the reason the routing set is a superset of the
        // canonical Bash|Grep|Read|Glob matcher.
        const serenaInHook = [...hook.matchAll(/'(mcp__serena__[a-z_]+)'/g)].map(m => m[1]);
        expect(serenaInHook.length).toBeGreaterThan(0);
        for (const tool of serenaInHook) {
            expect(GITNEXUS_TOOLS, `${tool} is a live hook branch but not routed`).toContain(tool);
        }
    });

    it('JS_EXTS matches quality-check.cjs isSourceFile', () => {
        const gate = fs.readFileSync(
            path.join(resolvePackageRoot(), '.xtrm', 'hooks', 'quality-check.cjs'), 'utf8');
        const regex = gate.match(/function isSourceFile\([^)]*\)\s*\{\s*return \/\\\.\(([^)]*)\)/)?.[1];
        expect(JS_EXTS.map(e => e.slice(1)).sort()).toEqual((regex as string).split('|').sort());
    });
});
