import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import kleur from 'kleur';
import Table from 'cli-table3';
import { checkDrift, type DriftReport } from '../core/drift.js';
import { checkRuntimeSkillsViews, type RuntimeViewCheckResult } from '../core/skills-runtime-views.js';
import { getXtManagedPiPackageDoctorReport } from '../core/pi-runtime.js';
import { discoverDefaultSkills, type DiscoveredSkill } from '../core/skill-discovery.js';

interface CheckJson {
  managed_sections: Array<{ name: string; version: string; canonical_version: string | null }>;
  drift: Array<{ name: string; kind: string; current_version: string | null; canonical_version: string | null }>;
  known_fragments: string[];
}

interface RegistryFileEntry {
  hash: string;
  version: string;
}

interface RegistryAsset {
  source_dir: string;
  install_mode: 'copy' | 'symlink';
  files: Record<string, RegistryFileEntry>;
}

interface RegistryManifest {
  version: string;
  assets: Record<string, RegistryAsset>;
}

type DriftState = 'in-sync' | 'drifted' | 'missing-from-snapshot' | 'extra-not-canonical';

type CatBSurface = 'skills' | 'hooks';

interface AssetRow {
  name: string;
  path: string;
  status: DriftState;
}

interface CatBJson {
  skills: AssetRow[];
  hooks: AssetRow[];
  runtimeView: RuntimeViewCheckResult;
  duplicates: string[];
  summary: { ok: number; warnings: number; errors: number };
}

function ok(msg: string) { console.log(`  ${kleur.green('✓')} ${msg}`); }
function warn(msg: string) { console.log(`  ${kleur.yellow('○')} ${msg}`); }
function fix(msg: string) { console.log(`    ${kleur.dim('→ fix:')} ${kleur.yellow(msg)}`); }
function section(label: string) {
  const line = '─'.repeat(Math.max(0, 38 - label.length));
  console.log(`\n${kleur.bold(`── ${label} ${line}`)}`);
}

function runSelfCheck(cwd: string): CheckJson | null {
  const cliEntry = process.argv[1];
  if (!cliEntry) return null;
  const result = spawnSync(process.execPath, [cliEntry, 'claude-sync', '--check', '--json', '--cwd', cwd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout) as CheckJson;
  } catch {
    return null;
  }
}

function checkClaudeMdFragments(cwd: string): boolean {
  section('CLAUDE.md fragments');
  const claudeMd = path.join(cwd, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    warn('No CLAUDE.md in this directory — skipping fragment check');
    return true;
  }
  const parsed = runSelfCheck(cwd);
  if (!parsed) {
    warn('claude-sync self-invoke failed — skipping fragment drift check');
    return true;
  }
  const sections = parsed.managed_sections ?? [];
  const drift = parsed.drift ?? [];
  if (sections.length === 0) {
    warn('CLAUDE.md has no XTRM-MANAGED sentinels — fragments not initialized');
    fix('xt claude-sync --add bd-workflow  (and other fragments)');
    return false;
  }
  const driftByName = new Map(drift.map(d => [d.name, d]));
  let allOk = true;
  for (const s of sections) {
    const d = driftByName.get(s.name);
    if (!d) {
      ok(`${s.name.padEnd(20)} current (v${s.version})`);
      continue;
    }
    allOk = false;
    if (d.kind === 'version-mismatch') {
      warn(`${s.name.padEnd(20)} project v${d.current_version}; canonical v${d.canonical_version}`);
      fix('xt claude-sync --apply --accept-overwrite');
    } else if (d.kind === 'body-mismatch') {
      warn(`${s.name.padEnd(20)} body diverges from canonical v${d.canonical_version}`);
      fix('xt claude-sync --apply --accept-overwrite');
    } else if (d.kind === 'unknown-fragment') {
      warn(`${s.name.padEnd(20)} not a known canonical fragment`);
    }
  }
  return allOk;
}

function stripXtrmPrefix(sourceDir: string): string {
  return sourceDir.replace(/^\.xtrm\/?/, '');
}

async function listDefaultSkillNames(skillsRoot: string): Promise<string[]> {
  return (await discoverDefaultSkills(skillsRoot)).map(skill => skill.name);
}

