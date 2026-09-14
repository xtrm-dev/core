/**
 * XTRM session identity (XTRM-252.4 R4 Core leg).
 *
 * The `xt` tmux launcher publishes the launched session's stable identity so
 * downstream consumers (X1 ExecutionContext envelope, Journal, Closure,
 * Specialists) can bind execution lineage without any model typing ids by
 * hand (ADR §36) and without Core deriving project identity (ADR §19).
 *
 * - `XTRM_SESSION_ID` — the tmux `#{session_id}` of the launched session
 *   (e.g. `$7`). Surfaced, never minted: when tmux cannot answer, the
 *   variable stays absent rather than carrying a placeholder.
 * - `XTRM_SESSION_NAME` — the tmux session name (the launcher-computed
 *   `pi-<slug>` / `role-<slug>` / `claude-<slug>` value, post-suffix).
 *
 * Unknown stays absent (ADR §98, joint with X1): every builder here omits
 * keys it cannot observe. No parallel registry, no model-entered flags.
 */

import { spawnSync } from 'node:child_process';

export const XTRM_SESSION_ID_VAR = 'XTRM_SESSION_ID';
export const XTRM_SESSION_NAME_VAR = 'XTRM_SESSION_NAME';

export interface TmuxSessionIdentity {
    sessionId?: string | null;
    sessionName?: string | null;
}

/** Minimal tmux probe surface; tests inject a stub, production uses spawnSync. */
export type TmuxProbe = (args: string[]) => { status: number | null; stdout: string };

function defaultProbe(args: string[]): { status: number | null; stdout: string } {
    const result = spawnSync('tmux', args, { encoding: 'utf8', stdio: 'pipe' });
    return { status: result.status, stdout: String(result.stdout ?? '') };
}

function clean(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

/**
 * Build the `XTRM_SESSION_*` environment record from observed identity.
 * Same values in, same values out; unobserved values produce no key —
 * never an empty string, never a placeholder. Pure and total.
 */
export function buildSessionIdentityEnv(identity: TmuxSessionIdentity): Record<string, string> {
    const env: Record<string, string> = {};
    const sessionId = clean(identity.sessionId);
    const sessionName = clean(identity.sessionName);
    if (sessionId) env[XTRM_SESSION_ID_VAR] = sessionId;
    if (sessionName) env[XTRM_SESSION_NAME_VAR] = sessionName;
    return env;
}

/**
 * Resolve the CURRENT tmux session identity (current-pane launches run
 * inside the caller's session, so both id and name are known pre-spawn).
 * Any probe failure yields absent fields — never fabricated values.
 */
export function resolveCurrentTmuxSessionIdentity(
    probe: TmuxProbe = defaultProbe,
): TmuxSessionIdentity {
    if (!process.env.TMUX) return { sessionId: null, sessionName: null };
    let sessionId: string | null = null;
    let sessionName: string | null = null;
    try {
        const id = probe(['display-message', '-p', '-F', '#{session_id}']);
        if (id.status === 0) sessionId = clean(id.stdout);
    } catch { /* absent */ }
    try {
        const name = probe(['display-message', '-p', '-F', '#{session_name}']);
        if (name.status === 0) sessionName = clean(name.stdout);
    } catch { /* absent */ }
    return { sessionId, sessionName };
}

/**
 * Resolve the `#{session_id}` of a named session just created by
 * `tmux new-session`. Null when tmux cannot answer — callers omit the
 * variable rather than inventing one.
 */
export function resolveTmuxSessionId(
    sessionName: string,
    probe: TmuxProbe = defaultProbe,
): string | null {
    try {
        const result = probe(['display-message', '-p', '-t', sessionName, '-F', '#{session_id}']);
        if (result.status !== 0) return null;
        return clean(result.stdout);
    } catch {
        return null;
    }
}
