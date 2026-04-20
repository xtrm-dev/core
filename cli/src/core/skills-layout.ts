import path from 'node:path';

export const SKILLS_STATE_SCHEMA_VERSION = '1' as const;

export const SKILLS_RUNTIMES = ['claude', 'pi'] as const;
export type SkillsRuntime = typeof SKILLS_RUNTIMES[number];

export const SKILLS_TIERS = ['default', 'optional', 'user'] as const;
export type SkillsTier = typeof SKILLS_TIERS[number];

export const RUNTIME_ROOT_MARKERS = ['.claude', '.agents', '.pi'] as const;

export const SKILL_FILE_NAME = 'SKILL.md';
export const PACK_FILE_NAME = 'PACK.json';

export const STATE_FILE_NAME = 'state.json';

export function resolveSkillsRoot(scopeRoot: string): string {
  return path.join(scopeRoot, '.xtrm', 'skills');
}

export function resolveDefaultTierRoot(skillsRoot: string): string {
  return path.join(skillsRoot, 'default');
}

export function resolveOptionalTierRoot(skillsRoot: string): string {
  return path.join(skillsRoot, 'optional');
}

export function resolveUserPacksRoot(skillsRoot: string): string {
  return path.join(skillsRoot, 'user', 'packs');
}

export function resolveActiveRuntimeRoot(skillsRoot: string, _runtime: SkillsRuntime): string {
  return path.join(skillsRoot, 'active');
}

export function resolveStateFilePath(skillsRoot: string): string {
  return path.join(skillsRoot, STATE_FILE_NAME);
}
