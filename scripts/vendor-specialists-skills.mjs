#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultRoot = path.join(repoRoot, '.xtrm', 'skills', 'default');
const optionalRoot = path.join(repoRoot, '.xtrm', 'skills', 'optional');
const manifestPath = path.join(repoRoot, '.xtrm', 'specialists-source.json');
const ownershipManifestPath = path.join(repoRoot, 'docs', 'skills-ownership.json');
const fallbackSpecialistsRepoPaths = [
  path.resolve(repoRoot, '../specialists'),
  path.resolve(repoRoot, '../../../../specialists'),
];

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertDirectoryExists(directoryPath, message) {
  try {
    if ((await fs.stat(directoryPath)).isDirectory()) return;
  } catch {
    // handled below
  }
  throw new Error(message);
}

function parseArgs(argv) {
  const source = { kind: 'repo' };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--specialists-tarball' || value.startsWith('--specialists-tarball=')) source.kind = 'tarball';
    else if (value === '--specialists-package' || value.startsWith('--specialists-package=')) source.kind = 'package';
    else if (value === '--specialists-ref') {
      source.kind = 'ref';
      source.ref = argv[++i];
    } else if (value.startsWith('--specialists-ref=')) {
      source.kind = 'ref';
      source.ref = value.slice('--specialists-ref='.length);
    }
  }
  return source;
}

async function gitText(repoPath, args) {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  return stdout.trim();
}

