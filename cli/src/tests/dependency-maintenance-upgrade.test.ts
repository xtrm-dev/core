import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync }));
vi.mock('../core/substrate.js', () => ({
  getSbVersion: () => ({ available: false }),
  getSbDoctorJson: () => ({ ok: true }),
}));

import { runDependencyMaintenance } from '../core/dependency-maintenance.js';

// CORE-2450: upgradeTool must never run `npm install -g` into the repo.
let repo: string;
let outside: string;
let installs: string[][];

function mockNpm(prefixStdout: string, prefixStatus = 0): void {
  installs = [];
  spawnSync.mockImplementation((cmd: string, args: string[]) => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (cmd === 'npm' && args[0] === 'prefix') return { status: prefixStatus, stdout: prefixStdout, stderr: '' };
    if (cmd === 'npm' && args[0] === 'install') { installs.push(args); return { status: 1, stdout: '', stderr: 'stubbed' }; }
    if (cmd === 'npm' && args[0] === 'view') return ok('9.0.0'); // sb/gitnexus below
    if (cmd === 'sb' || cmd === 'gitnexus') return { status: 1, stdout: '', stderr: '' }; // missing
    return ok('');
  });
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-repo-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-out-')));
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  spawnSync.mockReset();
});

describe('upgradeTool prefix safety', () => {
  it('skips a prefix inside the repo with a visible message', async () => {
    const inside = path.join(repo, 'cli');
    fs.mkdirSync(inside);
    mockNpm(`${inside}\n`);
    const { tools } = await runDependencyMaintenance(repo, true);
    expect(installs).toHaveLength(0);
    expect(tools[0].state).toBe('skipped');
    expect(tools[0].message).toContain('inside the repo');
  });

  it('skips when npm prefix -g is unresolved', async () => {
    mockNpm('', 1);
    const { tools } = await runDependencyMaintenance(repo, true);
    expect(installs).toHaveLength(0);
    expect(tools[0].state).toBe('skipped');
    expect(tools[0].message).toContain('unresolved');
  });

  it('runs install with an explicit --prefix for an external prefix', async () => {
    mockNpm(`${outside}\n`);
    await runDependencyMaintenance(repo, true);
    expect(installs[0]).toEqual(['install', '-g', '--prefix', outside, '@jaggerxtrm/substrate']);
  });

  it('skips a symlinked prefix that resolves into the repo', async () => {
    const inside = path.join(repo, 'cli');
    fs.mkdirSync(inside);
    const link = path.join(outside, 'prefix-link');
    fs.symlinkSync(inside, link);
    mockNpm(`${link}\n`);
    const { tools } = await runDependencyMaintenance(repo, true);
    expect(installs).toHaveLength(0);
    expect(tools[0].state).toBe('skipped');
  });
});
