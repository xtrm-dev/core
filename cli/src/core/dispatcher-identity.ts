/**
 * Dispatcher identity for xt-launched workers (CORE-2390).
 *
 * A worker launched with `xt claude|pi|codex` learns, with no typing, who
 * dispatched it and which Substrate participant it is:
 *
 * - `SUBSTRATE_HOLDER` — the worker's own name (the launch slug). Always the
 *   worker's, never the dispatcher's inherited value.
 * - `XTRM_DISPATCHER_NAME` / `XTRM_DISPATCHER_ADDRESS` — the nearest ancestor
 *   session in `~/.claude/sessions/<pid>.json` carrying a `messagingSocketPath`
 *   (Claude Code, or Pi via the first-party intercom Claude transport, which
 *   writes the same registry);
 *   the address is `uds:<messagingSocketPath>`, the
 *   form SendMessage accepts. Inherited `XTRM_DISPATCHER_*` is the fallback
 *   only when no ancestor resolves, so nested dispatch names the nearest
 *   dispatcher.
 * - `XTRM_PARENT_PANE_ID` / `XTRM_PARENT_SESSION_ID` — the tmux pane xt ran
 *   in and its session, when tmux can answer.
 *
 * Unknown stays absent (session-identity.ts rule): no placeholders, no empty
 * strings. Every probe fails soft — an error omits the field and the launch
 * proceeds.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TmuxProbe } from './session-identity.js';

export const SUBSTRATE_HOLDER_VAR = 'SUBSTRATE_HOLDER';
export const XTRM_DISPATCHER_NAME_VAR = 'XTRM_DISPATCHER_NAME';
export const XTRM_DISPATCHER_ADDRESS_VAR = 'XTRM_DISPATCHER_ADDRESS';
export const XTRM_PARENT_SESSION_ID_VAR = 'XTRM_PARENT_SESSION_ID';
export const XTRM_PARENT_PANE_ID_VAR = 'XTRM_PARENT_PANE_ID';

/** Every key this module owns; launchers strip them from inherited env first. */
export const DISPATCHER_ENV_KEYS = [
    SUBSTRATE_HOLDER_VAR,
    XTRM_DISPATCHER_NAME_VAR,
    XTRM_DISPATCHER_ADDRESS_VAR,
    XTRM_PARENT_SESSION_ID_VAR,
    XTRM_PARENT_PANE_ID_VAR,
] as const;

const MAX_ANCESTOR_HOPS = 64;

export interface ProcessInfo {
    ppid: number;
    /** Kernel start time (clock ticks); Claude Code records it as `procStart`. */
    startTime?: string;
}

export interface DispatcherIdentityDeps {
    env?: NodeJS.ProcessEnv;
    /** First pid to inspect. Default: the xt process's parent. */
    startPid?: number;
    /** Claude Code session registry. Default: ~/.claude/sessions. */
    sessionsDir?: string;
    readProcess?: (pid: number) => ProcessInfo | null;
    tmux?: TmuxProbe;
}

export interface DispatcherIdentity {
    name?: string;
    address?: string;
}

function clean(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function defaultTmux(args: string[]): { status: number | null; stdout: string } {
    const result = spawnSync('tmux', args, { encoding: 'utf8', stdio: 'pipe' });
    return { status: result.status, stdout: String(result.stdout ?? '') };
}

/** /proc first (Linux); `ps` fallback (macOS) carries no start time. */
export function readProcessInfo(pid: number): ProcessInfo | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        // comm may contain spaces and parens; fields resume after the last ')'.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ppid = Number(fields[1]);
        if (Number.isInteger(ppid)) return { ppid, startTime: fields[19] };
    } catch { /* not Linux, or the process is gone */ }
    try {
        const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: 'pipe' });
        const ppid = Number(String(result.stdout ?? '').trim());
        if (result.status === 0 && Number.isInteger(ppid) && ppid > 0) return { ppid };
    } catch { /* absent */ }
    return null;
}

