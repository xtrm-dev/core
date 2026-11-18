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
 * CORE-2728 (D8, operator decision b): the same resolution is also PERSISTED on
 * the launch's Substrate binding (`recordDispatcherBinding`), so `xt attach` can
 * restore the ORIGINAL dispatcher (`attachDispatcherEnv`) instead of guessing
 * from whoever typed attach.
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
import { describeSbFailure } from './sb-receipt.js';
import type { TmuxProbe } from './session-identity.js';

export const SUBSTRATE_HOLDER_VAR = 'SUBSTRATE_HOLDER';
/** The human-readable agent name (`<repo>-xt-<runtime>-<name>`), CORE-2606. */
export const XTRM_AGENT_NAME_VAR = 'XTRM_AGENT_NAME';
export const XTRM_DISPATCHER_NAME_VAR = 'XTRM_DISPATCHER_NAME';
export const XTRM_DISPATCHER_ADDRESS_VAR = 'XTRM_DISPATCHER_ADDRESS';
/**
 * The dispatcher's Substrate participant (CORE-2727, operator decision
 * 2026-11-18): the value a worker addresses by messaging and claims by name.
 * `XTRM_DISPATCHER_NAME` stays display-only.
 */
export const XTRM_DISPATCHER_PARTICIPANT_VAR = 'XTRM_DISPATCHER_PARTICIPANT';
export const XTRM_PARENT_SESSION_ID_VAR = 'XTRM_PARENT_SESSION_ID';
export const XTRM_PARENT_PANE_ID_VAR = 'XTRM_PARENT_PANE_ID';

