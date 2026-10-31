import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Regression smoke for xtrm-1o63w.1: xt update --apply removes retired managed defaults
// (e.g. using-specialists-v3) and matching active symlinks, while preserving user content.
//
// Uses the REAL pruneRetiredManagedSkills + scaffoldSkillsDefaultFromPackage + installFromRegistry
// (registry-scaffold.js is NOT mocked here), and stubs every surrounding side-effect so runInstall
// exercises only the skills path.

const mocked = vi.hoisted(() => ({
  getContext: vi.fn(),
  runMachineBootstrapPhase: vi.fn(async () => undefined),
  runPiInstall: vi.fn(async () => undefined),
  syncProjectMcpConfig: vi.fn(async () => ({ wroteFile: false, createdFile: false, mcpPath: '.mcp.json', addedServers: [], missingEnvWarnings: [] })),
  syncPiMcpConfig: vi.fn(async () => ({ wroteFile: false, createdFile: false, mcpPath: '.pi/mcp.json', addedServers: [], missingEnvWarnings: [] })),
  runClaudeRuntimeSyncPhase: vi.fn(async () => undefined),
  runPluginEraCleanup: vi.fn(async () => undefined),
  ensureUserAgentsSkillsSymlink: vi.fn(async () => undefined),
  ensureAgentsSkillsSymlink: vi.fn(async () => undefined),
  ensureGlobalSkillsBootstrapped: vi.fn(async () => ({ installedVersion: '1.0.0', changed: false })),
  ensureGlobalHooksBootstrapped: vi.fn(async () => ({ installedVersion: '1.0.0', changed: false })),
  reconcileGlobalClaudeHooks: vi.fn(async () => ({ settingsPath: '', changed: false, hooksEntries: 0 })),
  reconcileGlobalPiHooks: vi.fn(async () => ({ settingsPath: '', changed: false, hooksEntries: 0 })),
  logBootstrapTrigger: vi.fn(async () => undefined),
  assertRuntimeSkillsViews: vi.fn(async () => undefined),
}));

vi.mock('../core/context.js', () => ({ getContext: mocked.getContext }));
vi.mock('../core/machine-bootstrap.js', () => ({ runMachineBootstrapPhase: mocked.runMachineBootstrapPhase }));
vi.mock('../core/project-mcp-sync.js', () => ({
  syncProjectMcpConfig: mocked.syncProjectMcpConfig,
  syncPiMcpConfig: mocked.syncPiMcpConfig,
}));
vi.mock('../core/plugin-era-cleanup.js', () => ({ runPluginEraCleanup: mocked.runPluginEraCleanup }));
vi.mock('../core/skills-scaffold.js', () => ({
  ensureUserAgentsSkillsSymlink: mocked.ensureUserAgentsSkillsSymlink,
  ensureAgentsSkillsSymlink: mocked.ensureAgentsSkillsSymlink,
}));
vi.mock('../core/global-skills-bootstrap.js', async (importOriginal) => ({
  // Keep the real backup helper: prune must snapshot the (sandboxed) tree before removal.
  createVerifiedSkillsBackup: (await importOriginal<typeof import('../core/global-skills-bootstrap.js')>()).createVerifiedSkillsBackup,
  ensureGlobalSkillsBootstrapped: mocked.ensureGlobalSkillsBootstrapped,
  logBootstrapTrigger: mocked.logBootstrapTrigger,
}));
vi.mock('../core/global-hooks-bootstrap.js', () => ({ ensureGlobalHooksBootstrapped: mocked.ensureGlobalHooksBootstrapped }));
vi.mock('../core/claude-runtime-sync.js', () => ({
  runClaudeRuntimeSyncPhase: mocked.runClaudeRuntimeSyncPhase,
  reconcileGlobalClaudeHooks: mocked.reconcileGlobalClaudeHooks,
}));
vi.mock('../core/pi-runtime-hooks.js', () => ({ reconcileGlobalPiHooks: mocked.reconcileGlobalPiHooks }));
vi.mock('../core/global-hooks-flag.js', () => ({ shouldUseGlobalHooks: () => process.env.XTRM_GLOBAL_HOOKS === '1' }));
vi.mock('../core/skills-runtime-views.js', () => ({ assertRuntimeSkillsViews: mocked.assertRuntimeSkillsViews }));
vi.mock('../commands/pi-install.js', () => ({ runPiInstall: mocked.runPiInstall }));

