import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installGitHooks,
  installSettings,
  installSkills,
} from '../src/commands/install-service-skills.js';
import { runInitVerification } from '../src/core/init-verification.js';
import { ensureAgentsSkillsSymlink } from '../src/core/skills-scaffold.js';

const tempDirs: string[] = [];

const REPO_ROOT = path.resolve(__dirname, '../..');
const REPO_SKILLS_ROOT = path.join(REPO_ROOT, '.xtrm', 'skills');
const SERVICE_SKILLS_ASSETS_ROOT = path.join(REPO_SKILLS_ROOT, 'default', 'service-skills-set');

const SYMLINK_UNSUPPORTED = process.platform === 'win32';

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await fs.remove(tempDir);
  }
});

async function createTempProjectRoot(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-skills-migration-test-'));
  tempDirs.push(projectRoot);
  return projectRoot;
}

describe.skipIf(SYMLINK_UNSUPPORTED)('skills migration boundary contracts', () => {
  it('keeps service-skill trinity reachable through .claude/skills active view', async () => {
    const projectRoot = await createTempProjectRoot();
    const projectSkillsRoot = path.join(projectRoot, '.xtrm', 'skills');

    await fs.copy(REPO_SKILLS_ROOT, projectSkillsRoot);
    await ensureAgentsSkillsSymlink(projectRoot);

    const result = await installSkills(projectRoot, projectSkillsRoot);
    expect(result.length).toBeGreaterThan(0);

    for (const entry of result) {
      expect(entry.status).toBe('active');
      expect(await fs.pathExists(path.join(projectRoot, '.claude', 'skills', entry.skill, 'SKILL.md'))).toBe(true);
    }
  });

  it('fails clearly when active view misses a required trinity skill', async () => {
    const projectRoot = await createTempProjectRoot();
    const projectSkillsRoot = path.join(projectRoot, '.xtrm', 'skills');

    await fs.copy(REPO_SKILLS_ROOT, projectSkillsRoot);
    await ensureAgentsSkillsSymlink(projectRoot);

    await fs.remove(path.join(projectRoot, '.claude', 'skills', 'using-service-skills'));
    await expect(installSkills(projectRoot, projectSkillsRoot)).rejects.toThrow(/using-service-skills/);
  });

  it('init verification reports runtime readiness and deprecated .agents/skills as warning-only signal', async () => {
    const projectRoot = await createTempProjectRoot();
    const projectSkillsRoot = path.join(projectRoot, '.xtrm', 'skills');

    await fs.copy(REPO_SKILLS_ROOT, projectSkillsRoot);
    await ensureAgentsSkillsSymlink(projectRoot);

    await fs.ensureDir(path.join(projectRoot, '.pi'));
    await fs.writeJson(path.join(projectRoot, '.pi', 'settings.json'), {
      skills: ['../.xtrm/skills/active'],
    });

    await fs.ensureDir(path.join(projectRoot, '.agents', 'skills'));

    const verification = await runInitVerification(projectRoot);
    expect(verification.skillsRuntime.activeReady).toBe(true);
    expect(verification.skillsRuntime.claudePointerReady).toBe(true);
    expect(verification.skillsRuntime.piPointerReady).toBe(true);
    expect(verification.skillsRuntime.hasDeprecatedAgentsSkillsPath).toBe(true);
  });

  it('hook and settings installers recover from malformed settings and keep flattened assets contract', async () => {
    const projectRoot = await createTempProjectRoot();

    await fs.ensureDir(path.join(projectRoot, '.claude'));
    await fs.writeFile(path.join(projectRoot, '.claude', 'settings.json'), '{ bad-json', 'utf8');

    const settingsResult = await installSettings(projectRoot);
    expect(settingsResult.added.length).toBeGreaterThan(0);

    const settings = await fs.readJson(path.join(projectRoot, '.claude', 'settings.json')) as {
      hooks?: Record<string, unknown>;
    };
    expect(settings.hooks).toBeTruthy();

    await installGitHooks(projectRoot, SERVICE_SKILLS_ASSETS_ROOT);

    const preCommit = await fs.readFile(path.join(projectRoot, '.githooks', 'pre-commit'), 'utf8');
    const prePush = await fs.readFile(path.join(projectRoot, '.githooks', 'pre-push'), 'utf8');

    expect(preCommit).toContain('.claude/git-hooks/doc_reminder.py');
    expect(prePush).toContain('.claude/git-hooks/skill_staleness.py');
    expect(await fs.pathExists(path.join(projectRoot, '.claude', 'git-hooks', 'doc_reminder.py'))).toBe(true);
    expect(await fs.pathExists(path.join(projectRoot, '.claude', 'git-hooks', 'skill_staleness.py'))).toBe(true);
  });
});
