import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { placementCreateArgs, resolvePlacement, type ResolvedPlacement } from '../utils/tmux-placement.js';

// CORE-2802 e2e on private tmux servers: `-L <label>` on every call of the test's own
// tooling, including kill-server, so no live session is visible, moved or killed. A lead
// pane launches a worker from a shell WITHOUT `$TMUX`, and the worker lands in the lead
// session's workers window.
//
// The test drives the shipped resolver and the shipped tmux verb builder against a real
// server, so it proves the chain the launcher runs: identity (a pane id and no `$TMUX`) ->
// session -> role rule (workers window, max panes) -> the pane tmux creates. Worktree
// creation is not part of placement and is covered by the launcher tests.
//
// Every probe must carry the socket the identity came from (CORE-2802 review): two servers
// that both hold a `%0` are the collision the binding exists to prevent, so this file builds
// exactly that pair and proves a caller on server A never lands in server B.
const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

const LEAD_CONFIG = { version: 1, workersMaxPanes: 4, placement: { worker: 'workers', lead: 'window' } };

interface Server {
    label: string;
    /** The socket path `tmux -L <label>` uses: `${TMUX_TMPDIR}/tmux-<uid>/<label>`. */
    socketPath: string;
    tmux: (args: string[]) => { status: number | null; stdout: string; stderr: string };
    kill: () => void;
}

