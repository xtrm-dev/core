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

    async function writeLaunch(launch: unknown): Promise<WorktreeInfo> {
        await fs.writeFile(path.join(worktree, '.xtrm', 'session-meta.json'), JSON.stringify({
            runtime: 'pi',
            launchedAt: '2026-11-25T13:56:00.302Z',
            bead: 'CORE-2792',
            launch,
        }));
        return { ...target, path: worktree };
    }

    it('takes role, model and thinking from the record when the operator gives no flag', async () => {
        const wt = await writeLaunch(LAUNCH);
        const options = buildFreshLaunchOptions(wt, {}, { issue: null, dispatcher: {} });
        expect(options.role).toBe('worker');
        expect(options.model).toBe('pi-model-x');
        expect(options.existingWorktree?.path).toBe(worktree);
    });

    it('lets an explicit flag win over the record', async () => {
        const wt = await writeLaunch({ ...LAUNCH, thinking: 'low' });
        const options = buildFreshLaunchOptions(wt, { role: 'reviewer', model: 'other-model' }, { issue: null, dispatcher: {} });
        expect(options.role).toBe('reviewer');
        expect(options.model).toBe('other-model');
        expect(options.thinking).toBe('low');
    });

    it('restores nothing from a legacy record instead of inventing a role', async () => {
        await fs.writeFile(path.join(worktree, '.xtrm', 'session-meta.json'), JSON.stringify({
            runtime: 'pi', launchedAt: '2026-11-20T00:00:00.000Z',
        }));
        const options = buildFreshLaunchOptions({ ...target, path: worktree }, {}, { issue: null, dispatcher: {} });
        expect(options.role).toBeUndefined();
        expect(options.model).toBeUndefined();
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
                return { status: 1, stdout: '', stderr: '' };
            }
            if (command === 'tmux') {
                if (args[0] === 'set-option') { cap.paneOptions[args[4]] = args[5]; return ok(); }
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

    async function writeRecord(launch: unknown, extra: Record<string, unknown> = {}): Promise<void> {
        await fs.writeFile(path.join(worktree, '.xtrm', 'session-meta.json'), JSON.stringify({
            runtime: 'pi',
            launchedAt: '2026-11-25T13:56:00.302Z',
            bead: 'CORE-2792',
            ...(launch ? { launch } : {}),
            ...extra,
        }));
    }

    async function attach(args: string[] = ['demo'], caps: Partial<Caps> = {}): Promise<Caps> {
        const cap: Caps = { spawn: null, paneOptions: {}, paneTitle: null, ...caps };
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

    it('restores worktree, branch and bead from a legacy record, and invents no role', async () => {
        await writeRecord(null);
        process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
        process.env.TMUX_PANE = '%10';
        process.env.XTMUX_AGENT_ROLE = 'lead';
        const cap = await attach();
        expect(cap.paneOptions).toEqual({
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
});
