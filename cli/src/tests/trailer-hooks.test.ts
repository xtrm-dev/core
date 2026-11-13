import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  resolveHooksDir,
  isTrailerHookInstalled,
  installTrailerHook,
  removeTrailerHook,
} from '../core/trailer-hooks.js';

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailer-hook-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  return dir;
}

describe('trailer-hooks', () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
  });

  it('creates the hook file and chains a call when none exists', async () => {
    const repo = makeRepo();
    repos.push(repo);
    const r = await installTrailerHook(repo);
    expect(r.changed).toBe(true);
    expect(isTrailerHookInstalled(repo)).toBe(true);
    const content = fs.readFileSync(path.join(repo, '.git', 'hooks', 'prepare-commit-msg'), 'utf8');
    expect(content).toContain('# xtrm-trailer-hook (CORE-2570)');
  });

  it('keeps an existing prepare-commit-msg and appends one call', async () => {
    const repo = makeRepo();
    repos.push(repo);
    const hookPath = path.join(repo, '.git', 'hooks', 'prepare-commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const original = '#!/bin/sh\necho original\n';
    fs.writeFileSync(hookPath, original, 'utf8');
    fs.chmodSync(hookPath, 0o755);
    await installTrailerHook(repo);
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content.startsWith(original.trimEnd())).toBe(true);
    expect(content).toContain('echo original');
    expect(content).toContain('# xtrm-trailer-hook (CORE-2570)');
  });

  it('is idempotent: second install is a no-op', async () => {
    const repo = makeRepo();
    repos.push(repo);
    await installTrailerHook(repo);
    const r2 = await installTrailerHook(repo);
    expect(r2.changed).toBe(false);
    const content = fs.readFileSync(path.join(repo, '.git', 'hooks', 'prepare-commit-msg'), 'utf8');
    const count = content.split('# xtrm-trailer-hook (CORE-2570)').length - 1;
    expect(count).toBe(1);
  });

  it('--remove restores the original bytes', async () => {
    const repo = makeRepo();
    repos.push(repo);
    const hookPath = path.join(repo, '.git', 'hooks', 'prepare-commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const original = '#!/bin/sh\necho original-bytes\n';
    fs.writeFileSync(hookPath, original, 'utf8');
    await installTrailerHook(repo);
    await removeTrailerHook(repo);
    const restored = fs.readFileSync(hookPath, 'utf8');
    expect(restored).toBe(original);
    expect(isTrailerHookInstalled(repo)).toBe(false);
  });

  it('respects core.hooksPath', async () => {
    const repo = makeRepo();
    repos.push(repo);
    const custom = path.join(repo, 'myhooks');
    fs.mkdirSync(custom, { recursive: true });
    execFileSync('git', ['config', 'core.hooksPath', 'myhooks'], { cwd: repo });
    const hookPath = path.join(custom, 'prepare-commit-msg');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho hp\n', 'utf8');
    await installTrailerHook(repo);
    expect(resolveHooksDir(repo)).toBe(custom);
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content).toContain('# xtrm-trailer-hook (CORE-2570)');
    // default .git/hooks untouched
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'prepare-commit-msg'))).toBe(false);
  });

  it('doctor warns when hook missing (isTrailerHookInstalled false)', () => {
    const repo = makeRepo();
    repos.push(repo);
    expect(isTrailerHookInstalled(repo)).toBe(false);
  });
});
