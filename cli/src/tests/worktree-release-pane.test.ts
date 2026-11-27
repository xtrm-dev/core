/**
 * The destructive sequence, against a real tmux server on a private socket.
 *
 * This test exists because the review of PR #995 found the removal path untested: the
 * predicate was covered, the part that respawns a pane and deletes a directory was not.
 * It runs only where tmux is installed; on a host without tmux it reports a skip, never
 * a pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { escapePromptText, readPaneInfo, releasePane } from '../core/worktree-release-pane.js';

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
const originalHome = process.env.HOME;

// The release log and the launcher links live under HOME (and XDG_STATE_HOME when set).
// Point both at a throwaway directory so the suite never writes into the operator's
// state, and the temp-dir leak guard sees nothing outside its own scope.
const originalStateHome = process.env.XDG_STATE_HOME;
beforeAll(() => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-release-pane-home-'));
    created.push(home);
    process.env.HOME = home;
    process.env.XDG_STATE_HOME = path.join(home, '.local', 'state');
});

afterAll(() => {
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalStateHome;
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A pane whose foreground command is `node` — the guard accepts it — that echoes what it
 * receives and does nothing else. A shebang script would report `sh`, not `node`.
 */
function fakeAgentArgv(): string[] {
    return [
        process.execPath,
        '-e',
        'process.stdin.on("data", d => process.stdout.write("read:" + String(d))); setInterval(() => {}, 1000);',
    ];
}

/**
 * The real-prompt case drives the BUILT CLI, so it needs dist, tmux and `script` (for the
 * pty). skipIf keeps it visible as a skip instead of a pass when one is missing.
 */
