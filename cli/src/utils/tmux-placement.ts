import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export type PlacementKind = 'current' | 'session' | 'window' | 'pane' | 'workers';

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
}

export interface PlacementDeps {
    home?: string;
    readFile?: (file: string) => string;
    exists?: (file: string) => boolean;
    tmux?: (args: string[]) => { status: number | null; stdout?: string; stderr?: string };
}

const DEFAULT_MAX_PANES = 4;
const CONFIG_ENV = 'XTRM_LAUNCH_CONFIG';
const PLACEMENT_VALUES = new Set(['workers', 'window', 'session', 'current']);
const LAYOUT_RE = /^[a-z][a-z0-9-]*$/;

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

function tmuxCall(args: string[], deps: PlacementDeps): string {
    const run = deps.tmux ?? ((argv: string[]) => spawnSync('tmux', argv, { encoding: 'utf8', stdio: 'pipe' }));
    const result = run(args);
    if (result.status !== 0) return '';
    return (result.stdout ?? '').trim();
}

function currentSession(deps: PlacementDeps): string | undefined {
    return tmuxCall(['display-message', '-p', '#{session_name}'], deps) || undefined;
}

function resolvePaneTarget(target: string, session: string | undefined, deps: PlacementDeps): string {
    if (/^%\d+$/.test(target)) return target;
    if (target.includes(':') || !session) return target;
    return `${session}:${target}`;
}

function workersTarget(session: string | undefined, maxPanes: number, deps: PlacementDeps): { target: string; name: string } | null {
    if (!session) return null;
    const listing = tmuxCall(['list-windows', '-t', session, '-F', '#{window_id}\t#{window_name}\t#{window_panes}'], deps);
    const windows = listing.split(/\r?\n/).map(line => line.split('\t')).filter(row => row.length >= 3);
    for (const [id, name, count] of windows) {
        if (name.startsWith('workers') && Number(count) < maxPanes) return { target: id, name };
    }
    const numbered = windows.reduce((highest, [, name]) => {
        const match = /^workers-(\d+)$/.exec(name);
        return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
    return { target: `${session}:`, name: numbered === 0 ? 'workers' : `workers-${numbered + 1}` };
}

export function resolvePlacement(options: PlacementOptions, deps: PlacementDeps = {}): ResolvedPlacement {
    const config = loadLaunchPlacementConfig(deps);
    const explicit = options.pane ? `pane:${options.pane}` : options.workers ? 'workers' : options.window ? 'window' : options.newSession ? 'session' : undefined;
    const configured = !explicit && options.role
        ? config?.placement[options.role] ?? config?.placement.default
        : !explicit ? config?.placement.default : undefined;
    const selected = explicit ?? configured;
    const maxPanes = config?.workersMaxPanes ?? DEFAULT_MAX_PANES;
    if (!selected) return { kind: options.insideTmux ? 'current' : 'session', maxPanes };
    if (selected === 'current') return { kind: 'current', session: options.session ?? config?.session, maxPanes };
    if (selected === 'session') return { kind: 'session', session: options.session ?? config?.session, maxPanes };
    const configuredSession = options.session ?? config?.session;
    const querySession = configuredSession ?? (options.insideTmux ? currentSession(deps) : undefined);
    if (selected === 'workers') {
        const worker = workersTarget(querySession, maxPanes, deps);
        if (worker) {
            return { kind: 'workers', session: configuredSession, target: worker.target, windowName: worker.name, layout: options.layout ?? 'tiled', maxPanes, existingWindow: worker.target.startsWith('@') };
        }
        process.stderr.write('warning: --workers requires a tmux session; launching a new session instead\n');
        return { kind: 'session', session: configuredSession, maxPanes };
    }
    if (selected === 'window') {
        return options.insideTmux || configuredSession
            ? { kind: 'window', session: configuredSession, windowName: options.windowName, layout: options.layout, maxPanes }
            : { kind: 'session', maxPanes };
    }
    if (!options.insideTmux && !configuredSession) return { kind: 'session', maxPanes };
    const target = resolvePaneTarget(selected.slice(5), querySession, deps);
    return { kind: 'pane', session: configuredSession, target, layout: options.layout ?? 'tiled', maxPanes };
}

export function validateLayout(layout: string | undefined): void {
    if (layout !== undefined && !LAYOUT_RE.test(layout)) throw new Error(`invalid tmux layout '${layout}'`);
}
