import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
    launchCodexWorktreeSession: vi.fn(async () => undefined),
}));

vi.mock('../utils/codex-worktree-session.js', () => mocked);

import { createCodexCommand } from '../commands/codex.js';

describe('xt codex command', () => {
    beforeEach(() => mocked.launchCodexWorktreeSession.mockClear());

    it('defaults to YOLO and forwards the first-class launch inputs', async () => {
        await createCodexCommand().parseAsync([
            'node', 'xt', 'demo',
            '--role', 'reviewer',
            '--issue', 'xtrm-123',
            '--model', 'gpt-5.6-codex',
            '--skill', 'multiplexing',
            '--no-attach',
            '--json',
            '--', '--search',
        ]);

        expect(mocked.launchCodexWorktreeSession).toHaveBeenCalledWith({
            name: 'demo',
            role: 'reviewer',
            issue: 'xtrm-123',
            prompt: undefined,
            model: 'gpt-5.6-codex',
            skills: ['multiplexing'],
            attach: false,
            json: true,
            yolo: true,
            passthrough: ['--search'],
        });
    });

    it('maps --no-yolo without changing other defaults', async () => {
        await createCodexCommand().parseAsync(['node', 'xt', 'safe', '--no-yolo']);

        expect(mocked.launchCodexWorktreeSession).toHaveBeenCalledWith(expect.objectContaining({
            name: 'safe',
            yolo: false,
            attach: true,
            json: false,
        }));
    });

    it('marks the vertical slice experimental and documents hook-trust ownership', () => {
        const help = createCodexCommand().helpInformation();
        expect(help).toContain('EXPERIMENTAL');
        expect(help).toContain('--no-yolo');
        expect(help).toContain('hook trust');
    });
});
