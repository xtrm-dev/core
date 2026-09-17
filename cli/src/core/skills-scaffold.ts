import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { SKILLS_RUNTIMES, resolveGlobalSkillsRoot, resolveSkillsRoot, resolveDefaultTierRoot } from './skills-layout.js';
import { discoverTierPacks, validateSkillsInvariants } from './skill-discovery.js';
import { readSkillsState, type SkillsState } from './skills-state.js';
import { reconcileRuntimeLinks } from './skills-runtime-reconcile.js';

export interface SkillsActivationResult {
  readonly activatedClaudeSkills: number;
  readonly activatedPiSkills: number;
  readonly activatedCodexSkills: number;
}
interface EnsureSkillsSymlinkOptions { readonly force?: boolean }
interface EnsureRuntimeSkillsOptions extends EnsureSkillsSymlinkOptions { readonly state?: SkillsState }
type PointerScope = 'global' | 'project';

export async function ensureSkillsSymlink(linkPath: string, symlinkTarget: string, label: string, _scope: PointerScope, _options: EnsureSkillsSymlinkOptions = {}): Promise<void> {
  const existing = await fs.lstat(linkPath).catch(() => null);
  if (existing?.isSymbolicLink() && await fs.readlink(linkPath) === symlinkTarget) return;
  if (existing) {
    throw new Error(`Refusing to replace existing ${label}; remove it or pass --force.`);
  }
  await fs.ensureDir(path.dirname(linkPath));
  await fs.symlink(symlinkTarget, linkPath);
}

export async function ensureUserAgentsSkillsSymlink(options: EnsureSkillsSymlinkOptions = {}): Promise<void> {
  const target = resolveDefaultTierRoot(resolveGlobalSkillsRoot());
  if (!await fs.pathExists(target)) throw new Error(`Global runtime skills root missing: ${target}`);
  for (const [link, label] of [
    [path.join(os.homedir(), '.claude', 'skills'), '~/.claude/skills'],
    [path.join(os.homedir(), '.pi', 'agent', 'skills'), '~/.pi/agent/skills'],
  ] as const) {
    const existing = await fs.lstat(link).catch(() => null);
    if (existing && !(existing.isSymbolicLink() && path.resolve(path.dirname(link), await fs.readlink(link)) === path.resolve(target))) {
      if (!options.force) throw new Error(`Refusing to replace existing ${label}; pass --force.`);
      await fs.remove(link);
    }
    if (!await fs.pathExists(link)) {
      await fs.ensureDir(path.dirname(link));
      await fs.symlink(target, link);
    }
  }
}

export async function ensureAgentsSkillsSymlink(projectRoot: string, options: EnsureRuntimeSkillsOptions = {}): Promise<SkillsActivationResult> {
  const skillsRoot = resolveSkillsRoot(projectRoot);
  const violations = await validateSkillsInvariants(skillsRoot);
  if (violations.length > 0) throw new Error(`Skills invariants failed. ${violations.map((v) => `${v.code}: ${v.message}`).join('; ')}`);
  const globalRoot = resolveGlobalSkillsRoot();
  const packs = [
    ...(await discoverTierPacks(globalRoot, 'optional')),
    ...(await discoverTierPacks(globalRoot, 'user')),
    ...(await discoverTierPacks(skillsRoot, 'optional')),
    ...(await discoverTierPacks(skillsRoot, 'user')),
  ];
  // Callers that are mid-mutation pass the prospective state so activation is
  // materialized before enabledPacks is persisted (xtrm-e7jzt.1).
  const state = options.state ?? await readSkillsState(skillsRoot);
  const results = [];
  for (const runtime of SKILLS_RUNTIMES) {
    results.push(await reconcileRuntimeLinks({
      projectRoot,
      state,
      runtime,
      discoveredPacks: packs,
      globalDefaultRoot: resolveDefaultTierRoot(globalRoot),
      globalOptionalRoot: path.join(globalRoot, 'optional'),
    }));
  }
  return {
    activatedClaudeSkills: Object.keys(results[0].desiredLinks).length,
    activatedPiSkills: Object.keys(results[1].desiredLinks).length,
    activatedCodexSkills: Object.keys(results[2].desiredLinks).length,
  };
}
