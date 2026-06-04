import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { ApplyState } from './apply-state.js';

export interface PlannerResult {
    epic_id: string;
    children: string[];
    test_issues: string[];
    first_task?: string;
}

export interface ReconcileResult {
    ok: boolean;
    planner_result?: PlannerResult;
    error?: string;
    orphan_ids?: string[];
}

interface ReconcileOptions {
    /** Override sp binary. */
    spBinary?: string;
    /** Override bd binary. */
    bdBinary?: string;
}

/**
 * Read sp result for the planner job, validate every emitted id against bd,
 * write the resolved links back into spec.yaml in place (preserving comments
 * and key ordering), and append reconcile fields to the sidecar.
 *
 * Idempotent: a second run produces a byte-identical spec.yaml.
 */
export async function reconcile(
    specPath: string,
    state: ApplyState,
    opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
    const sp = opts.spBinary ?? process.env.XT_SPEC_SP_BINARY ?? 'sp';
    const bd = opts.bdBinary ?? process.env.XT_SPEC_BD_BINARY ?? 'bd';

    const r = spawnSync(sp, ['result', state.planner_job_id, '--json'], { encoding: 'utf8' });
    if (r.status !== 0) {
        return { ok: false, error: `sp result failed: ${r.stderr || r.stdout}` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(r.stdout);
    } catch (err) {
        return { ok: false, error: 'sp result returned non-JSON: ' + (err instanceof Error ? err.message : String(err)) };
    }
    const plannerResult = extractPlannerResult(parsed);
    if (!plannerResult) {
        return { ok: false, error: 'sp result missing required fields (epic_id, children, test_issues)' };
    }

    const orphans = await validateIdsExist([plannerResult.epic_id, ...plannerResult.children, ...plannerResult.test_issues], bd);
    if (orphans.length > 0) {
        return { ok: false, error: `reconcile_orphan_link: ${orphans.join(', ')}`, orphan_ids: orphans };
    }

    await writeLinksInPlace(specPath, {
        parent_epic: null,
        planner_bead: state.planner_bead_id,
        epic: plannerResult.epic_id,
        children: plannerResult.children,
        test_issues: plannerResult.test_issues,
    });

    return { ok: true, planner_result: plannerResult };
}

function extractPlannerResult(parsed: unknown): PlannerResult | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const epicId = typeof obj.epic_id === 'string' ? obj.epic_id : null;
    const children = Array.isArray(obj.children) && obj.children.every((c) => typeof c === 'string') ? (obj.children as string[]) : null;
    const testIssues = Array.isArray(obj.test_issues) && obj.test_issues.every((c) => typeof c === 'string') ? (obj.test_issues as string[]) : null;
    if (!epicId || !children || !testIssues) return null;
    const firstTask = typeof obj.first_task === 'string' ? obj.first_task : undefined;
    return { epic_id: epicId, children, test_issues: testIssues, first_task: firstTask };
}

async function validateIdsExist(ids: string[], bdBin: string): Promise<string[]> {
    const orphans: string[] = [];
    for (const id of ids) {
        const r = spawnSync(bdBin, ['show', id, '--json'], { encoding: 'utf8' });
        if (r.status !== 0) orphans.push(id);
    }
    return orphans;
}

interface LinksBlock {
    parent_epic: string | null;
    planner_bead: string;
    epic: string;
    children: string[];
    test_issues: string[];
}

async function writeLinksInPlace(specPath: string, links: LinksBlock): Promise<void> {
    const raw = await fs.readFile(specPath, 'utf8');
    const doc = parseDocument(raw);
    doc.set('links', links);
    doc.set('status', 'planned');
    const out = String(doc);
    const finalOut = out.endsWith('\n') ? out : out + '\n';

    const tmpPath = `${specPath}.tmp`;
    await fs.writeFile(tmpPath, finalOut, 'utf8');
    try {
        await fs.rename(tmpPath, specPath);
    } catch (err) {
        await fs.remove(tmpPath).catch(() => {});
        throw err;
    }
}

/** Exposed for tests: the relative sidecar location next to a spec. */
export function sidecarPathFromSpec(specPath: string): string {
    return path.join(path.dirname(specPath), '.apply-state.json');
}
