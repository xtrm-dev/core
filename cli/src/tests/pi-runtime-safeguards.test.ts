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
  if (previousPiAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = previousPiAgentDir;
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

  it('does not treat legacy extensions/core as the managed core library', async () => {
    const { resolveManagedPiCoreSourceDir } = await import('../core/pi-runtime.js');
    const legacyRoot = path.join(tempRoot, 'legacy-layout');
    await fs.ensureDir(path.join(legacyRoot, '.xtrm', 'extensions', 'core'));
    expect(resolveManagedPiCoreSourceDir(legacyRoot)).toBeNull();
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

  it('normalizes npm selectors without losing scoped package names', async () => {
    const { normalizePiPackageIdentity, parseNpmPackageName } = await import('../core/pi-runtime.js');

    expect(parseNpmPackageName('npm:pi-background-tasks@latest')).toBe('pi-background-tasks');
    expect(parseNpmPackageName('npm:@scope/pkg@next')).toBe('@scope/pkg');
    expect(parseNpmPackageName('npm:@scope/pkg')).toBe('@scope/pkg');
    expect(parseNpmPackageName('git:github.com/alonw0/pi-claude-link')).toBeNull();

    expect(normalizePiPackageIdentity('npm:pi-background-tasks@latest')).toBe('npm:pi-background-tasks');
    expect(normalizePiPackageIdentity('npm:@scope/pkg@next')).toBe('npm:@scope/pkg');
    expect(normalizePiPackageIdentity('git:github.com/alonw0/pi-claude-link.git#main')).toBe('git:github.com/alonw0/pi-claude-link');
  });

  it('resolves npm-backed packages from global npm root and strips install selectors', async () => {
    const { getInstalledPiPackageVersion, isPackagePresentInPiAgent } = await import('../core/pi-runtime.js');
    const npmRootDir = path.join(tempRoot, 'global-npm-root', 'node_modules');
    const packageDir = path.join(npmRootDir, 'pi-background-tasks');
    await fs.outputJson(path.join(packageDir, 'package.json'), { version: '2.3.4' });

    await expect(getInstalledPiPackageVersion(process.env.PI_AGENT_DIR as string, 'pi-background-tasks', npmRootDir)).resolves.toBe('2.3.4');
    await expect(isPackagePresentInPiAgent(process.env.PI_AGENT_DIR as string, 'npm:pi-background-tasks@latest', npmRootDir)).resolves.toBe(true);
  });

  it('classifies npm freshness with an injectable provider', async () => {
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

    expect(statuses.map(status => [status.pkg.id, status.npmPackageName, status.state])).toEqual([
      ['npm:current-package', 'current-package', 'current'],
      ['npm:outdated-package', 'outdated-package', 'outdated'],
      ['npm:missing-package', 'missing-package', 'missing'],
      ['npm:unknown-package', 'unknown-package', 'version-unknown'],
    ]);
  });

  it('treats git packages as current by installed Pi source identity and does not call npm version lookup', async () => {
    const { getManagedPiPackageFreshness } = await import('../core/pi-runtime.js');
    const provider = vi.fn(async () => ({ installedVersion: '1.0.0', expectedVersion: '1.0.0' }));

    const statuses = await getManagedPiPackageFreshness(provider, [
      { id: 'git:github.com/DietrichGebert/ponytail', displayName: 'ponytail', required: false },
      { id: 'git:github.com/alonw0/pi-claude-link', displayName: 'pi-claude-link', required: true },
    ], [
      'git:github.com/DietrichGebert/ponytail',
      'git:github.com/alonw0/pi-claude-link',
    ]);

    expect(statuses.map(status => [status.pkg.id, status.state])).toEqual([
      ['git:github.com/DietrichGebert/ponytail', 'current'],
      ['git:github.com/alonw0/pi-claude-link', 'current'],
    ]);
    expect(provider).not.toHaveBeenCalled();
  });

  it('marks absent git packages missing without pretending they have npm versions', async () => {
    const { getManagedPiPackageFreshness } = await import('../core/pi-runtime.js');
    const provider = vi.fn();

    const [status] = await getManagedPiPackageFreshness(provider, [
      { id: 'git:github.com/alonw0/pi-claude-link', displayName: 'pi-claude-link', required: true },
    ], []);

    expect(status).toEqual(expect.objectContaining({
      npmPackageName: '',
      installedVersion: null,
      expectedVersion: null,
      state: 'missing',
    }));
    expect(provider).not.toHaveBeenCalled();
  });

  it('exposes the approved canonical XTRM-managed Pi package inventory', async () => {
    const { getXtManagedPiPackages } = await import('../core/pi-runtime.js');

    expect(getXtManagedPiPackages().map(pkg => pkg.id)).toEqual([
      'npm:@jaggerxtrm/pi-extensions',
      'npm:pi-gitnexus',
      'npm:@robhowley/pi-structured-return',
      'npm:@aliou/pi-guardrails',
      'npm:@narumitw/pi-goal',
      'git:github.com/DietrichGebert/ponytail',
      'npm:@tintinweb/pi-tasks',
      'npm:pi-background-tasks@latest',
      'npm:pi-mcp-adapter',
      'npm:pi-mermaid-viewer',
      'npm:@jaggerxtrm/pi-service-knowledge',
      'npm:pi-intercom',
      'git:github.com/alonw0/pi-claude-link',
      'npm:pi-ast-grep',
    ]);
  });

  it('installs every absent managed package using its canonical Pi install selector', async () => {
    const { ensureAlwaysGlobalPiPackages, getXtManagedPiPackages } = await import('../core/pi-runtime.js');
    const agentDir = path.join(tempRoot, 'global-agent');
    const installCalls: string[] = [];

    const result = await ensureAlwaysGlobalPiPackages(
      false,
      undefined,
      agentDir,
      (piPackageId) => {
        installCalls.push(piPackageId);
        return { status: 0, stdout: '', stderr: '' };
      },
      null,
      [],
    );

    const expected = getXtManagedPiPackages().map(pkg => pkg.id);
    expect(installCalls).toEqual(expected);
    expect(result.installed).toEqual(expected);
    expect(result.failed).toEqual([]);
  });

  it('prunes stale pi-dex entries because xtrm-ui replaces its presentation role', async () => {
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

  it('repairs an incorrect @xtrm/pi-core symlink target', async () => {
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

    expect(await ensureCorePackageSymlink(coreDir, projectRoot, false)).toBe('repaired');
    const resolvedTarget = path.resolve(symlinkDir, await fs.readlink(symlinkPath));
    expect(resolvedTarget).toBe(path.resolve(coreDir));
  });

  it('removes a stale pi-mcp-adapter override missing commands.js', async () => {
    const { remediateStalePiMcpAdapterOverride } = await import('../core/pi-runtime.js');
    const overrideDir = path.join(process.env.PI_AGENT_DIR as string, 'extensions', 'pi-mcp-adapter');
    await fs.ensureDir(overrideDir);
    await fs.writeJson(path.join(overrideDir, 'package.json'), { name: 'pi-mcp-adapter' });

    const result = await remediateStalePiMcpAdapterOverride(false);
    expect(result).toEqual(expect.objectContaining({ stale: true, remediated: true }));
    expect(await fs.pathExists(overrideDir)).toBe(false);
  });

  it('preserves user skill paths while removing retired managed skill pointers', async () => {
    const { updatePiSettings } = await import('../core/pi-runtime.js');
    const projectRoot = path.join(tempRoot, 'with-user-paths');
    await fs.outputJson(path.join(projectRoot, '.pi', 'settings.json'), {
      skills: ['../.xtrm/skills/active', './my-custom-skills', '/abs/team-skills', '~/.xtrm/skills/default'],
    });

    await updatePiSettings(projectRoot, false);
    const settings = await fs.readJson(path.join(projectRoot, '.pi', 'settings.json'));
    expect(settings.skills).toEqual(['./my-custom-skills', '/abs/team-skills']);
  });

  it('does not write settings in dry-run mode', async () => {
    const { updatePiSettings } = await import('../core/pi-runtime.js');
    const projectRoot = path.join(tempRoot, 'dry-run');
    await fs.ensureDir(projectRoot);
    await updatePiSettings(projectRoot, true);
    expect(await fs.pathExists(path.join(projectRoot, '.pi', 'settings.json'))).toBe(false);
  });

  it('classifies managed pi-extensions entries by path/id shape without fs I/O', async () => {
    const { isManagedPiExtensionsPackageEntry } = await import('../core/pi-runtime.js');
    expect(isManagedPiExtensionsPackageEntry('npm:@jaggerxtrm/pi-extensions')).toBe(true);
    expect(isManagedPiExtensionsPackageEntry('../../dev/core/packages/pi-extensions')).toBe(true);
    expect(isManagedPiExtensionsPackageEntry('packages/pi-extensions')).toBe(true);
    expect(isManagedPiExtensionsPackageEntry('/abs/home/dev/core/packages/pi-extensions/')).toBe(true);
    expect(isManagedPiExtensionsPackageEntry('C:\\dev\\core\\packages\\pi-extensions')).toBe(true);
    expect(isManagedPiExtensionsPackageEntry('git:github.com/x/pi-extensions')).toBe(false);
    expect(isManagedPiExtensionsPackageEntry('file:../packages/pi-extensions')).toBe(false);
    expect(isManagedPiExtensionsPackageEntry('a/packages/b/pi-extensions')).toBe(false);
  });

  it('does not register the npm package beside a local pi-extensions source path', async () => {
    const { updatePiSettings } = await import('../core/pi-runtime.js');
    const projectRoot = path.join(tempRoot, 'local-source');
    await fs.ensureDir(projectRoot);

    const globalSettingsPath = path.join(process.env.PI_AGENT_DIR as string, 'settings.json');
    await fs.outputJson(globalSettingsPath, {
      packages: ['npm:pi-gitnexus', '../../dev/core/packages/pi-extensions'],
    });

    await updatePiSettings(projectRoot, false);
    const globalSettings = await fs.readJson(globalSettingsPath);
    expect(globalSettings.packages).toEqual(['npm:pi-gitnexus', '../../dev/core/packages/pi-extensions']);
    expect(globalSettings.packages).not.toContain('npm:@jaggerxtrm/pi-extensions');
  });
});
