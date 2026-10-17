import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
    spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
    listXtWorktrees: vi.fn(),
    getRepoRoot: vi.fn(() => '/repo'),
}));

vi.mock('node:child_process', () => ({ spawnSync: mocked.spawnSync }));
vi.mock('../commands/worktree.js', () => ({
    listXtWorktrees: mocked.listXtWorktrees,
    getRepoRoot: mocked.getRepoRoot,
}));

// CORE-2432 R8: hermetic dispatcher refresh; the live lookup is covered in attach-dispatcher.test.ts.
vi.mock('../core/dispatcher-identity.js', () => ({
    refreshDispatcherEnv: vi.fn(() => ({
        XTRM_DISPATCHER_NAME: 'test-dispatcher',
        XTRM_DISPATCHER_ADDRESS: 'uds:/test.sock',
    })),
}));

const roots: string[] = [];

afterEach(() => {
    vi.restoreAllMocks();
    mocked.spawnSync.mockClear();
    for (const root of roots.splice(0)) fs.removeSync(root);
});

describe('xt attach Codex resume', () => {
    it('resumes the exact persisted UUID and never uses --last', async () => {
        const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-attach-'));
        roots.push(worktree);
        fs.ensureDirSync(path.join(worktree, '.xtrm'));
        fs.writeJsonSync(path.join(worktree, '.xtrm', 'session-meta.json'), {
            runtime: 'codex',
            launchedAt: '2026-08-02T18:29:29.000Z',
            threadId: '019fc3bc-fb7a-7ae0-9536-125624bf726b',
            safetyProfile: 'codex-yolo',
            profileName: 'xtrm-0123456789abcdef',
            profilePath: path.join(os.homedir(), '.codex', 'xtrm-0123456789abcdef.config.toml'),
        });
        mocked.listXtWorktrees.mockReturnValue([{
            path: worktree,
            branch: 'refs/heads/xt/demo',
            head: 'abc',
            prunable: false,
            runtime: 'codex',
        }]);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code}`);
        }) as never);

        const { createAttachCommand } = await import('../commands/attach.js');
        // CORE-2432 R8: attach refreshes dispatcher identity into the resume env.
        await expect(createAttachCommand().parseAsync(['node', 'xt', 'demo'])).rejects.toThrow('exit:0');

        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'codex',
            [
                '--profile',
                'xtrm-0123456789abcdef',
                'resume',
                '--dangerously-bypass-approvals-and-sandbox',
                '019fc3bc-fb7a-7ae0-9536-125624bf726b',
            ],
            {
                cwd: worktree,
                stdio: 'inherit',
                env: expect.objectContaining({
                    XTRM_DISPATCHER_NAME: 'test-dispatcher',
                    XTRM_DISPATCHER_ADDRESS: 'uds:/test.sock',
                }),
            },
        );
        expect(mocked.spawnSync.mock.calls.flat(2)).not.toContain('--last');
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});
