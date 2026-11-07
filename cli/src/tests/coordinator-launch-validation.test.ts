// Coordinator-aware launch validation (audit P1-05). xtrm-6hey0.3.
//
// The merge-authority gate (audit P1-04) lived in `xt merge` and retired with
// that command (CORE-2552); its guard moves to the gh wrapper under CORE-2530.
//
// Every check here runs BEFORE any worktree is created — a rejected coordinator
// launch must leave nothing on disk. The "leaks nothing" property is asserted
// explicitly at the bottom rather than assumed from call ordering.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
    checkSubordinateRole,
    parseSpecialistJson,
    resolveSubordinateLaunch,
    subordinateRejection,
    type ResolvedRole,
} from '../utils/worktree-session.js';

const ROLE: ResolvedRole = {
    name: 'chain-coordinator',
    systemPrompt: 'You coordinate one epic.',
    skillPaths: [],
};

describe('parseSpecialistJson — execution.interactive (envelope additive field)', () => {
    const withExecution = (execution: unknown): ResolvedRole => parseSpecialistJson(
        'chain-coordinator',
        JSON.stringify({
            specialist: {
                metadata: { name: 'chain-coordinator' },
                prompt: { system: 'x' },
                skills: { paths: [] },
                execution,
            },
        }),
    );

    it('lifts an explicit true', () => {
        expect(withExecution({ interactive: true }).interactive).toBe(true);
    });

    it('lifts an explicit false', () => {
        expect(withExecution({ interactive: false }).interactive).toBe(false);
    });

    it('leaves it undefined when the release does not declare it', () => {
        // Tri-state matters: an older Specialists must stay launchable.
        expect(withExecution({ model: 'x' }).interactive).toBeUndefined();
        expect(withExecution(undefined).interactive).toBeUndefined();
    });

    it('ignores a non-boolean rather than coercing it', () => {
        expect(withExecution({ interactive: 'yes' }).interactive).toBeUndefined();
        expect(withExecution({ interactive: 1 }).interactive).toBeUndefined();
    });
});

describe('resolveSubordinateLaunch — argv-level P1-05 checks', () => {
    const base = { runtime: 'pi' as const, role: 'chain-coordinator', bead: 'xtrm-6hey0', insideTmux: true };

    it('accepts a complete subordinate launch', () => {
        expect(resolveSubordinateLaunch(base)).toEqual({
            ok: true, newSession: true, attach: false, child: true,
        });
    });

    it('requires --bead — a coordinator with no epic has no scope to own', () => {
        const r = resolveSubordinateLaunch({ ...base, bead: undefined });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toContain('requires --bead');
    });

    it('leaves parenting to an explicit --parent when the operator named one', () => {
        // child=false: --parent already carries the relationship and wins.
        expect(resolveSubordinateLaunch({ ...base, parent: '$12' })).toEqual({
            ok: true, newSession: true, attach: false, child: false,
        });
    });

    it('requires --role', () => {
        const r = resolveSubordinateLaunch({ ...base, role: undefined });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toContain('requires --role');
    });

    it('names the runtime actually being launched in the remediation', () => {
        const pi = resolveSubordinateLaunch({ ...base, role: undefined });
        const claude = resolveSubordinateLaunch({ ...base, runtime: 'claude', role: undefined });
        if (pi.ok || claude.ok) throw new Error('unreachable');
        expect(pi.error).toContain('xt pi <name>');
        expect(claude.error).toContain('xt claude <name>');
    });

    it('requires a parent session outside tmux unless --parent names one', () => {
        const without = resolveSubordinateLaunch({ ...base, insideTmux: false });
        expect(without.ok).toBe(false);
        const withParent = resolveSubordinateLaunch({ ...base, insideTmux: false, parent: 'xt-design' });
        expect(withParent.ok).toBe(true);
    });

    it('shapes every rejection with the canonical remediation command', () => {
        const r = resolveSubordinateLaunch({ ...base, bead: undefined });
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toBe(subordinateRejection(
            'pi',
            '--subordinate scopes a coordinator to one epic and requires --bead',
        ));
        expect(r.error).toContain('--new-session');
        expect(r.error).toContain('--no-attach');
        expect(r.error).toContain('--parent <session-id>');
    });
});

