// CORE-2606: one place decides how a failed `sb` call is reported. `sb --json`
// prints a refusal on STDOUT and exits non-zero with empty stderr, so a message
// built from stderr alone loses the reason — that is how the live warning came
// to say only "Journal receipt failed: sb exited 1".
//
// CORE-2611: a receipt also names its project. `sb` resolves the project from
// the cwd, so a reviewer working in a `core` worktree that reviews an `xtrm` PR
// was refused: "ref XTRM-728 belongs to project prj_xtrm, not the effective
// project prj_core: pass --project prj_xtrm". The receipt resolves the project
// from data `sb` already owns (the Issue ref prefix, or the PR repository name)
// and passes `--project <id>` explicitly.

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

/** One project as `sb project list --json` reports it. */
export interface SbProject {
    id: string;
    prefix: string;
    name: string;
}

/** Parse `sb project list --json`; anything unparseable yields no projects. */
export function parseProjectList(stdout: string | null | undefined): SbProject[] {
    const text = (stdout ?? '').trim();
    if (!text.startsWith('{')) return [];
    try {
        const parsed = JSON.parse(text) as { data?: unknown };
        if (!Array.isArray(parsed.data)) return [];
        const projects: SbProject[] = [];
        for (const entry of parsed.data) {
            if (!entry || typeof entry !== 'object') continue;
            const record = entry as Record<string, unknown>;
            if (typeof record.id !== 'string' || typeof record.prefix !== 'string') continue;
            projects.push({
                id: record.id,
                prefix: record.prefix,
                name: typeof record.name === 'string' ? record.name : '',
            });
        }
        return projects;
    } catch {
        return [];
    }
}

/** `XTRM-184.2.3` -> `xtrm`; a ref with no prefix yields an empty string. */
export function issueRefPrefix(ref: string | null | undefined): string {
    const match = /^([A-Za-z][A-Za-z0-9_]*)-/.exec((ref ?? '').trim());
    return match ? match[1].toLowerCase() : '';
}

/** The repository's last segment: `xtrm-dev/xtrm` -> `xtrm`. */
function repoSegment(repo: string | null | undefined): string {
    const parts = (repo ?? '').trim().split('/');
    return (parts[parts.length - 1] ?? '').toLowerCase();
}

/**
 * The project a receipt belongs to, from data `sb` already owns.
 *
 * The Issue ref prefix is authoritative (`XTRM-728` -> the project whose prefix
 * is XTRM); the PR repository name is the fallback. An unmatched or ambiguous
 * target yields null, so the receipt keeps the previous cwd-resolved behaviour
 * instead of guessing a project.
 */
export function pickReceiptProject(
    projects: SbProject[],
    target: { issueRef?: string | null; repo?: string | null },
): string | null {
    const prefix = issueRefPrefix(target.issueRef);
    if (prefix) {
        const matches = projects.filter((project) => project.prefix.trim().toLowerCase() === prefix);
        if (matches.length === 1) return matches[0].id;
        if (matches.length > 1) return null;
    }
    const segment = repoSegment(target.repo);
    if (!segment) return null;
    const byName = projects.filter((project) => project.name.trim().toLowerCase() === segment);
    return byName.length === 1 ? byName[0].id : null;
}

export interface RunSbJson {
    (args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string | null; stderr: string | null };
}

export interface ReceiptProjectDeps {
    env?: NodeJS.ProcessEnv;
    /** Runs `sb`; tests inject a fake so no real store is touched. */
    runSb?: RunSbJson;
    /**
     * An already-read project list. The caller that also needs the prefixes (the
     * created-PR link) reads it once and passes it, so one receipt costs one
     * read-only `sb` call, not two.
     */
    projects?: SbProject[];
}

function sbRunner(deps: ReceiptProjectDeps): RunSbJson {
    return deps.runSb ?? ((args, runEnv) => {
        const binary = resolveSbBinary(runEnv);
        const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: runEnv });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    });
}

/** The projects `sb project list --json` reports; no projects when `sb` cannot answer. */
export function listProjects(deps: ReceiptProjectDeps = {}): SbProject[] {
    const env = deps.env ?? process.env;
    try {
        const result = sbRunner(deps)(['project', 'list', '--json'], env);
        if (result.status !== 0) return [];
        return parseProjectList(result.stdout);
    } catch {
        return [];
    }
}

/**
 * Resolve the receipt's project with one read-only `sb project list --json`, or
 * null when `sb` cannot answer. Never throws: an unresolved project degrades to
 * the previous behaviour, never to a wrong one.
 */
export function resolveReceiptProject(
    target: { issueRef?: string | null; repo?: string | null },
    deps: ReceiptProjectDeps = {},
): string | null {
    try {
        return pickReceiptProject(deps.projects ?? listProjects(deps), target);
    } catch {
        return null;
    }
}

/** Append `--project <id>` to a receipt argv; an unresolved project leaves it as is. */
export function withReceiptProject(args: string[], projectId: string | null | undefined): string[] {
    return projectId ? [...args, '--project', projectId] : args;
}

export interface ReceiptRunOptions {
    /** A hard budget: a receipt that has not answered by then is abandoned. */
    timeoutMs?: number;
}

/** Run one `sb` receipt; never throws, and names the binary and its reason. */
export function runReceipt(
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
    options: ReceiptRunOptions = {},
): { ok: boolean; error?: string } {
    const binary = resolveSbBinary(env);
    const result = spawnSync(binary, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
    });
    if (result.status === 0) return { ok: true };
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return {
        ok: false,
        error: describeSbFailure({
            binary,
            status: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            spawnError: timedOut ? `no answer in ${options.timeoutMs} ms` : (result.error?.message ?? null),
        }),
    };
}
