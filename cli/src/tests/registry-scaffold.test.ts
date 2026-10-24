import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assessSuspiciousPrune,
  collectManagedDefaultSkillNames,
  hashFile,
  installFromRegistry,
  isSkillsDefaultPath,
  isUserOwnedPath,
  pruneRetiredManagedSkills,
  pruneRetiredOptionalSkills,
  scaffoldSkillsDefaultFromPackage,
  stripXtrmPrefix,
  toPosix,
  toUserRelativePath,
} from '../core/registry-scaffold.js';
import { ensureAgentsSkillsSymlink, ensureUserAgentsSkillsSymlink } from '../core/skills-scaffold.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function createTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-scaffold-test-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeSkill(root: string, name: string): Promise<void> {
  const skillRoot = path.join(root, name);
  await fs.ensureDir(skillRoot);
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), `# ${name}\n`, 'utf8');
}

describe('registry-scaffold path helpers', () => {
  it('toPosix converts windows-style separators to posix', () => {
    expect(toPosix('skills\\default\\README.md')).toBe('skills/default/README.md');
  });

  it('toPosix leaves already-posix paths unchanged', () => {
    expect(toPosix('skills/default/README.md')).toBe('skills/default/README.md');
  });

  it('stripXtrmPrefix strips .xtrm/foo/bar correctly', () => {
    expect(stripXtrmPrefix('.xtrm/foo/bar')).toBe('foo/bar');
  });

  it('stripXtrmPrefix strips .xtrm/ prefix exactly', () => {
    expect(stripXtrmPrefix('.xtrm/')).toBe('');
  });

  it('stripXtrmPrefix returns unchanged path when no .xtrm prefix is present', () => {
    expect(stripXtrmPrefix('hooks/post-tool-use.mjs')).toBe('hooks/post-tool-use.mjs');
  });

  it('toUserRelativePath joins sourceDir + filePath with posix separators', () => {
    expect(toUserRelativePath('.xtrm/skills/default', 'foo.md')).toBe('skills/default/foo.md');
  });

  it('toUserRelativePath strips .xtrm prefix before joining', () => {
    expect(toUserRelativePath('.xtrm/hooks', 'post-tool-use.mjs')).toBe('hooks/post-tool-use.mjs');
  });

  it('isSkillsDefaultPath returns true for skills/default paths', () => {
    expect(isSkillsDefaultPath('skills/default/README.md')).toBe(true);
  });

  it('isSkillsDefaultPath returns false for hooks paths', () => {
    expect(isSkillsDefaultPath('hooks/post-tool-use.mjs')).toBe(false);
  });

  it('isSkillsDefaultPath returns false for config paths', () => {
    expect(isSkillsDefaultPath('config/settings.json')).toBe(false);
  });

  it('isUserOwnedPath no longer matches retired .xtrm/memory.md', () => {
    expect(isUserOwnedPath('memory.md')).toBe(false);
  });

  it('isUserOwnedPath matches files under .xtrm/skills/user/', () => {
    expect(isUserOwnedPath('skills/user/packs/local/PACK.json')).toBe(true);
  });

  it('isUserOwnedPath ignores non user-owned paths', () => {
    expect(isUserOwnedPath('skills/default/using-xtrm/SKILL.md')).toBe(false);
  });
});

describe('scaffoldSkillsDefaultFromPackage', () => {
  it('returns copy when targetDir does not exist', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const sourceDir = path.join(packageRoot, '.xtrm', 'skills', 'default');
    const targetDir = path.join(userXtrmDir, 'skills', 'default');

    await fs.ensureDir(sourceDir);
    await fs.writeFile(path.join(sourceDir, 'README.md'), '# skill\n', 'utf8');

    const result = await scaffoldSkillsDefaultFromPackage({
      packageRoot,
      userXtrmDir,
      dryRun: false,
    });

    expect(result).toBe('copy');
    expect((await fs.lstat(targetDir)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(targetDir, 'README.md'), 'utf8')).toBe('# skill\n');
  });

  it('returns noop when targetDir already exists', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const sourceDir = path.join(packageRoot, '.xtrm', 'skills', 'default');
    const targetDir = path.join(userXtrmDir, 'skills', 'default');

    await fs.ensureDir(sourceDir);
    await fs.ensureDir(targetDir);

    const result = await scaffoldSkillsDefaultFromPackage({
      packageRoot,
      userXtrmDir,
      dryRun: false,
    });

    expect(result).toBe('noop');
  });

  it('removes broken symlink and copies when targetDir is a broken symlink', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const sourceDir = path.join(packageRoot, '.xtrm', 'skills', 'default');
    const targetDir = path.join(userXtrmDir, 'skills', 'default');

    await fs.ensureDir(sourceDir);
    await fs.writeFile(path.join(sourceDir, 'README.md'), '# skill\n', 'utf8');

    // create a broken symlink at targetDir
    await fs.ensureDir(path.dirname(targetDir));
    await fs.symlink('/nonexistent/path/that/does/not/exist', targetDir);
    expect((await fs.lstat(targetDir)).isSymbolicLink()).toBe(true);
    expect(await fs.pathExists(targetDir)).toBe(false);

    const result = await scaffoldSkillsDefaultFromPackage({
      packageRoot,
      userXtrmDir,
      dryRun: false,
    });

    expect(result).toBe('copy');
    expect(await fs.readFile(path.join(targetDir, 'README.md'), 'utf8')).toBe('# skill\n');
  });

  it('returns noop when targetDir points at the current package skills payload', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const sourceDir = path.join(packageRoot, '.xtrm', 'skills', 'default');
    const targetDir = path.join(userXtrmDir, 'skills', 'default');

    await fs.ensureDir(sourceDir);
    await fs.ensureDir(path.dirname(targetDir));
    await fs.symlink(sourceDir, targetDir);

    const result = await scaffoldSkillsDefaultFromPackage({
      packageRoot,
      userXtrmDir,
      dryRun: false,
    });

    expect(result).toBe('noop');
    expect((await fs.lstat(targetDir)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(targetDir)).toBe(sourceDir);
  });

  it('replaces a stale but valid symlink with the current package payload', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const sourceDir = path.join(packageRoot, '.xtrm', 'skills', 'default');
    const targetDir = path.join(userXtrmDir, 'skills', 'default');
    const staleDir = path.join(tempDir, 'old-dev-skills');

    await fs.ensureDir(sourceDir);
    await fs.writeFile(path.join(sourceDir, 'README.md'), '# current skill\n', 'utf8');
    await fs.ensureDir(staleDir);
    await fs.writeFile(path.join(staleDir, 'README.md'), '# stale skill\n', 'utf8');
    await fs.ensureDir(path.dirname(targetDir));
    await fs.symlink(staleDir, targetDir);

    const result = await scaffoldSkillsDefaultFromPackage({
      packageRoot,
      userXtrmDir,
      dryRun: false,
    });

    expect(result).toBe('copy');
    expect((await fs.lstat(targetDir)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(targetDir, 'README.md'), 'utf8')).toBe('# current skill\n');
    expect(await fs.readFile(path.join(staleDir, 'README.md'), 'utf8')).toBe('# stale skill\n');
  });

  it('returns noop in dry-run mode', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const sourceDir = path.join(packageRoot, '.xtrm', 'skills', 'default');

    await fs.ensureDir(sourceDir);

    const result = await scaffoldSkillsDefaultFromPackage({
      packageRoot,
      userXtrmDir,
      dryRun: true,
    });

    expect(result).toBe('noop');
    expect(await fs.pathExists(path.join(userXtrmDir, 'skills', 'default'))).toBe(false);
  });

  it('under XTRM_GLOBAL_SKILLS is a noop when global tree already exists and does not eagerly scaffold user packs', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const previousHome = process.env.HOME;
    const previousFlag = process.env.XTRM_GLOBAL_SKILLS;

    process.env.HOME = tempDir;
    process.env.XTRM_GLOBAL_SKILLS = '1';

    try {
      await fs.ensureDir(path.join(packageRoot, '.xtrm', 'skills', 'default'));
      await fs.ensureDir(path.join(tempDir, '.xtrm', 'skills', 'default'));
      await fs.ensureDir(path.join(tempDir, '.xtrm', 'skills', 'optional'));

      const result = await scaffoldSkillsDefaultFromPackage({
        packageRoot,
        userXtrmDir,
        dryRun: false,
      });

      expect(result).toBe('noop');
      expect(await fs.pathExists(path.join(userXtrmDir, 'skills', 'default'))).toBe(false);
      expect(await fs.pathExists(path.join(userXtrmDir, 'skills', 'user', 'packs'))).toBe(false);
    } finally {
      process.env.HOME = previousHome;
      process.env.XTRM_GLOBAL_SKILLS = previousFlag;
    }
  });
});

