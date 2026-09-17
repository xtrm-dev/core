import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import {
  type SkillsRuntime,
  SKILLS_RUNTIMES,
  resolveActiveRuntimeRoot,
  resolveGlobalRuntimePointer,
  resolveGlobalRuntimeViewRoot,
  resolveGlobalSkillsRoot,
} from './skills-layout.js';
import { discoverDefaultSkills, discoverRepoPacks, discoverTierPacks, type DiscoveredSkill } from './skill-discovery.js';
import { assertSafeRuntimeLinkName, readSkillsState, type SkillsState } from './skills-state.js';

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
  skillsRoots: readonly string[],
  enabledPackNames: readonly string[],
): Promise<DiscoveredSkill[]> {
  const availablePacks = new Map<string, { path: string; skills: DiscoveredSkill[] }>();

  for (const root of skillsRoots) {
    const optionalPacks = await discoverTierPacks(root, 'optional');
    const userPacks = await discoverTierPacks(root, 'user');
    for (const pack of [...optionalPacks, ...userPacks]) {
      if (!availablePacks.has(pack.name)) {
        availablePacks.set(pack.name, { path: pack.path, skills: pack.skills });
      }
    }
  }

  const enabledSkills: DiscoveredSkill[] = [];
  for (const packName of enabledPackNames) {
    const pack = availablePacks.get(packName);
    if (!pack) {
      throw new Error(`Enabled pack '${packName}' was not found under optional/ or project pack roots.`);
    }
    enabledSkills.push(...pack.skills);
  }

  return enabledSkills;
}

function assertNoRuntimeCollisions(runtime: SkillsRuntime, skills: readonly DiscoveredSkill[]): void {
  const firstSeenByName = new Map<string, string>();

  for (const skill of sortByName(skills)) {
    const firstPath = firstSeenByName.get(skill.runtimeName);
    if (firstPath) {
      throw new Error(
        `Duplicate skill name '${skill.runtimeName}' for runtime '${runtime}' (first: ${firstPath}, duplicate: ${skill.path}).`,
      );
    }

    firstSeenByName.set(skill.runtimeName, skill.path);
  }
}

export async function selectRuntimeSkills(
  runtime: SkillsRuntime,
  skillsRoot: string,
  providedState?: { enabledPacks: { claude: string[]; pi: string[]; codex?: string[] } },
  additionalSkillsRoots?: readonly string[],
): Promise<RuntimeSkillSelection> {
  const state = providedState ?? await readSkillsState(skillsRoot);
  const enabledPacks = state.enabledPacks[runtime] ?? [];

  const defaultSkills = await discoverDefaultSkills(skillsRoot);
  const rootsToSearch = additionalSkillsRoots ? [skillsRoot, ...additionalSkillsRoots] : [skillsRoot];
  const enabledPackSkills = await collectEnabledPackSkills(rootsToSearch, enabledPacks);
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
    const linkPath = path.join(tempRoot, skill.runtimeName);
    const relativeTarget = path.relative(tempRoot, skill.path);
    await fs.symlink(relativeTarget, linkPath);
  }

  return tempRoot;
}

