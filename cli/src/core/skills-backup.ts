import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'fs-extra';
import path from 'node:path';
import { assertStagedTreeSafe, extractValidatedBackup, inspectBackupArchive } from './backup-archive.js';
import { atomicSwapDirectory } from './skills-materializer.js';

// Restorable snapshot of a skills root (default/, optional/, active/, state).
// Extracted verbatim from global-skills-bootstrap so any destructive skills
// writer — bootstrap AND prune — snapshots through the same verified helper.

export interface VerifiedSkillsBackup {
  readonly archivePath: string;
  readonly sidecarPath: string;
  readonly sha256: string;
}

function hashArchive(archivePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
}

export async function createVerifiedSkillsBackup(globalSkillsRoot: string): Promise<VerifiedSkillsBackup | null> {
  if (!await fs.pathExists(globalSkillsRoot)) {
    return null;
  }

  const backupRoot = path.join(path.dirname(globalSkillsRoot), 'migration-backups');
  await fs.ensureDir(backupRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = path.join(backupRoot, `global-skills-${stamp}.tgz`);
  const sidecarPath = `${archivePath}.sha256.json`;
  const parentDir = path.dirname(globalSkillsRoot);
  const sourceBasename = path.basename(globalSkillsRoot);
  const result = spawnSync('tar', ['-czf', archivePath, '-C', parentDir, sourceBasename], { stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`Failed to create skills backup archive: ${result.stderr.toString() || 'unknown error'}`);
  }

  const sha256 = hashArchive(archivePath);
  await fs.writeJson(sidecarPath, { archivePath, sha256 }, { spaces: 2 });
  await fs.appendFile(sidecarPath, '\n');
  const sidecar = await fs.readJson(sidecarPath) as { sha256?: string };
  if (sidecar.sha256 !== sha256) {
    throw new Error(`Failed to verify skills backup digest sidecar: ${sidecarPath}`);
  }
  inspectBackupArchive(archivePath, 'skills', { allowSymlinks: true });
  return { archivePath, sidecarPath, sha256 };
}

export async function restoreSkillsBackup(globalSkillsRoot: string, backup: VerifiedSkillsBackup | null): Promise<void> {
  if (!backup) {
    await fs.remove(globalSkillsRoot).catch(() => undefined);
    return;
  }

  const sidecar = await fs.readJson(backup.sidecarPath) as { sha256?: string };
  const actualHash = hashArchive(backup.archivePath);
  if (sidecar.sha256 !== backup.sha256 || actualHash !== backup.sha256) {
    throw new Error(`Skills backup digest mismatch for ${backup.archivePath}`);
  }

  inspectBackupArchive(backup.archivePath, 'skills', { allowSymlinks: true });
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-global-skills-restore-'));
  try {
    extractValidatedBackup(backup.archivePath, 'skills', staging, { allowSymlinks: true });
    await assertStagedTreeSafe(staging, 'skills', { allowSymlinks: true });
    const stagedRoot = path.join(staging, 'skills');
    await fs.ensureDir(path.dirname(globalSkillsRoot));
    await atomicSwapDirectory(stagedRoot, globalSkillsRoot);
  } finally {
    await fs.remove(staging).catch(() => undefined);
  }
}