describe('pruneRetiredOptionalSkills', () => {
  it('removes the retired update-specialists dir and keeps other optional skills', async () => {
    const userXtrmDir = path.join(await createTempDir(), 'user-xtrm');
    const packRoot = path.join(userXtrmDir, 'skills', 'optional', 'xtrm-maintenance');
    await writeSkill(packRoot, 'update-specialists');
    await writeSkill(packRoot, 'user-authored');

    const dry = await pruneRetiredOptionalSkills({ userXtrmDir, dryRun: true });
    expect(dry.removed).toEqual(['xtrm-maintenance/update-specialists']);
    expect(await fs.pathExists(path.join(packRoot, 'update-specialists'))).toBe(true);

    const result = await pruneRetiredOptionalSkills({ userXtrmDir, dryRun: false });
    expect(result.removed).toEqual(['xtrm-maintenance/update-specialists']);
    expect(await fs.pathExists(path.join(packRoot, 'update-specialists'))).toBe(false);
    expect(await fs.pathExists(path.join(packRoot, 'user-authored'))).toBe(true);
  });

  it('noop when the optional tier is absent', async () => {
    const userXtrmDir = path.join(await createTempDir(), 'user-xtrm');
    expect((await pruneRetiredOptionalSkills({ userXtrmDir, dryRun: false })).removed).toEqual([]);
  });

  // CORE-2407: the optional tier can be materialized as symlinks. The release
  // smoke asserts the retired path does not exist (`! test -e`), which follows
  // symlinks, so prune must remove a symlink too or it reports success while
  // the smoke fails.
  const itIfSymlinkSupported = process.platform === 'win32' ? it.skip : it;
  itIfSymlinkSupported('removes a symlink at the retired path, matching the release smoke', async () => {
    const userXtrmDir = path.join(await createTempDir(), 'user-xtrm');
    const packRoot = path.join(userXtrmDir, 'skills', 'optional', 'xtrm-maintenance');
    const elsewhere = path.join(await createTempDir(), 'elsewhere');
    await fs.ensureDir(packRoot);
    await fs.ensureDir(elsewhere);
    await writeSkill(elsewhere, 'update-specialists');
    await fs.symlink(path.join(elsewhere, 'update-specialists'), path.join(packRoot, 'update-specialists'));

    const result = await pruneRetiredOptionalSkills({ userXtrmDir, dryRun: false });

    expect(result.removed).toEqual(['xtrm-maintenance/update-specialists']);
    expect(await fs.pathExists(path.join(packRoot, 'update-specialists'))).toBe(false);
    // The symlink target itself is user-owned and untouched.
    expect(await fs.pathExists(path.join(elsewhere, 'update-specialists', 'SKILL.md'))).toBe(true);
  });

  it('keeps a plain file at the retired path (files stay user-owned)', async () => {
    const userXtrmDir = path.join(await createTempDir(), 'user-xtrm');
    const retiredPath = path.join(userXtrmDir, 'skills', 'optional', 'xtrm-maintenance', 'update-specialists');
    await fs.ensureDir(path.dirname(retiredPath));
    await fs.writeFile(retiredPath, 'user notes', 'utf8');

    const result = await pruneRetiredOptionalSkills({ userXtrmDir, dryRun: false });

    expect(result.removed).toEqual([]);
    expect(await fs.readFile(retiredPath, 'utf8')).toBe('user notes');
  });
});

