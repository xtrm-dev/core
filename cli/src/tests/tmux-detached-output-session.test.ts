import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVE_SESSION_LISTING_FORMAT, parseLiveTmuxSessionListing } from '../core/launch-outcome.js';

// CORE-2811 e2e on a private tmux server. tmux rewrites a control character inside a
// format argument to '_' under a non-UTF-8 locale (CORE-2802), so a TAB-separated
// listing collapses into one field and the detached-output path reports a live
// session as gone. The unit fixtures in launch-outcome.test.ts cannot catch a
// regression here: a mock returns whatever the test writes, so a TAB there still
// "matches". These tests run the shipped format and the shipped launcher argv
// against a real tmux binary, on a server under the test's own TMUX_TMPDIR.
//
// Private in both directions: every tmux call names the test's own `-L <label>`
// server, `kill-server` runs per label, and cleanup deletes with `find -delete`.
const actualCp = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const tmuxAvailable = actualCp.spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

const mocked = vi.hoisted(() => ({
    spawnSync: vi.fn(),
    ensureAgentsSkillsSymlink: vi.fn(async () => undefined),
}));

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawnSync: mocked.spawnSync };
});

vi.mock('../core/skills-scaffold.js', () => ({
    ensureAgentsSkillsSymlink: mocked.ensureAgentsSkillsSymlink,
}));

