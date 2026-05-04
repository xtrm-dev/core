import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import {
  type SkillsRuntime,
  resolveActiveRuntimeRoot,
} from './skills-layout.js';
import { discoverDefaultSkills, discoverTierPacks, type DiscoveredSkill } from './skill-discovery.js';
import { readSkillsState } from './skills-state.js';

export interface RuntimeSkillSelection {
  readonly runtime: SkillsRuntime;
  readonly enabledPacks: string[];
  readonly skills: DiscoveredSkill[];
}

export interface RuntimeActiveViewResult {
  readonly runtime: SkillsRuntime;
  readonly enabledPackCount: number;
  readonly discoveredSkillCount: number;
  readonly symlinkNames: string[];
}

function sortByName<T extends { name: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

async function collectEnabledPackSkills(
  skillsRoot: string,
  enabledPackNames: readonly string[],
): Promise<DiscoveredSkill[]> {
  const optionalPacks = await discoverTierPacks(skillsRoot, 'optional');
  const userPacks = await discoverTierPacks(skillsRoot, 'user');
  const availablePacks = new Map<string, { path: string; skills: DiscoveredSkill[] }>();

  for (const pack of [...optionalPacks, ...userPacks]) {
    availablePacks.set(pack.name, { path: pack.path, skills: pack.skills });
  }

  const enabledSkills: DiscoveredSkill[] = [];
  for (const packName of enabledPackNames) {
    const pack = availablePacks.get(packName);
    if (!pack) {
      throw new Error(`Enabled pack '${packName}' was not found under optional/ or user/packs/.`);
    }
    enabledSkills.push(...pack.skills);
  }

  return enabledSkills;
}

function assertNoRuntimeCollisions(runtime: SkillsRuntime, skills: readonly DiscoveredSkill[]): void {
  const firstSeenByName = new Map<string, string>();

  for (const skill of sortByName(skills)) {
    const firstPath = firstSeenByName.get(skill.name);
    if (firstPath) {
      throw new Error(
        `Duplicate skill name '${skill.name}' for runtime '${runtime}' (first: ${firstPath}, duplicate: ${skill.path}).`,
      );
    }

    firstSeenByName.set(skill.name, skill.path);
  }
}

export async function selectRuntimeSkills(
  runtime: SkillsRuntime,
  skillsRoot: string,
): Promise<RuntimeSkillSelection> {
  const state = await readSkillsState(skillsRoot);
  const enabledPacks = state.enabledPacks[runtime];

  const defaultSkills = await discoverDefaultSkills(skillsRoot);
  const enabledPackSkills = await collectEnabledPackSkills(skillsRoot, enabledPacks);
  const allSkills = sortByName([...defaultSkills, ...enabledPackSkills]);

  assertNoRuntimeCollisions(runtime, allSkills);

  return {
    runtime,
    enabledPacks: [...enabledPacks],
    skills: allSkills,
  };
}

async function buildRuntimeTempView(
  runtime: SkillsRuntime,
  skillsRoot: string,
  selectedSkills: readonly DiscoveredSkill[],
): Promise<string> {
  const activeRuntimeRoot = resolveActiveRuntimeRoot(skillsRoot);
  const activeParentRoot = path.dirname(activeRuntimeRoot);
  const tempRoot = path.join(activeParentRoot, `${runtime}.tmp-${randomUUID()}`);

  await fs.ensureDir(tempRoot);

  for (const skill of selectedSkills) {
    const linkPath = path.join(tempRoot, skill.name);
    const relativeTarget = path.relative(tempRoot, skill.path);
    await fs.symlink(relativeTarget, linkPath);
  }

  return tempRoot;
}

async function atomicSwapDirectory(tempRoot: string, targetRoot: string): Promise<void> {
  const backupRoot = `${targetRoot}.bak-${randomUUID()}`;
  const targetExists = await fs.pathExists(targetRoot);

  try {
    if (targetExists) {
      await fs.rename(targetRoot, backupRoot);
    }

    await fs.rename(tempRoot, targetRoot);

    if (targetExists) {
      await fs.remove(backupRoot);
    }
  } catch (error) {
    if (targetExists && await fs.pathExists(backupRoot) && !await fs.pathExists(targetRoot)) {
      await fs.rename(backupRoot, targetRoot).catch(() => undefined);
    }
    throw error;
  } finally {
    if (await fs.pathExists(tempRoot)) {
      await fs.remove(tempRoot).catch(() => undefined);
    }

    if (await fs.pathExists(backupRoot) && await fs.pathExists(targetRoot)) {
      await fs.remove(backupRoot).catch(() => undefined);
    }
  }
}

async function findNonSymlinkEntries(runtimeRoot: string): Promise<string[]> {
  const runtimeRootExists = await fs.pathExists(runtimeRoot);
  if (!runtimeRootExists) {
    return [];
  }

  const entryNames = (await fs.readdir(runtimeRoot)).sort((a, b) => a.localeCompare(b));
  const nonSymlinkEntryNames: string[] = [];

  for (const entryName of entryNames) {
    const entryPath = path.join(runtimeRoot, entryName);
    const entryStat = await fs.lstat(entryPath).catch(() => null);
    if (!entryStat?.isSymbolicLink()) {
      nonSymlinkEntryNames.push(entryName);
    }
  }

  return nonSymlinkEntryNames;
}

export async function rebuildRuntimeActiveView(
  runtime: SkillsRuntime,
  skillsRoot: string,
): Promise<RuntimeActiveViewResult> {
  const selection = await selectRuntimeSkills(runtime, skillsRoot);

  const activeRuntimeRoot = resolveActiveRuntimeRoot(skillsRoot);
  await fs.ensureDir(path.dirname(activeRuntimeRoot));

  const nonSymlinkEntryNames = await findNonSymlinkEntries(activeRuntimeRoot);
  if (nonSymlinkEntryNames.length > 0) {
    console.log(
      `[xtrm] Warning: ${activeRuntimeRoot} contains non-symlink entries (${nonSymlinkEntryNames.join(', ')}). ` +
      'These entries will be evicted during runtime view rebuild. ' +
      'Do not write skills to .claude/skills directly; write to .xtrm/skills/default or packs.',
    );
  }

  const tempRoot = await buildRuntimeTempView(runtime, skillsRoot, selection.skills);
  await atomicSwapDirectory(tempRoot, activeRuntimeRoot);

  return {
    runtime,
    enabledPackCount: selection.enabledPacks.length,
    discoveredSkillCount: selection.skills.length,
    symlinkNames: selection.skills.map(skill => skill.name),
  };
}

export async function rebuildAllRuntimeActiveViews(skillsRoot: string): Promise<RuntimeActiveViewResult[]> {
  const state = await readSkillsState(skillsRoot);
  const mergedEnabledPacks = [...new Set([
    ...state.enabledPacks.claude,
    ...state.enabledPacks.pi,
  ])].sort((a, b) => a.localeCompare(b));

  const defaultSkills = await discoverDefaultSkills(skillsRoot);
  const enabledPackSkills = await collectEnabledPackSkills(skillsRoot, mergedEnabledPacks);
  const mergedSkills = sortByName([...defaultSkills, ...enabledPackSkills]);

  assertNoRuntimeCollisions('claude', mergedSkills);

  const activeRuntimeRoot = resolveActiveRuntimeRoot(skillsRoot);
  await fs.ensureDir(path.dirname(activeRuntimeRoot));

  const nonSymlinkEntryNames = await findNonSymlinkEntries(activeRuntimeRoot);
  if (nonSymlinkEntryNames.length > 0) {
    console.log(
      `[xtrm] Warning: ${activeRuntimeRoot} contains non-symlink entries (${nonSymlinkEntryNames.join(', ')}). ` +
      'These entries will be evicted during runtime view rebuild. ' +
      'Do not write skills to .claude/skills directly; write to .xtrm/skills/default or packs.',
    );
  }

  const tempRoot = await buildRuntimeTempView('claude', skillsRoot, mergedSkills);
  await atomicSwapDirectory(tempRoot, activeRuntimeRoot);

  return [{
    runtime: 'claude',
    enabledPackCount: mergedEnabledPacks.length,
    discoveredSkillCount: mergedSkills.length,
    symlinkNames: mergedSkills.map((skill) => skill.name),
  }];
}
