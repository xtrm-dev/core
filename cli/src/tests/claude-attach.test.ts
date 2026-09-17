import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const roots: string[] = [];
const originalHome = process.env.HOME;

beforeEach(() => {
    mocked.spawnSync.mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
    mocked.spawnSync.mockClear();
    process.env.HOME = originalHome;
    for (const root of roots.splice(0)) fs.removeSync(root);
});

/**
 * CORE-2284. `xt attach` resumes a Claude session with --continue. Without
 * --channels the resumed session cannot be woken by a settling specialist, so
 * it has to poll — the same wake loss CORE-2283 fixed on the bare direct launch
 * path. Detection reads $HOME, so both directions run against a hermetic HOME.
 */
describe('xt attach Claude resume', () => {
    async function attach(pluginInstalled: boolean): Promise<{ home: string; worktree: string }> {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-claude-attach-home-'));
        roots.push(home);
        const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-claude-attach-wt-'));
        roots.push(worktree);
        if (pluginInstalled) {
            fs.ensureDirSync(path.join(home, '.claude', 'plugins'));
            fs.writeJsonSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
                plugins: { 'specialists@xtrm': [{ version: '1.0.0' }] },
            });
        }
        process.env.HOME = home;
        mocked.listXtWorktrees.mockReturnValue([{
            path: worktree,
            branch: 'refs/heads/xt/demo',
            head: 'abc',
            prunable: false,
            runtime: 'claude',
        }]);
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code}`);
        }) as never);

        const { createAttachCommand } = await import('../commands/attach.js');
        await expect(createAttachCommand().parseAsync(['node', 'xt', 'demo'])).rejects.toThrow('exit:0');
        return { home, worktree };
    }

    function claudeResumeArgs(): unknown[] {
        const calls = mocked.spawnSync.mock.calls as unknown[][];
        const call = calls.find((c) => c[0] === 'claude');
        expect(call).toBeDefined();
        return call?.[1] as unknown[];
    }

    it('resumes with --continue and --channels when the plugin manifest is installed', async () => {
        const { worktree } = await attach(true);

        // Exact argv, as in the Codex attach test.
        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'claude',
            ['--continue', '--dangerously-skip-permissions', '--channels', 'plugin:specialists@xtrm'],
            expect.objectContaining({
                cwd: worktree,
                stdio: 'inherit',
                env: expect.objectContaining({ MCP_SDK_GENERATION: 'v2', MCP_PROTOCOL_NEGOTIATION: 'auto' }),
            }),
        );
        expect(claudeResumeArgs()).toContain('--channels');
    });

    it('resumes with --continue and no --channels when the manifest is absent (fail-soft)', async () => {
        const { worktree } = await attach(false);

        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'claude',
            ['--continue', '--dangerously-skip-permissions'],
            expect.objectContaining({
                cwd: worktree,
                stdio: 'inherit',
                env: expect.objectContaining({ MCP_SDK_GENERATION: 'v2', MCP_PROTOCOL_NEGOTIATION: 'auto' }),
            }),
        );
        expect(claudeResumeArgs()).not.toContain('--channels');
    });
});