describe('pruneRetiredManagedSkills', () => {
  // CORE-2513: prune now appends to ~/.xtrm/logs/skills-migration.jsonl and may
  // snapshot the skills root, so every test here sandboxes HOME.
  let previousHome: string | undefined;
  let sandboxHome = '';

  const pruneLogPath = () => path.join(sandboxHome, '.xtrm', 'logs', 'skills-migration.jsonl');
  const readPruneLog = async (): Promise<Record<string, any>[]> => {
    if (!await fs.pathExists(pruneLogPath())) return [];
    return (await fs.readFile(pruneLogPath(), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, any>);
  };

  const buildRegistry = (skillNames: readonly string[]) => ({
    version: '1.0.0',
    assets: {
      skills: {
        source_dir: '.xtrm/skills/default',
        install_mode: 'copy' as const,
        files: Object.fromEntries(skillNames.map(name => [
          `${name}/SKILL.md`,
          { hash: `${name}-hash`, version: '1.0.0' },
        ])),
      },
    },
  });

  beforeEach(async () => {
    sandboxHome = await createTempDir();
    previousHome = process.env.HOME;
    process.env.HOME = sandboxHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it('removes managed default dirs no longer in the registry and reports them', async () => {
    const tempDir = await createTempDir();
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const defaultRoot = path.join(userXtrmDir, 'skills', 'default');
    await fs.ensureDir(defaultRoot);
    await writeSkill(defaultRoot, 'using-specialists');
    await writeSkill(defaultRoot, 'using-specialists-v3');
    await fs.writeJson(path.join(userXtrmDir, 'registry.json'), buildRegistry(['using-specialists', 'using-specialists-v3']));

    const registry = buildRegistry(['using-specialists']);

    const result = await pruneRetiredManagedSkills({
      userXtrmDir,
      registry,
      dryRun: false,
    });

    expect(result.removed).toEqual(['using-specialists-v3']);
    expect(await fs.pathExists(path.join(defaultRoot, 'using-specialists'))).toBe(true);
    expect(await fs.pathExists(path.join(defaultRoot, 'using-specialists-v3'))).toBe(false);
  });

  it('also removes matching active-view symlinks that point at the pruned default', async () => {
    const tempDir = await createTempDir();
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const defaultRoot = path.join(userXtrmDir, 'skills', 'default');
    const activeRoot = path.join(userXtrmDir, 'skills', 'active');
    await fs.ensureDir(defaultRoot);
    await fs.ensureDir(activeRoot);
    await writeSkill(defaultRoot, 'using-specialists-v3');
    await fs.writeJson(path.join(userXtrmDir, 'registry.json'), buildRegistry(['using-specialists', 'using-specialists-v3']));
    await fs.symlink(
      path.join('..', 'default', 'using-specialists-v3'),
      path.join(activeRoot, 'using-specialists-v3'),
    );

    const registry = buildRegistry(['using-specialists']);

    const result = await pruneRetiredManagedSkills({
      userXtrmDir,
      registry,
      dryRun: false,
    });

    expect(result.removed).toEqual(['using-specialists-v3']);
    expect(await fs.pathExists(path.join(defaultRoot, 'using-specialists-v3'))).toBe(false);
    expect(await fs.pathExists(path.join(activeRoot, 'using-specialists-v3'))).toBe(false);
  });

  it('preserves user-owned active content: real dirs and symlinks pointing outside default/', async () => {
    const tempDir = await createTempDir();
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const defaultRoot = path.join(userXtrmDir, 'skills', 'default');
    const activeRoot = path.join(userXtrmDir, 'skills', 'active');
    await fs.ensureDir(defaultRoot);
    await fs.ensureDir(activeRoot);
    await writeSkill(defaultRoot, 'using-specialists-v3');
    await fs.writeJson(path.join(userXtrmDir, 'registry.json'), buildRegistry(['using-specialists', 'using-specialists-v3']));

    // user real-dir entry that shares name with retired skill — must not be touched
    const userRealDir = path.join(activeRoot, 'using-specialists-v3');
    await fs.ensureDir(userRealDir);
    await fs.writeFile(path.join(userRealDir, 'SKILL.md'), '# user override\n', 'utf8');

    // user pack elsewhere: active symlink to a different tree
    const userPackDir = path.join(userXtrmDir, 'skills', 'my-pack', 'my-skill');
    await fs.ensureDir(userPackDir);
    await fs.writeFile(path.join(userPackDir, 'SKILL.md'), '# user pack\n', 'utf8');
    await fs.symlink(
      path.join('..', 'my-pack', 'my-skill'),
      path.join(activeRoot, 'my-skill'),
    );

    const registry = buildRegistry(['using-specialists']);

    const result = await pruneRetiredManagedSkills({
      userXtrmDir,
      registry,
      dryRun: false,
    });

    expect(result.removed).toEqual(['using-specialists-v3']);
    expect(await fs.pathExists(path.join(defaultRoot, 'using-specialists-v3'))).toBe(false);
    // user real dir at active/using-specialists-v3 remains
    expect((await fs.lstat(path.join(activeRoot, 'using-specialists-v3'))).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(activeRoot, 'using-specialists-v3', 'SKILL.md'), 'utf8')).toBe('# user override\n');
    // user pack symlink remains
    expect(await fs.pathExists(path.join(activeRoot, 'my-skill'))).toBe(true);
  });

  it('respects dryRun: reports removals without touching disk', async () => {
    const tempDir = await createTempDir();
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const defaultRoot = path.join(userXtrmDir, 'skills', 'default');
    const activeRoot = path.join(userXtrmDir, 'skills', 'active');
    await fs.ensureDir(defaultRoot);
    await fs.ensureDir(activeRoot);
    await writeSkill(defaultRoot, 'using-specialists-v3');
    await fs.writeJson(path.join(userXtrmDir, 'registry.json'), buildRegistry(['using-specialists', 'using-specialists-v3']));
    await fs.symlink(
      path.join('..', 'default', 'using-specialists-v3'),
      path.join(activeRoot, 'using-specialists-v3'),
    );

    const registry = buildRegistry(['using-specialists']);

    const result = await pruneRetiredManagedSkills({
      userXtrmDir,
      registry,
      dryRun: true,
    });

    expect(result.removed).toEqual(['using-specialists-v3']);
    expect(await fs.pathExists(path.join(defaultRoot, 'using-specialists-v3'))).toBe(true);
    expect(await fs.pathExists(path.join(activeRoot, 'using-specialists-v3'))).toBe(true);
  });

  it('noop when the registry carries no default skills asset (e.g. project snapshot under global mode)', async () => {
    const tempDir = await createTempDir();
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const defaultRoot = path.join(userXtrmDir, 'skills', 'default');
    await fs.ensureDir(defaultRoot);
    await writeSkill(defaultRoot, 'using-specialists-v3');

    const registry = {
      version: '1.0.0',
      assets: {
        hooks: {
          source_dir: '.xtrm/hooks',
          install_mode: 'copy' as const,
          files: { 'pre-commit.mjs': { hash: 'x', version: '1.0.0' } },
        },
      },
    };

    const result = await pruneRetiredManagedSkills({
      userXtrmDir,
      registry,
      dryRun: false,
    });

    expect(result.removed).toEqual([]);
    expect(await fs.pathExists(path.join(defaultRoot, 'using-specialists-v3'))).toBe(true);
  });

  it('noop when default root does not exist', async () => {
    const tempDir = await createTempDir();
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    // no skills/default/ at all
    const registry = buildRegistry(['using-specialists']);
    const result = await pruneRetiredManagedSkills({ userXtrmDir, registry, dryRun: false });
    expect(result.removed).toEqual([]);
  });

  it('collectManagedDefaultSkillNames pulls first-segment names from the skills asset', () => {
    const registry = {
      version: '1.0.0',
      assets: {
        skills: {
          source_dir: '.xtrm/skills/default',
          install_mode: 'copy' as const,
          files: {
            'foo/SKILL.md': { hash: 'a', version: '1.0.0' },
            'foo/scripts/x.mjs': { hash: 'b', version: '1.0.0' },
            'bar/SKILL.md': { hash: 'c', version: '1.0.0' },
          },
        },
        hooks: {
          source_dir: '.xtrm/hooks',
          install_mode: 'copy' as const,
          files: { 'pre-commit.mjs': { hash: 'd', version: '1.0.0' } },
        },
      },
    };
    expect([...collectManagedDefaultSkillNames(registry)].sort()).toEqual(['bar', 'foo']);
  });

  it('sweeps per-runtime active views (active/<runtime>/<name>) and keeps surviving links resolvable', async () => {
    const tempDir = await createTempDir();
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const defaultRoot = path.join(userXtrmDir, 'skills', 'default');
    const activeRoot = path.join(userXtrmDir, 'skills', 'active');
    await fs.ensureDir(defaultRoot);
    for (const name of ['using-specialists', 'using-specialists-v3']) {
      await writeSkill(defaultRoot, name);
    }
    await fs.writeJson(path.join(userXtrmDir, 'registry.json'), buildRegistry(['using-specialists', 'using-specialists-v3']));

    for (const runtime of ['pi', 'claude', 'codex']) {
      const viewRoot = path.join(activeRoot, runtime);
      await fs.ensureDir(viewRoot);
      for (const name of ['using-specialists', 'using-specialists-v3']) {
        await fs.symlink(path.join('..', '..', 'default', name), path.join(viewRoot, name));
      }
    }

    const result = await pruneRetiredManagedSkills({
      userXtrmDir,
      registry: buildRegistry(['using-specialists']),
      dryRun: false,
    });

    expect(result.refused).toBe(false);
    expect(result.removed).toEqual(['using-specialists-v3']);
    expect(result.sweptActiveLinks.sort()).toEqual([
      'claude/using-specialists-v3',
      'codex/using-specialists-v3',
      'pi/using-specialists-v3',
    ]);
    for (const runtime of ['pi', 'claude', 'codex']) {
      expect(await fs.pathExists(path.join(activeRoot, runtime, 'using-specialists-v3'))).toBe(false);
      // The surviving per-runtime link still resolves.
      expect(await fs.pathExists(path.join(activeRoot, runtime, 'using-specialists', 'SKILL.md'))).toBe(true);
    }
  });

  it('appends one prune event with the registry source, managed-set digest and removed names', async () => {
    const tempDir = await createTempDir();
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const defaultRoot = path.join(userXtrmDir, 'skills', 'default');
    const registrySource = path.join(tempDir, 'pkg', '.xtrm', 'registry.json');
    await fs.ensureDir(defaultRoot);
    await writeSkill(defaultRoot, 'using-specialists');
    await writeSkill(defaultRoot, 'using-specialists-v3');
    await fs.writeJson(path.join(userXtrmDir, 'registry.json'), buildRegistry(['using-specialists', 'using-specialists-v3']));

    const result = await pruneRetiredManagedSkills({
      userXtrmDir,
      registry: buildRegistry(['using-specialists']),
      dryRun: false,
      registrySource,
    });

    const events = await readPruneLog();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      component: 'skills-prune',
      event: 'prune.retired-managed',
      outcome: 'ok',
      scope: 'project',
      registrySource,
      managedCount: 1,
      previouslyManagedCount: 2,
      retiredCount: 1,
      removed: ['using-specialists-v3'],
      removedCount: 1,
      dryRun: false,
    });
    expect(events[0].managedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof events[0].timestamp).toBe('string');

    // Snapshot taken before removal, with a verifiable digest sidecar.
    expect(result.backupArchive).toBeDefined();
    expect(await fs.pathExists(result.backupArchive!)).toBe(true);
    const sidecar = await fs.readJson(`${result.backupArchive!}.sha256.json`) as { sha256: string };
    expect(sidecar.sha256).toBe(await hashFile(result.backupArchive!));
    expect(events[0].backupArchive).toContain('global-skills-');
  });

  it('a dry run logs a planned event with no snapshot and no deletion', async () => {
    const tempDir = await createTempDir();
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const defaultRoot = path.join(userXtrmDir, 'skills', 'default');
    await fs.ensureDir(defaultRoot);
    await writeSkill(defaultRoot, 'using-specialists');
    await writeSkill(defaultRoot, 'using-specialists-v3');
    await fs.writeJson(path.join(userXtrmDir, 'registry.json'), buildRegistry(['using-specialists', 'using-specialists-v3']));

    const result = await pruneRetiredManagedSkills({
      userXtrmDir,
      registry: buildRegistry(['using-specialists']),
      dryRun: true,
    });

    expect(result.removed).toEqual(['using-specialists-v3']);
    expect(result.backupArchive).toBeUndefined();
    expect(await fs.pathExists(path.join(userXtrmDir, 'skills', 'migration-backups'))).toBe(false);
    expect(await fs.pathExists(path.join(defaultRoot, 'using-specialists-v3'))).toBe(true);
    const events = await readPruneLog();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'planned', dryRun: true, removed: ['using-specialists-v3'] });
    expect(events[0].backupArchive).toBeUndefined();
  });

  // CORE-2513 regression fixture: the 2026-10-21 wipe was a prune whose registry
  // managed 1 of 10 previously managed skills. That must refuse, log and delete nothing.
  const REDUCED_REGISTRY_VICTIMS = [
    'codemode',
    'engineering-quality',
    'find-skills',
    'gitnexus',
    'goal-prompt',
    'multiplexing',
    'open-code-review',
    'planning',
    'skill-creator',
    'using-xtrm',
  ];

  async function seedReducedRegistryFixture(): Promise<{ userXtrmDir: string; defaultRoot: string; activeRoot: string }> {
    const tempDir = await createTempDir();
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const defaultRoot = path.join(userXtrmDir, 'skills', 'default');
    const activeRoot = path.join(userXtrmDir, 'skills', 'active');
    await fs.ensureDir(defaultRoot);
    await fs.writeJson(path.join(userXtrmDir, 'registry.json'), buildRegistry(REDUCED_REGISTRY_VICTIMS));
    for (const name of REDUCED_REGISTRY_VICTIMS) {
      await writeSkill(defaultRoot, name);
    }
    for (const runtime of ['pi', 'claude', 'codex']) {
      const viewRoot = path.join(activeRoot, runtime);
      await fs.ensureDir(viewRoot);
      for (const name of REDUCED_REGISTRY_VICTIMS) {
        await fs.symlink(path.join('..', '..', 'default', name), path.join(viewRoot, name));
      }
    }
    return { userXtrmDir, defaultRoot, activeRoot };
  }

  it('refuses a reduced registry that would retire most of the managed set, and deletes nothing', async () => {
    const { userXtrmDir, defaultRoot, activeRoot } = await seedReducedRegistryFixture();

    const result = await pruneRetiredManagedSkills({
      userXtrmDir,
      registry: buildRegistry(['codemode']),
      dryRun: false,
    });

    expect(result.refused).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.sweptActiveLinks).toEqual([]);
    expect(result.retired).toHaveLength(9);
    expect(result.refusalReason).toContain('retires 9 of 10');

    for (const name of REDUCED_REGISTRY_VICTIMS) {
      expect(await fs.pathExists(path.join(defaultRoot, name, 'SKILL.md'))).toBe(true);
    }
    for (const runtime of ['pi', 'claude', 'codex']) {
      for (const name of REDUCED_REGISTRY_VICTIMS) {
        expect(await fs.pathExists(path.join(activeRoot, runtime, name, 'SKILL.md'))).toBe(true);
      }
    }

    const events = await readPruneLog();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'prune.retired-managed',
      outcome: 'refused',
      removed: [],
      removedCount: 0,
      retiredCount: 9,
      previouslyManagedCount: 10,
    });
    expect(events[0].refusalReason).toContain('managed set shrank to 1 of 10');
  });

  it('performs the same destructive contraction only with explicit confirmation, logging the override', async () => {
    const { userXtrmDir, defaultRoot, activeRoot } = await seedReducedRegistryFixture();

    const result = await pruneRetiredManagedSkills({
      userXtrmDir,
      registry: buildRegistry(['codemode']),
      dryRun: false,
      yes: true,
    });

    expect(result.refused).toBe(false);
    expect(result.removed).toHaveLength(9);
    expect(result.sweptActiveLinks).toHaveLength(27);
    expect(await fs.pathExists(path.join(defaultRoot, 'codemode'))).toBe(true);
    expect(await fs.pathExists(path.join(defaultRoot, 'using-xtrm'))).toBe(false);
    expect(await fs.pathExists(path.join(activeRoot, 'pi', 'using-xtrm'))).toBe(false);

    const events = await readPruneLog();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'override', removedCount: 9, sweptActiveLinks: 27 });
    expect(await fs.pathExists(result.backupArchive!)).toBe(true);
  });

  it('assessSuspiciousPrune leaves ordinary single-skill retirement alone', () => {
    expect(assessSuspiciousPrune({
      previouslyManaged: new Set(['using-specialists', 'using-specialists-v3']),
      managed: new Set(['using-specialists']),
      retired: new Set(['using-specialists-v3']),
    })).toEqual({ suspicious: false });

    expect(assessSuspiciousPrune({
      previouslyManaged: new Set(['a', 'b', 'c', 'd']),
      managed: new Set(['a', 'b', 'c']),
      retired: new Set(['d']),
    })).toEqual({ suspicious: false });
  });

  it('assessSuspiciousPrune flags a halved managed set and a majority retirement', () => {
    const halved = assessSuspiciousPrune({
      previouslyManaged: new Set(['a', 'b', 'c', 'd']),
      managed: new Set(['a', 'b']),
      retired: new Set(['c', 'd']),
    });
    expect(halved.suspicious).toBe(true);
    expect(halved.reason).toContain('shrank to 2 of 4');

    const majority = assessSuspiciousPrune({
      previouslyManaged: new Set(['a', 'b', 'c', 'd', 'e']),
      managed: new Set(['a', 'b']),
      retired: new Set(['c', 'd', 'e']),
    });
    expect(majority.suspicious).toBe(true);
    expect(majority.reason).toContain('retires 3 of 5');
  });
});