function readSessionEntry(sessionsDir: string, pid: number, startTime: string | undefined): DispatcherIdentity | null {
    let entry: Record<string, unknown>;
    try {
        entry = JSON.parse(readFileSync(path.join(sessionsDir, `${pid}.json`), 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
    const socket = clean(entry.messagingSocketPath);
    if (!socket) return null;
    // A stale file whose pid was reused by an unrelated ancestor is not a dispatcher.
    if (typeof entry.pid === 'number' && entry.pid !== pid) return null;
    // Claude Code writes procStart as /proc clock ticks; pre-M1 writers wrote a
    // `ps lstart` date string, which cannot be compared to ticks.
    // ponytail: Pi entries rely on the pid match alone; convert lstart via btime + CLK_TCK if pid reuse bites.
    const procStart = clean(entry.procStart);
    if (procStart && /^\d+$/.test(procStart) && startTime && procStart !== startTime) return null;
    const identity: DispatcherIdentity = { address: `uds:${socket}` };
    const name = clean(entry.name);
    if (name) identity.name = name;
    return identity;
}

/**
 * Nearest ancestor Claude Code session with a messaging socket; inherited
 * `XTRM_DISPATCHER_*` only when no ancestor resolves. Never throws.
 */
export function resolveDispatcher(deps: DispatcherIdentityDeps = {}): DispatcherIdentity {
    const env = deps.env ?? process.env;
    const sessionsDir = deps.sessionsDir ?? path.join(os.homedir(), '.claude', 'sessions');
    const readProcess = deps.readProcess ?? readProcessInfo;
    let pid = deps.startPid ?? process.ppid;
    try {
        for (let hop = 0; hop < MAX_ANCESTOR_HOPS && pid > 1; hop++) {
            const info = readProcess(pid);
            const hit = readSessionEntry(sessionsDir, pid, info?.startTime);
            if (hit) return hit;
            if (!info || info.ppid === pid) break;
            pid = info.ppid;
        }
    } catch { /* fall through to inherited */ }
    const inherited: DispatcherIdentity = {};
    const name = clean(env[XTRM_DISPATCHER_NAME_VAR]);
    const address = clean(env[XTRM_DISPATCHER_ADDRESS_VAR]);
    if (name) inherited.name = name;
    if (address) inherited.address = address;
    return inherited;
}

/**
 * The full dispatcher-identity env for a worker named `workerName`.
 * Observed values only; unknown keys are absent.
 */
export function buildDispatcherEnv(workerName: string, deps: DispatcherIdentityDeps = {}): Record<string, string> {
    const env = deps.env ?? process.env;
    const out: Record<string, string> = {};
    const holder = clean(workerName);
    if (holder) out[SUBSTRATE_HOLDER_VAR] = holder;

    const dispatcher = resolveDispatcher(deps);
    if (dispatcher.name) out[XTRM_DISPATCHER_NAME_VAR] = dispatcher.name;
    if (dispatcher.address) out[XTRM_DISPATCHER_ADDRESS_VAR] = dispatcher.address;

    const pane = env.TMUX ? clean(env.TMUX_PANE) : null;
    if (pane && /^%\d+$/.test(pane)) {
        out[XTRM_PARENT_PANE_ID_VAR] = pane;
        try {
            const result = (deps.tmux ?? defaultTmux)(['display-message', '-p', '-t', pane, '-F', '#{session_id}']);
            const sessionId = result.status === 0 ? clean(result.stdout) : null;
            if (sessionId && /^\$\d+$/.test(sessionId)) out[XTRM_PARENT_SESSION_ID_VAR] = sessionId;
        } catch { /* absent */ }
    }
    return out;
}

/**
 * Live dispatcher sessions for one participant name (CORE-2432 R8/F4): every
 * session-registry entry with that exact name carrying a messaging socket,
 * skipping dead pids. Several live candidates are an error naming them all;
 * mtime order never decides. Throws only on ambiguity.
 */
function findLiveDispatchers(
    participant: string,
    deps: DispatcherIdentityDeps = {},
): DispatcherIdentity[] {
    const sessionsDir = deps.sessionsDir ?? path.join(os.homedir(), '.claude', 'sessions');
    const readProcess = deps.readProcess ?? readProcessInfo;
    const found: { pid: unknown; address: string }[] = [];
    let files: string[];
    try {
        files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
    } catch {
        return [];
    }
    for (const file of files) {
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(readFileSync(path.join(sessionsDir, file), 'utf8')) as Record<string, unknown>;
        } catch {
            continue;
        }
        if (clean(entry.name) !== participant) continue;
        const socket = clean(entry.messagingSocketPath);
        if (!socket) continue;
        // Pid liveness with reuse protection, as readSessionEntry does: a
        // dead pid is skipped, and a numeric procStart that disagrees with
        // the live process start time means the pid was reused. A probe
        // failure keeps the entry (unknown, not dead).
        if (typeof entry.pid === 'number') {
            const filePid = Number(file.replace(/\.json$/, ''));
            if (Number.isInteger(filePid) && entry.pid !== filePid) continue;
            let info: ProcessInfo | null = null;
            try {
                info = readProcess(entry.pid);
            } catch { /* keep on probe failure */ }
            if (!info) continue;
            const procStart = clean(entry.procStart);
            if (procStart && /^\d+$/.test(procStart) && info.startTime && procStart !== info.startTime) continue;
        }
        found.push({ pid: entry.pid, address: `uds:${socket}` });
    }
    if (found.length > 1) {
        const candidates = found.map((f) => `pid ${String(f.pid)} at ${f.address}`).join(', ');
        throw new Error(`ambiguous dispatcher participant "${participant}": ${candidates}`);
    }
    return found.map((f) => ({ name: participant, address: f.address }));
}

/**
 * Resolve a dispatcher participant by name after it restarted (CORE-2432 R8).
 * A worker that only knows its dispatcher's participant name scans the live
 * sessions for that exact name. One live hit wins; several throw naming every
 * candidate (F4); none returns null so the caller can fall back. Never throws
 * except on ambiguity.
 */
export function resolveDispatcherByParticipant(
    participant: string,
    deps: DispatcherIdentityDeps = {},
): DispatcherIdentity | null {
    const want = clean(participant);
    if (!want) return null;
    return findLiveDispatchers(want, deps)[0] ?? null;
}

/**
 * Fresh dispatcher env for a resumed session (CORE-2432 R8/F2): `xt attach`
 * resolves the dispatcher by participant (XTRM_DISPATCHER_NAME) against the
 * live sessions with a pid liveness check, and refreshes the env from that
 * hit instead of inheriting stale values across a dispatcher restart. When no
 * live entry matches, the nearest-ancestor (else inherited) resolution applies.
 * Unknown stays absent; ambiguity falls back the same way. Never throws.
 */
export function refreshDispatcherEnv(deps: DispatcherIdentityDeps = {}): Record<string, string> {
    const out: Record<string, string> = {};
    const env = deps.env ?? process.env;
    const participant = clean(env[XTRM_DISPATCHER_NAME_VAR]);
    if (participant) {
        try {
            const live = findLiveDispatchers(participant, deps)[0];
            if (live?.address) {
                out[XTRM_DISPATCHER_NAME_VAR] = live.name ?? participant;
                out[XTRM_DISPATCHER_ADDRESS_VAR] = live.address;
                return out;
            }
        } catch (error) {
            // Ambiguous: say so on stderr, then fall back to ancestor resolution.
            process.stderr.write(`xt attach: ${(error as Error).message}; falling back to ancestor resolution\n`);
        }
    }
    const dispatcher = resolveDispatcher(deps);
    if (dispatcher.name) out[XTRM_DISPATCHER_NAME_VAR] = dispatcher.name;
    if (dispatcher.address) out[XTRM_DISPATCHER_ADDRESS_VAR] = dispatcher.address;
    return out;
}

/** Copy of `env` without any dispatcher key, so an inherited value can never leak through. */
export function stripDispatcherEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out = { ...env };
    for (const key of DISPATCHER_ENV_KEYS) delete out[key];
    return out;
}