async function listHookFileNames(hooksRoot: string): Promise<string[]> {
  if (!await fs.pathExists(hooksRoot)) return [];
  const entries = await fs.readdir(hooksRoot, { withFileTypes: true });
  return entries.filter(entry => entry.isFile()).map(entry => entry.name).sort((a, b) => a.localeCompare(b));
}

function assetStatusFromDrift(relativePath: string, drift: DriftReport): DriftState {
  if (drift.upToDate.includes(relativePath)) return 'in-sync';
  if (drift.drifted.includes(relativePath)) return 'drifted';
  if (drift.missing.includes(relativePath)) return 'missing-from-snapshot';
  return 'extra-not-canonical';
}

async function toRows(registry: RegistryManifest, cwd: string, surface: CatBSurface, drift: DriftReport): Promise<AssetRow[]> {
  const assetName = surface === 'skills' ? 'skills' : 'hooks';
  const asset = registry.assets[assetName];
  if (!asset) return [];

  const expected = new Set<string>();
  const rows: AssetRow[] = [];

  for (const filePath of Object.keys(asset.files).sort((a, b) => a.localeCompare(b))) {
    const relativePath = path.posix.join(stripXtrmPrefix(asset.source_dir), filePath);
    expected.add(relativePath);
    rows.push({
      name: relativePath,
      path: relativePath,
      status: assetStatusFromDrift(relativePath, drift),
    });
  }

  const discovered = surface === 'skills'
    ? await listDefaultSkillNames(path.join(cwd, '.xtrm', 'skills'))
    : await listHookFileNames(path.join(cwd, asset.source_dir));

  for (const name of discovered) {
    const relativePath = surface === 'skills'
      ? path.posix.join(stripXtrmPrefix(asset.source_dir), name, 'SKILL.md')
      : path.posix.join(stripXtrmPrefix(asset.source_dir), name);
    if (expected.has(relativePath)) continue;
    rows.push({
      name: relativePath,
      path: relativePath,
      status: 'extra-not-canonical',
    });
  }

  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

async function loadRegistry(cwd: string): Promise<RegistryManifest> {
  return fs.readJson(path.join(cwd, '.xtrm', 'registry.json')) as Promise<RegistryManifest>;
}

async function readSpecialistsSkillNames(repoPath: string): Promise<string[]> {
  const skillsRoot = path.join(repoPath, 'config', 'skills');
  if (!await fs.pathExists(skillsRoot)) return [];
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await fs.pathExists(path.join(skillsRoot, entry.name, 'SKILL.md'))) names.push(entry.name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

async function detectDuplicateCanonicalNames(cwd: string): Promise<string[]> {
  const localSkills = await discoverDefaultSkills(path.join(cwd, '.xtrm', 'skills'));
  const localNames = new Set(localSkills.map((skill: DiscoveredSkill) => skill.name));
  const repoPath = process.env.SPECIALISTS_REPO_PATH;
  if (!repoPath) return [];

  const specialistsNames = await readSpecialistsSkillNames(repoPath);
  return specialistsNames.filter(name => localNames.has(name)).sort((a, b) => a.localeCompare(b));
}

function formatStatus(status: DriftState): string {
  switch (status) {
    case 'in-sync': return kleur.green('in-sync');
    case 'drifted': return kleur.red('drifted');
    case 'missing-from-snapshot': return kleur.yellow('missing-from-snapshot');
    case 'extra-not-canonical': return kleur.magenta('extra-not-canonical');
  }
}

function formatRuntimeView(check: RuntimeViewCheckResult): string {
  return [
    `activeReady=${check.activeReady}`,
    `claudePointerReady=${check.claudePointerReady}`,
    `piPointerReady=${check.piPointerReady}`,
  ].join(' ');
}

async function buildCatBJson(registry: RegistryManifest, cwd: string, drift: DriftReport, runtimeView: RuntimeViewCheckResult, duplicates: string[]): Promise<CatBJson> {
  const skills = await toRows(registry, cwd, 'skills', drift);
  const hooks = await toRows(registry, cwd, 'hooks', drift);
  const summary = [...skills, ...hooks].reduce((acc, row) => {
    if (row.status === 'in-sync') acc.ok += 1;
    else if (row.status === 'drifted') acc.errors += 1;
    else acc.warnings += 1;
    return acc;
  }, { ok: 0, warnings: 0, errors: 0 });

  if (!runtimeView.activeReady || !runtimeView.claudePointerReady || !runtimeView.piPointerReady) {
    summary.errors += 1;
  } else {
    summary.ok += 1;
  }
  if (duplicates.length > 0) summary.errors += 1;

  return { skills, hooks, runtimeView, duplicates, summary };
}

function renderCatB(report: CatBJson): void {
  section('Cat B — Skills');
  const skillsTable = new Table({
    head: [kleur.bold('Name'), kleur.bold('Status')],
    style: { head: [], border: [] },
  });
  for (const row of report.skills) skillsTable.push([row.name, formatStatus(row.status)]);
  console.log(skillsTable.toString());

  section('Cat B — Hooks');
  const hooksTable = new Table({
    head: [kleur.bold('Name'), kleur.bold('Status')],
    style: { head: [], border: [] },
  });
  for (const row of report.hooks) hooksTable.push([row.name, formatStatus(row.status)]);
  console.log(hooksTable.toString());

  section('Cat B — Runtime view');
  console.log(`  ${formatRuntimeView(report.runtimeView)}`);

  section('Cat B — Duplicate canonical names');
  if (report.duplicates.length === 0) {
    ok('duplicate-canonical-name=0');
  } else {
    warn(`duplicate-canonical-name=${report.duplicates.length}`);
    for (const name of report.duplicates) warn(`duplicate: ${name}`);
  }
}

function renderXtManagedPiPackages(): Promise<boolean> {
  section('Pi packages');
  return getXtManagedPiPackageDoctorReport().then(report => {
    if (report.issues.length === 0) {
      ok('all xt-shipped Pi packages present and current');
      return true;
    }

    for (const issue of report.missing) {
      warn(issue.pkg.displayName.padEnd(28) + ' missing');
      fix(issue.remediation);
    }

    for (const issue of report.outdated) {
      warn(issue.pkg.displayName.padEnd(28) + ' outdated ' + (issue.installedVersion ?? 'unknown') + ' → ' + (issue.expectedVersion ?? 'unknown'));
      fix(issue.remediation);
    }

    return false;
  });
}

function hasCatBIssues(report: CatBJson): boolean {
  return report.skills.some(row => row.status !== 'in-sync')
    || report.hooks.some(row => row.status !== 'in-sync')
    || !report.runtimeView.activeReady
    || !report.runtimeView.claudePointerReady
    || !report.runtimeView.piPointerReady
    || report.duplicates.length > 0;
}

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('Health check for the xtrm-managed surfaces of the current project')
    .option('--cwd <path>', 'Operate on this directory (default: process.cwd())')
    .option('--json', 'Output machine-readable JSON', false)
    .option('--check-drift', 'Exit non-zero on any drift, missing, extra, or duplicate')
    .action(async (opts: { cwd?: string; json?: boolean; checkDrift?: boolean }) => {
      const cwd = path.resolve(opts.cwd ?? process.cwd());
      const registry = await loadRegistry(cwd);
      const drift = await checkDrift(path.join(cwd, '.xtrm', 'registry.json'), path.join(cwd, '.xtrm'));
      const runtimeView = await checkRuntimeSkillsViews(cwd);
      const duplicates = await detectDuplicateCanonicalNames(cwd);
      const catB = await buildCatBJson(registry, cwd, drift, runtimeView, duplicates);

      if (opts.json) {
        console.log(JSON.stringify(catB, null, 2));
        if (hasCatBIssues(catB)) process.exitCode = 1;
        return;
      }

      console.log(`\n${kleur.bold('xt doctor')}\n`);
      const fragmentsOk = checkClaudeMdFragments(cwd);
      const piPackagesOk = await renderXtManagedPiPackages();
      renderCatB(catB);

      const failed = !fragmentsOk || !piPackagesOk || hasCatBIssues(catB);
      if (failed) {
        console.log('');
        console.log(`  ${kleur.yellow('○')} ${kleur.bold('Some checks failed')}  — follow the fix hints above`);
        if (opts.checkDrift || failed) process.exitCode = 1;
      } else {
        console.log('');
        console.log(`  ${kleur.green('✓')} ${kleur.bold('All checks passed')}`);
      }
      console.log('');
    });
}
