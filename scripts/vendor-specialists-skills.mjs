#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const destinationRoot = path.join(repoRoot, '.xtrm', 'skills', 'default');
const manifestPath = path.join(repoRoot, '.xtrm', 'specialists-source.json');
const ownershipManifestPath = path.join(repoRoot, 'docs', 'skills-ownership.json');
const fallbackSpecialistsRepoPaths = [
  path.resolve(repoRoot, '../specialists'),
  path.resolve(repoRoot, '../../../../specialists'),
];

async function assertDirectoryExists(directoryPath, errorMessage) {
  try {
    const stats = await fs.stat(directoryPath);
    if (!stats.isDirectory()) throw new Error(errorMessage);
  } catch {
    throw new Error(errorMessage);
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function getSpecialistsSkillNames(manifest) {
  return Object.entries(manifest.owners)
    .filter(([, owner]) => owner.owner === 'specialists')
    .map(([skillName]) => skillName)
    .sort();
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

async function resolveCommitSha(specialistsRepoPath) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', specialistsRepoPath, 'rev-parse', 'HEAD']);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function resolveCommitRef(specialistsRepoPath) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', specialistsRepoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const ref = stdout.trim();
    return ref === 'HEAD' ? null : ref;
  } catch {
    return null;
  }
}

async function resolveSpecialistsRepoPath() {
  if (process.env.SPECIALISTS_REPO_PATH) {
    const explicitPath = path.resolve(repoRoot, process.env.SPECIALISTS_REPO_PATH);
    await assertDirectoryExists(
      explicitPath,
      `Missing specialists repo: ${explicitPath}. Set SPECIALISTS_REPO_PATH to specialists checkout.`,
    );
    return explicitPath;
  }

  for (const candidatePath of fallbackSpecialistsRepoPaths) {
    try {
      await assertDirectoryExists(candidatePath, `Missing specialists repo: ${candidatePath}`);
      return candidatePath;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Missing specialists repo. Looked in: ${fallbackSpecialistsRepoPaths.join(', ')}. Set SPECIALISTS_REPO_PATH to specialists checkout.`,
  );
}

async function collectFilePaths(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === '__pycache__') continue;
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFilePaths(absolutePath));
      continue;
    }
    if (entry.isFile()) files.push(absolutePath);
  }

  return files;
}

async function hashFile(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function copySkillDirectory(specialistsSkillsRoot, skillName) {
  const sourceDir = path.join(specialistsSkillsRoot, skillName);
  const destinationDir = path.join(destinationRoot, skillName);

  await assertDirectoryExists(sourceDir, `Missing specialists skill dir: ${sourceDir}`);
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true });
  await fs.cp(sourceDir, destinationDir, { recursive: true, force: true, errorOnExist: false });
  console.log(`Vendored ${skillName} from ${sourceDir}`);
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

async function buildManifest(source, specialistsRepoPath, specialistsSkillsRoot, skillNames) {
  const files = {};
  for (const skillName of skillNames) {
    const skillDir = path.join(specialistsSkillsRoot, skillName);
    const skillFiles = await collectFilePaths(skillDir);
    const hashes = {};
    for (const filePath of skillFiles) {
      const relativePath = path.relative(skillDir, filePath).split(path.sep).join('/');
      hashes[relativePath] = await hashFile(filePath);
    }
    files[skillName] = sortObject(hashes);
  }

  const resolvedSha = await resolveCommitSha(specialistsRepoPath);
  const detectedRef = source.ref ?? (await resolveCommitRef(specialistsRepoPath));

  const sourceBlock = {
    ...source,
    ...(detectedRef ? { ref: detectedRef } : {}),
    ...(resolvedSha ? { resolved_sha: resolvedSha } : {}),
    repo_path: path.relative(repoRoot, specialistsRepoPath).split(path.sep).join('/'),
    source_path: path.relative(specialistsRepoPath, specialistsSkillsRoot).split(path.sep).join('/'),
  };

  return {
    version: 1,
    source: sourceBlock,
    skills: skillNames,
    files,
  };
}

async function main() {
  const source = parseArgs(process.argv.slice(2));
  const ownershipManifest = await readJson(ownershipManifestPath);
  const specialistsRepoPath = await resolveSpecialistsRepoPath();
  const specialistsSkillsRoot = path.join(specialistsRepoPath, ownershipManifest.mirrors.specialists.source_path);
  const skillNames = getSpecialistsSkillNames(ownershipManifest);

  await assertDirectoryExists(specialistsSkillsRoot, `Missing specialists skills root: ${specialistsSkillsRoot}`);
  await assertDirectoryExists(destinationRoot, `Missing destination root: ${destinationRoot}`);

  for (const skillName of skillNames) {
    await copySkillDirectory(specialistsSkillsRoot, skillName);
  }

  const manifest = await buildManifest(source, specialistsRepoPath, specialistsSkillsRoot, skillNames);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${path.relative(repoRoot, manifestPath)}`);
}

main().catch((error) => {
  console.error(`Vendor specialists skills failed: ${error.message}`);
  process.exit(1);
});
