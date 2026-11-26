// CORE-2740: restore hardening after the PR #963 (CORE-2728) audit, F1-F3.
// Everything `xt attach` reads back — a binding's participant, a registry name,
// a pane's issue — is DATA written by another process, so a restored identity
// must be validated, must be this worker's OWN binding, and a tmux probe that
// never answers must not hang the attach.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    XTRM_DISPATCHER_ADDRESS_VAR,
    XTRM_DISPATCHER_NAME_VAR,
    XTRM_DISPATCHER_PARTICIPANT_VAR,
    attachDispatcherEnv,
    findLaunchBindingId,
    refreshDispatcherEnvByParticipant,
    type DispatcherIdentityDeps,
} from '../core/dispatcher-identity.js';
import { resolveWorkerIssue } from '../commands/attach.js';
import { PANE_PROBE_TIMEOUT_MS, listAgentPanes } from '../utils/worktree-pane-issue.js';
import { readSessionMeta, writeSessionBindingId, writeSessionMeta } from '../utils/worktree-session.js';

const roots: string[] = [];
let sessionsDir = '';

beforeEach(() => {
    sessionsDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-2740-sessions-'));
});

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(dir);
    return dir;
}

function traceStdout(bindings: Array<Record<string, unknown>>): string {
    return JSON.stringify({ schema: 'substrate-cli/v1', command: 'provenance.trace', ok: true, data: { bindings } });
}

/**
 * A live dispatcher session whose PROCESS holds `holder` and whose registry name
 * is `name`; the two differ, exactly as they may in reality.
 */
function liveDispatcher(holder: string, over: { name?: string; pid?: number; socket?: string } = {}): DispatcherIdentityDeps {
    const pid = over.pid ?? 100;
    writeFileSync(
        path.join(sessionsDir, `${pid}.json`),
        JSON.stringify({ pid, name: over.name ?? `${holder}-lead`, messagingSocketPath: over.socket ?? `/run/cc/${pid}.sock` }),
    );
    return {
        sessionsDir,
        readProcess: () => ({ ppid: 1 }),
        readEnviron: (want: number) => (want === pid ? { SUBSTRATE_HOLDER: holder } : null),
        env: {},
    };
}

describe('CORE-2740 F1: a restored value must be a dispatcher label', () => {
    it.each([
        ['a newline', 'g04z\nevil'],
        ['an ESC sequence', 'g04z\u001bdispatch'],
        ['a space', 'g04z lead'],
        ['an empty string', '   '],
        ['an over-long value', `g${'x'.repeat(140)}`],
    ])('%s in the binding participant is omitted, not exported', (_label, participant) => {
        const env = refreshDispatcherEnvByParticipant(participant, liveDispatcher('g04z'));
        expect(env).toEqual({});
    });

    it('a hittable label still restores, so the guard does not block the normal case', () => {
        const env = refreshDispatcherEnvByParticipant('g04z', liveDispatcher('g04z', { name: 'g04z-lead' }));
        expect(env[XTRM_DISPATCHER_PARTICIPANT_VAR]).toBe('g04z');
        expect(env[XTRM_DISPATCHER_NAME_VAR]).toBe('g04z-lead');
        expect(env[XTRM_DISPATCHER_ADDRESS_VAR]).toBe('uds:/run/cc/100.sock');
    });

    it('a registry display name is reduced to one bounded line before export', () => {
        const hostile = 'lead\u001b[2J\u0007evil\nSECOND LINE';
        const env = refreshDispatcherEnvByParticipant('g04z', liveDispatcher('g04z', { name: hostile }));
        // The participant is the label; the name is display-only and single-line.
        expect(env[XTRM_DISPATCHER_PARTICIPANT_VAR]).toBe('g04z');
        expect(env[XTRM_DISPATCHER_NAME_VAR]).toBe('lead [2J evil SECOND LINE');
    });

    it.each([
        ['a relative socket path', 'run/cc/100.sock'],
        ['a foreign scheme', 'unix:/run/cc/100.sock'],
        ['a newline in the path', '/run/cc/100\nsock'],
        ['an ESC in the path', '/run/cc/\u001b100.sock'],
        ['an empty path', ''],
        ['an over-long path', `/${'a'.repeat(520)}`],
    ])('%s in the registry socket is not exported as an address', (_label, socket) => {
        const env = refreshDispatcherEnvByParticipant('g04z', liveDispatcher('g04z', { socket }));
        expect(env).not.toHaveProperty(XTRM_DISPATCHER_ADDRESS_VAR);
        // The participant itself is still known and stays.
        expect(env[XTRM_DISPATCHER_PARTICIPANT_VAR]).toBe('g04z');
    });

    it('the attach path omits a hostile binding participant instead of exporting it', () => {
        const env = attachDispatcherEnv('CORE-2740', {
            env: {},
            run: () => ({ ok: true, stdout: traceStdout([{ id: 'exb_1', dispatcherParticipantId: 'g04z\u001bx', createdAt: 1 }]) }),
            identity: liveDispatcher('g04z'),
        });
        expect(env).toEqual({});
    });
});

