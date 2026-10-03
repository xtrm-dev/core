import type { CommandOutcomeAction, CommandOutcomeV1 } from '@xtrm/contracts';

export interface DetachedLaunchOutcomeInput {
    runtime: 'pi' | 'claude';
    runtimeVersion: string | null;
    sessionSlug: string;
    sessionName: string;
    tmuxSessionId: string | null;
    paneId: string;
    worktreePath: string;
    branchName: string;
    metadataPersisted: boolean;
    insideTmux?: boolean;
}

export function checkStructuredLaunchOptions(input: {
    json: boolean;
    attach: boolean;
    reuse: boolean;
    sessionSlug?: string;
    role?: boolean;
    insideTmux?: boolean;
    newSession?: boolean;
}): { ok: true } | { ok: false; error: string } {
    if (!input.json) return { ok: true };
    if (input.attach) return { ok: false, error: '--json requires --no-attach' };
    if (input.reuse) return { ok: false, error: '--json cannot be combined with --reuse' };
    if (input.role && input.insideTmux && !input.newSession) {
        return { ok: false, error: '--no-attach requires --new-session for role launches inside tmux' };
    }
    if (input.sessionSlug !== undefined) {
        try {
            assertOutcomeString('sessionSlug', input.sessionSlug, 256);
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'xtrm.command-outcome.v1: invalid sessionSlug',
            };
        }
    }
    return { ok: true };
}

export function checkStructuredLaunchPaths(input: {
    json: boolean;
    worktreePath: string;
    branchName: string;
}): { ok: true } | { ok: false; error: string } {
    if (!input.json) return { ok: true };
    try {
        assertOutcomeString('worktreePath', input.worktreePath, 4096);
        assertOutcomeString('branchName', input.branchName, 4096);
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'xtrm.command-outcome.v1: invalid launch path',
        };
    }
}

function quoteArg(arg: string): string {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
    return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

export function renderOutcomeArgv(argv: readonly string[]): string {
    return argv.map(quoteArg).join(' ');
}

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

function assertOutcomeString(label: string, value: string, maxLength: number): void {
    if (value.length === 0 || value.length > maxLength || CONTROL_CHARACTER.test(value)) {
        throw new Error(`xtrm.command-outcome.v1: invalid ${label}`);
    }
}

export function sanitizeRuntimeVersion(value: string): string | null {
    try {
        assertOutcomeString('runtimeVersion', value, 128);
        return value;
    } catch {
        return null;
    }
}

export function parseLiveTmuxSessionId(status: number | null, stdout: string):
    | { ok: true; sessionId: string }
    | { ok: false; error: string } {
    if (status !== 0) return { ok: false, error: 'detached tmux session is no longer live' };
    const sessionId = stdout.trim();
    return /^\$[0-9]+$/.test(sessionId)
        ? { ok: true, sessionId }
        : { ok: false, error: 'detached tmux session returned an invalid identity' };
}

export function parseLiveTmuxSessionListing(
    status: number | null,
    stdout: string,
    expectedName: string,
): ReturnType<typeof parseLiveTmuxSessionId> {
    if (status !== 0) return { ok: false, error: 'detached tmux session is no longer live' };
    const matches = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        const separator = line.indexOf('\t');
        if (separator < 1 || line.slice(0, separator) !== expectedName) return [];
        return [line.slice(separator + 1)];
    });
    if (matches.length === 0) return { ok: false, error: 'detached tmux session is no longer live' };
    if (matches.length !== 1) return { ok: false, error: 'detached tmux session returned an invalid identity' };
    return parseLiveTmuxSessionId(0, matches[0] ?? '');
}

function assertDetachedLaunchInput(input: DetachedLaunchOutcomeInput): void {
    if (input.runtimeVersion !== null) assertOutcomeString('runtimeVersion', input.runtimeVersion, 128);
    assertOutcomeString('sessionSlug', input.sessionSlug, 256);
    assertOutcomeString('sessionName', input.sessionName, 256);
    assertOutcomeString('worktreePath', input.worktreePath, 4096);
    assertOutcomeString('branchName', input.branchName, 4096);
    if (input.tmuxSessionId !== null && !/^\$[0-9]+$/.test(input.tmuxSessionId)) {
        throw new Error('xtrm.command-outcome.v1: invalid tmuxSessionId');
    }
    if (!/^%[0-9]+$/.test(input.paneId)) {
        throw new Error('xtrm.command-outcome.v1: invalid paneId');
    }
}

export function action(
    kind: CommandOutcomeAction['kind'],
    argv: string[],
    cwd: string,
    why: string,
): CommandOutcomeAction {
    return {
        kind,
        required: false,
        argv,
        display: renderOutcomeArgv(argv),
        cwd,
        why,
    };
}

export function buildDetachedLaunchOutcome(input: DetachedLaunchOutcomeInput): CommandOutcomeV1 {
    assertDetachedLaunchInput(input);
    const safetyProfile = input.runtime === 'pi'
        ? {
            name: 'pi-native',
            sandbox: 'runtime-defined',
            approvals: 'runtime-defined',
            hook_trust: 'preserved' as const,
        }
        : {
            name: 'claude-bypass-permissions',
            sandbox: 'disabled',
            approvals: 'bypassed',
            hook_trust: 'preserved' as const,
        };

    const outcome: CommandOutcomeV1 = {
        schema_version: 'xtrm.command-outcome.v1',
        status: input.metadataPersisted ? 'ok' : 'degraded',
        reason_code: input.metadataPersisted
            ? 'session_created_readiness_unverified'
            : 'session_created_metadata_not_persisted',
        summary: input.metadataPersisted
            ? `Detached ${input.runtime} session created; runtime readiness is not asserted.`
            : `Detached ${input.runtime} session created, but exact resume metadata was not persisted.`,
        runtime: { name: input.runtime, version: input.runtimeVersion },
        identity: {
            thread_id: null,
            session_name: input.sessionName,
            tmux_session_id: input.tmuxSessionId,
            pane_id: input.paneId,
        },
        worktree: { path: input.worktreePath, branch: input.branchName, owner: 'core' },
        readiness: { status: 'unverified', source: 'tmux-pane' },
        safety_profile: safetyProfile,
        persistence: { completed: input.metadataPersisted, kind: 'worktree.session-metadata' },
        authoritative_mutation: { completed: true, kind: 'interactive-session.created' },
        side_effects: [
            { kind: 'worktree.created', status: 'ok', id: input.sessionSlug },
            { kind: 'tmux.session.created', status: 'ok', id: input.tmuxSessionId },
            { kind: 'runtime.readiness', status: 'skipped', id: null },
        ],
        next_actions: [
            action(
                'attach',
                ['tmux', input.insideTmux ? 'switch-client' : 'attach-session', '-t', input.sessionName],
                input.worktreePath,
                'Attach to the live detached session.',
            ),
            ...(input.metadataPersisted ? [action(
                'resume',
                ['xt', 'attach', input.branchName],
                input.worktreePath,
                'Resume the runtime in this worktree after the tmux session ends.',
            )] : []),
            action(
                'repair',
                ['xt', 'doctor'],
                input.worktreePath,
                'Inspect runtime and managed configuration drift.',
            ),
            action(
                'end',
                ['xt', 'end'],
                input.worktreePath,
                'Close the worktree session through the existing Core lifecycle.',
            ),
        ],
    };
    return outcome;
}
