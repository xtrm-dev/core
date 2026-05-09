#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const manifestPath = path.join(repoRoot, 'docs', 'skills-ownership.json');
const releasePath = path.join(repoRoot, 'docs', 'skills-ownership.release.json');
const docsPath = path.join(repoRoot, 'docs', 'skills-ownership.md');

const canonicalEntries = [
  'releasing',
  'update-specialists',
  'using-kpi',
  'using-nodes',
  'specialists-creator',
  'using-specialists',
  'using-specialists-v2',
  'using-specialists-v3',
  'using-script-specialists',
];

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateManifest(manifest) {
  assert(manifest?.version === 1, 'manifest version must be 1');
  for (const name of canonicalEntries) {
    assert(manifest.owners?.[name], `missing manifest owner entry: ${name}`);
  }
  assert(!manifest.owners?.['using-specialists-v4'], 'unexpected future skill entry');
}

function validateDocs(docsText, manifest) {
  for (const name of canonicalEntries) {
    assert(docsText.includes(`\`${name}\``), `docs missing skill name: ${name}`);
  }
  assert(docsText.includes('Machine-readable source:'), 'docs missing manifest note');
  assert(docsText.includes('using-specialists-v3'), 'docs missing using-specialists-v3');
  assert(docsText.includes('update-specialists'), 'docs missing update-specialists');
  assert(docsText.includes('docs/skills-ownership.json'), 'docs missing manifest path');
  assert(manifest.owners.releasing.owner === 'xtrm-tools', 'releasing owner mismatch');
}

function validateRelease(release, manifest) {
  const mirror = release?.mirrors?.specialists;
  assert(mirror, 'missing specialists release metadata');
  assert(mirror.package === 'specialists', 'specialists release package mismatch');
  assert(Array.isArray(mirror.assets), 'specialists release assets missing');
  assert(mirror.assets.includes('using-specialists-v3'), 'release missing using-specialists-v3');
  assert(mirror.assets.includes('update-specialists'), 'release missing update-specialists');
  for (const asset of mirror.assets) {
    assert(manifest.owners[asset]?.owner === 'specialists', `release asset not specialists-owned: ${asset}`);
  }
}

async function main() {
  const [manifest, release, docsText] = await Promise.all([
    readJson(manifestPath),
    readJson(releasePath),
    fs.readFile(docsPath, 'utf8'),
  ]);

  validateManifest(manifest);
  validateDocs(docsText, manifest);
  validateRelease(release, manifest);

  console.log('Skills ownership manifest OK');
}

main().catch((error) => {
  console.error(`Skills ownership check failed: ${error.message}`);
  process.exit(1);
});
