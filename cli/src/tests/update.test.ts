import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  checkDriftMock,
  runInstallMock,
  assureXtManagedPiPackagesMock,
  runExternalPiToolPatchMock,
  resolvePackageRootMock,
  planSubstrateMigrationMock,
  migrationBlockedReasonMock,
  runDependencyMaintenanceMock,
  ensureServiceSkillsMock,
  reconcileProjectClaudeHooksMock,
  ensureGlobalSkillsBootstrappedMock,
  ensureGlobalHooksBootstrappedMock,
  reconcileGlobalClaudeHooksMock,
  reconcileGlobalPiHooksMock,
  logBootstrapTriggerMock,
  ensureUserAgentsSkillsSymlinkMock,
  ensureAgentsSkillsSymlinkMock,
  syncGlobalPromptsMock,
  printGlobalPromptSyncSummaryMock,
} = vi.hoisted(() => ({
  checkDriftMock: vi.fn(),
  runInstallMock: vi.fn(),
  assureXtManagedPiPackagesMock: vi.fn(),
  runExternalPiToolPatchMock: vi.fn(),
  resolvePackageRootMock: vi.fn(),
  planSubstrateMigrationMock: vi.fn(),
  migrationBlockedReasonMock: vi.fn((plan: { needed: boolean; sbAvailable: boolean; reason: string }) => {
    if (!plan.needed) return null;
    const sbHint = plan.sbAvailable ? '' : ' Install @xtrm/substrate via `xt init` first, then';
    return `legacy .beads workspace blocks \`xt update --apply\`: automated Substrate migration ships with the A9 pipeline. Do NOT delete \`.beads\` (irreversible work loss).${sbHint} Upgrade xt, then re-run \`xt update --apply\`.`;
  }),
  runDependencyMaintenanceMock: vi.fn(),
  ensureServiceSkillsMock: vi.fn(),
  reconcileProjectClaudeHooksMock: vi.fn(),
  ensureGlobalSkillsBootstrappedMock: vi.fn(),
  ensureGlobalHooksBootstrappedMock: vi.fn(),
  reconcileGlobalClaudeHooksMock: vi.fn(),
  reconcileGlobalPiHooksMock: vi.fn(),
  logBootstrapTriggerMock: vi.fn(),
  ensureUserAgentsSkillsSymlinkMock: vi.fn(),
  ensureAgentsSkillsSymlinkMock: vi.fn(),
  syncGlobalPromptsMock: vi.fn(),
  printGlobalPromptSyncSummaryMock: vi.fn(),
}));

vi.mock('../core/drift.js', () => ({
  checkDrift: checkDriftMock,
}));

vi.mock('../core/registry-scaffold.js', () => ({
  resolvePackageRoot: resolvePackageRootMock,
}));

vi.mock('../core/pi-runtime.js', () => ({
  assureXtManagedPiPackages: assureXtManagedPiPackagesMock,
  runExternalPiToolPatch: runExternalPiToolPatchMock,
}));

vi.mock('../commands/install.js', () => ({
  runInstall: runInstallMock,
  isStrictRegistryMode: (opts: { strictRegistry?: boolean }) => opts.strictRegistry ?? process.env.XTRM_STRICT_REGISTRY === '1',
}));

vi.mock('../core/substrate-migration.js', () => ({
  planSubstrateMigration: planSubstrateMigrationMock,
  migrationBlockedReason: migrationBlockedReasonMock,
}));

vi.mock('../core/dependency-maintenance.js', () => ({
  runDependencyMaintenance: runDependencyMaintenanceMock,
  printDependencyMaintenanceSummary: vi.fn(),
}));

vi.mock('../core/service-skills-ensure.js', () => ({
  ensureServiceSkills: ensureServiceSkillsMock,
}));

vi.mock('../core/claude-runtime-sync.js', () => ({
  reconcileProjectClaudeHooks: reconcileProjectClaudeHooksMock,
  reconcileGlobalClaudeHooks: reconcileGlobalClaudeHooksMock,
}));

