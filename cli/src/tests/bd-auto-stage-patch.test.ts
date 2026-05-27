import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { ensureBdAutoStagePatch } from '../core/bd-auto-stage-patch.js';

let tmpRoot: string;

function git(args: string[]): void {
  const result = spawnSync('git', args, { cwd: tmpRoot, stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-bd-stage-'));
  git(['init']);
  await fs.ensureDir(path.join(tmpRoot, '.beads'));
  await fs.writeFile(path.join(tmpRoot, '.beads', 'config.yaml'), 'dolt:\n  shared-server: true\n');
});

afterEach(async () => {
  await fs.remove(tmpRoot);
});

describe('ensureBdAutoStagePatch', () => {
  it('dry-run reports config and hook changes without writing', async () => {
    const result = await ensureBdAutoStagePatch(tmpRoot, false);

    expect(result.changed).toBe(true);
    expect(result.config).toBe('updated');
    expect(result.hook).toBe('updated');
    expect(await fs.pathExists(path.join(tmpRoot, '.git', 'hooks', 'pre-commit'))).toBe(false);

    const config = yaml.parse(await fs.readFile(path.join(tmpRoot, '.beads', 'config.yaml'), 'utf8'));
    expect(config['export.git-add']).toBeUndefined();
  });

  it('applies config flip and creates executable pre-commit shim idempotently', async () => {
    const first = await ensureBdAutoStagePatch(tmpRoot, true);
    const second = await ensureBdAutoStagePatch(tmpRoot, true);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.config).toBe('already-disabled');
    expect(second.hook).toBe('already-present');

    const config = yaml.parse(await fs.readFile(path.join(tmpRoot, '.beads', 'config.yaml'), 'utf8'));
    expect(config['export.git-add']).toBe(false);

    const hookPath = path.join(tmpRoot, '.git', 'hooks', 'pre-commit');
    const hook = await fs.readFile(hookPath, 'utf8');
    expect(hook).toContain('git add -f .beads/issues.jsonl 2>/dev/null || true');
    expect((await fs.stat(hookPath)).mode & 0o111).not.toBe(0);
  });

  it('honors relative core.hooksPath', async () => {
    git(['config', 'core.hooksPath', '.githooks']);
    await fs.ensureDir(path.join(tmpRoot, '.githooks'));
    await fs.writeFile(path.join(tmpRoot, '.githooks', 'pre-commit'), '#!/usr/bin/env sh\necho existing\n');

    const result = await ensureBdAutoStagePatch(tmpRoot, true);

    expect(result.hookPath).toBe(path.join(tmpRoot, '.githooks', 'pre-commit'));
    const hook = await fs.readFile(path.join(tmpRoot, '.githooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('echo existing');
    expect(hook).toContain('git add -f .beads/issues.jsonl 2>/dev/null || true');
  });

  it('honors bd-managed .beads/hooks when the pre-commit hook exists', async () => {
    git(['config', 'core.hooksPath', '.beads/hooks']);
    await fs.ensureDir(path.join(tmpRoot, '.beads', 'hooks'));
    await fs.writeFile(path.join(tmpRoot, '.beads', 'hooks', 'pre-commit'), '#!/usr/bin/env sh\n# --- BEGIN BEADS INTEGRATION v1.0.3 ---\n# --- END BEADS INTEGRATION v1.0.3 ---\n');

    const result = await ensureBdAutoStagePatch(tmpRoot, true);

    expect(result.hook).toBe('updated');
    expect(result.warnings).toEqual([]);
    const hook = await fs.readFile(path.join(tmpRoot, '.beads', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('git add -f .beads/issues.jsonl 2>/dev/null || true');
  });

  it('reports .beads/hooks core.hooksPath as misconfigured when no hook target exists', async () => {
    git(['config', 'core.hooksPath', '.beads/hooks']);

    const result = await ensureBdAutoStagePatch(tmpRoot, true);

    expect(result.changed).toBe(true);
    expect(result.config).toBe('updated');
    expect(result.hook).toBe('misconfigured-hooks-path');
    expect(result.warnings[0]).toContain('.beads/hooks');
    expect(await fs.pathExists(path.join(tmpRoot, '.beads', 'hooks', 'pre-commit'))).toBe(false);
  });
});
