import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installFromRegistry,
  isSkillsDefaultPath,
  isUserOwnedPath,
  scaffoldSkillsDefaultFromPackage,
  stripXtrmPrefix,
  toPosix,
  toUserRelativePath,
} from '../core/registry-scaffold.js';
import { ensureAgentsSkillsSymlink } from '../core/skills-scaffold.js';

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

  it('isUserOwnedPath matches .xtrm/memory.md', () => {
    expect(isUserOwnedPath('memory.md')).toBe(true);
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
});

describe('installFromRegistry', () => {
  it('never installs user-owned paths from registry assets', async () => {
    const tempDir = await createTempDir();
    const packageRoot = path.join(tempDir, 'pkg');
    const userXtrmDir = path.join(tempDir, 'user-xtrm');

    const memorySource = path.join(packageRoot, '.xtrm', 'memory.md');
    const hookSource = path.join(packageRoot, '.xtrm', 'hooks', 'post-tool-use.mjs');

    await fs.ensureDir(path.dirname(memorySource));
    await fs.ensureDir(path.dirname(hookSource));
    await fs.writeFile(memorySource, 'generated memory\n', 'utf8');
    await fs.writeFile(hookSource, 'export default {}\n', 'utf8');

    const registry = {
      version: '1.0.0',
      assets: {
        core: {
          source_dir: '.xtrm',
          install_mode: 'copy' as const,
          files: {
            'memory.md': { hash: 'memory-hash', version: '1.0.0' },
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
    expect(await fs.pathExists(path.join(userXtrmDir, 'memory.md'))).toBe(false);
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
});

describe('ensureAgentsSkillsSymlink', () => {
  const itIfSymlinkSupported = process.platform === 'win32' ? it.skip : it;

  async function writeSkill(root: string, name: string): Promise<void> {
    const skillRoot = path.join(root, name);
    await fs.ensureDir(skillRoot);
    await fs.writeFile(path.join(skillRoot, 'SKILL.md'), `# ${name}\n`, 'utf8');
  }

  itIfSymlinkSupported('rebuilds active view and points .claude/skills at active', async () => {
    const tempDir = await createTempDir();
    const skillsRoot = path.join(tempDir, '.xtrm', 'skills');

    await writeSkill(path.join(skillsRoot, 'default'), 'alpha');
    await fs.ensureDir(path.join(skillsRoot, 'optional', 'pack-one'));
    await fs.writeJson(path.join(skillsRoot, 'optional', 'pack-one', 'PACK.json'), {
      schemaVersion: '1',
      name: 'pack-one',
      version: '1.0.0',
      description: 'pack',
      skills: ['beta'],
    });
    await writeSkill(path.join(skillsRoot, 'optional', 'pack-one'), 'beta');
    await fs.writeJson(path.join(skillsRoot, 'state.json'), {
      schemaVersion: '1',
      enabledPacks: { claude: ['pack-one'], pi: [] },
    });

    const activation = await ensureAgentsSkillsSymlink(tempDir);

    const claudeLink = path.join(tempDir, '.claude', 'skills');
    const activeClaude = path.join(skillsRoot, 'active');

    expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(claudeLink)).toBe(path.join('..', '.xtrm', 'skills', 'active'));

    const activeEntries = (await fs.readdir(activeClaude)).sort();
    expect(activeEntries).toEqual(['alpha', 'beta']);

    expect(activation).toEqual({
      activatedClaudeSkills: 2,
      activatedPiSkills: 2,
    });
    expect((await fs.lstat(path.join(activeClaude, 'alpha'))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(activeClaude, 'beta'))).isSymbolicLink()).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.agents', 'skills'))).toBe(false);
  });

  it('skips when .xtrm/skills/default does not exist', async () => {
    const tempDir = await createTempDir();

    const activation = await ensureAgentsSkillsSymlink(tempDir);

    expect(await fs.pathExists(path.join(tempDir, '.claude', 'skills'))).toBe(false);
    expect(activation).toEqual({
      activatedClaudeSkills: 0,
      activatedPiSkills: 0,
    });
  });

  itIfSymlinkSupported('is idempotent and logs already in place on second call', async () => {
    const tempDir = await createTempDir();
    const defaultRoot = path.join(tempDir, '.xtrm', 'skills', 'default');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await writeSkill(defaultRoot, 'alpha');

    await ensureAgentsSkillsSymlink(tempDir);
    logSpy.mockClear();
    await ensureAgentsSkillsSymlink(tempDir);

    const messages = logSpy.mock.calls.map(([message]) => String(message));
    expect(messages.some(message => message.includes('.claude/skills symlink already in place'))).toBe(true);
  });

  itIfSymlinkSupported('replaces existing real .claude/skills directory', async () => {
    const tempDir = await createTempDir();
    const defaultRoot = path.join(tempDir, '.xtrm', 'skills', 'default');
    const claudeSkillsDir = path.join(tempDir, '.claude', 'skills');

    await writeSkill(defaultRoot, 'alpha');
    await fs.ensureDir(claudeSkillsDir);
    await fs.writeFile(path.join(claudeSkillsDir, 'local.txt'), 'local', 'utf8');

    await ensureAgentsSkillsSymlink(tempDir);

    expect((await fs.lstat(claudeSkillsDir)).isSymbolicLink()).toBe(true);
    expect(await fs.pathExists(path.join(claudeSkillsDir, 'local.txt'))).toBe(false);
  });

  itIfSymlinkSupported('evicts non-symlink entries from active during rebuild', async () => {
    const tempDir = await createTempDir();
    const skillsRoot = path.join(tempDir, '.xtrm', 'skills');
    const activeClaudeRoot = path.join(skillsRoot, 'active');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await writeSkill(path.join(skillsRoot, 'default'), 'alpha');
    await fs.ensureDir(path.join(activeClaudeRoot, 'corrupt-dir'));
    await fs.writeFile(path.join(activeClaudeRoot, 'corrupt-dir', 'junk.txt'), 'junk', 'utf8');

    await ensureAgentsSkillsSymlink(tempDir);

    const activeEntries = (await fs.readdir(activeClaudeRoot)).sort();
    expect(activeEntries).toEqual(['alpha']);
    expect((await fs.lstat(path.join(activeClaudeRoot, 'alpha'))).isSymbolicLink()).toBe(true);

    const messages = logSpy.mock.calls.map(([message]) => String(message));
    expect(messages.some(message => message.includes('contains non-symlink entries (corrupt-dir)'))).toBe(true);
  });
});
