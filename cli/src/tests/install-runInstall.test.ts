import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  getContext: vi.fn(),
  runMachineBootstrapPhase: vi.fn(async () => undefined),
  installFromRegistry: vi.fn(async () => ({
    installed: 0,
    upToDate: 0,
    driftedSkipped: 0,
    forced: 0,
    expectedInstalls: 0,
    missingSourceSkipped: 0,
  })),
  resolvePackageRoot: vi.fn(),
  scaffoldSkillsDefaultFromPackage: vi.fn(),
  runPiInstall: vi.fn(async () => undefined),
  syncProjectMcpConfig: vi.fn(async () => ({ wroteFile: false, createdFile: false, mcpPath: '.mcp.json', addedServers: [], missingEnvWarnings: [] })),
  syncPiMcpConfig: vi.fn(async () => ({ wroteFile: false, createdFile: false, mcpPath: '.pi/mcp.json', addedServers: [], missingEnvWarnings: [] })),
  runClaudeRuntimeSyncPhase: vi.fn(async () => undefined),
  runPluginEraCleanup: vi.fn(async () => undefined),
  ensureAgentsSkillsSymlink: vi.fn(async () => undefined),
  assertRuntimeSkillsViews: vi.fn(async () => undefined),
}));

vi.mock('../core/context.js', () => ({ getContext: mocked.getContext }));
vi.mock('../core/machine-bootstrap.js', () => ({ runMachineBootstrapPhase: mocked.runMachineBootstrapPhase }));
vi.mock('../core/registry-scaffold.js', () => ({
  installFromRegistry: mocked.installFromRegistry,
  resolvePackageRoot: mocked.resolvePackageRoot,
  scaffoldSkillsDefaultFromPackage: mocked.scaffoldSkillsDefaultFromPackage,
}));
vi.mock('../core/project-mcp-sync.js', () => ({
  syncProjectMcpConfig: mocked.syncProjectMcpConfig,
  syncPiMcpConfig: mocked.syncPiMcpConfig,
}));
vi.mock('../core/claude-runtime-sync.js', () => ({ runClaudeRuntimeSyncPhase: mocked.runClaudeRuntimeSyncPhase }));
vi.mock('../core/plugin-era-cleanup.js', () => ({ runPluginEraCleanup: mocked.runPluginEraCleanup }));
vi.mock('../core/skills-scaffold.js', () => ({ ensureAgentsSkillsSymlink: mocked.ensureAgentsSkillsSymlink }));
vi.mock('../core/skills-runtime-views.js', () => ({ assertRuntimeSkillsViews: mocked.assertRuntimeSkillsViews }));
vi.mock('../commands/pi-install.js', () => ({ runPiInstall: mocked.runPiInstall }));

import { runInstall } from '../commands/install.js';

