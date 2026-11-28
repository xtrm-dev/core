import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    callerProcessIds,
    canonicalPath,
    createLivenessProbe,
    discoverTmuxSockets,
    formatWorktreeHolders,
    removalOperations,
    targetIsUnresolved,
    worktreeInUse,
} from '../core/worktree-liveness.js';
import { readProcessCwds } from '../core/worktree-reap.js';

// CORE-2814: one liveness answer, three consumers (the CLI, the Claude
// PreToolUse hook, the Pi extension). The three copies exist because none can
// import another at install time; these tests are what keeps them honest.

const cleanup: Array<() => void> = [];

afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()?.();
});

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function spawnSleeping(dir: string): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: dir,
        stdio: 'ignore',
    });
    cleanup.push(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    return child;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('condition not reached before timeout');
}

async function waitForExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
    });
}

function processCwd(pid: number): string | null {
    const result = spawnSync('readlink', [`/proc/${pid}/cwd`], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

interface PrivateTmux {
    socket: string;
    dir: string;
}

/** A tmux server on a socket under a private TMUX_TMPDIR. Never the default server. */
function privateTmux(): PrivateTmux {
    const dir = tempDir('xtrm-liveguard-tmux-');
    const socket = join(dir, 'private.sock');
    cleanup.push(() => {
        spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf8' });
        rmSync(socket, { force: true });
    });
    return { socket, dir };
}

function tmux(socket: string, args: string[], cwd?: string): ReturnType<typeof spawnSync> {
    return spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', cwd });
}

describe('worktreeInUse (cli/src/core/worktree-liveness.ts)', () => {
    it('reports a child process whose cwd is inside the worktree, and not-live after it exits', async () => {
        const worktree = tempDir('xtrm-liveguard-wt-');
        const child = spawnSleeping(worktree);
        await waitFor(() => processCwd(child.pid as number) === worktree);

        const liveness = worktreeInUse(worktree);
        expect(liveness.live).toBe(true);
        expect(liveness.holders.some(holder => holder.kind === 'process' && holder.pid === child.pid)).toBe(true);
        expect(formatWorktreeHolders(liveness.holders).join('\n')).toContain(`pid ${child.pid}`);

        await waitForExit(child);
        await waitFor(() => !worktreeInUse(worktree).live);
    });

    it('exempts the holders a caller names, and still reports the others', async () => {
        const worktree = tempDir('xtrm-liveguard-wt-');
        const first = spawnSleeping(worktree);
        const second = spawnSleeping(worktree);
        await waitFor(() => processCwd(first.pid as number) === worktree && processCwd(second.pid as number) === worktree);

        const cwds = readProcessCwds();
        const all = worktreeInUse(worktree, { cwds, skipTmux: true });
        expect(all.holders.map(holder => holder.pid).sort()).toEqual([first.pid, second.pid].sort());

        // A release names its own pane tree: those holders are legitimate, the rest block.
        const own = worktreeInUse(worktree, { cwds, skipTmux: true, exemptPids: new Set([first.pid as number]) });
        expect(own.live).toBe(true);
        expect(own.holders.map(holder => holder.pid)).toEqual([second.pid]);

        const none = worktreeInUse(worktree, { cwds, skipTmux: true, exemptPids: new Set([first.pid, second.pid] as number[]) });
        expect(none).toMatchObject({ live: false, holders: [] });

        await waitForExit(first);
        await waitForExit(second);
    });

    it.skipIf(!hasTmux)('reports a tmux pane whose path is inside the worktree, and not-live after it is gone', async () => {
        const worktree = tempDir('xtrm-liveguard-wt-');
        const { socket } = privateTmux();
        const started = tmux(socket, ['new-session', '-d', '-s', 'liveguard', '-c', worktree, 'sleep', '300']);
        expect(started.status, String(started.stderr)).toBe(0);

        // The server sets pane_current_path asynchronously, so the first read can
        // still show the pane in the session's start directory.
        await waitFor(() => worktreeInUse(worktree, { cwds: new Map(), tmuxSockets: [socket] }).live);
        const liveness = worktreeInUse(worktree, { cwds: new Map(), tmuxSockets: [socket] });
        expect(liveness.holders.some(holder => holder.kind === 'pane' && holder.path === worktree)).toBe(true);

        expect(tmux(socket, ['kill-server']).status).toBe(0);
        await waitFor(() => !worktreeInUse(worktree, { cwds: new Map(), tmuxSockets: [socket] }).live);
    });

    it('reports not-live for an empty fixture and does not throw on an unreadable proc root', () => {
        const worktree = tempDir('xtrm-liveguard-wt-');
        expect(worktreeInUse(worktree, { cwds: new Map(), panes: [] })).toMatchObject({ live: false, holders: [] });
        expect(worktreeInUse(worktree, { procRoot: join(worktree, 'missing'), skipTmux: true }).live).toBe(false);
    });

    it('treats a nested cwd as inside and a sibling prefix as outside', () => {
        const worktree = tempDir('xtrm-liveguard-wt-');
        const sibling = `${worktree}-sibling`;
        const cwds = new Map<string, number[]>([[join(worktree, 'a', 'b'), [11]], [sibling, [12]]]);
        const liveness = worktreeInUse(worktree, { cwds, panes: [] });
        expect(liveness.holders.map(holder => holder.pid)).toEqual([11]);
    });

    it('finds a holder when the worktree path is reached through a symlink', async () => {
        const root = tempDir('xtrm-liveguard-symlink-');
        const real = join(root, 'real');
        const nested = join(real, 'wt');
        mkdirSync(nested, { recursive: true });
        const link = join(root, 'link');
        symlinkSync(real, link);

        const child = spawnSleeping(nested);
        await waitFor(() => processCwd(child.pid as number) === nested);

        // /proc reports the kernel-real path; the caller holds the symlinked one.
        const liveness = worktreeInUse(join(link, 'wt'), { panes: [] });
        expect(liveness.live).toBe(true);
        expect(liveness.holders.map(holder => holder.pid)).toContain(child.pid);
        expect(liveness.path).toBe(nested);

        await waitForExit(child);
        await waitFor(() => !worktreeInUse(join(link, 'wt'), { panes: [] }).live);
    });

    it('strips the kernel "(deleted)" suffix, and only for the same directory', async () => {
        const root = tempDir('xtrm-liveguard-deleted-');
        const first = join(root, 'first');
        const second = join(root, 'second');
        mkdirSync(first);
        mkdirSync(second);
        const a = spawnSleeping(first);
        const b = spawnSleeping(second);
        await waitFor(() => processCwd(a.pid as number) === first && processCwd(b.pid as number) === second);

        rmSync(first, { recursive: true, force: true });
        rmSync(second, { recursive: true, force: true });
        // The kernel now reports "<path> (deleted)" for both children.
        await waitFor(() => readProcessCwds().has(first) && readProcessCwds().has(second));
        expect([...readProcessCwds().keys()].every(key => !key.endsWith(' (deleted)'))).toBe(true);

        // The stripped path matches its own child and nothing else: no prefix match.
        expect(worktreeInUse(first, { panes: [] }).holders.map(holder => holder.pid)).toEqual([a.pid]);
        expect(worktreeInUse(second, { panes: [] }).holders.map(holder => holder.pid)).toEqual([b.pid]);
        expect(worktreeInUse(join(root, 'fir'), { panes: [] }).live).toBe(false);

        await waitForExit(a);
        await waitForExit(b);
    });

    it('excludes the caller process ancestry from a dedicated holder view', () => {
        const own = callerProcessIds();
        expect(own.has(process.pid)).toBe(true);
        expect(own.size).toBeGreaterThan(0);
    });

    it('discovers only socket paths, never a regular file posing as one', () => {
        const dir = tempDir('xtrm-liveguard-sockets-');
        const regular = join(dir, 'not-a-socket');
        writeFileSync(regular, '');
        const sockets = discoverTmuxSockets({ TMUX_TMPDIR: dir, TMUX: '' }, -999);
        expect(sockets).toEqual([]);
    });
});

describe('removal command parsing', () => {
    const cases: Array<[string, Array<{ kind: string; targets: string[] }>]> = [
        [
            `git worktree list | awk '/xt-pi-/{print $1}' | while read w; do git worktree remove --force "$w"; done`,
            [{ kind: 'git-worktree-remove', targets: ['$w'] }],
        ],
        ['git worktree remove --force /home/x/dev/core/.xtrm/worktrees/core-a', [{ kind: 'git-worktree-remove', targets: ['/home/x/dev/core/.xtrm/worktrees/core-a'] }]],
        ['git -C /repo worktree remove ../wt', [{ kind: 'git-worktree-remove', targets: ['../wt'] }]],
        ['git worktree prune', []],
        ['rm -rf /tmp/wt', [{ kind: 'rm', targets: ['/tmp/wt'] }]],
        ['rm -r -- /tmp/wt', [{ kind: 'rm', targets: ['/tmp/wt'] }]],
        ['rm -f /tmp/file', []],
        ['find /tmp/wt -name node_modules -delete', [{ kind: 'find-delete', targets: ['/tmp/wt'] }]],
        ['find /tmp/wt -type d -name .git -print', []],
        ['cd /repo && git worktree remove --force "$(git rev-parse --show-toplevel)"', [{ kind: 'git-worktree-remove', targets: ['$(git rev-parse --show-toplevel)'] }]],
        ['FOO=1 git worktree remove wt', [{ kind: 'git-worktree-remove', targets: ['wt'] }]],
        ['command rm -Rf /tmp/wt', [{ kind: 'rm', targets: ['/tmp/wt'] }]],
        ['echo hi # git worktree remove x', []],
        ['git worktree add /tmp/wt -b feature', []],
        ['env git worktree remove --force /tmp/wt', [{ kind: 'git-worktree-remove', targets: ['/tmp/wt'] }]],
        ['sudo -u root git worktree remove /tmp/wt', [{ kind: 'git-worktree-remove', targets: ['/tmp/wt'] }]],
        ['xargs -0 git worktree remove --force /tmp/wt', [{ kind: 'git-worktree-remove', targets: ['/tmp/wt'] }]],
        [`bash -c 'rm -rf /tmp/wt'`, [{ kind: 'shell', targets: [] }, { kind: 'rm', targets: ['/tmp/wt'] }]],
        [`sh -lc "find /tmp/wt -delete"`, [{ kind: 'shell', targets: [] }, { kind: 'find-delete', targets: ['/tmp/wt'] }]],
        ['bash scripts/reap.sh', [{ kind: 'script', targets: ['scripts/reap.sh'] }]],
        ['git worktree remove 2>/dev/null --force /tmp/wt', [{ kind: 'git-worktree-remove', targets: ['/tmp/wt'] }]],
        ['rm -rf /tmp/wt > /dev/null 2>&1', [{ kind: 'rm', targets: ['/tmp/wt'] }]],
        [`git -c alias.x='worktree remove --force' x /tmp/wt`, [{ kind: 'git-worktree-remove', targets: ['/tmp/wt'] }]],
        ['git --config-env=alias.x=ALIAS x /tmp/wt', [{ kind: 'git-worktree-remove', targets: ['/tmp/wt'] }]],
        [`git -c core.alias.y='worktree remove' y /tmp/wt`, [{ kind: 'git-worktree-remove', targets: ['/tmp/wt'] }]],
        [`git -c alias.x='log --oneline' x`, []],
        ['command -p git worktree remove --force /tmp/wt', [{ kind: 'git-worktree-remove', targets: ['/tmp/wt'] }]],
        ['sudo -p prompt git worktree remove /tmp/wt', [{ kind: 'git-worktree-remove', targets: ['/tmp/wt'] }]],
        ['env -u FOO git worktree remove /tmp/wt', [{ kind: 'git-worktree-remove', targets: ['/tmp/wt'] }]],
        ['timeout -s KILL 5 git worktree remove /tmp/wt', [{ kind: 'git-worktree-remove', targets: ['/tmp/wt'] }]],
    ];

    it.each(cases)('parses %s', (command, expected) => {
        expect(removalOperations(command).map((op: { kind: string; targets: string[] }) => ({ kind: op.kind, targets: op.targets }))).toEqual(expected);
    });

    it('never reports a removal for git worktree prune', () => {
        expect(removalOperations('git worktree prune')).toEqual([]);
    });

    it('canonicalises a symlink and a trailing slash to the same directory', () => {
        const root = tempDir('xtrm-liveguard-canon-');
        const target = join(root, 'wt');
        mkdirSync(target);
        const link = join(root, 'link');
        symlinkSync(target, link);
        expect(canonicalPath(link)).toBe(realpathSync(target));
        expect(canonicalPath(`${link}/`)).toBe(realpathSync(target));
        expect(canonicalPath(join(root, 'missing'))).toBe(join(root, 'missing'));
    });

    it('flags every shell-resolved target as unresolved', () => {
        expect(targetIsUnresolved('$w')).toBe(true);
        expect(targetIsUnresolved('$(pwd)')).toBe(true);
        expect(targetIsUnresolved('/tmp/*')).toBe(true);
        expect(targetIsUnresolved('~/wt')).toBe(true);
        expect(targetIsUnresolved('/tmp/wt')).toBe(false);
    });
});
