// CORE-2432 R8: a worker resolves a restarted dispatcher by participant, xt
// attach refreshes XTRM_DISPATCHER_*, and resolution by participant works
// across worktrees.

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildDispatcherEnv,
    refreshDispatcherEnv,
    resolveDispatcherByParticipant,
    type ProcessInfo,
} from '../core/dispatcher-identity.js';
import { buildAttachEnv } from '../commands/attach.js';
import { AgentHostRegistry, type ProducerConnection } from '../core/agent-host-registry.js';
import type { AgentEventV1 } from '@xtrm/contracts';

let sessionsDir = '';

function writeSession(pid: number, entry: Record<string, unknown>): void {
    fs.writeJsonSync(path.join(sessionsDir, `${pid}.json`), { pid, ...entry });
}

// worker xt (pid 300) <- shell 200 <- dispatcher 100 <- init
const TABLE: Record<number, ProcessInfo> = {
    300: { ppid: 200, startTime: '20' },
    200: { ppid: 100, startTime: '10' },
    100: { ppid: 1, startTime: '10' },
};
const readProcess = (pid: number): ProcessInfo | null => TABLE[pid] ?? null;
/** Every pid is alive. */
const allAlive = (_pid: number): ProcessInfo | null => ({ ppid: 1 });
const noTmux = () => ({ status: 1, stdout: '' });

beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-r8-'));
});

afterEach(() => {
    fs.removeSync(sessionsDir);
});

function stubConnection() {
    const sent: unknown[] = [];
    const connection: ProducerConnection = {
        sendCommand: (_sessionId, payload) => {
            sent.push(payload);
        },
    };
    return { connection, sent };
}

let seq = 0;
function identity(sessionId: string, extra: Record<string, unknown>): AgentEventV1 {
    return {
        schema: 'xtrm.agent-event.v1',
        seq: seq++,
        sessionId,
        at: Date.now(),
        payload: {
            type: 'session_identity',
            runtime: { name: 'pi', version: '1.0.0' },
            cwd: '/w',
            capabilities: ['prompt'],
            ...extra,
        } as never,
    };
}

