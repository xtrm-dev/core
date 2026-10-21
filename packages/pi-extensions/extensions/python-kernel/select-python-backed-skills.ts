/**
 * Canonical python-backed skills resolver (CORE-2512).
 *
 * Selects python-backed skills for runtime 'pi' on canonical primitives only —
 * never re-scans raw roots, never re-implements precedence/collision.
 *
 * Canonical flow (all VERIFIED by reading the cited modules):
 * - repoRoot   = resolveSkillsRoot(cwd)            [skills-layout.ts VERIFIED]
 * - globalRoot = resolveGlobalSkillsRoot()         [skills-layout.ts VERIFIED]
 * - repoState   = readSkillsState(repoRoot)        [skills-state.ts VERIFIED]
 * - globalState = readSkillsState(globalRoot)      [skills-state.ts VERIFIED]
 * - base = selectGlobalRuntimeSkills('pi', globalRoot, globalState)
 *        UNION selectRuntimeSkills('pi', repoRoot, repoState, [globalRoot]).skills
 *        [skills-materializer.ts VERIFIED, skills-runtime-reconcile.ts VERIFIED]
 *
 * Identity is the canonical runtimeName from SKILL.md frontmatter `name:`
 * [skill-discovery.ts VERIFIED: discoverSkill reads frontmatter, falls back to
 * dir name]. The package directory basename is only the importName, never the
 * identity (same rule as discoverSkillModules in python-kernel/index.ts).
 *
 * Scope merge mirrors ensureAgentsSkillsSymlink's repo+global pack handling
 * [skills-scaffold.ts VERIFIED as the merge pattern; exact union order here is
 * INFERENCE from the SUCCESS contract: global base first, repo selection second].
 *
 * Collision semantics (INFERENCE from SUCCESS contract, enforced here for the
 * cross-scope union; within-scope collisions already throw inside the
 * canonical selectors):
 * - identical (runtimeName, realpath) pairs dedupe silently;
 * - same runtimeName to different realpaths throws naming both realpaths,
 *   including python-vs-markdown (checked BEFORE the python classifier runs).
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveGlobalSkillsRoot, resolveSkillsRoot, resolveStateFilePath } from "../../../../cli/src/core/skills-layout.ts";
import { readSkillsState } from "../../../../cli/src/core/skills-state.ts";
import { selectGlobalRuntimeSkills } from "../../../../cli/src/core/skills-materializer.ts";
import { selectRuntimeSkills as selectRepoRuntimeSkills } from "../../../../cli/src/core/skills-runtime-reconcile.ts";
import type { DiscoveredSkill } from "../../../../cli/src/core/skill-discovery.ts";

export interface PythonBackedSkill {
  /** Canonical identity: SKILL.md frontmatter `name:`, never the dir name. */
  readonly runtimeName: string;
  /** Realpath of the skill directory (symlinks resolved). */
  readonly skillDir: string;
  /** `<skillDir>/src` — prepended to sys.path by the kernel driver. */
  readonly srcRoot: string;
  /** Import name: the exactly-one package dir basename under src/. */
  readonly importName: string;
}

export interface SelectPythonBackedSkillsOptions {
  readonly cwd: string;
  readonly runtime: string;
}

function toRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function statKey(stateFile: string): string {
  try {
    const st = statSync(stateFile);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

/** Classifier (mirrors discoverSkillModules): SKILL.md + exactly-one src/<pkg>/__init__.py. */
function classifyPythonBacked(skillDirReal: string): { srcRoot: string; importName: string } | null {
  if (!existsSync(join(skillDirReal, "SKILL.md"))) return null;
  const srcDir = join(skillDirReal, "src");
  let children: string[];
  try {
    children = readdirSync(srcDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
  const candidates = children.filter((d) => existsSync(join(srcDir, d, "__init__.py")));
  if (candidates.length !== 1) return null;
  return { srcRoot: srcDir, importName: basename(join(srcDir, candidates[0])) };
}

let generationToken = 0;
const selectionCache = new Map<string, { key: string; result: PythonBackedSkill[] }>();

/** Test/ops seam: force the next call to recompute. */
export function bumpPythonBackedSkillsCacheGeneration(): void {
  generationToken += 1;
}

/** Test seam: drop all cached selections. */
export function clearPythonBackedSkillsCache(): void {
  selectionCache.clear();
}

export async function selectPythonBackedSkills(
  options: SelectPythonBackedSkillsOptions,
): Promise<PythonBackedSkill[]> {
  const { cwd, runtime } = options;
  if (runtime !== "pi") {
    throw new Error(`Unsupported runtime '${runtime}': only 'pi' is supported.`);
  }

  const repoRoot = resolveSkillsRoot(cwd);
  const globalRoot = resolveGlobalSkillsRoot();
  const cacheId = `${cwd}\0${runtime}`;
  const freshness = `${generationToken}\0${statKey(resolveStateFilePath(repoRoot))}\0${statKey(resolveStateFilePath(globalRoot))}`;
  const cached = selectionCache.get(cacheId);
  if (cached && cached.key === freshness) return cached.result;

  const [repoState, globalState] = await Promise.all([
    readSkillsState(repoRoot),
    readSkillsState(globalRoot),
  ]);
  const [globalSkills, repoSelection] = await Promise.all([
    selectGlobalRuntimeSkills("pi", globalRoot, globalState),
    selectRepoRuntimeSkills("pi", repoRoot, repoState, [globalRoot]),
  ]);

  // Cross-scope union. Within-scope precedence/collisions already enforced by
  // the canonical selectors; here only the global-vs-repo seam is merged.
  const byRuntimeName = new Map<string, { real: string; skill: DiscoveredSkill }>();
  for (const skill of [...globalSkills, ...repoSelection.skills]) {
    const real = toRealpath(skill.path);
    const existing = byRuntimeName.get(skill.runtimeName);
    if (existing) {
      if (existing.real === real) continue;
      throw new Error(
        `Duplicate skill name '${skill.runtimeName}' for runtime 'pi' (first: ${existing.real}, duplicate: ${real}).`,
      );
    }
    byRuntimeName.set(skill.runtimeName, { real, skill });
  }

  const result: PythonBackedSkill[] = [];
  for (const { real, skill } of byRuntimeName.values()) {
    const classified = classifyPythonBacked(real);
    if (!classified) continue;
    result.push({
      runtimeName: skill.runtimeName,
      skillDir: real,
      srcRoot: classified.srcRoot,
      importName: classified.importName,
    });
  }
  result.sort((a, b) => a.runtimeName.localeCompare(b.runtimeName));

  selectionCache.set(cacheId, { key: freshness, result });
  return result;
}
