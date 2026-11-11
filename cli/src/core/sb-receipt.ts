// CORE-2606: one place decides how a failed `sb` call is reported. `sb --json`
// prints a refusal on STDOUT and exits non-zero with empty stderr, so a message
// built from stderr alone loses the reason — that is how the live warning came
// to say only "Journal receipt failed: sb exited 1".

import { spawnSync } from 'node:child_process';

/** The `sb` this session would run: PATH resolution, with a stable fallback. */
export function resolveSbBinary(env: NodeJS.ProcessEnv = process.env): string {
    const found = spawnSync('sh', ['-c', 'command -v sb'], { encoding: 'utf8', env });
    const resolved = (found.stdout || '').trim();
    return resolved || 'sb';
}

/**
 * The `error` field of an `sb --json` refusal, or null.
 */
export function sbJsonError(stdout: string | null | undefined): string | null {
    const text = (stdout ?? '').trim();
    if (!text.startsWith('{')) return null;
    try {
        const parsed = JSON.parse(text) as { error?: unknown };
        return typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : null;
    } catch {
        return null;
    }
}

export interface SbFailure {
    /** The binary that ran (or was asked to run). */
    binary: string;
    status: number | null;
    stdout?: string | null;
    stderr?: string | null;
    /** A spawn error, when the process never ran. */
    spawnError?: string | null;
}

/** One line: which binary, its exit status, and the reason it gave. */
export function describeSbFailure(failure: SbFailure): string {
    const binary = failure.binary || 'sb';
    if (failure.spawnError) return `${binary}: ${failure.spawnError}`;
    const stderr = (failure.stderr ?? '').trim();
    const fromStdout = sbJsonError(failure.stdout);
    const reason = stderr || (fromStdout ? `(stdout) ${fromStdout}` : 'no stderr and no JSON error on stdout');
    return `sb (${binary}) exited ${failure.status}: ${reason}`;
}

/** Run one `sb` receipt; never throws, and names the binary and its reason. */
export function runReceipt(args: string[], env: NodeJS.ProcessEnv = process.env): { ok: boolean; error?: string } {
    const binary = resolveSbBinary(env);
    const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    if (result.status === 0) return { ok: true };
    return {
        ok: false,
        error: describeSbFailure({
            binary,
            status: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            spawnError: result.error?.message ?? null,
        }),
    };
}