describe('checkSubordinateRole — role-level P1-05 checks', () => {
    it('accepts an interactive role launched from a plain pane', () => {
        expect(checkSubordinateRole({
            runtime: 'pi',
            role: { ...ROLE, interactive: true },
            launchingPaneRole: '',
        })).toEqual({ ok: true });
    });

    it('accepts a role that does not declare interactive (older Specialists)', () => {
        expect(checkSubordinateRole({
            runtime: 'pi', role: ROLE, launchingPaneRole: '',
        })).toEqual({ ok: true });
    });

    it('rejects a role that declares interactive=false', () => {
        const r = checkSubordinateRole({
            runtime: 'claude',
            role: { ...ROLE, interactive: false },
            launchingPaneRole: '',
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toContain('execution.interactive=false');
        expect(r.error).toContain('background job, not a session');
    });

    it('rejects a nested coordinator', () => {
        const r = checkSubordinateRole({
            runtime: 'pi',
            role: { ...ROLE, interactive: true },
            launchingPaneRole: 'chain-coordinator',
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.error).toContain('nested coordinator');
        expect(r.error).toContain('escalate to the main orchestrator');
    });

    it('allows a coordinator launched from a pane running a DIFFERENT role', () => {
        // The rule is "no self-nesting", not "no role may launch a role" — an
        // orchestrator pane primed with some other role is still a valid parent.
        expect(checkSubordinateRole({
            runtime: 'pi',
            role: { ...ROLE, interactive: true },
            launchingPaneRole: 'reviewer',
        })).toEqual({ ok: true });
    });
});

// End-to-end: a rejected coordinator launch must not create a worktree. Drives
// the real CLI so the assertion covers call ordering inside
// launchWorktreeSession, not just the pure validators above.
describe('rejected subordinate launch leaves no worktree behind', () => {
    const sandboxes: string[] = [];
    afterEach(() => {
        for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function sandboxRepo(): { repo: string; bin: string } {
        const root = path.join(os.tmpdir(), `xtrm-p105-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
        const repo = path.join(root, 'repo');
        const bin = path.join(root, 'bin');
        mkdirSync(repo, { recursive: true });
        mkdirSync(bin, { recursive: true });
        sandboxes.push(root);
        for (const args of [
            ['init', '-b', 'main'],
            ['config', 'user.email', 'p105@example.invalid'],
            ['config', 'user.name', 'p105'],
        ]) spawnSync('git', args, { cwd: repo, stdio: 'ignore' });
        writeFileSync(path.join(repo, 'README.md'), '#\n');
        spawnSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
        spawnSync('git', ['commit', '-m', 'x'], { cwd: repo, stdio: 'ignore' });
        return { repo, bin };
    }

    function writeSp(bin: string, interactive: boolean): void {
        const sp = path.join(bin, 'sp');
        const spec = JSON.stringify({
            specialist: {
                metadata: { name: 'chain-coordinator' },
                execution: { interactive },
                prompt: { system: 'coordinate' },
                skills: { paths: [] },
            },
        });
        writeFileSync(sp, `#!/bin/sh\ncase "$1" in\n  view) printf '%s\\n' '${spec}' ;;\n  *) exit 1 ;;\nesac\n`);
        chmodSync(sp, 0o755);
    }

    const worktreeCount = (repo: string): number => {
        const dir = path.join(repo, '.xtrm', 'worktrees');
        return existsSync(dir) ? readdirSync(dir).length : 0;
    };

    // Drive the built bundle, like cli/test/init-cli.test.ts does — CI builds
    // before it tests, so this exercises the artifact that actually ships.
    const CLI_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.cjs');

    const runXt = (repo: string, bin: string, args: string[]) => spawnSync(
        process.execPath,
        [CLI_BIN, ...args],
        {
            cwd: repo,
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX: '' },
        },
    );

    it('rejects --subordinate without --bead and creates nothing', () => {
        const { repo, bin } = sandboxRepo();
        writeSp(bin, true);
        const r = runXt(repo, bin, ['claude', 'c', '--role', 'chain-coordinator', '--subordinate', '--parent', 'x']);
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toContain('requires --bead');
        expect(worktreeCount(repo)).toBe(0);
    });

    it('rejects a non-interactive role and creates nothing', () => {
        const { repo, bin } = sandboxRepo();
        writeSp(bin, false);
        const r = runXt(repo, bin, [
            'claude', 'c', '--role', 'chain-coordinator', '--bead', 'b', '--subordinate', '--parent', 'x',
        ]);
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toContain('execution.interactive=false');
        expect(worktreeCount(repo)).toBe(0);
    });
});
