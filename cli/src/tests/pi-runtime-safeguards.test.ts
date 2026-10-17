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

    expect(parseNpmPackageName('npm:pi-ast-grep@latest')).toBe('pi-ast-grep');
    expect(parseNpmPackageName('npm:@scope/pkg@next')).toBe('@scope/pkg');
    expect(parseNpmPackageName('npm:@scope/pkg')).toBe('@scope/pkg');
    expect(parseNpmPackageName('git:github.com/DietrichGebert/ponytail')).toBeNull();

    expect(normalizePiPackageIdentity('npm:pi-ast-grep@latest')).toBe('npm:pi-ast-grep');
    expect(normalizePiPackageIdentity('npm:@scope/pkg@next')).toBe('npm:@scope/pkg');
    expect(normalizePiPackageIdentity('git:github.com/DietrichGebert/ponytail#main')).toBe('git:github.com/DietrichGebert/ponytail');
  });

  it('resolves npm-backed packages from global npm root and strips install selectors', async () => {
    const { getInstalledPiPackageVersion, isPackagePresentInPiAgent } = await import('../core/pi-runtime.js');
    const npmRootDir = path.join(tempRoot, 'global-npm-root', 'node_modules');
    const packageDir = path.join(npmRootDir, 'pi-ast-grep');
    await fs.outputJson(path.join(packageDir, 'package.json'), { version: '2.3.4' });

    await expect(getInstalledPiPackageVersion(process.env.PI_AGENT_DIR as string, 'pi-ast-grep', npmRootDir)).resolves.toBe('2.3.4');
    await expect(isPackagePresentInPiAgent(process.env.PI_AGENT_DIR as string, 'npm:pi-ast-grep@latest', npmRootDir)).resolves.toBe(true);
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
      { id: 'git:github.com/example/other-ext', displayName: 'other-ext', required: true },
    ], [
      'git:github.com/DietrichGebert/ponytail',
      'git:github.com/example/other-ext',
    ]);

    expect(statuses.map(status => [status.pkg.id, status.state])).toEqual([
      ['git:github.com/DietrichGebert/ponytail', 'current'],
      ['git:github.com/example/other-ext', 'current'],
    ]);
    expect(provider).not.toHaveBeenCalled();
  });

  it('marks absent git packages missing without pretending they have npm versions', async () => {
    const { getManagedPiPackageFreshness } = await import('../core/pi-runtime.js');
    const provider = vi.fn();

    const [status] = await getManagedPiPackageFreshness(provider, [
      { id: 'git:github.com/example/other-ext', displayName: 'other-ext', required: true },
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
      'npm:pi-mermaid-viewer',
      'npm:@jaggerxtrm/pi-service-knowledge',
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

  // CORE-2399: the adapter is retired, so what used to be a stale-override repair is now a
  // removal path that also clears the package entry from the settings files xt manages.
  it('removes the retired pi-mcp-adapter override, the npm leftover and its settings entries', async () => {
    const { removeRetiredPiMcpAdapter } = await import('../core/pi-runtime.js');
    const agentDir = path.join(tempRoot, 'agent-with-adapter');
    const projectRoot = path.join(tempRoot, 'project-with-adapter');
    const overrideDir = path.join(agentDir, 'extensions', 'pi-mcp-adapter');
    const npmLeftoverDir = path.join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter');
    await fs.ensureDir(overrideDir);
    await fs.writeJson(path.join(overrideDir, 'package.json'), { name: 'pi-mcp-adapter' });
    // What `pi remove` left behind; it kept the package readable as installed.
    await fs.ensureDir(npmLeftoverDir);
    await fs.writeJson(path.join(npmLeftoverDir, 'package.json'), { name: 'pi-mcp-adapter', version: '4.0.0' });
    await fs.outputJson(path.join(agentDir, 'settings.json'), {
      theme: 'light',
      packages: ['npm:pi-gitnexus', 'npm:pi-mcp-adapter'],
    });
    await fs.outputJson(path.join(projectRoot, '.pi', 'settings.json'), {
      packages: ['npm:pi-mcp-adapter', 'npm:pi-ast-grep'],
    });

    const result = await removeRetiredPiMcpAdapter(false, undefined, agentDir, projectRoot);

    expect(result).toEqual(expect.objectContaining({ found: true, removed: true }));
    expect(result.paths).toEqual([overrideDir, npmLeftoverDir]);
    expect(result.removedPaths).toEqual([overrideDir, npmLeftoverDir]);
    expect(result.settingsFiles).toEqual([
      path.join(agentDir, 'settings.json'),
      path.join(projectRoot, '.pi', 'settings.json'),
    ]);
    expect(await fs.pathExists(overrideDir)).toBe(false);
    expect(await fs.pathExists(npmLeftoverDir)).toBe(false);
    expect(await fs.readJson(path.join(agentDir, 'settings.json'))).toEqual({
      theme: 'light',
      packages: ['npm:pi-gitnexus'],
    });
    expect((await fs.readJson(path.join(projectRoot, '.pi', 'settings.json'))).packages).toEqual(['npm:pi-ast-grep']);
  });

  it('removes an npm leftover with no extension override and no settings entry', async () => {
    const { removeRetiredPiMcpAdapter } = await import('../core/pi-runtime.js');
    const agentDir = path.join(tempRoot, 'leftover-only-agent');
    const npmLeftoverDir = path.join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter');
    await fs.ensureDir(npmLeftoverDir);
    await fs.writeJson(path.join(npmLeftoverDir, 'package.json'), { name: 'pi-mcp-adapter', version: '4.0.0' });

    const result = await removeRetiredPiMcpAdapter(false, undefined, agentDir);

    expect(result).toEqual(expect.objectContaining({ found: true, removed: true, settingsFiles: [] }));
    expect(result.removedPaths).toEqual([npmLeftoverDir]);
    expect(await fs.pathExists(npmLeftoverDir)).toBe(false);
  });

  // CORE-2399 review: settings `packages` also holds object entries (a source plus
  // extensions/skills/prompts/themes). Dropping those on the way to removing the adapter is
  // data loss on a live file, so the removal path must touch adapter entries and nothing else.
  it('keeps object-form package entries intact while removing the retired adapter', async () => {
    const { removeRetiredPiMcpAdapter } = await import('../core/pi-runtime.js');
    const agentDir = path.join(tempRoot, 'agent-object-entries');
    const settingsPath = path.join(agentDir, 'settings.json');
    const objectEntry = {
      source: '/home/op/dev/xtmux',
      extensions: ['extensions/pi-agent-state.ts'],
      skills: [],
      prompts: [],
      themes: [],
    };
    await fs.outputJson(settingsPath, {
      theme: 'xtrm-dark-flattools',
      packages: ['npm:pi-gitnexus', 'npm:pi-mcp-adapter', objectEntry, 'npm:pi-ast-grep'],
    }, { spaces: 2 });

    const result = await removeRetiredPiMcpAdapter(false, undefined, agentDir);

    expect(result.settingsFiles).toEqual([settingsPath]);
    const after = await fs.readJson(settingsPath);
    expect(after.packages).toEqual(['npm:pi-gitnexus', objectEntry, 'npm:pi-ast-grep']);
    expect(after).toEqual({
      theme: 'xtrm-dark-flattools',
      packages: ['npm:pi-gitnexus', objectEntry, 'npm:pi-ast-grep'],
    });
  });

  it('removes the versioned string and object forms of the retired adapter', async () => {
    const { removeRetiredPiMcpAdapter } = await import('../core/pi-runtime.js');
    const agentDir = path.join(tempRoot, 'agent-versioned-forms');
    const settingsPath = path.join(agentDir, 'settings.json');
    await fs.outputJson(settingsPath, {
      packages: [
        'npm:pi-mcp-adapter@4.0.0',
        { source: 'npm:pi-mcp-adapter@4.0.0', extensions: ['cli.js'] },
        'npm:pi-gitnexus@latest',
      ],
    }, { spaces: 2 });

    const result = await removeRetiredPiMcpAdapter(false, undefined, agentDir);

    expect(result.removed).toBe(true);
    expect((await fs.readJson(settingsPath)).packages).toEqual(['npm:pi-gitnexus@latest']);
  });

  it('leaves a settings file byte-identical when the adapter is not listed', async () => {
    const { removeRetiredPiMcpAdapter } = await import('../core/pi-runtime.js');
    const agentDir = path.join(tempRoot, 'agent-no-match');
    const settingsPath = path.join(agentDir, 'settings.json');
    // 4-space indent, no trailing newline: a file the path does not change must not be reformatted.
    const text = JSON.stringify({
      theme: 'light',
      packages: ['npm:pi-gitnexus', { source: '/repo/packages/pi-extensions', extensions: [] }],
    }, null, 4);
    await fs.ensureDir(agentDir);
    await fs.writeFile(settingsPath, text, 'utf8');

    const result = await removeRetiredPiMcpAdapter(false, undefined, agentDir);

    expect(result).toEqual(expect.objectContaining({ found: false, removed: false, settingsFiles: [] }));
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(text);
  });

  it('preserves the settings file indentation when it does remove the adapter', async () => {
    const { removeRetiredPiMcpAdapter } = await import('../core/pi-runtime.js');
    const agentDir = path.join(tempRoot, 'agent-indent');
    const settingsPath = path.join(agentDir, 'settings.json');
    await fs.ensureDir(agentDir);
    await fs.writeFile(settingsPath, `${JSON.stringify({
      packages: ['npm:pi-mcp-adapter', 'npm:pi-gitnexus'],
    }, null, 4)}\n`, 'utf8');

    await removeRetiredPiMcpAdapter(false, undefined, agentDir);

    expect(await fs.readFile(settingsPath, 'utf8'))
      .toBe(`${JSON.stringify({ packages: ['npm:pi-gitnexus'] }, null, 4)}\n`);
  });

  it('is a silent no-op when the adapter is already gone', async () => {
    const { removeRetiredPiMcpAdapter } = await import('../core/pi-runtime.js');
    const agentDir = path.join(tempRoot, 'clean-agent');
    const projectRoot = path.join(tempRoot, 'clean-project');
    await fs.outputJson(path.join(agentDir, 'settings.json'), { packages: ['npm:pi-gitnexus'] });
    await fs.outputJson(path.join(projectRoot, '.pi', 'settings.json'), { packages: ['npm:pi-ast-grep'] });
    const beforeAgent = await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8');
    const beforeProject = await fs.readFile(path.join(projectRoot, '.pi', 'settings.json'), 'utf8');
    const logs: string[] = [];

    const result = await removeRetiredPiMcpAdapter(false, (message) => logs.push(message), agentDir, projectRoot);

    expect(result).toEqual(expect.objectContaining({ found: false, removed: false, settingsFiles: [], removedPaths: [] }));
    expect(logs).toEqual([]);
    expect(await fs.pathExists(path.join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter'))).toBe(false);
    expect(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8')).toBe(beforeAgent);
    expect(await fs.readFile(path.join(projectRoot, '.pi', 'settings.json'), 'utf8')).toBe(beforeProject);
  });

  it('reports the removal in a dry run and writes nothing', async () => {
    const { removeRetiredPiMcpAdapter } = await import('../core/pi-runtime.js');
    const agentDir = path.join(tempRoot, 'dry-agent');
    const overrideDir = path.join(agentDir, 'extensions', 'pi-mcp-adapter');
    const npmLeftoverDir = path.join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter');
    await fs.ensureDir(overrideDir);
    await fs.ensureDir(npmLeftoverDir);
    await fs.outputJson(path.join(agentDir, 'settings.json'), { packages: ['npm:pi-mcp-adapter'] });
    const logs: string[] = [];

    const result = await removeRetiredPiMcpAdapter(true, (message) => logs.push(message), agentDir);

    expect(result).toEqual(expect.objectContaining({
      found: true,
      removed: false,
      removedPaths: [],
      settingsFiles: [path.join(agentDir, 'settings.json')],
    }));
    expect(await fs.pathExists(overrideDir)).toBe(true);
    expect(await fs.pathExists(npmLeftoverDir)).toBe(true);
    expect((await fs.readJson(path.join(agentDir, 'settings.json'))).packages).toEqual(['npm:pi-mcp-adapter']);
    expect(logs.join('\n')).toContain('would remove');
    expect(logs.join('\n')).toContain(npmLeftoverDir);
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

  // CORE-2415: the other Pi settings writers rebuilt `packages` from strings only, which deleted
  // object-form entries. Each writer must change only what it intends to and leave the rest alone.
  describe('settings writers keep object-form package entries (CORE-2415)', () => {
    const objectEntry = {
      source: '/home/op/dev/xtmux',
      extensions: ['extensions/pi-agent-state.ts'],
      skills: [],
      prompts: [],
      themes: [],
    };
    const asText = (value: unknown, indent = 4): string => JSON.stringify(value, null, indent);

    async function writeText(file: string, text: string): Promise<void> {
      await fs.ensureDir(path.dirname(file));
      await fs.writeFile(file, text, 'utf8');
    }

    it('pruneConflictingPiPackageEntries matches string and object forms with or without a version', async () => {
      const { pruneConflictingPiPackageEntries } = await import('../core/pi-runtime.js');
      const versionedObject = { source: 'npm:pi-dex@2.1.0', extensions: ['x.ts'] };
      const result = pruneConflictingPiPackageEntries([
        'npm:pi-dex@1.0.0', objectEntry, versionedObject, 'npm:pi-dex', 'npm:pi-ast-grep',
      ]);
      expect(result.kept).toEqual([objectEntry, 'npm:pi-ast-grep']);
      expect(result.removed).toEqual(['npm:pi-dex@1.0.0', versionedObject, 'npm:pi-dex']);
    });

    it('cleanupConflictingPiPackageSettings removes only conflicting entries, in place', async () => {
      const { cleanupConflictingPiPackageSettings } = await import('../core/pi-runtime.js');
      const agentDir = path.join(tempRoot, 'prune-agent');
      const projectRoot = path.join(tempRoot, 'prune-project');
      const before = { theme: 'light', packages: ['npm:pi-ast-grep', 'npm:pi-dex@1.0.0', objectEntry, { source: 'npm:pi-dex', extensions: [] }, 'npm:pi-lens'] };
      const after = { theme: 'light', packages: ['npm:pi-ast-grep', objectEntry, 'npm:pi-lens'] };
      await writeText(path.join(agentDir, 'settings.json'), `${asText(before)}\n`);
      await writeText(path.join(projectRoot, '.pi', 'settings.json'), asText(before));

      const removed = await cleanupConflictingPiPackageSettings(projectRoot, false, false, undefined, agentDir);

      expect(removed).toEqual(['npm:pi-dex@1.0.0', 'npm:pi-dex', 'npm:pi-dex@1.0.0', 'npm:pi-dex']);
      expect(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8')).toBe(`${asText(after)}\n`);
      expect(await fs.readFile(path.join(projectRoot, '.pi', 'settings.json'), 'utf8')).toBe(asText(after));
    });

    it('cleanupConflictingPiPackageSettings leaves a file with no conflict byte-identical', async () => {
      const { cleanupConflictingPiPackageSettings } = await import('../core/pi-runtime.js');
      const agentDir = path.join(tempRoot, 'prune-noop-agent');
      const projectRoot = path.join(tempRoot, 'prune-noop-project');
      const text = asText({ theme: 'xtrm-dark', packages: ['npm:pi-ast-grep', objectEntry] });
      await writeText(path.join(agentDir, 'settings.json'), text);
      await writeText(path.join(projectRoot, '.pi', 'settings.json'), text);

      const removed = await cleanupConflictingPiPackageSettings(projectRoot, false, true, undefined, agentDir);

      expect(removed).toEqual([]);
      expect(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8')).toBe(text);
      expect(await fs.readFile(path.join(projectRoot, '.pi', 'settings.json'), 'utf8')).toBe(text);
    });

    it('updatePiSettings keeps object entries in packages, skills and extensions and drops only legacy strings', async () => {
      const { updatePiSettings } = await import('../core/pi-runtime.js');
      const projectRoot = path.join(tempRoot, 'update-object-entries');
      const settingsPath = path.join(projectRoot, '.pi', 'settings.json');
      const globalPath = path.join(process.env.PI_AGENT_DIR as string, 'settings.json');
      const skillObject = { source: './my-skills', skills: ['a'] };
      await writeText(globalPath, `${asText({ packages: ['../../dev/core/packages/pi-extensions'] })}\n`);
      await writeText(settingsPath, `${asText({
        extensions: [skillObject, 'npm:@xtrm/pi-extensions'],
        packages: ['npm:@xtrm/pi-extensions', objectEntry, 'npm:pi-dex', { source: 'npm:pi-dex@1.0.0' }, 'npm:pi-ast-grep'],
        skills: ['./my-custom-skills', skillObject],
      })}\n`);

      expect(await updatePiSettings(projectRoot, false)).toBe(true);

      const text = await fs.readFile(settingsPath, 'utf8');
      const after = JSON.parse(text);
      expect(after.packages).toEqual([objectEntry, 'npm:pi-ast-grep']);
      expect(after.skills).toEqual(['./my-custom-skills', skillObject]);
      expect(after.extensions).toContainEqual(skillObject);
      expect(text.startsWith('{\n    "')).toBe(true);
    });

    it('updatePiSettings is a byte-identical no-op on an already-normalized file', async () => {
      const { updatePiSettings } = await import('../core/pi-runtime.js');
      const projectRoot = path.join(tempRoot, 'update-noop');
      const settingsPath = path.join(projectRoot, '.pi', 'settings.json');
      const globalPath = path.join(process.env.PI_AGENT_DIR as string, 'settings.json');
      await writeText(globalPath, `${asText({ packages: ['../../dev/core/packages/pi-extensions'] })}\n`);
      const text = asText({ extensions: [], packages: ['npm:pi-ast-grep', objectEntry], theme: 'xtrm-dark' });
      await writeText(settingsPath, text);

      expect(await updatePiSettings(projectRoot, false)).toBe(false);
      expect(await fs.readFile(settingsPath, 'utf8')).toBe(text);
    });

    it('updatePiSettings appends the extension package to global settings without touching object entries', async () => {
      const { updatePiSettings } = await import('../core/pi-runtime.js');
      const projectRoot = path.join(tempRoot, 'update-global-append');
      await fs.ensureDir(projectRoot);
      const globalPath = path.join(process.env.PI_AGENT_DIR as string, 'settings.json');
      await writeText(globalPath, asText({ theme: 'light', packages: [objectEntry, 'npm:pi-ast-grep'] }));

      await updatePiSettings(projectRoot, false);

      expect(JSON.parse(await fs.readFile(globalPath, 'utf8')).packages)
        .toEqual([objectEntry, 'npm:pi-ast-grep', 'npm:@jaggerxtrm/pi-extensions']);
    });

    it('updatePiSettings treats an object-form pi-extensions source as already declared globally', async () => {
      const { updatePiSettings } = await import('../core/pi-runtime.js');
      const projectRoot = path.join(tempRoot, 'update-global-object-declared');
      await fs.ensureDir(projectRoot);
      const globalPath = path.join(process.env.PI_AGENT_DIR as string, 'settings.json');
      const text = asText({ packages: [{ source: '/dev/core/packages/pi-extensions', extensions: ['a.ts'] }] });
      await writeText(globalPath, text);

      await updatePiSettings(projectRoot, false);

      expect(await fs.readFile(globalPath, 'utf8')).toBe(text);
    });
  });
});
