import { spawnSync } from 'node:child_process';
import type { SpecV1 } from './schema.js';
import { computeStatus } from './drift.js';

export type GateFailureCode =
    | 'wrong_status'
    | 'epic_missing'
    | 'epic_open'
    | 'child_open'
    | 'test_open'
    | 'review_missing'
    | 'drift_present'
    | 'already_archived';

export interface GateFailure {
    code: GateFailureCode;
    detail: string;
}

export interface GateResult {
    ok: boolean;
    failures: GateFailure[];
}

interface GateOptions {
    bdBinary?: string;
}

/**
 * Decide whether a spec is archive-ready.
 * Read-only against bd; no state mutation.
 */
export async function checkArchiveGate(spec: SpecV1, opts: GateOptions = {}): Promise<GateResult> {
    const bd = opts.bdBinary ?? process.env.XT_SPEC_BD_BINARY ?? 'bd';
    const failures: GateFailure[] = [];

    if (spec.status === 'archived') {
        failures.push({ code: 'already_archived', detail: 'spec.status is already archived' });
        return { ok: false, failures };
    }
    if (spec.status !== 'planned') {
        failures.push({ code: 'wrong_status', detail: `spec.status must be "planned" to archive (current: "${spec.status}")` });
    }

    const epic = spec.links.epic;
    if (!epic) {
        failures.push({ code: 'epic_missing', detail: 'spec.links.epic is null — apply was never reconciled' });
        return { ok: failures.length === 0, failures };
    }

    const epicStatus = bdStatus(bd, epic);
    if (epicStatus !== 'closed') {
        failures.push({ code: 'epic_open', detail: `epic ${epic} status is "${epicStatus ?? 'unknown'}" (need "closed")` });
    }

    for (const id of spec.links.children) {
        const s = bdStatus(bd, id);
        if (s !== 'closed') failures.push({ code: 'child_open', detail: `child ${id} status "${s ?? 'unknown'}"` });
    }
    for (const id of spec.links.test_issues) {
        const s = bdStatus(bd, id);
        if (s !== 'closed') failures.push({ code: 'test_open', detail: `test issue ${id} status "${s ?? 'unknown'}"` });
    }

    if (spec.scrutiny === 'high' || spec.scrutiny === 'critical') {
        const marker = bdKv(bd, `reviewed:${epic}`);
        if (!marker) {
            failures.push({
                code: 'review_missing',
                detail: `scrutiny=${spec.scrutiny} requires \`bd kv set reviewed:${epic} <evidence>\` before archive`,
            });
        }
    }

    const status = await computeStatus(spec, { bdBinary: bd });
    if (!status.ok || status.drift.length > 0) {
        const driftKinds = status.drift.map((d) => d.kind).join(', ');
        failures.push({ code: 'drift_present', detail: `xt spec status reports drift: ${driftKinds || 'unspecified'}` });
    }

    return { ok: failures.length === 0, failures };
}

function bdStatus(bd: string, id: string): string | null {
    const r = spawnSync(bd, ['show', id, '--json'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    try {
        return (JSON.parse(r.stdout) as { status?: string }).status ?? null;
    } catch {
        return null;
    }
}

function bdKv(bd: string, key: string): string | null {
    const r = spawnSync(bd, ['kv', 'get', key], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const value = r.stdout.trim();
    return value.length > 0 ? value : null;
}
