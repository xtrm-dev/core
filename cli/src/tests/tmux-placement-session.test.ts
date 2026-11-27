import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { placementCreateArgs, resolvePlacement, type ResolvedPlacement } from '../utils/tmux-placement.js';

// CORE-2802 e2e on a private tmux server: `-L <label>` on every single call, including
// kill-server, so no live session is visible, moved or killed. A lead pane launches a
// worker from a shell WITHOUT `$TMUX`, and the worker lands in the lead session's workers
// window.
//
// The test drives the shipped resolver and the shipped tmux verb builder against a real
// server, so it proves the chain the launcher runs: identity (a pane id and no `$TMUX`) ->
// session -> role rule (workers window, max panes) -> the pane tmux creates. Worktree
// creation is not part of placement and is covered by the launcher tests.
const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

const LEAD_CONFIG = { version: 1, workersMaxPanes: 4, placement: { worker: 'workers', lead: 'window' } };

interface Server {
    dir: string;
    home: string;
    label: string;
    env: NodeJS.ProcessEnv;
    tmux: (args: string[]) => { status: number | null; stdout: string; stderr: string };
}

describe.skipIf(!tmuxAvailable)('placement on a real, isolated tmux server (CORE-2802)', () => {
    let server: Server;

    const start = (args: string[]) => server.tmux(args);

    beforeEach(() => {
        // A socket label gives this test its own tmux server; TMUX_TMPDIR keeps the socket
        // under the test directory instead of /tmp/tmux-<uid>/.
        const dir = realpathSync(mkdtempSync('/tmp/xtpl-'));
        const label = `xtpl-${path.basename(dir).replace(/[^A-Za-z0-9]/g, '')}`;
        const home = path.join(dir, 'home');
        mkdirSync(path.join(home, '.xtrm', 'config'), { recursive: true });
        const configPath = path.join(home, '.xtrm', 'config', 'launch.json');
        writeFileSync(configPath, JSON.stringify(LEAD_CONFIG));
        // TMUX and TMUX_PANE are deliberately absent: this is the caller the issue is about.
        const env: NodeJS.ProcessEnv = {
            PATH: process.env.PATH,
            HOME: home,
            TMUX_TMPDIR: dir,
            XTRM_LAUNCH_CONFIG: configPath,
        };
        server = {
            dir,
            home,
            label,
            env,
            // `-L` on every call: the resolver's dependency reaches only this server, and the
            // environment carries neither TMUX nor TMUX_PANE (the shell has no tmux to begin with).
            tmux: (args) => {
                const result = spawnSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', stdio: 'pipe' });
                return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
            },
        };
    });

    afterEach(() => {
        spawnSync('tmux', ['-L', server.label, 'kill-server'], { env: server.env });
        spawnSync('find', [server.dir, '-delete'], { stdio: 'ignore' });
    });

    /** Resolve as the launcher does: real config file, real tmux server, injected identity. */
    function place(role: string | undefined, env: NodeJS.ProcessEnv): ResolvedPlacement {
        return resolvePlacement(
            { role, insideTmux: Boolean(env.TMUX) },
            {
                env,
                exists: () => true,
                readFile: () => JSON.stringify(LEAD_CONFIG),
                tmux: (args) => server.tmux(args),
            },
        );
    }

    /** A session with one window, as the operator's or a lead's session looks. */
    function seedSession(name: string): { sessionId: string; paneId: string } {
        expect(start(['new-session', '-d', '-s', name, '-n', 'main', '-c', server.dir]).status).toBe(0);
        const sessionId = start(['display-message', '-p', '-t', name, '#{session_id}']).stdout;
        const paneId = start(['display-message', '-p', '-t', `${sessionId}:main`, '#{pane_id}']).stdout;
        expect(sessionId).toMatch(/^\$\d+$/);
        expect(paneId).toMatch(/^%\d+$/);
        return { sessionId, paneId };
    }

    /** The launcher's own verb for the resolved placement, run against the real server. */
    function createPane(placement: ResolvedPlacement): string {
        const created = start(placementCreateArgs(placement, {
            targetSession: placement.session ?? '',
            windowName: 'worker',
            worktreePath: server.dir,
            newSessionName: 'unexpected-new-session',
        }));
        expect(created.status).toBe(0);
        expect(created.stdout).toMatch(/^%\d+$/);
        return created.stdout;
    }

    // tmux rewrites a TAB inside a format string to '_', so '|' separates the fields.
    function windowOf(paneId: string): { sessionId: string; sessionName: string; windowName: string } {
        const [sessionId, sessionName, windowName] = start([
            'display-message', '-p', '-t', paneId, '#{session_id}|#{session_name}|#{window_name}',
        ]).stdout.split('|');
        return { sessionId, sessionName, windowName };
    }

    it('places a worker launched without $TMUX from the lead pane into the lead session workers window', () => {
        const lead = seedSession('operator');
        // The launch runs from a shell inside the lead pane that has no $TMUX: only the
        // inherited pane id names the session (CORE-2802).
        const placement = place('worker', { TMUX_PANE: lead.paneId });
        expect(placement).toMatchObject({ kind: 'workers', session: lead.sessionId, windowName: 'workers' });

        const workerPane = createPane(placement);
        expect(workerPane).not.toBe(lead.paneId);
        expect(windowOf(workerPane)).toEqual({ sessionId: lead.sessionId, sessionName: 'operator', windowName: 'workers' });
        // The lead's own pane is untouched: placement never moves or kills an existing pane.
        expect(windowOf(lead.paneId).windowName).toBe('main');
    });

    it('fills the lead workers window up to the cap, then rolls over to workers-2', () => {
        const lead = seedSession('operator');
        const panes: string[] = [];
        for (let index = 0; index < 4; index += 1) {
            panes.push(createPane(place('worker', { TMUX_PANE: lead.paneId })));
        }
        expect(panes.map(pane => windowOf(pane).windowName)).toEqual(['workers', 'workers', 'workers', 'workers']);

        const rolled = place('worker', { TMUX_PANE: lead.paneId });
        expect(rolled).toMatchObject({ kind: 'workers', session: lead.sessionId, windowName: 'workers-2', existingWindow: false });
        expect(windowOf(createPane(rolled))).toMatchObject({ sessionId: lead.sessionId, windowName: 'workers-2' });
    });

    it('places a caller in another session into that session, never into the lead session', () => {
        const lead = seedSession('operator');
        const other = seedSession('other-project');
        const placement = place('worker', { TMUX: `${server.dir}/default,1,0`, TMUX_PANE: other.paneId });
        expect(placement).toMatchObject({ kind: 'workers', session: other.sessionId });

        expect(windowOf(createPane(placement))).toMatchObject({ sessionId: other.sessionId, windowName: 'workers' });
        expect(start(['list-windows', '-t', lead.sessionId, '-F', '#{window_name}']).stdout.split('\n')).toEqual(['main']);
    });

    it('announces a new session only when there is no session to place into', () => {
        const written: string[] = [];
        const original = process.stderr.write;
        process.stderr.write = ((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
        }) as typeof process.stderr.write;
        try {
            expect(place('lead', {})).toMatchObject({ kind: 'session' });
        } finally {
            process.stderr.write = original;
        }
        expect(written.join('')).toContain('no tmux session to place this launch in');
    });
});