describe('CORE-2432 R8 worker resolves a restarted dispatcher by participant', () => {
    it('R8 resolves the dispatcher session by participant name, surviving a restart with a new socket', () => {
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        const deps = { sessionsDir, readProcess: allAlive };
        expect(resolveDispatcherByParticipant('coord', deps)).toEqual({
            name: 'coord',
            address: 'uds:/run/cc/100.sock',
        });
        // The dispatcher restarts: same participant name, new socket path.
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/140.sock', procStart: '10' });
        expect(resolveDispatcherByParticipant('coord', deps)).toEqual({
            name: 'coord',
            address: 'uds:/run/cc/140.sock',
        });
        expect(resolveDispatcherByParticipant('nobody', deps)).toBeNull();
    });

    it('F4 several live candidates with one name raise an error naming them, and dead pids are skipped', () => {
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock' });
        writeSession(200, { name: 'coord', messagingSocketPath: '/run/cc/200.sock' });
        let error: Error | null = null;
        try {
            resolveDispatcherByParticipant('coord', { sessionsDir, readProcess: allAlive });
        } catch (e) {
            error = e as Error;
        }
        expect(error?.message).toContain('ambiguous dispatcher participant "coord"');
        expect(error?.message).toContain('uds:/run/cc/100.sock');
        expect(error?.message).toContain('uds:/run/cc/200.sock');
        // A dead pid is skipped, so the live one resolves alone.
        expect(
            resolveDispatcherByParticipant('coord', {
                sessionsDir,
                readProcess: (pid) => (pid === 100 ? null : { ppid: 1 }),
            }),
        ).toEqual({ name: 'coord', address: 'uds:/run/cc/200.sock' });
    });

    it('F2 xt attach resolves the dispatcher by participant against the live sessions', () => {
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        const deps = {
            startPid: 300,
            sessionsDir,
            readProcess,
            tmux: noTmux,
            // Stale inherited address for the same participant name: the live
            // session entry wins, with a pid liveness check (TABLE: 100 alive).
            env: { XTRM_DISPATCHER_NAME: 'coord', XTRM_DISPATCHER_ADDRESS: 'uds:/stale.sock' },
        };
        expect(refreshDispatcherEnv(deps)).toEqual({
            XTRM_DISPATCHER_NAME: 'coord',
            XTRM_DISPATCHER_ADDRESS: 'uds:/run/cc/100.sock',
        });
        const env = buildAttachEnv({ PATH: '/bin' }, 'pi', deps);
        expect(env.XTRM_DISPATCHER_NAME).toBe('coord');
        expect(env.XTRM_DISPATCHER_ADDRESS).toBe('uds:/run/cc/100.sock');
        // The worker keeps its own holder name from the launch, not from attach.
        expect(buildDispatcherEnv('worker-name', deps).SUBSTRATE_HOLDER).toBe('worker-name');
    });

    it('pid reuse at attach: a numeric procStart disagreeing with the live process is skipped', () => {
        // Same file pid, but the live process started at a different time:
        // the pid was reused by an unrelated process, not the dispatcher.
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock', procStart: '999' });
        const deps = {
            sessionsDir,
            readProcess: (_pid: number): ProcessInfo | null => ({ ppid: 1, startTime: '10' }),
        };
        expect(resolveDispatcherByParticipant('coord', deps)).toBeNull();
        // Agreeing procStart resolves.
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        expect(resolveDispatcherByParticipant('coord', deps)).toEqual({
            name: 'coord',
            address: 'uds:/run/cc/100.sock',
        });
        // An entry pid disagreeing with its file is a reused-pid leftover too.
        writeSession(200, { pid: 4242, name: 'coord', messagingSocketPath: '/run/cc/200.sock' });
        expect(resolveDispatcherByParticipant('coord', deps)).toEqual({
            name: 'coord',
            address: 'uds:/run/cc/100.sock',
        });
    });

    it('ambiguity at attach prints one stderr line naming the candidates, then falls back', () => {
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock' });
        writeSession(200, { name: 'coord', messagingSocketPath: '/run/cc/200.sock' });
        const lines: string[] = [];
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
            lines.push(String(chunk));
            return true;
        }) as never);
        try {
            const got = refreshDispatcherEnv({
                sessionsDir,
                readProcess: allAlive,
                startPid: 999,
                env: { XTRM_DISPATCHER_NAME: 'coord', XTRM_DISPATCHER_ADDRESS: 'uds:/stale.sock' },
            });
            // No ancestor either: inherited last resort, after the stderr line.
            expect(got).toEqual({
                XTRM_DISPATCHER_NAME: 'coord',
                XTRM_DISPATCHER_ADDRESS: 'uds:/stale.sock',
            });
        } finally {
            spy.mockRestore();
        }
        expect(lines.join('')).toMatch(/ambiguous dispatcher participant "coord".*uds:\/run\/cc\/100\.sock.*uds:\/run\/cc\/200\.sock/);
    });

    it('F2 a dead participant entry falls back to ancestor resolution', () => {
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        const deps = {
            startPid: 300,
            sessionsDir,
            readProcess: (_pid: number): ProcessInfo | null => null,
            tmux: noTmux,
            env: { XTRM_DISPATCHER_NAME: 'coord', XTRM_DISPATCHER_ADDRESS: 'uds:/stale.sock' },
        };
        // No live entry (pid dead) and no ancestor session: inherited values
        // survive as the last resort, exactly as before.
        expect(refreshDispatcherEnv({ ...deps, startPid: 999 })).toEqual({
            XTRM_DISPATCHER_NAME: 'coord',
            XTRM_DISPATCHER_ADDRESS: 'uds:/stale.sock',
        });
    });

    it('R8 resolution by participant works when the worker runs in a different worktree from its dispatcher', () => {
        const registry = new AgentHostRegistry({ log: () => {} });
        const dispatcher = stubConnection();
        const worker = stubConnection();
        // Dispatcher lives in the main checkout; the worker in an xt worktree:
        // different cwd AND different worktree (F2: the cross-worktree test is real).
        registry.ingest(
            dispatcher.connection,
            identity('d-1', {
                pid: 10,
                generation: 1,
                sessionName: 'coord',
                cwd: '/w/core',
                worktree: '/w/core',
                repositoryPath: '/w/core',
                workItem: { ref: 'CORE-2428' },
            }),
        );
        registry.ingest(
            worker.connection,
            identity('w-1', {
                pid: 20,
                generation: 1,
                sessionName: 'worker',
                cwd: '/w/core/.xtrm/worktrees/core-xt-pi-x',
                worktree: '/w/core/.xtrm/worktrees/core-xt-pi-x',
                repositoryPath: '/w/core',
                workItem: { ref: 'CORE-2432' },
            }),
        );
        // By name, by session id, and by work-item ref alike, regardless of worktree.
        expect(registry.resolveParticipant('coord')).toBe('d-1');
        expect(registry.resolveParticipant('d-1')).toBe('d-1');
        expect(registry.resolveParticipant('CORE-2428')).toBe('d-1');
        // A wake held for an unknown participant flushes once it registers (restart case).
        const held = registry.wake('late-dispatcher', 'CORE-1');
        expect(held.state).toBe('held');
        const late = stubConnection();
        registry.ingest(
            late.connection,
            identity('d-2', { pid: 30, generation: 1, sessionName: 'late-dispatcher', worktree: '/elsewhere' }),
        );
        expect(registry.wakeStatus(held.messageId)?.state).toBe('queued');
    });
});
