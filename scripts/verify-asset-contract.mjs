#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const ownershipPath = path.join(repoRoot, 'docs', 'skills-ownership.json');
const DEFAULT_CONTRACT_PATH = path.join(repoRoot, 'specialists-src', 'dist', 'asset-contract.json');
const DEFAULT_VENDOR_ROOT = path.join(repoRoot, '.xtrm', 'skills', 'default');
const MUST_HAVE_SKILLS = new Set(['using-specialists-v3', 'update-specialists']);

function parseArgs(argv) {
  const result = {
    contractPath: DEFAULT_CONTRACT_PATH,
    vendorRoot: DEFAULT_VENDOR_ROOT,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--contract' || arg === '--asset-contract') {
      result.contractPath = argv[++index];
      continue;
    }
    if (arg === '--vendor-root') {
      result.vendorRoot = argv[++index];
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!result.contractPath || !result.vendorRoot) {
    throw new Error('Missing required paths');
  }

  return result;
}

function printHelpAndExit() {
  console.log('Usage: node scripts/verify-asset-contract.mjs [--contract PATH] [--vendor-root PATH]');
  process.exit(0);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getOwnedSkills(ownership) {
  const owners = ownership?.owners;
  if (!owners || typeof owners !== 'object') throw new Error('skills ownership manifest missing owners');
  return Object.entries(owners)
    .filter(([, entry]) => entry?.owner === 'specialists')
    .map(([name]) => name)
    .sort();
}

function getContractSkills(contract) {
  const shipped = contract?.shipped_skills;
  if (!Array.isArray(shipped)) throw new Error('asset-contract missing shipped_skills array');
  return shipped;
}

function formatStatus(ok) {
  return ok ? 'PASS' : 'FAIL';
}

async function main() {
  const { contractPath, vendorRoot } = parseArgs(process.argv);
  const [contract, ownership] = await Promise.all([readJson(contractPath), readJson(ownershipPath)]);
  const ownedSkills = new Set(getOwnedSkills(ownership));
  const shippedSkills = getContractSkills(contract);
  const rows = [];
  const failures = [];

  for (const entry of shippedSkills) {
    const assetPath = entry?.path;
    const skillName = assetPath ? path.basename(path.dirname(assetPath)) : null;
    const expectedHash = entry?.sha256;

    if (!skillName || !assetPath || !expectedHash) {
      const reason = `contract entry missing path/hash: ${JSON.stringify(entry)}`;
      rows.push([skillName ?? '(unknown)', assetPath ?? '(unknown)', 'missing contract data', 'FAIL']);
      failures.push(reason);
      continue;
    }

    if (!ownedSkills.has(skillName)) {
      rows.push([skillName, assetPath, 'not specialists-owned, skipped', 'PASS']);
      continue;
    }

    const basename = path.basename(assetPath);
    const mirrorPath = path.join(vendorRoot, skillName, basename);
    if (!(await fileExists(mirrorPath))) {
      const reason = `missing mirror file for ${skillName}: ${path.relative(repoRoot, mirrorPath)}`;
      rows.push([skillName, path.relative(repoRoot, mirrorPath), 'missing file', 'FAIL']);
      failures.push(reason);
      continue;
    }

    const actualHash = sha256(await fs.readFile(mirrorPath));
    const ok = actualHash === expectedHash;
    rows.push([skillName, path.relative(repoRoot, mirrorPath), `${actualHash.slice(0, 12)}…`, formatStatus(ok)]);
    if (!ok) {
      failures.push(`sha256 drift for ${skillName}: expected ${expectedHash}, got ${actualHash} (${path.relative(repoRoot, mirrorPath)})`);
    }
  }

  for (const skillName of MUST_HAVE_SKILLS) {
    if (!shippedSkills.some((entry) => entry?.path && path.basename(path.dirname(entry.path)) === skillName)) {
      failures.push(`missing must-have skill payload: ${skillName}`);
      rows.push([skillName, '(contract)', 'missing payload', 'FAIL']);
    }
  }

  console.log('Asset contract verification summary');
  console.log('skill | mirror file | result | status');
  console.log('--- | --- | --- | ---');
  for (const [skill, file, result, status] of rows) {
    console.log(`${skill} | ${file} | ${result} | ${status}`);
  }

  if (failures.length > 0) {
    console.error('Asset contract verification failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('Asset contract verification PASS');
}

main().catch((error) => {
  console.error(`Asset contract verification error: ${error.message}`);
  process.exit(1);
});
