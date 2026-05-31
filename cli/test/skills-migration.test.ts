import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInitVerification } from '../src/core/init-verification.js';
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
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-skills-migration-test-'));
  tempDirs.push(projectRoot);
  return projectRoot;
}

// NOTE: the pre-v2 "trinity reachability" + settings.json hook-installer tests were
// removed with service-skills v2 — the 4 trinity skills were consolidated into one
// `service-skills` skill, Claude hooks now ship via the global service-skills policy
// (not a per-repo settings.json writer), and the service-skills-set bundle is gone.
describe.skipIf(SYMLINK_UNSUPPORTED)('skills migration boundary contracts', () => {
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
});
