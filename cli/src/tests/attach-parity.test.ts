import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CORE-2792: `xt attach` must restore the launch identity the launcher wrote
// onto the pane and into the pane's environment. A pane option dies with the
// pane (power loss, reopened terminal), so the durable source is the worktree
// session record's `launch` block; these tests cover that record, the restored
// pane options, the restored environment, and the resume action end to end over
// a hermetic spawnSync (no real tmux, git or runtime).

const mocked = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocked.spawnSync }));

import {
    buildAttachEnv,
    buildFreshLaunchOptions,
    currentPaneId,
    restoredAttachPaneOptions,
    stripRestoredEnv,
} from '../commands/attach.js';
import type { WorktreeInfo } from '../commands/worktree.js';

const LAUNCH = {
    role: 'worker',
    requestedRole: 'worker',
    task: 'role:worker',
    worktree: '/repo/.xtrm/worktrees/repo-xt-pi-demo',
    branch: 'xt/demo',
    parentSession: '$0',
    sessionName: 'role-pi-worker-core-2792',
    model: 'pi-model-x',
};

describe('CORE-2792 launch record', () => {
    let tempRoot = '';

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-attach-parity-'));
        mocked.spawnSync.mockReset();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await fs.remove(tempRoot);
    });

    it('persists the launch identity and preserves the bead, binding and launch time', async () => {
        const { writeSessionMeta, writeSessionBindingId, writeSessionLaunch, readSessionMeta, readSessionLaunch } =
            await import('../utils/worktree-session.js');
        const worktree = path.join(tempRoot, 'repo-xt-pi-demo');
        await fs.ensureDir(worktree);
        expect(writeSessionMeta(worktree, 'pi', 'CORE-2792')).toBe(true);
        const launchedAt = readSessionMeta(worktree)?.launchedAt;
        expect(writeSessionBindingId(worktree, 'exb_01a212fd')).toBe(true);

        expect(writeSessionLaunch(worktree, 'pi', LAUNCH)).toBe(true);
        const meta = readSessionMeta(worktree);
        expect(meta).toMatchObject({
            runtime: 'pi',
            launchedAt,
            bead: 'CORE-2792',
            bindingId: 'exb_01a212fd',
            launch: LAUNCH,
        });
        expect(readSessionLaunch(meta)).toEqual(LAUNCH);
    });

    it('creates the record for a worktree that has none, and never writes a placeholder', async () => {
        const { writeSessionLaunch, readSessionMeta } = await import('../utils/worktree-session.js');
        const worktree = path.join(tempRoot, 'repo-xt-claude-demo');
        await fs.ensureDir(worktree);

        expect(writeSessionLaunch(worktree, 'claude', { role: '  ', task: '', worktree: undefined as never })).toBe(false);
        expect(readSessionMeta(worktree)).toBeNull();

        expect(writeSessionLaunch(worktree, 'claude', { role: 'worker', branch: 'xt/demo' })).toBe(true);
        expect(readSessionMeta(worktree)).toMatchObject({
            runtime: 'claude',
            launch: { role: 'worker', branch: 'xt/demo' },
        });
        // No empty keys: absence stays absence.
        expect(Object.keys((readSessionMeta(worktree)?.launch ?? {}) as object).sort()).toEqual(['branch', 'role']);
    });

    it('keeps the runtime display name in the record, and drops a hand-edited one', async () => {
        const { writeSessionLaunch, readSessionMeta, readSessionLaunch } = await import('../utils/worktree-session.js');
        const worktree = path.join(tempRoot, 'repo-xt-claude-demo');
        await fs.ensureDir(worktree);
        expect(writeSessionLaunch(worktree, 'claude', { ...LAUNCH, displayName: 'repo-xt-claude-demo' })).toBe(true);
        expect(readSessionMeta(worktree)?.launch?.displayName).toBe('repo-xt-claude-demo');

        expect(readSessionLaunch({ launch: { role: 'worker', displayName: 'a'.repeat(5000) } })).toEqual({ role: 'worker' });
        expect(readSessionLaunch({ launch: { role: 'worker', displayName: 'bad\u0000name' } })).toEqual({ role: 'worker' });
        expect(readSessionLaunch({ launch: { role: 'worker', displayName: '   ' } })).toEqual({ role: 'worker' });
    });

    it('reads a damaged or hand-edited launch block as absent, field by field', async () => {
        const { readSessionLaunch } = await import('../utils/worktree-session.js');
        expect(readSessionLaunch(null)).toBeNull();
        expect(readSessionLaunch({})).toBeNull();
        expect(readSessionLaunch({ launch: 'worker' })).toBeNull();
        expect(readSessionLaunch({ launch: {} })).toBeNull();
        expect(readSessionLaunch({
            launch: { role: 42, task: 'role:worker', branch: 'x'.repeat(5000), model: 'bad\u0000model', worktree: '  ' },
        })).toEqual({ task: 'role:worker' });
    });
});

describe('CORE-2792 restored pane options', () => {
    it('restores every launcher pane option that has a durable source', () => {
        expect(restoredAttachPaneOptions({
            launch: LAUNCH,
            worktreePath: '/repo/.xtrm/worktrees/repo-xt-pi-demo',
            branch: 'xt/demo',
            bead: 'CORE-2792',
        })).toEqual([
            { key: '@agent_parent_session', value: '$0' },
            { key: '@agent_task', value: 'role:worker' },
            { key: '@agent_worktree', value: '/repo/.xtrm/worktrees/repo-xt-pi-demo' },
            { key: '@agent_branch', value: 'xt/demo' },
            { key: '@agent_bead', value: 'CORE-2792' },
            { key: '@agent_role', value: 'worker' },
        ]);
    });

    it('never writes the runtime-owned keys', () => {
        const keys = restoredAttachPaneOptions({ launch: LAUNCH, worktreePath: '/w', branch: 'xt/demo', bead: 'CORE-1' })
            .map(option => option.key);
        expect(keys).not.toContain('@agent_state');
        expect(keys).not.toContain('@agent_instance_id');
    });

    it('a legacy record restores only what the worktree itself answers — never a role or a parent', () => {
        expect(restoredAttachPaneOptions({
            launch: null,
            worktreePath: '/w',
            branch: 'xt/demo',
            bead: 'CORE-2792',
        })).toEqual([
            { key: '@agent_worktree', value: '/w' },
            { key: '@agent_branch', value: 'xt/demo' },
            { key: '@agent_bead', value: 'CORE-2792' },
        ]);
    });

    it('derives @agent_task from the role when the record only names a role', () => {
        const keys = restoredAttachPaneOptions({
            launch: { role: 'reviewer' }, worktreePath: '/w', branch: 'xt/demo', bead: null,
        });
        expect(keys).toEqual(expect.arrayContaining([{ key: '@agent_task', value: 'role:reviewer' }]));
        expect(keys.map(option => option.key)).not.toContain('@agent_bead');
    });
});

