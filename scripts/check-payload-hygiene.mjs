#!/usr/bin/env node

import fs from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
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

const TAR_READ_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const allowlist = new Set([]);

// Files that intentionally mention absolute-path strings as documentation
// (changelog entries describing past fixes, hygiene-script self-tests, etc.).
// Forbidden-path scanning still applies to these.
const ABSOLUTE_PATH_LEAK_ALLOWLIST = new Set([
  'CHANGELOG.md',
  'scripts/check-payload-hygiene.mjs',
]);

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
    if (ABSOLUTE_PATH_LEAK_ALLOWLIST.has(filePath)) continue;
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

// Tracked symlinks (git mode 120000) must really resolve (realpath, so links through symlinked
// directories are followed) to an existing path inside the repo; machine-specific links
// (e.g. into ../lib/node_modules) are invisible to git grep.
export function findBadTrackedSymlinks(root = repoRoot) {
  // The tar read limit is reused deliberately as a generous bound for the file listing.
  const listing = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: TAR_READ_MAX_BUFFER_BYTES });
  const links = listing.split('\0').filter((entry) => entry.startsWith('120000 ')).map((entry) => entry.split('\t')[1]);
  const realRoot = realpathSync(root);
  return links.flatMap((filePath) => {
    const absolute = path.join(root, filePath);
    if (!lstatSync(absolute, { throwIfNoEntry: false })) return [{ filePath, reason: 'missing from working tree' }];
    let real;
    try {
      real = realpathSync(absolute);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [{ filePath, reason: 'dangling target' }];
    }
    const relative = path.relative(realRoot, real);
    return relative.startsWith('..') || path.isAbsolute(relative) ? [{ filePath, reason: 'target outside repo' }] : [];
  });
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

export function readTarballFile(tarballPath, filePath) {
  // Large packed files need more than execFileSync default 1MB buffer.
  return execFileSync('tar', ['-xOf', tarballPath, `package/${filePath}`], {
    encoding: 'utf8',
    maxBuffer: TAR_READ_MAX_BUFFER_BYTES,
  });
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

  const badSymlinks = findBadTrackedSymlinks();

  const ok = forbiddenFiles.length === 0 && textLeaks.length === 0 && badSymlinks.length === 0;
  if (jsonOutput) {
    console.log(JSON.stringify({ ok, forbiddenFiles, textLeaks, badSymlinks }, null, 2));
  } else if (ok) {
    console.log(`Payload hygiene ok: ${packFiles.length} packed files`);
  }

  if (!ok) {
    if (!jsonOutput) {
      console.error(formatList('Forbidden packed paths', forbiddenFiles, (item) => `${item.filePath} (${item.reason})`));
      console.error(formatList('Bad tracked symlinks', badSymlinks, (item) => `${item.filePath} (${item.reason})`));
      console.error(formatList('Absolute path leaks', textLeaks, (item) => `${item.filePath}: ${item.match}`));
    }
    if (!reportOnly) process.exit(1);
  }
}

if (process.argv[1] === __filename) {
  await main();
}
