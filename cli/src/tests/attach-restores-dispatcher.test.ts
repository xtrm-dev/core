// CORE-2728 (D8, operator decision b): a launch records WHO dispatched it on the
// Substrate ExecutionBinding, and `xt attach` restores that ORIGINAL dispatcher —
// never the attacher's inherited identity. Hermetic: a stubbed `sb`, a temp
// session registry and an injected process table.

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    XTRM_DISPATCHER_ADDRESS_VAR,
    XTRM_DISPATCHER_NAME_VAR,
    XTRM_DISPATCHER_PARTICIPANT_VAR,
    attachDispatcherEnv,
    buildDispatcherEnvWithResolution,
    parseDispatcherBindings,
    readDispatcherBinding,
    recordDispatcherBinding,
    refreshDispatcherEnv,
    refreshDispatcherEnvByParticipant,
    resolveDispatcherSessionForParticipant,
    type DispatcherIdentityDeps,
    type DispatcherResolution,
    type ProcessInfo,
    type SbRunner,
} from '../core/dispatcher-identity.js';
import { resolveWorkerIssueRef } from '../commands/attach.js';

const CLAUDE_SESSION = '01a1ec56-3da4-77fb-aed5-c6dee5eb40ce';

/** A resolution with the fields a record call ignores left at their defaults. */
function resolution(over: Partial<DispatcherResolution> = {}): DispatcherResolution {
    return { source: 'ancestor', procStartChecked: false, skipped: [], ...over };
}

let sessionsDir = '';
const roots: string[] = [];

function writeSession(pid: number, entry: Record<string, unknown>): void {
    fs.writeJsonSync(path.join(sessionsDir, `${pid}.json`), { pid, ...entry });
}

beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-d8-registry-'));
});

afterEach(() => {
    fs.removeSync(sessionsDir);
    for (const root of roots.splice(0)) fs.removeSync(root);
});

/** A trace answer in the real sb envelope shape, newest binding last. */
function traceStdout(bindings: Array<Record<string, unknown>>): string {
    return JSON.stringify({ schema: 'substrate-cli/v1', command: 'provenance.trace', ok: true, data: { bindings } });
}

/** Identity deps: a live dispatcher session owned by `holder`, name and holder differing. */
function liveDispatcher(holder: string, over: { name?: string; socket?: string; pid?: number } = {}): DispatcherIdentityDeps {
    const pid = over.pid ?? 100;
    writeSession(pid, {
        name: over.name ?? 'g04z-lead',
        messagingSocketPath: over.socket ?? '/run/cc/100.sock',
        sessionId: CLAUDE_SESSION,
    });
    return {
        sessionsDir,
        readProcess: (_pid: number): ProcessInfo | null => ({ ppid: 1 }),
        readEnviron: (want: number): NodeJS.ProcessEnv | null => (want === pid ? { SUBSTRATE_HOLDER: holder } : null),
        env: {},
    };
}