describe('CORE-2740 F2: attach restores the worker\'s own binding', () => {
    const WT_A = '/repo/.xtrm/worktrees/core-xt-pi-worker-a';
    const WT_B = '/repo/.xtrm/worktrees/core-xt-pi-worker-b';
    const FOREIGN_WT = '/repo/.xtrm/worktrees/core-xt-pi-foreign';

    /** Two bindings on ONE issue: worker A's and worker B's, B's written later. */
    function twoWorkersOneIssue(): string {
        return traceStdout([
            { id: 'exb_a', dispatcherParticipantId: 'lead-a', dispatcherSessionId: null, workspace: WT_A, createdAt: 200 },
            { id: 'exb_b', dispatcherParticipantId: 'lead-b', dispatcherSessionId: null, workspace: WT_B, createdAt: 400 },
            { id: 'exb_foreign', dispatcherParticipantId: 'attacker', workspace: FOREIGN_WT, createdAt: 600 },
        ]);
    }

    it('two workers on one issue each restore their own dispatcher, a foreign pane notwithstanding', () => {
        const stdout = twoWorkersOneIssue();
        const run = () => ({ ok: true, stdout });
        const envA = attachDispatcherEnv('CORE-2740', {
            env: {},
            run,
            bindingId: 'exb_a',
            workspace: WT_A,
            identity: liveDispatcher('lead-a'),
        });
        const envB = attachDispatcherEnv('CORE-2740', {
            env: {},
            run,
            bindingId: 'exb_b',
            workspace: WT_B,
            identity: liveDispatcher('lead-b', { pid: 101 }),
        });
        expect(envA[XTRM_DISPATCHER_PARTICIPANT_VAR]).toBe('lead-a');
        expect(envB[XTRM_DISPATCHER_PARTICIPANT_VAR]).toBe('lead-b');
    });

    it('a issue taken from a pane may only read a binding made in this worktree', () => {
        const stdout = twoWorkersOneIssue();
        const run = () => ({ ok: true, stdout });
        // No binding id (the pane has none) and the newest binding belongs to another
        // worktree: the foreign dispatcher must NOT be restored.
        const foreign = attachDispatcherEnv('CORE-2740', {
            env: {},
            run,
            bindingId: null,
            workspace: '/repo/.xtrm/worktrees/core-xt-pi-victim',
            identity: liveDispatcher('attacker'),
        });
        expect(foreign).toEqual({});
        // The same query for a worktree that DOES hold a binding is answered by it.
        const own = attachDispatcherEnv('CORE-2740', {
            env: {},
            run,
            bindingId: null,
            workspace: WT_A,
            identity: liveDispatcher('lead-a'),
        });
        expect(own[XTRM_DISPATCHER_PARTICIPANT_VAR]).toBe('lead-a');
    });

    it('an exact id that the trace no longer lists leaves the dispatcher absent', () => {
        const env = attachDispatcherEnv('CORE-2740', {
            env: {},
            run: () => ({ ok: true, stdout: twoWorkersOneIssue() }),
            bindingId: 'exb_gone',
            workspace: WT_A,
            identity: liveDispatcher('lead-a'),
        });
        // Never "the newest binding on the issue" as a consolation prize.
        expect(env).toEqual({});
    });

    it('the own binding that recorded no dispatcher answers absent, not the next binding', () => {
        const stdout = traceStdout([
            { id: 'exb_mine', dispatcherParticipantId: null, workspace: WT_A, createdAt: 100 },
            { id: 'exb_other', dispatcherParticipantId: 'attacker', workspace: WT_B, createdAt: 200 },
        ]);
        const env = attachDispatcherEnv('CORE-2740', {
            env: {},
            run: () => ({ ok: true, stdout }),
            bindingId: 'exb_mine',
            workspace: WT_A,
            identity: liveDispatcher('attacker'),
        });
        expect(env).toEqual({});
    });

    it('a legacy record whose own binding recorded no dispatcher adopts none from another worktree', () => {
        // CORE-2740 F2 (seconder act:ce631d40-f1c): without a binding id the
        // worker's own worktree decides. Its own binding recorded no dispatcher,
        // so the answer is absent — the other worktree's binding is not its own.
        const stdout = traceStdout([
            { id: 'exb_mine', dispatcherParticipantId: null, workspace: WT_A, createdAt: 100 },
            { id: 'exb_other', dispatcherParticipantId: 'attacker', workspace: WT_B, createdAt: 200 },
        ]);
        const env = attachDispatcherEnv('CORE-2740', {
            env: {},
            run: () => ({ ok: true, stdout }),
            bindingId: null,
            workspace: WT_A,
            identity: liveDispatcher('attacker'),
        });
        expect(env).toEqual({});
    });

    it('a legacy record whose worktree has no binding row adopts nothing from another worktree', () => {
        // CORE-2740 review M1b: with no binding id and no row for WT_A, the
        // legacy fallback must not reach the newest binding of another worktree.
        const stdout = traceStdout([{ id: 'exb_other', dispatcherParticipantId: 'attacker', workspace: WT_B, createdAt: 200 }]);
        const env = attachDispatcherEnv('CORE-2740', {
            env: {},
            run: () => ({ ok: true, stdout }),
            bindingId: null,
            workspace: WT_A,
            identity: liveDispatcher('attacker'),
        });
        expect(env).toEqual({});
    });

    it('the launch read-back picks the binding it just wrote in its own worktree', () => {
        const stdout = traceStdout([
            { id: 'exb_previous', dispatcherParticipantId: 'old-lead', workspace: WT_A, createdAt: 100 },
            { id: 'exb_new', dispatcherParticipantId: 'lead-a', workspace: WT_A, createdAt: 300 },
            { id: 'exb_elsewhere', dispatcherParticipantId: 'lead-b', workspace: WT_B, createdAt: 400 },
        ]);
        const id = findLaunchBindingId('CORE-2740', {
            workspace: WT_A,
            sinceMs: 250,
            participant: 'lead-a',
            env: {},
            run: () => ({ ok: true, stdout }),
        });
        expect(id).toBe('exb_new');
        // A binding written before the launch started is not this launch's.
        expect(findLaunchBindingId('CORE-2740', {
            workspace: WT_A,
            sinceMs: 350,
            env: {},
            run: () => ({ ok: true, stdout }),
        })).toBeNull();
        // An unreadable trace is unknown, not an error.
        expect(findLaunchBindingId('CORE-2740', {
            workspace: WT_A,
            env: {},
            run: () => ({ ok: false, error: 'no store' }),
        })).toBeNull();
    });

    it('the session record carries the binding id, and a hostile one is not believed', () => {
        const worktree = tmp('xtrm-2740-wt-');
        expect(writeSessionMeta(worktree, 'pi', 'CORE-2740')).toBe(true);
        expect(writeSessionBindingId(worktree, 'exb_01a1ee88-6881-7068-b9de-784b3011f71a')).toBe(true);
        expect(readSessionMeta(worktree)).toMatchObject({
            runtime: 'pi',
            issue: 'CORE-2740',
            bindingId: 'exb_01a1ee88-6881-7068-b9de-784b3011f71a',
        });
        // The issue lookup reports the record as its source and hands the id along.
        expect(resolveWorkerIssue(worktree, { paneIssue: () => null })).toEqual({
            ref: 'CORE-2740',
            source: 'meta',
            bindingId: 'exb_01a1ee88-6881-7068-b9de-784b3011f71a',
        });
        // A record carrying a value that is not a binding id is not believed; the
        // restore then falls back to the worktree match only.
        fsWriteBindingId(worktree, 'exb_1; rm -rf /tmp/x');
        expect(readSessionMeta(worktree)?.bindingId).toBe('exb_1; rm -rf /tmp/x');
        expect(resolveWorkerIssue(worktree, { paneIssue: () => null })?.bindingId).toBeNull();
        // Writing no id at all is a no-op, never a record rewrite.
        expect(writeSessionBindingId(worktree, '   ')).toBe(false);
        // CORE-2740 F2: a pane-derived ref carries no binding and says so.
        const paneless = tmp('xtrm-2740-wt-');
        expect(resolveWorkerIssue(paneless, { readMeta: () => null, paneIssue: () => 'CORE-2740' })).toEqual({
            ref: 'CORE-2740',
            source: 'pane',
            bindingId: null,
        });
    });
});

