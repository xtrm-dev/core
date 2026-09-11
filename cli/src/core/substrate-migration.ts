/**
 * `xt update` Beads→Substrate migration DETECTION and PLANNING
 * (ADR sections 42-43).
 *
 * A8 scope is deliberately activation-free: this module detects a legacy
 * `.beads` workspace, plans the migration, and reports the exact remediation.
 * It never backs up, exports, imports, verifies, receipts, cleans up, or
 * writes markers. Import activation, preservation verification, receipt
 * interpretation, cleanup, and cutover are owned by xtrm-6qu.9 (A9):
 * `xt update --apply` fails closed on any legacy `.beads` repo BEFORE all
 * apply-mode global/repo/runtime mutation, with zero-mutation proof.
 *
 * Forward compatibility: `readMigrationMarker` honors a marker file the A9
 * pipeline will write; nothing in A8 creates one.
 */

import fs from 'fs-extra';
import path from 'node:path';
import { defaultSbRunner, getSbVersion, type SbRunner } from './substrate.js';

/** Marker file the A9 migration pipeline writes on success (A8 never writes). */
export const MIGRATION_MARKER = '.substrate-migrated.json';

export interface MigrationPlan {
    needed: boolean;
    hasBeads: boolean;
    alreadyMigrated: boolean;
    sbAvailable: boolean;
    reason: string;
}

/**
 * Single source of truth for the ADR 43 fail-closed gate.
 * Returns the exact remediation whenever migration is needed, null when the
 * repo needs nothing. A8 never activates the import, so "needed" is always
 * blocking: callers must treat a non-null result as a zero-mutation abort —
 * no global, repo, or runtime writes before or after this decision in the
 * same run.
 */
export function migrationBlockedReason(plan: MigrationPlan): string | null {
    if (!plan.needed) return null;
    const sbHint = plan.sbAvailable
        ? ''
        : ' Install @xtrm/substrate via `xt init` first, then';
    // No manual migration posture: the operator must not hand-migrate or
    // delete the board. Automated migration ships with the A9 pipeline;
    // the truthful action is upgrading xt and re-running.
    return `legacy .beads workspace blocks \`xt update --apply\`: automated Substrate migration ships with the A9 pipeline. Do NOT delete \`.beads\` (irreversible work loss).${sbHint} Upgrade xt, then re-run \`xt update --apply\`.`;
}

export async function readMigrationMarker(repoRoot: string): Promise<Record<string, unknown> | null> {
    const markerPath = path.join(repoRoot, '.xtrm', MIGRATION_MARKER);
    try {
        if (!await fs.pathExists(markerPath)) return null;
        return await fs.readJson(markerPath) as Record<string, unknown>;
    } catch {
        return null;
    }
}

export async function planSubstrateMigration(repoRoot: string, run: SbRunner = defaultSbRunner): Promise<MigrationPlan> {
    const marker = await readMigrationMarker(repoRoot);
    const hasBeads = await fs.pathExists(path.join(repoRoot, '.beads'));
    if (marker && !hasBeads) {
        return {
            needed: false,
            hasBeads,
            alreadyMigrated: true,
            sbAvailable: getSbVersion(run).available,
            reason: `already migrated (receipt ${String(marker.receipt ?? 'unknown')})`,
        };
    }
    if (marker && hasBeads) {
        // A8 has no A9 receipt verifier: ANY marker (forged, stale, or
        // genuine) is informational only while the board is still present.
        // A present board always blocks.
        return {
            needed: true,
            hasBeads,
            alreadyMigrated: false,
            sbAvailable: getSbVersion(run).available,
            reason: 'legacy .beads workspace present with an unverified migration marker — A9 verification required',
        };
    }
    if (!hasBeads) {
        return { needed: false, hasBeads, alreadyMigrated: false, sbAvailable: getSbVersion(run).available, reason: 'no .beads directory' };
    }
    const sbAvailable = getSbVersion(run).available;
    return {
        needed: true,
        hasBeads,
        alreadyMigrated: false,
        sbAvailable,
        reason: sbAvailable
            ? 'legacy .beads workspace pending Substrate import (A9 pipeline)'
            : 'sb unavailable — run xt init to install Substrate, then re-run xt update --apply',
    };
}
