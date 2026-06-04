import fs from 'fs-extra';
import path from 'node:path';

export interface ApplyState {
    schema: 'xt.spec.apply-state.v1';
    spec_id: string;
    spec_path: string;
    planner_bead_id: string;
    planner_job_id: string;
    dispatched_at: string; // ISO8601
    // .12 reconcile will append:
    reconciled_at?: string;
    epic_id?: string;
    children?: string[];
    test_issues?: string[];
}

export function sidecarPath(specPath: string): string {
    return path.join(path.dirname(specPath), '.apply-state.json');
}

/**
 * Atomic write: write to <sidecar>.tmp + rename(2). On any failure the partial
 * file is removed and the original (if any) is preserved.
 */
export async function writeApplyState(specPath: string, state: ApplyState): Promise<void> {
    const finalPath = sidecarPath(specPath);
    const tmpPath = `${finalPath}.tmp`;
    const payload = JSON.stringify(state, null, 2) + '\n';
    await fs.writeFile(tmpPath, payload, 'utf8');
    try {
        await fs.rename(tmpPath, finalPath);
    } catch (err) {
        await fs.remove(tmpPath).catch(() => {});
        throw err;
    }
}

export async function readApplyState(specPath: string): Promise<ApplyState | null> {
    const p = sidecarPath(specPath);
    if (!(await fs.pathExists(p))) return null;
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw) as ApplyState;
}
