// nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- runs the vendored python migrator; args are project-derived (basename + constant path + readdir pack name), never user-controllable.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { rebuildAllRuntimeActiveViews } from './skills-materializer.js';

/**
 * Registry-gated, idempotent service-skills migration runner.
 *
 * Makes `xt update --apply` (and `xt init`) the FOOLPROOF, single-button path to
 * the service-skills v2 layout: when a repo has a service-registry (any layout),
 * run the one-time layout migrator (flat → per-repo umbrella, relocate + rewrite
 * the registry, generate the umbrella). It is a no-op in repos with no
 * service-registry, and idempotent on already-migrated repos.
 *
 * Claude/Pi activation hooks ship via the global service-skills policies and are
 * reconciled into settings.json by claude-runtime-sync (xtrm-0p7bp). This module
 * owns the data migration AND wires the local git post-merge drift sweep (the
 * post-merge reconciliation trigger, xtrm-jcmub) on the same foolproof path.
 */

const PACKS_REL = path.join('.xtrm', 'skills', 'user', 'packs');
const MIGRATOR_REL = path.join('.xtrm', 'skills', 'default', 'service-skills', 'scripts', 'layout_migrator.py');
const INSTALLER_REL = path.join('.xtrm', 'skills', 'default', 'service-skills', 'install', 'install-service-skills.py');

export interface ServiceSkillsEnsureResult {
  /** Whether the repo has a service-registry (i.e. service-skills apply here). */
  readonly applicable: boolean;
  /** Packs migrated to the umbrella layout on this run. */
  readonly migratedPacks: string[];
  /** True when nothing needed migrating (no-op / already current). */
  readonly alreadyCurrent: boolean;
  /** Human-readable notes (migrator output, warnings, refusals). */
  readonly notes: string[];
}

async function packsWithRegistry(projectRoot: string): Promise<string[]> {
  const packsRoot = path.join(projectRoot, PACKS_REL);
  if (!await fs.pathExists(packsRoot)) {
    return [];
  }
  const entries = await fs.readdir(packsRoot, { withFileTypes: true });
  const packs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packPath = path.join(packsRoot, entry.name);
    const hasUmbrellaRegistry = await fs.pathExists(path.join(packPath, 'service-skills', 'service-registry.json'));
    const hasFlatRegistry = await fs.pathExists(path.join(packPath, 'service-registry.json'));
    if (hasUmbrellaRegistry || hasFlatRegistry) {
      packs.push(entry.name);
    }
  }
  return packs.sort((a, b) => a.localeCompare(b));
}

/** True when the repo has any service-registry (pack, root, or legacy .claude). */
export async function hasServiceRegistry(projectRoot: string): Promise<boolean> {
  if ((await packsWithRegistry(projectRoot)).length > 0) {
    return true;
  }
  return (await fs.pathExists(path.join(projectRoot, 'service-registry.json')))
    || (await fs.pathExists(path.join(projectRoot, '.claude', 'skills', 'service-registry.json')));
}

export async function ensureServiceSkills(
  projectRoot: string,
  opts: { apply: boolean },
): Promise<ServiceSkillsEnsureResult> {
  const notes: string[] = [];
  const migratedPacks: string[] = [];

  const packs = await packsWithRegistry(projectRoot);
  const applicable = packs.length > 0 || await hasServiceRegistry(projectRoot);
  if (!applicable) {
    // No service-registry → service-skills do not apply here. Silent no-op.
    return { applicable: false, migratedPacks, alreadyCurrent: true, notes };
  }

  const migrator = path.join(projectRoot, MIGRATOR_REL);
  if (!await fs.pathExists(migrator)) {
    notes.push('service-skills machinery not installed yet — skills must be installed (xt update) before migration.');
    return { applicable: true, migratedPacks, alreadyCurrent: true, notes };
  }

  if (!opts.apply) {
    notes.push(`service-skills migration available (dry-run) for pack(s): ${packs.join(', ') || '(root/legacy registry)'}.`);
    return { applicable: true, migratedPacks, alreadyCurrent: true, notes };
  }

  const repoName = path.basename(projectRoot);
  const targetPacks = packs.length > 0 ? packs : [''];
  for (const pack of targetPacks) {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    const run = spawnSync('python3', [migrator, repoName], {
      cwd: projectRoot,
      encoding: 'utf8',
      // Pass the project root explicitly (the CLI knows it) so the migrator never
      // depends on a git checkout; scope to the pack being migrated.
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectRoot,
        ...(pack ? { XTRM_PACK: pack } : {}),
      },
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    if (run.status === 2) {
      notes.push(`service-skills: pack '${pack}' migration refused — ${(run.stderr ?? '').trim()}`);
      continue;
    }
    const lines = output.split('\n');
    if (lines.some(line => line.startsWith('migrated:'))) {
      migratedPacks.push(pack || repoName);
    }
    for (const line of lines) {
      if (line.startsWith('migrated:') || line.startsWith('umbrella:') || line.startsWith('registry:') || line.includes('WARNING')) {
        notes.push(`service-skills: ${line.trim()}`);
      }
    }
  }

  // Rebuild the runtime active view AFTER a migration (xtrm-x8b5g). The migrator just
  // moved services into the umbrella and synced PACK.json; but the active-view rebuild in
  // the normal flow is gated (update: only when registry files drifted; init: Phase 6b runs
  // *before* this migration), so a migration-only pass would leave .xtrm/skills/active frozen
  // — the consumer would never see the new `service-skills` machinery + `<repo>-services`
  // umbrella. Rebuild here, scoped to an actual migration. Idempotent (atomic swap) and
  // best-effort: a failure is noted, never aborts the update.
  if (migratedPacks.length > 0) {
    try {
      const skillsRoot = path.join(projectRoot, '.xtrm', 'skills');
      const views = await rebuildAllRuntimeActiveViews(skillsRoot);
      notes.push(`service-skills: active view rebuilt after migration (${views[0]?.discoveredSkillCount ?? 0} skills).`);
    } catch (error) {
      notes.push(`service-skills: active-view rebuild after migration skipped — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Wire the local git post-merge drift sweep (xtrm-jcmub) on the foolproof path.
  // Registry-gated (we only reach here when applicable). Idempotent — marker-guarded
  // installer; a no-op on repos that already have it. Never fails the update.
  await ensurePostMergeDriftHook(projectRoot, notes);

  return { applicable: true, migratedPacks, alreadyCurrent: migratedPacks.length === 0, notes };
}

/**
 * Install the service-skills git hooks (including the post-merge drift sweep) via the
 * vendored installer's `--hooks-only` mode. Best-effort and idempotent: any failure is
 * recorded as a note and never aborts `xt update`.
 */
async function ensurePostMergeDriftHook(projectRoot: string, notes: string[]): Promise<void> {
  const installer = path.join(projectRoot, INSTALLER_REL);
  if (!await fs.pathExists(installer)) {
    return;
  }
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  const run = spawnSync('python3', [installer, '--hooks-only'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
  });
  if (run.status !== 0) {
    notes.push(`service-skills: post-merge drift hook wiring skipped — ${(run.stderr ?? '').trim() || 'installer error'}`);
  }
}