export async function atomicSwapDirectory(tempRoot: string, targetRoot: string): Promise<void> {
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

async function warnOnNonSymlinkEntries(activeRuntimeRoot: string): Promise<void> {
  await fs.ensureDir(path.dirname(activeRuntimeRoot));

  const nonSymlinkEntryNames = await findNonSymlinkEntries(activeRuntimeRoot);
  if (nonSymlinkEntryNames.length === 0) {
    return;
  }

  console.log(
    `[xtrm] Warning: ${activeRuntimeRoot} contains non-symlink entries (${nonSymlinkEntryNames.join(', ')}). ` +
    'These entries will be evicted during runtime view rebuild. ' +
    'Do not write skills to .claude/skills directly; write to .xtrm/skills/default or packs.',
  );
}

export async function rebuildRuntimeActiveView(
  runtime: SkillsRuntime,
  skillsRoot: string,
): Promise<RuntimeActiveViewResult> {
  const selection = await selectRuntimeSkills(runtime, skillsRoot);
  const activeRuntimeRoot = resolveActiveRuntimeRoot(skillsRoot);

  await warnOnNonSymlinkEntries(activeRuntimeRoot);

  const tempRoot = await buildRuntimeTempView(runtime, skillsRoot, selection.skills);
  await atomicSwapDirectory(tempRoot, activeRuntimeRoot);

  return {
    runtime,
    enabledPackCount: selection.enabledPacks.length,
    discoveredSkillCount: selection.skills.length,
    symlinkNames: selection.skills.map(skill => skill.runtimeName),
  };
}

export async function rebuildActiveViewInternal(
  skillsRoot: string,
  extraSourceRoots: readonly string[] = [],
): Promise<RuntimeActiveViewResult[]> {
  const state = await readSkillsState(skillsRoot);
  const mergedEnabledPacks = [...new Set([
    ...state.enabledPacks.claude,
    ...state.enabledPacks.pi,
    ...state.enabledPacks.codex,
  ])].sort((a, b) => a.localeCompare(b));

  const defaultSkills = await discoverDefaultSkills(skillsRoot);
  const rootsToSearch = extraSourceRoots.length > 0 ? [skillsRoot, ...extraSourceRoots] : [skillsRoot];
  const enabledPackSkills = await collectEnabledPackSkills(rootsToSearch, mergedEnabledPacks);
  const extraSkills = (await Promise.all(extraSourceRoots.map((root) => discoverDirectSkills(root)))).flat();
  const mergedSkills = sortByName([...defaultSkills, ...enabledPackSkills, ...extraSkills]);

  assertNoRuntimeCollisions('claude', mergedSkills);

  const activeRuntimeRoot = resolveActiveRuntimeRoot(skillsRoot);
  await warnOnNonSymlinkEntries(activeRuntimeRoot);

  const tempRoot = await buildRuntimeTempView('claude', skillsRoot, mergedSkills);
  await atomicSwapDirectory(tempRoot, activeRuntimeRoot);

  return [{
    runtime: 'claude',
    enabledPackCount: mergedEnabledPacks.length,
    discoveredSkillCount: mergedSkills.length,
    symlinkNames: mergedSkills.map((skill) => skill.runtimeName),
  }];
}

async function discoverDirectSkills(root: string): Promise<DiscoveredSkill[]> {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    return [];
  }

  const names = (await fs.readdir(root)).sort((a, b) => a.localeCompare(b));
  const skills: DiscoveredSkill[] = [];

  for (const name of names) {
    const entryPath = path.join(root, name);
    const entryStat = await fs.lstat(entryPath).catch(() => null);
    if (!entryStat?.isSymbolicLink()) {
      continue;
    }

    const resolvedTarget = path.resolve(root, await fs.readlink(entryPath));
    skills.push({ name, runtimeName: name, path: resolvedTarget });
  }

  return skills;
}

export async function rebuildGlobalActiveView(globalSkillsRoot: string): Promise<RuntimeActiveViewResult[]> {
  return rebuildActiveViewInternal(globalSkillsRoot);
}

export async function rebuildProjectActiveView(
  projectSkillsRoot: string,
  options: { globalSkillsRoot: string },
): Promise<RuntimeActiveViewResult[]> {
  const globalActiveRoot = resolveActiveRuntimeRoot(options.globalSkillsRoot);
  return rebuildActiveViewInternal(projectSkillsRoot, [globalActiveRoot]);
}

export async function rebuildAllRuntimeActiveViews(skillsRoot: string): Promise<RuntimeActiveViewResult[]> {
  return rebuildActiveViewInternal(skillsRoot);
}