describe('CORE-2792 restored environment', () => {
    const BASE = {
        PATH: '/usr/bin',
        TMUX: '/tmp/tmux,1,1',
        TMUX_PANE: '%14',
        XTMUX_AGENT_ROLE: 'lead',
        XTMUX_AGENT_BEAD: 'XTRM-1025',
        XTRM_ROLE: 'lead',
        XTRM_SESSION_ID: '$0',
        XTRM_SESSION_NAME: 'xx',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'url.git@github.com:',
        GIT_CONFIG_VALUE_0: 'https://github.com/',
        XTRM_DISPATCHER_NAME: 'thread-lead',
        HOME: '/home/op',
    };

    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('strips the attacher identity and never leaks it into the resumed worker', () => {
        const env = buildAttachEnv(BASE, 'claude', {}, 'demo', '/repo/.xtrm/worktrees/repo-xt-claude-demo', [
            { key: '@agent_role', value: 'worker' },
            { key: '@agent_task', value: 'role:worker' },
        ]);
        expect(env.XTMUX_AGENT_ROLE).toBe('worker');
        expect(env.XTMUX_AGENT_TASK).toBe('role:worker');
        expect(env.XTMUX_AGENT_BEAD).toBeUndefined();
        expect(env.XTRM_SESSION_ID).toBeUndefined();
        expect(env.XTRM_SESSION_NAME).toBeUndefined();
        expect(env.GIT_CONFIG_COUNT).toBeUndefined();
        expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
        expect(env.XTRM_DISPATCHER_NAME).toBeUndefined();
    });

    it('re-adds the resumed worker\'s own session identity', () => {
        const previousTmux = process.env.TMUX;
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        try {
            mocked.spawnSync.mockImplementation((command: string, args: string[] = []) => {
                const joined = args.join(' ');
                if (command === 'tmux' && joined.includes('#{session_id}')) return { status: 0, stdout: '$3\n', stderr: '' };
                if (command === 'tmux' && joined.includes('#{session_name}')) return { status: 0, stdout: 'sess\n', stderr: '' };
                return { status: 1, stdout: '', stderr: '' };
            });
            const env = buildAttachEnv(BASE, 'pi', {}, 'demo', '/repo/.xtrm/worktrees/repo-xt-pi-demo', [
                { key: '@agent_role', value: 'worker' },
            ]);
            expect(env.XTRM_SESSION_ID).toBe('$3');
            expect(env.XTRM_SESSION_NAME).toBe('sess');
        } finally {
            if (previousTmux === undefined) delete process.env.TMUX;
            else process.env.TMUX = previousTmux;
        }
    });

    it('resolves the session identity from the environment it was handed, not the ambient one', () => {
        // Review blocker: `base.TMUX` gated the restore while the probe re-gated on
        // process.env.TMUX, so a process with no tmux variable of its own (CI, a
        // timer wake) got no XTRM_SESSION_* even though the pane was real.
        const previousTmux = process.env.TMUX;
        delete process.env.TMUX;
        try {
            mocked.spawnSync.mockImplementation((command: string, args: string[] = []) => {
                const joined = args.join(' ');
                if (command === 'tmux' && joined.includes('#{session_id}')) return { status: 0, stdout: '$9\n', stderr: '' };
                if (command === 'tmux' && joined.includes('#{session_name}')) return { status: 0, stdout: 'hermetic\n', stderr: '' };
                return { status: 1, stdout: '', stderr: '' };
            });
            const env = buildAttachEnv(
                { ...BASE, TMUX: '/tmp/tmux-1000/default,1,0' },
                'pi', {}, 'demo', '/repo/.xtrm/worktrees/repo-xt-pi-demo',
                [{ key: '@agent_role', value: 'worker' }],
            );
            expect(env.XTRM_SESSION_ID).toBe('$9');
            expect(env.XTRM_SESSION_NAME).toBe('hermetic');
            // And with no tmux in the handed environment there is nothing to probe.
            const { TMUX: _tmux, ...outsideBase } = BASE;
            const outside = buildAttachEnv(outsideBase, 'pi', {}, 'demo', '/repo/.xtrm/worktrees/repo-xt-pi-demo', []);
            expect(outside.XTRM_SESSION_ID).toBeUndefined();
        } finally {
            if (previousTmux === undefined) delete process.env.TMUX;
            else process.env.TMUX = previousTmux;
        }
    });

    it('exports the role identity the launcher itself would export for this worktree', async () => {
        const { resolveLaunchIdentity } = await import('../core/launch-identity.js');
        mocked.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
        const worktree = '/repo/.xtrm/worktrees/repo-xt-pi-demo';
        const env = buildAttachEnv(BASE, 'pi', {}, 'demo', worktree, [{ key: '@agent_role', value: 'worker' }]);
        // Same resolver, same inputs: a worktree without a GitHub origin gets the
        // operator identity from BOTH paths, and one with it gets the role App.
        const expected = resolveLaunchIdentity({ holder: 'demo', roleName: 'worker', cwd: worktree, forwardInherited: true }).env;
        expect('XTRM_ROLE' in env).toBe('XTRM_ROLE' in expected);
        expect(env.XTRM_ROLE).toBe(expected.XTRM_ROLE);
    });

    it('adds no session identity and no role outside tmux, and keeps the base otherwise', () => {
        const base = { ...BASE };
        delete (base as Record<string, string>).TMUX;
        delete (base as Record<string, string>).TMUX_PANE;
        const env = buildAttachEnv(base, 'pi', {}, null, null, []);
        expect(env.XTRM_SESSION_ID).toBeUndefined();
        expect(env.XTRM_ROLE).toBeUndefined();
        expect(env.PATH).toBe('/usr/bin');
        expect(env.HOME).toBe('/home/op');
    });

    it('marks a resumed Codex pane with its runtime', () => {
        const env = buildAttachEnv(BASE, 'codex', {}, null, null, []);
        expect(env.XTMUX_AGENT_RUNTIME).toBe('codex');
    });

    it('stripRestoredEnv removes exactly the launch-owned keys (dispatcher keys are stripped separately)', () => {
        expect(stripRestoredEnv(BASE)).toEqual({
            PATH: '/usr/bin',
            TMUX: '/tmp/tmux,1,1',
            TMUX_PANE: '%14',
            XTRM_DISPATCHER_NAME: 'thread-lead',
            HOME: '/home/op',
        });
    });
});

describe('CORE-2792 resuming pane', () => {
    afterEach(() => vi.restoreAllMocks());

    it('uses $TMUX_PANE when it is a pane id', () => {
        expect(currentPaneId({ TMUX: '/tmp/tmux,1,1', TMUX_PANE: '%3' })).toBe('%3');
    });

    it('never addresses a session name, a window or an index', () => {
        for (const value of ['xx', '$3', '@1', '3', '%', '%x3', '']) {
            expect(currentPaneId({ TMUX: '/tmp/tmux,1,1', TMUX_PANE: value })).toBeNull();
        }
    });

    it('asks tmux for the pane when $TMUX_PANE is absent, and reports nothing outside tmux', () => {
        expect(currentPaneId({})).toBeNull();
        mocked.spawnSync.mockReturnValue({ status: 0, stdout: '%11\n', stderr: '' });
        expect(currentPaneId({ TMUX: '/tmp/tmux,1,1' })).toBe('%11');
        mocked.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'no server' });
        expect(currentPaneId({ TMUX: '/tmp/tmux,1,1' })).toBeNull();
    });
});

