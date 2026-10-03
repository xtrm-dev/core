// XTRM-566: POST /v1/launch — argv construction, request validation, parent resolution, and
// binding the launched pane to the session whose extension reports it.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeFrame, validate } from '@xtrm/contracts';
import type { AgentEventV1, AgentHostApiV1 } from '@xtrm/contracts';
import { AGENT_HOST_BIND_ADDRESS, startAgentHost, type AgentHost } from '../core/agent-host.js';
import {
    AgentHostLauncher,
    LaunchRejection,
    buildLaunchEnv,
    buildPiArgs,
    buildXtPiArgs,
    resolveParentTmuxSession,
    validateLaunchRequest,
    type LaunchRequest,
    type ProcessResult,
    type RunProcess,
} from '../core/agent-host-launch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
    readFileSync(path.resolve(here, '../../../packages/contracts/fixtures/agent-protocol.json'), 'utf8'),
) as { events: AgentEventV1[] };
const identity = fixtures.events[0];

const ALL_OPTIONS = {
    name: 'gui-worker',
    role: 'executor',
    bead: 'XTRM-1',
    model: 'opencode-go/deepseek-v4.1-flash',
    thinking: 'low',
    skills: ['multiplexing', '/abs/skill'],
    prompt: '--looks like a flag\nsecond line',
    parent: '019f9a10-0000-7000-8000-000000000000',
    child: true,
};

function launchRequest(over: Partial<LaunchRequest> = {}): LaunchRequest {
    return { schema: 'xtrm.agent-host-api.v1', kind: 'launch_request', cwd: os.tmpdir(), command: 'xt pi', ...over };
}

interface Call {
    file: string;
    args: readonly string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
}

/** A process runner that records calls and answers by executable. */
function fakeRun(answer: (call: Call) => ProcessResult): { run: RunProcess; calls: Call[] } {
    const calls: Call[] = [];
    const run: RunProcess = async (file, args, options) => {
        const call = { file, args, cwd: options.cwd, env: options.env };
        calls.push(call);
        return answer(call);
    };
    return { run, calls };
}

const xtOutcome = {
    schema_version: 'xtrm.command-outcome.v1',
    status: 'ok',
    reason_code: 'session_created_readiness_unverified',
    summary: 'Detached pi session created; runtime readiness is not asserted.',
    identity: { thread_id: null, session_name: 'xt-gui-worker', tmux_session_id: '$9', pane_id: '%42' },
    authoritative_mutation: { completed: true, kind: 'interactive-session.created' },
    side_effects: [],
    next_actions: [],
};

function tmuxAndXt(call: Call): ProcessResult {
    if (call.file === 'tmux' && call.args[0] === 'list-panes') {
        return { status: 0, stdout: `$1 \n$7 ${ALL_OPTIONS.parent}\n$8 other\n`, stderr: '' };
    }
    if (call.file === 'tmux') return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: `noise\n${JSON.stringify(xtOutcome)}\n`, stderr: '' };
}

