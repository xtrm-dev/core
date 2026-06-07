import { spawnSync } from 'node:child_process';
import type { SpecV1 } from './schema.js';

export type DriftKind =
    | 'orphan_link'
    | 'new_child'
    | 'cycle'
    | 'linked_open'
    | 'linked_closed';

export interface DriftIssue {
    kind: DriftKind;
    id: string;
    detail?: string;
    severity: 'warning' | 'error';
}

export interface StatusReport {
    schema: 'xt.spec.status.v1';
    spec_id: string;
    spec_status: SpecV1['status'];
    links: {
        epic: string | null | undefined;
        planner_bead: string | null | undefined;
        children: string[];
        test_issues: string[];
    };
    open_count: number;
    closed_count: number;
    drift: DriftIssue[];
    ok: boolean;
    warning_only: boolean;
}

interface BdShow {
    id: string;
    status?: string;
}

interface StatusOptions {
    bdBinary?: string;
}

export async function computeStatus(spec: SpecV1, opts: StatusOptions = {}): Promise<StatusReport> {
    const bd = opts.bdBinary ?? process.env.XT_SPEC_BD_BINARY ?? 'bd';
    const epic = spec.links.epic ?? null;
    const plannerBead = spec.links.planner_bead ?? null;
    const ids = [
        ...(epic ? [epic] : []),
        ...(plannerBead ? [plannerBead] : []),
        ...spec.links.children,
        ...spec.links.test_issues,
    ];

    const drift: DriftIssue[] = [];
    let openCount = 0;
    let closedCount = 0;

    for (const id of ids) {
        const show = bdShow(bd, id);
        if (!show) {
            drift.push({ kind: 'orphan_link', id, severity: 'error', detail: `bd show ${id} failed` });
            continue;
        }
        if (show.status === 'closed') closedCount++;
        else openCount++;
    }

    if (epic) {
        const newChildren = bdChildrenDiff(bd, epic, spec.links.children);
        for (const id of newChildren) {
            drift.push({ kind: 'new_child', id, severity: 'warning', detail: `bd shows ${id} as child of ${epic}; not in spec.links.children` });
        }
        const cycles = bdCycles(bd, epic);
        for (const c of cycles) {
            drift.push({ kind: 'cycle', id: c, severity: 'error', detail: `cycle detected involving ${c}` });
        }
    }

    const errCount = drift.filter((d) => d.severity === 'error').length;
    const warnCount = drift.filter((d) => d.severity === 'warning').length;
    const ok = errCount === 0;
    const warningOnly = ok && warnCount > 0;

    return {
        schema: 'xt.spec.status.v1',
        spec_id: spec.id,
        spec_status: spec.status,
        links: { epic, planner_bead: plannerBead, children: spec.links.children, test_issues: spec.links.test_issues },
        open_count: openCount,
        closed_count: closedCount,
        drift,
        ok,
        warning_only: warningOnly,
    };
}

function bdShow(bd: string, id: string): BdShow | null {
    const r = spawnSync(bd, ['show', id, '--json'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    try {
        return JSON.parse(r.stdout);
    } catch {
        return null;
    }
}

function bdChildrenDiff(bd: string, epic: string, knownChildren: string[]): string[] {
    const r = spawnSync(bd, ['children', epic, '--json'], { encoding: 'utf8' });
    if (r.status !== 0) return [];
    try {
        const parsed = JSON.parse(r.stdout) as Array<{ id: string }>;
        const seen = new Set(knownChildren);
        return parsed.map((c) => c.id).filter((id) => !seen.has(id));
    } catch {
        return [];
    }
}

function bdCycles(bd: string, epic: string): string[] {
    const r = spawnSync(bd, ['dep', 'cycles', '--scope', epic, '--json'], { encoding: 'utf8' });
    if (r.status !== 0) return [];
    try {
        const parsed = JSON.parse(r.stdout);
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map((c) => (typeof c === 'string' ? c : JSON.stringify(c)));
        }
        return [];
    } catch {
        return [];
    }
}
