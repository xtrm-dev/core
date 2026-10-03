/**
 * Agent host launch (PRD xtrm-app §35.4; XTRM-566).
 *
 * POST /v1/launch starts an agent through the existing launcher so the agent outlives the GUI
 * and `tmux attach` stays an equal client:
 *
 * - `xt pi`: the host runs `xt pi … --no-attach --json` from the same xt build it runs from
 *   (process.execPath + its own entry, never an xt on PATH). Roles, beads, worktrees and skill
 *   resolution stay owned by `xt pi`.
 * - `pi`: the host starts bare `pi` in a new detached tmux session.
 *
 * Both set XTRM_AGENT_LAUNCH=gui in the launched pane, so the xtrm-agent-host extension reports
 * `launch: gui`. Arguments are argv arrays; nothing passes through a shell string.
 */

import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { validate } from '@xtrm/contracts';
import type { AgentHostApiV1, CommandOutcomeV1 } from '@xtrm/contracts';
import { action } from './launch-outcome.js';
import { forwardedLaunchEnv } from '../utils/worktree-session.js';

export type LaunchRequest = Extract<AgentHostApiV1, { kind: 'launch_request' }>;
export type LaunchResult = Extract<AgentHostApiV1, { kind: 'launch_result' }>;
type LaunchOptions = NonNullable<LaunchRequest['options']>;

/** Read by the xtrm-agent-host extension; `gui` marks a host-launched session. */
export const LAUNCH_ENV = 'XTRM_AGENT_LAUNCH';
/** Published by the xtrm-agent-host extension on its tmux pane (XTRM-564). */
export const PANE_SESSION_OPTION = '@xtrm_agent_session_id';

const OPTION_KEYS = new Set<keyof LaunchOptions>([
    'name', 'role', 'bead', 'model', 'thinking', 'skills', 'prompt', 'parent', 'child',
]);
/** Options `xt pi` owns; a bare `pi` launch cannot honor them. */
const XT_PI_ONLY_OPTIONS = new Set<keyof LaunchOptions>(['role', 'bead']);
/** A tmux session name and an `xt/<name>` branch component. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export class LaunchRejection extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
    }
}

export interface ProcessResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

export type RunProcess = (
    file: string,
    args: readonly string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<ProcessResult>;

export interface AgentHostLaunchOptions {
    /** The xt build the host runs from, as [executable, ...entry]. Default: process.execPath + process.argv[1]. */
    xtCommand?: readonly string[];
    /** Pi executable for bare `pi` launches. */
    piCommand?: string;
    /** Base environment for launched processes. */
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    run?: RunProcess;
}