describe('CORE-2792 xt attach --fresh restores the launch identity', () => {
    let tempRoot = '';
    let worktree = '';

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-attach-fresh-'));
        worktree = path.join(tempRoot, 'repo', '.xtrm', 'worktrees', 'repo-xt-pi-demo');
        await fs.ensureDir(path.join(worktree, '.xtrm'));
        mocked.spawnSync.mockReset();
        mocked.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await fs.remove(tempRoot);
    });

    const target: WorktreeInfo = {
        path: '',
        branch: 'refs/heads/xt/demo',
        head: 'abc123',
        prunable: false,
    };

    /** A record and, by default, the ledger the launcher writes beside it (item 1). */
    async function writeLaunch(launch: unknown, options: { ledger?: boolean } = {}): Promise<WorktreeInfo> {
        await fs.writeFile(path.join(worktree, '.xtrm', 'session-meta.json'), JSON.stringify({
            runtime: 'pi',
            launchedAt: '2026-11-25T13:56:00.302Z',
            bead: 'CORE-2792',
            launch,
        }));
        if (options.ledger !== false) {
            const { writeLaunchLedger } = await import('../core/session-launch.js');
            writeLaunchLedger(process.env.HOME as string, worktree, 'pi', launch as never);
        }
        return { ...target, path: worktree };
    }

    it('takes role, model and thinking from the record when the operator gives no flag', async () => {
        const wt = await writeLaunch(LAUNCH);
        const options = buildFreshLaunchOptions(wt, {}, { issue: null, dispatcher: {} });
        expect(options.role).toBe('worker');
        expect(options.model).toBe('pi-model-x');
        expect(options.existingWorktree?.path).toBe(worktree);
    });

    it('lets an explicit flag win over the record, and does not carry another role\'s defaults', async () => {
        const wt = await writeLaunch({ ...LAUNCH, thinking: 'low' });
        const sameRole = buildFreshLaunchOptions(wt, { model: 'other-model' }, { issue: null, dispatcher: {} });
        expect(sameRole.model).toBe('other-model');
        expect(sameRole.thinking).toBe('low');
        // CORE-2792 review (finding 3): `thinking` and `model` are defaults OF the
        // role, so naming a different role drops them.
        const otherRole = buildFreshLaunchOptions(wt, { role: 'reviewer', model: 'other-model' }, { issue: null, dispatcher: {} });
        expect(otherRole.role).toBe('reviewer');
        expect(otherRole.model).toBe('other-model');
        expect(otherRole.thinking).toBeUndefined();
    });

    it('takes no role from a record that has no launch ledger behind it', async () => {
        // Review item 1: a plain direct `xt claude` writes no record and no ledger,
        // so a worker can create the record alone. Without a ledger the record's
        // role is an ignored claim, even for --fresh.
        const wt = await writeLaunch({ ...LAUNCH, role: 'lead', requestedRole: 'lead', task: 'role:lead' }, { ledger: false });
        const options = buildFreshLaunchOptions(wt, {}, { issue: null, dispatcher: {} });
        expect(options.role).toBeUndefined();
        // The explicit flag is the operator's own claim and is honoured.
        const explicit = buildFreshLaunchOptions(wt, { role: 'lead' }, { issue: null, dispatcher: {} });
        expect(explicit.role).toBe('lead');
    });

    it('validates --role on the fresh path through the same rule as a resume', async () => {
        // Review round 4, item 2: one helper, so `--fresh --role` cannot accept a
        // name a resume would refuse.
        const wt = await writeLaunch(LAUNCH);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? 0}`);
        }) as never);
        const errors: string[] = [];
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(((...args: unknown[]) => {
            errors.push(args.map(String).join(' '));
        }) as never);
        try {
            expect(() => buildFreshLaunchOptions(wt, { role: 'bad role!' }, { issue: null, dispatcher: {} })).toThrow('exit:1');
            expect(errors.join('\n')).toContain("--role 'bad role!' is not a role name");
            const valid = buildFreshLaunchOptions(wt, { role: 'lead' }, { issue: null, dispatcher: {} });
            expect(valid.role).toBe('lead');
        } finally {
            exitSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });

    it('gives a forced --role the role task and leaves a session task alone', async () => {
        // Review round 4, nit: the role->task rule lives in one place.
        const { taskWithRole } = await import('../core/session-launch.js');
        expect(taskWithRole('role:worker', 'lead')).toBe('role:lead');
        expect(taskWithRole(undefined, 'lead')).toBe('role:lead');
        expect(taskWithRole('session:demo', 'lead')).toBe('session:demo');
    });

    it('restores nothing from a legacy record instead of inventing a role', async () => {
        await fs.writeFile(path.join(worktree, '.xtrm', 'session-meta.json'), JSON.stringify({
            runtime: 'pi', launchedAt: '2026-11-20T00:00:00.000Z',
        }));
        const options = buildFreshLaunchOptions({ ...target, path: worktree }, {}, { issue: null, dispatcher: {} });
        expect(options.role).toBeUndefined();
        expect(options.model).toBeUndefined();
    });

    it('hands the launcher an environment without the attacher\'s identity (gap 2)', async () => {
        // `xt attach --fresh` runs inside the operator's current pane, often another
        // agent session. Without `identityEnv` the launcher resolves the new
        // session's App identity from process.env and forwards the ATTACHER's
        // credential helper ahead of the worker's.
        const wt = await writeLaunch(LAUNCH);
        const saved: Record<string, string | undefined> = {};
        for (const key of ['XTRM_ROLE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'SPECIALISTS_JOB_ID', 'XTMUX_AGENT_ROLE', 'XTRM_SESSION_ID']) {
            saved[key] = process.env[key];
        }
        process.env.XTRM_ROLE = 'lead';
        process.env.GIT_CONFIG_COUNT = '1';
        process.env.GIT_CONFIG_KEY_0 = 'credential.helper';
        process.env.GIT_CONFIG_VALUE_0 = '!attacher-leak';
        process.env.SPECIALISTS_JOB_ID = 'job-1';
        process.env.XTMUX_AGENT_ROLE = 'lead';
        process.env.XTRM_SESSION_ID = '$0';
        try {
            const options = buildFreshLaunchOptions(wt, {}, { issue: null, dispatcher: {} });
            const env = options.identityEnv ?? {};
            for (const key of ['XTRM_ROLE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'SPECIALISTS_JOB_ID', 'XTMUX_AGENT_ROLE', 'XTRM_SESSION_ID']) {
                expect(env[key]).toBeUndefined();
            }
            // Everything the launcher legitimately needs from the caller survives.
            expect(env.PATH).toBe(process.env.PATH);
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    it('resolves the new session\'s own App identity from that stripped environment', async () => {
        // The mechanism the fix depends on: the same call the launcher makes, with
        // the attacher's environment replaced. A real role map plus a real App make
        // the resolver reach its forwarding loop, so a leak would show up here.
        const { resolveLaunchIdentity } = await import('../core/launch-identity.js');
        const { attachLaunchEnv } = await import('../commands/attach.js');
        const home = path.join(tempRoot, 'identity-home');
        await fs.ensureDir(path.join(home, '.xtrm', 'config'));
        await fs.writeFile(path.join(home, '.xtrm', 'config', 'identity-role-map.json'), JSON.stringify({
            version: 1, default: 'worker', specialists: {}, apps: { worker: 'xtrm-worker' },
        }));
        await fs.ensureDir(path.join(home, '.xtrm', 'identities', 'github-apps', 'xtrm-worker'));
        await fs.writeFile(path.join(home, '.xtrm', 'identities', 'github-apps', 'xtrm-worker', 'app.json'), JSON.stringify({
            slug: 'xtrm-worker', appId: '12345', installations: { acme: '67890' },
        }));
        const attacher: NodeJS.ProcessEnv = {
            ...process.env,
            XTRM_ROLE: 'lead',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'credential.helper',
            GIT_CONFIG_VALUE_0: '!attacher-leak',
        };
        // spawnSync is mocked in this block, so the repo slug is injected rather
        // than detected: the resolver's forwarding loop is what this test needs.
        const deps = { repo: 'acme/demo', home, roleMapExists: true };
        const resolved = resolveLaunchIdentity({
            holder: 'demo',
            roleName: 'worker',
            cwd: worktree,
            env: attachLaunchEnv(attacher),
            deps,
            forwardInherited: true,
        });
        expect(resolved.env.XTRM_ROLE).toBe('worker');
        const values = Object.entries(resolved.env).filter(([key]) => key.startsWith('GIT_CONFIG_VALUE_')).map(([, value]) => value);
        expect(values).not.toContain('!attacher-leak');
        // The control: the unstripped environment is what leaked before.
        const leaked = resolveLaunchIdentity({
            holder: 'demo',
            roleName: 'worker',
            cwd: worktree,
            env: attacher,
            deps,
            forwardInherited: true,
        });
        expect(Object.values(leaked.env)).toContain('!attacher-leak');
    });

    it('reads a Codex record\'s launch block too', async () => {
        await fs.writeFile(path.join(worktree, '.xtrm', 'session-meta.json'), JSON.stringify({
            runtime: 'codex',
            launchedAt: '2026-11-25T13:56:00.302Z',
            threadId: '2f8e5c1a-1111-4222-8333-444455556666',
            safetyProfile: 'codex-yolo',
            profileName: 'xtrm-0123456789abcdef',
            profilePath: path.join(tempRoot, 'xtrm-0123456789abcdef.config.toml'),
            launch: { role: 'worker', model: 'gpt-codex-x' },
        }));
        // The Codex launcher writes the same ledger as the claude/pi one.
        const { writeLaunchLedger } = await import('../core/session-launch.js');
        writeLaunchLedger(process.env.HOME as string, worktree, 'codex', { role: 'worker', model: 'gpt-codex-x' });
        const options = buildFreshLaunchOptions({ ...target, path: worktree, runtime: 'codex' }, {}, { issue: null, dispatcher: {} });
        expect(options.role).toBe('worker');
        expect(options.model).toBe('gpt-codex-x');
    });
});

describe('CORE-2792 xt attach resumes with the launch identity restored', () => {
    let tempRoot = '';
    let repoRoot = '';
    let worktree = '';
    let previousCwd = '';
    const savedEnv: Record<string, string | undefined> = {};
    const ENV_KEYS = ['HOME', 'TMUX', 'TMUX_PANE', 'XTMUX_AGENT_ROLE', 'XTMUX_AGENT_TASK', 'XTERM',
        'XTRM_ROLE', 'XTRM_SESSION_ID', 'XTRM_SESSION_NAME', 'XTRM_DISPATCHER_NAME', 'SUBSTRATE_HOLDER',
        'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'XTRM_SKIP_RUNTIME_COMPAT'];

    interface Caps {
        spawn: { command: string; args: string[]; env?: NodeJS.ProcessEnv } | null;
        paneOptions: Record<string, string>;
        /** Pane options the command explicitly unset, in order. */
        unset: string[];
        paneTitle: string | null;
        /** When set, `sp view` answers with this role specification. */
        roleSpec?: unknown;
    }

    function install(cap: Caps): void {
        mocked.spawnSync.mockImplementation((command: string, args: string[] = [], options: Record<string, unknown> = {}) => {
            const joined = args.join(' ');
            const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
            if (command === 'git') {
                if (joined === 'rev-parse --show-toplevel') return ok(`${repoRoot}\n`);
                if (joined === 'worktree list --porcelain') {
                    return ok(`worktree ${repoRoot}\nHEAD abc123\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD def456\nbranch refs/heads/xt/demo\n\n`);
                }
                if (args[0] === 'log') return ok('2026-11-25 13:40:00 +0000\x1fCORE-2792 work\n');
                if (joined.includes('remote get-url origin')) return ok('git@github.com:acme/demo.git\n');
                return { status: 1, stdout: '', stderr: '' };
            }
            if (command === 'tmux') {
                if (args[0] === 'set-option') {
                    if (args.includes('-u')) {
                        const key = args[args.length - 1];
                        cap.unset.push(key);
                        delete cap.paneOptions[key];
                    } else {
                        cap.paneOptions[args[args.length - 2]] = args[args.length - 1];
                    }
                    return ok();
                }
                if (args[0] === 'select-pane') { cap.paneTitle = args[4]; return ok(); }
                if (args[0] === 'display-message' && joined.includes('#{pane_id}')) return ok('%10\n');
                if (args[0] === 'display-message' && joined.includes('#{session_id}')) return ok('$0\n');
                if (args[0] === 'display-message' && joined.includes('#{session_name}')) return ok('xx\n');
                return { status: 1, stdout: '', stderr: '' };
            }
            if (command === 'sb') return { status: 1, stdout: '', stderr: 'no sb' };
            if (command === 'sp') {
                if (args[0] === 'view' && cap.roleSpec !== undefined) return ok(JSON.stringify(cap.roleSpec));
                return { status: 1, stdout: '', stderr: 'no sp' };
            }
            if (command === 'pi' || command === 'claude' || command === 'codex') {
                cap.spawn = { command, args: [...args], env: (options as { env?: NodeJS.ProcessEnv }).env };
                return ok();
            }
            return { status: 1, stdout: '', stderr: '' };
        });
    }

    beforeEach(async () => {
        for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
        for (const key of ENV_KEYS) delete process.env[key];
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-attach-resume-'));
        repoRoot = path.join(tempRoot, 'repo');
        worktree = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-pi-demo');
        await fs.ensureDir(path.join(worktree, '.xtrm'));
        await fs.ensureDir(path.join(tempRoot, 'home'));
        process.env.HOME = path.join(tempRoot, 'home');
        process.env.XTRM_SKIP_RUNTIME_COMPAT = '1';
        previousCwd = process.cwd();
        process.chdir(repoRoot);
        mocked.spawnSync.mockReset();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as never);
    });

    afterEach(async () => {
        process.chdir(previousCwd);
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
        }
        vi.restoreAllMocks();
        await fs.remove(tempRoot);
    });

    /**
     * Writes the worktree record AND, by default, the launch ledger the launcher
     * writes beside it (CORE-2792 review item 1). A record with no ledger behind it
     * carries no identity any more, so a test that restores a role must say which of
     * the two sources it means. `{ ledger: false }` writes the record alone.
     */
    async function writeRecord(launch: unknown, extra: Record<string, unknown> = {}, options: { ledger?: boolean } = {}): Promise<void> {
        await fs.writeFile(path.join(worktree, '.xtrm', 'session-meta.json'), JSON.stringify({
            runtime: 'pi',
            launchedAt: '2026-11-25T13:56:00.302Z',
            bead: 'CORE-2792',
            ...(launch ? { launch } : {}),
            ...extra,
        }));
        if (launch && options.ledger !== false) {
            const { writeLaunchLedger } = await import('../core/session-launch.js');
            writeLaunchLedger(process.env.HOME as string, worktree, 'pi', launch as never);
        }
    }

    async function attach(args: string[] = ['demo'], caps: Partial<Caps> = {}): Promise<Caps> {
        const cap: Caps = { spawn: null, paneOptions: {}, unset: [], paneTitle: null, ...caps };
        install(cap);
        const { createAttachCommand } = await import('../commands/attach.js');
        await expect(createAttachCommand().parseAsync(args, { from: 'user' })).rejects.toThrow('exit:0');
        return cap;
    }

    it('rewrites the lost pane options from the record, on the pane it runs in', async () => {
        await writeRecord(LAUNCH);
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach();
        expect(cap.paneOptions).toEqual({
            '@agent_parent_session': '$0',
            '@agent_task': 'role:worker',
            '@agent_worktree': worktree,
            '@agent_branch': 'xt/demo',
            '@agent_bead': 'CORE-2792',
            '@agent_role': 'worker',
        });
    });

    it('exports the restored identity to the runtime and strips the attacher\'s own', async () => {
        await writeRecord(LAUNCH);
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        process.env.XTMUX_AGENT_ROLE = 'lead';
        process.env.XTRM_ROLE = 'lead';
        process.env.XTRM_SESSION_ID = '$0';
        process.env.XTRM_SESSION_NAME = 'xx';
        process.env.GIT_CONFIG_COUNT = '1';
        process.env.GIT_CONFIG_KEY_0 = 'url.git@github.com:';
        process.env.XTRM_DISPATCHER_NAME = 'thread-lead';
        const cap = await attach();
        expect(cap.spawn?.command).toBe('pi');
        expect(cap.spawn?.args).toEqual(['-c']);
        const env = cap.spawn?.env ?? {};
        expect(env.XTMUX_AGENT_ROLE).toBe('worker');
        expect(env.XTMUX_AGENT_TASK).toBe('role:worker');
        expect(env.XTMUX_AGENT_BEAD).toBe('CORE-2792');
        expect(env.XTMUX_AGENT_WORKTREE).toBe(worktree);
        expect(env.XTMUX_AGENT_BRANCH).toBe('xt/demo');
        expect(env.XTMUX_AGENT_PARENT_SESSION).toBe('$0');
        expect(env.XTRM_SESSION_ID).toBe('$0');
        expect(env.XTRM_SESSION_NAME).toBe('xx');
        expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
        expect(env.XTRM_DISPATCHER_NAME).toBeUndefined();
        expect(env.SUBSTRATE_HOLDER).toBe('demo');
    });

    it('keeps the parent session the record names, and adds one when it names none', async () => {
        // XTRM-1069: a resumed pane's parent session is the session it now runs
        // in; a recorded launch keeps the one it recorded.
        await writeRecord({ ...LAUNCH, parentSession: '$2' });
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const recorded = await attach();
        expect(recorded.paneOptions['@agent_parent_session']).toBe('$2');
    });

    it('restores worktree, branch and bead from a legacy record, and invents no role', async () => {
        await writeRecord(null);
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        process.env.XTMUX_AGENT_ROLE = 'lead';
        const cap = await attach();
        expect(cap.paneOptions).toEqual({
            // XTRM-1069: the record names no parent, so the session the resumed
            // pane now runs in does — never an empty option.
            '@agent_parent_session': '$0',
            '@agent_worktree': worktree,
            '@agent_branch': 'xt/demo',
            '@agent_bead': 'CORE-2792',
        });
        const env = cap.spawn?.env ?? {};
        expect(env.XTMUX_AGENT_ROLE).toBeUndefined();
        expect(env.XTMUX_AGENT_WORKTREE).toBe(worktree);
    });

    it('writes no pane option outside tmux, and still exports the restored identity', async () => {
        await writeRecord(LAUNCH);
        const cap = await attach();
        // No pane to write onto; the environment has no such dependency.
        expect(cap.paneOptions).toEqual({});
        expect(cap.spawn?.env?.XTMUX_AGENT_ROLE).toBe('worker');
        expect(cap.spawn?.env?.XTRM_SESSION_ID).toBeUndefined();
    });

    it('refuses a hand-edited record field instead of writing it onto a pane', async () => {
        await writeRecord({ role: 'x'.repeat(5000), task: 'role:worker', branch: 'bad\u0000branch' });
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach();
        expect(cap.paneOptions).toEqual({
            '@agent_parent_session': '$0',
            '@agent_task': 'role:worker',
            '@agent_worktree': worktree,
            '@agent_branch': 'xt/demo',
            '@agent_bead': 'CORE-2792',
        });
    });

    it('resumes Claude with --continue and the restored worker identity', async () => {
        await writeRecord(LAUNCH, { runtime: 'claude' });
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach();
        expect(cap.spawn?.command).toBe('claude');
        expect(cap.spawn?.args).toEqual(expect.arrayContaining(['--continue', '--dangerously-skip-permissions']));
        expect(cap.spawn?.env?.XTMUX_AGENT_ROLE).toBe('worker');
    });

    it('repeats the launch\'s system prompt, display name and skill pool on a pi resume', async () => {
        const skill = path.join(tempRoot, 'skills', 'demo');
        await fs.ensureDir(skill);
        await fs.writeFile(path.join(skill, 'SKILL.md'), '# demo\n');
        await writeRecord({ ...LAUNCH, displayName: 'repo-xt-pi-demo' });
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach(['demo'], {
            roleSpec: {
                specialist: {
                    metadata: { name: 'worker', version: '1.0.0' },
                    prompt: { system: 'You are the demo worker.' },
                    skills: { paths: [skill] },
                    execution: { mode: 'tool' },
                },
            },
        });
        expect(cap.spawn?.command).toBe('pi');
        expect(cap.spawn?.args).toEqual([
            '-c',
            '--name', 'repo-xt-pi-demo',
            '--append-system-prompt', 'You are the demo worker.',
            '--no-skills',
            '--skill', expect.stringContaining(path.join('skills', 'demo')),
        ]);
        // The resumed pane keeps the launch's title, not the worktree name.
        expect(cap.paneTitle).toBe('repo-xt-pi-demo');
    });

    it('repeats the claude system prompt on a claude resume, without pi\'s skill flags', async () => {
        await writeRecord({ ...LAUNCH, displayName: 'repo-xt-claude-demo' }, { runtime: 'claude' });
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach(['demo'], {
            roleSpec: { specialist: { prompt: { system: 'You are the demo worker.' }, skills: { paths: [] } } },
        });
        expect(cap.spawn?.command).toBe('claude');
        expect(cap.spawn?.args).toEqual([
            '--continue',
            '--dangerously-skip-permissions',
            '--name', 'repo-xt-claude-demo',
            '--append-system-prompt', 'You are the demo worker.',
        ]);
    });

    it('warns and resumes without the role prompt when the role no longer resolves', async () => {
        await writeRecord({ ...LAUNCH, displayName: 'repo-xt-pi-demo' });
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach();
        expect(cap.spawn?.args).toEqual(['-c', '--name', 'repo-xt-pi-demo']);
        const warnings = vi.mocked(console.error).mock.calls.map(call => String(call[0])).join('\n');
        expect(warnings).toContain(`could not resolve role 'worker'`);
        expect(warnings).toContain('resuming without its system prompt');
        // The rest of the identity still comes back.
        expect(cap.paneOptions['@agent_role']).toBe('worker');
    });

    it('keeps the plain resume for a legacy record and titles nothing', async () => {
        await writeRecord(null);
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach();
        expect(cap.spawn?.args).toEqual(['-c']);
        expect(cap.paneTitle).toBeNull();
        expect(cap.paneOptions['@agent_role']).toBeUndefined();
    });
    // ---- CORE-2792 review findings -------------------------------------------

    it('unsets every restored pane option first, so a stale lead role cannot survive', async () => {
        // A legacy record answers nothing about a role, and the pane remembers one:
        // the previous occupant was a coordinator.
        await writeRecord(null);
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach();
        for (const key of ['@agent_parent_session', '@agent_task', '@agent_worktree', '@agent_branch', '@agent_bead', '@agent_role']) {
            expect(cap.unset).toContain(key);
        }
        // Unset before set: the keys the record cannot answer stay absent.
        expect(cap.paneOptions['@agent_role']).toBeUndefined();
        expect(cap.paneOptions['@agent_task']).toBeUndefined();
        // The parent session is NOT one of the keys that may stay absent: the
        // resumed pane always runs inside a session (XTRM-1069).
        expect(cap.paneOptions['@agent_parent_session']).toBe('$0');
        expect(cap.paneOptions['@agent_worktree']).toBe(worktree);
    });

    it('takes the role from the launch ledger when the worktree record disagrees', async () => {
        // The worker can rewrite its own record; the launcher's copy is outside the
        // checkout. The ledger wins and the disagreement is reported.
        const { writeLaunchLedger } = await import('../core/session-launch.js');
        await writeRecord({ ...LAUNCH, role: 'lead', requestedRole: 'lead', task: 'role:lead' });
        expect(writeLaunchLedger(process.env.HOME as string, worktree, 'pi', LAUNCH)).toBe(true);
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach();
        expect(cap.paneOptions['@agent_role']).toBe('worker');
        const errors = vi.mocked(console.error).mock.calls.map(call => String(call[0])).join('\n');
        expect(errors).toContain("the worktree record names role 'lead'");
        expect(errors).toContain('launch ledger disagrees');
    });

    it('does not restore a role a worker forged into its own record when the ledger names none', async () => {
        // The same scenario end to end: a role-less launch, a forged record, a resume.
        const { writeLaunchLedger } = await import('../core/session-launch.js');
        const { role: _role, requestedRole: _requested, ...ledgerWithoutRole } = LAUNCH;
        await writeRecord({ ...LAUNCH, role: 'lead', requestedRole: 'lead', task: 'role:lead' });
        expect(writeLaunchLedger(process.env.HOME as string, worktree, 'pi', ledgerWithoutRole)).toBe(true);
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach();
        expect(cap.paneOptions['@agent_role']).toBeUndefined();
        expect(cap.paneOptions['@agent_worktree']).toBe(worktree);
        // The forged role never reaches the runtime either.
        expect(cap.spawn?.env?.XTMUX_AGENT_ROLE).toBeUndefined();
        expect(cap.spawn?.env?.XTRM_ROLE).toBeUndefined();
        const errors = vi.mocked(console.error).mock.calls.map(call => String(call[0])).join('\n');
        expect(errors).toContain("names role 'lead' but the launch ledger names none");
    });


    it('drops a role the record names when no launch ledger exists, until --role names it', async () => {
        // Review item 1: a plain direct `xt claude` writes no record and no ledger,
        // and both files are the worker's uid — so a record alone is a claim, not a
        // source. The resume drops the role, says so, and the operator can restore it.
        await writeRecord({ ...LAUNCH, role: 'lead', requestedRole: 'lead', task: 'role:lead' }, {}, { ledger: false });
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach();
        expect(cap.paneOptions['@agent_role']).toBeUndefined();
        // The task derived from the dropped role goes with it.
        expect(cap.paneOptions['@agent_task']).toBeUndefined();
        // Everything that is not identity still restores.
        expect(cap.paneOptions['@agent_worktree']).toBe(worktree);
        expect(cap.paneOptions['@agent_bead']).toBe('CORE-2792');
        expect(cap.spawn?.env?.XTMUX_AGENT_ROLE).toBeUndefined();
        expect(cap.spawn?.env?.XTRM_ROLE).toBeUndefined();
        const errors = vi.mocked(console.error).mock.calls.map(call => String(call[0])).join('\n');
        expect(errors).toContain("names role 'lead' but the launch ledger names none");
        expect(errors).toContain('pass --role lead to restore it');

        // The explicit flag is the operator's own claim and is honoured, with the
        // pane metadata that belongs to it.
        const explicit = await attach(['demo', '--role', 'lead']);
        expect(explicit.paneOptions['@agent_role']).toBe('lead');
        expect(explicit.paneOptions['@agent_task']).toBe('role:lead');
        expect(explicit.spawn?.env?.XTMUX_AGENT_ROLE).toBe('lead');
    });

    it('restores the ledger role even when the attacher is a supervised specialist, and passes no marker on', async () => {
        // Review item 3: the supervisor markers describe the ATTACHER's session. They
        // are stripped, so the launcher's supervisor refusal cannot veto a role the
        // ledger names, and the worker does not inherit the attacher's job id.
        await writeRecord(LAUNCH);
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        process.env.SPECIALISTS_JOB_ID = 'job-attacher';
        process.env.XTRM_SUPERVISOR_LAUNCH = '1';
        const cap = await attach();
        expect(cap.paneOptions['@agent_role']).toBe('worker');
        const env = cap.spawn?.env ?? {};
        expect(env.XTMUX_AGENT_ROLE).toBe('worker');
        expect(env.SPECIALISTS_JOB_ID).toBeUndefined();
        expect(env.XTRM_SUPERVISOR_LAUNCH).toBeUndefined();
    });

    it('removes a ledger after its worktree is gone, so no identity outlives the directory', async () => {
        // Review item 4: `xt worktree remove`, `xt end` and a failed launch all
        // resolve the path BEFORE the directory goes. A canonical path that no
        // longer exists still resolves to the key it had, which is the property the
        // removal paths depend on.
        const { launchLedgerPath, readLaunchLedger, removeLaunchLedger, writeLaunchLedger } = await import('../core/session-launch.js');
        const home = process.env.HOME as string;
        expect(writeLaunchLedger(home, worktree, 'pi', LAUNCH)).toBe(true);
        expect(readLaunchLedger(home, worktree)?.role).toBe('worker');
        const resolvedBeforeRemoval = launchLedgerPath(home, worktree);
        await fs.remove(worktree);
        expect(launchLedgerPath(home, worktree)).toBe(resolvedBeforeRemoval);
        expect(removeLaunchLedger(home, worktree)).toBe(true);
        expect(readLaunchLedger(home, worktree)).toBeNull();
    });

    it('removes the ledger when a failed launch rolls its worktree back', async () => {
        // Review item 4: a launch that fails after the record was written rolls the
        // worktree back; the identity must go with it, and the key has to be
        // resolved BEFORE `git worktree remove` (realpath cannot answer afterwards).
        const { launchLedgerPath, readLaunchLedger, writeLaunchLedger } = await import('../core/session-launch.js');
        const { rollbackLauncherWorktree } = await import('../utils/worktree-session.js');
        const home = process.env.HOME as string;
        expect(writeLaunchLedger(home, worktree, 'pi', LAUNCH)).toBe(true);
        const key = launchLedgerPath(home, worktree);
        mocked.spawnSync.mockImplementation((command: string, args: string[] = []) => (
            command === 'git' && args[0] === 'worktree' && args[1] === 'remove'
                ? { status: 0, stdout: '', stderr: '' }
                : { status: 1, stdout: '', stderr: '' }
        ));
        rollbackLauncherWorktree(repoRoot, worktree, 'xt/demo', false);
        expect(await fs.pathExists(key)).toBe(false);
        expect(readLaunchLedger(home, worktree)).toBeNull();
    });

    it('replaces the attacher\'s inherited git transport with the resumed worker\'s own', async () => {
        // Review finding 1. A real attacher environment: a credential helper on
        // process.env, an operator role that OWNS a GitHub App on this host (so the
        // resolver reaches its forwarding loop), and a github.com origin. The
        // resumed worker must get its own App transport — never the attacher's
        // helper, which would let it push as the operator.
        await writeRecord(LAUNCH);
        const home = process.env.HOME as string;
        await fs.ensureDir(path.join(home, '.xtrm', 'config'));
        await fs.writeFile(path.join(home, '.xtrm', 'config', 'identity-role-map.json'), JSON.stringify({
            version: 1,
            default: 'worker',
            specialists: {},
            apps: { worker: 'xtrm-worker' },
        }));
        await fs.ensureDir(path.join(home, '.xtrm', 'identities', 'github-apps', 'xtrm-worker'));
        await fs.writeFile(path.join(home, '.xtrm', 'identities', 'github-apps', 'xtrm-worker', 'app.json'), JSON.stringify({
            slug: 'xtrm-worker',
            appId: '12345',
            installations: { acme: '67890' },
        }));
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        process.env.GIT_CONFIG_COUNT = '1';
        process.env.GIT_CONFIG_KEY_0 = 'credential.helper';
        process.env.GIT_CONFIG_VALUE_0 = '!attacher-leak';
        const cap = await attach();
        const env = cap.spawn?.env ?? {};
        expect(env.GIT_CONFIG_KEY_0).toBe('url.https://github.com/.insteadOf');
        const values = Object.entries(env).filter(([key]) => key.startsWith('GIT_CONFIG_VALUE_')).map(([, value]) => value);
        expect(values).toContain('!xt identity credential');
        expect(values).not.toContain('!attacher-leak');
        expect(env.GIT_CONFIG_COUNT).toBe('5');
    });

    it('refuses a reviewer resume whose App is configured but not installed', async () => {
        // Review finding 2: the launcher refuses a reviewer on the operator
        // identity; a resume restarted the runtime without asking, so the pane said
        // "reviewer", the reviewer prompt was applied, and the session held the
        // operator's credentials with no signal at all.
        await writeRecord({ ...LAUNCH, role: 'reviewer', requestedRole: 'reviewer', task: 'role:reviewer' });
        const home = process.env.HOME as string;
        await fs.ensureDir(path.join(home, '.xtrm', 'config'));
        await fs.writeFile(path.join(home, '.xtrm', 'config', 'identity-role-map.json'), JSON.stringify({
            version: 1,
            default: 'worker',
            specialists: {},
            apps: { worker: 'xtrm-worker', reviewer: 'xtrm-reviewer' },
        }));
        await fs.ensureDir(path.join(home, '.xtrm', 'identities', 'github-apps', 'xtrm-reviewer'));
        await fs.writeFile(path.join(home, '.xtrm', 'identities', 'github-apps', 'xtrm-reviewer', 'app.json'), JSON.stringify({
            slug: 'xtrm-reviewer',
            appId: '55555',
            // Configured on this host, installed for another owner only.
            installations: { other: '999' },
        }));
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        await expect(attach()).rejects.toThrow('exit:1');
        const errors = vi.mocked(console.error).mock.calls.map(call => String(call[0])).join('\n');
        expect(errors).toContain('refusing to launch a reviewer with the operator identity');
    });

    it('replays the operator\'s recorded --skill paths on a pi resume', async () => {
        const existing = path.join(tempRoot, 'extra-skill', 'SKILL.md');
        await fs.ensureDir(path.dirname(existing));
        await fs.writeFile(existing, '# extra\n');
        const missing = path.join(tempRoot, 'gone-skill', 'SKILL.md');
        await writeRecord({ ...LAUNCH, skills: [existing, missing] });
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        const cap = await attach(['demo'], {
            roleSpec: { specialist: { prompt: { system: 'You are the demo worker.' }, skills: { paths: [] } } },
        });
        expect(cap.spawn?.args).toContain('--no-skills');
        const skillFlags = (cap.spawn?.args ?? []).flatMap((arg, index, all) => (arg === '--skill' ? [all[index + 1]] : []));
        expect(skillFlags).toContain(existing);
        expect(skillFlags).not.toContain(missing);
        const errors = vi.mocked(console.error).mock.calls.map(call => String(call[0])).join('\n');
        expect(errors).toContain('no longer exists');
    });
});

describe('CORE-2792 review: trust and the restart rule', () => {
    let tempRoot = '';
    let worktree = '';

    const TARGET = (): WorktreeInfo => ({ path: worktree, branch: 'refs/heads/xt/demo', head: 'abc123', prunable: false });

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-attach-trust-'));
        worktree = path.join(tempRoot, 'repo', '.xtrm', 'worktrees', 'repo-xt-pi-demo');
        await fs.ensureDir(path.join(worktree, '.xtrm'));
    });

    afterEach(async () => {
        await fs.remove(tempRoot);
    });

    async function writeRecord(launch: unknown): Promise<void> {
        await fs.writeFile(path.join(worktree, '.xtrm', 'session-meta.json'), JSON.stringify({
            runtime: 'pi', launchedAt: '2026-11-25T13:56:00.302Z', bead: 'CORE-2792', launch,
        }));
    }

    it('refuses a role name outside the launcher grammar, keeping the rest of the record', async () => {
        const { readSessionLaunch } = await import('../core/session-launch.js');
        const launch = readSessionLaunch({ launch: { ...LAUNCH, role: '../../etc/passwd', requestedRole: '--evil' } });
        expect(launch?.role).toBeUndefined();
        expect(launch?.requestedRole).toBeUndefined();
        expect(launch?.task).toBe('role:worker');
    });

    it('prefers the launch ledger and reports a disagreement', async () => {
        const { trustedLaunchMeta } = await import('../commands/attach.js');
        const recordLaunch = { ...LAUNCH, role: 'lead', requestedRole: 'lead' };
        const ledgerLaunch = { ...LAUNCH, role: 'worker', requestedRole: 'worker' };
        expect(trustedLaunchMeta(recordLaunch, ledgerLaunch)).toEqual({
            launch: { ...ledgerLaunch },
            conflictRole: 'lead',
            ignoredRecordRole: null,
        });
        // No ledger behind the record means no identity: the role is dropped and
        // reported, never restored from the worker's own file (review item 1).
        expect(trustedLaunchMeta(recordLaunch, null)).toEqual({
            launch: { ...recordLaunch, role: undefined, requestedRole: undefined },
            conflictRole: null,
            ignoredRecordRole: 'lead',
        });
        expect(trustedLaunchMeta(null, ledgerLaunch)).toEqual({
            launch: ledgerLaunch,
            conflictRole: null,
            ignoredRecordRole: null,
        });
        expect(trustedLaunchMeta(null, null)).toEqual({
            launch: null,
            conflictRole: null,
            ignoredRecordRole: null,
        });
    });

    it('takes identity from the ledger alone, so a record cannot add a role the ledger lacks', async () => {
        // Round-2 HIGH: a worker launched WITHOUT a role writes launch.role="lead"
        // into its own session-meta.json. The ledger exists and names no role, so the
        // record's role is an ignored claim — never a restored identity.
        const { trustedLaunchMeta } = await import('../commands/attach.js');
        const { role: _role, requestedRole: _requested, ...ledgerWithoutRole } = LAUNCH;
        const forged = { ...LAUNCH, role: 'lead', requestedRole: 'lead', task: 'role:lead' };
        const result = trustedLaunchMeta(forged, ledgerWithoutRole);
        expect(result.launch?.role).toBeUndefined();
        expect(result.launch?.requestedRole).toBeUndefined();
        expect(result.ignoredRecordRole).toBe('lead');
        expect(result.conflictRole).toBeNull();
        // Identity is the only thing the ledger monopolizes: the rest still merges,
        // and the ledger wins each field it carries.
        expect(result.launch?.task).toBe('role:worker');
        expect(result.launch?.branch).toBe('xt/demo');
        // A ledger that names a role still wins over a forged one, and reports both.
        const withLedgerRole = trustedLaunchMeta(forged, LAUNCH);
        expect(withLedgerRole.launch?.role).toBe('worker');
        expect(withLedgerRole.conflictRole).toBe('lead');
        // A record that names no role adds none.
        const quiet = trustedLaunchMeta({ ...LAUNCH, role: undefined }, ledgerWithoutRole);
        expect(quiet.ignoredRecordRole).toBeNull();
        expect(quiet.launch?.role).toBeUndefined();
    });

    it('keys the ledger by the real path, so a trailing slash or a symlink finds it', async () => {
        const { launchLedgerPath, writeLaunchLedger, readLaunchLedger } = await import('../core/session-launch.js');
        const home = path.join(tempRoot, 'home');
        const plain = launchLedgerPath(home, worktree);
        expect(launchLedgerPath(home, `${worktree}/`)).toBe(plain);
        const link = path.join(tempRoot, 'repo-link');
        await fs.symlink(path.join(tempRoot, 'repo'), link, 'dir').catch(async () => {
            await fs.ensureDir(path.join(tempRoot, 'repo'));
            await fs.symlink(path.join(tempRoot, 'repo'), link, 'dir');
        });
        const linked = path.join(link, '.xtrm', 'worktrees', 'repo-xt-pi-demo');
        expect(launchLedgerPath(home, linked)).toBe(plain);
        // A write through the symlinked route is readable through the real one.
        expect(writeLaunchLedger(home, linked, 'pi', LAUNCH)).toBe(true);
        expect(readLaunchLedger(home, worktree)?.role).toBe('worker');
    });

    it('reads no ledger that names a different worktree', async () => {
        const { launchLedgerPath, readLaunchLedger } = await import('../core/session-launch.js');
        const home = path.join(tempRoot, 'home');
        const dest = launchLedgerPath(home, worktree);
        await fs.ensureDir(path.dirname(dest));
        await fs.writeFile(dest, JSON.stringify({ worktree: path.join(tempRoot, 'other'), runtime: 'pi', launch: LAUNCH }));
        expect(readLaunchLedger(home, worktree)).toBeNull();
        await fs.writeFile(dest, JSON.stringify({ runtime: 'pi', launch: LAUNCH }));
        expect(readLaunchLedger(home, worktree)).toBeNull();
    });

    it('keeps the record when the ledger write fails', async () => {
        const { launchLedgerPath, readLaunchLedger } = await import('../core/session-launch.js');
        const { writeSessionLaunch, readSessionMeta } = await import('../utils/worktree-session.js');
        // A file where the state directory should be makes the ledger write fail.
        const blocked = path.join(tempRoot, 'blocked-home');
        await fs.ensureDir(blocked);
        await fs.writeFile(path.join(blocked, '.xtrm'), 'not a directory');
        const previousHome = process.env.HOME;
        process.env.HOME = blocked;
        try {
            expect(writeSessionLaunch(worktree, 'pi', LAUNCH)).toBe(true);
            expect(readSessionMeta(worktree)?.launch?.role).toBe('worker');
            expect(readLaunchLedger(blocked, worktree)).toBeNull();
            expect(launchLedgerPath(blocked, worktree)).toContain('.xtrm');
        } finally {
            process.env.HOME = previousHome;
        }
    });

    it('does not inherit the old role\'s model or thinking when --fresh names another role', async () => {
        await writeRecord({ ...LAUNCH, model: 'worker-model', thinking: 'low' });
        const home = process.env.HOME as string;
        // This block writes records only; the ledger is what makes the role real.
        const { writeLaunchLedger } = await import('../core/session-launch.js');
        writeLaunchLedger(home, worktree, 'pi', { ...LAUNCH, model: 'worker-model', thinking: 'low' });
        const same = buildFreshLaunchOptions(TARGET(), {}, { issue: null, dispatcher: {}, home });
        expect(same.role).toBe('worker');
        expect(same.model).toBe('worker-model');
        expect(same.thinking).toBe('low');
        const other = buildFreshLaunchOptions(TARGET(), { role: 'reviewer' }, { issue: null, dispatcher: {}, home });
        expect(other.role).toBe('reviewer');
        expect(other.model).toBeUndefined();
        expect(other.thinking).toBeUndefined();
        const explicit = buildFreshLaunchOptions(TARGET(), { model: 'cli-model' }, { issue: null, dispatcher: {}, home });
        expect(explicit.model).toBe('cli-model');
    });

    it('ignores a pane id that arrives without a tmux server', () => {
        expect(currentPaneId({ TMUX_PANE: '%3' } as NodeJS.ProcessEnv)).toBeNull();
    });
});