const canDriveRealCli = hasTmux()
    && spawnSync('script', ['--version'], { stdio: 'pipe' }).status === 0
    && fs.existsSync(path.resolve(process.cwd(), 'dist/index.cjs'));

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
            const prompts: string[] = [];
            const outcome = await releasePane({
                paneId,
                client: '/dev/pts/0',
                dryRun: false,
                confirm: input => { prompts.push(input.prompt); return 'confirmed'; },
            });
            expect(prompts).toHaveLength(1);
            expect(prompts[0]).toContain('release xt/pane');
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

    it('reads a branch, a worktree and a path that hold the field separator (CORE-2811)', () => {
        // '|' is legal in a branch name and a path, and the release decides on both. The
        // shipped format quotes every field, so the values survive instead of shifting the
        // record: this is the reader, on a real server, with a separator inside the data.
        const socket = `xt-release-sep-${process.pid}`;
        const repoRoot = path.join(os.tmpdir(), `xt|sep-${process.pid}`);
        const worktree = path.join(repoRoot, '.xtrm', 'worktrees', 'w|1');
        fs.mkdirSync(worktree, { recursive: true });
        created.push(repoRoot);
        tmuxBin(socket, ['new-session', '-d', '-s', "s|1", '-c', worktree, 'sleep 300']);
        const paneId = tmuxBin(socket, ['list-panes', '-t', "=s|1", '-F', '#{pane_id}']);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_worktree', worktree]);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_branch', 'xt/a|b']);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_bead', 'CORE-1']);
        // readPaneInfo resolves the server from $TMUX, which names this private socket.
        const previousTmux = process.env.TMUX;
        process.env.TMUX = tmuxBin(socket, ['display-message', '-p', '#{socket_path},#{pid},0']);
        try {
            const info = readPaneInfo(paneId);
            expect(info.error).toBeUndefined();
            expect(info.pane).toMatchObject({
                branch: 'xt/a|b',
                worktree,
                bead: 'CORE-1',
                currentPath: fs.realpathSync(worktree),
            });
        } finally {
            if (previousTmux === undefined) delete process.env.TMUX;
            else process.env.TMUX = previousTmux;
            spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'pipe' });
        }
    }, 60_000);

    it.skipIf(!canDriveRealCli)('releases through the real CLI and a real prompt', async () => {
        // The in-process path cannot be tested here: confirmRelease uses spawnSync and
        // blocks the event loop, so nothing in this process could type the answer. Driving
        // the built CLI from a child process exercises the whole chain — argv, prompt,
        // answer, removal — which is the chain round 3 broke.
        const cliEntry = path.resolve(process.cwd(), 'dist/index.cjs');

        const { repoRoot, worktree } = makeRepoWithWorktree();
        const socket = `xt-release-test-cli-${process.pid}`;

        tmuxBin(socket, ['new-session', '-d', '-s', 't', '-c', worktree, 'sleep 300']);
        const paneId = tmuxBin(socket, ['list-panes', '-F', '#{pane_id}']);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_worktree', worktree]);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_branch', 'xt/pane']);
        process.env.TMUX = tmuxBin(socket, ['display-message', '-p', '#{socket_path},#{pid},0']);

        // `script` allocates the pty the prompt needs; TERM is required because the CI
        // runner has none and tmux attach then fails with "terminal does not support clear".
        const client = spawn('script', ['-qfc', `tmux -L ${socket} attach -t t`, '/dev/null'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, TERM: process.env.TERM ?? 'xterm-256color' },
        });
        try {
            let clientName = '';
            for (let attempt = 0; attempt < 40 && !clientName; attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
                const listed = spawnSync('tmux', ['-L', socket, 'list-clients', '-F', '#{client_name}'], { encoding: 'utf8' });
                clientName = (listed.stdout ?? '').trim().split('\n')[0] ?? '';
            }
            expect(clientName).not.toBe('');

            const child = spawn(process.execPath, [cliEntry, 'worktree', 'release', '--pane', paneId, '--client', clientName], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let settled = false;
            child.on('exit', () => { settled = true; });
            const deadline = Date.now() + 25_000;
            while (!settled && Date.now() < deadline) {
                client.stdin?.write('y\n');
                await new Promise(resolve => setTimeout(resolve, 400));
            }
            expect(settled).toBe(true);
            expect(child.exitCode).toBe(0);
            expect(fs.existsSync(worktree)).toBe(false);
        } finally {
            client.kill();
            spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'pipe' });
        }
    }, 120_000);

    it('does not remove the tree when the operator declines', async () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        const socket = `xt-release-test-decline-${process.pid}`;

        tmuxBin(socket, ['new-session', '-d', '-s', 't', '-c', worktree, 'sleep 300']);
        const paneId = tmuxBin(socket, ['list-panes', '-F', '#{pane_id}']);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_worktree', worktree]);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_branch', 'xt/pane']);
        process.env.TMUX = tmuxBin(socket, ['display-message', '-p', '#{socket_path},#{pid},0']);

        try {
            const outcome = await releasePane({
                paneId, client: '/dev/pts/0', dryRun: false, confirm: () => 'declined',
            });
            expect(outcome.action).toBe('refused');
            expect(outcome.detail).toContain('not confirmed');
            expect(fs.existsSync(worktree)).toBe(true);
            expect(git(['worktree', 'list', '--porcelain'], repoRoot)).toContain(worktree);
            expect(tmuxBin(socket, ['display-message', '-p', '-t', paneId, '#{@agent_worktree}'])).toBe(worktree);
        } finally {
            spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'pipe' });
        }
    }, 120_000);

    it('re-checks the tree after the prompt and refuses when it changed', async () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        const socket = `xt-release-test-toctou-${process.pid}`;

        tmuxBin(socket, ['new-session', '-d', '-s', 't', '-c', worktree, 'sleep 300']);
        const paneId = tmuxBin(socket, ['list-panes', '-F', '#{pane_id}']);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_worktree', worktree]);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_branch', 'xt/pane']);
        process.env.TMUX = tmuxBin(socket, ['display-message', '-p', '#{socket_path},#{pid},0']);

        try {
            // An ignored, non-regenerable file appearing while the prompt is up is work
            // the removal must not destroy: the second check has to catch it.
            const outcome = await releasePane({
                paneId,
                client: '/dev/pts/0',
                dryRun: false,
                confirm: () => {
                    fs.writeFileSync(path.join(worktree, '.env'), 'SECRET=1\n', 'utf8');
                    return 'confirmed';
                },
            });
            expect(outcome.action).toBe('refused');
            expect(outcome.detail).toContain('state changed');
            expect(fs.existsSync(path.join(worktree, '.env'))).toBe(true);
            expect(git(['worktree', 'list', '--porcelain'], repoRoot)).toContain(worktree);
        } finally {
            spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'pipe' });
        }
    }, 120_000);

    it('refuses when HEAD moved while the prompt was open', async () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        const socket = `xt-release-test-head-${process.pid}`;

        tmuxBin(socket, ['new-session', '-d', '-s', 't', '-c', worktree, 'sleep 300']);
        const paneId = tmuxBin(socket, ['list-panes', '-F', '#{pane_id}']);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_worktree', worktree]);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_branch', 'xt/pane']);
        process.env.TMUX = tmuxBin(socket, ['display-message', '-p', '#{socket_path},#{pid},0']);

        try {
            // A commit made while the prompt is up is work the prompt never named: the
            // pinned HEAD is what refuses it, not the dirty check.
            const outcome = await releasePane({
                paneId,
                client: '/dev/pts/0',
                dryRun: false,
                confirm: () => {
                    fs.writeFileSync(path.join(worktree, 'late.ts'), 'export const late = 1;\n', 'utf8');
                    git(['add', 'late.ts'], worktree);
                    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'late'], worktree);
                    return 'confirmed';
                },
            });
            expect(outcome.action).toBe('refused');
            expect(outcome.detail).toContain('expected-head');
            expect(fs.existsSync(worktree)).toBe(true);
        } finally {
            spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'pipe' });
        }
    }, 120_000);

    it('refuses a dirty tree and leaves a non-agent pane untouched', async () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        const socket = `xt-release-test-dirty-${process.pid}`;

        // `sleep` is not an agent: this case proves a pane whose foreground is a shell or
        // an ordinary process is never typed into.
        tmuxBin(socket, ['new-session', '-d', '-s', 't', '-c', worktree, 'sleep 300']);
        const paneId = tmuxBin(socket, ['list-panes', '-F', '#{pane_id}']);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_worktree', worktree]);
        process.env.TMUX = tmuxBin(socket, ['display-message', '-p', '#{socket_path},#{pid},0']);

        try {
            fs.writeFileSync(path.join(worktree, 'work.ts'), 'export const x = 1;\n', 'utf8');

            const outcome = await releasePane({ paneId, client: '/dev/pts/0', dryRun: false });
            expect(outcome.action).toBe('refused');
            expect(outcome.detail).toContain('not an agent');
            expect(fs.existsSync(worktree)).toBe(true);
            expect(fs.existsSync(path.join(worktree, 'work.ts'))).toBe(true);
        } finally {
            spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'pipe' });
        }
    }, 120_000);

    it('types the nudge into an agent pane and names the dirty file', async () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        const socket = `xt-release-test-nudge-${process.pid}`;

        tmuxBin(socket, ['new-session', '-d', '-s', 't', '-c', worktree, ...fakeAgentArgv()]);
        const paneId = tmuxBin(socket, ['list-panes', '-F', '#{pane_id}']);
        tmuxBin(socket, ['set-option', '-p', '-t', paneId, '@agent_worktree', worktree]);
        process.env.TMUX = tmuxBin(socket, ['display-message', '-p', '#{socket_path},#{pid},0']);

        try {
            fs.writeFileSync(path.join(worktree, 'work.ts'), 'export const x = 1;\n', 'utf8');
            const outcome = await releasePane({ paneId, dryRun: false });
            expect(outcome.action).toBe('nudged');
            expect(fs.existsSync(worktree)).toBe(true);

            // The text must actually arrive in the pane, which the previous version of this
            // suite never checked: it asserted a refusal and called it a nudge.
            // A long nudge line wraps at the pane width, so assert on the parts that cannot
            // be split: the header, the named path, and the pane's own echo of the paste.
            let screen = '';
            for (let i = 0; i < 30 && !screen.includes('read:XTRM'); i += 1) {
                spawnSync('sleep', ['0.1']);
                screen = tmuxBin(socket, ['capture-pane', '-p', '-t', paneId]);
            }
            expect(screen).toContain('read:XTRM');
            expect(screen).toContain('work.ts');
            expect(screen).toContain('Commit and push');
        } finally {
            spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'pipe' });
        }
    }, 120_000);
});