import { runInstall } from '../commands/install.js';

describe('runInstall — retired managed-skill prune (xtrm-1o63w.1)', () => {
  let tmpDir = '';
  let previousCwd = '';
  let previousHome: string | undefined;
  let sandboxHome = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-prune-smoke-'));
    // xtrm-8zsi1: XTRM_GLOBAL_SKILLS mode reroutes the install target to
    // ~/.xtrm/skills/default. Without HOME sandboxing this test would prune
    // the operator's real global skills tree.
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-prune-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = sandboxHome;
    process.chdir(tmpDir);
    mocked.getContext.mockResolvedValue({ targets: [path.join(tmpDir, '.xtrm')] });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.removeSync(tmpDir);
    fs.removeSync(sandboxHome);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    vi.clearAllMocks();
  });

  async function writeSkill(root: string, name: string, body = ''): Promise<void> {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const skillDir = path.join(root, name);
    await fs.ensureDir(skillDir);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), body || `# ${name}\n`, 'utf8');
  }

  it('removes only retired managed defaults proved by prior ownership; keeps unmanaged entries', async () => {
    const packageRoot = path.join(tmpDir, 'pkg');
    const packageDefault = path.join(packageRoot, '.xtrm', 'skills', 'default');
    const userXtrmDir = path.join(tmpDir, '.xtrm');
    const targetDefault = path.join(userXtrmDir, 'skills', 'default');
    const targetActive = path.join(userXtrmDir, 'skills', 'active');

    // Package registry ships ONLY using-specialists (v3 retired).
    fs.ensureDirSync(path.join(packageRoot, '.xtrm'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.0.0' });
    await writeSkill(packageDefault, 'using-specialists');
    fs.writeJsonSync(path.join(packageRoot, '.xtrm', 'registry.json'), {
      version: '1.0.0',
      assets: {
        skills: {
          source_dir: '.xtrm/skills/default',
          install_mode: 'copy',
          files: {
            'using-specialists/SKILL.md': { hash: 'x', version: '1.0.0' },
          },
        },
      },
    });

    // Prior repo snapshot proves only these two defaults were xt-managed.
    await fs.ensureDir(userXtrmDir);
    await fs.writeJson(path.join(userXtrmDir, 'registry.json'), {
      version: '0.9.0',
      assets: {
        skills: {
          source_dir: '.xtrm/skills/default',
          install_mode: 'copy',
          files: {
            'using-specialists/SKILL.md': { hash: 'old', version: '0.9.0' },
            'using-specialists-v3/SKILL.md': { hash: 'old', version: '0.9.0' },
          },
        },
      },
    });

    // Consumer fixture: one retired managed skill, one current managed skill,
    // and one unmanaged drop-in that must survive.
    await writeSkill(targetDefault, 'using-specialists-v3');
    await writeSkill(targetDefault, 'using-specialists');
    await writeSkill(targetDefault, 'user-dropin');
    await fs.ensureDir(targetActive);
    await fs.symlink(
      path.join('..', 'default', 'using-specialists-v3'),
      path.join(targetActive, 'using-specialists-v3'),
    );
    await fs.symlink(
      path.join('..', 'default', 'using-specialists'),
      path.join(targetActive, 'using-specialists'),
    );

    // User-owned active content that must be preserved:
    //  1. a real dir at active/user-real (no symlink)
    await fs.ensureDir(path.join(targetActive, 'user-real'));
    await fs.writeFile(path.join(targetActive, 'user-real', 'SKILL.md'), '# user\n', 'utf8');
    //  2. a symlink pointing outside default/ (into a user pack)
    await fs.ensureDir(path.join(userXtrmDir, 'skills', 'my-pack', 'my-skill'));
    await fs.writeFile(path.join(userXtrmDir, 'skills', 'my-pack', 'my-skill', 'SKILL.md'), '# pack\n', 'utf8');
    await fs.symlink(path.join('..', 'my-pack', 'my-skill'), path.join(targetActive, 'my-skill'));

    await runInstall({
      yes: true,
      dryRun: false,
      projectRoot: tmpDir,
      packageRoot,
      skipMachineBootstrap: true,
      skipClaudeRuntimeSync: true,
    });

    // Retired managed default and its active symlink are gone.
    expect(await fs.pathExists(path.join(targetDefault, 'using-specialists-v3'))).toBe(false);
    expect(await fs.pathExists(path.join(targetActive, 'using-specialists-v3'))).toBe(false);

    // Canonical managed default remains.
    expect(await fs.pathExists(path.join(targetDefault, 'using-specialists', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(targetActive, 'using-specialists'))).toBe(true);

    // Unmanaged/default-root and user-owned active content preserved.
    expect(await fs.pathExists(path.join(targetDefault, 'user-dropin', 'SKILL.md'))).toBe(true);
    expect(await fs.readFile(path.join(targetActive, 'user-real', 'SKILL.md'), 'utf8')).toBe('# user\n');
    expect(await fs.pathExists(path.join(targetActive, 'my-skill'))).toBe(true);
    expect((await fs.lstat(path.join(targetActive, 'my-skill'))).isSymbolicLink()).toBe(true);
  });

  it('hydrates managed skills without pruning a false three-entry pre-state that lacks ownership proof', async () => {
    const packageRoot = path.join(tmpDir, 'pkg');
    const packageDefault = path.join(packageRoot, '.xtrm', 'skills', 'default');
    const userXtrmDir = path.join(tmpDir, '.xtrm');
    const targetDefault = path.join(userXtrmDir, 'skills', 'default');

    fs.ensureDirSync(path.join(packageRoot, '.xtrm'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.0.0' });
    await writeSkill(packageDefault, 'using-specialists');
    fs.writeJsonSync(path.join(packageRoot, '.xtrm', 'registry.json'), {
      version: '1.0.0',
      assets: {
        skills: {
          source_dir: '.xtrm/skills/default',
          install_mode: 'copy',
          files: {
            'using-specialists/SKILL.md': { hash: 'x', version: '1.0.0' },
          },
        },
      },
    });

    await fs.ensureDir(targetDefault);
    for (const name of ['alpha-baseline', 'beta-baseline', 'gamma-baseline']) {
      await writeSkill(targetDefault, name);
    }

    await runInstall({
      yes: true,
      dryRun: false,
      projectRoot: tmpDir,
      packageRoot,
      skipMachineBootstrap: true,
      skipClaudeRuntimeSync: true,
    });

    for (const name of ['alpha-baseline', 'beta-baseline', 'gamma-baseline']) {
      expect(await fs.pathExists(path.join(targetDefault, name, 'SKILL.md'))).toBe(true);
    }
    expect(await fs.pathExists(path.join(targetDefault, 'using-specialists', 'SKILL.md'))).toBe(true);
  });

  it('dry-run reports but does not touch disk', async () => {
    const packageRoot = path.join(tmpDir, 'pkg');
    const packageDefault = path.join(packageRoot, '.xtrm', 'skills', 'default');
    const userXtrmDir = path.join(tmpDir, '.xtrm');
    const targetDefault = path.join(userXtrmDir, 'skills', 'default');

    fs.ensureDirSync(path.join(packageRoot, '.xtrm'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.0.0' });
    await writeSkill(packageDefault, 'using-specialists');
    fs.writeJsonSync(path.join(packageRoot, '.xtrm', 'registry.json'), {
      version: '1.0.0',
      assets: {
        skills: {
          source_dir: '.xtrm/skills/default',
          install_mode: 'copy',
          files: {
            'using-specialists/SKILL.md': { hash: 'x', version: '1.0.0' },
          },
        },
      },
    });

    await writeSkill(targetDefault, 'using-specialists-v3');

    await runInstall({
      yes: true,
      dryRun: true,
      projectRoot: tmpDir,
      packageRoot,
      skipMachineBootstrap: true,
      skipClaudeRuntimeSync: true,
    });

    // dryRun: v3 still on disk
    expect(await fs.pathExists(path.join(targetDefault, 'using-specialists-v3'))).toBe(true);
  });
});