describe('recordDispatcherBinding: the launch writes who dispatched it (CORE-2728)', () => {
    it('passes the dispatcher participant and its Claude session id, plus the workspace', () => {
        const calls: string[][] = [];
        const run: SbRunner = (args) => {
            calls.push(args);
            return { ok: true, stdout: '' };
        };
        const written = recordDispatcherBinding({
            ref: 'CORE-2728',
            resolution: resolution({ participant: 'g04z', sessionId: CLAUDE_SESSION, procStartChecked: true }),
            workspace: '/repo/.xtrm/worktrees/core-xt-pi-worker',
            env: {},
            run,
        });
        expect(written).toEqual({
            argv: [
                'provenance', 'dispatch', 'CORE-2728',
                '--dispatcher-participant', 'g04z',
                '--dispatcher-session', CLAUDE_SESSION,
                '--workspace', '/repo/.xtrm/worktrees/core-xt-pi-worker',
            ],
            written: true,
        });
        expect(calls).toEqual([written.argv]);
    });

    it('unknown stays absent: no participant and no session means no dispatcher flag', () => {
        const calls: string[][] = [];
        const run: SbRunner = (args) => {
            calls.push(args);
            return { ok: true, stdout: '' };
        };
        const written = recordDispatcherBinding({
            ref: 'CORE-2728',
            resolution: resolution({ source: 'none' }),
            env: {},
            run,
        });
        expect(written.written).toBe(true);
        expect(written.argv).toEqual(['provenance', 'dispatch', 'CORE-2728']);
        expect(calls[0]).not.toContain('--dispatcher-participant');
        expect(calls[0]).not.toContain('--dispatcher-session');
    });

    it('a session that is not a lowercase UUID is never passed (and never defaulted from env)', () => {
        const written = recordDispatcherBinding({
            ref: 'CORE-2728',
            resolution: resolution({ participant: 'g04z', sessionId: '$42' }),
            // An inherited value of the same name must not be read for the session.
            env: { XTRM_PARENT_SESSION_ID: '$42', XTRM_SESSION_ID: '$42' },
            run: () => ({ ok: true, stdout: '' }),
        });
        expect(written.argv).toContain('--dispatcher-participant');
        expect(written.argv).not.toContain('--dispatcher-session');
    });

    it('a failed sb is one warning and never a failed launch', () => {
        const written = recordDispatcherBinding({
            ref: 'CORE-2728',
            resolution: resolution({ participant: 'g04z' }),
            env: {},
            run: () => ({ ok: false, error: 'sb exited 1: no store' }),
        });
        expect(written.written).toBe(false);
        expect(written.warning).toMatch(/^xt: could not record the dispatcher on CORE-2728 \(launch continues\): sb exited 1: no store\n$/);
        // A runner that throws is the same single warning, not an exception.
        const thrown = recordDispatcherBinding({
            ref: 'CORE-2728',
            resolution: resolution({ participant: 'g04z' }),
            env: {},
            run: () => {
                throw new Error('sb is not installed');
            },
        });
        expect(thrown.written).toBe(false);
        expect(thrown.warning).toContain('sb is not installed');
    });

    it('a resolution with a label sb would refuse passes no participant', () => {
        const written = recordDispatcherBinding({
            ref: 'CORE-2728',
            resolution: resolution({ participant: 'not a label' }),
            env: {},
            run: () => ({ ok: true, stdout: '' }),
        });
        expect(written.argv).toEqual(['provenance', 'dispatch', 'CORE-2728']);
    });

    it('the launch env and the recorded binding come from one resolution', () => {
        const deps = liveDispatcher('g04z');
        // worker xt (pid 300) <- shell 200 <- claude dispatcher 100
        const resolutionDeps: DispatcherIdentityDeps = {
            ...deps,
            startPid: 300,
            readProcess: (pid: number): ProcessInfo | null => ({
                300: { ppid: 200 },
                200: { ppid: 100 },
                100: { ppid: 1 },
            }[pid] ?? null),
        };
        const built = buildDispatcherEnvWithResolution('worker', resolutionDeps);
        expect(built.env[XTRM_DISPATCHER_PARTICIPANT_VAR]).toBe('g04z');
        expect(built.resolution.sessionId).toBe(CLAUDE_SESSION);
        expect(built.resolution.participant).toBe('g04z');
    });
});

describe('the binding a launch recorded (CORE-2728)', () => {
    it('parses the newest binding that names a dispatcher, skipping the ones that do not', () => {
        const parsed = parseDispatcherBindings(traceStdout([
            { id: 'b1', dispatcherParticipantId: 'old-lead', dispatcherSessionId: null, createdAt: 100 },
            { id: 'b2', dispatcherParticipantId: null, dispatcherSessionId: null, createdAt: 300 },
            { id: 'b3', dispatcherParticipantId: 'g04z', dispatcherSessionId: CLAUDE_SESSION, createdAt: 200 },
        ]));
        expect(parsed).toEqual([
            { participant: 'g04z', sessionId: CLAUDE_SESSION },
            { participant: 'old-lead' },
        ]);
        expect(parseDispatcherBindings('not json')).toEqual([]);
        expect(parseDispatcherBindings(JSON.stringify({ ok: true, data: { bindings: 'x' } }))).toEqual([]);
    });

    it('accepts an ISO createdAt, prefers it over an older integer, and dates a missing one oldest', () => {
        // sb 0.4.0 emits an integer epoch in ms; the schema never promised a wire
        // type, so an ISO string must order correctly instead of counting as oldest.
        const parsed = parseDispatcherBindings(traceStdout([
            { id: 'b-old', dispatcherParticipantId: 'old-lead', createdAt: 100 },
            { id: 'b-new', dispatcherParticipantId: 'iso-lead', createdAt: '2026-11-18T01:00:00.000Z' },
            { id: 'b-none', dispatcherParticipantId: 'undated-lead' },
        ]));
        expect(parsed.map((row) => row.participant)).toEqual(['iso-lead', 'old-lead', 'undated-lead']);
    });

    it('breaks a createdAt tie on the binding id, newest uuidv7 first, deterministically', () => {
        const rows = [
            { id: 'exb_01a1ec56-0000-7000-8000-000000000001', dispatcherParticipantId: 'older-lex', createdAt: 500 },
            { id: 'exb_01a1ec9f-0000-7000-8000-000000000002', dispatcherParticipantId: 'newer-lex', createdAt: 500 },
        ];
        // Both orders of input give the same answer: the store's row order never decides.
        expect(parseDispatcherBindings(traceStdout(rows)).map((r) => r.participant)).toEqual(['newer-lex', 'older-lex']);
        expect(parseDispatcherBindings(traceStdout([...rows].reverse())).map((r) => r.participant)).toEqual(['newer-lex', 'older-lex']);
        // Same instant in the two wire forms is a tie too.
        expect(parseDispatcherBindings(traceStdout([
            { id: 'exb_02', dispatcherParticipantId: 'integer', createdAt: Date.parse('2026-11-18T01:00:00.000Z') },
            { id: 'exb_01', dispatcherParticipantId: 'string', createdAt: '2026-11-18T01:00:00.000Z' },
        ])).map((r) => r.participant)).toEqual(['integer', 'string']);
    });

    it('reads the binding through a stubbed `sb provenance trace`', () => {
        const calls: string[][] = [];
        const run: SbRunner = (args) => {
            calls.push(args);
            return { ok: true, stdout: traceStdout([{ dispatcherParticipantId: 'g04z', createdAt: 1 }]) };
        };
        expect(readDispatcherBinding('CORE-2728', { run, env: {} })).toEqual({ participant: 'g04z' });
        expect(calls).toEqual([['provenance', 'trace', 'CORE-2728', '--json']]);
        expect(readDispatcherBinding('CORE-2728', { run: () => ({ ok: false, error: 'no store' }), env: {} })).toBeNull();
        expect(readDispatcherBinding(null, { run })).toBeNull();
    });
});

