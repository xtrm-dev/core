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

import { buildGitIdentityEnv, GIT_IDENTITY_ENV_KEYS } from './git-identity.js';
import type { TmuxProbe } from './session-identity.js';

export const SUBSTRATE_HOLDER_VAR = 'SUBSTRATE_HOLDER';
/** The human-readable agent name (`<repo>-xt-<runtime>-<name>`), CORE-2606. */
export const XTRM_AGENT_NAME_VAR = 'XTRM_AGENT_NAME';
export const XTRM_DISPATCHER_NAME_VAR = 'XTRM_DISPATCHER_NAME';
export const XTRM_DISPATCHER_ADDRESS_VAR = 'XTRM_DISPATCHER_ADDRESS';
export const XTRM_PARENT_SESSION_ID_VAR = 'XTRM_PARENT_SESSION_ID';
export const XTRM_PARENT_PANE_ID_VAR = 'XTRM_PARENT_PANE_ID';

/** Every key this module owns; launchers strip them from inherited env first. */
export const DISPATCHER_ENV_KEYS = [
    SUBSTRATE_HOLDER_VAR,
    XTRM_AGENT_NAME_VAR,
    XTRM_DISPATCHER_NAME_VAR,
    XTRM_DISPATCHER_ADDRESS_VAR,
    XTRM_PARENT_SESSION_ID_VAR,
    XTRM_PARENT_PANE_ID_VAR,
    // CORE-2525: the git author identity of the launched agent, so a nested
    // launch recomputes it from its own holder instead of inheriting the
    // dispatcher's name as its author.
    ...GIT_IDENTITY_ENV_KEYS,
] as const;

const MAX_ANCESTOR_HOPS = 64;

/**
 * Runtime processes (D5): the nearest of these in the ancestor chain IS the
 * dispatcher, with or without a messaging socket. `comm` holds exactly these
 * names for `pi`, `claude` and `codex` sessions (jira-identity.ts walks the
 * same three names).
 */
export const AGENT_PROCESS_COMMS = new Set(['pi', 'claude', 'codex']);

export interface ProcessInfo {
    ppid: number;
    /** Kernel start time (clock ticks); Claude Code records it as `procStart`. */
    startTime?: string;
    /** Process name from /proc/<pid>/comm (Linux) or `ps -o comm=` (macOS). */
    comm?: string;
}

export interface DispatcherIdentityDeps {
    env?: NodeJS.ProcessEnv;
    /** First pid to inspect. Default: the xt process's parent. */
    startPid?: number;
    /** Claude Code session registry. Default: ~/.claude/sessions. */
    sessionsDir?: string;
    readProcess?: (pid: number) => ProcessInfo | null;
    tmux?: TmuxProbe;
    /**
     * CORE-2525: author/committer email for the launched agent, resolved by the
     * launcher (resolveGitEmail). Omitted means no git identity is emitted, so
     * callers that do not launch a runtime stay byte-identical to before.
     */
    gitEmail?: string | null;
    /**
     * CORE-2606: the full agent name (`<repo>-xt-<runtime>-<name>`) the launcher
     * computed, exported next to SUBSTRATE_HOLDER. Omitted keeps it absent.
     */
    agentName?: string | null;
    /**
     * CORE-2726 (D5): one pid's environment, read for the ancestor's
     * SUBSTRATE_HOLDER. Default: /proc/<pid>/environ on Linux, absent elsewhere.
     */
    readEnviron?: (pid: number) => NodeJS.ProcessEnv | null;
    /** Boot time in epoch seconds (/proc/stat `btime`), for a `ps lstart` procStart. */
    bootTime?: () => number | null;
    /** Kernel clock ticks per second (`getconf CLK_TCK`), for the same conversion. */
    clockTicks?: () => number;
    /**
     * CORE-2726: false skips the inherited `XTRM_DISPATCHER_*` fallback. An
     * in-process caller (the specialists MCP server, an in-process activation)
     * carries the launched session's env, so its inherited dispatcher value
     * belongs to someone else and must not be read.
     */
    inherit?: boolean;
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

/**
 * A single-line name for the review attribution (CORE-2606): controls become
 * spaces, runs collapse, the result is bounded. The visible line reads it, so a
 * hostile worktree name must not be able to inject a second line.
 */
export function cleanAgentName(value: unknown, max = 96): string | null {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned ? cleaned.slice(0, max) : null;
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
        const close = stat.lastIndexOf(')');
        const comm = stat.slice(stat.indexOf('(') + 1, close).trim();
        const fields = stat.slice(close + 2).split(' ');
        const ppid = Number(fields[1]);
        if (Number.isInteger(ppid)) return { ppid, startTime: fields[19], ...(comm ? { comm } : {}) };
    } catch { /* not Linux, or the process is gone */ }
    try {
        const result = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: 'pipe' });
        const match = /^(\d+)\s+(.+)$/.exec(String(result.stdout ?? '').trim());
        if (result.status === 0 && match) {
            const ppid = Number(match[1]);
            const comm = path.basename(match[2].trim());
            if (Number.isInteger(ppid) && ppid > 0) return { ppid, ...(comm ? { comm } : {}) };
        }
    } catch { /* absent */ }
    return null;
}