/** Every key this module owns; launchers strip them from inherited env first. */
export const DISPATCHER_ENV_KEYS = [
    SUBSTRATE_HOLDER_VAR,
    XTRM_AGENT_NAME_VAR,
    XTRM_DISPATCHER_NAME_VAR,
    XTRM_DISPATCHER_ADDRESS_VAR,
    XTRM_DISPATCHER_PARTICIPANT_VAR,
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
    /** Kernel clock ticks per second (`getconf CLK_TCK`); null when unknowable. */
    clockTicks?: () => number | null;
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
function readProcessEnvironment(pid: number): NodeJS.ProcessEnv | null {
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
function bootTimeSeconds(): number | null {
    try {
        const match = /^btime\s+(\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
        return match ? Number(match[1]) : null;
    } catch {
        return null;
    }
}

/**
 * Kernel clock ticks per second (`getconf CLK_TCK`), null when unknowable.
 * Never a guessed default: a wrong value would silently mis-date every
 * converted start time, so an unreadable CLK_TCK means "not checked".
 */
function clockTicksPerSecond(): number | null {
    try {
        const result = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', stdio: 'pipe' });
        const ticks = Number(String(result.stdout ?? '').trim());
        if (result.status === 0 && Number.isInteger(ticks) && ticks > 0) return ticks;
    } catch { /* absent */ }
    return null;
}

/** A start-time comparison: did it happen, and did it agree. */
interface StartCheck {
    checked: boolean;
    agrees: boolean;
}

/** `ps lstart` has one-second resolution; the btime conversion truncates to a second. */
const LSTART_TOLERANCE_SECONDS = 2;
/** Every real UTC offset and DST step is a multiple of 15 minutes. */
const QUARTER_HOUR_SECONDS = 900;
/** The largest zone difference any host can show (UTC-12..UTC+14). */
const MAX_ZONE_OFFSET_SECONDS = 14 * 3600;

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
    if (ticks === null || boot === null || perSecond === null || !Number.isInteger(perSecond) || perSecond <= 0) {
        return { checked: false, agrees: true };
    }
    const live = boot + ticks / perSecond;
    const delta = Math.abs(live - lstart / 1000);
    if (delta <= LSTART_TOLERANCE_SECONDS) return { checked: true, agrees: true };
    // Time-zone artifact (CORE-2726 fix 1, option B). The lstart string was
    // formatted by the WRITER's process, and `Date.parse` reads it as the
    // READER's local time, so two different zones — or a DST change between the
    // writer and the reader — shift the parsed instant by a whole number of
    // quarter hours (every real UTC offset and DST step is a multiple of 15
    // minutes). Option A (spawn `ps -o lstart=` for the live pid and compare
    // strings) would cost a spawn per registry entry and cannot help when the
    // writer's zone was different anyway; option C (always report unchecked)
    // would drop the reuse guard exactly when it matters. So an offset that is a
    // whole quarter hour (|offset| <= 14 h) is treated as a zone difference: the
    // entry stays live and the check is reported as done. The residual gap is a
    // reused pid that started exactly N*15 min after the old one; anything else
    // still disagrees.
    const remainder = delta % QUARTER_HOUR_SECONDS;
    const zoneAligned = delta <= MAX_ZONE_OFFSET_SECONDS
        && (remainder <= LSTART_TOLERANCE_SECONDS || QUARTER_HOUR_SECONDS - remainder <= LSTART_TOLERANCE_SECONDS);
    return { checked: true, agrees: zoneAligned };
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
/** The dispatcher env a launch exports, plus the resolution it came from (CORE-2728). */
export interface DispatcherEnvResolution {
    env: Record<string, string>;
    resolution: DispatcherResolution;
}

/**
 * `buildDispatcherEnv` and its resolution in one pass (CORE-2728): the launcher
 * records the dispatcher on the Substrate binding from the SAME resolution the
 * env exports, so the pane and the store can never name different sessions.
 */
export function buildDispatcherEnvWithResolution(
    workerName: string,
    deps: DispatcherIdentityDeps = {},
): DispatcherEnvResolution {
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

    // CORE-2727: the participant is the dispatcher's Substrate identity, taken from
    // the same resolution the display name comes from, so the two can never name
    // different sessions. Unknown stays absent.
    const dispatcher = resolveDispatcherResolution(deps);
    if (dispatcher.name) out[XTRM_DISPATCHER_NAME_VAR] = dispatcher.name;
    if (dispatcher.address) out[XTRM_DISPATCHER_ADDRESS_VAR] = dispatcher.address;
    if (dispatcher.participant) out[XTRM_DISPATCHER_PARTICIPANT_VAR] = dispatcher.participant;

    const pane = env.TMUX ? clean(env.TMUX_PANE) : null;
    if (pane && /^%\d+$/.test(pane)) {
        out[XTRM_PARENT_PANE_ID_VAR] = pane;
        try {
            const result = (deps.tmux ?? defaultTmux)(['display-message', '-p', '-t', pane, '-F', '#{session_id}']);
            const sessionId = result.status === 0 ? clean(result.stdout) : null;
            if (sessionId && /^\$\d+$/.test(sessionId)) out[XTRM_PARENT_SESSION_ID_VAR] = sessionId;
        } catch { /* absent */ }
    }
    return { env: out, resolution: dispatcher };
}

/** The env record only, for callers that do not need the resolution. */
export function buildDispatcherEnv(workerName: string, deps: DispatcherIdentityDeps = {}): Record<string, string> {
    return buildDispatcherEnvWithResolution(workerName, deps).env;
}

/** One live session-registry entry that carries a messaging socket. */
interface LiveSessionEntry {
    pid?: number;
    address: string;
    name?: string;
    sessionId?: string;
}

/**
 * Every live registry entry with a messaging socket, with its pid liveness and
 * pid-reuse check applied. Shared by the name-keyed and holder-keyed lookups so
 * both apply the same guard (CORE-2728).
 */
function collectLiveSocketSessions(deps: DispatcherIdentityDeps = {}): LiveSessionEntry[] {
    const sessionsDir = deps.sessionsDir ?? path.join(os.homedir(), '.claude', 'sessions');
    const readProcess = deps.readProcess ?? readProcessInfo;
    const found: LiveSessionEntry[] = [];
    // CORE-2726 fix 6: the boot time and the clock ticks answer for the whole
    // host, so read them at most once per call instead of once per registry
    // file (getconf is a spawn).
    let bootCache: number | null | undefined;
    let tickCache: number | null | undefined;
    const memoDeps: DispatcherIdentityDeps = {
        ...deps,
        bootTime: () => {
            if (bootCache === undefined) bootCache = (deps.bootTime ?? bootTimeSeconds)();
            return bootCache;
        },
        clockTicks: () => {
            if (tickCache === undefined) tickCache = (deps.clockTicks ?? clockTicksPerSecond)();
            return tickCache;
        },
    };
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
            const startCheck = compareStartTime(clean(entry.procStart), info.startTime, memoDeps);
            if (startCheck.checked && !startCheck.agrees) continue;
        }
        const live: LiveSessionEntry = { address: `uds:${socket}` };
        if (typeof entry.pid === 'number') live.pid = entry.pid;
        const name = clean(entry.name);
        if (name) live.name = name;
        const sessionId = clean(entry.sessionId);
        if (sessionId) live.sessionId = sessionId;
        found.push(live);
    }
    return found;
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
): Array<{ pid?: number; address: string }> {
    const found = collectLiveSocketSessions(deps).filter((entry) => entry.name === participant);
    if (found.length > 1) {
        const candidates = found.map((f) => `pid ${String(f.pid)} at ${f.address}`).join(', ');
        throw new Error(`ambiguous dispatcher participant "${participant}": ${candidates}`);
    }
    // CORE-2727: the matched PID travels with the address, because the participant
    // is that process's own SUBSTRATE_HOLDER — never the name it was looked up by.
    return found.map((f) => ({ ...(typeof f.pid === 'number' ? { pid: f.pid } : {}), address: f.address }));
}

/**
 * Live dispatcher sessions whose PROCESS carries this SUBSTRATE_HOLDER
 * (CORE-2728). The registry `name` is the display name and may differ from the
 * participant, so a participant lookup compares the ancestor process's own
 * environment instead. Never throws.
 */
function findLiveDispatchersByHolder(
    participant: string,
    deps: DispatcherIdentityDeps = {},
): LiveSessionEntry[] {
    const readEnviron = deps.readEnviron ?? readProcessEnvironment;
    return collectLiveSocketSessions(deps).filter((entry) => typeof entry.pid === 'number'
        && clean(holderOf(readEnviron, entry.pid)) === participant);
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
    const live = findLiveDispatchers(want, deps)[0];
    return live ? { name: want, address: live.address } : null;
}

/**
 * Fresh dispatcher env for a session restored from a persisted binding
 * (CORE-2728, operator decision b): `xt attach` knows the ORIGINAL dispatcher's
 * Substrate participant from the launch binding, never from the attacher's
 * environment or ancestor chain. The live sessions are matched on
 * SUBSTRATE_HOLDER (the participant), not on the display name. The participant
 * always survives; the address (and display name) only when a live session
 * carries a messaging socket. Unknown stays absent; never throws.
 */
export function refreshDispatcherEnvByParticipant(
    participant: string,
    deps: DispatcherIdentityDeps = {},
): Record<string, string> {
    const out: Record<string, string> = {};
    // CORE-2740 F1: the participant is read back from a stored binding, so it is
    // data, not a value this process chose. A value that is not a Substrate label
    // (a newline, an ESC, an over-long string) is OMITTED, never trimmed into a
    // different identity: unknown stays absent and the caller falls back.
    const want = clean(participant);
    if (!want || !isDispatcherLabel(want)) return out;
    let live: LiveSessionEntry[] = [];
    try {
        live = findLiveDispatchersByHolder(want, deps);
    } catch { /* lookup failure means unknown, not absent participant */ }
    if (live.length > 1) {
        const candidates = live.map((entry) => `pid ${String(entry.pid)} at ${entry.address}`).join(', ');
        process.stderr.write(`xt attach: ambiguous live dispatcher participant "${want}": ${candidates}; the address stays absent\n`);
        out[XTRM_DISPATCHER_PARTICIPANT_VAR] = want;
        out[XTRM_DISPATCHER_NAME_VAR] = want;
        return out;
    }
    out[XTRM_DISPATCHER_PARTICIPANT_VAR] = want;
    const hit = live[0];
    if (hit) {
        out[XTRM_DISPATCHER_ADDRESS_VAR] = hit.address;
        // CORE-2740 F1: the registry name is display-only and may come from another
        // process's record, so it is reduced to one bounded line before export.
        out[XTRM_DISPATCHER_NAME_VAR] = cleanAgentName(hit.name) ?? want;
        return out;
    }
    // No live session: the participant is still the answer to "who dispatched me".
    out[XTRM_DISPATCHER_NAME_VAR] = want;
    return out;
}

/**
 * The dispatcher session id of a participant, when a live session of that holder
 * carries a canonical lowercase UUID (the Claude session id, CORE-2728). Null
 * when unknown; a tmux `$N` is never a dispatcher session id here.
 */
export function resolveDispatcherSessionForParticipant(
    participant: string,
    deps: DispatcherIdentityDeps = {},
): string | null {
    const want = clean(participant);
    if (!want) return null;
    let live: LiveSessionEntry[] = [];
    try {
        live = findLiveDispatchersByHolder(want, deps);
    } catch {
        return null;
    }
    for (const entry of live) {
        if (entry.sessionId && LOWERCASE_UUID.test(entry.sessionId)) return entry.sessionId;
    }
    return null;
}

/** A canonical lowercase UUID; the only dispatcher session form Substrate stores. */
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when `value` is a canonical lowercase UUID (a Claude session id). */
export function isLowercaseUuid(value: unknown): boolean {
    return typeof value === 'string' && LOWERCASE_UUID.test(value);
}

/**
 * A Substrate identity label: what `sb provenance dispatch --dispatcher-participant`
 * accepts (shell-safe, at most 128 characters). A value that would be refused is
 * never passed, so a launch cannot fail on it.
 */
const DISPATCHER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/;
export function isDispatcherLabel(value: unknown): boolean {
    return typeof value === 'string' && value.length <= 128 && DISPATCHER_LABEL.test(value);
}

/** One `sb` call; injectable so tests never touch a real store. */
export type SbRunner = (
    args: string[],
    env?: NodeJS.ProcessEnv,
    timeoutMs?: number,
) => { ok: boolean; error?: string; stdout?: string };

/** A provenance call a launch or an attach may wait for; never the whole budget. */
export const PROVENANCE_TIMEOUT_MS = 5_000;

function defaultSbRunner(args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = PROVENANCE_TIMEOUT_MS) {
    const result = spawnSync('sb', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
    });
    const stdout = result.stdout ?? '';
    if (result.status === 0) return { ok: true, stdout };
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return {
        ok: false,
        stdout,
        error: describeSbFailure({
            binary: 'sb',
            status: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            spawnError: timedOut ? `no answer in ${timeoutMs} ms` : (result.error?.message ?? null),
        }),
    };
}

