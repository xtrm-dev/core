import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureAgentsSkillsSymlink } from '../src/core/skills-scaffold.js';
import { checkRuntimeSkillsViews, assertRuntimeSkillsViews } from '../src/core/skills-runtime-views.js';

const tempDirs: string[] = [];

const SYMLINK_UNSUPPORTED = process.platform === 'win32';

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await fs.remove(tempDir);
  }
});

async function createTempProjectRoot(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-runtime-sync-test-'));
  tempDirs.push(projectRoot);
  return projectRoot;
}

async function writeSkill(parentRoot: string, skillName: string): Promise<void> {
  const skillRoot = path.join(parentRoot, skillName);
  await fs.ensureDir(skillRoot);
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), `# ${skillName}\n`, 'utf8');
}

async function writePack(
  skillsRoot: string,
  tier: 'optional' | 'user',
  packName: string,
  skillNames: readonly string[],
): Promise<void> {
  const packRoot = tier === 'optional'
    ? path.join(skillsRoot, 'optional', packName)
    : path.join(skillsRoot, 'user', 'packs', packName);

  await fs.ensureDir(packRoot);
  await fs.writeJson(path.join(packRoot, 'PACK.json'), {
    schemaVersion: '1',
    name: packName,
    version: '1.0.0',
    description: `${packName} pack`,
    skills: [...skillNames],
  });

  for (const skillName of skillNames) {
    await writeSkill(packRoot, skillName);
  }
}

async function writeState(skillsRoot: string, claudePacks: readonly string[], piPacks: readonly string[]): Promise<void> {
  await fs.ensureDir(skillsRoot);
  await fs.writeJson(path.join(skillsRoot, 'state.json'), {
    schemaVersion: '1',
    enabledPacks: {
      claude: [...claudePacks],
      pi: [...piPacks],
    },
  });
}

describe.skipIf(SYMLINK_UNSUPPORTED)('skills runtime sync filesystem contract', () => {
  it('materializes active runtime trees as direct child symlinks with valid relative targets', async () => {
    const projectRoot = await createTempProjectRoot();
    const skillsRoot = path.join(projectRoot, '.xtrm', 'skills');

    await writeSkill(path.join(skillsRoot, 'default'), 'alpha');
    await writeSkill(path.join(skillsRoot, 'default'), 'beta');
    await writePack(skillsRoot, 'optional', 'pack-claude', ['gamma']);
    await writePack(skillsRoot, 'user', 'pack-shared', ['delta']);
    await writeState(skillsRoot, ['pack-claude', 'pack-shared'], ['pack-shared']);

    await ensureAgentsSkillsSymlink(projectRoot);
    await fs.ensureDir(path.join(projectRoot, '.pi'));
    await fs.writeJson(path.join(projectRoot, '.pi', 'settings.json'), {
      skills: ['../.xtrm/skills/active'],
    });

    const activeView = path.join(skillsRoot, 'active');

    expect((await fs.readdir(activeView)).sort()).toEqual(['alpha', 'beta', 'delta', 'gamma']);

    for (const runtimeView of [activeView]) {
      const entries = await fs.readdir(runtimeView);
      for (const entryName of entries) {
        const entryPath = path.join(runtimeView, entryName);
        const stat = await fs.lstat(entryPath);
        expect(stat.isSymbolicLink()).toBe(true);

        const target = await fs.readlink(entryPath);
        expect(path.isAbsolute(target)).toBe(false);

        const resolvedTarget = path.resolve(path.dirname(entryPath), target);
        expect(await fs.pathExists(resolvedTarget)).toBe(true);
        expect(await fs.pathExists(path.join(resolvedTarget, 'SKILL.md'))).toBe(true);
      }
    }

    const check = await checkRuntimeSkillsViews(projectRoot);
    expect(check.activeReady).toBe(true);
    expect(check.claudePointerReady).toBe(true);
    expect(check.piPointerReady).toBe(true);
  });

  it('aborts before swapping active view when runtime collisions are detected', async () => {
    const projectRoot = await createTempProjectRoot();
    const skillsRoot = path.join(projectRoot, '.xtrm', 'skills');
    const activeRoot = path.join(skillsRoot, 'active');

    await writeSkill(path.join(skillsRoot, 'default'), 'alpha');
    await writePack(skillsRoot, 'optional', 'dup-pack', ['alpha']);
    await writeState(skillsRoot, ['dup-pack'], []);

    await fs.ensureDir(activeRoot);
    await fs.writeFile(path.join(activeRoot, 'sentinel.txt'), 'keep', 'utf8');

    await expect(ensureAgentsSkillsSymlink(projectRoot)).rejects.toThrow(/Duplicate skill name 'alpha'/);
    expect(await fs.readFile(path.join(activeRoot, 'sentinel.txt'), 'utf8')).toBe('keep');

    const activeRootEntries = await fs.readdir(path.join(skillsRoot, 'active'));
    expect(activeRootEntries.some(name => name.includes('.tmp-'))).toBe(false);
    expect(activeRootEntries.some(name => name.includes('.bak-'))).toBe(false);
  });

  it('handles malformed runtime pointer/settings checks with clear failures', async () => {
    const projectRoot = await createTempProjectRoot();
    const skillsRoot = path.join(projectRoot, '.xtrm', 'skills');

    await writeSkill(path.join(skillsRoot, 'default'), 'alpha');
    await writeState(skillsRoot, [], []);
    await ensureAgentsSkillsSymlink(projectRoot);

    await fs.ensureDir(path.join(projectRoot, '.pi'));
    await fs.writeFile(path.join(projectRoot, '.pi', 'settings.json'), '{ malformed', 'utf8');

    const check = await checkRuntimeSkillsViews(projectRoot);
    expect(check.activeReady).toBe(true);
    expect(check.piPointerReady).toBe(false);

    await expect(assertRuntimeSkillsViews(projectRoot)).rejects.toThrow(
      /\.pi\/settings\.json\.skills does not include \.\.\/\.xtrm\/skills\/active/,
    );
  });

  it('throws clear errors for malformed state.json during rebuild', async () => {
    const projectRoot = await createTempProjectRoot();
    const skillsRoot = path.join(projectRoot, '.xtrm', 'skills');

    await writeSkill(path.join(skillsRoot, 'default'), 'alpha');
    await fs.writeFile(path.join(skillsRoot, 'state.json'), '{not-json', 'utf8');

    await expect(ensureAgentsSkillsSymlink(projectRoot)).rejects.toThrow();
  });
});