describe('installFromRegistry', () => {
  it('never installs user-owned paths from registry assets', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');

    const userSkillSource = path.join(packageRoot, '.xtrm', 'skills', 'user', 'packs', 'local', 'PACK.json');
    const hookSource = path.join(packageRoot, '.xtrm', 'hooks', 'post-tool-use.mjs');

    await fs.ensureDir(path.dirname(userSkillSource));
    await fs.ensureDir(path.dirname(hookSource));
    await fs.writeFile(userSkillSource, '{}\n', 'utf8');
    await fs.writeFile(hookSource, 'export default {}\n', 'utf8');

    const registry = {
      version: '1.0.0',
      assets: {
        core: {
          source_dir: '.xtrm',
          install_mode: 'copy' as const,
          files: {
            'skills/user/packs/local/PACK.json': { hash: 'user-skill-hash', version: '1.0.0' },
            'hooks/post-tool-use.mjs': { hash: 'hook-hash', version: '1.0.0' },
          },
        },
      },
    };

    await fs.ensureDir(path.join(packageRoot, '.xtrm'));
    await fs.writeJson(path.join(packageRoot, '.xtrm', 'registry.json'), registry);

    const result = await installFromRegistry({
      packageRoot,
      registry,
      userXtrmDir,
      dryRun: false,
      force: true,
      yes: true,
    });

    expect(result.installed).toBe(1);
    expect(result.expectedInstalls).toBe(1);
    expect(result.missingSourceSkipped).toBe(0);
    expect(await fs.pathExists(path.join(userXtrmDir, 'hooks', 'post-tool-use.mjs'))).toBe(true);
    expect(await fs.pathExists(path.join(userXtrmDir, 'skills', 'user', 'packs', 'local', 'PACK.json'))).toBe(false);
  });

  it('seeds registry.json into the target .xtrm/ (xtrm-ya2i)', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');

    const hookSource = path.join(packageRoot, '.xtrm', 'hooks', 'post-tool-use.mjs');
    await fs.ensureDir(path.dirname(hookSource));
    await fs.writeFile(hookSource, 'export default {}\n', 'utf8');

    const registry = {
      version: '1.0.0',
      assets: {
        core: {
          source_dir: '.xtrm',
          install_mode: 'copy' as const,
          files: {
            'hooks/post-tool-use.mjs': { hash: 'hook-hash', version: '1.0.0' },
          },
        },
        skills: {
          source_dir: '.xtrm/skills/default',
          install_mode: 'copy' as const,
          install_scope: 'global' as const,
          files: {
            'alpha/SKILL.md': { hash: 'skill-hash', version: '1.0.0' },
          },
        },
      },
    };

    await fs.ensureDir(path.join(packageRoot, '.xtrm'));
    await fs.writeJson(path.join(packageRoot, '.xtrm', 'registry.json'), registry);

    await installFromRegistry({
      packageRoot,
      registry,
      userXtrmDir,
      dryRun: false,
      force: true,
      yes: true,
    });

    const targetRegistryPath = path.join(userXtrmDir, 'registry.json');
    expect(await fs.pathExists(targetRegistryPath)).toBe(true);
    const written = await fs.readJson(targetRegistryPath);
    expect(written).toEqual(registry);

    const previousFlag = process.env.XTRM_GLOBAL_SKILLS;
    process.env.XTRM_GLOBAL_SKILLS = '1';
    try {
      await installFromRegistry({
        packageRoot,
        registry,
        userXtrmDir,
        dryRun: false,
        force: true,
        yes: true,
      });
      const filtered = await fs.readJson(targetRegistryPath);
      expect(filtered.assets.skills).toBeUndefined();
      expect(filtered.assets.core).toBeTruthy();
    } finally {
      process.env.XTRM_GLOBAL_SKILLS = previousFlag;
    }
  });

  it('skips registry.json snapshot in dry-run mode (xtrm-ya2i)', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');

    const hookSource = path.join(packageRoot, '.xtrm', 'hooks', 'post-tool-use.mjs');
    await fs.ensureDir(path.dirname(hookSource));
    await fs.writeFile(hookSource, 'export default {}\n', 'utf8');

    const registry = {
      version: '1.0.0',
      assets: {
        core: {
          source_dir: '.xtrm',
          install_mode: 'copy' as const,
          files: { 'hooks/post-tool-use.mjs': { hash: 'h', version: '1.0.0' } },
        },
      },
    };

    await fs.ensureDir(path.join(packageRoot, '.xtrm'));
    await fs.writeJson(path.join(packageRoot, '.xtrm', 'registry.json'), registry);

    await installFromRegistry({
      packageRoot,
      registry,
      userXtrmDir,
      dryRun: true,
      force: true,
      yes: true,
    });

    expect(await fs.pathExists(path.join(userXtrmDir, 'registry.json'))).toBe(false);
  });

  it('does not clobber the source registry when packageRoot === installRepoRoot (xtrm-5ts3l)', async () => {
    // Real scenario: running `xt update --apply [--force]` from the xtrm-tools
    // source repo itself. Under global-skills mode, createProjectRegistrySnapshot
    // filters out every global-scoped asset (hooks/skills/skills_optional).
    // Without the source==target guard, the filtered snapshot gets written back
    // to the source registry — stripping it down to just `config`. The guard
    // must skip the snapshot write when source and target are the same repo.
    const tempDir = await createTempDir();
    const sourceRepo = path.join(tempDir, 'source-repo');
    const userXtrmDir = path.join(sourceRepo, '.xtrm'); // <-- source IS target

    // Hash-match source content so drift check reports no missing/drifted files
    // → installFromRegistry does no copies → only the snapshot write remains,
    // which is what this test exercises.
    const hookSourcePath = path.join(sourceRepo, '.xtrm', 'hooks', 'post-tool-use.mjs');
    await fs.ensureDir(path.dirname(hookSourcePath));
    await fs.writeFile(hookSourcePath, 'export default {}\n', 'utf8');
    const hookHash = await hashFile(hookSourcePath);

    const originalRegistry = {
      version: '1.0.0',
      assets: {
        hooks: {
          source_dir: '.xtrm/hooks',
          install_mode: 'copy' as const,
          install_scope: 'global' as const,
          files: { 'post-tool-use.mjs': { hash: hookHash, version: '1.0.0' } },
        },
        config: {
          source_dir: '.xtrm/config',
          install_mode: 'copy' as const,
          install_scope: 'project' as const,
          files: {},
        },
      },
    };
    await fs.writeJson(path.join(sourceRepo, '.xtrm', 'registry.json'), originalRegistry);

    const previousFlag = process.env.XTRM_GLOBAL_SKILLS;
    process.env.XTRM_GLOBAL_SKILLS = '1';
    try {
      await installFromRegistry({
        packageRoot: sourceRepo,
        registry: originalRegistry,
        userXtrmDir,
        dryRun: false,
        force: true,
        yes: true,
      });

      const afterRegistry = await fs.readJson(path.join(sourceRepo, '.xtrm', 'registry.json'));
      expect(afterRegistry.assets.hooks).toBeTruthy();
      expect(afterRegistry.assets.hooks.files['post-tool-use.mjs']).toBeTruthy();
      expect(afterRegistry).toEqual(originalRegistry);
    } finally {
      process.env.XTRM_GLOBAL_SKILLS = previousFlag;
    }
  });

  it('installs optional skills packs from registry assets', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');

    const packJsonSource = path.join(packageRoot, '.xtrm', 'skills', 'optional', 'pack-one', 'PACK.json');
    const skillSource = path.join(packageRoot, '.xtrm', 'skills', 'optional', 'pack-one', 'beta', 'SKILL.md');

    await fs.ensureDir(path.dirname(packJsonSource));
    await fs.ensureDir(path.dirname(skillSource));
    await fs.writeJson(packJsonSource, {
      schemaVersion: '1',
      name: 'pack-one',
      version: '1.0.0',
      description: 'pack',
      skills: ['beta'],
    });
    await fs.writeFile(skillSource, '# beta\n', 'utf8');

    const registry = {
      version: '1.0.0',
      assets: {
        skills_optional: {
          source_dir: '.xtrm/skills/optional',
          install_mode: 'copy' as const,
          files: {
            'pack-one/PACK.json': { hash: 'pack-hash', version: '1.0.0' },
            'pack-one/beta/SKILL.md': { hash: 'skill-hash', version: '1.0.0' },
          },
        },
      },
    };

    await fs.ensureDir(path.join(packageRoot, '.xtrm'));
    await fs.writeJson(path.join(packageRoot, '.xtrm', 'registry.json'), registry);

    const result = await installFromRegistry({
      packageRoot,
      registry,
      userXtrmDir,
      dryRun: false,
      force: true,
      yes: true,
    });

    expect(result.installed).toBe(2);
    expect(result.expectedInstalls).toBe(2);
    expect(result.missingSourceSkipped).toBe(0);
    expect(await fs.pathExists(path.join(userXtrmDir, 'skills', 'optional', 'pack-one', 'PACK.json'))).toBe(true);
    expect(await fs.pathExists(path.join(userXtrmDir, 'skills', 'optional', 'pack-one', 'beta', 'SKILL.md'))).toBe(true);
  });

  it('skips missing source files referenced by registry and continues installing others', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');

    const existingSource = path.join(packageRoot, '.xtrm', 'skills', 'default', 'alpha', 'SKILL.md');
    await fs.ensureDir(path.dirname(existingSource));
    await fs.writeFile(existingSource, '# alpha\n', 'utf8');

    const registry = {
      version: '1.0.0',
      assets: {
        skills_default: {
          source_dir: '.xtrm/skills/default',
          install_mode: 'copy' as const,
          files: {
            'alpha/SKILL.md': { hash: 'alpha-hash', version: '1.0.0' },
            'documenting/tests/integration_test.sh': { hash: 'missing-hash', version: '1.0.0' },
          },
        },
      },
    };

    await fs.ensureDir(path.join(packageRoot, '.xtrm'));
    await fs.writeJson(path.join(packageRoot, '.xtrm', 'registry.json'), registry);

    const result = await installFromRegistry({
      packageRoot,
      registry,
      userXtrmDir,
      dryRun: false,
      force: true,
      yes: true,
    });

    expect(result.installed).toBe(1);
    expect(result.expectedInstalls).toBe(2);
    expect(result.missingSourceSkipped).toBe(1);
    expect(await fs.pathExists(path.join(userXtrmDir, 'skills', 'default', 'alpha', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(userXtrmDir, 'skills', 'default', 'documenting', 'tests', 'integration_test.sh'))).toBe(false);
  });

  it('fails in strict registry mode when a registry source file is missing', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');

    const existingSource = path.join(packageRoot, '.xtrm', 'skills', 'default', 'alpha', 'SKILL.md');
    await fs.ensureDir(path.dirname(existingSource));
    await fs.writeFile(existingSource, '# alpha\n', 'utf8');

    const registry = {
      version: '1.0.0',
      assets: {
        skills_default: {
          source_dir: '.xtrm/skills/default',
          install_mode: 'copy' as const,
          files: {
            'alpha/SKILL.md': { hash: 'alpha-hash', version: '1.0.0' },
            'documenting/tests/integration_test.sh': { hash: 'missing-hash', version: '1.0.0' },
          },
        },
      },
    };

    await fs.ensureDir(path.join(packageRoot, '.xtrm'));
    await fs.writeJson(path.join(packageRoot, '.xtrm', 'registry.json'), registry);

    await expect(installFromRegistry({
      packageRoot,
      registry,
      userXtrmDir,
      dryRun: false,
      force: true,
      yes: true,
      strictRegistry: true,
    })).rejects.toThrowError(/Registry\/source mismatch: missing package source files\./);
    await expect(fs.pathExists(path.join(userXtrmDir, 'skills', 'default', 'alpha', 'SKILL.md'))).resolves.toBe(true);
  });

  it('reads drifted override-root skills from global target paths', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const globalSkillsRoot = path.join(tempDir, 'global-skills');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const sourcePath = path.join(packageRoot, '.xtrm', 'skills', 'default', 'alpha', 'SKILL.md');
    const globalTargetPath = path.join(globalSkillsRoot, 'default', 'alpha', 'SKILL.md');
    await fs.ensureDir(path.dirname(sourcePath));
    await fs.ensureDir(path.dirname(globalTargetPath));
    await fs.writeFile(sourcePath, 'expected', 'utf8');
    await fs.writeFile(globalTargetPath, 'drifted', 'utf8');

    const registry = {
      version: '1.0.0',
      assets: {
        skills: {
          source_dir: '.xtrm/skills/default',
          install_mode: 'copy' as const,
          files: {
            'alpha/SKILL.md': { hash: await hashFile(sourcePath), version: '1.0.0' },
          },
        },
      },
    };

    await fs.ensureDir(path.join(packageRoot, '.xtrm'));
    await fs.writeJson(path.join(packageRoot, '.xtrm', 'registry.json'), registry);

    await installFromRegistry({
      packageRoot,
      registry,
      userXtrmDir,
      dryRun: false,
      force: false,
      yes: true,
      overrideRoots: {
        skills: path.join(globalSkillsRoot, 'default'),
      },
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('skills/default/alpha/SKILL.md'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('actual '));
    expect(await fs.readFile(globalTargetPath, 'utf8')).toBe('drifted');
    consoleSpy.mockRestore();
  });

  it('routes global-scope skills assets to override roots and logs skip event when XTRM_GLOBAL_SKILLS=1', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');
    const globalSkillsRoot = path.join(tempDir, 'global-skills');
    const previousHome = process.env.HOME;
    const previousFlag = process.env.XTRM_GLOBAL_SKILLS;

    process.env.HOME = tempDir;
    process.env.XTRM_GLOBAL_SKILLS = '1';

    try {
      const sourcePath = path.join(packageRoot, '.xtrm', 'skills', 'default', 'alpha', 'SKILL.md');
      await fs.ensureDir(path.dirname(sourcePath));
      await fs.writeFile(sourcePath, '# alpha\n', 'utf8');

      const registry = {
        version: '1.0.0',
        assets: {
          skills: {
            source_dir: '.xtrm/skills/default',
            install_mode: 'copy' as const,
            install_scope: 'global' as const,
            files: {
              'alpha/SKILL.md': { hash: await hashFile(sourcePath), version: '1.0.0' },
            },
          },
        },
      };

      await fs.ensureDir(path.join(packageRoot, '.xtrm'));
      await fs.writeJson(path.join(packageRoot, '.xtrm', 'registry.json'), registry);

      await installFromRegistry({
        packageRoot,
        registry,
        userXtrmDir,
        dryRun: false,
        force: true,
        yes: true,
        overrideRoots: {
          skills: path.join(globalSkillsRoot, 'default'),
        },
      });

      expect(await fs.pathExists(path.join(globalSkillsRoot, 'default', 'alpha', 'SKILL.md'))).toBe(true);
      expect(await fs.pathExists(path.join(userXtrmDir, 'skills', 'default', 'alpha', 'SKILL.md'))).toBe(false);
      const logPath = path.join(tempDir, '.xtrm', 'logs', 'skills-migration.jsonl');
      const logLines = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(logLines.some(line => line.event === 'install.skip.global-managed' && line.asset === 'skills' && line.count === 1)).toBe(true);
    } finally {
      process.env.HOME = previousHome;
      process.env.XTRM_GLOBAL_SKILLS = previousFlag;
    }
  });
});