/** The dispatcher a launch binding recorded, and the values needed to restore it. */
export interface DispatcherBindingRecord {
    participant: string;
    sessionId?: string;
}

/** One trace binding row as the restore selection reads it (CORE-2740). */
interface TraceBindingRow {
    id: string;
    /** The dispatcher, when this binding recorded one. */
    participant?: string;
    sessionId?: string;
    /** The worktree the launch bound its execution to. */
    workspace?: string;
    createdAt: number;
}

/**
 * Every binding `sb provenance trace <ref> --json` lists, newest first — also
 * the ones that recorded no dispatcher, because a worker's own binding without
 * a dispatcher is still an answer ("absent"), not a licence to read the next
 * binding's (CORE-2740 F2).
 */
function parseTraceBindingRows(stdout: string | null | undefined): TraceBindingRow[] {
    const text = (stdout ?? '').trim();
    if (!text.startsWith('{')) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }
    const envelope = parsed as { bindings?: unknown; data?: { bindings?: unknown } | null };
    const raw = envelope.data && typeof envelope.data === 'object' && Array.isArray(envelope.data.bindings)
        ? envelope.data.bindings
        : envelope.bindings;
    if (!Array.isArray(raw)) return [];
    const rows: TraceBindingRow[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const binding = item as Record<string, unknown>;
        const row: TraceBindingRow = {
            id: clean(binding.id) ?? '',
            createdAt: bindingCreatedAt(binding.createdAt),
        };
        const participant = clean(binding.dispatcherParticipantId);
        if (participant) row.participant = participant;
        const sessionId = clean(binding.dispatcherSessionId);
        if (sessionId) row.sessionId = sessionId;
        const workspace = clean(binding.workspace);
        if (workspace) row.workspace = workspace;
        rows.push(row);
    }
    // Newest first. sb 0.4.0 emits an integer epoch in milliseconds; an ISO string
    // is accepted too, because the schema never promised a wire type. A missing
    // timestamp is the OLDEST, never "now", and ties break on the binding id —
    // a uuidv7, so lexical order is creation order — which keeps the pick
    // deterministic instead of leaving it to the store's row order.
    rows.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
        if (a.id === b.id) return 0;
        return a.id < b.id ? 1 : -1;
    });
    return rows;
}