async function gitBytes(repoPath, args) {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'buffer',
    maxBuffer: 64 << 20,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function resolveSpecialistsRepoPath() {
  if (process.env.SPECIALISTS_REPO_PATH) {
    const explicitPath = path.resolve(repoRoot, process.env.SPECIALISTS_REPO_PATH);
    await assertDirectoryExists(explicitPath, `Missing specialists repo: ${explicitPath}`);
    return explicitPath;
  }
  for (const candidate of fallbackSpecialistsRepoPaths) {
    try {
      await assertDirectoryExists(candidate, `Missing specialists repo: ${candidate}`);
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error(`Missing specialists repo. Looked in: ${fallbackSpecialistsRepoPaths.join(', ')}`);
}

function normalizePlacement(owner) {
  const placement = owner.placement ?? { tier: 'default' };
  if (placement.tier === 'default') return { tier: 'default' };
  if (placement.tier === 'optional' && typeof placement.pack === 'string' && placement.pack.length > 0) {
    return { tier: 'optional', pack: placement.pack };
  }
  throw new Error(`Invalid specialists skill placement: ${JSON.stringify(placement)}`);
}

function destinationDir(skillName, placement) {
  if (placement.tier === 'default') return path.join(defaultRoot, skillName);
  return path.join(optionalRoot, placement.pack, skillName);
}

function previousPlacement(manifest, skillName) {
  return manifest?.placements?.[skillName] ?? { tier: 'default' };
}

function specialistsEntries(ownershipManifest) {
  return Object.entries(ownershipManifest.owners ?? {})
    .filter(([, owner]) => owner.owner === 'specialists')
    .map(([skillName, owner]) => ({ skillName, placement: normalizePlacement(owner) }))
    .sort((a, b) => a.skillName.localeCompare(b.skillName));
}

async function removePreviousVendoredPaths(previousManifest, currentEntries) {
  const cleanup = new Map();
  for (const skillName of previousManifest?.skills ?? []) {
    cleanup.set(destinationDir(skillName, previousPlacement(previousManifest, skillName)), true);
  }
  for (const { skillName, placement } of currentEntries) {
    cleanup.set(path.join(defaultRoot, skillName), true); // v1 compatibility cleanup
    cleanup.set(destinationDir(skillName, placement), true);
  }
  for (const target of cleanup.keys()) await fs.rm(target, { recursive: true, force: true });
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function shouldVendor(relativePath) {
  // Evals/workspaces are source-repo development fixtures, not runtime payload.
  return relativePath.length > 0
    && !relativePath.startsWith('evals/')
    && !relativePath.startsWith('workspace/');
}

async function listSkillFiles(specialistsRepoPath, resolvedSha, sourcePath, skillName) {
  const prefix = `${sourcePath}/${skillName}`.replaceAll('\\', '/');
  const output = await gitText(specialistsRepoPath, ['ls-tree', '-r', '--name-only', resolvedSha, '--', prefix]);
  const files = (output ? output.split('\n').filter(Boolean) : [])
    .map((fullPath) => ({ fullPath, relativePath: fullPath.slice(prefix.length + 1) }))
    .filter(({ relativePath }) => shouldVendor(relativePath));
  if (files.length === 0) throw new Error(`Missing runtime Specialists skill content at ${resolvedSha}:${prefix}`);
  return files;
}

async function vendorSkill({ specialistsRepoPath, resolvedSha, sourcePath, skillName, placement }) {
  const destination = destinationDir(skillName, placement);
  await fs.mkdir(destination, { recursive: true });

  const files = await listSkillFiles(specialistsRepoPath, resolvedSha, sourcePath, skillName);
  const gitBlobs = {};
  for (const { fullPath, relativePath } of files) {
    const bytes = await gitBytes(specialistsRepoPath, ['show', `${resolvedSha}:${fullPath}`]);
    const target = path.join(destination, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    gitBlobs[relativePath] = await gitText(specialistsRepoPath, ['rev-parse', `${resolvedSha}:${fullPath}`]);
  }

  const location = placement.tier === 'default' ? 'default' : `optional/${placement.pack}`;
  console.log(`Vendored ${skillName} @ ${resolvedSha.slice(0, 12)} -> ${location}`);
  return sortObject(gitBlobs);
}

async function main() {
  const source = parseArgs(process.argv.slice(2));
  const ownership = await readJson(ownershipManifestPath);
  const entries = specialistsEntries(ownership);
  const specialistsRepoPath = await resolveSpecialistsRepoPath();
  const sourcePath = ownership.mirrors?.specialists?.source_path;
  if (!sourcePath) throw new Error('docs/skills-ownership.json missing mirrors.specialists.source_path');

  await assertDirectoryExists(defaultRoot, `Missing default skill root: ${defaultRoot}`);
  await assertDirectoryExists(optionalRoot, `Missing optional skill root: ${optionalRoot}`);

  const requestedRef = source.ref ?? 'HEAD';
  const resolvedSha = await gitText(specialistsRepoPath, ['rev-parse', `${requestedRef}^{commit}`]);
  const previousManifest = await readJsonIfExists(manifestPath);

  await removePreviousVendoredPaths(previousManifest, entries);

  const files = {};
  const placements = {};
  for (const entry of entries) {
    if (entry.placement.tier === 'optional') {
      await assertDirectoryExists(
        path.join(optionalRoot, entry.placement.pack),
        `Missing optional pack for ${entry.skillName}: ${entry.placement.pack}`,
      );
    }
    files[entry.skillName] = await vendorSkill({ specialistsRepoPath, resolvedSha, sourcePath, ...entry });
    placements[entry.skillName] = entry.placement;
  }

  const manifest = {
    version: 2,
    digest: 'git-blob-sha1',
    source: {
      ...source,
      // CORE-2407: record the immutable commit as the ref. A moving branch name
      // (e.g. `master`) on a manifest that claims a pin lets any consumer that
      // reads .source.ref resolve a different tree than the one vendored here.
      ref: resolvedSha,
      resolved_sha: resolvedSha,
      repo_path: path.relative(repoRoot, specialistsRepoPath).split(path.sep).join('/'),
      source_path: sourcePath,
    },
    skills: entries.map(({ skillName }) => skillName),
    placements: sortObject(placements),
    files: sortObject(files),
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${path.relative(repoRoot, manifestPath)}`);
}

main().catch((error) => {
  console.error(`Vendor specialists skills failed: ${error.message}`);
  process.exit(1);
});
