import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CORE-2792 behavioural proof: the launch identity reaches the resumed runtime.
// This file imports only symbols that already exist on the base commit, so it
// compiles and runs there and fails on behaviour, not on a missing export.

const mocked = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocked.spawnSync }));

import { buildAttachEnv, buildFreshLaunchOptions } from '../commands/attach.js';
import type { WorktreeInfo } from '../commands/worktree.js';

const LAUNCH = {
    role: 'worker',
    requestedRole: 'worker',
    task: 'role:worker',
    worktree: '/repo/.xtrm/worktrees/repo-xt-pi-demo',
    branch: 'xt/demo',
    parentSession: '$0',
    sessionName: 'role-pi-worker-core-2792',
    displayName: 'repo-xt-pi-demo',
    model: 'pi-model-x',
    thinking: 'low',
};

describe('CORE-2792 attach restores the launch identity', () => {
    const saved: Record<string, string | undefined> = {};
    const KEYS = ['TMUX', 'TMUX_PANE', 'XTRM_SESSION_ID', 'XTRM_SESSION_NAME', 'XTMUX_AGENT_ROLE',
        'XTMUX_AGENT_TASK', 'XTMUX_AGENT_WORKTREE', 'XTRM_ROLE'];
    let tempRoot = '';
    let worktree = '';

    beforeEach(async () => {
        for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
        mocked.spawnSync.mockReset();
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-attach-base-'));
        worktree = path.join(tempRoot, 'repo', '.xtrm', 'worktrees', 'repo-xt-pi-demo');
        await fs.ensureDir(path.join(worktree, '.xtrm'));
    });

    afterEach(async () => {
        for (const key of KEYS) {
            if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
        }
        await fs.remove(tempRoot);
    });

    it('exports the restored pane identity and drops the attacher\'s own', () => {
        const env = buildAttachEnv(
            { PATH: '/usr/bin', XTMUX_AGENT_WORKTREE: '/attacher/wt', XTMUX_AGENT_ROLE: 'lead' },
            'pi',
            {},
            'demo',
            worktree,
            [
                { key: '@agent_role', value: 'worker' },
                { key: '@agent_task', value: 'role:worker' },
                { key: '@agent_bead', value: 'CORE-2792' },
                { key: '@agent_worktree', value: worktree },
            ] as never,
        );
        expect(env.XTMUX_AGENT_ROLE).toBe('worker');
        expect(env.XTMUX_AGENT_TASK).toBe('role:worker');
        expect(env.XTMUX_AGENT_BEAD).toBe('CORE-2792');
        // The attacher's own worktree must not survive into the resumed worker.
        expect(env.XTMUX_AGENT_WORKTREE).toBe(worktree);
        expect(env.SUBSTRATE_HOLDER).toBe('demo');
    });

    it('exports the session identity of the pane it resumes in', () => {
        mocked.spawnSync.mockImplementation((_command: string, args: string[] = []) => {
            const joined = args.join(' ');
            if (joined.includes('#{session_id}')) return { status: 0, stdout: '$0\n', stderr: '' };
            if (joined.includes('#{session_name}')) return { status: 0, stdout: 'xx\n', stderr: '' };
            return { status: 1, stdout: '', stderr: '' };
        });
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const env = buildAttachEnv({ TMUX: process.env.TMUX, TMUX_PANE: '%10' }, 'pi', {}, 'demo', worktree, []);
        expect(env.XTRM_SESSION_ID).toBe('$0');
        expect(env.XTRM_SESSION_NAME).toBe('xx');
    });

    it('takes role, model and thinking from the launch record for --fresh', async () => {
        await fs.writeFile(path.join(worktree, '.xtrm', 'session-meta.json'), JSON.stringify({
            runtime: 'pi', launchedAt: '2026-11-25T13:56:00.302Z', bead: 'CORE-2792', launch: LAUNCH,
        }));
        const target: WorktreeInfo = { path: worktree, branch: 'refs/heads/xt/demo', head: 'abc123', prunable: false };
        const options = buildFreshLaunchOptions(target, {}, { issue: null, dispatcher: {} });
        expect(options.role).toBe('worker');
        expect(options.model).toBe('pi-model-x');
        expect(options.thinking).toBe('low');
    });
});
