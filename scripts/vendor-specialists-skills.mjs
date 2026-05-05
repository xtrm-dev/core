#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const destinationRoot = path.join(repoRoot, '.xtrm', 'skills', 'default');
const fallbackSpecialistsRepoPaths = [
  path.resolve(repoRoot, '../specialists'),
  path.resolve(repoRoot, '../../../../specialists'),
];
const skillNames = [
  'update-specialists',
  'using-kpi',
  'using-nodes',
  'specialists-creator',
  'using-specialists',
  'using-specialists-v2',
  'using-specialists-v3',
  'using-script-specialists',
];

async function assertDirectoryExists(directoryPath, errorMessage) {
  try {
    const stats = await fs.stat(directoryPath);
    if (!stats.isDirectory()) throw new Error(errorMessage);
  } catch {
    throw new Error(errorMessage);
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

async function copySkillDirectory(specialistsSkillsRoot, skillName) {
  const sourceDir = path.join(specialistsSkillsRoot, skillName);
  const destinationDir = path.join(destinationRoot, skillName);

  await assertDirectoryExists(sourceDir, `Missing specialists skill dir: ${sourceDir}`);
  await fs.mkdir(destinationDir, { recursive: true });
  await fs.cp(sourceDir, destinationDir, { recursive: true, force: true, errorOnExist: false });
  console.log(`Vendored ${skillName} from ${sourceDir}`);
}

async function main() {
  const specialistsRepoPath = await resolveSpecialistsRepoPath();
  const specialistsSkillsRoot = path.join(specialistsRepoPath, 'config', 'skills');

  await assertDirectoryExists(specialistsSkillsRoot, `Missing specialists skills root: ${specialistsSkillsRoot}`);
  await assertDirectoryExists(destinationRoot, `Missing destination root: ${destinationRoot}`);

  for (const skillName of skillNames) {
    await copySkillDirectory(specialistsSkillsRoot, skillName);
  }
}

main().catch((error) => {
  console.error(`Vendor specialists skills failed: ${error.message}`);
  process.exit(1);
});
