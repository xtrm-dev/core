import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';

import { needsTmpGitGuard } from '../src/tests/tmp-git-guard.js';

const tempRoot = path.resolve(os.tmpdir());
const runnerCwd = path.resolve(process.cwd());
const tmpGitPath = path.join(tempRoot, '.git');


// xtrm-on2mk: TREE-HASH LEAK GUARD.
// The prior mtime-only detector could not catch a wipe that leaves
// state.json alone. When an operator ran vitest from a repo root whose glob
// reached older worktree copies of init-phases (pre-xtrm-8zsi1), those
// tests wiped ~/.xtrm/{hooks/*,skills/default/*} because they resolved
// os.homedir() live and state.json's mtime did not change in the same
// process. Hash the whole ~/.xtrm/{hooks,skills/default} tree at module
// load and again in afterEach; throw and name the offender if it drifted.
const realHome = process.env.HOME ?? os.homedir();
const guardedTrees = [
  path.join(realHome, '.xtrm', 'hooks'),
  path.join(realHome, '.xtrm', 'skills', 'default'),
];

// CORE-2412: the CLI suite must never touch the operator's real home.
// Snapshot the two load-bearing settings files before any test runs and
// fail the suite if a test rewrites them. The writer on 2026-10-17 was
// cli/test/pi-runtime.test.ts via updatePiSettings →
// ensureGlobalDeclaresExtensionPackage, which resolved PI_AGENT_DIR once at
// import time (cli/src/core/pi-runtime.ts:124) before the test set any env.
const guardedFiles = [
  path.join(realHome, '.pi', 'agent', 'settings.json'),
  path.join(realHome, '.claude', 'settings.json'),
];

function fileSnapshot(file: string): string {
  try {
    const stat = fsSync.statSync(file);
    const content = fsSync.readFileSync(file);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `${stat.mtimeMs}:${stat.size}:${hash}`;
  } catch {
    return 'missing';
  }
}

const initialFileSnapshots = new Map<string, string>();
for (const file of guardedFiles) {
  initialFileSnapshots.set(file, fileSnapshot(file));
}

async function treeHash(dir: string): Promise<string> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const parts: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      // eslint-disable-next-line no-await-in-loop
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        parts.push(`${entry.name}/${await treeHash(full)}`);
      } else {
        parts.push(`${entry.name}:${stat.size}:${stat.mtimeMs}`);
      }
    }
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
  } catch {
    return 'missing';
  }
}

const initialTreeHashes = new Map<string, string>();
for (const tree of guardedTrees) {
  // eslint-disable-next-line no-await-in-loop
  initialTreeHashes.set(tree, await treeHash(tree));
}

async function assertRealHomeUntouched(): Promise<void> {
  for (const tree of guardedTrees) {
    // eslint-disable-next-line no-await-in-loop
    const now = await treeHash(tree);
    const initial = initialTreeHashes.get(tree) ?? 'missing';
    if (now !== initial) {
      initialTreeHashes.set(tree, now);
      throw new Error(
        `test setup: real user's ${tree} tree was modified during a test `
        + `(hash ${initial.slice(0, 12)} -> ${now.slice(0, 12)}). This is the class of `
        + `leak that wiped ~/.xtrm/{hooks,skills/default} during xtrm-on2mk. `
        + `Sandbox HOME in this test's beforeEach: `
        + `previousHome = process.env.HOME; process.env.HOME = fs.mkdtempSync(...); `
        + `and restore in afterEach. If your code path uses os.homedir(), also `
        + `vi.spyOn(os, 'homedir').mockReturnValue(sandboxHome).`,
      );
    }
  }
  for (const file of guardedFiles) {
    const now = fileSnapshot(file);
    const initial = initialFileSnapshots.get(file) ?? 'missing';
    if (now !== initial) {
      initialFileSnapshots.set(file, now);
      throw new Error(
        `test setup: real user's ${file} was modified during a test `
        + `(snapshot ${initial.slice(0, 24)} -> ${now.slice(0, 24)}). `
        + `This is the CORE-2412 class of leak (2026-10-17 rewrite of `
        + `~/.pi/agent/settings.json via import-time PI_AGENT_DIR). `
        + `Sandbox HOME/PI_AGENT_DIR/CLAUDE_CONFIG_DIR in this test's beforeEach, `
        + `or rely on the suite sandbox in cli/test/setup.ts. `
        + `Never write the operator's real ~/.pi/agent/settings.json.`,
      );
    }
  }
}