describe('launch argv (XTRM-566)', () => {
    it('builds xt pi argv for every option with --opt=value and no bare --', () => {
        const args = buildXtPiArgs(ALL_OPTIONS, '$7');
        expect(args).toEqual([
            'pi', 'gui-worker', '--no-attach', '--json', '--new-session',
            '--role=executor', '--bead=XTRM-1', '--model=opencode-go/deepseek-v4.1-flash', '--thinking=low',
            '--skill=multiplexing', '--skill=/abs/skill',
            `--prompt=${ALL_OPTIONS.prompt}`, '--parent=$7',
        ]);
        expect(args).not.toContain('--');
        expect(buildXtPiArgs({}, null)).toEqual(['pi', '--no-attach', '--json', '--new-session']);
    });

    it('builds bare pi argv with the prompt after --', () => {
        const { role: _role, bead: _bead, ...options } = ALL_OPTIONS;
        expect(buildPiArgs(options, 'pi-abc')).toEqual([
            '--name', 'gui-worker', '--model', 'opencode-go/deepseek-v4.1-flash', '--thinking', 'low',
            '--skill', 'multiplexing', '--skill', '/abs/skill', '--', ALL_OPTIONS.prompt,
        ]);
        expect(buildPiArgs({}, 'pi-abc')).toEqual(['--name', 'pi-abc']);
    });

    it('sets XTRM_AGENT_LAUNCH=gui and drops the host tmux client', () => {
        const env = buildLaunchEnv({ PATH: '/bin', TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%3', XTRM_AGENT_LAUNCH: 'terminal' });
        expect(env).toEqual({ PATH: '/bin', XTRM_AGENT_LAUNCH: 'gui' });
    });
});

describe('launch request validation (XTRM-566)', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'xt-launch-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const reject = (request: LaunchRequest, code: string) => {
        try {
            validateLaunchRequest(request);
        } catch (error) {
            expect(error).toBeInstanceOf(LaunchRejection);
            expect((error as LaunchRejection).code).toBe(code);
            return;
        }
        throw new Error('expected a rejection');
    };

    it('accepts every option for xt pi and resolves cwd', () => {
        const validated = validateLaunchRequest(launchRequest({ cwd: dir, options: ALL_OPTIONS }));
        expect(validated.cwd).toBe(realpathSync(dir));
        expect(validated.options).toEqual(ALL_OPTIONS);
    });

    it('rejects unknown options and options the command cannot honor', () => {
        reject(launchRequest({ cwd: dir, options: { worktree: '/x' } as never }), 'invalid_option');
        reject(launchRequest({ cwd: dir, command: 'pi', options: { role: 'executor' } }), 'invalid_option');
        reject(launchRequest({ cwd: dir, command: 'pi', options: { bead: 'XTRM-1' } }), 'invalid_option');
        reject(launchRequest({ cwd: dir, command: 'bash' as never }), 'invalid_option');
        reject(launchRequest({ cwd: dir, options: { name: 'a:b' } }), 'invalid_option');
        reject(launchRequest({ cwd: dir, options: { name: '-x' } }), 'invalid_option');
        reject(launchRequest({ cwd: dir, options: { model: '--print' } }), 'invalid_option');
        reject(launchRequest({ cwd: dir, options: { skills: ['ok', 'a\nb'] } }), 'invalid_option');
        reject(launchRequest({ cwd: dir, options: { child: true } }), 'invalid_option');
    });

    it('rejects a cwd that is not an existing directory', () => {
        reject(launchRequest({ cwd: 'relative/dir' }), 'invalid_cwd');
        reject(launchRequest({ cwd: path.join(dir, 'missing') }), 'invalid_cwd');
        const file = path.join(dir, 'file');
        writeFileSync(file, '');
        reject(launchRequest({ cwd: file }), 'invalid_cwd');
    });

    it('resolves the parent through @xtrm_agent_session_id', async () => {
        const { run, calls } = fakeRun(tmuxAndXt);
        await expect(resolveParentTmuxSession(run, {}, ALL_OPTIONS.parent)).resolves.toBe('$7');
        expect(calls[0].args).toEqual(['list-panes', '-a', '-F', '#{session_id} #{@xtrm_agent_session_id}']);
        await expect(resolveParentTmuxSession(run, {}, 'unknown')).rejects.toMatchObject({ code: 'parent_not_found' });
    });
});