describe.skipIf(!tmuxAvailable)('detached launch output on a real, private tmux server (CORE-2811)', () => {
    let dir = '';
    let home = '';
    let label = '';
    let tmuxEnv: NodeJS.ProcessEnv = {};
    let previousEnv: Record<string, string | undefined> = {};
    let previousCwd = '';
    let tempRoot = '';
    const realSpawnSync = actualCp.spawnSync;
    const savedEnvKeys = [
        'TMUX', 'TMUX_PANE', 'XTRM_SESSION_SOCKET', 'XTRM_SESSION_ID', 'XTRM_SESSION_NAME',
        'XTRM_LAUNCH_CONFIG', 'PI_AGENT_DIR', 'PI_CODING_AGENT_DIR',
    ] as const;

    function tmux(args: string[]): { status: number | null; stdout: string; stderr: string } {
        const result = realSpawnSync('tmux', ['-L', label, ...args], { env: tmuxEnv, encoding: 'utf8', stdio: 'pipe' });
        return {
            status: result.status,
            stdout: String(result.stdout ?? '').trim(),
            stderr: String(result.stderr ?? '').trim(),
        };
    }

    beforeEach(async () => {
        dir = path.join(await fs.realpath(os.tmpdir()), `xtsep-${process.pid}-${Date.now()}`);
        await fs.ensureDir(dir);
        home = path.join(dir, 'home');
        await fs.ensureDir(home);
        label = `xtsep${process.pid}`;
        // TMUX and TMUX_PANE are deliberately absent: this is the caller the issue is about.
        // TMUX_TMPDIR keeps the private server's socket out of the operator's socket directory.
        tmuxEnv = { PATH: process.env.PATH, HOME: home, TMUX_TMPDIR: dir };
        previousEnv = Object.fromEntries(savedEnvKeys.map((key) => [key, process.env[key]]));
        for (const key of savedEnvKeys) delete process.env[key];
        tempRoot = path.join(dir, 'repo');
        previousCwd = process.cwd();
        mocked.spawnSync.mockReset();
        mocked.ensureAgentsSkillsSymlink.mockReset();
        mocked.ensureAgentsSkillsSymlink.mockResolvedValue(undefined);
        vi.resetModules();
    });

    afterEach(async () => {
        process.chdir(previousCwd);
        for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        tmux(['kill-server']);
        realSpawnSync('find', [dir, '-delete'], { stdio: 'ignore' });
        await fs.remove(tempRoot);
        vi.restoreAllMocks();
    });

    it('resolves a live session from the shipped listing format and parser', () => {
        expect(tmux(['new-session', '-d', '-s', 'pi-json', '-c', dir]).status).toBe(0);
        const sessionId = tmux(['display-message', '-p', '-t', 'pi-json', '#{session_id}']).stdout;
        expect(sessionId).toMatch(/^\$\d+$/);

        // The format the launcher passes, run by the real binary, parsed by the real parser.
        const listing = tmux(['list-sessions', '-F', LIVE_SESSION_LISTING_FORMAT]);
        expect(listing.status).toBe(0);
        expect(listing.stdout).toBe(`pi-json|${sessionId}`);
        expect(parseLiveTmuxSessionListing(listing.status, `${listing.stdout}\n`, 'pi-json')).toEqual({
            ok: true,
            sessionId,
        });
    });

    it('reports the detached session of `xt pi --json` as live', async () => {
        const repoRoot = tempRoot;
        const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-pi-json');
        await fs.ensureDir(path.join(repoRoot, '.beads'));
        // The real `new-session` runs this: a stub that answers the version probe and then
        // stays alive, so the session the detached-output path looks for is still there.
        const runtime = path.join(repoRoot, 'bin', 'pi');
        await fs.ensureDir(path.dirname(runtime));
        await fs.writeFile(runtime, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 0.74.2"; exit 0; fi\nexec sleep 120\n', { mode: 0o755 });
        process.env.PI_AGENT_DIR = path.join(home, 'pi-agent');
        process.env.PI_CODING_AGENT_DIR = path.join(home, 'pi-agent');
        process.chdir(repoRoot);

        mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
            if (command === 'tmux') {
                if (args[0] === '-S') throw new Error(`unbound seat expected, got: ${args.join(' ')}`);
                return tmux(args);
            }
            const joinedArgs = args.join(' ');
            if (command === 'sh' && args[0] === '-c') {
                return { status: 0, stdout: 'bin/pi\n', stderr: '' };
            }
            if (command === 'git' && joinedArgs === 'rev-parse --show-toplevel') {
                return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
            }
            if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
                return { status: 0, stdout: '.git\n', stderr: '' };
            }
            if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
                fs.ensureDirSync(worktreePath);
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'bd') return { status: 0, stdout: '', stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
        });

        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
            throw new Error(`exit:${code ?? 0}`) as never;
        });
        const { launchWorktreeSession } = await import('../utils/worktree-session.js');

        await expect(launchWorktreeSession({
            runtime: 'pi',
            name: 'json',
            prompt: 'echo hi',
            attach: false,
            json: true,
        })).rejects.toThrow('exit:0');

        // The launcher asked the real server with the shipped separator.
        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'tmux',
            expect.arrayContaining(['list-sessions', '-F', LIVE_SESSION_LISTING_FORMAT]),
            expect.anything(),
        );
        expect(logSpy).not.toHaveBeenCalled();
        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        const outcome = JSON.parse(String(stdoutSpy.mock.calls[0][0]));

        const sessionId = tmux(['display-message', '-p', '-t', 'pi-json', '#{session_id}']).stdout;
        expect(sessionId).toMatch(/^\$\d+$/);
        expect(tmux(['has-session', '-t', '=pi-json']).status).toBe(0);
        expect(outcome).toMatchObject({
            schema_version: 'xtrm.command-outcome.v1',
            identity: { session_name: 'pi-json', tmux_session_id: sessionId },
            worktree: { path: worktreePath, branch: 'xt/json' },
            persistence: { completed: true },
        });
        expect(outcome.identity.pane_id).toMatch(/^%\d+$/);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('keeps every tmux format in the cli sources free of control separators', async () => {
        const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
        const offenders: string[] = [];
        async function walk(current: string): Promise<void> {
            for (const entry of await fs.readdir(current, { withFileTypes: true })) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'tests') continue;
                    await walk(full);
                    continue;
                }
                if (!full.endsWith('.ts')) continue;
                const lines = (await fs.readFile(full, 'utf8')).split('\n');
                lines.forEach((line, index) => {
                    // A tmux format expansion next to a TAB or unit-separator escape is the bug.
                    if (line.includes('#{') && (line.includes('\\t') || line.includes('\\u001f'))) {
                        offenders.push(`${path.relative(cliRoot, full)}:${index + 1}: ${line.trim()}`);
                    }
                });
            }
        }
        await walk(path.join(cliRoot, 'src'));
        expect(offenders).toEqual([]);
    });
});
