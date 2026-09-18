import fs from 'fs-extra';
import path from 'node:path';
import yaml from 'yaml';
import { migrationBlockedReason, planSubstrateMigration } from './substrate-migration.js';

export type SharedBeadsServerState = 'enabled' | 'updated' | 'not-applicable';

export async function hasBeadsDir(repoRoot: string): Promise<boolean> {
  return fs.pathExists(path.join(repoRoot, '.beads'));
}

export async function ensureBeadsSharedServerEnabled(repoRoot: string, apply: boolean): Promise<{ changed: boolean; state: SharedBeadsServerState }> {
  const beadsDir = path.join(repoRoot, '.beads');
  if (!await fs.pathExists(beadsDir)) return { changed: false, state: 'not-applicable' };

  // CORE-2302 (A9 lane part 1): the install-path writer is gated behind
  // planSubstrateMigration. A legacy `.beads` board always blocks apply:
  // the A9 pipeline owns import activation, and update already fails closed
  // on the same plan. The read-only probe (apply=false, doctor) is
  // unaffected — detection never mutates.
  if (apply) {
    const plan = await planSubstrateMigration(repoRoot);
    if (plan.needed) {
      const blocked = migrationBlockedReason(plan);
      throw new Error(blocked ?? plan.reason);
    }
  }

  const configPath = path.join(beadsDir, 'config.yaml');
  const raw = await fs.pathExists(configPath) ? await fs.readFile(configPath, 'utf8') : '';
  // yaml.parse returns null for a comments-only file (default after fresh `bd init`);
  // also guard against non-object scalar parses just in case.
  const rawParsed = raw.trim() ? yaml.parse(raw) : {};
  const parsed = (rawParsed && typeof rawParsed === 'object' && !Array.isArray(rawParsed)
    ? rawParsed
    : {}) as Record<string, unknown>;
  const dolt = ((parsed.dolt as Record<string, unknown> | undefined) ?? {});
  if (dolt['shared-server'] === true) return { changed: false, state: 'enabled' };

  if (!apply) return { changed: true, state: 'updated' };

  const next = { ...parsed, dolt: { ...dolt, 'shared-server': true } };
  await fs.ensureDir(beadsDir);
  await fs.writeFile(configPath, yaml.stringify(next));
  return { changed: true, state: 'updated' };
}
