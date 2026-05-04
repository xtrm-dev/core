import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureAgentsSkillsSymlink } from '../src/core/skills-scaffold.js';

const tempDirs: string[] = [];
const REPO_ROOT = path.resolve(__dirname, '../..');
const REPO_SKILLS_ROOT = path.join(REPO_ROOT, '.xtrm', 'skills');
const SYMLINK_UNSUPPORTED = process.platform === 'win32';

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await fs.remove(tempDir);
  }
});

async function createTempProjectRoot(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-skills-scaffold-test-'));
  tempDirs.push(projectRoot);
  return projectRoot;
}

describe.skipIf(SYMLINK_UNSUPPORTED)('skills scaffold migration guard', () => {
  it('refuses real .claude/skills dir with foreign file', async () => {
    const projectRoot = await createTempProjectRoot();
    const projectSkillsRoot = path.join(projectRoot, '.xtrm', 'skills');

    await fs.copy(REPO_SKILLS_ROOT, projectSkillsRoot);
    await ensureAgentsSkillsSymlink(projectRoot);

    const skillsPath = path.join(projectRoot, '.claude', 'skills');
    await fs.remove(skillsPath);
    await fs.ensureDir(skillsPath);
    await fs.writeFile(path.join(skillsPath, 'foreign.txt'), 'local content', 'utf8');

    await expect(ensureAgentsSkillsSymlink(projectRoot)).rejects.toThrow(/docs\/cat-b-distribution\.md/);
    expect((await fs.readdir(path.join(projectRoot, '.claude'))).some(name => name.startsWith('skills.bak-'))).toBe(false);
  });

  it('backs up foreign content when forced', async () => {
    const projectRoot = await createTempProjectRoot();
    const projectSkillsRoot = path.join(projectRoot, '.xtrm', 'skills');

    await fs.copy(REPO_SKILLS_ROOT, projectSkillsRoot);
    await ensureAgentsSkillsSymlink(projectRoot);

    const skillsPath = path.join(projectRoot, '.claude', 'skills');
    await fs.remove(skillsPath);
    await fs.ensureDir(path.join(skillsPath, 'foo'));
    await fs.writeFile(path.join(skillsPath, 'foo', 'SKILL.md'), '# foo', 'utf8');

    await ensureAgentsSkillsSymlink(projectRoot, { force: true });

    const backups = (await fs.readdir(path.join(projectRoot, '.claude'))).filter(name => name.startsWith('skills.bak-'));
    expect(backups.length).toBe(1);
    expect(await fs.pathExists(path.join(projectRoot, '.claude', backups[0], 'foo', 'SKILL.md'))).toBe(true);
  });

  it('leaves correct symlink untouched', async () => {
    const projectRoot = await createTempProjectRoot();
    const projectSkillsRoot = path.join(projectRoot, '.xtrm', 'skills');

    await fs.copy(REPO_SKILLS_ROOT, projectSkillsRoot);
    await ensureAgentsSkillsSymlink(projectRoot);

    const skillsPath = path.join(projectRoot, '.claude', 'skills');
    const before = await fs.readlink(skillsPath);

    await ensureAgentsSkillsSymlink(projectRoot);

    expect((await fs.lstat(skillsPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(skillsPath)).toBe(before);
    expect((await fs.readdir(path.join(projectRoot, '.claude'))).some(name => name.startsWith('skills.bak-'))).toBe(false);
  });
});