// CORE-2412: isolate agent dir and HOME per test file. This setup file runs
// before every test file, so exporting a sandbox HOME/PI_AGENT_DIR/
// CLAUDE_CONFIG_DIR here keeps the whole suite off the operator's real
// ~/.pi, ~/.claude and ~/.xtrm even when a single test forgets its own
// sandbox. Per-test sandboxes (beforeEach mkdtemp) still win where present;
// this is the backstop, not a replacement.
const sandboxHome = fsSync.mkdtempSync(path.join(tempRoot, 'xtrm-cli-home-'));
fsSync.mkdirSync(path.join(sandboxHome, '.pi', 'agent'), { recursive: true });
fsSync.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });
fsSync.mkdirSync(path.join(sandboxHome, '.xtrm'), { recursive: true });
process.env.HOME = sandboxHome;
process.env.PI_AGENT_DIR = path.join(sandboxHome, '.pi', 'agent');
process.env.PI_CODING_AGENT_DIR = process.env.PI_AGENT_DIR;
process.env.CLAUDE_CONFIG_DIR = path.join(sandboxHome, '.claude');

// A stale /tmp/.git makes git treat /tmp as a project root. FAIL-CLOSED guard
// (exact-06ca security): the test setup must never MUTATE the host — it
// asserts /tmp/.git is absent (a stale one fails the suite loudly, telling the
// operator to remove it manually). Only a runner rooted at the exact host temp
// directory is exempt; projects below that directory remain guarded.
async function assertNoTmpGitPollution(): Promise<void> {
  if (needsTmpGitGuard(runnerCwd, tempRoot) && fsSync.existsSync(tmpGitPath)) {
    throw new Error(
      `test setup: stale host-global ${tmpGitPath} exists. This test suite never `
      + 'mutates the host: remove the stale directory manually, then rerun.',
    );
  }
}

await assertNoTmpGitPollution();

// xtrm-on2mk: operators using the global migration export
// XTRM_GLOBAL_HOOKS=1 and XTRM_GLOBAL_SKILLS=1 in their shell. Vitest
// inherits the parent env, which forces tests that assume the pre-global
// branches (registry-scaffold, prune-retired-managed-skills, update,
// claude-runtime-sync-global-guard, ...) down code paths they never seed.
// Tests that want the global branches set the env var explicitly inside
// their own beforeEach.
delete process.env.XTRM_GLOBAL_HOOKS;
delete process.env.XTRM_GLOBAL_SKILLS;

beforeEach(() => {
  delete process.env.XTRM_GLOBAL_HOOKS;
  delete process.env.XTRM_GLOBAL_SKILLS;
  // Backstop: a test that restores the real HOME (or unsets the sandbox)
  // goes straight back to the sandbox. Per-test temp HOME dirs are left
  // alone — only the real home is forbidden.
  if (!process.env.HOME || process.env.HOME === realHome) {
    process.env.HOME = sandboxHome;
  }
  const sandboxAgent = path.join(sandboxHome, '.pi', 'agent');
  if (!process.env.PI_AGENT_DIR || process.env.PI_AGENT_DIR === path.join(realHome, '.pi', 'agent')) {
    process.env.PI_AGENT_DIR = sandboxAgent;
  }
  if (!process.env.PI_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR === path.join(realHome, '.pi', 'agent')) {
    process.env.PI_CODING_AGENT_DIR = process.env.PI_AGENT_DIR;
  }
  if (!process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR === path.join(realHome, '.claude')) {
    process.env.CLAUDE_CONFIG_DIR = path.join(sandboxHome, '.claude');
  }
  return assertNoTmpGitPollution();
});
afterEach(async () => {
  await assertNoTmpGitPollution();
  await assertRealHomeUntouched();
});
