// CORE-2728: the real `sb` runner surface. `node:child_process` is mocked here so
// the launch/attach code paths that do NOT inject a runner are exercised: the
// spawn budget (M7a), a failed trace read during attach (F6) and the newest-binding
// pick through the whole attach chain (M4b).

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatcherResolution, ProcessInfo } from '../core/dispatcher-identity.js';

/** A resolution with the fields the record call ignores left at their defaults. */
function resolution(over: Partial<DispatcherResolution> = {}): DispatcherResolution {
    return { source: 'ancestor', procStartChecked: false, skipped: [], ...over };
}

const mocked = vi.hoisted(() => ({
    spawnSync: vi.fn((_command?: unknown, _args?: unknown, _options?: unknown) => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawnSync: mocked.spawnSync };
});

const CALLER = 'CORE-2728';
const SESSION_UUID = '01a1ec56-3da4-77fb-aed5-c6dee5eb40ce';

let sessionsDir = '';

beforeEach(() => {
    mocked.spawnSync.mockReset();
    mocked.spawnSync.mockReturnValue({ status: 0, stdout: '{}', stderr: '' });
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-d8-sb-'));
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.removeSync(sessionsDir);
});

function traceStdout(bindings: Array<Record<string, unknown>>): string {
    return JSON.stringify({ schema: 'substrate-cli/v1', command: 'provenance.trace', ok: true, data: { bindings } });
}

/** A live dispatcher session owned by `holder` (matched on SUBSTRATE_HOLDER). */
function liveHolder(holder: string): { sessionsDir: string; readProcess: () => ProcessInfo; readEnviron: (pid: number) => NodeJS.ProcessEnv | null; env: NodeJS.ProcessEnv } {
    fs.writeJsonSync(path.join(sessionsDir, '100.json'), {
        pid: 100,
        name: 'g04z-lead',
        messagingSocketPath: '/run/cc/100.sock',
        sessionId: SESSION_UUID,
    });
    return {
        sessionsDir,
        readProcess: (): ProcessInfo => ({ ppid: 1 }),
        readEnviron: (pid: number): NodeJS.ProcessEnv | null => (pid === 100 ? { SUBSTRATE_HOLDER: holder } : null),
        env: {},
    };
}

describe('the default sb runner (CORE-2728 M7a)', () => {
    it('bounds the spawn with the provenance timeout and a hard kill', async () => {
        const { PROVENANCE_TIMEOUT_MS, recordDispatcherBinding } = await import('../core/dispatcher-identity.js');
        const written = recordDispatcherBinding({
            ref: CALLER,
            resolution: resolution({ participant: 'g04z' }),
        });
        expect(written.written).toBe(true);
        expect(mocked.spawnSync).toHaveBeenCalledTimes(1);
        const [command, args, options] = mocked.spawnSync.mock.calls[0] as [string, string[], Record<string, unknown>];
        expect(command).toBe('sb');
        expect(args).toEqual(['provenance', 'dispatch', CALLER, '--dispatcher-participant', 'g04z']);
        // Without the timeout a hung sb would block the launch forever.
        expect(options.timeout).toBe(PROVENANCE_TIMEOUT_MS);
        expect(options.timeout).toBe(5_000);
        expect(options.killSignal).toBe('SIGKILL');
        expect(options.encoding).toBe('utf8');
    });

    it('forwards an explicit shorter budget', async () => {
        const { recordDispatcherBinding } = await import('../core/dispatcher-identity.js');
        recordDispatcherBinding({
            ref: CALLER,
            resolution: resolution({ participant: 'g04z' }),
            timeoutMs: 800,
        });
        const [, , options] = mocked.spawnSync.mock.calls[0] as [string, string[], Record<string, unknown>];
        expect(options.timeout).toBe(800);
    });
});

describe('a failed trace read during attach (CORE-2728 F6)', () => {
    it('warns once on stderr and leaves the dispatcher absent', async () => {
        const { attachDispatcherEnv } = await import('../core/dispatcher-identity.js');
        mocked.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'no store' });
        const lines: string[] = [];
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
            lines.push(String(chunk));
            return true;
        }) as never);
        let env: Record<string, string>;
        try {
            env = attachDispatcherEnv(CALLER, { identity: liveHolder('g04z') });
        } finally {
            spy.mockRestore();
        }
        expect(env).toEqual({});
        expect(lines).toHaveLength(1);
        expect(lines[0]).toBe(`xt attach: the launch binding of ${CALLER} could not be read (sb (sb) exited 1: no store); the dispatcher stays absent\n`);
        // The trace argv is the documented read, run in the attach process env.
        expect(mocked.spawnSync.mock.calls[0]?.[0]).toBe('sb');
        expect(mocked.spawnSync.mock.calls[0]?.[1]).toEqual(['provenance', 'trace', CALLER, '--json']);
    });

    it('stays silent when the store answers but records no dispatcher', async () => {
        const { attachDispatcherEnv } = await import('../core/dispatcher-identity.js');
        mocked.spawnSync.mockReturnValue({ status: 0, stdout: traceStdout([]), stderr: '' });
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
        try {
            expect(attachDispatcherEnv(CALLER, { identity: liveHolder('g04z') })).toEqual({});
        } finally {
            spy.mockRestore();
        }
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('the newest binding wins through the whole attach chain (CORE-2728 M4b)', () => {
    it('picks the newest binding even when it is not the last row', async () => {
        const { attachDispatcherEnv } = await import('../core/dispatcher-identity.js');
        // Newest FIRST in the array: a "last row wins" reader would answer old-lead.
        mocked.spawnSync.mockReturnValue({
            status: 0,
            stdout: traceStdout([
                { id: 'exb_03', dispatcherParticipantId: 'g04z', dispatcherSessionId: SESSION_UUID, createdAt: 1_800 },
                { id: 'exb_02', dispatcherParticipantId: 'old-lead', createdAt: 1_700 },
                { id: 'exb_01', dispatcherParticipantId: 'oldest-lead', createdAt: 1_600 },
            ]),
            stderr: '',
        });
        const identity = liveHolder('g04z');
        fs.writeJsonSync(path.join(sessionsDir, '200.json'), {
            pid: 200,
            name: 'old-lead',
            messagingSocketPath: '/run/cc/200.sock',
        });
        identity.readEnviron = (pid: number) => ({ 100: { SUBSTRATE_HOLDER: 'g04z' }, 200: { SUBSTRATE_HOLDER: 'old-lead' } }[pid] ?? null);
        const env = attachDispatcherEnv(CALLER, { identity });
        expect(env).toEqual({
            XTRM_DISPATCHER_PARTICIPANT: 'g04z',
            XTRM_DISPATCHER_NAME: 'g04z-lead',
            XTRM_DISPATCHER_ADDRESS: 'uds:/run/cc/100.sock',
        });
    });
});
