import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    buildDispatcherEnv,
    isDispatcherAddress,
    resolveDispatcher,
    resolveDispatcherByParticipant,
    resolveDispatcherReport,
    resolveDispatcherResolution,
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

    it('a Pi dispatcher entry with a legacy date-string procStart still resolves when the host cannot convert it', () => {
        // Pre-M1 writers recorded a `ps lstart` date string instead of numeric
        // ticks. CORE-2726 compares it through boot time + CLK_TCK when that is
        // readable; when it is not, the entry is kept (unknown, not stale) and
        // the pid match has to do.
        writeSession(200, {
            name: 'pi-coord', messagingSocketPath: '/run/cc/200.sock',
            procStart: 'Thu Oct 15 19:40:44 2026', entrypoint: 'pi', version: 'intercom 1.4.0',
        });
        writeSession(100, { name: 'grand', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        expect(resolveDispatcher({ startPid: 300, sessionsDir, readProcess, bootTime: () => null, env: {} }))
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
            .toEqual({ SUBSTRATE_HOLDER: 'worker-a', XTRM_MERGE_GUARD: 'on' });
        // An empty holder still carries the guard default: every launched agent gets it.
        expect(buildDispatcherEnv('', { startPid: 300, sessionsDir, readProcess, env: {}, tmux: noTmux })).toEqual({ XTRM_MERGE_GUARD: 'on' });
    });

    it('turns the merge guard on by default and never overrides an inherited value', () => {
        expect(buildDispatcherEnv('w', { env: {} }).XTRM_MERGE_GUARD).toBe('on');
        // CORE-2528 review: an inherited value is forwarded, not dropped — the pane
        // only sees what the launcher puts on the -e list.
        expect(buildDispatcherEnv('w', { env: { XTRM_MERGE_GUARD: 'off' } }).XTRM_MERGE_GUARD).toBe('off');
        expect(buildDispatcherEnv('w', { env: { XTRM_MERGE_GUARD: 'yes' } }).XTRM_MERGE_GUARD).toBe('yes');
    });

    it('holder is the worker name, never an inherited SUBSTRATE_HOLDER', () => {
        const env = { SUBSTRATE_HOLDER: 'dispatcher-self', XTRM_PARENT_PANE_ID: '%1' };
        const out = buildDispatcherEnv('worker-a', { startPid: 300, sessionsDir, readProcess, env, tmux: noTmux });
        expect(out.SUBSTRATE_HOLDER).toBe('worker-a');
        const merged = { ...stripDispatcherEnv(env), ...out };
        expect(merged.SUBSTRATE_HOLDER).toBe('worker-a');
        expect(merged.XTRM_PARENT_PANE_ID).toBeUndefined();
    });

    it('exports XTRM_AGENT_NAME next to the holder, and strips an inherited one (CORE-2606)', () => {
        const env = { XTRM_AGENT_NAME: 'parent-xt-pi-self' };
        expect(stripDispatcherEnv(env).XTRM_AGENT_NAME).toBeUndefined();
        const out = buildDispatcherEnv('worker-a', {
            startPid: 300, sessionsDir, readProcess, env, tmux: noTmux, agentName: 'core-xt-pi-worker-a',
        });
        expect(out).toMatchObject({ SUBSTRATE_HOLDER: 'worker-a', XTRM_AGENT_NAME: 'core-xt-pi-worker-a' });
        // No name computed means no key at all, never an empty string.
        expect(buildDispatcherEnv('worker-a', { startPid: 300, sessionsDir, readProcess, env: {}, tmux: noTmux }))
            .not.toHaveProperty('XTRM_AGENT_NAME');
    });

    it('collapses a multi-line agent name to one line', () => {
        const out = buildDispatcherEnv('worker-a', {
            startPid: 300, sessionsDir, readProcess, env: {}, tmux: noTmux, agentName: 'core\nxt\tpi  worker-a',
        });
        expect(out.XTRM_AGENT_NAME).toBe('core xt pi worker-a');
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
            XTRM_MERGE_GUARD: 'on',
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
        expect(Object.keys(none).sort()).toEqual(['SUBSTRATE_HOLDER', 'XTRM_MERGE_GUARD']);
    });
});

// CORE-2726 (D5) + the dispatcher report behind `xt identity dispatcher`.
// The walk stops at the nearest AGENT ancestor even when it publishes no
// messaging socket, and a Pi entry written with a `ps lstart` date string is
// guarded against pid reuse through boot time + CLK_TCK.