/**
 * One process's environment (Linux /proc/<pid>/environ). Absent when the host
 * has no /proc, the pid is gone, or the process is not ours to read. Never
 * throws: an unreadable environment means unknown, not empty.
 */
export function readProcessEnvironment(pid: number): NodeJS.ProcessEnv | null {
    try {
        const raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
        const env: NodeJS.ProcessEnv = {};
        for (const pair of raw.split('\0')) {
            const eq = pair.indexOf('=');
            if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        return env;
    } catch {
        return null;
    }
}

/** Boot time in epoch seconds (/proc/stat `btime`), null when unreadable. */
export function bootTimeSeconds(): number | null {
    try {
        const match = /^btime\s+(\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
        return match ? Number(match[1]) : null;
    } catch {
        return null;
    }
}

/** Kernel clock ticks per second (`getconf CLK_TCK`), 100 when unknowable. */
export function clockTicksPerSecond(): number {
    try {
        const result = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', stdio: 'pipe' });
        const ticks = Number(String(result.stdout ?? '').trim());
        if (result.status === 0 && Number.isInteger(ticks) && ticks > 0) return ticks;
    } catch { /* absent */ }
    return 100;
}

/** A start-time comparison: did it happen, and did it agree. */
interface StartCheck {
    checked: boolean;
    agrees: boolean;
}

/** `ps lstart` has one-second resolution; the btime conversion truncates to a second. */
const LSTART_TOLERANCE_SECONDS = 2;

/**
 * Pid-reuse guard for one registry entry.
 *
 * A numeric `procStart` (clock ticks, what Claude Code writes) is compared to
 * the live start time directly. A `ps lstart` date string (pre-M1 Claude
 * writers, and Pi entries) is converted to epoch seconds through
 * boot time + CLK_TCK when both are readable, so a Pi entry is guarded too
 * (CORE-2726); when that conversion is impossible the entry is kept and the
 * caller reports `procStartChecked: false` — unknown, not stale.
 */
function compareStartTime(
    procStart: string | null,
    startTime: string | undefined,
    deps: DispatcherIdentityDeps,
): StartCheck {
    if (!procStart || !startTime) return { checked: false, agrees: true };
    if (/^\d+$/.test(procStart)) return { checked: true, agrees: procStart === startTime };
    const lstart = Date.parse(procStart);
    if (!Number.isFinite(lstart)) return { checked: false, agrees: true };
    const ticks = /^\d+$/.test(startTime) ? Number(startTime) : null;
    const boot = (deps.bootTime ?? bootTimeSeconds)();
    const perSecond = (deps.clockTicks ?? clockTicksPerSecond)();
    if (ticks === null || boot === null || !Number.isInteger(perSecond) || perSecond <= 0) return { checked: false, agrees: true };
    const live = boot + ticks / perSecond;
    return { checked: true, agrees: Math.abs(live - lstart / 1000) <= LSTART_TOLERANCE_SECONDS };
}

/** What one pid's registry file says, and whether it may name a dispatcher. */
interface RegistryProbe {
    address?: string;
    name?: string;
    sessionId?: string;
    /** Why the entry cannot name a dispatcher; reported in `skipped`. */
    rejection?: string;
    /** The entry was written by a Pi session (`entrypoint: 'pi'`). */
    agentEntrypoint?: boolean;
    startCheck: StartCheck;
}

function probeRegistryEntry(
    sessionsDir: string,
    pid: number,
    info: ProcessInfo | null,
    deps: DispatcherIdentityDeps,
): RegistryProbe | null {
    let entry: Record<string, unknown>;
    try {
        entry = JSON.parse(readFileSync(path.join(sessionsDir, `${pid}.json`), 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
    const startCheck = compareStartTime(clean(entry.procStart), info?.startTime, deps);
    // A stale file whose pid was reused by an unrelated ancestor is not a dispatcher.
    if (typeof entry.pid === 'number' && entry.pid !== pid) {
        return { rejection: 'pid reused: the registry entry names another pid', startCheck };
    }
    if (startCheck.checked && !startCheck.agrees) {
        return { rejection: 'pid reused: procStart disagrees with the live process start time', startCheck };
    }
    const probe: RegistryProbe = { startCheck };
    const sessionId = clean(entry.sessionId);
    if (sessionId) probe.sessionId = sessionId;
    const name = clean(entry.name);
    if (name) probe.name = name;
    const entrypoint = clean(entry.entrypoint);
    if (entrypoint && AGENT_PROCESS_COMMS.has(entrypoint)) probe.agentEntrypoint = true;
    const socket = clean(entry.messagingSocketPath);
    if (socket) probe.address = `uds:${socket}`;
    return probe;
}

/** True when this pid is an agent runtime process (D5), from comm or the registry entrypoint. */
function isAgentAncestor(info: ProcessInfo | null, probe: RegistryProbe | null): boolean {
    const comm = clean(info?.comm);
    if (comm && AGENT_PROCESS_COMMS.has(comm)) return true;
    return probe?.agentEntrypoint === true;
}

/** The dispatcher candidate a resolution came from. */
export type DispatcherSource = 'explicit' | 'ancestor' | 'inherited' | 'none';

/** One ancestor that was walked past, and why. */
export interface SkippedAncestor {
    pid: number;
    reason: string;
}

/**
 * A full dispatcher resolution (CORE-2726): the identity plus its provenance.
 * Unknown stays absent, exactly as `DispatcherIdentity`.
 */
export interface DispatcherResolution {
    /** The dispatcher's SUBSTRATE_HOLDER; absent when unreadable. */
    participant?: string;
    /** Display-only agent name, never the participant. */
    name?: string;
    address?: string;
    source: DispatcherSource;
    /** The ancestor pid that resolved the dispatcher. */
    pid?: number;
    sessionId?: string;
    /** Whether a pid-reuse start-time check was possible for the entry that resolved. */
    procStartChecked: boolean;
    skipped: SkippedAncestor[];
}

const NO_SOCKET_REASON = 'agent ancestor without a messaging socket';

/**
 * The ancestor walk plus its diagnostics (CORE-2726).
 *
 * Stops at the nearest agent ancestor (D5): a Pi or Codex lead that publishes
 * no messaging socket is the dispatcher all the same, so its participant is
 * taken, its address stays absent and it is listed in `skipped`. The walk
 * never continues to a grandparent or an inherited value behind it, because
 * both name someone who did not dispatch.
 */
export function resolveDispatcherResolution(deps: DispatcherIdentityDeps = {}): DispatcherResolution {
    const env = deps.env ?? process.env;
    const sessionsDir = deps.sessionsDir ?? path.join(os.homedir(), '.claude', 'sessions');
    const readProcess = deps.readProcess ?? readProcessInfo;
    const readEnviron = deps.readEnviron ?? readProcessEnvironment;
    const skipped: SkippedAncestor[] = [];
    let pid = deps.startPid ?? process.ppid;
    try {
        for (let hop = 0; hop < MAX_ANCESTOR_HOPS && pid > 1; hop++) {
            const info = readProcess(pid);
            const probe = probeRegistryEntry(sessionsDir, pid, info, deps);
            if (probe?.rejection) skipped.push({ pid, reason: probe.rejection });
            // A rejected entry is stale: its name, session and socket name another process.
            const hit = probe && !probe.rejection ? probe : null;
            if (hit?.address) {
                const resolution: DispatcherResolution = {
                    address: hit.address,
                    source: 'ancestor',
                    pid,
                    procStartChecked: hit.startCheck.checked,
                    skipped,
                };
                if (hit.name) resolution.name = hit.name;
                if (hit.sessionId) resolution.sessionId = hit.sessionId;
                const participant = clean(holderOf(readEnviron, pid));
                if (participant) resolution.participant = participant;
                return resolution;
            }
            if (isAgentAncestor(info, probe)) {
                const participant = clean(holderOf(readEnviron, pid));
                skipped.push({ pid, reason: NO_SOCKET_REASON });
                const resolution: DispatcherResolution = {
                    source: 'ancestor',
                    pid,
                    // A rejected entry still proved whether the check was possible.
                    procStartChecked: probe?.startCheck.checked ?? false,
                    skipped,
                };
                // No new env key (CORE-2725 non-goal): NAME keeps its display
                // meaning and falls back to the participant only when the
                // registry has no name for this ancestor.
                const name = hit?.name ?? participant;
                if (name) resolution.name = name;
                if (participant) resolution.participant = participant;
                return resolution;
            }
            if (!info || info.ppid === pid) break;
            pid = info.ppid;
        }
    } catch { /* fall through to inherited */ }
    const resolution: DispatcherResolution = { source: 'none', procStartChecked: false, skipped };
    if (deps.inherit === false) return resolution;
    const name = clean(env[XTRM_DISPATCHER_NAME_VAR]);
    const address = clean(env[XTRM_DISPATCHER_ADDRESS_VAR]);
    if (name) resolution.name = name;
    if (address) resolution.address = address;
    if (name || address) resolution.source = 'inherited';
    return resolution;
}

/** The dispatcher's own SUBSTRATE_HOLDER, when that process's env is readable. */
function holderOf(readEnviron: (pid: number) => NodeJS.ProcessEnv | null, pid: number): string | null {
    try {
        const env = readEnviron(pid);
        return env ? clean(env[SUBSTRATE_HOLDER_VAR]) : null;
    } catch {
        return null;
    }
}

/**
 * Nearest ancestor agent session; inherited `XTRM_DISPATCHER_*` only when no
 * ancestor resolves. Never throws.
 */
export function resolveDispatcher(deps: DispatcherIdentityDeps = {}): DispatcherIdentity {
    const resolved = resolveDispatcherResolution(deps);
    const identity: DispatcherIdentity = {};
    if (resolved.name) identity.name = resolved.name;
    if (resolved.address) identity.address = resolved.address;
    return identity;
}

/** What `xt identity dispatcher` was asked for. */
export interface DispatcherQuery {
    /** Walk start pid; INCLUSIVE — the walk starts at and tests this pid. */
    pid?: number | null;
    /** Explicit participant; outranks the ancestor walk. */
    participant?: string | null;
    /** Explicit address (`uds:` or `activation:`); outranks the ancestor walk. */
    address?: string | null;
    /** false skips the inherited env fallback. */
    inherit?: boolean;
}

/** The two address schemes a dispatcher may carry (CORE-2726). */
export function isDispatcherAddress(value: string): boolean {
    return /^uds:.+$/.test(value) || /^activation:\S+$/.test(value);
}

/**
 * One dispatcher answer with its provenance, for callers outside xt
 * (CORE-2726): explicit input outranks the ancestor walk, the walk reports its
 * diagnostics, and `inherit: false` keeps an in-process caller from reading a
 * launched session's inherited value. Never throws.
 */
export function resolveDispatcherReport(
    query: DispatcherQuery = {},
    deps: DispatcherIdentityDeps = {},
): DispatcherResolution {
    const participant = clean(query.participant);
    const address = clean(query.address);
    if (participant || address) {
        const explicit: DispatcherResolution = { source: 'explicit', procStartChecked: false, skipped: [] };
        if (participant) explicit.participant = participant;
        if (address) explicit.address = address;
        return explicit;
    }
    const walkDeps: DispatcherIdentityDeps = { ...deps, inherit: query.inherit ?? deps.inherit };
    const startPid = query.pid ?? null;
    if (typeof startPid === 'number') walkDeps.startPid = startPid;
    return resolveDispatcherResolution(walkDeps);
}

/** The merge guard's switch; the launcher owns the default (CORE-2528). */
export const MERGE_GUARD_VAR = 'XTRM_MERGE_GUARD';

/**
 * The full dispatcher-identity env for a worker named `workerName`.
 * Observed values only; unknown keys are absent.
 */
export function buildDispatcherEnv(workerName: string, deps: DispatcherIdentityDeps = {}): Record<string, string> {
    const env = deps.env ?? process.env;
    const out: Record<string, string> = {};
    const holder = clean(workerName);
    if (holder) {
        out[SUBSTRATE_HOLDER_VAR] = holder;
        // Git identity follows the holder, never the inherited environment.
        if (deps.gitEmail !== undefined) {
            Object.assign(out, buildGitIdentityEnv({ holder, email: deps.gitEmail }));
        }
    }
    const agentName = cleanAgentName(deps.agentName);
    if (agentName) out[XTRM_AGENT_NAME_VAR] = agentName;

    // The merge guard is on by construction for every launched agent session: an
    // operator turns it off deliberately (XTRM_MERGE_GUARD=off) instead of having to
    // remember to turn it on. An inherited value is forwarded EXPLICITLY, because a
    // new tmux session or window starts from the tmux server's env and never sees
    // this process's environment (CORE-2528 review).
    out[MERGE_GUARD_VAR] = clean(env[MERGE_GUARD_VAR]) ?? 'on';

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
        // Pid liveness with reuse protection, exactly as the ancestor walk does
        // (compareStartTime): a dead pid is skipped, and a procStart — clock
        // ticks, or a Pi entry's `ps lstart` date string when boot time and
        // CLK_TCK are readable — that disagrees with the live process start time
        // means the pid was reused. A probe failure keeps the entry (unknown,
        // not dead).
        if (typeof entry.pid === 'number') {
            const filePid = Number(file.replace(/\.json$/, ''));
            if (Number.isInteger(filePid) && entry.pid !== filePid) continue;
            let info: ProcessInfo | null = null;
            try {
                info = readProcess(entry.pid);
            } catch { /* keep on probe failure */ }
            if (!info) continue;
            const startCheck = compareStartTime(clean(entry.procStart), info.startTime, deps);
            if (startCheck.checked && !startCheck.agrees) continue;
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