describe('runInstall broken default symlink repair', () => {
  let tmpDir = '';
  let previousCwd = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-run-install-test-'));
    process.chdir(tmpDir);
    mocked.getContext.mockResolvedValue({ targets: [path.join(tmpDir, '.xtrm')] });
    mocked.resolvePackageRoot.mockReturnValue(path.join(tmpDir, 'pkg'));
    mocked.scaffoldSkillsDefaultFromPackage.mockReset();
    mocked.installFromRegistry.mockReset();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.removeSync(tmpDir);
    vi.clearAllMocks();
  });

  it('repairs broken symlink before registry install and leaves valid symlink untouched', async () => {
    const packageRoot = path.join(tmpDir, 'pkg');
    const sourceDir = path.join(packageRoot, '.xtrm', 'skills', 'default');
    const targetDir = path.join(tmpDir, '.xtrm', 'skills', 'default');

    fs.ensureDirSync(path.join(packageRoot, '.xtrm'));
    fs.writeJsonSync(path.join(packageRoot, '.xtrm', 'registry.json'), { version: '1.0.0', assets: {} });
    fs.ensureDirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, 'README.md'), '# skill\n', 'utf8');
    fs.ensureDirSync(path.dirname(targetDir));
    fs.symlinkSync('/missing/dev/skills/default', targetDir);

    const callOrder: string[] = [];
    mocked.scaffoldSkillsDefaultFromPackage.mockImplementation(async ({ packageRoot, userXtrmDir, dryRun }) => {
      callOrder.push('scaffoldSkillsDefaultFromPackage');
      if (dryRun) return 'noop';
      const source = path.join(packageRoot, '.xtrm', 'skills', 'default');
      const target = path.join(userXtrmDir, 'skills', 'default');
      await fs.remove(target).catch(() => undefined);
      await fs.copy(source, target);
      return 'copy';
    });
    mocked.installFromRegistry.mockImplementation(async () => {
      callOrder.push('installFromRegistry');
      return {
        installed: 0,
        upToDate: 0,
        driftedSkipped: 0,
        forced: 0,
        expectedInstalls: 0,
        missingSourceSkipped: 0,
      };
    });

    await runInstall({
      yes: true,
      dryRun: false,
      projectRoot: tmpDir,
      skipMachineBootstrap: true,
      skipClaudeRuntimeSync: true,
    });

    expect(callOrder).toEqual(['scaffoldSkillsDefaultFromPackage', 'installFromRegistry']);
    expect((await fs.lstat(targetDir)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(targetDir, 'README.md'), 'utf8')).toBe('# skill\n');
  });

  it('preserves symlink at .xtrm/skills/default when scaffold reports noop', async () => {
    const packageRoot = path.join(tmpDir, 'pkg');
    const targetDir = path.join(tmpDir, '.xtrm', 'skills', 'default');
    const sourceDir = path.join(packageRoot, '.xtrm', 'skills', 'default');

    fs.ensureDirSync(path.join(packageRoot, '.xtrm'));
    fs.writeJsonSync(path.join(packageRoot, '.xtrm', 'registry.json'), { version: '1.0.0', assets: {} });
    fs.ensureDirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, 'README.md'), '# dev skill\n', 'utf8');
    fs.ensureDirSync(path.dirname(targetDir));
    fs.symlinkSync(sourceDir, targetDir);

    mocked.scaffoldSkillsDefaultFromPackage.mockImplementation(async () => 'noop');
    mocked.installFromRegistry.mockImplementation(async () => ({
      installed: 0,
      upToDate: 0,
      driftedSkipped: 0,
      forced: 0,
      expectedInstalls: 0,
      missingSourceSkipped: 0,
    }));

    await runInstall({
      yes: true,
      dryRun: false,
      projectRoot: tmpDir,
      skipMachineBootstrap: true,
      skipClaudeRuntimeSync: true,
    });

    expect((await fs.lstat(targetDir)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(targetDir)).toBe(sourceDir);
  });

  it('dryRun leaves broken symlink untouched at .xtrm/skills/default', async () => {
    const packageRoot = path.join(tmpDir, 'pkg');
    const sourceDir = path.join(packageRoot, '.xtrm', 'skills', 'default');
    const targetDir = path.join(tmpDir, '.xtrm', 'skills', 'default');

    fs.ensureDirSync(path.join(packageRoot, '.xtrm'));
    fs.writeJsonSync(path.join(packageRoot, '.xtrm', 'registry.json'), { version: '1.0.0', assets: {} });
    fs.ensureDirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, 'README.md'), '# skill\n', 'utf8');
    fs.ensureDirSync(path.dirname(targetDir));
    fs.symlinkSync('/missing/dev/skills/default', targetDir);

    mocked.scaffoldSkillsDefaultFromPackage.mockImplementation(async ({ dryRun }) => (dryRun ? 'noop' : 'copy'));
    mocked.installFromRegistry.mockImplementation(async () => ({
      installed: 0,
      upToDate: 0,
      driftedSkipped: 0,
      forced: 0,
      expectedInstalls: 0,
      missingSourceSkipped: 0,
    }));

    await runInstall({
      yes: true,
      dryRun: true,
      projectRoot: tmpDir,
      skipMachineBootstrap: true,
      skipClaudeRuntimeSync: true,
    });

    expect(mocked.scaffoldSkillsDefaultFromPackage).toHaveBeenCalledWith({
      packageRoot,
      userXtrmDir: path.join(tmpDir, '.xtrm'),
      dryRun: true,
    });
    expect((await fs.lstat(targetDir)).isSymbolicLink()).toBe(true);
    expect(await fs.pathExists(targetDir)).toBe(false);
    expect(await fs.pathExists(path.join(targetDir, 'README.md'))).toBe(false);
  });

});
