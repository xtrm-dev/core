import { Command } from 'commander';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import kleur from 'kleur';
import { findProjectRoot } from '../utils/repo-root.js';
import { sym } from '../utils/theme.js';

function resolveSkillsLogPath(): string {
  return path.join(os.homedir(), '.xtrm', 'logs', 'skills-state.jsonl');
}

async function appendSkillsLog(event: Record<string, unknown>): Promise<void> {
  const logPath = resolveSkillsLogPath();
  await fs.ensureDir(path.dirname(logPath));
  await fs.appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
}
import {
  SKILLS_RUNTIMES,
  type SkillsRuntime,
  resolveSkillsRoot,
  resolveStateFilePath,
  resolveRepoPackRoot,
} from '../core/skills-layout.js';
import { createDefaultSkillsState, readSkillsState, setRuntimeEnabledPacks } from '../core/skills-state.js';
import {
  discoverDefaultSkills,
  discoverRepoPacks,
  discoverTierPacks,
  type DiscoveredPack,
  type InvariantViolation,
  validateSkillsInvariants,
} from '../core/skill-discovery.js';
import { materializeGlobalRuntimeViews, selectRuntimeSkills } from '../core/skills-materializer.js';
import { ensureAgentsSkillsSymlink } from '../core/skills-scaffold.js';

type Scope = 'global' | 'local';
type RuntimeOptions = { claude?: boolean; pi?: boolean; codex?: boolean };

type RuntimeStatus = {
  readonly runtime: SkillsRuntime;
  readonly enabledPacks: string[];
  readonly activeSkills: string[];
};

type ListPackEntry = {
  readonly name: string;
  readonly tier: 'optional' | 'user';
  readonly path: string;
  readonly skills: string[];
  readonly enabledIn: SkillsRuntime[];
  readonly source?: 'global' | 'local' | 'both';
};

const PACK_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function resolveScope(opts: { global?: boolean; local?: boolean }, defaultScope: Scope = 'global'): Scope {
  if (opts.global && opts.local) {
    throw new Error('Choose exactly one scope: --global or --local');
  }

  if (opts.global) return 'global';
  if (opts.local) return 'local';
  return defaultScope;
}

async function resolveScopeRoot(scope: Scope): Promise<string> {
  if (scope === 'global') {
    return os.homedir();
  }

  return findProjectRoot();
}

function resolveTargetRuntimes(opts: RuntimeOptions): SkillsRuntime[] {
  const selected = SKILLS_RUNTIMES.filter((runtime) => opts[runtime]);
  return selected.length > 0 ? selected : [...SKILLS_RUNTIMES];
}

async function readStateOrDefault(skillsRoot: string) {
  const statePath = resolveStateFilePath(skillsRoot);
  if (!await fs.pathExists(statePath)) {
    return createDefaultSkillsState();
  }

  return readSkillsState(skillsRoot);
}

async function assertSkillsInvariants(
  skillsRoot: string,
  opts: {
    nonBlockingCodes?: readonly InvariantViolation['code'][];
  } = {},
): Promise<InvariantViolation[]> {
  const nonBlockingCodes = new Set(opts.nonBlockingCodes ?? []);
  const violations = await validateSkillsInvariants(skillsRoot);
  const blockingViolations = violations.filter(violation => !nonBlockingCodes.has(violation.code));

  if (blockingViolations.length > 0) {
    const summary = blockingViolations.map(violation => `${violation.code}: ${violation.message}`).join('; ');
    throw new Error(`Skills invariants failed. ${summary}`);
  }

  return violations.filter(violation => nonBlockingCodes.has(violation.code));
}

