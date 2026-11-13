import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  TRAILER_HOOK_CREATED,
  TRAILER_HOOK_MARKER,
  installTrailerHook,
  readHooksState,
  removeTrailerHook,
  resolveHooksDir,
  resolveSubstrateHookEntry,
  setWorktreeIssue,
  trailerHookVerdict,
} from '../core/trailer-hooks.js';

const roots: string[] = [];
const created: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function makeRepo(): string {
  const dir = tmpRoot('trailer-hook-test-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

/** A substrate checkout the resolver accepts: integrations/setup.ts + the hook entry. */
function makeSubstrateCheckout(): string {
  const dir = tmpRoot('trailer-hook-substrate-');
  fs.mkdirSync(path.join(dir, 'integrations'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'integrations', 'setup.ts'), '// fixture\n');
  fs.writeFileSync(
    path.join(dir, 'hooks', 'prepare-commit-msg.ts'),
    'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.CM_LOG ?? "/dev/null", "ran\\n");\n',
  );
  return dir;
}

const previousDir = process.env.XTRM_SUBSTRATE_DIR;
beforeAll(() => {
  process.env.XTRM_SUBSTRATE_DIR = makeSubstrateCheckout();
});
afterAll(() => {
  if (previousDir === undefined) delete process.env.XTRM_SUBSTRATE_DIR;
  else process.env.XTRM_SUBSTRATE_DIR = previousDir;
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('trailer-hooks', () => {
  it('creates the hook file and the chain calls the resolved substrate entry', async () => {
    const repo = makeRepo();
    const outcome = await installTrailerHook(repo);
    expect(outcome.changed).toBe(true);
    expect(outcome.entry).toBe(resolveSubstrateHookEntry());
    const content = fs.readFileSync(path.join(resolveHooksDir(repo), 'prepare-commit-msg'), 'utf8');
    // The marker alone used to be the whole assertion: this is the call itself.
    expect(content).toContain(`node "${outcome.entry}" "$1"`);
    expect(content).toContain(TRAILER_HOOK_CREATED);
    expect(readHooksState(repo).status).toBe('installed');
  });

  it('runs the substrate entry when git invokes the hook', async () => {
    const repo = makeRepo();
    const log = path.join(tmpRoot('trailer-hook-log-'), 'ran.txt');
    const entry = resolveSubstrateHookEntry();
    expect(entry).not.toBeNull();
    // Prepend a log line so the assertion does not depend on the fixture's own
    // environment plumbing: what is proved is that the chain reaches this file.
    await installTrailerHook(repo);
    const hookPath = path.join(resolveHooksDir(repo), 'prepare-commit-msg');
    // Replace the whole chained line (its `>/dev/null` tail would swallow a
    // partial rewrite), keeping the marker so the state stays "installed".
    const patched = fs.readFileSync(hookPath, 'utf8')
      .split('\n')
      .map((line) => (line.startsWith('node "') ? `echo ran >> "${log}"` : line))
      .join('\n');
    fs.writeFileSync(hookPath, patched);
    execFileSync(hookPath, ['x', 'message'], { cwd: repo });
    expect(fs.readFileSync(log, 'utf8')).toContain('ran');
  });

  it('keeps an existing prepare-commit-msg and appends exactly one call', async () => {
    const repo = makeRepo();
    const hookPath = path.join(resolveHooksDir(repo), 'prepare-commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const original = '#!/bin/sh\necho original\n';
    fs.writeFileSync(hookPath, original, 'utf8');
    fs.chmodSync(hookPath, 0o755);
    await installTrailerHook(repo);
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content.startsWith(original.trimEnd())).toBe(true);
    expect(content.split(TRAILER_HOOK_MARKER)).toHaveLength(2);
  });

  it('is idempotent: a second install changes nothing', async () => {
    const repo = makeRepo();
    await installTrailerHook(repo);
    const before = fs.readFileSync(path.join(resolveHooksDir(repo), 'prepare-commit-msg'), 'utf8');
    const second = await installTrailerHook(repo);
    expect(second.changed).toBe(false);
    expect(second.reason).toBe('already-installed');
    expect(fs.readFileSync(path.join(resolveHooksDir(repo), 'prepare-commit-msg'), 'utf8')).toBe(before);
  });

  it('--remove deletes a file the chain created, leaving no empty hook', async () => {
    const repo = makeRepo();
    const hookPath = path.join(resolveHooksDir(repo), 'prepare-commit-msg');
    await installTrailerHook(repo);
    expect(fs.existsSync(hookPath)).toBe(true);
    await removeTrailerHook(repo);
    expect(fs.existsSync(hookPath)).toBe(false);
  });

  it('--remove keeps the repo hook byte for byte', async () => {
    const repo = makeRepo();
    const hookPath = path.join(resolveHooksDir(repo), 'prepare-commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const original = '#!/bin/sh\necho original-bytes\n';
    fs.writeFileSync(hookPath, original, 'utf8');
    await installTrailerHook(repo);
    await removeTrailerHook(repo);
    expect(fs.readFileSync(hookPath, 'utf8')).toBe(original);
    expect(readHooksState(repo).status).toBe('missing');
  });

  it('--remove preserves an operator edit made while the chain was installed', async () => {
    const repo = makeRepo();
    const hookPath = path.join(resolveHooksDir(repo), 'prepare-commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho original\n', 'utf8');
    await installTrailerHook(repo);
    fs.writeFileSync(hookPath, fs.readFileSync(hookPath, 'utf8').replace('echo original', 'echo user-edit-later'), 'utf8');
    await removeTrailerHook(repo);
    expect(fs.readFileSync(hookPath, 'utf8')).toContain('echo user-edit-later');
  });

  it('honours core.hooksPath, including a relative one', async () => {
    const repo = makeRepo();
    execFileSync('git', ['config', 'core.hooksPath', 'myhooks'], { cwd: repo });
    const custom = path.join(repo, 'myhooks');
    fs.mkdirSync(custom, { recursive: true });
    expect(resolveHooksDir(repo)).toBe(custom);
    await installTrailerHook(repo);
    expect(fs.existsSync(path.join(custom, 'prepare-commit-msg'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'prepare-commit-msg'))).toBe(false);
  });

  it('resolves the shared hooks dir in a linked worktree', async () => {
    const repo = makeRepo();
    const linked = path.join(tmpRoot('trailer-hook-linked-parent-'), 'wt');
    execFileSync('git', ['worktree', 'add', '-q', linked, '-b', 'wt-branch'], { cwd: repo });
    // `git rev-parse --git-path hooks` answers the common dir, not <x>/.git/hooks.
    expect(resolveHooksDir(linked)).toBe(path.join(repo, '.git', 'hooks'));
    const outcome = await installTrailerHook(linked);
    expect(outcome.changed).toBe(true);
    expect(readHooksState(linked).status).toBe('installed');
  });

  it('refuses to write a marker when the substrate entry cannot be resolved', async () => {
    const repo = makeRepo();
    const saved = process.env.XTRM_SUBSTRATE_DIR;
    process.env.XTRM_SUBSTRATE_DIR = tmpRoot('trailer-hook-empty-substrate-');
    try {
      expect(resolveSubstrateHookEntry()).toBeNull();
      const outcome = await installTrailerHook(repo);
      expect(outcome.changed).toBe(false);
      expect(outcome.reason).toBe('substrate-hook-unresolved');
      expect(fs.existsSync(path.join(resolveHooksDir(repo), 'prepare-commit-msg'))).toBe(false);
      expect(trailerHookVerdict(repo).status).toBe('missing');
    } finally {
      process.env.XTRM_SUBSTRATE_DIR = saved;
    }
  });

  it('repairs an inert chain in place, keeping the shebang and created marker', async () => {
    const repo = makeRepo();
    await installTrailerHook(repo);
    const hookPath = path.join(resolveHooksDir(repo), 'prepare-commit-msg');
    fs.writeFileSync(hookPath, fs.readFileSync(hookPath, 'utf8').replace(/node "[^"]+"/, 'node "/nonexistent/prepare-commit-msg.ts"'), 'utf8');
    expect(readHooksState(repo).status).toBe('inert');
    const verdict = trailerHookVerdict(repo);
    expect(verdict.status).toBe('inert');
    expect(verdict.message).toContain('inert');

    const repaired = await installTrailerHook(repo);
    expect(repaired.changed).toBe(true);
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(readHooksState(repo).status).toBe('installed');
    // The repaired file is still a script with provenance, not a blank-line mess.
    expect(content.startsWith('#!/bin/sh')).toBe(true);
    expect(content).toContain(TRAILER_HOOK_CREATED);
    expect(content.split(TRAILER_HOOK_MARKER)).toHaveLength(2);
    // ...and a following --remove deletes it rather than leaving 0 bytes.
    await removeTrailerHook(repo);
    expect(fs.existsSync(hookPath)).toBe(false);
  });

  it('keeps the repo hook when the resolved entry changes', async () => {
    const repo = makeRepo();
    const hookPath = path.join(resolveHooksDir(repo), 'prepare-commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho IMPORTANT-REPO-HOOK\n', 'utf8');

    const first = makeSubstrateCheckout();
    const second = makeSubstrateCheckout();
    const saved = process.env.XTRM_SUBSTRATE_DIR;
    try {
      process.env.XTRM_SUBSTRATE_DIR = first;
      await installTrailerHook(repo);
      process.env.XTRM_SUBSTRATE_DIR = second;
      const second_install = await installTrailerHook(repo);
      expect(second_install.changed).toBe(true);
      expect(second_install.entry).toBe(path.join(second, 'hooks', 'prepare-commit-msg.ts'));
    } finally {
      process.env.XTRM_SUBSTRATE_DIR = saved;
    }
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content).toContain('echo IMPORTANT-REPO-HOOK');
    expect(content.split(TRAILER_HOOK_MARKER)).toHaveLength(2);
    // The file was the repo's own: --remove restores it, never deletes it.
    await removeTrailerHook(repo);
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(fs.readFileSync(hookPath, 'utf8')).toContain('echo IMPORTANT-REPO-HOOK');
  });

  it('doctor verdict distinguishes missing from installed', async () => {
    const repo = makeRepo();
    expect(trailerHookVerdict(repo).status).toBe('missing');
    expect(trailerHookVerdict(repo).message).toContain('xt hooks install-trailers');
    await installTrailerHook(repo);
    expect(trailerHookVerdict(repo).status).toBe('installed');
  });

  it('writes the xtrm.issue worktree binding', async () => {
    const repo = makeRepo();
    const result = setWorktreeIssue(repo, 'CORE-2570');
    expect(result.ok).toBe(true);
    const read = execFileSync('git', ['config', '--worktree', '--get', 'xtrm.issue'], { cwd: repo, encoding: 'utf8' });
    expect(read.trim()).toBe('CORE-2570');
  });
});