vi.mock('../core/global-skills-bootstrap.js', () => ({
  ensureGlobalSkillsBootstrapped: ensureGlobalSkillsBootstrappedMock,
  logBootstrapTrigger: logBootstrapTriggerMock,
}));

vi.mock('../core/global-hooks-bootstrap.js', () => ({
  ensureGlobalHooksBootstrapped: ensureGlobalHooksBootstrappedMock,
}));

vi.mock('../core/pi-runtime-hooks.js', () => ({
  reconcileGlobalPiHooks: reconcileGlobalPiHooksMock,
}));

vi.mock('../core/global-prompt-sync.js', () => ({
  syncGlobalPrompts: syncGlobalPromptsMock,
  printGlobalPromptSyncSummary: printGlobalPromptSyncSummaryMock,
}));

vi.mock('../core/global-hooks-flag.js', () => ({
  shouldUseGlobalHooks: () => process.env.XTRM_GLOBAL_HOOKS === '1',
}));

vi.mock('../core/skills-scaffold.js', () => ({
  ensureUserAgentsSkillsSymlink: ensureUserAgentsSkillsSymlinkMock,
  ensureAgentsSkillsSymlink: ensureAgentsSkillsSymlinkMock,
}));

import { createUpdateCommand } from '../commands/update.js';

let tmpDir = '';
let previousCwd = '';
let previousHome = '';

beforeEach(() => {
  previousCwd = process.cwd();
  previousHome = process.env.HOME ?? '';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-update-test-'));
  process.chdir(tmpDir);
  const happyHome = path.join(tmpDir, 'happy-home');
  fs.ensureDirSync(path.join(happyHome, '.xtrm', 'skills', 'default'));
  process.env.HOME = happyHome;
  checkDriftMock.mockReset();
  runInstallMock.mockReset();
  assureXtManagedPiPackagesMock.mockReset();
  runExternalPiToolPatchMock.mockReset();
  resolvePackageRootMock.mockReset();
  planSubstrateMigrationMock.mockReset();
  migrationBlockedReasonMock.mockClear();
  runDependencyMaintenanceMock.mockReset();
  checkDriftMock.mockResolvedValue({ missing: ['asset.txt'], upToDate: [], drifted: [] });
  assureXtManagedPiPackagesMock.mockResolvedValue({
    statuses: [],
    missing: [],
    outdated: [],
    installed: [],
    refreshed: [],
    failed: [],
  });
  planSubstrateMigrationMock.mockResolvedValue({ needed: false, hasBeads: false, alreadyMigrated: false, sbAvailable: false, reason: 'no .beads directory' });
  runDependencyMaintenanceMock.mockResolvedValue({
    tools: [],
    substrateDoctor: { state: 'checked' },
    gitnexusIndex: { state: 'current' },
  });
  ensureServiceSkillsMock.mockReset();
  ensureServiceSkillsMock.mockResolvedValue({ applicable: false, migratedPacks: [], alreadyCurrent: true, notes: [] });
  reconcileProjectClaudeHooksMock.mockReset();
  reconcileProjectClaudeHooksMock.mockResolvedValue({ settingsPath: '', changed: false, hooksEntries: 0 });
  ensureGlobalSkillsBootstrappedMock.mockReset();
  ensureGlobalSkillsBootstrappedMock.mockResolvedValue({ installedVersion: '1.0.0', changed: false });
  ensureGlobalHooksBootstrappedMock.mockReset();
  ensureGlobalHooksBootstrappedMock.mockResolvedValue({ installedVersion: '1.0.0', changed: false });
  reconcileGlobalClaudeHooksMock.mockReset();
  reconcileGlobalClaudeHooksMock.mockResolvedValue({ settingsPath: '', changed: false, hooksEntries: 0 });
  reconcileGlobalPiHooksMock.mockReset();
  reconcileGlobalPiHooksMock.mockResolvedValue({ settingsPath: '', changed: false, hooksEntries: 0 });
  logBootstrapTriggerMock.mockReset();
  logBootstrapTriggerMock.mockResolvedValue(undefined);
  ensureUserAgentsSkillsSymlinkMock.mockReset();
  ensureUserAgentsSkillsSymlinkMock.mockImplementation(async () => {
    const target = path.join(process.env.HOME || os.homedir(), '.xtrm', 'skills', 'default');
    if (!await fs.pathExists(target)) throw new Error(`Global runtime skills root missing: ${target}`);
  });
  ensureAgentsSkillsSymlinkMock.mockReset();
  ensureAgentsSkillsSymlinkMock.mockResolvedValue({ claude: 0, pi: 0 });
  syncGlobalPromptsMock.mockReset();
  syncGlobalPromptsMock.mockResolvedValue({ targets: [] });
  printGlobalPromptSyncSummaryMock.mockReset();
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousHome) process.env.HOME = previousHome;
  else delete process.env.HOME;
  fs.removeSync(tmpDir);
  vi.restoreAllMocks();
});