export const runProcess: RunProcess = (file, args, options) =>
    new Promise((resolve) => {
        execFile(
            file,
            [...args],
            { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
            (error, stdout, stderr) => {
                const code = (error as NodeJS.ErrnoException | null)?.code;
                const status = error ? (typeof code === 'number' ? code : null) : 0;
                resolve({ status, stdout, stderr: stderr || (error && status === null ? error.message : '') });
            },
        );
    });

export interface ValidatedLaunch {
    command: LaunchRequest['command'];
    cwd: string;
    options: LaunchOptions;
}

/** Reject unknown options, options the command cannot honor, and a cwd that is not an existing directory. */
export function validateLaunchRequest(request: LaunchRequest): ValidatedLaunch {
    const options = request.options ?? {};
    for (const key of Object.keys(options)) {
        if (!OPTION_KEYS.has(key as keyof LaunchOptions)) throw new LaunchRejection('invalid_option', `unknown launch option ${key}`);
    }
    if (request.command !== 'pi' && request.command !== 'xt pi') {
        throw new LaunchRejection('invalid_option', 'command must be "pi" or "xt pi"');
    }
    if (request.command === 'pi') {
        for (const key of XT_PI_ONLY_OPTIONS) {
            if (options[key] !== undefined) throw new LaunchRejection('invalid_option', `${key} requires the "xt pi" command`);
        }
    }
    if (options.name !== undefined && !NAME_PATTERN.test(options.name)) {
        throw new LaunchRejection('invalid_option', 'name must be 1-64 letters, digits, "-" or "_", starting with a letter or digit');
    }
    for (const key of ['role', 'bead', 'model', 'thinking', 'parent'] as const) {
        const value = options[key];
        if (value !== undefined) assertOptionValue(key, value);
    }
    for (const skill of options.skills ?? []) assertOptionValue('skills', skill);
    if (options.child && !options.parent) throw new LaunchRejection('invalid_option', 'child requires parent');

    if (!path.isAbsolute(request.cwd)) throw new LaunchRejection('invalid_cwd', 'cwd must be an absolute path');
    let cwd: string;
    try {
        cwd = realpathSync(request.cwd);
        if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch {
        throw new LaunchRejection('invalid_cwd', `cwd ${request.cwd} is not an existing directory`);
    }
    return { command: request.command, cwd, options };
}

function assertOptionValue(key: string, value: string): void {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || CONTROL_CHARACTER.test(value)) {
        throw new LaunchRejection('invalid_option', `${key} must be a non-empty single-line string`);
    }
    if (value.startsWith('-')) throw new LaunchRejection('invalid_option', `${key} must not start with "-"`);
}

/**
 * `xt pi` argv after the xt entry. Valued options use `--opt=value`, so no value is ever read
 * as a flag, and no element is a bare `--` (the launcher's passthrough marker).
 */
export function buildXtPiArgs(options: LaunchOptions, parentTmuxSessionId: string | null): string[] {
    const args = ['pi'];
    if (options.name) args.push(options.name);
    args.push('--no-attach', '--json', '--new-session');
    if (options.role) args.push(`--role=${options.role}`);
    if (options.bead) args.push(`--bead=${options.bead}`);
    if (options.model) args.push(`--model=${options.model}`);
    if (options.thinking) args.push(`--thinking=${options.thinking}`);
    for (const skill of options.skills ?? []) args.push(`--skill=${skill}`);
    if (options.prompt) args.push(`--prompt=${options.prompt}`);
    if (parentTmuxSessionId) args.push(`--parent=${parentTmuxSessionId}`);
    return args;
}

/** Bare `pi` argv; the prompt follows `--`, so pi never parses it as an option. */
export function buildPiArgs(options: LaunchOptions, sessionName: string): string[] {
    const args = ['--name', options.name ?? sessionName];
    if (options.model) args.push('--model', options.model);
    if (options.thinking) args.push('--thinking', options.thinking);
    for (const skill of options.skills ?? []) args.push('--skill', skill);
    if (options.prompt) args.push('--', options.prompt);
    return args;
}

/** Environment for a launched agent: forwarded launch context plus XTRM_AGENT_LAUNCH=gui, never the host's own tmux client. */
export function buildLaunchEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, [LAUNCH_ENV]: 'gui' };
    // The host is not a tmux client: xt pi must neither run in the host's pane nor parent to its session.
    delete env.TMUX;
    delete env.TMUX_PANE;
    return env;
}

/** Resolve a parent Pi session id to its tmux session id ($N) through the pane option the extension publishes. */
// tmux formats use a space separator: without a UTF-8 locale tmux rewrites a tab in -F output.
export async function resolveParentTmuxSession(run: RunProcess, env: NodeJS.ProcessEnv, parent: string): Promise<string> {
    const listing = await run('tmux', ['list-panes', '-a', '-F', `#{session_id} #{${PANE_SESSION_OPTION}}`], { env, timeoutMs: 5_000 });
    if (listing.status === 0) {
        for (const line of listing.stdout.split('\n')) {
            const [tmuxSessionId, sessionId] = line.split(' ');
            if (sessionId === parent && /^\$[0-9]+$/.test(tmuxSessionId ?? '')) return tmuxSessionId;
        }
    }
    throw new LaunchRejection('parent_not_found', `no tmux pane publishes ${PANE_SESSION_OPTION}=${parent}`);
}

export class AgentHostLauncher {
    private readonly xtCommand: readonly string[];
    private readonly piCommand: string;
    private readonly env: NodeJS.ProcessEnv;
    private readonly timeoutMs: number;
    private readonly run: RunProcess;

    constructor(options: AgentHostLaunchOptions = {}) {
        this.xtCommand = options.xtCommand ?? [process.execPath, process.argv[1] ?? ''];
        this.piCommand = options.piCommand ?? 'pi';
        this.env = buildLaunchEnv(options.env ?? process.env);
        this.timeoutMs = options.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
        this.run = options.run ?? runProcess;
    }

    /** Validate and launch. Throws LaunchRejection for a request that never reached the launcher. */
    async launch(request: LaunchRequest): Promise<LaunchResult> {
        const { command, cwd, options } = validateLaunchRequest(request);
        const parent = options.parent ? await resolveParentTmuxSession(this.run, this.env, options.parent) : null;
        return command === 'xt pi' ? this.launchXtPi(cwd, options, parent) : this.launchPi(cwd, options, parent);
    }

