import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempRoot = '';
let previousPiAgentDir: string | undefined;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-pi-runtime-'));
  previousPiAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = path.join(tempRoot, 'pi-agent');
  vi.resetModules();
});

afterEach(async () => {
  if (previousPiAgentDir === undefined) {
    delete process.env.PI_AGENT_DIR;
  } else {
    process.env.PI_AGENT_DIR = previousPiAgentDir;
  }
  await fs.remove(tempRoot);
  vi.restoreAllMocks();
});

describe('pi runtime safeguards', () => {
  it('resolves bundled pi runtime sources from the workspace package layout', async () => {
    const { resolveManagedPiCoreSourceDir, resolveManagedPiExtensionsSourceDir } = await import('../core/pi-runtime.js');
    const repoRoot = path.resolve(process.cwd(), '..');

    expect(resolveManagedPiExtensionsSourceDir()).toBe(path.join(repoRoot, 'packages/pi-extensions/extensions'));
    expect(resolveManagedPiCoreSourceDir()).toBe(path.join(repoRoot, 'packages/pi-extensions/src/core'));
  });

  it('detects npmmirror 404s and emits the scoped npmjs hint for pi extensions', async () => {
    const { getPiPackageInstallFailureHint, shouldRetryPiInstallViaNpmjs } = await import('../core/pi-runtime.js');
    const output = 'npm error 404 Not Found - GET https://cdn.npmmirror.com/packages/%40jaggerxtrm/pi-extensions/0.7.8/pi-extensions-0.7.8.tgz';

    expect(shouldRetryPiInstallViaNpmjs('npm:@jaggerxtrm/pi-extensions', output)).toBe(true);
    expect(getPiPackageInstallFailureHint('npm:@jaggerxtrm/pi-extensions', output)).toEqual([
      'detected registry mirror 404 for npm:@jaggerxtrm/pi-extensions',
      'best fix: npm config set @jaggerxtrm:registry https://registry.npmjs.org',
    ]);
    expect(getPiPackageInstallFailureHint('npm:pi-gitnexus', output)).toEqual([]);
  });

  it('classifies managed npm-backed pi package freshness with an injectable provider', async () => {
    const { getManagedPiPackageFreshness } = await import('../core/pi-runtime.js');

    const statuses = await getManagedPiPackageFreshness((piPackageId) => {
      const versions: Record<string, { installedVersion: string | null; expectedVersion: string | null }> = {
        'npm:current-package': { installedVersion: '1.2.3', expectedVersion: '1.2.3' },
        'npm:outdated-package': { installedVersion: '1.2.2', expectedVersion: '1.2.3' },
        'npm:missing-package': { installedVersion: null, expectedVersion: '1.2.3' },
        'npm:unknown-package': { installedVersion: '1.2.3', expectedVersion: null },
      };
      return versions[piPackageId] ?? { installedVersion: null, expectedVersion: null };
    }, [
      { id: 'npm:current-package', displayName: 'current', required: true },
      { id: 'npm:outdated-package', displayName: 'outdated', required: true },
      { id: 'npm:missing-package', displayName: 'missing', required: true },
      { id: 'npm:unknown-package', displayName: 'unknown', required: true },
    ]);

    expect(statuses.map(status => [
      status.pkg.id,
      status.npmPackageName,
      status.installedVersion,
      status.expectedVersion,
      status.state,
    ])).toEqual([
      ['npm:current-package', 'current-package', '1.2.3', '1.2.3', 'current'],
      ['npm:outdated-package', 'outdated-package', '1.2.2', '1.2.3', 'outdated'],
      ['npm:missing-package', 'missing-package', null, '1.2.3', 'missing'],
      ['npm:unknown-package', 'unknown-package', '1.2.3', null, 'version-unknown'],
    ]);
  });

  it('exposes the canonical xt-managed pi package inventory for freshness checks', async () => {
    const { getXtManagedPiPackages } = await import('../core/pi-runtime.js');

    expect(getXtManagedPiPackages().map(pkg => pkg.id)).toEqual([
      'npm:@jaggerxtrm/pi-extensions',
      'npm:pi-gitnexus',
      'npm:pi-serena-tools',
      'npm:@zenobius/pi-worktrees',
      'npm:@robhowley/pi-structured-return',
      'npm:@aliou/pi-guardrails',
      'npm:@aliou/pi-processes',
    ]);
  });

  it('prunes stale pi-dex entries because xtrm-ui already replaces it', async () => {
    const { pruneConflictingPiPackageEntries } = await import('../core/pi-runtime.js');

    expect(pruneConflictingPiPackageEntries([
      'npm:pi-dex',
      'npm:pi-gitnexus',
      'npm:@jaggerxtrm/pi-extensions',
    ])).toEqual({
      kept: ['npm:pi-gitnexus', 'npm:@jaggerxtrm/pi-extensions'],
      removed: ['npm:pi-dex'],
    });
  });

  it('repairs incorrect @xtrm/pi-core symlink target', async () => {
    const { ensureCorePackageSymlink } = await import('../core/pi-runtime.js');

    const projectRoot = path.join(tempRoot, 'project');
    const coreDir = path.join(projectRoot, '.xtrm', 'extensions', 'core');
    const symlinkDir = path.join(projectRoot, '.xtrm', 'extensions', 'node_modules', '@xtrm');
    const symlinkPath = path.join(symlinkDir, 'pi-core');
    const wrongTarget = path.join(projectRoot, 'wrong-core');

    await fs.ensureDir(coreDir);
    await fs.ensureDir(wrongTarget);
    await fs.ensureDir(symlinkDir);
    await fs.symlink(path.relative(symlinkDir, wrongTarget), symlinkPath);

    const status = await ensureCorePackageSymlink(coreDir, projectRoot, false);

    expect(status).toBe('repaired');
    expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);

    const resolvedTarget = path.resolve(symlinkDir, await fs.readlink(symlinkPath));
    expect(resolvedTarget).toBe(path.resolve(coreDir));
  });

  it('removes stale pi-mcp-adapter override missing commands.js', async () => {
    const { remediateStalePiMcpAdapterOverride } = await import('../core/pi-runtime.js');

    const overrideDir = path.join(process.env.PI_AGENT_DIR as string, 'extensions', 'pi-mcp-adapter');
    await fs.ensureDir(overrideDir);
    await fs.writeJson(path.join(overrideDir, 'package.json'), { name: 'pi-mcp-adapter' });

    const result = await remediateStalePiMcpAdapterOverride(false);

    expect(result.stale).toBe(true);
    expect(result.remediated).toBe(true);
    expect(await fs.pathExists(overrideDir)).toBe(false);
  });
});
