// Placement rule for a launch (CORE-2776, CORE-2802; docs/tmux-placement.md).
//
// The target session of a launch is resolved in one order: the explicit --session flag,
// the caller's own session taken from its identity, the configured default session in
// ~/.xtrm/config/launch.json, and a new session only as a last resort, announced on
// stderr. The caller's identity is not only $TMUX: a process without $TMUX (a dispatched
// agent, an in-process specialist, the app) still names its session through its pane id
// or the launcher's exports.
//
// Every probe is bound to the socket the identity came from (CORE-2802 review). A pane id
// or a session id is only unique per tmux server, so resolving `%0` against whichever
// server tmux would pick by default can land a launch in a stranger's session. The socket
// is `$TMUX`'s first field, else the socket the launcher recorded in
// `XTRM_SESSION_SOCKET`; when neither is known the identity is not trusted at all and the
// launcher says so. A recorded socket that no server answers on is dropped rather than
// used: `tmux -S <dead path> new-session` would start a second, invisible server there.
// The binding is part of the resolution result (`ResolvedPlacement.socketArgs`), so every
// later call for that seat uses the socket the decision was made on.
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export type PlacementKind = 'current' | 'session' | 'window' | 'pane' | 'workers';

/**
 * The one refusal a `--window` launch can give (CORE-2802): pi, claude and codex all resolve
 * the target session with `resolvePlacement`, so the message is stated once and cannot drift
 * between runtimes.
 */
export const WINDOW_REQUIRES_SESSION =
    '--window requires a tmux session: run inside tmux, launch from an agent whose session is known, or set "session" in the launch config';

export interface LaunchPlacementConfig {
    version: 1;
    session?: string;
    workersMaxPanes: number;
    placement: Record<string, string>;
}

export interface PlacementOptions {
    role?: string;
    pane?: string;
    workers?: boolean;
    window?: boolean;
    windowName?: string;
    session?: string;
    layout?: string;
    newSession?: boolean;
    insideTmux: boolean;
}

export interface ResolvedPlacement {
    kind: PlacementKind;
    session?: string;
    target?: string;
    windowName?: string;
    layout?: string;
    maxPanes: number;
    existingWindow?: boolean;
    /**
     * `-S <socket>` of the server this decision was made on (CORE-2802 review). Every call
     * for this seat must use it: the create verb, the pane options, the identity publish,
     * the layout and — above all — the failure cleanup. Empty means the default server.
     */
    socketArgs: string[];
}

export interface PlacementDeps {
    home?: string;
    readFile?: (file: string) => string;
    exists?: (file: string) => boolean;
    tmux?: (args: string[]) => { status: number | null; stdout?: string; stderr?: string };
    /**
     * CORE-2802: the environment that carries the caller's tmux identity. It defaults to
     * process.env; pass `env: {}` to state that the caller has no identity at all, so a
     * test never depends on the host it runs on.
     */
    env?: NodeJS.ProcessEnv;
}

const DEFAULT_MAX_PANES = 4;
const CONFIG_ENV = 'XTRM_LAUNCH_CONFIG';
/** CORE-2802: the tmux socket the recorded identity belongs to (set by the launcher). */
export const TMUX_SOCKET_ENV = 'XTRM_SESSION_SOCKET';
const PLACEMENT_VALUES = new Set(['workers', 'window', 'session', 'current']);
const LAYOUT_RE = /^[a-z][a-z0-9-]*$/;
/** An exact tmux session id (`$N`): the only form a probe result is trusted in. */
const SESSION_ID_RE = /^\$\d+$/;
/** A caller-supplied or inherited tmux target this module is willing to hand to tmux. */
const TARGET_RE = /^[A-Za-z0-9_.%$-]+$/;
const PANE_ID_RE = /^%\d+$/;
/**
 * The caller's own session, in identity order: what the launcher exported at launch,
 * then the dispatcher relation it recorded (CORE-2801). Every name already exists; the
 * dispatcher's pane (XTRM_PARENT_PANE_ID) is the one that survives when a worker shell
 * keeps no session of its own.
 */
const CALLER_SESSION_ENV = ['XTRM_SESSION_ID', 'XTRM_SESSION_NAME', 'XTRM_PARENT_SESSION_ID', 'XTRM_PARENT_PANE_ID'] as const;

export function launchConfigPath(home = os.homedir()): string {
    return process.env[CONFIG_ENV] || path.join(home, '.xtrm', 'config', 'launch.json');
}

function invalid(file: string, detail: string): never {
    throw new Error(`invalid launch config ${file}: ${detail}`);
}