describe('AgentHostLauncher (XTRM-566)', () => {
    let dir: string;
    beforeEach(() => {
        dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'xt-launch-')));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('runs the host xt build with the launch env and returns the xt pi outcome', async () => {
        const { run, calls } = fakeRun(tmuxAndXt);
        const launcher = new AgentHostLauncher({ xtCommand: ['/node', '/xt/dist/index.cjs'], env: { PATH: '/bin', TMUX: 'x' }, run });
        const result = await launcher.launch(launchRequest({ cwd: dir, options: ALL_OPTIONS }));

        expect(validate('xtrm.agent-host-api.v1', result).valid).toBe(true);
        expect(result.outcome).toEqual(xtOutcome);
        expect(result.tmux).toEqual({ session: 'xt-gui-worker', paneId: '%42' });
        const xt = calls.find((c) => c.file === '/node')!;
        expect(xt.args).toEqual(['/xt/dist/index.cjs', ...buildXtPiArgs(ALL_OPTIONS, '$7')]);
        expect(xt.cwd).toBe(dir);
        expect(xt.env).toEqual({ PATH: '/bin', XTRM_AGENT_LAUNCH: 'gui' });
    });

    it('reports a failed xt pi run as a failed outcome', async () => {
        const { run } = fakeRun(() => ({ status: 1, stdout: '', stderr: '\u001b[31m\n  ✗ --parent \'$7\': tmux session not found\n\u001b[39m' }));
        const launcher = new AgentHostLauncher({ xtCommand: ['/node', '/xt.cjs'], run });
        const result = await launcher.launch(launchRequest({ cwd: dir }));
        expect(validate('xtrm.agent-host-api.v1', result).valid).toBe(true);
        expect(result.outcome).toMatchObject({ status: 'failed', reason_code: 'launch_failed', summary: "--parent '$7': tmux session not found" });
        expect(result.tmux).toBeUndefined();
    });

    it('rejects xt pi output that is not a command outcome', async () => {
        const { run } = fakeRun(() => ({ status: 0, stdout: 'xt-a:%1\n', stderr: '' }));
        const result = await new AgentHostLauncher({ xtCommand: ['/node', '/xt.cjs'], run }).launch(launchRequest({ cwd: dir }));
        expect(result.outcome).toMatchObject({ status: 'failed', reason_code: 'launch_output_invalid' });
    });

    it('starts bare pi in a new tmux session with argv, launch env and parent pane option', async () => {
        const { run, calls } = fakeRun((call) => {
            if (call.args[0] === 'new-session') return { status: 0, stdout: '$5 %50\n', stderr: '' };
            return tmuxAndXt(call);
        });
        const env = { PATH: '/bin', PI_CODING_AGENT_DIR: '/iso/agent', XTRM_AGENT_HOST_SOCKET: '/iso/host.sock' };
        const launcher = new AgentHostLauncher({ piCommand: '/bin/pi', env, run });
        const { role: _r, bead: _b, ...options } = ALL_OPTIONS;
        const result = await launcher.launch(launchRequest({ cwd: dir, command: 'pi', options }));

        expect(validate('xtrm.agent-host-api.v1', result).valid).toBe(true);
        expect(result.outcome.identity).toEqual({ thread_id: null, session_name: 'gui-worker', tmux_session_id: '$5', pane_id: '%50' });
        expect(result.tmux).toEqual({ session: 'gui-worker', paneId: '%50' });
        const created = calls.find((c) => c.args[0] === 'new-session')!;
        expect(created.args).toEqual([
            'new-session', '-d', '-P', '-F', '#{session_id} #{pane_id}', '-s', 'gui-worker', '-c', dir,
            '-e', 'XTRM_AGENT_LAUNCH=gui', '-e', 'XTRM_AGENT_HOST_SOCKET=/iso/host.sock', '-e', 'PI_CODING_AGENT_DIR=/iso/agent',
            '--', '/bin/pi', ...buildPiArgs(options, 'gui-worker'),
        ]);
        expect(calls.find((c) => c.args[0] === 'set-option')!.args).toEqual(['set-option', '-p', '-t', '%50', '@agent_parent_session', '$7']);
    });

    it('fails a bare pi launch when tmux refuses the session', async () => {
        const { run } = fakeRun(() => ({ status: 1, stdout: '', stderr: 'duplicate session: gui-worker\n' }));
        const result = await new AgentHostLauncher({ run }).launch(launchRequest({ cwd: dir, command: 'pi', options: { name: 'gui-worker' } }));
        expect(result.outcome).toMatchObject({ status: 'failed', reason_code: 'launch_failed', summary: 'duplicate session: gui-worker' });
    });
});

