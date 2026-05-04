import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createDefaultSkillsState,
  readSkillsState,
  setRuntimeEnabledPacks,
  writeSkillsState,
} from '../src/core/skills-state.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(tempDir => rm(tempDir, { recursive: true, force: true })));
});

async function createTempSkillsRoot(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-skills-state-test-'));
  tempDirs.push(tempDir);
  return path.join(tempDir, '.xtrm', 'skills');
}

function normalize(packNames: readonly string[]): string[] {
  return [...new Set(packNames)].sort((a, b) => a.localeCompare(b));
}

const packNameArbitrary = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,10}$/)
  .filter(value => value.length > 0);

describe('skills-state', () => {
  it('initializes missing state.json with canonical defaults', async () => {
    const skillsRoot = await createTempSkillsRoot();

    const state = await readSkillsState(skillsRoot);

    expect(state).toEqual(createDefaultSkillsState());
    expect(await fs.pathExists(path.join(skillsRoot, 'state.json'))).toBe(true);
    expect(await fs.pathExists(path.join(skillsRoot, 'default'))).toBe(true);
    expect(await fs.pathExists(path.join(skillsRoot, 'optional'))).toBe(true);
    expect(await fs.pathExists(path.join(skillsRoot, 'user', 'packs'))).toBe(true);
    expect(await fs.pathExists(path.join(skillsRoot, 'active'))).toBe(true);
  });

  it('handles the all pack token as a normal normalized pack name', async () => {
    const skillsRoot = await createTempSkillsRoot();

    await setRuntimeEnabledPacks(skillsRoot, 'claude', ['zeta', 'all', 'all', 'alpha']);

    const state = await readSkillsState(skillsRoot);

    expect(state.enabledPacks.claude).toEqual(['all', 'alpha', 'zeta']);
    expect(state.enabledPacks.pi).toEqual([]);
  });

  it('normalizes enabled packs deterministically regardless of input order (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(packNameArbitrary, { minLength: 0, maxLength: 20 }), async packNames => {
        const skillsRoot = await createTempSkillsRoot();

        const shuffled = [...packNames].reverse();
        await writeSkillsState(skillsRoot, {
          schemaVersion: '1',
          enabledPacks: {
            claude: packNames,
            pi: shuffled,
          },
        });

        const state = await readSkillsState(skillsRoot);

        expect(state.enabledPacks.claude).toEqual(normalize(packNames));
        expect(state.enabledPacks.pi).toEqual(normalize(packNames));
      }),
      { numRuns: 50 },
    );
  });
});
