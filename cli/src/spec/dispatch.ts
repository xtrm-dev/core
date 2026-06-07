import { spawnSync } from 'node:child_process';

export interface DispatchResult {
    ok: boolean;
    job_id?: string;
    stderr?: string;
    exit_code?: number;
}

export interface DispatchOptions {
    /** Override the sp binary path (used by tests via env). */
    spBinary?: string;
}

/**
 * Dispatch the planner specialist against an existing planner bead.
 * Background only — the operator follows via `sp feed <job-id>`.
 *
 * Honors XT_SPEC_SP_BINARY env to support test injection of a mock sp.
 */
export function dispatchPlanner(plannerBeadId: string, opts: DispatchOptions = {}): DispatchResult {
    const sp = opts.spBinary ?? process.env.XT_SPEC_SP_BINARY ?? 'sp';
    const r = spawnSync(sp, ['run', 'planner', '--bead', plannerBeadId, '--background', '--json'], {
        encoding: 'utf8',
    });
    if (r.status !== 0) {
        return { ok: false, stderr: r.stderr || r.stdout, exit_code: r.status ?? 1 };
    }
    try {
        const parsed = JSON.parse(r.stdout);
        const jobId = parsed.job_id ?? parsed.id;
        if (typeof jobId !== 'string') {
            return { ok: false, stderr: 'sp returned no job_id field: ' + r.stdout };
        }
        return { ok: true, job_id: jobId };
    } catch {
        // Some sp builds may print plain text containing the id; try a fallback regex.
        const m = /job[_-]?id[:= ]+([a-z0-9-]+)/i.exec(r.stdout);
        if (m) return { ok: true, job_id: m[1] };
        return { ok: false, stderr: 'failed to parse sp output: ' + r.stdout };
    }
}
