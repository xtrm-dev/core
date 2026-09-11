import { spawnSync } from 'node:child_process';
import kleur from 'kleur';
import { getSbDoctorJson, getSbVersion } from './substrate.js';

export type MaintenanceState = 'current' | 'outdated' | 'missing' | 'unknown' | 'checked' | 'updated' | 'failed' | 'skipped';

export interface ToolMaintenanceStatus {
  id: 'sb' | 'gitnexus';
  cli: string;
  packageName: string;
  installedVersion?: string;
  latestVersion?: string;
  state: MaintenanceState;
  majorUpgrade: boolean;
  message?: string;
}

export interface DependencyMaintenanceSummary {
  tools: ToolMaintenanceStatus[];
  substrateDoctor: {
    state: MaintenanceState;
    message?: string;
  };
  gitnexusIndex: {
    state: MaintenanceState;
    message?: string;
  };
}

const TOOLS = [
  { id: 'sb' as const, cli: 'sb', packageName: '@xtrm/substrate', versionArgs: ['--version'] },
  { id: 'gitnexus' as const, cli: 'gitnexus', packageName: 'gitnexus', versionArgs: ['--version'] },
];

function run(command: string, args: string[], cwd: string, timeout = 10000): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout,
  });
}

function extractVersion(text: string): string | undefined {
  return text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

function major(version?: string): number | undefined {
  if (!version) return undefined;
  const parsed = Number(version.split('.')[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareVersions(installed?: string, latest?: string): { state: MaintenanceState; majorUpgrade: boolean } {
  if (!installed) return { state: 'missing', majorUpgrade: false };
  if (!latest) return { state: 'unknown', majorUpgrade: false };
  if (installed === latest) return { state: 'current', majorUpgrade: false };

  const installedMajor = major(installed);
  const latestMajor = major(latest);
  return {
    state: installed === latest ? 'current' : 'outdated',
    majorUpgrade: installedMajor !== undefined && latestMajor !== undefined && latestMajor > installedMajor,
  };
}

const latestVersionCache = new Map<string, string | undefined>();

function latestPackageVersion(packageName: string, cwd: string): string | undefined {
  if (latestVersionCache.has(packageName)) return latestVersionCache.get(packageName);
  const latest = run('npm', ['view', packageName, 'version'], cwd, 5000);
  const version = latest.status === 0 ? extractVersion(String(latest.stdout ?? '')) : undefined;
  latestVersionCache.set(packageName, version);
  return version;
}

function checkTool(tool: typeof TOOLS[number], cwd: string): ToolMaintenanceStatus {
  const installed = run(tool.cli, tool.versionArgs, cwd, 5000);
  const installedVersion = installed.status === 0
    ? extractVersion(`${installed.stdout ?? ''}\n${installed.stderr ?? ''}`)
    : undefined;

  // @xtrm/substrate is unpublished: never phone the npm registry for it
  // (name leak + guaranteed lookup failure). Version truth comes from sb.
  const latestVersion = tool.id === 'sb' ? undefined : latestPackageVersion(tool.packageName, cwd);
  const comparison = compareVersions(installedVersion, latestVersion);

  return {
    id: tool.id,
    cli: tool.cli,
    packageName: tool.packageName,
    installedVersion,
    latestVersion,
    state: comparison.state,
    majorUpgrade: comparison.majorUpgrade,
    message: latestVersion ? undefined : 'latest version lookup unavailable',
  };
}


function upgradeTool(tool: ToolMaintenanceStatus, cwd: string): ToolMaintenanceStatus {
  if (tool.state !== 'missing' && tool.state !== 'outdated') return tool;
  if (tool.majorUpgrade) {
    return { ...tool, state: 'skipped', message: 'major upgrade requires operator confirmation' };
  }
  if (tool.id === 'sb') {
    // @xtrm/substrate is unpublished: never attempt `npm install -g`.
    return { ...tool, state: 'failed', message: 'sb is not published to npm: set XTRM_SB_BIN to a local @xtrm/substrate `sb` entry (or put `sb` on PATH)' };
  }

  const install = run('npm', ['install', '-g', tool.packageName], cwd, 120000);
  if (install.status !== 0) {
    return {
      ...tool,
      state: 'failed',
      message: `${install.stderr || install.stdout || `npm install exited ${install.status}`}`.trim(),
    };
  }

  const refreshed = TOOLS.find(candidate => candidate.id === tool.id);
  return refreshed ? checkTool(refreshed, cwd) : { ...tool, state: 'updated' };
}

function runSubstrateDoctor(repoRoot: string): DependencyMaintenanceSummary['substrateDoctor'] {
  // Substrate-first gate (replaces the old Beads doctor gate): `sb doctor
  // --json` is read-only, so apply/non-apply share the same exit-code gate.
  // The payload is carried verbatim — schema interpretation is a marked seam
  // for xtrm-6qu.9, never parsed here.
  if (!getSbVersion().available) return { state: 'skipped', message: 'sb not installed' };
  const doctor = getSbDoctorJson(repoRoot);
  if (doctor.ok) return { state: 'checked' };
  return { state: 'failed', message: doctor.error ?? 'sb doctor --json rejected' };
}

function runGitNexusStatus(repoRoot: string, apply: boolean): DependencyMaintenanceSummary['gitnexusIndex'] {
  const status = run('gitnexus', ['status'], repoRoot, 10000);
  if (status.error) return { state: 'skipped', message: status.error.message };

  const text = `${status.stdout ?? ''}\n${status.stderr ?? ''}`.toLowerCase();
  const needsAnalyze = status.status !== 0 || text.includes('stale') || text.includes('not indexed') || text.includes('missing') || text.includes('schema');
  if (!needsAnalyze) return { state: 'current' };
  if (!apply) return { state: 'outdated', message: 'GitNexus index needs analyze' };

  const analyze = run('gitnexus', ['analyze'], repoRoot, 120000);
  if (analyze.status === 0) return { state: 'updated' };
  return {
    state: 'failed',
    message: `${analyze.stderr || analyze.stdout || `gitnexus analyze exited ${analyze.status}`}`.trim(),
  };
}

export async function runDependencyMaintenance(repoRoot: string, apply: boolean): Promise<DependencyMaintenanceSummary> {
  const checkedTools = TOOLS.map(tool => checkTool(tool, repoRoot));
  const tools = apply ? checkedTools.map(tool => upgradeTool(tool, repoRoot)) : checkedTools;
  return {
    tools,
    substrateDoctor: runSubstrateDoctor(repoRoot),
    gitnexusIndex: runGitNexusStatus(repoRoot, apply),
  };
}

export function printDependencyMaintenanceSummary(summary: DependencyMaintenanceSummary): void {
  console.log(kleur.bold('\n  Dependency Maintenance'));
  console.log(kleur.dim('  ' + '-'.repeat(50)));

  for (const tool of summary.tools) {
    const versions = [tool.installedVersion ?? 'missing', tool.latestVersion ? `latest ${tool.latestVersion}` : 'latest unknown'].join(' / ');
    const major = tool.majorUpgrade ? ' (major upgrade requires operator confirmation)' : '';
    console.log(`  ${tool.id.padEnd(8)} ${tool.state.padEnd(8)} ${kleur.dim(versions)}${kleur.yellow(major)}`);
  }

  console.log(`  ${'sb doctor'.padEnd(8)} ${summary.substrateDoctor.state}${summary.substrateDoctor.message ? kleur.dim(` — ${summary.substrateDoctor.message}`) : ''}`);
  console.log(`  ${'gitnexus'.padEnd(8)} ${summary.gitnexusIndex.state}${summary.gitnexusIndex.message ? kleur.dim(` — ${summary.gitnexusIndex.message}`) : ''}`);
}