describe('xt attach restores the ORIGINAL dispatcher (CORE-2728)', () => {
    it('keeps the participant from the binding and finds the live session by SUBSTRATE_HOLDER', () => {
        const identity = liveDispatcher('g04z', { name: 'g04z-lead', socket: '/run/cc/100.sock' });
        const env = attachDispatcherEnv('CORE-2728', {
            env: {},
            run: () => ({ ok: true, stdout: traceStdout([{ dispatcherParticipantId: 'g04z', createdAt: 1 }]) }),
            identity,
        });
        // The participant was read from the trace; the address comes from the live
        // session whose PROCESS holds that participant — not from its display name.
        expect(env).toEqual({
            [XTRM_DISPATCHER_PARTICIPANT_VAR]: 'g04z',
            [XTRM_DISPATCHER_NAME_VAR]: 'g04z-lead',
            [XTRM_DISPATCHER_ADDRESS_VAR]: 'uds:/run/cc/100.sock',
        });
    });

    it('a different lead attaching keeps the original participant, never its own', () => {
        const identity = liveDispatcher('g04z');
        const attacherEnv: NodeJS.ProcessEnv = {
            XTRM_DISPATCHER_PARTICIPANT: 'attacher',
            XTRM_DISPATCHER_NAME: 'attacher',
            XTRM_DISPATCHER_ADDRESS: 'uds:/run/cc/attacher.sock',
        };
        // The attacher's environment is present in the process, but the restore
        // reads the binding only.
        const env = attachDispatcherEnv('CORE-2728', {
            env: attacherEnv,
            run: () => ({ ok: true, stdout: traceStdout([{ dispatcherParticipantId: 'g04z', createdAt: 1 }]) }),
            identity,
        });
        expect(env[XTRM_DISPATCHER_PARTICIPANT_VAR]).toBe('g04z');
        expect(env[XTRM_DISPATCHER_ADDRESS_VAR]).toBe('uds:/run/cc/100.sock');
    });

    it('no binding leaves the dispatcher absent: the attacher is never adopted', () => {
        // The attacher IS resolvable here: its own env names it, the ancestor walk
        // reaches its live session (worker xt 300 <- shell 200 <- claude 100) and
        // that process holds SUBSTRATE_HOLDER=attacher. A restore that fell back to
        // any of that would adopt the attacher; the binding-only rule must not.
        const registry = liveDispatcher('attacher', { name: 'attacher', socket: '/run/cc/attacher.sock' });
        const attacherDeps: DispatcherIdentityDeps = {
            ...registry,
            startPid: 300,
            readProcess: (pid: number): ProcessInfo | null => ({
                300: { ppid: 200 },
                200: { ppid: 100 },
                100: { ppid: 1 },
            }[pid] ?? null),
            env: { XTRM_DISPATCHER_NAME: 'attacher', XTRM_DISPATCHER_ADDRESS: 'uds:/run/cc/attacher.sock' },
        };
        // Proof the trap is armed: the old, name-keyed path would name the attacher.
        expect(refreshDispatcherEnv(attacherDeps)).toEqual({
            [XTRM_DISPATCHER_NAME_VAR]: 'attacher',
            [XTRM_DISPATCHER_ADDRESS_VAR]: 'uds:/run/cc/attacher.sock',
            [XTRM_DISPATCHER_PARTICIPANT_VAR]: 'attacher',
        });
        const attacherEnv: NodeJS.ProcessEnv = {
            XTRM_DISPATCHER_PARTICIPANT: 'attacher',
            XTRM_DISPATCHER_NAME: 'attacher',
            XTRM_DISPATCHER_ADDRESS: 'uds:/run/cc/attacher.sock',
        };
        for (const stdout of [
            traceStdout([]),
            traceStdout([{ dispatcherParticipantId: null, dispatcherSessionId: null, createdAt: 5 }]),
        ]) {
            expect(attachDispatcherEnv('CORE-2728', { env: attacherEnv, run: () => ({ ok: true, stdout }), identity: attacherDeps })).toEqual({});
        }
        // An unreadable store and an unknown issue ref are the same: absent.
        expect(attachDispatcherEnv('CORE-2728', { run: () => ({ ok: false, error: 'no store' }), identity: attacherDeps })).toEqual({});
        expect(attachDispatcherEnv(null, { identity: attacherDeps })).toEqual({});
    });

    it('no live session keeps the participant and leaves the address absent', () => {
        const identity: DispatcherIdentityDeps = {
            sessionsDir,
            readProcess: (): ProcessInfo | null => null,
            readEnviron: () => null,
            env: {},
        };
        const env = attachDispatcherEnv('CORE-2728', {
            run: () => ({ ok: true, stdout: traceStdout([{ dispatcherParticipantId: 'g04z', createdAt: 1 }]) }),
            identity,
        });
        expect(env).toEqual({
            [XTRM_DISPATCHER_PARTICIPANT_VAR]: 'g04z',
            [XTRM_DISPATCHER_NAME_VAR]: 'g04z',
        });
        expect(env).not.toHaveProperty(XTRM_DISPATCHER_ADDRESS_VAR);
    });

    it('ambiguity never picks an address: the participant stays, the address is absent', () => {
        const forBoth: DispatcherIdentityDeps = {
            sessionsDir,
            readProcess: (): ProcessInfo | null => ({ ppid: 1 }),
            readEnviron: (): NodeJS.ProcessEnv | null => ({ SUBSTRATE_HOLDER: 'g04z' }),
            env: {},
        };
        writeSession(100, { name: 'one', messagingSocketPath: '/run/cc/100.sock' });
        writeSession(200, { name: 'two', messagingSocketPath: '/run/cc/200.sock' });
        const lines: string[] = [];
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
            lines.push(String(chunk));
            return true;
        }) as never);
        let env: Record<string, string>;
        try {
            env = refreshDispatcherEnvByParticipant('g04z', forBoth);
        } finally {
            spy.mockRestore();
        }
        expect(env).toEqual({
            [XTRM_DISPATCHER_PARTICIPANT_VAR]: 'g04z',
            [XTRM_DISPATCHER_NAME_VAR]: 'g04z',
        });
        expect(env).not.toHaveProperty(XTRM_DISPATCHER_ADDRESS_VAR);
        // Exactly one stderr line, naming the participant and every candidate by
        // pid and socket — never a multi-line dump.
        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line.endsWith('\n')).toBe(true);
        expect(line.trimEnd()).not.toContain('\n');
        expect(line).toContain('ambiguous live dispatcher participant "g04z"');
        expect(line).toContain('pid 100 at uds:/run/cc/100.sock');
        expect(line).toContain('pid 200 at uds:/run/cc/200.sock');
    });

    it('the dispatcher session id is the live holder session UUID, never the display name', () => {
        const identity = liveDispatcher('g04z', { name: 'g04z-lead' });
        expect(resolveDispatcherSessionForParticipant('g04z', identity)).toBe(CLAUDE_SESSION);
        expect(resolveDispatcherSessionForParticipant('g04z-lead', identity)).toBeNull();
        expect(resolveDispatcherSessionForParticipant('nobody', identity)).toBeNull();
    });

    it('CORE-2728 F5: a tmux `$N` session id is never a dispatcher session id', () => {
        const identity = liveDispatcher('g04z', { name: 'g04z-lead' });
        // Same live holder session, but its registry sessionId is a tmux id: the
        // dispatcher session stays UNKNOWN rather than storing a tmux session.
        writeSession(100, {
            name: 'g04z-lead',
            messagingSocketPath: '/run/cc/100.sock',
            sessionId: '$42',
        });
        expect(resolveDispatcherSessionForParticipant('g04z', identity)).toBeNull();
        // An uppercase UUID is not the canonical lowercase form either.
        writeSession(100, {
            name: 'g04z-lead',
            messagingSocketPath: '/run/cc/100.sock',
            sessionId: CLAUDE_SESSION.toUpperCase(),
        });
        expect(resolveDispatcherSessionForParticipant('g04z', identity)).toBeNull();
    });
});