describe.skipIf(!tmuxAvailable)('placement on a real, isolated tmux server (CORE-2802)', () => {
    let dir: string;
    let home: string;
    let configPath: string;
    let env: NodeJS.ProcessEnv;
    const servers: Server[] = [];

    /**
     * Bind a call to a private server the way production binds it. A `-S <socket>` the
     * resolver prepended must name this server's socket, and the call then runs on it: the
     * assertion is the point, so a probe that reached the wrong server fails loudly.
     */
    function runner(server: Pick<Server, 'label' | 'socketPath'>, args: string[]) {
        const bound = args[0] === '-S' ? args.slice(0, 2) : [];
        const rest = bound.length > 0 ? args.slice(2) : args;
        if (bound.length > 0 && bound[1] !== server.socketPath) {
            throw new Error(`probe bound to ${bound[1]}, expected this server's socket ${server.socketPath}`);
        }
        const result = spawnSync('tmux', ['-L', server.label, ...rest], { env, encoding: 'utf8', stdio: 'pipe' });
        return {
            status: result.status,
            stdout: (result.stdout ?? '').trim(),
            stderr: (result.stderr ?? '').trim(),
        };
    }

    /** One private server. Both servers of a test share the socket directory, so both hold `%0`. */
    function startServer(name: string): Server {
        const label = `${path.basename(dir).replace(/[^A-Za-z0-9]/g, '')}-${name}`;
        const socketPath = path.join(dir, `tmux-${typeof process.getuid === 'function' ? process.getuid() : 0}`, label);
        const server: Server = {
            label,
            socketPath,
            tmux: (args) => runner(server, args),
            kill: () => { spawnSync('tmux', ['-L', label, 'kill-server'], { env, stdio: 'ignore' }); },
        };
        servers.push(server);
        return server;
    }

    beforeEach(() => {
        // A socket label gives each test its own tmux servers; TMUX_TMPDIR keeps the sockets
        // under the test directory instead of /tmp/tmux-<uid>/.
        dir = realpathSync(mkdtempSync('/tmp/xtpl-'));
        home = path.join(dir, 'home');
        mkdirSync(path.join(home, '.xtrm', 'config'), { recursive: true });
        configPath = path.join(home, '.xtrm', 'config', 'launch.json');
        writeFileSync(configPath, JSON.stringify(LEAD_CONFIG));
        // TMUX and TMUX_PANE are deliberately absent: this is the caller the issue is about.
        // TMUX_TMPDIR is the private socket directory, never the operator's.
        env = {
            PATH: process.env.PATH,
            HOME: home,
            TMUX_TMPDIR: dir,
            XTRM_LAUNCH_CONFIG: configPath,
        };
    });

    afterEach(() => {
        for (const server of servers.splice(0)) server.kill();
        spawnSync('find', [dir, '-delete'], { stdio: 'ignore' });
    });

    /** Resolve as the launcher does: real config file, real tmux server, injected identity. */
    function place(role: string | undefined, callerEnv: NodeJS.ProcessEnv, server: Server): ResolvedPlacement {
        return resolvePlacement(
            { role, insideTmux: Boolean(callerEnv.TMUX) },
            {
                env: callerEnv,
                exists: () => true,
                readFile: () => JSON.stringify(LEAD_CONFIG),
                tmux: (args) => server.tmux(args),
            },
        );
    }

    /** A session with one window, as the operator's or a lead's session looks. */
    function seedSession(server: Server, name: string): { sessionId: string; paneId: string } {
        expect(server.tmux(['new-session', '-d', '-s', name, '-n', 'main', '-c', dir]).status).toBe(0);
        const sessionId = server.tmux(['display-message', '-p', '-t', name, '#{session_id}']).stdout;
        const paneId = server.tmux(['display-message', '-p', '-t', `${sessionId}:main`, '#{pane_id}']).stdout;
        expect(sessionId).toMatch(/^\$\d+$/);
        expect(paneId).toMatch(/^%\d+$/);
        return { sessionId, paneId };
    }

    /** The launcher's own verb for the resolved placement, run against the real server. */
    function createPane(server: Server, placement: ResolvedPlacement): string {
        const created = server.tmux(placementCreateArgs(placement, {
            targetSession: placement.session ?? '',
            windowName: 'worker',
            worktreePath: dir,
            newSessionName: 'unexpected-new-session',
            socketArgs: ['-S', server.socketPath],
        }));
        expect(created.status).toBe(0);
        expect(created.stdout).toMatch(/^%\d+$/);
        return created.stdout;
    }

    // tmux rewrites a TAB inside a format string to '_' (locale-dependent), so '|' separates.
    function windowOf(server: Server, paneId: string): { sessionId: string; sessionName: string; windowName: string } {
        const [sessionId, sessionName, windowName] = server.tmux([
            'display-message', '-p', '-t', paneId, '#{session_id}|#{session_name}|#{window_name}',
        ]).stdout.split('|');
        return { sessionId, sessionName, windowName };
    }

    function captureStderr(run: () => void): string {
        const written: string[] = [];
        const original = process.stderr.write;
        process.stderr.write = ((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
        }) as typeof process.stderr.write;
        try {
            run();
        } finally {
            process.stderr.write = original;
        }
        return written.join('');
    }

    it('places a worker launched without $TMUX from the lead pane into the lead session workers window', () => {
        const server = startServer('lead');
        const lead = seedSession(server, 'operator');
        // The launch runs from a shell inside the lead pane that has no $TMUX: the inherited
        // pane id and the socket the launcher recorded name the session (CORE-2802).
        const placement = place('worker', { TMUX_PANE: lead.paneId, XTRM_SESSION_SOCKET: server.socketPath }, server);
        expect(placement).toMatchObject({ kind: 'workers', session: lead.sessionId, windowName: 'workers' });

        const workerPane = createPane(server, placement);
        expect(workerPane).not.toBe(lead.paneId);
        expect(windowOf(server, workerPane)).toEqual({ sessionId: lead.sessionId, sessionName: 'operator', windowName: 'workers' });
        // The lead's own pane is untouched: placement never moves or kills an existing pane.
        expect(windowOf(server, lead.paneId).windowName).toBe('main');
    });

    it('fills the lead workers window up to the cap, then rolls over to workers-2', () => {
        const server = startServer('lead');
        const lead = seedSession(server, 'operator');
        const callerEnv = { TMUX_PANE: lead.paneId, XTRM_SESSION_SOCKET: server.socketPath };
        const panes: string[] = [];
        for (let index = 0; index < 4; index += 1) {
            panes.push(createPane(server, place('worker', callerEnv, server)));
        }
        expect(panes.map(pane => windowOf(server, pane).windowName)).toEqual(['workers', 'workers', 'workers', 'workers']);

        const rolled = place('worker', callerEnv, server);
        expect(rolled).toMatchObject({ kind: 'workers', session: lead.sessionId, windowName: 'workers-2', existingWindow: false });
        expect(windowOf(server, createPane(server, rolled))).toMatchObject({ sessionId: lead.sessionId, windowName: 'workers-2' });
    });

    it('places a caller in another session into that session, never into the lead session', () => {
        const server = startServer('lead');
        const lead = seedSession(server, 'operator');
        const other = seedSession(server, 'other-project');
        const placement = place('worker', {
            TMUX: `${server.socketPath},1,0`,
            TMUX_PANE: other.paneId,
        }, server);
        expect(placement).toMatchObject({ kind: 'workers', session: other.sessionId });

        expect(windowOf(server, createPane(server, placement))).toMatchObject({ sessionId: other.sessionId, windowName: 'workers' });
        expect(server.tmux(['list-windows', '-t', lead.sessionId, '-F', '#{window_name}']).stdout.split('\n')).toEqual(['main']);
    });

    it('never resolves a pane id on a server the caller does not belong to, even when both hold %0', () => {
        const leadServer = startServer('a');
        const strangerServer = startServer('b');
        const lead = seedSession(leadServer, 'operator');
        const stranger = seedSession(strangerServer, 'stranger');
        // The collision: both servers hold a pane `%0`, and the caller's pane id is the same
        // string on either one. Its socket decides which server the id means.
        expect(lead.paneId).toBe('%0');
        expect(stranger.paneId).toBe('%0');

        const placement = place('worker', { TMUX_PANE: '%0', XTRM_SESSION_SOCKET: leadServer.socketPath }, leadServer);
        expect(placement).toMatchObject({ kind: 'workers', session: lead.sessionId });
        expect(windowOf(leadServer, createPane(leadServer, placement)))
            .toMatchObject({ sessionId: lead.sessionId, windowName: 'workers' });
        // The stranger's session was never touched.
        expect(strangerServer.tmux(['list-windows', '-t', stranger.sessionId, '-F', '#{window_name}']).stdout.split('\n')).toEqual(['main']);
        expect(strangerServer.tmux(['list-windows', '-t', stranger.sessionId, '-F', '#{window_panes}']).stdout).toBe('1');
    });

    it('refuses an identity whose server is unknown instead of guessing a server', () => {
        const leadServer = startServer('a');
        seedSession(leadServer, 'operator');
        // No $TMUX and no recorded socket: `%0` could be a session on any server, so the
        // launcher does not place the launch in it and says why.
        let placement: ResolvedPlacement | undefined;
        const stderr = captureStderr(() => {
            placement = place('worker', { TMUX_PANE: '%0' }, leadServer);
        });
        expect(placement).toMatchObject({ kind: 'session' });
        expect(stderr).toContain('%0 names a tmux session, but the server it belongs to is unknown');
    });

    it('announces a new session only when there is no session to place into', () => {
        const server = startServer('lead');
        let placement: ResolvedPlacement | undefined;
        const stderr = captureStderr(() => {
            placement = place('lead', {}, server);
        });
        expect(placement).toMatchObject({ kind: 'session' });
        expect(stderr).toContain('no tmux session to place this launch in');
    });
});
