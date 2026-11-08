/**
 * Git author identity for agent sessions (CORE-2525, parent CORE-2524).
 *
 * An agent commit must name the agent, not the operator. The launcher knows the
 * Substrate holder, so it exports the four git identity variables for the
 * runtime it starts:
 *
 * - `GIT_AUTHOR_NAME` / `GIT_COMMITTER_NAME` — the holder verbatim.
 * - `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_EMAIL` — the role's noreply address once
 *   the GitHub Apps exist; until then the operator's `user.email`, resolved from
 *   git itself so no address is hard-coded here.
 *
 * Unknown stays absent (session-identity.ts rule): no holder means no git env,
 * and an unresolvable email leaves the email variables unset so git keeps its
 * own resolution. The `Agent: <holder>` trailer is not written here: it belongs
 * to Substrate's prepare-commit-msg hook (XTRM-684), installed per repo by
 * CORE-2570.
 */

import { spawnSync } from 'node:child_process';

export const GIT_IDENTITY_ENV_KEYS = [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
] as const;

export interface GitIdentity {
    /** Substrate holder (`SUBSTRATE_HOLDER`), the agent's own name. */
    holder?: string | null;
    /** Resolved author/committer email; absent keeps git's own resolution. */
    email?: string | null;
}

export interface GitIdentityDeps {
    /** Directory the git config lookup runs in. Default: the process cwd. */
    cwd?: string;
    /** Injected for tests; defaults to a real `git config --get user.email`. */
    run?: (cmd: string, args: string[], opts: { cwd?: string }) => { status: number | null; stdout: string };
}

/**
 * The operator's configured email (`git config --get user.email`), or null.
 * Used as the interim agent email until the role Apps mint their own noreply
 * addresses. Never throws: an absent or malformed answer is simply unknown.
 */
export function resolveGitEmail(deps: GitIdentityDeps = {}): string | null {
    const run = deps.run ?? ((cmd, args, opts) => {
        const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd, stdio: 'pipe' });
        return { status: result.status, stdout: String(result.stdout ?? '') };
    });
    try {
        const result = run('git', ['config', '--get', 'user.email'], { cwd: deps.cwd });
        if (result.status !== 0) return null;
        const email = result.stdout.trim();
        // A value with whitespace is not an address git can use.
        return email && !/\s/.test(email) ? email : null;
    } catch {
        return null;
    }
}

/**
 * The git identity variables for one agent, from observed values only.
 * No holder means no identity env at all (never a placeholder name).
 */
export function buildGitIdentityEnv(input: GitIdentity): Record<string, string> {
    const holder = (input.holder ?? '').trim();
    if (!holder) return {};
    const out: Record<string, string> = {
        GIT_AUTHOR_NAME: holder,
        GIT_COMMITTER_NAME: holder,
    };
    const email = (input.email ?? '').trim();
    if (email) {
        out.GIT_AUTHOR_EMAIL = email;
        out.GIT_COMMITTER_EMAIL = email;
    }
    return out;
}
