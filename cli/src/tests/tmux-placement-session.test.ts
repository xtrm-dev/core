import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { placementCreateArgs, resolvePlacement, type ResolvedPlacement } from '../utils/tmux-placement.js';

// CORE-2802 e2e on private tmux servers. The resolver and the verb builder under test are the
// shipped ones: the test supplies ONLY the caller's environment (identity + recorded socket),
// never a binding, so the argv the launcher would run is the argv that runs here. A runner
// that refused to assert the binding would pass on a tree without socket binding (review
// 6082741245, finding 3), so `strictRunner` fails any call it did not expect to be bound.
//
// Servers are private in both directions: the `-L <label>` servers of the test's own tooling
// live under the test's TMUX_TMPDIR, and the process that runs the resolver gets that same
// TMUX_TMPDIR, so even a legitimately unbound call (the default-server case below) cannot see
// the operator's socket. `kill-server` runs per label, and cleanup deletes with `find -delete`.
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
    let defaultServerStarted = false;

    function run(argv: string[], label?: string) {
        const result = spawnSync('tmux', label ? ['-L', label, ...argv] : argv, { env, encoding: 'utf8', stdio: 'pipe' });
        return {
            status: result.status,
            stdout: (result.stdout ?? '').trim(),
            stderr: (result.stderr ?? '').trim(),
        };
    }

    /**
     * The tmux surface the resolver and the verb builder get. `private`: every call must name
     * this server's socket, and it runs on it. `default`: only the socket liveness check may
     * name `deadSocket`; every other call must be unbound and runs on the private default
     * server (the process env has the test's TMUX_TMPDIR).
     */
    function strictRunner(mode: { private: Server } | { default: string }) {
        return (args: string[]) => {
            const bound = args[0] === '-S' ? args.slice(0, 2) : [];
            const rest = bound.length > 0 ? args.slice(2) : args;
            if ('private' in mode) {
                if (bound.length !== 2) throw new Error(`unbound tmux call on a private seat: ${args.join(' ')}`);
                if (bound[1] !== mode.private.socketPath) {
                    throw new Error(`call bound to ${bound[1]}, expected ${mode.private.socketPath}`);
                }
                return mode.private.tmux(rest);
            }
            const isLivenessCheck = bound.length === 2 && bound[1] === mode.default && rest[0] === 'display-message';
            if (bound.length > 0 && !isLivenessCheck) {
                throw new Error(`call bound to ${bound[1]} after the recorded socket was dropped: ${args.join(' ')}`);
            }
            return run(args);
        };
    }

    /** One private server. Both servers of a test share the socket directory, so both hold `%0`. */
    function startServer(name: string): Server {
        const label = `${path.basename(dir).replace(/[^A-Za-z0-9]/g, '')}-${name}`;
        const socketPath = path.join(dir, `tmux-${typeof process.getuid === 'function' ? process.getuid() : 0}`, label);
        const server: Server = {
            label,
            socketPath,
            tmux: (args) => run(args, label),
            kill: () => { run(['kill-server'], label); },
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
        defaultServerStarted = false;
    });

    afterEach(() => {
        for (const server of servers.splice(0)) server.kill();
        if (defaultServerStarted) run(['kill-server']);
        spawnSync('find', [dir, '-delete'], { stdio: 'ignore' });
    });

    /** Resolve as the launcher does: the caller's environment and nothing else. */
    function place(
        role: string | undefined,
        callerEnv: NodeJS.ProcessEnv,
        mode: { private: Server } | { default: string },
    ): ResolvedPlacement {
        return resolvePlacement(
            { role, insideTmux: Boolean(callerEnv.TMUX) },
            {
                env: callerEnv,
                exists: () => true,
                readFile: () => JSON.stringify(LEAD_CONFIG),
                tmux: strictRunner(mode),
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

    /** The launcher's own verb for the resolved placement, run as the launcher runs it. */
    function createPane(server: Server, placement: ResolvedPlacement): string {
        const argv = placementCreateArgs(placement, {
            targetSession: placement.session ?? '',
            windowName: 'worker',
            worktreePath: dir,
            newSessionName: 'unexpected-new-session',
        });
        // The socket comes from the placement, not from the test: that is the chain under test.
        expect(argv.slice(0, 2)).toEqual(['-S', server.socketPath]);
        const created = run(argv);
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

    function captureStderr(run_: () => void): string {
        const written: string[] = [];
        const original = process.stderr.write;
        process.stderr.write = ((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
        }) as typeof process.stderr.write;
        try {
            run_();
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
        const placement = place('worker', { TMUX_PANE: lead.paneId, XTRM_SESSION_SOCKET: server.socketPath }, { private: server });
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
            panes.push(createPane(server, place('worker', callerEnv, { private: server })));
        }
        expect(panes.map(pane => windowOf(server, pane).windowName)).toEqual(['workers', 'workers', 'workers', 'workers']);

        const rolled = place('worker', callerEnv, { private: server });
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
        }, { private: server });
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

        const placement = place('worker', { TMUX_PANE: '%0', XTRM_SESSION_SOCKET: leadServer.socketPath }, { private: leadServer });
        expect(placement).toMatchObject({ kind: 'workers', session: lead.sessionId, socketArgs: ['-S', leadServer.socketPath] });
        expect(windowOf(leadServer, createPane(leadServer, placement)))
            .toMatchObject({ sessionId: lead.sessionId, windowName: 'workers' });
        // The stranger's session was never touched.
        expect(strangerServer.tmux(['list-windows', '-t', stranger.sessionId, '-F', '#{window_name}']).stdout.split('\n')).toEqual(['main']);
        expect(strangerServer.tmux(['list-windows', '-t', stranger.sessionId, '-F', '#{window_panes}']).stdout).toBe('1');
    });

    it('drops a recorded socket that no server answers on and creates on the default server instead', () => {
        const dead = path.join(dir, `tmux-${typeof process.getuid === 'function' ? process.getuid() : 0}`, 'gone');
        // A private DEFAULT server, so the unbound create below never reaches the operator's.
        expect(run(['new-session', '-d', '-s', 'operator', '-n', 'main', '-c', dir]).status).toBe(0);
        defaultServerStarted = true;
        const operatorId = run(['display-message', '-p', '-t', 'operator', '#{session_id}']).stdout;

        // A configured session, so the launch has somewhere to go without the identity: the
        // fallback is order 3, on the default server, and the seat is created there.
        const configured = { ...LEAD_CONFIG, session: 'operator' };
        let placement: ResolvedPlacement | undefined;
        const stderr = captureStderr(() => {
            placement = resolvePlacement(
                { role: 'worker', insideTmux: false },
                {
                    env: { XTRM_SESSION_SOCKET: dead, XTRM_SESSION_NAME: 'operator' },
                    exists: () => true,
                    readFile: () => JSON.stringify(configured),
                    tmux: strictRunner({ default: dead }),
                },
            );
        });
        // The recorded socket is dropped, so the create verb carries no `-S`: on a stale path
        // `new-session -S <dead>` would start a second server there (review finding, HIGH).
        expect(placement).toMatchObject({ kind: 'workers', session: 'operator', socketArgs: [] });
        expect(stderr).toContain(`${dead} is recorded as this seat's tmux server, but nothing answers there`);

        const argv = placementCreateArgs(placement!, {
            targetSession: 'operator',
            windowName: 'worker',
            worktreePath: dir,
            newSessionName: 'unexpected-new-session',
        });
        expect(argv[0]).not.toBe('-S');
        const created = run(argv);
        expect(created.status).toBe(0);
        expect(created.stdout).toMatch(/^%\d+$/);
        const [sessionId, windowName] = run(['display-message', '-p', '-t', created.stdout, '#{session_id}|#{window_name}']).stdout.split('|');
        expect({ sessionId, windowName }).toEqual({ sessionId: operatorId, windowName: 'workers' });
        // No phantom server was created at the dropped path.
        expect(existsSync(dead)).toBe(false);
    });

    it('refuses an identity whose server is unknown instead of guessing a server', () => {
        const leadServer = startServer('a');
        seedSession(leadServer, 'operator');
        // No $TMUX and no recorded socket: `%0` could be a session on any server, so the
        // launcher does not place the launch in it and says why.
        let placement: ResolvedPlacement | undefined;
        const stderr = captureStderr(() => {
            placement = resolvePlacement(
                { role: 'worker', insideTmux: false },
                {
                    env: { TMUX_PANE: '%0' },
                    exists: () => true,
                    readFile: () => JSON.stringify(LEAD_CONFIG),
                    tmux: strictRunner({ default: path.join(dir, 'none') }),
                },
            );
        });
        expect(placement).toMatchObject({ kind: 'session' });
        expect(stderr).toContain('%0 names a tmux session, but the server it belongs to is unknown');
    });

    it('announces a new session only when there is no session to place into', () => {
        const server = startServer('lead');
        let placement: ResolvedPlacement | undefined;
        const stderr = captureStderr(() => {
            placement = place('lead', {}, { private: server });
        });
        expect(placement).toMatchObject({ kind: 'session' });
        expect(stderr).toContain('no tmux session to place this launch in');
    });
});