// worker xt (pid 300, bash) <- pi lead (pid 200, no socket) <- claude (pid 100, socket)
const AGENT_TABLE: Record<number, ProcessInfo> = {
    300: { ppid: 200, startTime: '30', comm: 'bash' },
    200: { ppid: 100, startTime: '20', comm: 'pi' },
    100: { ppid: 1, startTime: '10', comm: 'claude' },
};
const readAgentProcess = (pid: number): ProcessInfo | null => AGENT_TABLE[pid] ?? null;
const readEnvironOf = (table: Record<number, Record<string, string>>) =>
    (pid: number): NodeJS.ProcessEnv | null => table[pid] ?? null;

const STALE_ENV = { XTRM_DISPATCHER_NAME: 'stale', XTRM_DISPATCHER_ADDRESS: 'uds:/run/cc/stale.sock' };

describe('resolveDispatcher D5: an agent ancestor without a socket', () => {
    it('takes the Pi lead, not the socketed grandparent and not the inherited value', () => {
        writeSession(100, { name: 'grand', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        const readEnviron = readEnvironOf({ 200: { SUBSTRATE_HOLDER: 'pi-lead' } });
        // The env projection names the Pi lead and carries no address.
        expect(resolveDispatcher({ startPid: 300, sessionsDir, readProcess: readAgentProcess, readEnviron, env: STALE_ENV }))
            .toEqual({ name: 'pi-lead' });
    });

    it('reports the participant, the pid and the skipped socket in the resolution', () => {
        writeSession(100, { name: 'grand', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        const report = resolveDispatcherResolution({
            startPid: 300, sessionsDir, readProcess: readAgentProcess,
            readEnviron: readEnvironOf({ 200: { SUBSTRATE_HOLDER: 'pi-lead' } }),
            env: STALE_ENV,
        });
        expect(report).toEqual({
            name: 'pi-lead',
            participant: 'pi-lead',
            source: 'ancestor',
            pid: 200,
            procStartChecked: false,
            skipped: [{ pid: 200, reason: 'agent ancestor without a messaging socket' }],
        });
        expect(report.address).toBeUndefined();
    });

    it('keeps an unreadable environment absent instead of guessing', () => {
        writeSession(100, { name: 'grand', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        const report = resolveDispatcherResolution({
            startPid: 300, sessionsDir, readProcess: readAgentProcess,
            readEnviron: () => null, env: STALE_ENV,
        });
        expect(report.participant).toBeUndefined();
        expect(report.address).toBeUndefined();
        expect(report.source).toBe('ancestor');
        expect(report.skipped).toEqual([{ pid: 200, reason: 'agent ancestor without a messaging socket' }]);
        // Nothing to project: no name, no address — never the grandparent's.
        expect(resolveDispatcher({ startPid: 300, sessionsDir, readProcess: readAgentProcess, readEnviron: () => null, env: STALE_ENV }))
            .toEqual({});
    });

    it('still walks past a non-agent ancestor to the nearest socket', () => {
        const table: Record<number, ProcessInfo> = {
            300: { ppid: 200, startTime: '30', comm: 'bash' },
            200: { ppid: 100, startTime: '20', comm: 'bun' },
            100: { ppid: 1, startTime: '10', comm: 'claude' },
        };
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        expect(resolveDispatcher({ startPid: 300, sessionsDir, readProcess: (pid) => table[pid] ?? null, env: {} }))
            .toEqual({ name: 'coord', address: 'uds:/run/cc/100.sock' });
    });

    it('an agent ancestor with a socket keeps its address and gains the participant', () => {
        writeSession(200, { name: 'pi-coord', messagingSocketPath: '/run/cc/200.sock', procStart: '20', sessionId: 'sess-2' });
        writeSession(100, { name: 'grand', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        expect(resolveDispatcherResolution({
            startPid: 300, sessionsDir, readProcess: readAgentProcess,
            readEnviron: readEnvironOf({ 200: { SUBSTRATE_HOLDER: 'pi-coord' } }), env: {},
        })).toEqual({
            name: 'pi-coord',
            participant: 'pi-coord',
            address: 'uds:/run/cc/200.sock',
            source: 'ancestor',
            pid: 200,
            sessionId: 'sess-2',
            procStartChecked: true,
            skipped: [],
        });
    });

    it('a stale entry on an agent pid names nobody: the participant alone is taken', () => {
        // The file says pid 4242 (reused), yet the live process 200 is a Pi lead.
        fs.writeJsonSync(path.join(sessionsDir, '200.json'), { pid: 4242, name: 'stale-name', messagingSocketPath: '/x.sock' });
        const report = resolveDispatcherResolution({
            startPid: 300, sessionsDir, readProcess: readAgentProcess,
            readEnviron: readEnvironOf({ 200: { SUBSTRATE_HOLDER: 'pi-lead' } }), env: {},
        });
        expect(report).toMatchObject({ participant: 'pi-lead', name: 'pi-lead', source: 'ancestor', pid: 200 });
        expect(report.address).toBeUndefined();
        expect(report.skipped).toEqual([
            { pid: 200, reason: 'pid reused: the registry entry names another pid' },
            { pid: 200, reason: 'agent ancestor without a messaging socket' },
        ]);
    });

    it('buildDispatcherEnv follows D5: the Pi lead name, no address', () => {
        writeSession(100, { name: 'grand', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        expect(buildDispatcherEnv('worker-a', {
            startPid: 300, sessionsDir, readProcess: readAgentProcess,
            readEnviron: readEnvironOf({ 200: { SUBSTRATE_HOLDER: 'pi-lead' } }), env: {}, tmux: noTmux,
        })).toEqual({
            SUBSTRATE_HOLDER: 'worker-a',
            XTRM_MERGE_GUARD: 'on',
            XTRM_DISPATCHER_NAME: 'pi-lead',
        });
    });
});

describe('Pi registry entries and the pid-reuse guard', () => {
    // Both live start times below are ticks of 100/s counted from a btime of 1_000_000 s.
    const bootTime = () => 1_000_000;
    const clockTicks = () => 100;
    const liveStartEpoch = (ticks: number): number => 1_000_000 + ticks / 100;

    function psLstart(epochSeconds: number): string {
        const date = new Date(epochSeconds * 1000);
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const pad = (value: number): string => String(value).padStart(2, '0');
        return `${days[date.getDay()]} ${months[date.getMonth()]} ${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getFullYear()}`;
    }

    // worker xt (150) <- pi lead (120): 120 starts at tick 2000.
    const table: Record<number, ProcessInfo> = {
        150: { ppid: 120, startTime: '3000', comm: 'bash' },
        120: { ppid: 1, startTime: '2000', comm: 'pi' },
    };
    // Built per test: `sessionsDir` is a fresh temp dir in every beforeEach.
    const piDeps = (overrides: Record<string, unknown> = {}): Parameters<typeof resolveDispatcher>[0] => ({
        startPid: 150, sessionsDir, readProcess: (pid: number): ProcessInfo | null => table[pid] ?? null,
        bootTime, clockTicks, env: {}, ...overrides,
    });

    it('rejects a Pi entry whose lstart disagrees with the live start time', () => {
        writeSession(120, {
            name: 'pi-coord', messagingSocketPath: '/run/cc/120.sock',
            entrypoint: 'pi', procStart: psLstart(liveStartEpoch(2000) + 5_000),
        });
        // pid reuse: the entry is rejected and reported, so nothing resolves. The
        // live process 120 is a Pi lead with no readable env, so no participant either.
        expect(resolveDispatcher(piDeps())).toEqual({});
        const report = resolveDispatcherResolution(piDeps());
        expect(report.source).toBe('ancestor');
        expect(report.address).toBeUndefined();
        expect(report.procStartChecked).toBe(true);
        expect(report.skipped.map((skip) => skip.reason)).toContain('pid reused: procStart disagrees with the live process start time');
    });

    it('accepts a Pi entry whose lstart agrees, and reports the check as done', () => {
        writeSession(120, {
            name: 'pi-coord', messagingSocketPath: '/run/cc/120.sock',
            entrypoint: 'pi', procStart: psLstart(liveStartEpoch(2000)),
        });
        expect(resolveDispatcher(piDeps())).toEqual({ name: 'pi-coord', address: 'uds:/run/cc/120.sock' });
        expect(resolveDispatcherResolution(piDeps()).procStartChecked).toBe(true);
    });

    it('keeps a Pi entry the host cannot convert, and reports procStartChecked: false', () => {
        writeSession(120, {
            name: 'pi-coord', messagingSocketPath: '/run/cc/120.sock',
            entrypoint: 'pi', procStart: psLstart(liveStartEpoch(2000) + 5_000),
        });
        const unconvertible = resolveDispatcherResolution(piDeps({ bootTime: () => null }));
        expect(unconvertible).toMatchObject({ name: 'pi-coord', source: 'ancestor', pid: 120, procStartChecked: false });
    });

    it('an injected null CLK_TCK is unknown, never a guessed 100', () => {
        // CORE-2726 fix 2: the ticks used to default to 100, which would silently
        // mis-date every conversion on a host that answers something else.
        writeSession(120, {
            name: 'pi-coord', messagingSocketPath: '/run/cc/120.sock',
            entrypoint: 'pi', procStart: psLstart(liveStartEpoch(2000) + 5_000),
        });
        const unknownTicks = resolveDispatcherResolution(piDeps({ clockTicks: () => null }));
        expect(unknownTicks).toMatchObject({ name: 'pi-coord', source: 'ancestor', pid: 120, procStartChecked: false });
    });

    it('the REAL default (getconf unreadable) reports unchecked, not a guessed 100', () => {
        // CORE-2726 fix round 2 (reviewer finding 1): the injected-null case above
        // passes even when clockTicksPerSecond guesses 100, so this one exercises
        // the module's own default — no clockTicks dep — with `getconf` made
        // unrunnable by an empty PATH. The boot time stays injected so the fixture
        // is deterministic; that is the only dep this test pins.
        //   fixed: getconf fails -> clockTicksPerSecond() null -> procStartChecked false
        //   reverted (return 100): the conversion happens, the fixture's exact
        //   lstart agrees, and the report says procStartChecked true -> red.
        writeSession(120, {
            name: 'pi-coord', messagingSocketPath: '/run/cc/120.sock',
            entrypoint: 'pi', procStart: psLstart(liveStartEpoch(2000)),
        });
        const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-no-getconf-'));
        const realPath = process.env.PATH;
        try {
            process.env.PATH = emptyBin;
            const report = resolveDispatcherResolution(piDeps({ clockTicks: undefined }));
            // The entry is live and resolves; only the start-time check is unknown.
            expect(report).toMatchObject({ name: 'pi-coord', address: 'uds:/run/cc/120.sock', source: 'ancestor', pid: 120, procStartChecked: false });
        } finally {
            process.env.PATH = realPath;
            fs.removeSync(emptyBin);
        }
    });

    it('a time-zone difference between the writer and the reader never rejects a live entry', () => {
        // CORE-2726 fix 1 (option B): the writer formatted the lstart in its own
        // zone, the reader parses it in its own. Every real offset and DST step is
        // a whole number of quarter hours, so a live entry must survive it. This
        // fixture is one hour off; on the pre-fix code it was rejected as a reused
        // pid.
        writeSession(120, {
            name: 'pi-coord', messagingSocketPath: '/run/cc/120.sock',
            entrypoint: 'pi', procStart: psLstart(liveStartEpoch(2000) + 3_600),
        });
        expect(resolveDispatcher(piDeps())).toEqual({ name: 'pi-coord', address: 'uds:/run/cc/120.sock' });
        expect(resolveDispatcherResolution(piDeps())).toMatchObject({ source: 'ancestor', pid: 120, procStartChecked: true, skipped: [] });
    });

    it('a half-hour zone offset is tolerated too, and a non-quarter-hour drift is still reuse', () => {
        // The half-hour zones (UTC+05:30, +05:45, ...) and a 30-minute DST step.
        writeSession(120, {
            name: 'pi-coord', messagingSocketPath: '/run/cc/120.sock',
            entrypoint: 'pi', procStart: psLstart(liveStartEpoch(2000) + 1_800),
        });
        expect(resolveDispatcher(piDeps())).toEqual({ name: 'pi-coord', address: 'uds:/run/cc/120.sock' });
        // 9 hours and 60 seconds is not a zone offset: still a different process.
        writeSession(120, {
            name: 'reused', messagingSocketPath: '/run/cc/120.sock',
            entrypoint: 'pi', procStart: psLstart(liveStartEpoch(2000) + 9 * 3_600 + 60),
        });
        expect(resolveDispatcher(piDeps())).not.toEqual({ name: 'reused', address: 'uds:/run/cc/120.sock' });
    });
});

describe('findLiveDispatchers shares one boot-time and ticks reading', () => {
    // worker xt (150) <- nothing; two live registry entries under one name.
    const allAlive = (pid: number): ProcessInfo | null => ({ ppid: 1, startTime: pid === 100 ? '2000' : '3000', comm: 'pi' });

    it('reads the boot time and the clock ticks once per lookup, not once per file', () => {
        // CORE-2726 fix 6: getconf is a spawn, and the answer is a property of the
        // host, so one reading serves every registry file in the same call.
        const boot = () => 1_000_000;
        const liveEpoch = (ticks: number): number => 1_000_000 + ticks / 100;
        const stamp = (epochSeconds: number): string => {
            const date = new Date(epochSeconds * 1000);
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const pad = (value: number): string => String(value).padStart(2, '0');
            return `${days[date.getDay()]} ${months[date.getMonth()]} ${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getFullYear()}`;
        };
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock', entrypoint: 'pi', procStart: stamp(liveEpoch(2000)) });
        writeSession(200, { name: 'coord', messagingSocketPath: '/run/cc/200.sock', entrypoint: 'pi', procStart: stamp(liveEpoch(3000)) });
        let boots = 0;
        let ticks = 0;
        expect(() => resolveDispatcherByParticipant('coord', {
            sessionsDir,
            readProcess: allAlive,
            bootTime: () => { boots += 1; return boot(); },
            clockTicks: () => { ticks += 1; return 100; },
        })).toThrow(/ambiguous dispatcher participant "coord"/);
        // Both entries reach the start check (they agree, so the ambiguity is real),
        // and one reading served both.
        expect(boots).toBe(1);
        expect(ticks).toBe(1);
    });
});

describe('resolveDispatcherReport: the answer `xt identity dispatcher` prints', () => {
    it('--pid is inclusive: the walk starts at and tests that pid', () => {
        writeSession(300, { name: 'self-dispatch', messagingSocketPath: '/run/cc/300.sock', procStart: '30' });
        expect(resolveDispatcherReport({ pid: 300 }, { sessionsDir, readProcess, env: {} })).toMatchObject({
            name: 'self-dispatch', address: 'uds:/run/cc/300.sock', source: 'ancestor', pid: 300,
        });
    });

    it('explicit flags outrank the ancestor walk', () => {
        writeSession(100, { name: 'coord', messagingSocketPath: '/run/cc/100.sock', procStart: '10' });
        expect(resolveDispatcherReport(
            { pid: 300, participant: 'lead-a', address: 'activation:act:3bb0e173' },
            { sessionsDir, readProcess, env: {} },
        )).toEqual({ participant: 'lead-a', address: 'activation:act:3bb0e173', source: 'explicit', procStartChecked: false, skipped: [] });
    });

    it('accepts only uds: and activation: as an explicit address scheme', () => {
        expect(isDispatcherAddress('uds:/run/cc/1.sock')).toBe(true);
        expect(isDispatcherAddress('activation:act:3bb0e173-52a')).toBe(true);
        expect(isDispatcherAddress('uds:')).toBe(false);
        expect(isDispatcherAddress('activation:')).toBe(false);
        expect(isDispatcherAddress('/run/cc/1.sock')).toBe(false);
        expect(isDispatcherAddress('http://example/sock')).toBe(false);
    });

    it('inherit: false returns none even with a stale inherited value set', () => {
        expect(resolveDispatcherReport({ inherit: false }, {
            startPid: 300, sessionsDir, readProcess, env: { ...STALE_ENV },
        })).toEqual({ source: 'none', procStartChecked: false, skipped: [] });
    });

    it('inherits the stale env value only when inherit is left on', () => {
        expect(resolveDispatcherReport({}, { startPid: 300, sessionsDir, readProcess, env: { ...STALE_ENV } })).toEqual({
            name: 'stale', address: 'uds:/run/cc/stale.sock', source: 'inherited', procStartChecked: false, skipped: [],
        });
    });

    it('an ancestor reports its SUBSTRATE_HOLDER as the participant, its name as display only', () => {
        writeSession(100, { name: 'core-xt-claude-g04z', messagingSocketPath: '/run/cc/100.sock', procStart: '10', sessionId: 'sess-1' });
        expect(resolveDispatcherReport({ pid: 300 }, {
            sessionsDir, readProcess,
            readEnviron: readEnvironOf({ 100: { SUBSTRATE_HOLDER: 'g04z' } }), env: {},
        })).toEqual({
            participant: 'g04z',
            name: 'core-xt-claude-g04z',
            address: 'uds:/run/cc/100.sock',
            source: 'ancestor',
            pid: 100,
            sessionId: 'sess-1',
            procStartChecked: true,
            skipped: [],
        });
    });
});
