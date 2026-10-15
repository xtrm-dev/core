import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    buildDispatcherEnv,
    resolveDispatcher,
    stripDispatcherEnv,
    type ProcessInfo,
} from '../core/dispatcher-identity.js';

// CORE-2390: dispatcher identity resolution. Hermetic: a temp session
// registry, an injected process table and an injected tmux probe.

let sessionsDir = '';

function writeSession(pid: number, entry: Record<string, unknown>): void {
    fs.writeJsonSync(path.join(sessionsDir, `${pid}.json`), { pid, ...entry });
}

// worker xt (pid 300) <- shell 200 <- claude 100 <- init
const TABLE: Record<number, ProcessInfo> = {
    300: { ppid: 200, startTime: '30' },
    200: { ppid: 100, startTime: '20' },
    100: { ppid: 1, startTime: '10' },
};
const readProcess = (pid: number): ProcessInfo | null => TABLE[pid] ?? null;
const noTmux = () => ({ status: 1, stdout: '' });

beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-dispatcher-'));
});

afterEach(() => {
    fs.removeSync(sessionsDir);
});

describe('resolveDispatcher', () => {
    it('ancestor hit: nearest Claude session with a socket wins over inherited env', () => {
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        const got = resolveDispatcher({
            startPid: 300, sessionsDir, readProcess,
            env: { XTRM_DISPATCHER_NAME: 'grand', XTRM_DISPATCHER_ADDRESS: 'uds:/run/cc/1.sock' },
        });
        expect(got).toEqual({ name: 'coord', address: 'uds:/run/cc/100.sock' });
    });

    it('nested dispatch names the nearest dispatcher', () => {
        writeSession(100, { name: 'grand', messagingSocketPath: '/run/cc/100.sock' });
        writeSession(200, { name: 'near', messagingSocketPath: '/run/cc/200.sock' });
        expect(resolveDispatcher({ startPid: 300, sessionsDir, readProcess, env: {} }).name).toBe('near');
    });

    it('skips entries without a socket, with a reused pid or a stale procStart', () => {
        writeSession(200, { name: 'no-socket' });
        writeSession(100, { name: 'stale', messagingSocketPath: '/run/cc/100.sock', procStart: '999' });
        expect(resolveDispatcher({ startPid: 300, sessionsDir, readProcess, env: {} })).toEqual({});
        fs.writeJsonSync(path.join(sessionsDir, '100.json'), { pid: 4242, name: 'reused', messagingSocketPath: '/x.sock' });
        expect(resolveDispatcher({ startPid: 300, sessionsDir, readProcess, env: {} })).toEqual({});
    });

    it('a Pi dispatcher registered by pi-claude-link (date-string procStart) resolves', () => {
        writeSession(200, {
            name: 'pi-coord', messagingSocketPath: '/run/cc/200.sock',
            procStart: 'Thu Oct 15 19:40:44 2026', entrypoint: 'pi', version: 'pi-claude-link',
        });
        writeSession(100, { name: 'grand', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        expect(resolveDispatcher({ startPid: 300, sessionsDir, readProcess, env: {} }))
            .toEqual({ name: 'pi-coord', address: 'uds:/run/cc/200.sock' });
    });

    it('no ancestor: falls back to inherited XTRM_DISPATCHER_*', () => {
        expect(resolveDispatcher({
            startPid: 300, sessionsDir, readProcess,
            env: { XTRM_DISPATCHER_NAME: 'coord', XTRM_DISPATCHER_ADDRESS: 'uds:/run/cc/9.sock' },
        })).toEqual({ name: 'coord', address: 'uds:/run/cc/9.sock' });
    });

    it('no ancestor and no env: everything absent', () => {
        expect(resolveDispatcher({ startPid: 300, sessionsDir, readProcess, env: {} })).toEqual({});
        expect(resolveDispatcher({ startPid: 300, sessionsDir, readProcess, env: { XTRM_DISPATCHER_NAME: '  ' } })).toEqual({});
    });

    it('fails soft when the process table throws', () => {
        const throwing = () => { throw new Error('boom'); };
        expect(resolveDispatcher({ startPid: 300, sessionsDir, readProcess: throwing, env: {} })).toEqual({});
    });
});

describe('buildDispatcherEnv', () => {
    it('no ancestor, no env, no tmux: only the holder', () => {
        expect(buildDispatcherEnv('worker-a', { startPid: 300, sessionsDir, readProcess, env: {}, tmux: noTmux }))
            .toEqual({ SUBSTRATE_HOLDER: 'worker-a' });
        expect(buildDispatcherEnv('', { startPid: 300, sessionsDir, readProcess, env: {}, tmux: noTmux })).toEqual({});
    });

    it('holder is the worker name, never an inherited SUBSTRATE_HOLDER', () => {
        const env = { SUBSTRATE_HOLDER: 'dispatcher-self', XTRM_PARENT_PANE_ID: '%1' };
        const out = buildDispatcherEnv('worker-a', { startPid: 300, sessionsDir, readProcess, env, tmux: noTmux });
        expect(out.SUBSTRATE_HOLDER).toBe('worker-a');
        const merged = { ...stripDispatcherEnv(env), ...out };
        expect(merged.SUBSTRATE_HOLDER).toBe('worker-a');
        expect(merged.XTRM_PARENT_PANE_ID).toBeUndefined();
    });

    it('full identity: dispatcher, address, parent pane and session', () => {
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock' });
        const calls: string[][] = [];
        const out = buildDispatcherEnv('worker-a', {
            startPid: 300, sessionsDir, readProcess,
            env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%5' },
            tmux: (args) => { calls.push(args); return { status: 0, stdout: '$2\n' }; },
        });
        expect(out).toEqual({
            SUBSTRATE_HOLDER: 'worker-a',
            XTRM_DISPATCHER_NAME: 'coord',
            XTRM_DISPATCHER_ADDRESS: 'uds:/run/cc/100.sock',
            XTRM_PARENT_PANE_ID: '%5',
            XTRM_PARENT_SESSION_ID: '$2',
        });
        expect(calls).toEqual([['display-message', '-p', '-t', '%5', '-F', '#{session_id}']]);
    });

    it('tmux that cannot answer leaves the parent session absent; no TMUX leaves both absent', () => {
        const base = { startPid: 300, sessionsDir, readProcess };
        const pane = buildDispatcherEnv('w', { ...base, env: { TMUX: 't', TMUX_PANE: '%5' }, tmux: noTmux });
        expect(pane.XTRM_PARENT_PANE_ID).toBe('%5');
        expect('XTRM_PARENT_SESSION_ID' in pane).toBe(false);
        const none = buildDispatcherEnv('w', { ...base, env: { TMUX_PANE: '%5' }, tmux: () => ({ status: 0, stdout: '$2' }) });
        expect(Object.keys(none)).toEqual(['SUBSTRATE_HOLDER']);
    });
});
