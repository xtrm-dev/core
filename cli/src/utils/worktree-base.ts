import { spawnSync } from 'node:child_process';

export type WorktreeBaseResult = { ok: true; ref: string } | { ok: false; error: string };

const FALLBACK_REFS = ['origin/main', 'origin/master'];

function git(repoRoot: string, args: string[]): { status: number; stdout: string; stderr: string } {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
    return {
        status: r.status ?? -1,
        stdout: (r.stdout ?? '').trim(),
        stderr: (r.stderr ?? '').trim(),
    };
}

/** Resolve the repo's default remote-tracking branch without network access. */
export function resolveDefaultBranchRef(repoRoot: string): string | null {
    const sym = git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (sym.status === 0 && sym.stdout) return sym.stdout;
    for (const ref of FALLBACK_REFS) {
        if (git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]).status === 0) return ref;
    }
    return null;
}

/**
 * Fetch origin and resolve the start point for a new xt worktree branch
 * (CORE-2340). Never falls back to the main checkout's local HEAD — a wrong
 * base produces wrong PR diffs — so a failed fetch is a hard error.
 */
export function fetchWorktreeBase(repoRoot: string, baseOverride?: string): WorktreeBaseResult {
    const fetch = git(repoRoot, ['fetch', 'origin', '--quiet']);
    if (fetch.status !== 0) {
        return { ok: false, error: `git fetch origin failed (offline?): ${fetch.stderr || 'no stderr'}` };
    }
    const ref = baseOverride ?? resolveDefaultBranchRef(repoRoot);
    if (!ref) {
        return { ok: false, error: 'could not resolve the default branch (origin/HEAD, origin/main, origin/master); pass --base <ref>' };
    }
    if (git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]).status !== 0) {
        return { ok: false, error: `base ref '${ref}' not found after fetch` };
    }
    return { ok: true, ref };
}
