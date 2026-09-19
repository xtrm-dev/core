import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureGlobalHooksBootstrapped, computeSourceFingerprint } from '../core/global-hooks-bootstrap.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    await fs.remove(tempDir);
  }
});

async function scaffoldPkg(pkgRoot: string, hooksJson: object): Promise<void> {
  await fs.ensureDir(pkgRoot);
  await fs.writeJson(path.join(pkgRoot, 'package.json'), { version: '1.2.3' });
  await fs.outputFile(path.join(pkgRoot, '.xtrm', 'hooks', 'statusline.mjs'), '#!/usr/bin/env node\n');
  await fs.outputFile(path.join(pkgRoot, '.xtrm', 'hooks', 'gitnexus', 'gitnexus-hook.cjs'), 'module.exports = {};\n');
  await fs.outputFile(path.join(pkgRoot, '.xtrm', 'config', 'hooks.json'), JSON.stringify(hooksJson, null, 2));
}

describe('global-hooks-bootstrap', () => {
  it('copies global hooks payload and stays idempotent', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-global-hooks-'));
    tempDirs.push(tempDir);
    const fakeHome = path.join(tempDir, 'home');
    const pkgRoot = path.join(tempDir, 'pkg');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    await scaffoldPkg(pkgRoot, { hooks: { PostToolUse: [] } });

    const first = await ensureGlobalHooksBootstrapped(pkgRoot);
    const second = await ensureGlobalHooksBootstrapped(pkgRoot);

    expect(first.installedVersion).toBe('1.2.3');
    expect(first.changed).toBe(true);
    expect(first.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(second.installedVersion).toBe('1.2.3');
    expect(second.changed).toBe(false);
    expect(second.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(await fs.pathExists(path.join(fakeHome, '.xtrm', 'hooks', 'statusline.mjs'))).toBe(true);
    expect(await fs.pathExists(path.join(fakeHome, '.xtrm', 'hooks', 'gitnexus', 'gitnexus-hook.cjs'))).toBe(true);
    expect(await fs.pathExists(path.join(fakeHome, '.xtrm', 'config', 'hooks.json'))).toBe(true);
  });

  // xtrm-bbxzu: the version string alone doesn't guarantee identical payload —
  // bootstrap can be re-sourced from a stale worktree at the same version and
  // silently downgrade global config. Fingerprint-based drift detection catches
  // this even when the version stamp is unchanged.
  it('refreshes when source content drifts even at the same version', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-global-hooks-drift-'));
    tempDirs.push(tempDir);
    const fakeHome = path.join(tempDir, 'home');
    const pkgRoot = path.join(tempDir, 'pkg');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    // First bootstrap at v1.2.3 with payload A.
    await scaffoldPkg(pkgRoot, { hooks: { PostToolUse: [{ matcher: 'A' }] } });
    const initial = await ensureGlobalHooksBootstrapped(pkgRoot);
    expect(initial.changed).toBe(true);

    // Same package version, DIFFERENT canonical hooks payload (simulates a
    // stale worktree source vs. the previously-installed npm source).
    await fs.outputFile(path.join(pkgRoot, '.xtrm', 'config', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'B' }] } }, null, 2));

    const second = await ensureGlobalHooksBootstrapped(pkgRoot);
    expect(second.changed).toBe(true);
    expect(second.sourceFingerprint).not.toBe(initial.sourceFingerprint);

    const globalConfig = await fs.readJson(path.join(fakeHome, '.xtrm', 'config', 'hooks.json')) as { hooks: { PostToolUse: Array<{ matcher: string }> } };
    expect(globalConfig.hooks.PostToolUse[0]?.matcher).toBe('B');
  });

  it('refreshes when hook file content drifts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-global-hooks-file-drift-'));
    tempDirs.push(tempDir);
    const fakeHome = path.join(tempDir, 'home');
    const pkgRoot = path.join(tempDir, 'pkg');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    await scaffoldPkg(pkgRoot, { hooks: {} });
    const initial = await ensureGlobalHooksBootstrapped(pkgRoot);

    // Modify a hook file (not the config) — fingerprint must still detect it.
    await fs.outputFile(path.join(pkgRoot, '.xtrm', 'hooks', 'statusline.mjs'), '#!/usr/bin/env node\n// changed\n');

    const second = await ensureGlobalHooksBootstrapped(pkgRoot);
    expect(second.changed).toBe(true);
    expect(second.sourceFingerprint).not.toBe(initial.sourceFingerprint);

    const globalHook = await fs.readFile(path.join(fakeHome, '.xtrm', 'hooks', 'statusline.mjs'), 'utf8');
    expect(globalHook).toContain('// changed');
  });

  it('force flag refreshes even when fingerprint matches', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-global-hooks-force-'));
    tempDirs.push(tempDir);
    const fakeHome = path.join(tempDir, 'home');
    const pkgRoot = path.join(tempDir, 'pkg');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    await scaffoldPkg(pkgRoot, { hooks: {} });
    await ensureGlobalHooksBootstrapped(pkgRoot);

    const forced = await ensureGlobalHooksBootstrapped(pkgRoot, { force: true });
    expect(forced.changed).toBe(true);
  });

  it('recovers when state.json exists but target payload has been wiped', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-global-hooks-recover-'));
    tempDirs.push(tempDir);
    const fakeHome = path.join(tempDir, 'home');
    const pkgRoot = path.join(tempDir, 'pkg');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    await scaffoldPkg(pkgRoot, { hooks: {} });
    await ensureGlobalHooksBootstrapped(pkgRoot);

    // Simulate operator wiping ~/.xtrm/config/hooks.json while state.json remains.
    await fs.remove(path.join(fakeHome, '.xtrm', 'config', 'hooks.json'));

    const recovered = await ensureGlobalHooksBootstrapped(pkgRoot);
    expect(recovered.changed).toBe(true);
    expect(await fs.pathExists(path.join(fakeHome, '.xtrm', 'config', 'hooks.json'))).toBe(true);
  });
});

describe('computeSourceFingerprint', () => {
  it('is deterministic across runs on identical content', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-fingerprint-'));
    tempDirs.push(tempDir);
    const hooksRoot = path.join(tempDir, 'hooks');
    const configPath = path.join(tempDir, 'hooks.json');
    await fs.outputFile(path.join(hooksRoot, 'a.mjs'), 'a\n');
    await fs.outputFile(path.join(hooksRoot, 'nested', 'b.mjs'), 'b\n');
    await fs.outputFile(configPath, '{"hooks":{}}');

    const a = await computeSourceFingerprint(hooksRoot, configPath);
    const b = await computeSourceFingerprint(hooksRoot, configPath);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any hook file changes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-fingerprint-'));
    tempDirs.push(tempDir);
    const hooksRoot = path.join(tempDir, 'hooks');
    const configPath = path.join(tempDir, 'hooks.json');
    await fs.outputFile(path.join(hooksRoot, 'a.mjs'), 'v1\n');
    await fs.outputFile(configPath, '{"hooks":{}}');

    const a = await computeSourceFingerprint(hooksRoot, configPath);
    await fs.outputFile(path.join(hooksRoot, 'a.mjs'), 'v2\n');
    const b = await computeSourceFingerprint(hooksRoot, configPath);
    expect(a).not.toBe(b);
  });
});