describe('the worker issue an attach resolves (CORE-2728)', () => {
    function worktree(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-d8-wt-'));
        roots.push(dir);
        return dir;
    }

    it('reads the bead the launch persisted in session metadata', () => {
        const dir = worktree();
        fs.ensureDirSync(path.join(dir, '.xtrm'));
        fs.writeJsonSync(path.join(dir, '.xtrm', 'session-meta.json'), {
            runtime: 'pi',
            launchedAt: '2026-11-18T00:00:00.000Z',
            bead: 'CORE-2728',
        });
        expect(resolveWorkerIssueRef(dir, { listPanes: () => '' })).toBe('CORE-2728');
    });

    it('falls back to a live pane @agent_bead for that worktree', () => {
        const dir = worktree();
        // The real listing shape is path<TAB>worktree<TAB>bead.
        // @agent_worktree names the worktree even when the pane's cwd has moved.
        const listing = [
            `/elsewhere\t\tCORE-1`,
            `/elsewhere\t${dir}\tCORE-2728`,
        ].join('\n');
        expect(resolveWorkerIssueRef(dir, { readMeta: () => null, listPanes: () => listing })).toBe('CORE-2728');
        // pane_current_path is the fallback: a bare launch writes no @agent_worktree
        // option, so a pane sitting in the worktree must still resolve its issue.
        const byPath = `${dir}\t\tCORE-2728`;
        expect(resolveWorkerIssueRef(dir, { readMeta: () => null, listPanes: () => byPath })).toBe('CORE-2728');
        // A pane in another worktree is never that worktree's issue.
        expect(resolveWorkerIssueRef(dir, { readMeta: () => null, listPanes: () => `/elsewhere\t\tCORE-9999` })).toBeNull();
    });

    it('a Codex record carries the bead, so attach restores the dispatcher with NO pane', () => {
        const dir = worktree();
        fs.ensureDirSync(path.join(dir, '.xtrm'));
        // The shape writeCodexWorktreeSession writes (CORE-2728 added `bead`).
        fs.writeJsonSync(path.join(dir, '.xtrm', 'session-meta.json'), {
            runtime: 'codex',
            launchedAt: '2026-11-18T00:00:00.000Z',
            threadId: '019fc3bc-fb7a-7ae0-9536-125624bf726b',
            safetyProfile: 'codex-yolo',
            profileName: 'xtrm-0123456789abcdef',
            profilePath: path.join(os.homedir(), '.codex', 'xtrm-0123456789abcdef.config.toml'),
            bead: 'CORE-2728',
        });
        // No tmux pane at all: the record is the only source.
        const ref = resolveWorkerIssueRef(dir, { listPanes: () => '' });
        expect(ref).toBe('CORE-2728');
        const identity = liveDispatcher('g04z', { name: 'g04z-lead' });
        const env = attachDispatcherEnv(ref, {
            env: {},
            run: () => ({ ok: true, stdout: traceStdout([{ dispatcherParticipantId: 'g04z', createdAt: 1 }]) }),
            identity,
        });
        expect(env).toEqual({
            [XTRM_DISPATCHER_PARTICIPANT_VAR]: 'g04z',
            [XTRM_DISPATCHER_NAME_VAR]: 'g04z-lead',
            [XTRM_DISPATCHER_ADDRESS_VAR]: 'uds:/run/cc/100.sock',
        });
    });

    it('unknown stays absent: no metadata, no pane and an unsafe value all return null', () => {
        const dir = worktree();
        expect(resolveWorkerIssueRef(dir, { readMeta: () => null, listPanes: () => '' })).toBeNull();
        const unsafe = `${dir}\t\t--project`;
        expect(resolveWorkerIssueRef(dir, { readMeta: () => null, listPanes: () => unsafe })).toBeNull();
        fs.ensureDirSync(path.join(dir, '.xtrm'));
        fs.writeJsonSync(path.join(dir, '.xtrm', 'session-meta.json'), { runtime: 'pi', launchedAt: 'x', bead: 'not a ref' });
        expect(resolveWorkerIssueRef(dir, { listPanes: () => '' })).toBeNull();
    });
});
