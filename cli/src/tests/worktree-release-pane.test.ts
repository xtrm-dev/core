/**
 * The destructive sequence, against a real tmux server on a private socket.
 *
 * This test exists because the review of PR #995 found the removal path untested: the
 * predicate was covered, the part that respawns a pane and deletes a directory was not.
 * It runs only where tmux is installed; on a host without tmux it reports a skip, never
 * a pass.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createTicket, releasePane } from '../core/worktree-release-pane.js';

function hasTmux(): boolean {
    return spawnSync('tmux', ['-V'], { encoding: 'utf8', stdio: 'pipe' }).status === 0;
}

const created: string[] = [];

function tmuxBin(socket: string, args: string[]): string {
    const r = spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`tmux ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout ?? '').trim();
}

function git(args: string[], cwd: string): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout ?? '').trim();
}

function makeRepoWithWorktree(): { repoRoot: string; worktree: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-release-pane-'));
    created.push(repoRoot);
    git(['init', '--quiet', '--initial-branch=main'], repoRoot);
    git(['config', 'user.email', 'test@example.invalid'], repoRoot);
    git(['config', 'user.name', 'test'], repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# t\n', 'utf8');
    git(['add', '-A'], repoRoot);
    git(['commit', '--quiet', '-m', 'initial'], repoRoot);

    const worktree = path.join(repoRoot, '.xtrm', 'worktrees', 'xt-pane');
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(['worktree', 'add', '--quiet', '-b', 'xt/pane', worktree, 'HEAD'], repoRoot);

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-release-pane-origin-'));
    created.push(bare);
    git(['init', '--quiet', '--bare', '--initial-branch=main'], bare);
    git(['remote', 'add', 'origin', bare], repoRoot);
    git(['push', '--quiet', '-u', 'origin', 'main'], repoRoot);
    git(['push', '--quiet', '-u', 'origin', 'xt/pane'], worktree);
    return { repoRoot, worktree };
}

const originalTmux = process.env.TMUX;

afterAll(() => {
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasTmux())('releasePane — confirmed removal', () => {
    it('removes a clean tree, moves the pane to the main checkout and keeps the branch', async () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        const socket = `xt-release-test-${process.pid}`;

        tmuxBin(socket, ['new-session', '-d', '-s', 't', '-c', worktree, 'sleep 300']);
        const paneId = tmuxBin(socket, ['list-panes', '-F', '#{pane_id}']);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_worktree', worktree]);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_branch', 'xt/pane']);
        process.env.TMUX = tmuxBin(socket, ['display-message', '-p', '#{socket_path},#{pid},0']);

        try {
            const head = git(['rev-parse', 'HEAD'], worktree);
            const ticket = createTicket({ paneId, client: '/dev/pts/0', head });
            expect(ticket).toMatch(/^[0-9a-f]{32}$/);

            const outcome = await releasePane({ paneId, ticket: ticket as string, dryRun: false });
            expect(outcome.action).toBe('released');

            expect(fs.existsSync(worktree)).toBe(false);
            expect(git(['worktree', 'list', '--porcelain'], repoRoot)).not.toContain(worktree);
            expect(tmuxBin(socket, ['display-message', '-p', '-t', paneId, '#{pane_current_path}']))
                .toBe(fs.realpathSync(repoRoot));
            // The option must be gone, not merely empty: -q keeps a missing option from throwing.
            const option = spawnSync('tmux', ['-L', socket, 'show-options', '-p', '-q', '-t', paneId, '-v', '@agent_worktree'], { encoding: 'utf8' });
            expect((option.stdout ?? '').trim()).toBe('');
            expect(git(['rev-parse', '--verify', 'xt/pane'], repoRoot)).toBe(head);
        } finally {
            spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'pipe' });
        }
    }, 120_000);

    it('refuses a dirty tree and nudges the agent instead of removing anything', async () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        const socket = `xt-release-test-dirty-${process.pid}`;

        // A long-lived agent-shaped foreground command: the nudge guard accepts `sleep`?
        // No — it does not, and that refusal is the point of this test: a pane whose
        // foreground is not an agent is never typed into.
        tmuxBin(socket, ['new-session', '-d', '-s', 't', '-c', worktree, 'sleep 300']);
        const paneId = tmuxBin(socket, ['list-panes', '-F', '#{pane_id}']);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_worktree', worktree]);
        process.env.TMUX = tmuxBin(socket, ['display-message', '-p', '#{socket_path},#{pid},0']);

        try {
            fs.writeFileSync(path.join(worktree, 'work.ts'), 'export const x = 1;\n', 'utf8');
            const head = git(['rev-parse', 'HEAD'], worktree);
            const ticket = createTicket({ paneId, client: '/dev/pts/0', head });

            const outcome = await releasePane({ paneId, ticket: ticket as string, dryRun: false });
            expect(outcome.action).toBe('refused');
            expect(outcome.detail).toContain('nudge');
            expect(fs.existsSync(worktree)).toBe(true);
            expect(fs.existsSync(path.join(worktree, 'work.ts'))).toBe(true);
        } finally {
            spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'pipe' });
        }
    }, 120_000);
});