export function parseLaunchPlacementConfig(raw: unknown, file = '<launch.json>'): LaunchPlacementConfig {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(file, 'expected an object');
    const value = raw as Record<string, unknown>;
    if (value.version !== 1) invalid(file, 'version must be 1');
    const max = value.workersMaxPanes === undefined ? DEFAULT_MAX_PANES : value.workersMaxPanes;
    if (!Number.isInteger(max) || (max as number) < 1) invalid(file, 'workersMaxPanes must be a positive integer');
    if (value.session !== undefined && (typeof value.session !== 'string' || !value.session.trim())) invalid(file, 'session must be a non-empty string');
    if (!value.placement || typeof value.placement !== 'object' || Array.isArray(value.placement)) invalid(file, 'placement must be an object');
    const placement: Record<string, string> = {};
    for (const [role, rawValue] of Object.entries(value.placement as Record<string, unknown>)) {
        if (typeof rawValue !== 'string' || !rawValue.trim()) invalid(file, `placement.${role} must be a non-empty string`);
        const selected = rawValue.trim();
        if (!PLACEMENT_VALUES.has(selected) && !selected.startsWith('pane:')) invalid(file, `placement.${role} has unsupported value '${selected}'`);
        if (selected.startsWith('pane:') && !selected.slice(5).trim()) invalid(file, `placement.${role} pane target is empty`);
        placement[role] = selected;
    }
    return { version: 1, session: typeof value.session === 'string' ? value.session.trim() : undefined, workersMaxPanes: max as number, placement };
}