async function collectListState(
  skillsRoot: string,
  runtimes: readonly SkillsRuntime[],
  scope: Scope,
): Promise<{
  defaultSkills: string[];
  packs: ListPackEntry[];
  runtimeStatus: RuntimeStatus[];
  scope: Scope;
}> {
  const globalSkillsRoot = resolveSkillsRoot(os.homedir());
  const isLocalScope = scope === 'local' && skillsRoot !== globalSkillsRoot;
  const [globalState, localState, globalDefaultSkills, localDefaultSkills, globalOptionalPacks, localOptionalPacks, globalUserPacks, localUserPacks] = await Promise.all([
    fs.pathExists(resolveStateFilePath(globalSkillsRoot)).then(exists => exists ? readSkillsState(globalSkillsRoot) : createDefaultSkillsState()),
    isLocalScope ? readStateOrDefault(skillsRoot) : null,
    discoverDefaultSkills(globalSkillsRoot),
    isLocalScope ? discoverDefaultSkills(skillsRoot) : null,
    discoverTierPacks(globalSkillsRoot, 'optional'),
    isLocalScope ? discoverTierPacks(skillsRoot, 'optional') : null,
    discoverRepoPacks(globalSkillsRoot),
    isLocalScope ? discoverRepoPacks(skillsRoot) : null,
  ]);

  const effectiveState = isLocalScope && localState
    ? composeState(globalState, localState)
    : globalState;

  const defaultSkills = isLocalScope && localDefaultSkills
    ? [...localDefaultSkills]
    : globalDefaultSkills;
  const optionalPacks = isLocalScope && localOptionalPacks
    ? [...globalOptionalPacks, ...localOptionalPacks]
    : globalOptionalPacks;
  const userPacks = isLocalScope && localUserPacks
    ? [...globalUserPacks, ...localUserPacks]
    : globalUserPacks;

  const allPacksMap = new Map<string, { name: string; tier: 'optional' | 'user'; path: string; skills: DiscoveredPack['skills']; source: 'global' | 'local' | 'both' }>();
  for (const pack of globalOptionalPacks) {
    allPacksMap.set(pack.name, { ...pack, tier: 'optional' as const, source: 'global' as const });
  }
  for (const pack of globalUserPacks) {
    allPacksMap.set(pack.name, { ...pack, tier: 'user' as const, source: 'global' as const });
  }
  if (isLocalScope) {
    for (const pack of localOptionalPacks ?? []) {
      if (allPacksMap.has(pack.name)) {
        const existing = allPacksMap.get(pack.name)!;
        existing.source = 'both';
      } else {
        allPacksMap.set(pack.name, { ...pack, tier: 'optional' as const, source: 'local' as const });
      }
    }
    for (const pack of localUserPacks ?? []) {
      if (allPacksMap.has(pack.name)) {
        const existing = allPacksMap.get(pack.name)!;
        existing.source = 'both';
      } else {
        allPacksMap.set(pack.name, { ...pack, tier: 'user' as const, source: 'local' as const });
      }
    }
  }

  const allPacks = [...allPacksMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  const runtimeStatus: RuntimeStatus[] = [];
  for (const runtime of runtimes) {
    const selected = await selectRuntimeSkills(
      runtime,
      isLocalScope ? skillsRoot : globalSkillsRoot,
      effectiveState,
      isLocalScope ? [globalSkillsRoot] : undefined,
    );
    runtimeStatus.push({
      runtime,
      enabledPacks: selected.enabledPacks,
      activeSkills: selected.skills.map(skill => skill.name),
    });
  }

  const packs: ListPackEntry[] = allPacks.map(pack => {
    const globalEnabled = globalState.enabledPacks;
    const localEnabled = localState?.enabledPacks;
    const enabledIn: SkillsRuntime[] = [];

    for (const runtime of SKILLS_RUNTIMES) {
      const inGlobal = globalEnabled[runtime].includes(pack.name);
      const inLocal = localEnabled?.[runtime].includes(pack.name);

      if (inGlobal || inLocal) {
        enabledIn.push(runtime);
      }
    }

    return {
      name: pack.name,
      tier: pack.tier,
      path: pack.path,
      skills: pack.skills.map(skill => skill.name).sort((a, b) => a.localeCompare(b)),
      enabledIn,
      source: pack.source,
    };
  });

  return {
    defaultSkills: defaultSkills.map(skill => skill.name),
    packs,
    runtimeStatus,
    scope,
  };
}

function composeState(
  globalState: { enabledPacks: Record<SkillsRuntime, string[]> },
  localState: { enabledPacks: Record<SkillsRuntime, string[]> },
): { enabledPacks: Record<SkillsRuntime, string[]> } {
  return {
    enabledPacks: {
      claude: [...new Set([...globalState.enabledPacks.claude, ...localState.enabledPacks.claude])].sort((a, b) => a.localeCompare(b)),
      pi: [...new Set([...globalState.enabledPacks.pi, ...localState.enabledPacks.pi])].sort((a, b) => a.localeCompare(b)),
      codex: [...new Set([...globalState.enabledPacks.codex, ...localState.enabledPacks.codex])].sort((a, b) => a.localeCompare(b)),
    },
  };
}

function printListSummary(skillsRoot: string, data: {
  defaultSkills: string[];
  packs: ListPackEntry[];
  runtimeStatus: RuntimeStatus[];
  warnings: string[];
  scope: Scope;
}): void {
  const scopeLabel = data.scope === 'global' ? 'global' : 'local (composed)';
  console.log(kleur.bold(`\n  xt skills list --${data.scope}`));
  console.log(kleur.gray(`  scope: ${scopeLabel}`));
  console.log(kleur.gray(`  root: ${skillsRoot}`));

  console.log(`\n  ${kleur.bold('Default skills')} (${data.defaultSkills.length})`);
  if (data.defaultSkills.length === 0) {
    console.log(kleur.yellow('  - none'));
  } else {
    for (const skillName of data.defaultSkills) {
      console.log(`  - ${skillName}`);
    }
  }

  console.log(`\n  ${kleur.bold('Packs')} (${data.packs.length})`);
  if (data.packs.length === 0) {
    console.log(kleur.yellow('  - none'));
  } else {
    for (const pack of data.packs) {
      const enabledText = pack.enabledIn.length > 0
        ? pack.enabledIn.join(', ')
        : 'disabled';
      const sourceLabel = data.scope === 'local' && pack.source === 'global' ? ' [global]'
        : data.scope === 'local' && pack.source === 'local' ? ' [local]'
        : data.scope === 'local' && pack.source === 'both' ? ' [global+local]'
        : '';
      console.log(`  - ${kleur.bold(pack.name)} [${pack.tier}] enabled: ${enabledText}${sourceLabel}`);
    }
  }

  console.log(`\n  ${kleur.bold('Runtime active view')}`);
  for (const runtime of data.runtimeStatus) {
    console.log(`  - ${runtime.runtime}: ${runtime.activeSkills.length} active skills, enabled packs: ${runtime.enabledPacks.length}`);
  }

  if (data.warnings.length > 0) {
    console.log(`\n  ${kleur.bold(kleur.yellow('Warnings'))} (${data.warnings.length})`);
    for (const warning of data.warnings) {
      console.log(`  - ${kleur.yellow(warning)}`);
    }
  }

  console.log('');
}

function ensureValidPackName(name: string): void {
  if (!PACK_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid pack name '${name}'. Use lowercase alphanumerics and hyphens only.`);
  }
}

/** Roots that contribute packs to enable/disable resolution: the active scope
 * plus the global tier. Mirrors collectListState and the materializer so `list`
 * can never advertise a pack that `enable` rejects (xtrm-e7jzt.1). */
function resolvePackResolutionRoots(skillsRoot: string): string[] {
  const roots = [skillsRoot, resolveSkillsRoot(os.homedir())].map(root => path.resolve(root));
  return [...new Set(roots)];
}

async function resolveAvailablePackNames(skillsRoot: string): Promise<string[]> {
  const packs = (await Promise.all(resolvePackResolutionRoots(skillsRoot).map(async (root) => [
    ...(await discoverTierPacks(root, 'optional')),
    ...(await discoverRepoPacks(root)),
  ]))).flat();

  const names = packs.map(pack => pack.name);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

async function resolveRequestedPacks(
  skillsRoot: string,
  packArg: string,
  action: 'enable' | 'disable',
): Promise<string[]> {
  const packNames = await resolveAvailablePackNames(skillsRoot);

  if (packArg === 'all') {
    return packNames;
  }

  if (packNames.includes(packArg)) {
    return [packArg];
  }

  const defaultSkillNames = (await Promise.all(
    resolvePackResolutionRoots(skillsRoot).map(root => discoverDefaultSkills(root)),
  )).flat().map(skill => skill.name);
  if (defaultSkillNames.includes(packArg) && action === 'disable') {
    throw new Error(`Cannot disable '${packArg}' - it's a default skill, not a pack.`);
  }

  throw new Error(`Pack '${packArg}' not found in .xtrm/skills packs.`);
}

async function mutatePacks(opts: {
  skillsRoot: string;
  action: 'enable' | 'disable';
  packArg: string;
  runtimes: readonly SkillsRuntime[];
  scope: Scope;
}) {
  const { skillsRoot, action, packArg, runtimes, scope } = opts;

  // When disabling with --local scope, check if pack is globally enabled
  if (action === 'disable' && scope === 'local') {
    const globalSkillsRoot = resolveSkillsRoot(os.homedir());
    const globalState = await readStateOrDefault(globalSkillsRoot);
    const isGloballyEnabled = globalState.enabledPacks.claude.includes(packArg)
      || globalState.enabledPacks.pi.includes(packArg)
      || globalState.enabledPacks.codex.includes(packArg);

    if (isGloballyEnabled) {
      throw new Error(
        `Pack "${packArg}" is globally enabled; use --global to disable everywhere, or leave alone and add a local override.`
      );
    }
  }

  const requestedPacks = await resolveRequestedPacks(skillsRoot, packArg, action);
  const beforeState = await readSkillsState(skillsRoot);
  const nextEnabledPacks: Record<SkillsRuntime, string[]> = {
    claude: [...beforeState.enabledPacks.claude],
    pi: [...beforeState.enabledPacks.pi],
    codex: [...beforeState.enabledPacks.codex],
  };

  for (const runtime of runtimes) {
    const current = new Set(beforeState.enabledPacks[runtime]);

    if (action === 'enable') {
      for (const packName of requestedPacks) {
        current.add(packName);
      }
    } else if (packArg === 'all') {
      current.clear();
    } else {
      for (const packName of requestedPacks) {
        current.delete(packName);
      }
    }

    nextEnabledPacks[runtime] = [...current];
  }

  // Materialize before persisting: an activation that fails must not leave
  // state.json claiming a pack is enabled with no links on disk (xtrm-e7jzt.1).
  const nextState = { ...beforeState, enabledPacks: nextEnabledPacks };
  if (scope === 'local') {
    // Reconcile owns the state write here (enabledPacks + managedLinks).
    await ensureAgentsSkillsSymlink(await findProjectRoot(), { state: nextState });
  } else {
    // Materialize the user-scope views from the prospective state first, then
    // commit enabledPacks — same ordering contract as local scope (xtrm-e7jzt.2).
    await materializeGlobalRuntimeViews({ state: nextState });
    for (const runtime of runtimes) {
      await setRuntimeEnabledPacks(skillsRoot, runtime, nextEnabledPacks[runtime]);
    }
  }

  const afterState = await readSkillsState(skillsRoot);

  for (const runtime of runtimes) {
    await appendSkillsLog({
      event: 'skills-state.mutation',
      scope,
      action,
      pack: packArg,
      runtime,
      before: beforeState.enabledPacks[runtime],
      after: afterState.enabledPacks[runtime],
    });
  }

  return {
    action,
    requested: packArg,
    resolvedPacks: requestedPacks,
    runtimes,
    state: afterState,
  };
}

async function createUserPack(skillsRoot: string, packName: string): Promise<{ path: string }> {
  ensureValidPackName(packName);
  const allPackNames = await resolveAvailablePackNames(skillsRoot);
  if (allPackNames.includes(packName)) throw new Error(`Pack '${packName}' already exists.`);

  const packRoot = resolveRepoPackRoot(skillsRoot, packName);
  if (await fs.pathExists(packRoot)) throw new Error(`Pack path already exists: ${packRoot}`);
  await fs.ensureDir(packRoot);
  return { path: packRoot };
}

export function createSkillsCommand(): Command {
  const skills = new Command('skills')
    .description('List installed skills and manage skill packs');

  skills
    .command('list')
    .description('Show tiered skill inventory and runtime active resolution (default: --global)')
    .option('--global', 'Use user-global scope (~/.xtrm/skills)', false)
    .option('--local', 'Use project-local scope (./.xtrm/skills) with global composition', false)
    .option('--claude', 'Show Claude runtime view', false)
    .option('--pi', 'Show Pi runtime view', false)
    .option('--codex', 'Show Codex runtime view', false)
    .option('--json', 'Output JSON', false)
    .action(async (opts: RuntimeOptions & { global?: boolean; local?: boolean; json?: boolean }) => {
      try {
        const scope = resolveScope(opts, 'global');
        const scopeRoot = await resolveScopeRoot(scope);
        const skillsRoot = resolveSkillsRoot(scopeRoot);
        const runtimes = resolveTargetRuntimes(opts);

        if (!await fs.pathExists(skillsRoot)) {
          const empty = {
            scope,
            skillsRoot,
            runtimes,
            defaultSkills: [],
            packs: [],
            runtimeStatus: [],
          };

          if (opts.json) {
            console.log(JSON.stringify(empty, null, 2));
            return;
          }

          console.log(kleur.bold(`\n  xt skills list`));
          console.log(kleur.gray(`  root: ${skillsRoot}`));
          console.log(kleur.yellow('\n  No skills tree found. Run xt init first.\n'));
          return;
        }

        const warningViolations = await assertSkillsInvariants(skillsRoot);
        const listData = await collectListState(skillsRoot, runtimes, scope);

        const warnings = [
          ...warningViolations.map(violation => violation.message),
        ];

        if (opts.json) {
          console.log(JSON.stringify({
            scope,
            skillsRoot,
            runtimes,
            defaultSkills: listData.defaultSkills,
            packs: listData.packs,
            runtimeStatus: listData.runtimeStatus,
            warnings,
          }, null, 2));
          return;
        }

        printListSummary(skillsRoot, {
          ...listData,
          warnings,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(kleur.red(`\n  ${sym.fail} ${msg}\n`));
        process.exit(1);
      }
    });

  skills
    .command('enable <pack>')
    .description('Enable a skill pack (default: --global)')
    .option('--global', 'Use user-global scope (~/.xtrm/skills)', false)
    .option('--local', 'Use project-local scope (./.xtrm/skills)', false)
    .option('--claude', 'Target Claude runtime', false)
    .option('--pi', 'Target Pi runtime', false)
    .option('--codex', 'Target Codex runtime', false)
    .option('--json', 'Output JSON', false)
    .action(async (pack: string, opts: RuntimeOptions & { global?: boolean; local?: boolean; json?: boolean }) => {
      try {
        const scope = resolveScope(opts, 'global');
        const scopeRoot = await resolveScopeRoot(scope);
        const skillsRoot = resolveSkillsRoot(scopeRoot);
        const runtimes = resolveTargetRuntimes(opts);

        await assertSkillsInvariants(skillsRoot);
        const result = await mutatePacks({
          skillsRoot,
          action: 'enable',
          packArg: pack,
          runtimes,
          scope,
        });

        if (opts.json) {
          console.log(JSON.stringify({
            scope,
            skillsRoot,
            ...result,
          }, null, 2));
          return;
        }

        console.log(`\n  ${sym.ok} Enabled ${result.resolvedPacks.length} pack(s): ${result.resolvedPacks.join(', ') || '(none)'}`);
        console.log(`  runtimes: ${result.runtimes.join(', ')}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(kleur.red(`\n  ${sym.fail} ${msg}\n`));
        process.exit(1);
      }
    });

  skills
    .command('disable <pack>')
    .description('Disable a skill pack (default: --global)')
    .option('--global', 'Use user-global scope (~/.xtrm/skills)', false)
    .option('--local', 'Use project-local scope (./.xtrm/skills)', false)
    .option('--claude', 'Target Claude runtime', false)
    .option('--pi', 'Target Pi runtime', false)
    .option('--codex', 'Target Codex runtime', false)
    .option('--json', 'Output JSON', false)
    .action(async (pack: string, opts: RuntimeOptions & { global?: boolean; local?: boolean; json?: boolean }) => {
      try {
        const scope = resolveScope(opts, 'global');
        const scopeRoot = await resolveScopeRoot(scope);
        const skillsRoot = resolveSkillsRoot(scopeRoot);
        const runtimes = resolveTargetRuntimes(opts);

        await assertSkillsInvariants(skillsRoot);
        const result = await mutatePacks({
          skillsRoot,
          action: 'disable',
          packArg: pack,
          runtimes,
          scope,
        });

        if (opts.json) {
          console.log(JSON.stringify({
            scope,
            skillsRoot,
            ...result,
          }, null, 2));
          return;
        }

        console.log(`\n  ${sym.ok} Disabled ${result.resolvedPacks.length} pack(s): ${result.resolvedPacks.join(', ') || '(none)'}`);
        console.log(`  runtimes: ${result.runtimes.join(', ')}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(kleur.red(`\n  ${sym.fail} ${msg}\n`));
        process.exit(1);
      }
    });

  skills
    .command('create-pack <name>')
    .description('Create an empty skill pack under .xtrm/skills/<name>/ (default: --local)')
    .option('--global', 'Use user-global scope (~/.xtrm/skills)', false)
    .option('--local', 'Use project-local scope (./.xtrm/skills)', false)
    .option('--json', 'Output JSON', false)
    .action(async (name: string, opts: { global?: boolean; local?: boolean; json?: boolean }) => {
      try {
        const scope = resolveScope(opts, 'local');
        const scopeRoot = await resolveScopeRoot(scope);
        const skillsRoot = resolveSkillsRoot(scopeRoot);

        await assertSkillsInvariants(skillsRoot);
        const created = await createUserPack(skillsRoot, name);

        if (opts.json) {
          console.log(JSON.stringify({
            scope,
            skillsRoot,
            pack: name,
            path: created.path,
          }, null, 2));
          return;
        }

        console.log(`\n  ${sym.ok} Created pack '${name}'`);
        console.log(`  ${kleur.dim(created.path)}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(kleur.red(`\n  ${sym.fail} ${msg}\n`));
        process.exit(1);
      }
    });

  return skills;
}
