import fs from 'fs-extra';
import path from 'node:path';
import yaml from 'yaml';

export type SharedBeadsServerState = 'enabled' | 'updated' | 'not-applicable';

export async function hasBeadsDir(repoRoot: string): Promise<boolean> {
  return fs.pathExists(path.join(repoRoot, '.beads'));
}

export async function ensureBeadsSharedServerEnabled(repoRoot: string, apply: boolean): Promise<{ changed: boolean; state: SharedBeadsServerState }> {
  const beadsDir = path.join(repoRoot, '.beads');
  if (!await fs.pathExists(beadsDir)) return { changed: false, state: 'not-applicable' };

  const configPath = path.join(beadsDir, 'config.yaml');
  const raw = await fs.pathExists(configPath) ? await fs.readFile(configPath, 'utf8') : '';
  const parsed = (raw.trim() ? yaml.parse(raw) : {}) as Record<string, unknown>;
  const dolt = ((parsed.dolt as Record<string, unknown> | undefined) ?? {});
  if (dolt['shared-server'] === true) return { changed: false, state: 'enabled' };

  if (!apply) return { changed: true, state: 'updated' };

  const next = { ...parsed, dolt: { ...dolt, 'shared-server': true } };
  await fs.ensureDir(beadsDir);
  await fs.writeFile(configPath, yaml.stringify(next));
  return { changed: true, state: 'updated' };
}
