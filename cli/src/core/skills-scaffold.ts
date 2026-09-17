import path from 'node:path';
import fs from 'fs-extra';
import { SKILLS_RUNTIMES, resolveGlobalSkillsRoot, resolveSkillsRoot, resolveDefaultTierRoot } from './skills-layout.js';
import { discoverTierPacks, validateSkillsInvariants } from './skill-discovery.js';
import { readSkillsState, type SkillsState } from './skills-state.js';
import { reconcileRuntimeLinks } from './skills-runtime-reconcile.js';
import { materializeGlobalRuntimeViews } from './skills-materializer.js';

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

export async function ensureUserAgentsSkillsSymlink(_options: EnsureSkillsSymlinkOptions = {}): Promise<void> {
  // User-scope runtime entry points are symlinks to per-runtime composed views
  // under ~/.xtrm/skills/active/, not to the installer-owned default tier, so
  // globally enabled packs are actually loaded (xtrm-e7jzt.2).
  await materializeGlobalRuntimeViews();
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