export interface GlobalRuntimeViewResult {
  readonly runtime: SkillsRuntime;
  readonly viewRoot: string;
  readonly pointerPath: string;
  readonly pointerAdopted: boolean;
  readonly skillNames: string[];
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Default skills + skills of the packs globally enabled for one runtime, in
 * the order they must appear in that runtime's user-scope view. */
export async function selectGlobalRuntimeSkills(
  runtime: SkillsRuntime,
  skillsRoot: string,
  state: Pick<SkillsState, 'enabledPacks'>,
): Promise<DiscoveredSkill[]> {
  const defaultSkills = await discoverDefaultSkills(skillsRoot);
  const packs = new Map<string, DiscoveredSkill[]>();
  for (const pack of [
    ...(await discoverTierPacks(skillsRoot, 'optional')),
    ...(await discoverRepoPacks(skillsRoot)),
  ]) {
    if (!packs.has(pack.name)) packs.set(pack.name, pack.skills);
  }

  const selected = [...defaultSkills];
  for (const packName of state.enabledPacks[runtime] ?? []) {
    const packSkills = packs.get(packName);
    if (!packSkills) {
      throw new Error(`Enabled pack '${packName}' was not found under ${skillsRoot}/optional or the global user packs.`);
    }
    selected.push(...packSkills);
  }

  const seen = new Map<string, string>();
  for (const skill of selected) {
    assertSafeRuntimeLinkName(skill.runtimeName);
    const first = seen.get(skill.runtimeName);
    if (first && first !== skill.path) {
      throw new Error(`Cannot materialize skill '${skill.runtimeName}' for global ${runtime}: name collides (${first} vs ${skill.path}).`);
    }
    seen.set(skill.runtimeName, skill.path);
  }
  return selected;
}

async function ensureGlobalRuntimePointer(
  runtime: SkillsRuntime,
  viewRoot: string,
): Promise<{ pointerPath: string; pointerAdopted: boolean }> {
  const pointerPath = resolveGlobalRuntimePointer(runtime);
  const label = `~/${path.relative(os.homedir(), pointerPath)}`;
  const existing = await fs.lstat(pointerPath).catch(() => null);

  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`Refusing to replace existing ${label}; move it aside and re-run, or pass --force.`);
  }

  if (existing?.isSymbolicLink()) {
    const resolved = path.resolve(path.dirname(pointerPath), await fs.readlink(pointerPath));
    if (resolved === path.resolve(viewRoot)) return { pointerPath, pointerAdopted: false };
    // Adopt only xtrm-managed pointers (legacy default-tier pointer or an older view).
    if (!isInside(resolved, resolveGlobalSkillsRoot())) {
      throw new Error(`Refusing to replace foreign runtime skills symlink ${label} -> ${resolved}.`);
    }
    await fs.remove(pointerPath);
  }

  await fs.ensureDir(path.dirname(pointerPath));
  await fs.symlink(path.resolve(viewRoot), pointerPath);
  return { pointerPath, pointerAdopted: true };
}

/** Materialize the per-runtime user-scope views and point the runtime entry
 * points at them. Rebuilt atomically; derives entirely from `state`, so it is
 * safe to call on every enable/disable/install/update (xtrm-e7jzt.2). */
export async function materializeGlobalRuntimeViews(options: {
  readonly state?: SkillsState;
  readonly runtimes?: readonly SkillsRuntime[];
  readonly skillsRoot?: string;
} = {}): Promise<GlobalRuntimeViewResult[]> {
  const skillsRoot = options.skillsRoot ?? resolveGlobalSkillsRoot();
  const state = options.state ?? await readSkillsState(skillsRoot);
  const runtimes = options.runtimes ?? SKILLS_RUNTIMES;
  const results: GlobalRuntimeViewResult[] = [];

  for (const runtime of runtimes) {
    const selected = await selectGlobalRuntimeSkills(runtime, skillsRoot, state);
    const viewRoot = resolveGlobalRuntimeViewRoot(runtime);
    const tempRoot = path.join(path.dirname(viewRoot), `${runtime}.tmp-${randomUUID()}`);
    await fs.ensureDir(path.dirname(viewRoot));
    await fs.remove(tempRoot);
    await fs.ensureDir(tempRoot);

    try {
      const names = new Set<string>();
      for (const skill of selected) {
        if (names.has(skill.runtimeName)) continue;
        names.add(skill.runtimeName);
        // Relative targets: the view is renamed into place by atomicSwapDirectory
        // and relative links stay valid inside ~/.xtrm/skills, which also keeps
        // the global skills backup archive validation happy (xtrm-e7jzt.2).
        await fs.symlink(path.relative(tempRoot, path.resolve(skill.path)), path.join(tempRoot, skill.runtimeName));
      }
      await atomicSwapDirectory(tempRoot, viewRoot);
      const pointer = await ensureGlobalRuntimePointer(runtime, viewRoot);
      results.push({ runtime, viewRoot, skillNames: [...names].sort((a, b) => a.localeCompare(b)), ...pointer });
    } finally {
      if (await fs.pathExists(tempRoot)) await fs.remove(tempRoot).catch(() => undefined);
    }
  }

  return results;
}
