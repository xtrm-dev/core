/**
 * `xt update` Beads→Substrate migration DETECTION and PLANNING
 * (ADR sections 42-43).
 *
 * A8 scope is deliberately activation-free: this module detects a legacy
 * `.beads` workspace, plans the migration, and reports the exact remediation.
 * It never backs up, exports, imports, verifies, receipts, cleans up, or
 * writes markers. Import activation, preservation verification, receipt
 * interpretation, cleanup, and cutover are owned by xtrm-6qu.9 (A9).
 *
 * Blast radius (CORE-2343): `needed` gates REPO-scoped writes only, with a
 * zero-mutation proof for that repo. User-scoped writes (~/.xtrm skills
 * payload, hook rewiring, prompt sync, Pi package assurance) cannot reach a
 * `.beads` board, so they proceed; gating them made `xt update --apply` a
 * dead end and let the global payload drift behind the installed package.
 * The gate message is a transition pointer, not a dead end — see
 * `substrateMigrationTransition`.
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
 * In-repo remediation pointer. Deliberately NOT a GitHub URL: the substrate
 * package ships no repository field, so any hardcoded link would rot into a
 * 404. `scripts/` gates assert this path exists.
 */
export const SUBSTRATE_TRANSITION_DOC = 'docs/migration/beads-to-substrate.md';

/** Machine-readable state for a repo whose board has not been migrated yet. */
export const SUBSTRATE_TRANSITION_STATUS = 'transition-pending';

export interface SubstrateTransition {
    needed: boolean;
    status: typeof SUBSTRATE_TRANSITION_STATUS;
    reason: string;
    /** Read-only inspection of the current Substrate/board state. */
    inspectCommand: string;
    /** Full remediation write-up, relative to the repo root. */
    docPath: string;
    /** False until the A9 import pipeline ships; no xt release clears this yet. */
    clearsWithUpgrade: false;
}

/**
 * The transition a blocked repo is in: repo-scope writes are gated, the board
 * is untouched, and the operator has a resolvable next step. This is DATA, not
 * prose, so callers can surface it as-is and machines can enumerate it.
 */
export function substrateMigrationTransition(plan: MigrationPlan): SubstrateTransition | null {
    if (!plan.needed) return null;
    return {
        needed: true,
        status: SUBSTRATE_TRANSITION_STATUS,
        reason: plan.reason,
        inspectCommand: 'xt doctor',
        docPath: SUBSTRATE_TRANSITION_DOC,
        clearsWithUpgrade: false,
    };
}

/**
 * Single source of truth for the ADR 43 gate message.
 * Returns the remediation whenever migration is needed, null when the repo
 * needs nothing. "Needed" gates REPO-scope writes only — user-scope writes
 * (~/.xtrm payload, hook rewiring, prompt sync) cannot reach `.beads` and are
 * not gated. Never instructs deletion or hand-migration: the operator must not
 * destroy the board, and no released xt version clears this gate (CORE-2343).
 */
export function migrationBlockedReason(plan: MigrationPlan): string | null {
    const transition = substrateMigrationTransition(plan);
    if (!transition) return null;
    const sbHint = plan.sbAvailable
        ? ''
        : ' Install @jaggerxtrm/substrate via `xt init` first.';
    return `legacy .beads workspace gates repo-scoped \`xt update --apply\` (transition pending): ${transition.reason}. Do NOT delete or hand-migrate \`.beads\` (irreversible work loss).${sbHint} Inspect with \`${transition.inspectCommand}\`; remediation: ${transition.docPath}. No released xt version clears this gate — the A9 import pipeline has not shipped.`;
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