/**
 * The launch bindings that name a dispatcher, newest first, from
 * `sb provenance trace <ref> --json` (CORE-2728). Bindings without a dispatcher
 * participant are not an answer here, so the newest one that HAS one wins.
 */
export function parseDispatcherBindings(stdout: string | null | undefined): DispatcherBindingRecord[] {
    const records: DispatcherBindingRecord[] = [];
    for (const row of parseTraceBindingRows(stdout)) {
        const record = bindingRecordOf(row);
        if (record) records.push(record);
    }
    return records;
}

/** The restore-relevant view of one row; null when the row names no dispatcher. */
function bindingRecordOf(row: TraceBindingRow): DispatcherBindingRecord | null {
    if (!row.participant) return null;
    const record: DispatcherBindingRecord = { participant: row.participant };
    if (row.sessionId) record.sessionId = row.sessionId;
    return record;
}

/** Which binding `xt attach` may restore for one worker (CORE-2740 F2). */
export interface DispatcherBindingSelect {
    /** The exact binding the launch recorded in the worker's own session record. */
    bindingId?: string | null;
    /** The worker's own worktree: a binding created anywhere else is not its own. */
    workspace?: string | null;
    /** false when the Issue ref came from a live pane, never from the worker's own record. */
    ownRecord?: boolean;
}

