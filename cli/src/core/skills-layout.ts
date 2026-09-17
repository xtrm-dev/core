import os from 'node:os';
import path from 'node:path';

export const SKILLS_STATE_SCHEMA_VERSION = '2' as const;

export const SKILLS_RUNTIMES = ['claude', 'pi', 'codex'] as const;
export type SkillsRuntime = typeof SKILLS_RUNTIMES[number];

export const SKILLS_TIERS = ['default', 'optional', 'user'] as const;
export type SkillsTier = typeof SKILLS_TIERS[number];

export const RUNTIME_ROOT_MARKERS = ['.claude', '.agents', '.pi'] as const;

export const SKILL_FILE_NAME = 'SKILL.md';
export const PACK_FILE_NAME = 'PACK.json';
/** Reserved top-level names during v1 shim window. */
export const RESERVED_PACK_NAMES = new Set([
  'default',
  'optional',
  'user',
  'active',
  'local-legacy',
]);

export const STATE_FILE_NAME = 'state.json';

export function resolveSkillsRoot(scopeRoot: string): string {
  return path.join(scopeRoot, '.xtrm', 'skills');
}

export function resolveGlobalSkillsRoot(): string {
  return path.join(os.homedir(), '.xtrm', 'skills');
}

export function resolveDefaultTierRoot(skillsRoot: string): string {
  return path.join(skillsRoot, 'default');
}

export function resolveOptionalTierRoot(skillsRoot: string): string {
  return path.join(skillsRoot, 'optional');
}

/** @deprecated Kept only for reading the v1 shim layout. */
export function resolveUserPacksRoot(skillsRoot: string): string {
  return path.join(skillsRoot, 'user', 'packs');
}

export function assertProjectPackName(packName: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packName)) {
    throw new Error(`Invalid pack name '${packName}'. Use lowercase alphanumerics and hyphens only.`);
  }
  if (RESERVED_PACK_NAMES.has(packName)) {
    throw new Error(`Pack name '${packName}' is reserved by the skills layout.`);
  }
}

export function resolveRepoPackRoot(skillsRoot: string, packName: string): string {
  assertProjectPackName(packName);
  return path.join(skillsRoot, packName);
}

export function resolveActiveRuntimeRoot(skillsRoot: string): string {
  return path.join(skillsRoot, 'active');
}

/** Composed user-scope runtime view for one runtime (xtrm-e7jzt.2).
 * Generated state: rebuilt from default skills + globally enabled packs. */
export function resolveGlobalRuntimeViewRoot(runtime: SkillsRuntime): string {
  return path.join(resolveActiveRuntimeRoot(resolveGlobalSkillsRoot()), runtime);
}

/** User-scope runtime entry point the host runtime actually reads. */
export function resolveGlobalRuntimePointer(runtime: SkillsRuntime): string {
  if (runtime === 'claude') return path.join(os.homedir(), '.claude', 'skills');
  if (runtime === 'pi') return path.join(os.homedir(), '.pi', 'agent', 'skills');
  return path.join(os.homedir(), '.agents', 'skills');
}

export function resolveStateFilePath(skillsRoot: string): string {
  return path.join(skillsRoot, STATE_FILE_NAME);
}