describe('POST /v1/launch and pane binding (XTRM-566)', () => {
    let dir: string;
    let host: AgentHost;
    const sockets: net.Socket[] = [];

    beforeEach(async () => {
        dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'xt-launch-host-')));
        const { run } = fakeRun(tmuxAndXt);
        host = await startAgentHost({
            socketPath: path.join(dir, 'host.sock'),
            infoPath: path.join(dir, 'host.json'),
            launch: { xtCommand: ['/node', '/xt.cjs'], run },
            log: () => {},
        });
    });
    afterEach(async () => {
        for (const s of sockets.splice(0)) s.destroy();
        await host.close();
        rmSync(dir, { recursive: true, force: true });
    });

    function post(body: unknown): Promise<{ status: number; body: AgentHostApiV1 }> {
        return new Promise((resolve, reject) => {
            const req = http.request(
                { host: AGENT_HOST_BIND_ADDRESS, port: host.info.port, method: 'POST', path: '/v1/launch', headers: { 'content-type': 'application/json' } },
                (res) => {
                    let text = '';
                    res.setEncoding('utf8');
                    res.on('data', (c: string) => (text += c));
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
                },
            );
            req.on('error', reject);
            req.end(JSON.stringify(body));
        });
    }

    async function connectExtension(paneId: string, sessionId: string): Promise<void> {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
            const s = net.connect(path.join(dir, 'host.sock'), () => resolve(s));
            s.once('error', reject);
        });
        sockets.push(socket);
        const payload = { ...identity.payload, tmux: { session: 'xt-gui-worker', paneId }, launch: 'terminal' };
        socket.write(encodeFrame({ ...identity, sessionId, at: Date.now(), payload } as AgentEventV1));
    }

    async function summaryOf(sessionId: string) {
        const deadline = Date.now() + 5000;
        for (;;) {
            const found = host.registry.list().find((s) => s.sessionId === sessionId);
            if (found) return found;
            if (Date.now() > deadline) throw new Error(`session ${sessionId} never appeared`);
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    it('launches and binds the pane when the extension connects afterwards', async () => {
        const reply = await post(launchRequest({ cwd: dir, options: { name: 'gui-worker', model: 'opencode-go/deepseek-v4.1-flash' } }));
        expect(reply.status).toBe(200);
        expect(validate('xtrm.agent-host-api.v1', reply.body).valid).toBe(true);
        expect(reply.body).toMatchObject({ kind: 'launch_result', tmux: { session: 'xt-gui-worker', paneId: '%42' } });

        await connectExtension('%42', '019f9a10-0000-7000-8000-0000000000a1');
        await connectExtension('%43', '019f9a10-0000-7000-8000-0000000000a2');
        expect(await summaryOf('019f9a10-0000-7000-8000-0000000000a1')).toMatchObject({ launch: 'gui', tmux: { paneId: '%42' } });
        expect(await summaryOf('019f9a10-0000-7000-8000-0000000000a2')).toMatchObject({ launch: 'terminal', tmux: { paneId: '%43' } });
    });

    it('binds a session whose extension connected before the launch returned', async () => {
        await connectExtension('%42', '019f9a10-0000-7000-8000-0000000000b1');
        expect(await summaryOf('019f9a10-0000-7000-8000-0000000000b1')).toMatchObject({ launch: 'terminal' });
        await post(launchRequest({ cwd: dir }));
        expect(await summaryOf('019f9a10-0000-7000-8000-0000000000b1')).toMatchObject({ launch: 'gui' });
    });

    it('rejects a bad cwd, an unknown option, and an unresolvable parent with 400', async () => {
        const badCwd = await post(launchRequest({ cwd: path.join(dir, 'missing') }));
        expect(badCwd).toMatchObject({ status: 400, body: { kind: 'error', code: 'invalid_cwd' } });
        const unknown = await post(launchRequest({ cwd: dir, options: { worktree: '/x' } as never }));
        expect(unknown).toMatchObject({ status: 400, body: { kind: 'error', code: 'invalid_request' } });
        const parent = await post(launchRequest({ cwd: dir, options: { parent: 'nobody' } }));
        expect(parent).toMatchObject({ status: 400, body: { kind: 'error', code: 'parent_not_found' } });
    });
});

const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

describe.skipIf(!tmuxAvailable)('bare pi launch on a real, isolated tmux server (XTRM-566)', () => {
    let dir: string;
    let env: NodeJS.ProcessEnv;

    beforeEach(() => {
        // TMUX_TMPDIR gives this test its own tmux server; no existing session is visible or touched.
        // A short base keeps the server socket path under the Unix socket length limit.
        dir = realpathSync(mkdtempSync('/tmp/xtl-'));
        env = { PATH: process.env.PATH, HOME: process.env.HOME, TMUX_TMPDIR: dir, PI_CODING_AGENT_DIR: path.join(dir, 'agent') };
    });
    afterEach(() => {
        spawnSync('tmux', ['kill-server'], { env: { ...env } });
        rmSync(dir, { recursive: true, force: true });
    });

    it('starts the runtime in a detached session with XTRM_AGENT_LAUNCH=gui in its environment', async () => {
        const fakePi = path.join(dir, 'pi');
        const out = path.join(dir, 'pi.out');
        writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$XTRM_AGENT_LAUNCH" "$PI_CODING_AGENT_DIR" "$PWD" "$@" > '${out}'\nexec sleep 30\n`);
        chmodSync(fakePi, 0o755);
        const launcher = new AgentHostLauncher({ piCommand: fakePi, env });
        const result = await launcher.launch(launchRequest({ cwd: dir, command: 'pi', options: { name: 'launch-test', prompt: '-p hi' } }));
        expect(result.outcome.status).toBe('ok');
        expect(result.tmux?.session).toBe('launch-test');

        const deadline = Date.now() + 5000;
        while (!existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        expect(readFileSync(out, 'utf8').split('\n').slice(0, 7)).toEqual([
            'gui', path.join(dir, 'agent'), dir, '--name', 'launch-test', '--', '-p hi',
        ]);
        const panes = spawnSync('tmux', ['list-panes', '-t', 'launch-test', '-F', '#{pane_id}'], { env, encoding: 'utf8' });
        expect(panes.stdout.trim()).toBe(result.tmux?.paneId);
    });
});
