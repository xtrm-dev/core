#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const FORBIDDEN_PATH_PATTERNS = [
  { pattern: /^\.xtrm\/worktrees\//, reason: 'worktree payload' },
  { pattern: /(^|\/)\.pi(\/|$)/, reason: 'pi runtime artifact' },
  { pattern: /(^|\/)\.serena(\/|$)/, reason: 'serena metadata' },
  { pattern: /(^|\/)__pycache__(\/|$)/, reason: 'python cache' },
  { pattern: /(^|\/)workspace\//, reason: 'workspace output' },
  { pattern: /(^|\/)evals?(\/|$)/, reason: 'eval output' },
  { pattern: /(^|\/)\.specialists\/(jobs|db)\//, reason: 'specialists runtime data' },
  { pattern: /(^|\/)\.beads\/(dolt|backup)\//, reason: 'beads backup data' },
  { pattern: /(^|\/)\.beads\/issues\.jsonl$/, reason: 'beads issue journal' },
  { pattern: /(^|\/)logs?(\/|$)|\.(log|db|sqlite)(?:-|$)|\.sqlite$/, reason: 'log/database artifact' },
];

const TEXT_FILE_PATTERN = /\.(md|json|js|cjs|mjs|ts|cts|tsx|txt|yaml|yml|sh)$/;
const ABSOLUTE_PATH_PATTERNS = [
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
  /file:\/\/\/home\//,
  /file:\/\/\/Users\//,
];

const allowlist = new Set([]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function toPosix(value) {
  return value.split(path.sep).join('/');
}

export function findForbiddenPackFiles(packFiles) {
  return packFiles.flatMap((filePath) => {
    const match = FORBIDDEN_PATH_PATTERNS.find(({ pattern }) => pattern.test(filePath) && !allowlist.has(filePath));
    return match ? [{ filePath, reason: match.reason }] : [];
  });
}

export function findAbsolutePathLeaks(textByFile) {
  const leaks = [];
  for (const [filePath, content] of textByFile) {
    for (const pattern of ABSOLUTE_PATH_PATTERNS) {
      const match = content.match(pattern);
      if (match && !allowlist.has(filePath)) {
        leaks.push({ filePath, match: match[0] });
        break;
      }
    }
  }
  return leaks;
}

function formatList(title, items, formatItem) {
  if (items.length === 0) return `${title}: none`;
  return `${title}:\n${items.map((item) => `- ${formatItem(item)}`).join('\n')}`;
}

function runPackDryRun() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  const results = JSON.parse(output);
  if (!Array.isArray(results) || results.length !== 1) throw new Error(`Expected one pack result, got ${Array.isArray(results) ? results.length : 'non-array'}`);
  return results[0].files?.map((file) => toPosix(file.path)) ?? [];
}

function runPackTarball(tempDir) {
  const output = execFileSync('npm', ['pack', '--json', '--pack-destination', tempDir], { cwd: repoRoot, encoding: 'utf8' });
  const results = JSON.parse(output);
  const tarball = results?.[0]?.filename;
  if (!tarball) throw new Error('npm pack did not return tarball filename');
  return path.join(tempDir, tarball);
}

function listTarballFiles(tarballPath) {
  const output = execFileSync('tar', ['-tf', tarballPath], { encoding: 'utf8' });
  return output.trim().split('\n').filter(Boolean).map((entry) => entry.replace(/^package\//, ''));
}

function readTarballFile(tarballPath, filePath) {
  return execFileSync('tar', ['-xOf', tarballPath, `package/${filePath}`], { encoding: 'utf8' });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const jsonOutput = args.has('--json');
  const reportOnly = args.has('--report-only');

  const packFiles = runPackDryRun();
  const forbiddenFiles = findForbiddenPackFiles(packFiles);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-payload-'));
  const textLeaks = [];
  try {
    const tarballPath = runPackTarball(tempDir);
    const tarballFiles = listTarballFiles(tarballPath).filter((filePath) => TEXT_FILE_PATTERN.test(filePath));
    const textByFile = new Map(tarballFiles.map((filePath) => [filePath, readTarballFile(tarballPath, filePath)]));
    textLeaks.push(...findAbsolutePathLeaks(textByFile));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  const ok = forbiddenFiles.length === 0 && textLeaks.length === 0;
  if (jsonOutput) {
    console.log(JSON.stringify({ ok, forbiddenFiles, textLeaks }, null, 2));
  } else if (ok) {
    console.log(`Payload hygiene ok: ${packFiles.length} packed files`);
  }

  if (!ok) {
    if (!jsonOutput) {
      console.error(formatList('Forbidden packed paths', forbiddenFiles, (item) => `${item.filePath} (${item.reason})`));
      console.error(formatList('Absolute path leaks', textLeaks, (item) => `${item.filePath}: ${item.match}`));
    }
    if (!reportOnly) process.exit(1);
  }
}

if (process.argv[1] === __filename) {
  await main();
}
