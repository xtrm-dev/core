import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CORE-2792 (review round 4, item 1): the Codex launcher builds its pane command from
// `-e` exports only, so a key the launch does not export would otherwise be inherited
// from whatever created the pane. `xt attach --fresh` from a role pane must not hand
// that pane's `XTRM_ROLE` or git transport to the worker it starts. The unset list is
// shared with `xt claude` and `xt pi`, so one test here pins all three.

const mocked = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocked.spawnSync }));

const ROLE_SPEC = JSON.stringify({
    specialist: {
        metadata: { name: 'testrole', version: '1.0.0', category: 'testing', description: 'd' },
        execution: { mode: 'tool' },
        prompt: { system: 'You are the test role.' },
        skills: { paths: [] },
    },
});

interface Capture {
    paneCommand: string;
    newSessionArgs: string[];
}

function install(repoRoot: string, cap: Capture): void {
    let live = false;
    let sessionName = '';
    mocked.spawnSync.mockImplementation((command: string, args: string[] = []) => {
        // CORE-2802: the launcher binds tmux to the caller's socket; the verb is args[0] again.
                // CORE-2802 review (finding 5): the binding is asserted, never merely stripped.
        if (command === 'tmux' && args[0] === '-S') { expect(args[1]).toMatch(/^(?:\/|tmux-)/); args = args.slice(2); }
        const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
        const joined = args.join(' ');
        if (command === 'sh') return ok('/usr/bin/codex\n');
        if (command === 'git') {
            if (joined === 'rev-parse --show-toplevel') return ok(`${repoRoot}\n`);
            if (joined === 'rev-parse --git-common-dir') return ok('.git\n');
            if (args[0] === 'symbolic-ref') return ok('origin/main\n');
            if (args[0] === 'check-ref-format') return ok();
            if (args[0] === 'show-ref') return { status: 1, stdout: '', stderr: '' };
            if (args[0] === 'fetch') return ok();
            if (args[0] === 'worktree' && args[1] === 'add') {
                const worktree = args.find((arg) => arg.startsWith(`${repoRoot}/.`));
                if (worktree) fs.ensureDirSync(worktree);
            }
            if (args[0] === 'worktree' && args[1] === 'list') {
                return ok(`worktree ${repoRoot}\nHEAD abc\nbranch refs/heads/main\n`);
            }
            return ok();
        }
        if (command === 'sp' && args[0] === 'view') return ok(ROLE_SPEC);
        if (command === 'bd' || command === 'sb') return { status: 1, stdout: '', stderr: 'no' };
        if (command === 'tmux') {
            if (args[0] === 'has-session') return live ? ok() : { status: 1, stdout: '', stderr: '' };
            if (args[0] === 'new-session') {
                cap.newSessionArgs = [...args];
                cap.paneCommand = args[args.length - 1] ?? '';
                sessionName = args[args.indexOf('-s') + 1] ?? '';
                live = true;
                return ok();
            }
            if (args[0] === 'list-sessions') return ok(`${sessionName}\t$3\n`);
            if (args[0] === 'display-message') return ok('$3\n');
            if (args[0] === 'list-panes') return ok('%5\n');
            return ok();
        }
        return ok();
    });
}

describe('CORE-2792 the Codex launch clears the identity keys it does not export', () => {
    let root: string;
    let repoRoot: string;
    const saved = { ...process.env };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-env-'));
        repoRoot = path.join(root, 'repo');
        fs.ensureDirSync(repoRoot);
        process.env.CODEX_HOME = path.join(root, 'codex-home');
        process.env.HOME = path.join(root, 'home');
        fs.ensureDirSync(process.env.HOME);
    });

    afterEach(() => {
        fs.removeSync(root);
        for (const key of Object.keys(process.env)) {
            if (!(key in saved)) delete process.env[key];
        }
        Object.assign(process.env, saved);
        process.chdir(saved.PWD ?? process.cwd());
        mocked.spawnSync.mockReset();
    });

    it('unsets the attacher role and git transport the pane environment does not export', async () => {
        // A `--fresh` attach from a coordinator pane: the attacher's environment
        // carries its own role and App transport, the launch exports neither.
        process.env.XTRM_ROLE = 'lead';
        process.env.SPECIALISTS_JOB_ID = 'job-attacher';
        process.env.GIT_CONFIG_COUNT = '1';
        process.env.GIT_CONFIG_KEY_0 = 'credential.helper';
        process.env.GIT_CONFIG_VALUE_0 = '!attacher-leak';
        const cap: Capture = { paneCommand: '', newSessionArgs: [] };
        install(repoRoot, cap);
        process.chdir(repoRoot);

        const { launchCodexWorktreeSession } = await import('../utils/codex-worktree-session.js');
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? 0}`);
        }) as never);
        await expect(launchCodexWorktreeSession({
            name: 'demo',
            role: 'testrole',
            yolo: false,
            attach: false,
            identityEnv: { PATH: process.env.PATH },
        })).rejects.toThrow('exit:0');
        exitSpy.mockRestore();

        // The unsets run in front of the pane command, for exactly the keys the
        // attacher carries and the launch does not export.
        expect(cap.paneCommand.startsWith('env ')).toBe(true);
        expect(cap.paneCommand).toContain("-u 'XTRM_ROLE'");
        expect(cap.paneCommand).toContain("-u 'SPECIALISTS_JOB_ID'");
        expect(cap.paneCommand).toContain("-u 'GIT_CONFIG_COUNT'");
        expect(cap.paneCommand).toContain("-u 'GIT_CONFIG_KEY_0'");
        expect(cap.paneCommand).toContain("-u 'GIT_CONFIG_VALUE_0'");
        // ... and the pane env carries none of them as its own export.
        const exports = cap.newSessionArgs.filter((arg) => arg.startsWith('XTRM_ROLE=')
            || arg.startsWith('GIT_CONFIG_') || arg.startsWith('SPECIALISTS_JOB_ID='));
        expect(exports).toEqual([]);
    }, 40_000);
});