async function runUpdateCli(args: string[]): Promise<{ logs: string[]; json?: unknown; exitCode: number | undefined }> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const command = createUpdateCommand();
    await command.parseAsync(['node', 'xtrm-update-test', ...args]);
    const jsonText = logs.join('\n');
    return { logs, json: jsonText.includes('{') ? JSON.parse(jsonText) : undefined, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
    logSpy.mockRestore();
  }
}

function writePackageRoot(root: string): string {
  fs.ensureDirSync(path.join(root, '.xtrm'));
  fs.writeJsonSync(path.join(root, '.xtrm', 'registry.json'), {
    version: '1',
    assets: {},
  }, { spaces: 2 });
  return root;
}

function writeRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  fs.ensureDirSync(path.join(repo, '.xtrm'));
  fs.writeJsonSync(path.join(repo, '.xtrm', 'registry.json'), {
    version: '1',
    assets: {},
  }, { spaces: 2 });
  return repo;
}

/** Deterministic fs snapshot (relative paths + file bytes) for zero-mutation proofs. */
async function snapshotTree(root: string): Promise<Array<{ file: string; content: string }>> {
  const out: Array<{ file: string; content: string }> = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push({ file: path.relative(root, full), content: await fs.readFile(full, 'utf8') });
    }
  }
  if (await fs.pathExists(root)) await walk(root);
  return out;
}

