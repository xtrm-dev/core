#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const registryPath = path.join(repoRoot, '.xtrm', 'registry.json');
// `packages/pi-extensions` is intentionally NOT a managed root since xtrm-xvjg
// (2026-05-11): pi-extensions is a global-only install, not scaffolded into
// project `.xtrm/` directories. It still ships via the xtrm-tools npm pack so
// it is globally installable, but it must not be in the project registry —
// the parity check only enforces the registry↔pack invariant for assets that
// are scaffolded into consumer projects.
const managedRoots = [
  '.xtrm/config',
  '.xtrm/hooks',
  '.xtrm/skills/default',
  '.xtrm/skills/optional',
];
const allowlist = new Map([
  [
    '.xtrm/skills/default/documenting/tests/integration_test.sh',
    'Documenting test fixture intentionally excluded from npm pack.',
  ],
  [
    '.xtrm/skills/default/documenting/tests/test_changelog.py',
    'Documenting test fixture intentionally excluded from npm pack.',
  ],
  [
    '.xtrm/skills/default/documenting/tests/test_drift_detector.py',
    'Documenting test fixture intentionally excluded from npm pack.',
  ],
  [
    '.xtrm/skills/default/documenting/tests/test_orchestrator.py',
    'Documenting test fixture intentionally excluded from npm pack.',
  ],
  [
    '.xtrm/skills/default/documenting/tests/test_validate_metadata.py',
    'Documenting test fixture intentionally excluded from npm pack.',
  ],
  [
    '.xtrm/skills/default/using-service-skills/scripts/test_skill_activator.py',
    'Using-service-skills test fixture intentionally excluded from npm pack.',
  ],
  [
    'packages/pi-extensions/.serena/.gitignore',
    'Pi extensions Serena ignore file intentionally excluded from npm pack.',
  ],
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function getPackFiles() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const packResults = JSON.parse(output);

  if (!Array.isArray(packResults) || packResults.length !== 1) {
    throw new Error(`Expected single npm pack result for root package, got ${Array.isArray(packResults) ? packResults.length : 'non-array'}`);
  }

  const files = packResults[0]?.files ?? [];
  return files.map((file) => file.path);
}

async function getRegistryFiles() {
  const content = await fs.readFile(registryPath, 'utf8');
  const registry = JSON.parse(content);
  const files = [];

  for (const asset of Object.values(registry.assets ?? {})) {
    const sourceDir = asset.source_dir;
    for (const relativePath of Object.keys(asset.files ?? {})) {
      files.push(toPosix(path.join(sourceDir, relativePath)));
    }
  }

  return files;
}

function isManagedPackFile(filePath) {
  return managedRoots.some((root) => filePath === root || filePath.startsWith(`${root}/`));
}

function formatList(title, items) {
  return items.length === 0 ? `${title}: none` : `${title}:\n- ${items.join('\n- ')}`;
}

const [packFiles, registryFiles] = await Promise.all([getPackFiles(), getRegistryFiles()]);
const packSet = new Set(packFiles);
const registrySet = new Set(registryFiles);

const missingFromPack = registryFiles.filter((filePath) => !packSet.has(filePath) && !allowlist.has(filePath));
const missingFromRegistry = packFiles
  .filter(isManagedPackFile)
  .filter((filePath) => !registrySet.has(filePath) && !allowlist.has(filePath));

const allowedMissingFromPack = registryFiles.filter((filePath) => !packSet.has(filePath) && allowlist.has(filePath));
const allowedMissingFromRegistry = packFiles.filter(isManagedPackFile).filter((filePath) => !registrySet.has(filePath) && allowlist.has(filePath));

if (missingFromPack.length > 0 || missingFromRegistry.length > 0) {
  console.error(formatList('Missing from npm pack', missingFromPack));
  console.error(formatList('Missing from registry', missingFromRegistry));

  if (allowedMissingFromPack.length > 0) {
    console.error('Allowlisted registry-only paths:');
    for (const filePath of allowedMissingFromPack) {
      console.error(`- ${filePath}: ${allowlist.get(filePath)}`);
    }
  }

  if (allowedMissingFromRegistry.length > 0) {
    console.error('Allowlisted pack-only managed paths:');
    for (const filePath of allowedMissingFromRegistry) {
      console.error(`- ${filePath}: ${allowlist.get(filePath)}`);
    }
  }

  process.exit(1);
}

console.log(`Registry↔pack parity ok: ${registryFiles.length} registry files, ${packFiles.filter(isManagedPackFile).length} managed packed files.`);
if (allowedMissingFromPack.length > 0) {
  console.log(`Allowlisted registry-only paths: ${allowedMissingFromPack.length}`);
}
if (allowedMissingFromRegistry.length > 0) {
  console.log(`Allowlisted pack-only managed paths: ${allowedMissingFromRegistry.length}`);
}