/** Overwrite the session record's binding id verbatim, for the validation test. */
function fsWriteBindingId(worktreePath: string, value: string): void {
    const file = path.join(worktreePath, '.xtrm', 'session-meta.json');
    const meta = JSON.parse(require('node:fs').readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...meta, bindingId: value }));
}

describe('CORE-2740 review: each refusal names its cause in one line', () => {
    const WT_A = '/repo/.xtrm/worktrees/core-xt-pi-worker-a';
    const WT_B = '/repo/.xtrm/worktrees/core-xt-pi-worker-b';

    function captureLines<T>(run: () => T): { value: T; lines: string[] } {
        const lines: string[] = [];
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
            lines.push(String(chunk));
            return true;
        }) as never);
        try {
            return { value: run(), lines };
        } finally {
            spy.mockRestore();
        }
    }

    it('an invalid participant is refused with one line and no echoed value', () => {
        const hostile = 'g04z\u001b[2Jevil';
        const { value, lines } = captureLines(() => refreshDispatcherEnvByParticipant(hostile, liveDispatcher('g04z')));
        expect(value).toEqual({});
        expect(lines).toEqual(['xt attach: the dispatcher participant recorded on the launch binding is not a Substrate label; the dispatcher stays absent\n']);
        expect(lines.join('')).not.toContain('evil');
    });

    it('a binding id the trace no longer lists is refused with one line', () => {
        const { value, lines } = captureLines(() => attachDispatcherEnv('CORE-2740', {
            env: {},
            run: () => ({ ok: true, stdout: traceStdout([{ id: 'exb_other', dispatcherParticipantId: 'attacker', workspace: WT_B, createdAt: 2 }]) }),
            bindingId: 'exb_gone',
            workspace: WT_A,
            identity: liveDispatcher('attacker'),
        }));
        expect(value).toEqual({});
        expect(lines).toEqual(['xt attach: the launch binding named by the session record of CORE-2740 is not in the trace; the dispatcher stays absent\n']);
    });

    it('a worktree with no binding row is refused with one line', () => {
        const { value, lines } = captureLines(() => attachDispatcherEnv('CORE-2740', {
            env: {},
            run: () => ({ ok: true, stdout: traceStdout([{ id: 'exb_other', dispatcherParticipantId: 'attacker', workspace: WT_B, createdAt: 2 }]) }),
            bindingId: null,
            workspace: WT_A,
            identity: liveDispatcher('attacker'),
        }));
        expect(value).toEqual({});
        expect(lines).toEqual(['xt attach: no launch binding in this worktree for CORE-2740; the dispatcher stays absent\n']);
    });

    it('an own binding without a dispatcher is refused with one line', () => {
        const { value, lines } = captureLines(() => attachDispatcherEnv('CORE-2740', {
            env: {},
            run: () => ({ ok: true, stdout: traceStdout([{ id: 'exb_mine', dispatcherParticipantId: null, workspace: WT_A, createdAt: 1 }]) }),
            bindingId: 'exb_mine',
            workspace: WT_A,
            identity: liveDispatcher('attacker'),
        }));
        expect(value).toEqual({});
        expect(lines).toEqual(['xt attach: the launch binding of CORE-2740 recorded no dispatcher; the dispatcher stays absent\n']);
    });

    it('an ambiguity line names a registry socket only when it is a usable address', () => {
        // Two live sessions of one holder: one plausible socket, one not.
        const { value, lines } = captureLines(() => refreshDispatcherEnvByParticipant('g04z', {
            sessionsDir,
            readProcess: () => ({ ppid: 1 }),
            readEnviron: (pid: number) => (pid === 100 || pid === 101 ? { SUBSTRATE_HOLDER: 'g04z' } : null),
            env: {},
            ...(() => {
                writeFileSync(path.join(sessionsDir, '100.json'), JSON.stringify({ pid: 100, name: 'lead', messagingSocketPath: '/run/cc/100.sock' }));
                writeFileSync(path.join(sessionsDir, '101.json'), JSON.stringify({ pid: 101, name: 'lead', messagingSocketPath: 'run/cc/101.sock' }));
                return {};
            })(),
        }));
        expect(value[XTRM_DISPATCHER_PARTICIPANT_VAR]).toBe('g04z');
        expect(value).not.toHaveProperty(XTRM_DISPATCHER_ADDRESS_VAR);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('pid 100 at uds:/run/cc/100.sock');
        expect(lines[0]).toContain('pid 101 with an unusable address');
        // The unusable path itself is never printed.
        expect(lines[0]).not.toContain('run/cc/101.sock');
        expect(lines[0].endsWith('\n')).toBe(true);
    });
});

describe('CORE-2740 F3: a hung pane probe reads as absent', () => {
    it('kills the probe at the timeout instead of hanging the attach', () => {
        const bin = tmp('xtrm-2740-bin-');
        const fake = path.join(bin, 'tmux');
        // One process that IGNORES SIGTERM: only the probe's SIGKILL ends it, so
        // dropping killSignal from listAgentPanes makes this test hang and fail.
        writeFileSync(fake, '#!/usr/bin/env python3\nimport signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(30)\n');
        chmodSync(fake, 0o755);
        const savedPath = process.env.PATH;
        process.env.PATH = `${bin}:${savedPath ?? ''}`;
        const started = Date.now();
        try {
            expect(listAgentPanes(150)).toBe('');
        } finally {
            process.env.PATH = savedPath;
        }
        expect(Date.now() - started).toBeLessThan(5_000);
        // The production default is a bound, not a wait forever.
        expect(PANE_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
        expect(PANE_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    });
});