describe('xtrm update', () => {
  it('dry-run reports changes when current package registry differs from old installed registry', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);

    const result = await runUpdateCli(['--repo', repo]);

    expect(checkDriftMock).toHaveBeenCalledWith(
      path.join(packageRoot, '.xtrm', 'registry.json'),
      path.join(repo, '.xtrm'),
      undefined, // ponytail: dry-run doesn't compute globalRoots
    );
    expect(runInstallMock).toHaveBeenCalledTimes(1);
    expect(runInstallMock).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: true,
      projectRoot: repo,
      skipGlobalPiPackageAssurance: true,
      skipExternalPiToolPatch: true,
    }));
    // plain update is a dry run: package assurance must not install/mutate
    expect(assureXtManagedPiPackagesMock).toHaveBeenCalledWith(true);
    expect(result.logs.join('\n')).toContain('refreshed');
    expect(result.logs.join('\n')).not.toContain('already-current');
  });

  it('dry-run reports refresh when only substrate migration is pending', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    await fs.ensureDir(path.join(repo, '.beads'));
    resolvePackageRootMock.mockReturnValue(packageRoot);
    checkDriftMock.mockResolvedValue({ missing: [], upToDate: ['asset.txt'], drifted: [] });
    planSubstrateMigrationMock.mockResolvedValue({ needed: true, hasBeads: true, alreadyMigrated: false, sbAvailable: true, reason: 'legacy .beads workspace pending Substrate import' });

    const result = await runUpdateCli(['--repo', repo]);

    expect(runInstallMock).toHaveBeenCalledTimes(1);
    expect(runInstallMock).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: true,
      projectRoot: repo,
      skipGlobalPiPackageAssurance: true,
      skipExternalPiToolPatch: true,
    }));
    // dry-run never imports: the run stage stays untouched.
    expect(result.logs.join('\n')).toContain('refreshed');
    expect(result.logs.join('\n')).toContain('substrate migration pending');
  });

  it('apply fails closed with zero mutation when migration is needed', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    await fs.ensureDir(path.join(repo, '.beads'));
    resolvePackageRootMock.mockReturnValue(packageRoot);
    checkDriftMock.mockResolvedValue({ missing: [], upToDate: ['asset.txt'], drifted: [] });
    planSubstrateMigrationMock.mockResolvedValue({ needed: true, hasBeads: true, alreadyMigrated: false, sbAvailable: true, reason: 'legacy .beads workspace pending Substrate import' });
    const before = await snapshotTree(repo);
    const result = await runUpdateCli(['--apply', '--repo', repo]);

    // Amended A8/A9 contract: A8 never activates the import. Needed means
    // fail-closed with remediation and zero mutation — A9 owns activation.
    expect(result.exitCode).toBe(1);
    expect(result.logs.join('\n')).toContain('failed');
    expect(result.logs.join('\n')).toContain('substrate migration required');
    expect(result.logs.join('\n')).toContain('A9 pipeline');
    expect(runInstallMock).not.toHaveBeenCalled();
    expect(syncGlobalPromptsMock).not.toHaveBeenCalled();
    expect(await snapshotTree(repo)).toEqual(before);
  });

  it('apply aborts with zero mutation when migration is blocked (sb absent)', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    await fs.ensureDir(path.join(repo, '.beads'));
    await fs.writeFile(path.join(repo, '.xtrm', 'sentinel.txt'), 'untouched');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    planSubstrateMigrationMock.mockResolvedValue({ needed: true, hasBeads: true, alreadyMigrated: false, sbAvailable: false, reason: 'sb CLI not found' });

    const before = await snapshotTree(repo);
    const result = await runUpdateCli(['--apply', '--repo', repo]);

    // ADR 43: blocked migration is a zero-mutation abort with remediation.
    expect(result.exitCode).toBe(1);
    expect(result.logs.join('\n')).toContain('failed');
    expect(result.logs.join('\n')).toContain('substrate migration required');
    expect(result.logs.join('\n')).toContain('xt init');
    expect(runInstallMock).not.toHaveBeenCalled();
    expect(syncGlobalPromptsMock).not.toHaveBeenCalled();
    expect(logBootstrapTriggerMock).not.toHaveBeenCalled();
    expect(ensureGlobalSkillsBootstrappedMock).not.toHaveBeenCalled();
    expect(reconcileGlobalClaudeHooksMock).not.toHaveBeenCalled();
    expect(reconcileGlobalPiHooksMock).not.toHaveBeenCalled();
    expect(assureXtManagedPiPackagesMock).not.toHaveBeenCalled();
    expect(runExternalPiToolPatchMock).not.toHaveBeenCalled();
    expect(await snapshotTree(repo)).toEqual(before);
    expect(await fs.readFile(path.join(repo, '.xtrm', 'sentinel.txt'), 'utf8')).toBe('untouched');
  });

  it('fail-closed remediation forbids deletion and points at A9 automation', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    await fs.ensureDir(path.join(repo, '.beads'));
    resolvePackageRootMock.mockReturnValue(packageRoot);
    planSubstrateMigrationMock.mockResolvedValue({ needed: true, hasBeads: true, alreadyMigrated: false, sbAvailable: true, reason: 'legacy .beads workspace pending Substrate import' });

    const before = await snapshotTree(repo);
    const result = await runUpdateCli(['--apply', '--repo', repo]);

    expect(result.exitCode).toBe(1);
    const logs = result.logs.join('\n');
    expect(logs).toContain('substrate migration required');
    expect(logs).toContain('A9 pipeline');
    expect(logs).toContain('Do NOT delete');
    expect(logs).toContain('Upgrade xt');
    expect(logs).not.toContain('bd export');
    expect(runInstallMock).not.toHaveBeenCalled();
    expect(syncGlobalPromptsMock).not.toHaveBeenCalled();
    expect(await snapshotTree(repo)).toEqual(before);
  });

  it('fleet preflight aborts before globals when any repo is blocked', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const root = path.join(tmpDir, 'root');
    const repoA = writeRepo(root, 'a');
    const repoB = writeRepo(root, 'b');
    await fs.ensureDir(path.join(repoA, '.beads'));
    resolvePackageRootMock.mockReturnValue(packageRoot);
    planSubstrateMigrationMock.mockImplementation(async (repo: string) => ({
      needed: repo === repoA,
      hasBeads: repo === repoA,
      alreadyMigrated: false,
      sbAvailable: false,
      reason: 'sb CLI not found',
    }));

    const beforeA = await snapshotTree(repoA);
    const beforeB = await snapshotTree(repoB);
    const result = await runUpdateCli(['--apply', '--root', root]);

    expect(result.exitCode).toBe(1);
    expect(result.logs.join('\n')).toContain(repoA);
    expect(result.logs.join('\n')).toContain('substrate migration required');
    expect(result.logs.join('\n')).toContain('not attempted');
    // zero mutation fleet-wide: no per-repo work, no globals.
    expect(runInstallMock).not.toHaveBeenCalled();
    expect(syncGlobalPromptsMock).not.toHaveBeenCalled();
    expect(ensureGlobalSkillsBootstrappedMock).not.toHaveBeenCalled();
    expect(assureXtManagedPiPackagesMock).not.toHaveBeenCalled();
    expect(runExternalPiToolPatchMock).not.toHaveBeenCalled();
    expect(await snapshotTree(repoA)).toEqual(beforeA);
    expect(await snapshotTree(repoB)).toEqual(beforeB);
  });

  it('fleet preflight covers incomplete repos carrying a board', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const root = path.join(tmpDir, 'root');
    const repoA = writeRepo(root, 'a');
    // incomplete: .xtrm/ without registry.json, but with a legacy board.
    const repoB = path.join(root, 'b');
    await fs.ensureDir(path.join(repoB, '.xtrm'));
    await fs.ensureDir(path.join(repoB, '.beads'));
    resolvePackageRootMock.mockReturnValue(packageRoot);
    planSubstrateMigrationMock.mockImplementation(async (repo: string) => ({
      needed: repo === repoB,
      hasBeads: repo === repoB,
      alreadyMigrated: false,
      sbAvailable: true,
      reason: 'legacy board',
    }));

    const beforeA = await snapshotTree(repoA);
    const beforeB = await snapshotTree(repoB);
    const result = await runUpdateCli(['--apply', '--root', root]);

    // the incomplete board blocks the fleet; the managed repo is skipped.
    expect(result.exitCode).toBe(1);
    const logs = result.logs.join('\n');
    expect(logs).toContain(repoB);
    expect(logs).toContain('substrate migration required');
    expect(logs).toContain('failed');
    expect(logs).toContain('A9 pipeline');
    expect(logs).toContain('Do NOT delete');
    expect(runInstallMock).not.toHaveBeenCalled();
    expect(syncGlobalPromptsMock).not.toHaveBeenCalled();
    expect(assureXtManagedPiPackagesMock).not.toHaveBeenCalled();
    expect(runExternalPiToolPatchMock).not.toHaveBeenCalled();
    expect(await snapshotTree(repoA)).toEqual(beforeA);
    expect(await snapshotTree(repoB)).toEqual(beforeB);
  });

  it('apply refreshes repo once when current package registry differs from old installed registry', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    runInstallMock.mockResolvedValue(undefined);

    const result = await runUpdateCli(['--apply', '--repo', repo]);

    expect(checkDriftMock).toHaveBeenCalledWith(
      path.join(packageRoot, '.xtrm', 'registry.json'),
      path.join(repo, '.xtrm'),
      undefined, // ponytail: globalRoots is undefined when HOME has no .xtrm/skills (CI temp HOME)
    );
    expect(runInstallMock).toHaveBeenCalledTimes(1);
    expect(assureXtManagedPiPackagesMock).toHaveBeenCalledWith(false);
    expect(runExternalPiToolPatchMock).toHaveBeenCalledWith(packageRoot, false);
    expect(assureXtManagedPiPackagesMock.mock.invocationCallOrder[0]).toBeLessThan(runExternalPiToolPatchMock.mock.invocationCallOrder[0]);
    expect(result.logs.join('\n')).toContain('refreshed');
  });

  it('root walk updates every managed repo and continues after failures', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const root = path.join(tmpDir, 'root');
    const repoA = writeRepo(root, 'a');
    const repoB = writeRepo(root, 'b');
    const repoC = writeRepo(root, 'c');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    runInstallMock.mockResolvedValue(undefined);

    const result = await runUpdateCli(['--apply', '--root', root]);

    expect(runInstallMock).toHaveBeenCalledTimes(3);
    expect(assureXtManagedPiPackagesMock).toHaveBeenCalledTimes(1);
    expect(runExternalPiToolPatchMock).toHaveBeenCalledTimes(1);
    expect(result.logs.join('\n')).toContain(repoA);
    expect(result.logs.join('\n')).toContain(repoB);
    expect(result.logs.join('\n')).toContain(repoC);
  });

  it('apply reconciles claude settings hooks even when registry is already current', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    checkDriftMock.mockResolvedValue({ missing: [], upToDate: ['asset.txt'], drifted: [] });

    await runUpdateCli(['--apply', '--repo', repo]);

    expect(reconcileProjectClaudeHooksMock).toHaveBeenCalledWith(repo, { dryRun: false });
    expect(runInstallMock).toHaveBeenCalledTimes(1);
  });

  it('dry-run reports pending Pi runtime repair without applying it', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    checkDriftMock.mockResolvedValue({ missing: [], upToDate: ['asset.txt'], drifted: [] });
    runInstallMock.mockResolvedValue({
      piRuntime: { extensionsAdded: [], extensionsUpdated: [], extensionsRemoved: [], packagesInstalled: [], failed: [], changed: true },
    });

    const result = await runUpdateCli(['--repo', repo]);

    expect(result.logs.join('\n')).toContain('Pi runtime repair pending');
    expect(runInstallMock).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(reconcileProjectClaudeHooksMock).not.toHaveBeenCalled();
  });

  it('apply reports a Pi runtime repair when registry is already current', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    checkDriftMock.mockResolvedValue({ missing: [], upToDate: ['asset.txt'], drifted: [] });
    runInstallMock.mockResolvedValue({
      piRuntime: { extensionsAdded: [], extensionsUpdated: [], extensionsRemoved: ['pi-dex'], packagesInstalled: [], failed: [], changed: true },
    });

    const result = await runUpdateCli(['--apply', '--repo', repo]);

    expect(runInstallMock).toHaveBeenCalledTimes(1);
    expect(result.logs.join('\n')).toContain('Pi runtime repaired');
    expect(result.logs.join('\n')).not.toContain('already-current');
  });

  it('apply reports Pi reconciliation failure and sets a non-zero exit code', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    checkDriftMock.mockResolvedValue({ missing: [], upToDate: ['asset.txt'], drifted: [] });
    runInstallMock.mockResolvedValue({
      piRuntime: { extensionsAdded: [], extensionsUpdated: [], extensionsRemoved: [], packagesInstalled: [], failed: ['npm:pi-gitnexus'], changed: false },
    });

    const result = await runUpdateCli(['--apply', '--repo', repo]);

    expect(result.exitCode).toBe(1);
    expect(result.logs.join('\n')).toContain('Pi reconciliation failed: npm:pi-gitnexus');
  });

  it('apply self-heals dormant repo: hook rewiring alone flips already-current to refreshed', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    checkDriftMock.mockResolvedValue({ missing: [], upToDate: ['asset.txt'], drifted: [] });
    reconcileProjectClaudeHooksMock.mockResolvedValue({ settingsPath: '', changed: true, hooksEntries: 3 });

    const result = await runUpdateCli(['--apply', '--repo', repo]);

    const out = result.logs.join('\n');
    expect(out).toContain('refreshed');
    expect(out).toContain('claude hooks rewired');
  });

  it('json output is valid JSON', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    checkDriftMock.mockResolvedValue({ missing: [], upToDate: ['asset.txt'], drifted: [] });

    const result = await runUpdateCli(['--json', '--repo', repo]);

    expect(result.json).toEqual({
      repos: [{
        repo,
        status: 'already-current',
        maintenance: { tools: [], substrateDoctor: { state: 'checked' }, gitnexusIndex: { state: 'current' } },
        migration: { needed: false, status: 'planned', reason: 'no .beads directory' },
      }],
      packages: { statuses: [], missing: [], outdated: [], installed: [], refreshed: [], failed: [] },
      promptSync: { targets: [] },
    });
  });

  it('apply exits non-zero in strict registry env when registry source missing', async () => {
    const repo = writeRepo(tmpDir, 'repo-a');
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    resolvePackageRootMock.mockReturnValue(packageRoot);
    checkDriftMock.mockResolvedValue({ missing: ['missing/file.md'], upToDate: [], drifted: [] });
    runInstallMock.mockImplementation(async (opts: { strictRegistry?: boolean }) => {
      expect(opts.strictRegistry).toBe(true);
      throw new Error('Registry/source mismatch: missing package source files.\n    • .xtrm/skills/default/missing/file.md');
    });
    assureXtManagedPiPackagesMock.mockResolvedValue({
      statuses: [], missing: [], outdated: [], installed: [], refreshed: [], failed: [],
    });
    const previousStrict = process.env.XTRM_STRICT_REGISTRY;
    process.env.XTRM_STRICT_REGISTRY = '1';

    try {
      const result = await runUpdateCli(['--apply', '--repo', repo]);
      expect(result.exitCode).toBe(1);
      expect(result.logs.join('\n')).toContain('failed');
      expect(result.logs.join('\n')).not.toContain('/missing/file.md');
    } finally {
      process.env.XTRM_STRICT_REGISTRY = previousStrict;
    }
  });

  it('apply bootstraps global skills before drift check', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);

    await runUpdateCli(['--apply', '--repo', repo]);

    expect(logBootstrapTriggerMock).toHaveBeenCalledWith({ command: 'update', cwd: tmpDir, pkgVersion: '1.2.3' });
    expect(ensureGlobalSkillsBootstrappedMock).toHaveBeenCalledWith(packageRoot, {});
    expect(logBootstrapTriggerMock.mock.invocationCallOrder[0]).toBeLessThan(checkDriftMock.mock.invocationCallOrder[0]);
    expect(ensureGlobalSkillsBootstrappedMock.mock.invocationCallOrder[0]).toBeLessThan(checkDriftMock.mock.invocationCallOrder[0]);
  });

  it('dry-run skips global bootstrap side effects', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);

    await runUpdateCli(['--repo', repo]);

    expect(logBootstrapTriggerMock).not.toHaveBeenCalled();
    expect(ensureGlobalSkillsBootstrappedMock).not.toHaveBeenCalled();
    expect(runExternalPiToolPatchMock).not.toHaveBeenCalled();
  });

  it('does not drift-check absent direct global roots when XTRM_GLOBAL_SKILLS=1', async () => {
    const previousFlag = process.env.XTRM_GLOBAL_SKILLS;
    const previousHome = process.env.HOME;
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    process.env.XTRM_GLOBAL_SKILLS = '1';
    process.env.HOME = tmpDir;

    try {
      const result = await runUpdateCli(['--apply', '--repo', repo]);
      expect(checkDriftMock).not.toHaveBeenCalled();
      expect(result.logs.join('\n')).not.toMatch(/Run `xt migrate skills`/);
    } finally {
      if (previousFlag === undefined) delete process.env.XTRM_GLOBAL_SKILLS;
      else process.env.XTRM_GLOBAL_SKILLS = previousFlag;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('help mentions package freshness and refresh behavior', async () => {
    const command = createUpdateCommand();
    const help = await command.helpInformation();
    // ponytail: short substrings — commander word-wraps at terminal width; long assertion strung across wrap breaks in CI
    expect(help).toContain('Routine refresh and repair');
    expect(help).toContain('runtimes, hooks, skills');
    expect(help).toContain('--all-repos');
  });

  it('per-repo install always defers the global prompt sync (xtrm-3ljgz.2)', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    runInstallMock.mockResolvedValue({ piRuntime: { changed: false, failed: [] } });

    await runUpdateCli(['--apply', '--repo', repo]);

    expect(runInstallMock).toHaveBeenCalledTimes(1);
    expect(runInstallMock).toHaveBeenCalledWith(expect.objectContaining({
      skipGlobalPromptSync: true,
    }));
  });

  it('apply fails before repo/global bootstrap work when global prompt preflight rejects', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    const repo = writeRepo(tmpDir, 'repo-a');
    resolvePackageRootMock.mockReturnValue(packageRoot);
    syncGlobalPromptsMock.mockRejectedValue(new Error('GlobalPromptSyncError: malformed managed block'));

    await expect(runUpdateCli(['--apply', '--repo', repo])).rejects.toThrow(/GlobalPromptSyncError/);
    expect(runInstallMock).not.toHaveBeenCalled();
    expect(ensureGlobalSkillsBootstrappedMock).not.toHaveBeenCalled();
    expect(ensureGlobalHooksBootstrappedMock).not.toHaveBeenCalled();
    expect(reconcileGlobalClaudeHooksMock).not.toHaveBeenCalled();
    expect(reconcileGlobalPiHooksMock).not.toHaveBeenCalled();
    expect(runExternalPiToolPatchMock).not.toHaveBeenCalled();
  });

  it('fleet update --root runs the global prompt sync exactly once, even for many repos (xtrm-3ljgz.2)', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    resolvePackageRootMock.mockReturnValue(packageRoot);
    // Scan root is a subdir holding only the two target repos; the package
    // root itself lives outside the scanned tree.
    const fleetRoot = path.join(tmpDir, 'fleet');
    writeRepo(fleetRoot, 'repo-a');
    writeRepo(fleetRoot, 'repo-b');
    runInstallMock.mockResolvedValue({ piRuntime: { changed: false, failed: [] } });

    await runUpdateCli(['--apply', '--root', fleetRoot]);

    expect(runInstallMock).toHaveBeenCalledTimes(2);
    expect(syncGlobalPromptsMock).toHaveBeenCalledTimes(1);
    expect(syncGlobalPromptsMock).toHaveBeenCalledWith({ dryRun: false });
  });

  it('fleet update --all-repos dry-run reports the sync without applying it (xtrm-3ljgz.2)', async () => {
    const packageRoot = writePackageRoot(path.join(tmpDir, 'package-root'));
    fs.writeJsonSync(path.join(packageRoot, 'package.json'), { version: '1.2.3' });
    resolvePackageRootMock.mockReturnValue(packageRoot);
    writeRepo(tmpDir, 'repo-a');
    writeRepo(tmpDir, 'repo-b');
    runInstallMock.mockResolvedValue({ piRuntime: { changed: false, failed: [] } });

    const previousFleetHome = process.env.HOME;
    try {
      process.env.HOME = path.join(tmpDir, 'fleet-home');
      await runUpdateCli(['--all-repos']);
    } finally {
      if (previousFleetHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousFleetHome;
    }

    expect(syncGlobalPromptsMock).toHaveBeenCalledTimes(1);
    expect(syncGlobalPromptsMock).toHaveBeenCalledWith({ dryRun: true });
  });
});