    private async launchXtPi(cwd: string, options: LaunchOptions, parent: string | null): Promise<LaunchResult> {
        const [file, ...entry] = this.xtCommand;
        if (!file || entry.some((arg) => !arg)) return failed('launcher_unavailable', 'the agent host cannot locate its own xt entry');
        const result = await this.run(file, [...entry, ...buildXtPiArgs(options, parent)], { cwd, env: this.env, timeoutMs: this.timeoutMs });
        if (result.status !== 0) return failed('launch_failed', firstLine(result.stderr) ?? `xt pi exited with status ${result.status}`);
        const line = result.stdout.trim().split('\n').pop() ?? '';
        let outcome: unknown;
        try {
            outcome = JSON.parse(line);
        } catch {
            return failed('launch_output_invalid', 'xt pi did not print an xtrm.command-outcome.v1 object');
        }
        if (!validate('xtrm.command-outcome.v1', outcome).valid) {
            return failed('launch_output_invalid', 'xt pi printed an invalid xtrm.command-outcome.v1 object');
        }
        return launchResult(outcome as CommandOutcomeV1);
    }

    private async launchPi(cwd: string, options: LaunchOptions, parent: string | null): Promise<LaunchResult> {
        const sessionName = options.name ?? `pi-${randomBytes(3).toString('hex')}`;
        const envArgs: string[] = ['-e', `${LAUNCH_ENV}=gui`];
        for (const [key, value] of Object.entries(forwardedLaunchEnv(this.env))) {
            if (key !== LAUNCH_ENV) envArgs.push('-e', `${key}=${value}`);
        }
        const created = await this.run('tmux', [
            'new-session', '-d', '-P', '-F', '#{session_id} #{pane_id}',
            '-s', sessionName, '-c', cwd, ...envArgs,
            '--', this.piCommand, ...buildPiArgs(options, sessionName),
        ], { env: this.env, timeoutMs: 10_000 });
        const [tmuxSessionId, paneId] = created.stdout.trim().split(' ');
        if (created.status !== 0 || !/^\$[0-9]+$/.test(tmuxSessionId ?? '') || !/^%[0-9]+$/.test(paneId ?? '')) {
            return failed('launch_failed', firstLine(created.stderr) ?? 'tmux new-session failed');
        }
        if (parent) {
            await this.run('tmux', ['set-option', '-p', '-t', paneId, '@agent_parent_session', parent], { env: this.env, timeoutMs: 5_000 });
        }
        const attach = ['tmux', 'attach-session', '-t', sessionName];
        return launchResult({
            schema_version: 'xtrm.command-outcome.v1',
            status: 'ok',
            reason_code: 'session_created_readiness_unverified',
            summary: 'Detached pi session created; runtime readiness is not asserted.',
            identity: { thread_id: null, session_name: sessionName, tmux_session_id: tmuxSessionId, pane_id: paneId },
            readiness: { status: 'unverified', source: 'tmux-pane' },
            authoritative_mutation: { completed: true, kind: 'interactive-session.created' },
            side_effects: [
                { kind: 'tmux.session.created', status: 'ok', id: tmuxSessionId },
                { kind: 'runtime.readiness', status: 'skipped', id: null },
            ],
            next_actions: [action('attach', attach, cwd, 'Attach to the live detached session.')],
        });
    }
}

function launchResult(outcome: CommandOutcomeV1): LaunchResult {
    const sessionName = outcome.identity?.session_name;
    const paneId = outcome.identity?.pane_id;
    return {
        schema: 'xtrm.agent-host-api.v1',
        kind: 'launch_result',
        outcome,
        ...(sessionName && paneId ? { tmux: { session: sessionName, paneId } } : {}),
    };
}

function failed(reasonCode: string, summary: string): LaunchResult {
    return {
        schema: 'xtrm.agent-host-api.v1',
        kind: 'launch_result',
        outcome: {
            schema_version: 'xtrm.command-outcome.v1',
            status: 'failed',
            reason_code: reasonCode,
            summary: summary.slice(0, 240),
            authoritative_mutation: { completed: false, kind: 'interactive-session.created' },
            side_effects: [],
            next_actions: [],
        },
    };
}

/** First non-empty stderr line without terminal styling, safe for an outcome summary. */
function firstLine(text: string): string | null {
    const line = text
        .replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
        .split('\n')
        .map((l) => l.replace(/[\u0000-\u001F\u007F]/g, '').replace(/^\s*✗\s*/, '').trim())
        .find(Boolean);
    return line ? line.slice(0, 240) : null;
}
