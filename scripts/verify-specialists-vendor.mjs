#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const manifestPath = path.join(repoRoot, '.xtrm', 'specialists-source.json');
const destinationRoot = path.join(repoRoot, '.xtrm', 'skills', 'default');

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function hashFile(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function collectFileHashes(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = {};

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFileHashes(absolutePath);
      for (const [relativePath, hash] of Object.entries(nested)) {
        files[path.posix.join(entry.name, relativePath)] = hash;
      }
      continue;
    }

    if (entry.isFile()) {
      files[entry.name] = await hashFile(absolutePath);
    }
  }

  return files;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const manifest = await readJson(manifestPath);
  assert(manifest.version === 1, 'manifest version mismatch');
  assert(Array.isArray(manifest.skills) && manifest.skills.length > 0, 'manifest skills missing');
  assert(manifest.source && typeof manifest.source === 'object', 'manifest source missing');

  for (const skillName of manifest.skills) {
    const skillDir = path.join(destinationRoot, skillName);
    const expectedFiles = manifest.files?.[skillName] ?? {};
    const actualFiles = await collectFileHashes(skillDir);
    const expectedPaths = Object.keys(expectedFiles).sort();
    const actualPaths = Object.keys(actualFiles).sort();

    assert(JSON.stringify(expectedPaths) === JSON.stringify(actualPaths), `file set mismatch for ${skillName}`);
    for (const relativePath of expectedPaths) {
      assert(actualFiles[relativePath] === expectedFiles[relativePath], `hash mismatch for ${skillName}/${relativePath}`);
    }
  }

  console.log('Specialists vendor manifest OK');
}

main().catch((error) => {
  console.error(`Specialists vendor verify failed: ${error.message}`);
  process.exit(1);
});