/**
 * The one binding a restore may read (CORE-2740 F2). The order is the defence:
 * an exact id from the worker's own record outranks everything; without it only
 * a binding created in the worker's own worktree may answer; and a ref taken from
 * a live pane may never fall through to "the newest binding on the Issue",
 * because a same-user process could have written that pane.
 */
function selectRestoreBinding(rows: TraceBindingRow[], select: DispatcherBindingSelect): DispatcherBindingRecord | null {
    const wantedId = clean(select.bindingId);
    if (wantedId) {
        const own = rows.find((row) => row.id === wantedId);
        return own ? bindingRecordOf(own) : null;
    }
    const workspace = clean(select.workspace);
    if (workspace) {
        const own = rows.find((row) => row.workspace === workspace && row.participant);
        if (own) return bindingRecordOf(own);
    }
    // A ref taken from a live pane is not the worker's own word: only the
    // workspace match above may answer it.
    if (select.ownRecord === false) return null;
    // Legacy record (launched before CORE-2740, so it names no binding id): the
    // newest binding that names a dispatcher is that launch's own.
    const legacy = rows.find((row) => row.participant);
    return legacy ? bindingRecordOf(legacy) : null;
}

/** A binding's creation instant in epoch ms; a missing or unparseable value is oldest. */
function bindingCreatedAt(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Date.parse(value.trim());
        if (Number.isFinite(parsed)) return parsed;
    }
    return Number.NEGATIVE_INFINITY;
}

/**
 * Read the dispatcher a launch recorded for `ref`; null when none or unreadable.
 * `select` says which binding may answer (CORE-2740 F2); without it the newest
 * binding that names a dispatcher wins, which is the pre-CORE-2740 behaviour.
 */
export function readDispatcherBinding(
    ref: string | null | undefined,
    deps: { env?: NodeJS.ProcessEnv; run?: SbRunner; timeoutMs?: number } & DispatcherBindingSelect = {},
): DispatcherBindingRecord | null {
    const wanted = clean(ref);
    if (!wanted) return null;
    const run = deps.run ?? defaultSbRunner;
    let result: { ok: boolean; stdout?: string; error?: string };
    try {
        result = run(['provenance', 'trace', wanted, '--json'], deps.env ?? process.env, deps.timeoutMs ?? PROVENANCE_TIMEOUT_MS);
    } catch {
        return null;
    }
    if (!result.ok) {
        // CORE-2728 F6: an unreadable binding is not silence — one stderr line
        // names the issue and the reason, and the dispatcher stays ABSENT (never
        // the attacher's).
        process.stderr.write(`xt attach: the launch binding of ${wanted} could not be read (${oneLine(result.error ?? 'sb gave no reason')}); the dispatcher stays absent\n`);
        return null;
    }
    return selectRestoreBinding(parseTraceBindingRows(result.stdout), deps);
}

/**
 * The id of the binding a launch just wrote (CORE-2740 F2): the newest row for
 * `ref` created at or after `sinceMs` in the launch's OWN worktree. The launch
 * stores it in its session record, so `xt attach` restores that binding instead
 * of the newest one on the Issue. Null when unknown; never throws, never warns.
 */
export function findLaunchBindingId(
    ref: string | null | undefined,
    deps: {
        workspace: string | null | undefined;
        sinceMs?: number;
        participant?: string | null;
        env?: NodeJS.ProcessEnv;
        run?: SbRunner;
        timeoutMs?: number;
    },
): string | null {
    const wanted = clean(ref);
    const workspace = clean(deps.workspace);
    if (!wanted || !workspace) return null;
    const run = deps.run ?? defaultSbRunner;
    let result: { ok: boolean; stdout?: string; error?: string };
    try {
        result = run(['provenance', 'trace', wanted, '--json'], deps.env ?? process.env, deps.timeoutMs ?? PROVENANCE_TIMEOUT_MS);
    } catch {
        return null;
    }
    if (!result.ok) return null;
    const since = typeof deps.sinceMs === 'number' && Number.isFinite(deps.sinceMs) ? deps.sinceMs : null;
    const own = parseTraceBindingRows(result.stdout).filter((row) => row.id
        && row.workspace === workspace
        && (since === null || row.createdAt >= since));
    if (own.length === 0) return null;
    // Prefer the row that also names our dispatcher; a launch with no dispatcher
    // leaves that field absent, and the row is still ours by workspace.
    const participant = clean(deps.participant);
    const preferred = participant ? own.find((row) => row.participant === participant) : undefined;
    return (preferred ?? own[0])?.id ?? null;
}

