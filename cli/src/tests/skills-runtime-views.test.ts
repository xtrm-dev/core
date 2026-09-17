import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertRuntimeSkillsViews, checkRuntimeSkillsViews, getRuntimePointerTarget } from '../core/skills-runtime-views.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.remove(tempDirs.pop() as string);
  }
});

async function createTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-runtime-view-test-'));
  tempDirs.push(tempDir);
  return tempDir;
}

describe('skills-runtime-views', () => {
  it('describes project runtime directories rather than an active pointer', () => {
    expect(getRuntimePointerTarget({ scope: 'project' })).toBe('real .claude/skills, .pi/skills, and .agents/skills directories');
  });

  it('targets the composed global per-runtime view rather than the raw default tier', () => {
    expect(getRuntimePointerTarget({ scope: 'global' })).toBe(path.join(os.homedir(), '.xtrm', 'skills', 'active', '<runtime>'));
  });

  it('accepts direct Claude, Pi, and Codex runtime directories with manifest-owned links and no Pi settings file', async () => {
    const tempHome = await createTempDir();
    const projectRoot = await createTempDir();
    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const globalDefaultRoot = path.join(tempHome, '.xtrm', 'skills', 'default');
      const localSkillRoot = path.join(projectRoot, '.xtrm', 'skills', 'local', 'local-skill');
      await fs.ensureDir(globalDefaultRoot);
      await fs.ensureDir(localSkillRoot);
      await fs.writeFile(path.join(globalDefaultRoot, 'SKILL.md'), '# global\n', 'utf8');
      await fs.writeFile(path.join(localSkillRoot, 'SKILL.md'), '# local\n', 'utf8');
      await fs.ensureDir(path.join(tempHome, '.claude'));
      await fs.symlink(globalDefaultRoot, path.join(tempHome, '.claude', 'skills'));
      await fs.ensureDir(path.join(tempHome, '.pi', 'agent'));
      await fs.symlink(globalDefaultRoot, path.join(tempHome, '.pi', 'agent', 'skills'));

      for (const runtime of ['claude', 'pi', 'codex'] as const) {
        const runtimeSkills = path.join(projectRoot, runtime === 'claude' ? '.claude' : runtime === 'pi' ? '.pi' : '.agents', 'skills');
        await fs.ensureDir(runtimeSkills);
        await fs.symlink(localSkillRoot, path.join(runtimeSkills, 'local-skill'));
      }
      await fs.writeJson(path.join(projectRoot, '.xtrm', 'skills', 'state.json'), {
        schemaVersion: '2',
        enabledPacks: { claude: ['local'], pi: ['local'], codex: ['local'] },
        managedLinks: {
          claude: { 'local-skill': '.xtrm/skills/local/local-skill' },
          pi: { 'local-skill': '.xtrm/skills/local/local-skill' },
          codex: { 'local-skill': '.xtrm/skills/local/local-skill' },
        },
      });

      await expect(assertRuntimeSkillsViews(projectRoot, { scope: 'both' })).resolves.toBeUndefined();
      expect(await fs.pathExists(path.join(projectRoot, '.pi', 'settings.json'))).toBe(false);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it('requires each managed runtime link to match manifest target and exist', async () => {
    const tempHome = await createTempDir();
    const projectRoot = await createTempDir();
    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      const skillsRoot = path.join(projectRoot, '.xtrm', 'skills');
      const manifestTarget = path.join(skillsRoot, 'local', 'local-skill');
      const wrongTarget = path.join(skillsRoot, 'other-skill');
      const runtimeLink = path.join(projectRoot, '.claude', 'skills', 'local-skill');
      await fs.ensureDir(manifestTarget);
      await fs.ensureDir(wrongTarget);
      await fs.ensureDir(path.dirname(runtimeLink));
      await fs.symlink(wrongTarget, runtimeLink);
      await fs.writeJson(path.join(skillsRoot, 'state.json'), {
        schemaVersion: '2',
        enabledPacks: { claude: ['local'], pi: [] },
        managedLinks: { claude: { 'local-skill': '.xtrm/skills/local/local-skill' }, pi: {} },
      });

      const wrongTargetCheck = await checkRuntimeSkillsViews(projectRoot);
      expect(wrongTargetCheck.projectClaudeSkillsReady).toBe(false);

      await fs.remove(runtimeLink);
      const missingLinkCheck = await checkRuntimeSkillsViews(projectRoot);
      expect(missingLinkCheck.projectClaudeSkillsReady).toBe(false);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it('reports global pack activation drift and clears it after materialization', async () => {
    const tempHome = await createTempDir();
    const previousHome = process.env.HOME;
    process.env.HOME = tempHome;

    try {
      const skillsRoot = path.join(tempHome, '.xtrm', 'skills');
      const defaultSkill = path.join(skillsRoot, 'default', 'always-on');
      await fs.ensureDir(defaultSkill);
      await fs.writeFile(path.join(defaultSkill, 'SKILL.md'), '# always-on\n', 'utf8');

      const packRoot = path.join(skillsRoot, 'optional', 'shipped-pack');
      await fs.ensureDir(path.join(packRoot, 'shipped-skill'));
      await fs.writeFile(path.join(packRoot, 'shipped-skill', 'SKILL.md'), '# shipped\n', 'utf8');
      await fs.writeJson(path.join(packRoot, 'PACK.json'), {
        schemaVersion: '1',
        name: 'shipped-pack',
        version: '1.0.0',
        description: 'shipped',
        skills: ['shipped-skill'],
      });

      await fs.writeJson(path.join(skillsRoot, 'state.json'), {
        schemaVersion: '2',
        enabledPacks: { claude: ['shipped-pack'], pi: [], codex: [] },
        managedLinks: { claude: {}, pi: {}, codex: {} },
      });

      // State says the pack is enabled but no runtime view exists yet.
      const drifted = await checkRuntimeSkillsViews(tempHome);
      expect(drifted.globalActivationReady).toBe(false);

      const { materializeGlobalRuntimeViews } = await import('../core/skills-materializer.js');
      await materializeGlobalRuntimeViews();

      const healed = await checkRuntimeSkillsViews(tempHome);
      expect(healed.globalActivationReady).toBe(true);
      // Per-runtime scoping: the pack is materialized for claude only.
      expect(await fs.pathExists(path.join(skillsRoot, 'active', 'claude', 'shipped-skill', 'SKILL.md'))).toBe(true);
      expect(await fs.pathExists(path.join(skillsRoot, 'active', 'pi', 'shipped-skill'))).toBe(false);
      expect(await fs.pathExists(path.join(skillsRoot, 'active', 'pi', 'always-on', 'SKILL.md'))).toBe(true);
    } finally {
      process.env.HOME = previousHome;
    }
  });
});