export function loadLaunchPlacementConfig(deps: PlacementDeps = {}): LaunchPlacementConfig | null {
    const file = launchConfigPath(deps.home);
    const exists = deps.exists ?? existsSync;
    if (!exists(file)) return null;
    const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
    let parsed: unknown;
    try {
        parsed = JSON.parse(read(file));
    } catch (error) {
        throw new Error(`invalid launch config ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseLaunchPlacementConfig(parsed, file);
}

/**
 * The socket a `$TMUX` value names (its first comma-separated field) (CORE-2802 review).
 * No socket is inferred from the uid or the system default: an inferred socket would be
 * exactly the guess that lets a private server's `%0` collide with the default one's.
 */
function clientSocket(env: NodeJS.ProcessEnv): string | undefined {
    const [socket] = (env.TMUX ?? '').trim().split(',');
    return socket || undefined;
}

/** One tmux call with the argv the binary receives, so `-S` is visible to every caller. */
function tmuxRun(args: string[], deps: PlacementDeps): { status: number | null; stdout?: string; stderr?: string } {
    const run = deps.tmux
        ?? ((argv: string[]) => spawnSync('tmux', argv, { encoding: 'utf8', stdio: 'pipe' }));
    try {
        return run(args) ?? { status: null };
    } catch {
        // A missing server or binary is an absent answer, never a failed launch decision.
        return { status: null };
    }
}

function tmuxCall(socketArgs: string[], args: string[], deps: PlacementDeps): string {
    const result = tmuxRun([...socketArgs, ...args], deps);
    if (result.status !== 0) return '';
    return (result.stdout ?? '').trim();
}

/** The socket binding a launch resolved, and the stale socket it had to drop. */
export interface SocketBinding {
    /** `-S <socket>` for every tmux call of this launch; empty when it may use the default server. */
    args: string[];
    /** A recorded socket that no server answered on: dropped for this launch, said so on stderr. */
    stale?: string;
}

/**
 * Bind a launch to the tmux server its identity belongs to (CORE-2802 review). `$TMUX` is
 * a live client, so its socket is live by definition. `XTRM_SESSION_SOCKET` is only a
 * record, so it is confirmed first: a dead path would either abort the launch or — for
 * `new-session` — start a second server at that path, invisible to the caller and to the
 * operator. A recorded socket that does not answer is dropped with one note.
 */
export function resolveSocketBinding(deps: PlacementDeps = {}, announce = true): SocketBinding {
    const env = deps.env ?? process.env;
    const client = clientSocket(env);
    if (client) return { args: ['-S', client] };
    const recorded = (env[TMUX_SOCKET_ENV] ?? '').trim();
    if (!recorded) return { args: [] };
    if (tmuxCall(['-S', recorded], ['display-message', '-p', '#{pid}'], deps)) return { args: ['-S', recorded] };
    if (announce) {
        process.stderr.write(`warning: ${recorded} is recorded as this seat's tmux server, but nothing answers there; creating on the default server\n`);
    }
    return { args: [], stale: recorded };
}

/**
 * The session id of one tmux target, or undefined when the target is unsafe, absent or
 * gone. A value that no longer resolves (a recycled pane id, a closed session) is not
 * an identity: the caller falls through to the next source.
 */
function sessionIdOf(target: string | undefined, socketArgs: string[], deps: PlacementDeps): string | undefined {
    if (target !== undefined && !TARGET_RE.test(target)) return undefined;
    const args = target === undefined
        ? ['display-message', '-p', '#{session_id}']
        : ['display-message', '-p', '-t', target, '#{session_id}'];
    const id = tmuxCall(socketArgs, args, deps);
    return SESSION_ID_RE.test(id) ? id : undefined;
}

/**
 * The tmux session the caller belongs to (CORE-2802). `$TMUX` alone is not enough: a
 * dispatched agent, an in-process specialist and the app can lack it while their pane
 * id or their exported identity still names the session they live in.
 *
 * Order: the caller's own pane (which works without `$TMUX`), the current session of the
 * tmux server the caller talks to, then the identity the launcher exported. Every source
 * is validated against the live server, so a stale variable never places a launch.
 */
export function resolveCallerSession(deps: PlacementDeps = {}, announce = true): string | undefined {
    const socket = resolveSocketBinding(deps, false);
    return callerSessionOn(socket, deps, announce && !socket.stale);
}

function callerSessionOn(socket: SocketBinding, deps: PlacementDeps, announce: boolean): string | undefined {
    const env = deps.env ?? process.env;
    if (socket.args.length === 0) {
        // A pane id or an exported id names a session on one server only. Without the socket
        // that id came from, confirming it would confirm whichever server tmux defaults to,
        // so the identity is not trusted and the reason is announced (CORE-2802 review).
        // After a dropped stale socket the reason is already on stderr, so it is said once.
        const claim = [env.TMUX_PANE, ...CALLER_SESSION_ENV.map(key => env[key])]
            .map(value => (value ?? '').trim())
            .find(Boolean);
        if (claim && announce) {
            process.stderr.write(`warning: ${claim} names a tmux session, but the server it belongs to is unknown; not placing this launch in it (set $TMUX or ${TMUX_SOCKET_ENV})\n`);
        }
        return undefined;
    }
    const paneId = (env.TMUX_PANE ?? '').trim();
    if (PANE_ID_RE.test(paneId)) {
        const fromPane = sessionIdOf(paneId, socket.args, deps);
        if (fromPane) return fromPane;
    }
    if (env.TMUX) {
        const live = sessionIdOf(undefined, socket.args, deps);
        if (live) return live;
    }
    for (const key of CALLER_SESSION_ENV) {
        const value = (env[key] ?? '').trim();
        if (!value) continue;
        const resolved = sessionIdOf(value, socket.args, deps);
        if (resolved) return resolved;
    }
    return undefined;
}

/**
 * The last resort (CORE-2802). When a flag or a role rule asked for a session and none
 * resolved, the fallback is announced. A plain launch that asked for nothing keeps its
 * silent new session: outside tmux that session is the product, not a fallback.
 */
function newSessionPlacement(session: string | undefined, maxPanes: number, socketArgs: string[], announce = true): ResolvedPlacement {
    if (announce) process.stderr.write('warning: no tmux session to place this launch in; launching a new session instead\n');
    return { kind: 'session', session, maxPanes, socketArgs };
}

function resolvePaneTarget(target: string, session: string | undefined, deps: PlacementDeps): string {
    if (/^%\d+$/.test(target)) return target;
    if (target.includes(':') || !session) return target;
    return `${session}:${target}`;
}

function workersTarget(session: string | undefined, maxPanes: number, socketArgs: string[], deps: PlacementDeps): { target: string; name: string } | null {
    if (!session) return null;
    // '|' and not a TAB: tmux rewrites a control character inside a format argument to '_'.
    const listing = tmuxCall(socketArgs, ['list-windows', '-t', session, '-F', '#{window_id}|#{window_name}|#{window_panes}'], deps);
    const windows = listing.split(/\r?\n/).map(line => line.split('|')).filter(row => row.length >= 3);
    for (const [id, name, count] of windows) {
        if (/^workers(?:-\d+)?$/.test(name) && Number(count) < maxPanes) return { target: id, name };
    }
    const numbered = windows.reduce((highest, [, name]) => {
        const match = /^workers-(\d+)$/.exec(name);
        return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
    const hasWorkersWindow = windows.some(([, name]) => /^workers(?:-\d+)?$/.test(name));
    return { target: `${session}:`, name: hasWorkersWindow ? `workers-${Math.max(numbered, 1) + 1}` : 'workers' };
}

export function resolvePlacement(options: PlacementOptions, deps: PlacementDeps = {}): ResolvedPlacement {
    const config = loadLaunchPlacementConfig(deps);
    const explicit = options.pane ? `pane:${options.pane}` : options.workers ? 'workers' : options.window ? 'window' : options.newSession ? 'session' : undefined;
    const configured = !explicit && options.role
        ? config?.placement[options.role] ?? config?.placement.default
        : !explicit ? config?.placement.default : undefined;
    const selected = explicit ?? configured;
    const maxPanes = config?.workersMaxPanes ?? DEFAULT_MAX_PANES;
    // CORE-2802: one placement-session order. The flag is explicit intent, the caller's own
    // session is where a dispatched agent belongs, and the configured session is the
    // project default. The socket is resolved first, because an id means nothing without
    // the server it belongs to; it is part of the result so the create verb and every call
    // after it use the same server. resolveCallerSession probes only when two of them are
    // missing, and it stays silent on the plain path: there a new session is the product,
    // so an untrusted identity is not worth a warning on a stream scripts scrape (K1).
    const socket = resolveSocketBinding(deps, Boolean(selected));
    const session = options.session ?? callerSessionOn(socket, deps, Boolean(selected) && !socket.stale) ?? config?.session;
    if (!selected) {
        if (options.insideTmux) return { kind: 'current', session, maxPanes, socketArgs: socket.args };
        return session
            ? { kind: 'window', session, windowName: options.windowName, layout: options.layout, maxPanes, socketArgs: socket.args }
            : newSessionPlacement(session, maxPanes, socket.args, false);
    }
    if (selected === 'current') {
        // 'current' needs the caller's own pane. Without $TMUX it becomes a window of the
        // resolved session, and a new session when there is none.
        if (options.insideTmux) return { kind: 'current', session, maxPanes, socketArgs: socket.args };
        return session
            ? { kind: 'window', session, windowName: options.windowName, layout: options.layout, maxPanes, socketArgs: socket.args }
            : newSessionPlacement(session, maxPanes, socket.args);
    }
    if (selected === 'session') return { kind: 'session', session, maxPanes, socketArgs: socket.args };
    if (selected === 'workers') {
        const worker = workersTarget(session, maxPanes, socket.args, deps);
        if (worker) {
            return { kind: 'workers', session, target: worker.target, windowName: worker.name, layout: options.layout ?? 'tiled', maxPanes, existingWindow: worker.target.startsWith('@'), socketArgs: socket.args };
        }
        return newSessionPlacement(session, maxPanes, socket.args);
    }
    if (selected === 'window') {
        return session
            ? { kind: 'window', session, windowName: options.windowName, layout: options.layout, maxPanes, socketArgs: socket.args }
            : newSessionPlacement(session, maxPanes, socket.args);
    }
    const target = selected.slice(5);
    // An absolute pane id is its own target: it needs no session to resolve against.
    if (!session && !PANE_ID_RE.test(target)) return newSessionPlacement(session, maxPanes, socket.args);
    return { kind: 'pane', session, target: resolvePaneTarget(target, session, deps), layout: options.layout ?? 'tiled', maxPanes, socketArgs: socket.args };
}

export interface PlacementCreateArgs {
    /** The session the launch lands in: the resolved one, the live one, or the new one. */
    targetSession: string;
    /** Window name for a window placement. */
    windowName: string;
    /** Working directory of the new pane. */
    worktreePath: string;
    /** Session name that a last-resort `new-session` creates. */
    newSessionName: string;
}

/**
 * The tmux verb that creates the pane for a resolved placement (CORE-2776, CORE-2802).
 * Pure: the caller supplies the resolved session, so a placement into the caller's own
 * session produces the same arguments whether or not the caller has `$TMUX`. The socket
 * comes from the placement itself, never from a fresh look at the environment: a decision
 * made on one server must be executed on that server.
 */
export function placementCreateArgs(placement: ResolvedPlacement, args: PlacementCreateArgs): string[] {
    const target = placement.target ?? args.targetSession;
    const socket = placement.socketArgs;
    if (placement.kind === 'pane' || (placement.kind === 'workers' && placement.existingWindow)) {
        return [...socket, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', target, '-c', args.worktreePath];
    }
    if (placement.kind === 'workers' || placement.kind === 'window') {
        return [...socket, 'new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${args.targetSession}:`, '-n', placement.windowName ?? args.windowName, '-c', args.worktreePath];
    }
    return [...socket, 'new-session', '-d', '-s', args.newSessionName, '-c', args.worktreePath];
}

export function validateLayout(layout: string | undefined): void {
    if (layout !== undefined && !LAYOUT_RE.test(layout)) throw new Error(`invalid tmux layout '${layout}'`);
}