/**
 * The dispatcher env `xt attach` restores for a worker's issue (CORE-2728): the
 * binding the worker's OWN launch wrote, refreshed against the live sessions by
 * its participant. `select` narrows which binding may answer (CORE-2740 F2).
 * No binding — or no issue ref — is no dispatcher: the record is empty so the
 * attacher's own identity CANNOT be adopted.
 */
export function attachDispatcherEnv(
    ref: string | null,
    deps: {
        env?: NodeJS.ProcessEnv;
        run?: SbRunner;
        timeoutMs?: number;
        identity?: DispatcherIdentityDeps;
    } & DispatcherBindingSelect = {},
): Record<string, string> {
    const wanted = clean(ref);
    if (!wanted) return {};
    const binding = readDispatcherBinding(wanted, deps);
    if (!binding) return {};
    return refreshDispatcherEnvByParticipant(binding.participant, deps.identity ?? {});
}

/** What recording the launch dispatcher produced, for the caller's one warning. */
export interface DispatcherBindingWrite {
    /** The exact `sb provenance dispatch` argv, for the golden test. */
    argv: string[];
    written: boolean;
    warning?: string;
}

/**
 * Record who dispatched a launch on the ExecutionBinding (CORE-2728, XTRM-839):
 * `sb provenance dispatch <ref> [--dispatcher-participant <p>]
 * [--dispatcher-session <uuid>]`. Absent values pass no flag — never a
 * placeholder, never an env default. A failed or old `sb` is one warning and
 * never blocks the launch.
 */
export function recordDispatcherBinding(input: {
    ref: string;
    resolution: Pick<DispatcherResolution, 'participant' | 'sessionId'>;
    workspace?: string | null;
    env?: NodeJS.ProcessEnv;
    run?: SbRunner;
    timeoutMs?: number;
}): DispatcherBindingWrite {
    const ref = clean(input.ref);
    if (!ref) return { argv: [], written: false, warning: 'xt: launch carries no bead, so no dispatcher was recorded\n' };
    const argv: string[] = ['provenance', 'dispatch', ref];
    const participant = clean(input.resolution.participant);
    if (participant && isDispatcherLabel(participant)) argv.push('--dispatcher-participant', participant);
    const sessionId = clean(input.resolution.sessionId);
    if (sessionId && isLowercaseUuid(sessionId)) argv.push('--dispatcher-session', sessionId);
    const workspace = clean(input.workspace);
    if (workspace) argv.push('--workspace', workspace);
    const run = input.run ?? defaultSbRunner;
    let result: { ok: boolean; error?: string };
    try {
        result = run(argv, input.env ?? process.env, input.timeoutMs ?? PROVENANCE_TIMEOUT_MS);
    } catch (error) {
        result = { ok: false, error: (error as Error).message };
    }
    if (result.ok) return { argv, written: true };
    return {
        argv,
        written: false,
        warning: `xt: could not record the dispatcher on ${ref} (launch continues): ${oneLine(result.error ?? 'sb gave no reason')}\n`,
    };
}

/** One line, so a warning never spans the launch output. */
function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * The dispatcher keys `env` carries no value for (CORE-2727, D7). A tmux `-e`
 * only ever sets: a pane whose launch exports no value for a key still inherits
 * whatever the tmux server's environment holds, so the pane command must clear
 * these with `env -u`.
 */
export function absentDispatcherEnvKeys(env: Record<string, string>): string[] {
    return DISPATCHER_ENV_KEYS.filter((key) => {
        const value = env[key];
        return typeof value !== 'string' || value.trim() === '';
    });
}

/** Copy of `env` without any dispatcher key, so an inherited value can never leak through. */
export function stripDispatcherEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out = { ...env };
    for (const key of DISPATCHER_ENV_KEYS) delete out[key];
    return out;
}
