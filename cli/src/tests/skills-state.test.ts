import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultSkillsState,
  readSkillsState,
  setRuntimeEnabledPacks,
  writeSkillsState,
} from '../core/skills-state.js';

interface RuntimePackCase {
  name: string;
  apply: (skillsRoot: string) => Promise<void>;
  expectedClaude: string[];
  expectedPi: string[];
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function createTempSkillsRoot(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-skills-state-test-'));
  tempDirs.push(tempDir);
  return path.join(tempDir, '.xtrm', 'skills');
}

const runtimePackCases: RuntimePackCase[] = [
  {
    name: 'deduplicates and sorts enabled packs',
    apply: async (skillsRoot) => {
      await writeSkillsState(skillsRoot, {
        schemaVersion: '1',
        enabledPacks: {
          claude: ['zeta', 'alpha', 'alpha'],
          pi: ['pi-pack', 'pi-pack'],
        },
      });
    },
    expectedClaude: ['alpha', 'zeta'],
    expectedPi: ['pi-pack'],
  },
  {
    name: 'updates per-runtime enabled packs',
    apply: async (skillsRoot) => {
      await setRuntimeEnabledPacks(skillsRoot, 'claude', ['service', 'service', 'alpha']);
    },
    expectedClaude: ['alpha', 'service'],
    expectedPi: [],
  },
];

describe('skills-state', () => {
  it('initializes missing state.json with schemaVersion 1 and runtime enabledPacks', async () => {
    const skillsRoot = await createTempSkillsRoot();

    const state = await readSkillsState(skillsRoot);

    expect(state).toEqual(createDefaultSkillsState());
    expect(await fs.pathExists(path.join(skillsRoot, 'state.json'))).toBe(true);
    expect(await fs.pathExists(path.join(skillsRoot, 'active'))).toBe(true);
    expect(await fs.pathExists(path.join(skillsRoot, 'optional'))).toBe(true);
    expect(await fs.pathExists(path.join(skillsRoot, 'user', 'packs'))).toBe(true);
  });

  it.each(runtimePackCases)('$name', async ({ apply, expectedClaude, expectedPi }) => {
    const skillsRoot = await createTempSkillsRoot();

    await apply(skillsRoot);
    const state = await readSkillsState(skillsRoot);

    expect(state.enabledPacks.claude).toEqual(expectedClaude);
    expect(state.enabledPacks.pi).toEqual(expectedPi);
  });
});
