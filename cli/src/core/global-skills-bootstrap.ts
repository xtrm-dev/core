import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'fs-extra';
import path from 'node:path';
import { assertStagedTreeSafe, extractValidatedBackup, inspectBackupArchive } from './backup-archive.js';
import { resolveGlobalSkillsRoot, resolveStateFilePath, SKILLS_STATE_SCHEMA_VERSION } from './skills-layout.js';
import { atomicSwapDirectory, materializeGlobalRuntimeViews } from './skills-materializer.js';

import {
  INSTALLER_MANIFEST_FILENAME,
  listFilesUnder,
  pruneEmptyDirsUnder,
  readManifestJson,
  removeTrackedEntries,
  writeManifestJson,
} from './installer-manifest.js';
import { readSkillsState } from './skills-state.js';

// xtrm-wiy5n.4.37 — the manifest records every file the previous install wrote
// under each tier. On the next install we remove ONLY those paths, then copy
// the new payload. A file the installer never wrote is left alone.
interface SkillsInstallerManifest {
  default?: string[];
  optional?: string[];
}

function resolveSkillsManifestPath(globalSkillsRoot: string): string {
  return path.join(globalSkillsRoot, INSTALLER_MANIFEST_FILENAME);
}

interface BootstrapOptions {
  readonly force?: boolean;
}

interface BootstrapResult {
  readonly installedVersion: string;
  readonly changed: boolean;
}

interface BootstrapLogEvent {
  readonly timestamp: string;
  readonly component: 'skills-bootstrap';
  readonly event: string;
  readonly pkgVersion: string;
  readonly source?: string;
  readonly target?: string;
  readonly filesCopied?: number;
  readonly durationMs?: number;
  readonly outcome?: 'ok' | 'skipped' | 'error';
  readonly command?: string;
  readonly cwd?: string;
}

const COPY_FILTER = (sourcePath: string): boolean => !sourcePath.endsWith('__pycache__');

