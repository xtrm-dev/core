#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const packageJsonPath = path.join(repoRoot, 'package.json');
const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

const assets = {
  hooks: {
    source_dir: '.xtrm/hooks',
    install_mode: 'copy',
  },
  skills: {
    source_dir: '.xtrm/skills/default',
    install_mode: 'copy',
  },
  skills_optional: {
    source_dir: '.xtrm/skills/optional',
    install_mode: 'copy',
  },
  config: {
    source_dir: '.xtrm/config',
    install_mode: 'copy',
  },
};

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function isIgnoredByGit(relativePath) {
  const result = spawnSync('git', ['check-ignore', '-q', relativePath], {
    cwd: repoRoot,
    stdio: 'ignore',
  });

  if (result.status === 0) return true;
  if (result.status === 1) return false;

  throw new Error(`git check-ignore failed for ${relativePath}`);
}

async function ensureSourceDirExists(sourceDir) {
  const absolutePath = path.resolve(repoRoot, sourceDir);
  return fs.realpath(absolutePath);
}

async function collectFilePaths(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === '__pycache__') continue;

    const absolutePath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      const nestedFiles = await collectFilePaths(absolutePath);
      files.push(...nestedFiles);
      continue;
    }

    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function hashFile(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function buildAssetFiles(sourceDir) {
  let sourceAbsolutePath;
  try {
    sourceAbsolutePath = await ensureSourceDirExists(sourceDir);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  const allFiles = await collectFilePaths(sourceAbsolutePath);
  const files = {};

  for (const absoluteFilePath of allFiles) {
    const canonicalFilePath = await fs.realpath(absoluteFilePath);
    const relativeToRepo = toPosixPath(path.relative(repoRoot, canonicalFilePath));
    if (isIgnoredByGit(relativeToRepo)) continue;

    const relativeToSource = toPosixPath(path.relative(sourceAbsolutePath, canonicalFilePath));
    const hash = await hashFile(canonicalFilePath);
    files[relativeToSource] = {
      hash,
      version: packageJson.version,
    };
  }

  const sortedEntries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(sortedEntries);
}

const registry = {
  version: '1',
  assets: {},
};

for (const [assetName, asset] of Object.entries(assets)) {
  const files = await buildAssetFiles(asset.source_dir);
  registry.assets[assetName] = {
    ...asset,
    files,
  };
}

const registryPath = path.join(repoRoot, '.xtrm', 'registry.json');
await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
console.log(`Wrote ${path.relative(repoRoot, registryPath)}`);