describe('ensureUserAgentsSkillsSymlink', () => {
  const itIfSymlinkSupported = process.platform === 'win32' ? it.skip : it;

  itIfSymlinkSupported('wires home runtime pointers to the composed global per-runtime views', async () => {
    const tempHome = await createTempDir();
    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const globalDefaultRoot = path.join(tempHome, '.xtrm', 'skills', 'default');
      await writeSkill(globalDefaultRoot, 'alpha');

      await ensureUserAgentsSkillsSymlink();

      expect(await fs.readlink(path.join(tempHome, '.claude', 'skills'))).toBe(
        path.join(tempHome, '.xtrm', 'skills', 'active', 'claude'),
      );
      expect(await fs.readlink(path.join(tempHome, '.pi', 'agent', 'skills'))).toBe(
        path.join(tempHome, '.xtrm', 'skills', 'active', 'pi'),
      );
      // Default skills are composed into each view, not read through the pointer.
      expect(await fs.pathExists(path.join(tempHome, '.claude', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  itIfSymlinkSupported('refuses to replace existing real home Claude skills directory without force', async () => {
    const tempHome = await createTempDir();
    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const globalDefaultRoot = path.join(tempHome, '.xtrm', 'skills', 'default');
      const claudeSkillsDir = path.join(tempHome, '.claude', 'skills');
      await writeSkill(globalDefaultRoot, 'alpha');
      await fs.ensureDir(claudeSkillsDir);
      await fs.writeFile(path.join(claudeSkillsDir, 'foreign.txt'), 'foreign', 'utf8');

      await expect(ensureUserAgentsSkillsSymlink()).rejects.toThrowError(/Refusing to replace existing ~\/\.claude\/skills/);
      expect((await fs.lstat(claudeSkillsDir)).isSymbolicLink()).toBe(false);
    } finally {
      process.env.HOME = previousHome;
    }
  });
});

describe('ensureAgentsSkillsSymlink', () => {
  const itIfSymlinkSupported = process.platform === 'win32' ? it.skip : it;

  async function setupProjectPack(tempDir: string): Promise<string> {
    const skillsRoot = path.join(tempDir, '.xtrm', 'skills');
    const packRoot = path.join(skillsRoot, 'optional', 'pack-one');
    await fs.ensureDir(packRoot);
    await fs.writeJson(path.join(packRoot, 'PACK.json'), {
      schemaVersion: '1', name: 'pack-one', version: '1.0.0', description: 'pack', skills: ['beta'],
    });
    await writeSkill(packRoot, 'beta');
    await fs.writeJson(path.join(skillsRoot, 'state.json'), {
      schemaVersion: '1', enabledPacks: { claude: ['pack-one'], pi: ['pack-one'] },
    });
    return path.join(packRoot, 'beta');
  }

  itIfSymlinkSupported('reconciles direct Claude, Pi, and Codex skill links with managed manifest ownership', async () => {
    const tempDir = await createTempDir();
    const previousHome = process.env.HOME;
    process.env.HOME = path.join(tempDir, 'home');

    try {
      await writeSkill(path.join(process.env.HOME, '.xtrm', 'skills', 'default'), 'alpha');
      const betaRoot = await setupProjectPack(tempDir);

      const activation = await ensureAgentsSkillsSymlink(tempDir);

      expect(activation).toEqual({ activatedClaudeSkills: 1, activatedPiSkills: 1, activatedCodexSkills: 1 });
      for (const runtime of ['.claude', '.pi']) {
        const runtimeSkills = path.join(tempDir, runtime, 'skills');
        expect((await fs.lstat(runtimeSkills)).isDirectory()).toBe(true);
        expect((await fs.lstat(path.join(runtimeSkills, 'beta'))).isSymbolicLink()).toBe(true);
        expect(await fs.readlink(path.join(runtimeSkills, 'beta'))).toBe(betaRoot);
      }
      const codexSkills = path.join(tempDir, '.agents', 'skills');
      expect((await fs.lstat(codexSkills)).isDirectory()).toBe(true);
      expect((await fs.lstat(path.join(codexSkills, 'alpha'))).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(path.join(codexSkills, 'alpha'))).toBe(
        path.join(process.env.HOME, '.xtrm', 'skills', 'default', 'alpha'),
      );
      const state = await fs.readJson(path.join(tempDir, '.xtrm', 'skills', 'state.json'));
      expect(state.managedLinks).toEqual({
        claude: { beta: '.xtrm/skills/optional/pack-one/beta' },
        pi: { beta: '.xtrm/skills/optional/pack-one/beta' },
        codex: { alpha: path.relative(tempDir, path.join(process.env.HOME, '.xtrm', 'skills', 'default', 'alpha')) },
      });
      expect(await fs.pathExists(path.join(tempDir, '.xtrm', 'skills', 'active'))).toBe(false);
      expect(await fs.pathExists(path.join(tempDir, '.pi', 'settings.json'))).toBe(false);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  itIfSymlinkSupported('is idempotent without rebuilding retired active view', async () => {
    const tempDir = await createTempDir();
    const previousHome = process.env.HOME;
    process.env.HOME = path.join(tempDir, 'home');

    try {
      await writeSkill(path.join(process.env.HOME, '.xtrm', 'skills', 'default'), 'alpha');
      await setupProjectPack(tempDir);
      await ensureAgentsSkillsSymlink(tempDir);
      const claudeLink = path.join(tempDir, '.claude', 'skills', 'beta');
      const firstTarget = await fs.readlink(claudeLink);

      await ensureAgentsSkillsSymlink(tempDir);

      expect(await fs.readlink(claudeLink)).toBe(firstTarget);
      expect(await fs.pathExists(path.join(tempDir, '.xtrm', 'skills', 'active'))).toBe(false);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  itIfSymlinkSupported('rejects same-name user-owned direct runtime entry', async () => {
    const tempDir = await createTempDir();
    const previousHome = process.env.HOME;
    process.env.HOME = path.join(tempDir, 'home');

    try {
      await writeSkill(path.join(process.env.HOME, '.xtrm', 'skills', 'default'), 'alpha');
      await setupProjectPack(tempDir);
      const userOwned = path.join(tempDir, '.claude', 'skills', 'beta');
      await fs.ensureDir(path.dirname(userOwned));
      await fs.writeFile(userOwned, 'user', 'utf8');

      await expect(ensureAgentsSkillsSymlink(tempDir)).rejects.toThrowError(/is user-owned/);
      expect(await fs.readFile(userOwned, 'utf8')).toBe('user');
    } finally {
      process.env.HOME = previousHome;
    }
  });
});
