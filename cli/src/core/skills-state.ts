import fs from 'fs-extra';
import { z } from 'zod';
import {
  SKILLS_STATE_SCHEMA_VERSION,
  type SkillsRuntime,
  resolveActiveRuntimeRoot,
  resolveDefaultTierRoot,
  resolveOptionalTierRoot,
  resolveStateFilePath,
  resolveUserPacksRoot,
} from './skills-layout.js';

const runtimeEnabledPacksSchema = z.strictObject({
  claude: z.array(z.string().min(1, { error: 'Pack name cannot be empty' }), {
    error: 'Claude enabled packs must be an array of strings',
  }).default([]),
  pi: z.array(z.string().min(1, { error: 'Pack name cannot be empty' }), {
    error: 'Pi enabled packs must be an array of strings',
  }).default([]),
});

const skillsStateSchema = z.strictObject({
  schemaVersion: z.literal(SKILLS_STATE_SCHEMA_VERSION, {
    error: `skills state schemaVersion must be ${SKILLS_STATE_SCHEMA_VERSION}`,
  }),
  enabledPacks: runtimeEnabledPacksSchema,
});

export type SkillsState = z.infer<typeof skillsStateSchema>;

function normalizePackList(packNames: readonly string[]): string[] {
  return [...new Set(packNames)].sort((a, b) => a.localeCompare(b));
}

function normalizeState(state: SkillsState): SkillsState {
  return {
    schemaVersion: SKILLS_STATE_SCHEMA_VERSION,
    enabledPacks: {
      claude: normalizePackList(state.enabledPacks.claude),
      pi: normalizePackList(state.enabledPacks.pi),
    },
  };
}

export function createDefaultSkillsState(): SkillsState {
  return {
    schemaVersion: SKILLS_STATE_SCHEMA_VERSION,
    enabledPacks: {
      claude: [],
      pi: [],
    },
  };
}

export async function ensureSkillsTreeStructure(skillsRoot: string): Promise<void> {
  await fs.ensureDir(resolveDefaultTierRoot(skillsRoot));
  await fs.ensureDir(resolveOptionalTierRoot(skillsRoot));
  await fs.ensureDir(resolveUserPacksRoot(skillsRoot));

  await fs.ensureDir(resolveActiveRuntimeRoot(skillsRoot));
}

export async function writeSkillsState(skillsRoot: string, state: SkillsState): Promise<SkillsState> {
  await ensureSkillsTreeStructure(skillsRoot);

  const validatedState = normalizeState(skillsStateSchema.parse(state));
  const statePath = resolveStateFilePath(skillsRoot);

  await fs.writeJson(statePath, validatedState, { spaces: 2 });
  await fs.appendFile(statePath, '\n');

  return validatedState;
}

export async function readSkillsState(skillsRoot: string): Promise<SkillsState> {
  await ensureSkillsTreeStructure(skillsRoot);

  const statePath = resolveStateFilePath(skillsRoot);
  if (!await fs.pathExists(statePath)) {
    return writeSkillsState(skillsRoot, createDefaultSkillsState());
  }

  const parsedState = skillsStateSchema.parse(await fs.readJson(statePath));
  return normalizeState(parsedState);
}

export async function setRuntimeEnabledPacks(
  skillsRoot: string,
  runtime: SkillsRuntime,
  packNames: readonly string[],
): Promise<SkillsState> {
  const currentState = await readSkillsState(skillsRoot);

  const nextState: SkillsState = {
    ...currentState,
    enabledPacks: {
      ...currentState.enabledPacks,
      [runtime]: normalizePackList(packNames),
    },
  };

  return writeSkillsState(skillsRoot, nextState);
}