function hashPath(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function formatLogPath(filePath: string): string {
  const normalized = path.resolve(filePath);
  const globalRoot = path.resolve(path.join(path.dirname(resolveGlobalSkillsRoot()), '..'));
  return normalized.startsWith(globalRoot) ? normalized : `sha256:${hashPath(normalized)}`;
}

interface VerifiedSkillsBackup {
  readonly archivePath: string;
  readonly sidecarPath: string;
  readonly sha256: string;
}

function hashArchive(archivePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
}

async function createVerifiedSkillsBackup(globalSkillsRoot: string): Promise<VerifiedSkillsBackup | null> {
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

async function restoreSkillsBackup(globalSkillsRoot: string, backup: VerifiedSkillsBackup | null): Promise<void> {
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

async function appendLog(event: BootstrapLogEvent): Promise<void> {
  const logPath = path.join(path.dirname(resolveGlobalSkillsRoot()), 'logs', 'skills-migration.jsonl');
  await fs.ensureDir(path.dirname(logPath));
  await fs.appendFile(logPath, `${JSON.stringify(event)}\n`);
}

export async function logBootstrapTrigger(params: {
  readonly command: string;
  readonly cwd: string;
  readonly pkgVersion: string;
}): Promise<void> {
  await appendLog({
    timestamp: new Date().toISOString(),
    component: 'skills-bootstrap',
    event: 'bootstrap.trigger',
    command: params.command,
    cwd: params.cwd,
    pkgVersion: params.pkgVersion,
  });
}

async function copyTier(
  sourceRoot: string,
  targetRoot: string,
  previousEntries: readonly string[],
): Promise<string[]> {
  await fs.ensureDir(targetRoot);
  await removeTrackedEntries(targetRoot, previousEntries);
  await pruneEmptyDirsUnder(targetRoot);
  await fs.copy(sourceRoot, targetRoot, { filter: COPY_FILTER, overwrite: true });
  // Manifest lists ONLY what we just copied — derived from the source walk
  // (same __pycache__ filter as COPY_FILTER), not from listFilesUnder(target).
  // Walking the target would adopt pre-existing user files that were never
  // ours, and the next install would then delete them (xtrm-wiy5n.4.37 hole
  // caught by the review of the first commit on this PR).
  return listFilesUnder(sourceRoot);
}

export async function ensureGlobalSkillsBootstrapped(pkgRoot: string, opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const pkgJsonPath = path.join(pkgRoot, 'package.json');
  const pkgJson = await fs.readJson(pkgJsonPath) as { version?: string };
  const installedVersion = pkgJson.version;

  if (!installedVersion) {
    throw new Error(`Failed to read package version from ${pkgJsonPath}.`);
  }

  const globalSkillsRoot = resolveGlobalSkillsRoot();
  const statePath = resolveStateFilePath(globalSkillsRoot);
  const sourceRoot = path.join(pkgRoot, '.xtrm', 'skills');
  const targetRoot = globalSkillsRoot;
  const startedAt = Date.now();

  await appendLog({
    timestamp: new Date().toISOString(),
    component: 'skills-bootstrap',
    event: 'bootstrap.start',
    pkgVersion: installedVersion,
    source: formatLogPath(sourceRoot),
    target: formatLogPath(targetRoot),
    filesCopied: 0,
    durationMs: 0,
    outcome: 'ok',
  });

  let backup: VerifiedSkillsBackup | null = null;
  let mutationStarted = false;
  try {
    const currentState = await readSkillsState(globalSkillsRoot);
    if (!opts.force && currentState.installedVersion === installedVersion) {
      await appendLog({
        timestamp: new Date().toISOString(),
        component: 'skills-bootstrap',
        event: 'bootstrap.ok',
        pkgVersion: installedVersion,
        source: formatLogPath(sourceRoot),
        target: formatLogPath(targetRoot),
        filesCopied: 0,
        durationMs: Date.now() - startedAt,
        outcome: 'skipped',
      });
      return { installedVersion, changed: false };
    }

    backup = await createVerifiedSkillsBackup(globalSkillsRoot);
    const manifestPath = resolveSkillsManifestPath(globalSkillsRoot);
    const previousManifest = await readManifestJson<SkillsInstallerManifest>(manifestPath, {});
    const nextManifest: SkillsInstallerManifest = {};
    let filesCopied = 0;
    mutationStarted = true;
    for (const asset of ['default', 'optional'] as const) {
      const assetSource = path.join(sourceRoot, asset);
      const assetTarget = path.join(targetRoot, asset);
      const assetStartedAt = Date.now();
      const entries = await copyTier(assetSource, assetTarget, previousManifest[asset] ?? []);
      nextManifest[asset] = entries;
      filesCopied += entries.length;

      await appendLog({
        timestamp: new Date().toISOString(),
        component: 'skills-bootstrap',
        event: `bootstrap.copy.${asset}`,
        pkgVersion: installedVersion,
        source: formatLogPath(assetSource),
        target: formatLogPath(assetTarget),
        filesCopied: entries.length,
        durationMs: Date.now() - assetStartedAt,
        outcome: 'ok',
      });
    }

    await writeManifestJson(manifestPath, nextManifest);
    await fs.remove(path.join(globalSkillsRoot, 'active'));

    const currentStateForMetadata = await readSkillsState(globalSkillsRoot);
    await fs.writeJson(statePath, {
      schemaVersion: SKILLS_STATE_SCHEMA_VERSION,
      enabledPacks: currentStateForMetadata.enabledPacks,
      managedLinks: currentStateForMetadata.managedLinks,
      installedVersion,
      installedFrom: formatLogPath(pkgRoot),
      installedAt: new Date().toISOString(),
    }, { spaces: 2 });
    await fs.appendFile(statePath, '\n');

    // Rebuild the user-scope runtime views from the just-written state. The
    // payload above may have changed and `active/` was removed, so pointers
    // would otherwise dangle (xtrm-e7jzt.2).
    await materializeGlobalRuntimeViews();

    await appendLog({
      timestamp: new Date().toISOString(),
      component: 'skills-bootstrap',
      event: 'bootstrap.ok',
      pkgVersion: installedVersion,
      source: formatLogPath(sourceRoot),
      target: formatLogPath(targetRoot),
      filesCopied,
      durationMs: Date.now() - startedAt,
      outcome: 'ok',
    });

    return { installedVersion, changed: true };
  } catch (error) {
    if (mutationStarted) {
      try {
        await restoreSkillsBackup(globalSkillsRoot, backup);
        await appendLog({
          timestamp: new Date().toISOString(),
          component: 'skills-bootstrap',
          event: 'bootstrap.rollback',
          pkgVersion: installedVersion,
          source: formatLogPath(sourceRoot),
          target: formatLogPath(targetRoot),
          filesCopied: 0,
          durationMs: Date.now() - startedAt,
          outcome: 'ok',
        });
      } catch (rollbackError) {
        await appendLog({
          timestamp: new Date().toISOString(),
          component: 'skills-bootstrap',
          event: 'bootstrap.rollback',
          pkgVersion: installedVersion,
          source: formatLogPath(sourceRoot),
          target: formatLogPath(targetRoot),
          filesCopied: 0,
          durationMs: Date.now() - startedAt,
          outcome: 'error',
        });
        throw new Error(`Global skills rollback failed: ${(rollbackError as Error).message}; original error: ${(error as Error).message}`);
      }
    }
    await appendLog({
      timestamp: new Date().toISOString(),
      component: 'skills-bootstrap',
      event: 'bootstrap.error',
      pkgVersion: installedVersion,
      source: formatLogPath(sourceRoot),
      target: formatLogPath(targetRoot),
      filesCopied: 0,
      durationMs: Date.now() - startedAt,
      outcome: 'error',
    });
    throw error;
  }
}
