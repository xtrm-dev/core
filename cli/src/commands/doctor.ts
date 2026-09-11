import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import kleur from 'kleur';
import Table from 'cli-table3';
import { checkDrift, type DriftReport } from '../core/drift.js';
import { checkRuntimeSkillsViews, type RuntimeViewCheckResult } from '../core/skills-runtime-views.js';
import { getXtManagedPiPackageDoctorReport, type XtManagedPiPackageDoctorReport } from '../core/pi-runtime.js';
import { discoverDefaultSkills, type DiscoveredSkill } from '../core/skill-discovery.js';
import { ensureBeadsSharedServerEnabled, hasBeadsDir, type SharedBeadsServerState } from '../core/beads-shared-server.js';
import { findProjectRoot } from '../utils/repo-root.js';
import { applySettingsFixes, auditSettings, type SettingsAuditOutcome, type SettingsFinding } from '../core/settings-audit.js';
import { defaultStateDbPath, getSbDoctorJson, getSbVersion, runSetupCheck, stateDbPresent, type SetupCheckReport } from '../core/substrate.js';
import { checkXtrmUpdates, defaultCacheFile, formatUpdateRows, updatesSummary, type PackageStatus } from '../utils/npm-latest.js';

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
  sharedBeadsServerState: SharedBeadsServerState;
  summary: { ok: number; warnings: number; errors: number };
}

interface SubstrateDoctorSection {
  available: boolean;
  version: string | null;
  stateDb: string;
  stateDbPresent: boolean;
  doctorOk: boolean;
  /** Interpreted `sb doctor --json` data keys (verified live `sb 0.1.0`). */
  dbPath: string | null;
  schemaHealthy: boolean | null;
  projects: number | null;
  projectLink: { projectId?: string; source?: string; gitRoot?: string } | null;
  integrations: {
    available: boolean;
    ok: boolean | null;
    claudeChecks: number;
    piChecks: number;
    duplicates: boolean | null;
    /** Failing enrollment item names (contract #174 checks). */
    enrollmentFailed: string[];
  };
  error?: string;
}

interface LegacyMigrationSection {
  beadsDirPresent: boolean;
  beadsHookRegistrations: number;
  substrateRemnants: string[];
  status: 'clean' | 'legacy migration required';
}

interface DoctorJson {
  catB: CatBJson;
  piPackages: XtManagedPiPackageDoctorReport;
  updates: {
    packages: Array<{ package: string; installed: string | null; latest: string | null; state: string; from_cache: boolean; cache_age_ms: number | null }>;
    cache_file: string;
  };
  substrate: SubstrateDoctorSection;
  legacyMigration: LegacyMigrationSection;
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
    fix('xt claude-sync --list  (pick a current fragment; bd-workflow is retired Beads doctrine)');
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

async function resolveDoctorCwd(optsCwd?: string): Promise<string> {
  const cwd = optsCwd ? path.resolve(optsCwd) : await findProjectRoot();
  const registryPath = path.join(cwd, '.xtrm', 'registry.json');

  if (!(await fs.pathExists(registryPath))) {
    throw new Error(`Not inside an xtrm project: ${cwd}`);
  }

  return cwd;
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
    `globalClaudePointerReady=${check.globalClaudePointerReady}`,
    `globalPiPointerReady=${check.globalPiPointerReady}`,
    `projectClaudePointerState=${check.projectClaudePointerState}`,
    `projectPiPointerState=${check.projectPiPointerState}`,
    `projectCodexPointerState=${check.projectCodexPointerState}`,
  ].join(' ');
}

async function buildCatBJson(registry: RegistryManifest, cwd: string, drift: DriftReport, runtimeView: RuntimeViewCheckResult, duplicates: string[], sharedBeadsServerState: SharedBeadsServerState): Promise<CatBJson> {
  const skills = await toRows(registry, cwd, 'skills', drift);
  const hooks = await toRows(registry, cwd, 'hooks', drift);
  const summary = [...skills, ...hooks].reduce((acc, row) => {
    if (row.status === 'in-sync') acc.ok += 1;
    else if (row.status === 'drifted') acc.errors += 1;
    else acc.warnings += 1;
    return acc;
  }, { ok: 0, warnings: 0, errors: 0 });

  if (
    !runtimeView.activeReady
    || !runtimeView.globalClaudePointerReady
    || !runtimeView.globalPiPointerReady
    || runtimeView.projectClaudePointerState === 'missing'
    || runtimeView.projectPiPointerState === 'missing'
    || runtimeView.projectCodexPointerState === 'missing'
  ) {
    summary.errors += 1;
  } else {
    summary.ok += 1;
  }
  if (duplicates.length > 0) summary.errors += 1;

  return { skills, hooks, runtimeView, duplicates, sharedBeadsServerState, summary };
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
  console.log(`  ${report.runtimeView.globalClaudePointerReady && report.runtimeView.globalPiPointerReady ? kleur.green('✓') : kleur.yellow('○')} Global skills pointer: ${report.runtimeView.globalClaudePointerReady && report.runtimeView.globalPiPointerReady ? 'ok' : 'missing'}`);
  const projectPointerState = report.runtimeView.projectClaudePointerState === 'missing'
    || report.runtimeView.projectPiPointerState === 'missing'
    || report.runtimeView.projectCodexPointerState === 'missing'
    ? 'missing'
    : (report.runtimeView.projectClaudePointerState === 'skipped'
      && report.runtimeView.projectPiPointerState === 'skipped'
      && report.runtimeView.projectCodexPointerState === 'skipped' ? 'skipped (empty)' : 'ok');
  console.log(`  ${projectPointerState === 'ok' ? kleur.green('✓') : kleur.yellow('○')} Project skills pointer: ${projectPointerState}`);

  section('Cat B — Duplicate canonical names');
  if (report.duplicates.length === 0) {
    ok('duplicate-canonical-name=0');
  } else {
    warn(`duplicate-canonical-name=${report.duplicates.length}`);
    for (const name of report.duplicates) warn(`duplicate: ${name}`);
  }
}

function renderXtManagedPiPackages(report: XtManagedPiPackageDoctorReport): boolean {
  section('Pi packages');
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

  const unknown = report.issues.filter(issue => issue.state === 'version-unknown');
  for (const issue of unknown) {
    warn(issue.pkg.displayName.padEnd(28) + ' version unknown (offline or npm lookup failed)');
    fix(issue.remediation);
  }

  console.log(kleur.dim('  outbound: npm view <pkg> version --registry https://registry.npmjs.org'));
  return false;
}

function hasCatBIssues(report: CatBJson): boolean {
  return report.skills.some(row => row.status !== 'in-sync')
    || report.hooks.some(row => row.status !== 'in-sync')
    || !report.runtimeView.activeReady
    || !report.runtimeView.globalClaudePointerReady
    || !report.runtimeView.globalPiPointerReady
    || report.runtimeView.projectClaudePointerState === 'missing'
    || report.runtimeView.projectPiPointerState === 'missing'
    || report.duplicates.length > 0;
}

const FINDING_LABEL: Record<SettingsFinding['kind'], string> = {
  'dead-hook-command': 'dead hook command',
  'duplicate-registration': 'duplicate registration',
  'duplicate-of-global': 'duplicates global',
  'legacy-path': 'legacy path',
  'legacy-beads-hook': 'legacy Beads hook',
  'dangling-reference': 'dangling reference',
  'orphaned-key': 'orphaned key',
};

function renderSettingsAudit(outcome: SettingsAuditOutcome, mode: { fix: boolean; apply: boolean } = { fix: false, apply: false }): void {
  const banner = !mode.fix ? '(read-only)' : mode.apply ? '(--fix --apply)' : '(--fix, dry run)';
  console.log(`\n${kleur.bold('xt doctor settings')} ${kleur.dim(banner)}\n`);

  section('Scanned');
  if (outcome.scanned.length === 0) warn('no settings.json found in the requested scope');
  for (const file of outcome.scanned) console.log(`  ${kleur.dim(file)}`);

  const byFile = new Map<string, SettingsFinding[]>();
  for (const finding of outcome.planned) {
    const bucket = byFile.get(finding.file) ?? [];
    bucket.push(finding);
    byFile.set(finding.file, bucket);
  }

  section('Findings');
  if (outcome.planned.length === 0) {
    ok('no findings');
  } else {
    for (const [file, findings] of byFile) {
      console.log(`\n  ${kleur.bold(file)}  ${kleur.dim(`(${findings.length})`)}`);
      const table = new Table({
        head: [kleur.bold('Kind'), kleur.bold('Subject'), kleur.bold('Evidence')],
        style: { head: [], border: [] },
        wordWrap: true,
        colWidths: [24, 52, 56],
      });
      for (const finding of findings) table.push([FINDING_LABEL[finding.kind], finding.subject, finding.evidence]);
      console.log(table.toString());
      for (const remediation of new Set(findings.map(f => f.remediation))) fix(remediation);
    }
  }

  section('Preserved');
  if (outcome.preserved.length === 0) {
    ok('nothing needed preserving');
  } else {
    console.log(kleur.dim('  left alone — ownership is never inferred from absence'));
    for (const item of outcome.preserved) {
      warn(`${item.classification.padEnd(20)} ${item.subject}`);
      console.log(`    ${kleur.dim(item.reason)}`);
    }
  }

  if (outcome.failed.length > 0) {
    section('Failed');
    for (const failure of outcome.failed) warn(`${failure.file}: ${failure.error}`);
  }

  const fixable = outcome.planned.filter(f => f.fix).length;

  if (mode.apply && outcome.applied.length > 0) {
    section('Applied');
    for (const item of outcome.applied) {
      ok(`${item.subject}  ${kleur.dim(`(${item.file})`)}`);
      console.log(`    ${kleur.dim(`backup: ${item.backup}`)}`);
    }
  }

  console.log('');
  console.log(`  ${outcome.planned.length === 0 ? kleur.green('✓') : kleur.yellow('○')} ${outcome.planned.length} finding(s), ${outcome.preserved.length} preserved, ${outcome.failed.length} failed`);
  if (!mode.fix) {
    console.log(kleur.dim(`  read-only — nothing was written. ${fixable} finding(s) are xt-owned; run --fix to see them.`));
  } else if (!mode.apply) {
    console.log(kleur.dim(`  dry run — nothing was written. ${fixable} finding(s) would be removed; re-run with --apply.`));
  } else {
    console.log(kleur.dim(`  ${outcome.applied.length} finding(s) removed; each mutated file was backed up first.`));
  }
  console.log('');
}

function createDoctorSettingsCommand(): Command {
  return new Command('settings')
    .description('Read-only audit of the settings.json files the installer writes into')
    .option('--cwd <path>', 'Project to audit (default: nearest project root)')
    .option('--scope <scope>', 'home | project | all', 'all')
    .option('--scan-all-repos', 'Audit every xt consumer project under ~/dev and ~/projects', false)
    .option('--json', 'Output machine-readable ReconciliationOutcome/1 JSON', false)
    .option('--fix', 'Remove the findings xt owns (dry-run; add --apply to write)', false)
    .option('--apply', 'With --fix: write the changes, backing each file up first', false)
    .action(async (opts: { cwd?: string; scope?: string; scanAllRepos?: boolean; json?: boolean; fix?: boolean; apply?: boolean }, cmd: Command) => {
      // `doctor` declares --json and --cwd too. Commander v14 resolves a flag
      // the parent also declares onto the PARENT, leaving the subcommand's copy
      // at its default — so read both. Declaring them here keeps `--help` honest.
      const parentOpts = (cmd.parent?.opts() ?? {}) as { cwd?: string; json?: boolean };
      const json = Boolean(opts.json || parentOpts.json);
      const cwdOpt = opts.cwd ?? parentOpts.cwd;

      const scope = opts.scope ?? 'all';
      if (scope !== 'home' && scope !== 'project' && scope !== 'all') {
        throw new Error(`--scope must be home, project or all (got: ${scope})`);
      }

      const projectRoot = opts.scanAllRepos
        ? undefined
        : (cwdOpt ? path.resolve(cwdOpt) : await findProjectRoot().catch(() => undefined));

      if (opts.apply && !opts.fix) {
        throw new Error('--apply only applies to --fix; run: xt doctor settings --fix --apply');
      }

      const outcome = await auditSettings({
        projectRoot,
        scope,
        scanAllRepos: opts.scanAllRepos,
      });

      if (opts.fix) await applySettingsFixes(outcome, { apply: opts.apply });

      if (json) console.log(JSON.stringify(outcome, null, 2));
      else renderSettingsAudit(outcome, { fix: Boolean(opts.fix), apply: Boolean(opts.apply) });

      // A finding that --fix --apply resolved is no longer outstanding.
      const outstanding = outcome.planned.length - outcome.applied.length;
      if (outstanding > 0 || outcome.failed.length > 0) process.exitCode = 1;
    });
}

async function buildSubstrateSection(cwd: string): Promise<SubstrateDoctorSection> {
  const version = getSbVersion();
  const stateDb = defaultStateDbPath();
  const present = stateDbPresent(stateDb);
  const noIntegrations: SubstrateDoctorSection['integrations'] = { available: false, ok: null, claudeChecks: 0, piChecks: 0, duplicates: null, enrollmentFailed: [] };
  if (!version.available) {
    return {
      available: false,
      version: null,
      stateDb,
      stateDbPresent: present,
      doctorOk: false,
      dbPath: null,
      schemaHealthy: null,
      projects: null,
      projectLink: null,
      integrations: noIntegrations,
      error: version.raw || 'sb CLI not found',
    };
  }
  const doctor = getSbDoctorJson(cwd);
  // A6 integration health (xtrm PR #168): fail-open, never crashes diagnosis.
  let integrations: SubstrateDoctorSection['integrations'] = noIntegrations;
  try {
    const setup = runSetupCheck({ cwd });
    const report: SetupCheckReport | null = setup.report;
    integrations = {
      available: true,
      ok: setup.ok,
      claudeChecks: report?.claude?.length ?? 0,
      piChecks: report?.pi?.length ?? 0,
      duplicates: report?.naming?.duplicates ?? null,
      enrollmentFailed: (report?.enrollment ?? []).filter(e => !e.ok).map(e => e.name),
    };
  } catch {
    integrations = noIntegrations;
  }
  return {
    available: true,
    version: version.version ?? null,
    stateDb,
    stateDbPresent: present,
    doctorOk: doctor.ok,
    dbPath: doctor.data?.dbPath ?? null,
    schemaHealthy: doctor.data?.schemaHealthy ?? null,
    projects: doctor.data?.projects ?? null,
    projectLink: doctor.data?.link ?? null,
    integrations,
    ...(doctor.ok ? {} : { error: doctor.error ?? 'sb doctor --json rejected' }),
  };
}

async function buildLegacyMigrationSection(cwd: string): Promise<LegacyMigrationSection> {
  const beadsDirPresent = await hasBeadsDir(cwd);
  let beadsHookRegistrations = 0;
  let substrateRemnants: string[] = [];
  try {
    // Fail-open: settings audit failure must not crash the diagnosis.
    const outcome = await auditSettings({ projectRoot: cwd, scope: 'all' });
    beadsHookRegistrations = outcome.planned.filter(finding => finding.kind === 'legacy-beads-hook').length;
  } catch {
    beadsHookRegistrations = 0;
  }
  try {
    // A6 naming probe (§7): stale beads plugin/marketplace/package remnants.
    const setup = runSetupCheck({ cwd });
    substrateRemnants = setup.report?.naming?.beadsRemnants ?? [];
  } catch {
    substrateRemnants = [];
  }
  const required = beadsDirPresent || beadsHookRegistrations > 0 || substrateRemnants.length > 0;
  return {
    beadsDirPresent,
    beadsHookRegistrations,
    substrateRemnants,
    status: required ? 'legacy migration required' : 'clean',
  };
}

function renderSubstrate(report: SubstrateDoctorSection): void {
  section('Substrate');
  if (!report.available) {
    warn(`sb CLI not found${report.error ? ` (${report.error})` : ''}`);
    fix('xt init --substrate-dir <checkout>  (enrolls sb + integrations from a local @xtrm/substrate source)');
    return;
  }
  ok(`sb available${report.version ? ` (${report.version})` : ''}`);
  if (report.stateDbPresent) ok(`state.db present (${report.stateDb})`);
  else {
    warn(`state.db missing (${report.stateDb})`);
    fix('xt init  (initializes ~/.xtrm/state.db and links the checkout)');
  }
  if (report.doctorOk) {
    ok(`sb doctor --json: healthy${report.projects !== null && report.projects !== undefined ? ` (${report.projects} project(s))` : ''}`);
    if (report.projectLink?.projectId) ok(`linked project: ${report.projectLink.projectId} (via ${report.projectLink.source ?? 'unknown'})`);
    else warn('no linked project for this checkout');
  } else {
    warn(`sb doctor --json rejected${report.error ? ` (${report.error})` : ''}`);
    fix('sb doctor  (human-readable diagnosis)');
  }
  if (report.integrations.available) {
    if (report.integrations.ok) ok(`integrations healthy (claude ${report.integrations.claudeChecks}, pi ${report.integrations.piChecks})`);
    else warn('integration health check failed (claude plugin / pi extension)');
    if (report.integrations.enrollmentFailed.length > 0) warn(`enrollment failing: ${report.integrations.enrollmentFailed.join(', ')}`);
    if (report.integrations.duplicates) warn('duplicate substrate plugin registrations');
  } else {
    warn('integration health unavailable (@xtrm/substrate setup.ts not installed)');
  }
}

function renderLegacyMigration(report: LegacyMigrationSection): void {
  section('Legacy migration');
  if (report.status === 'clean') {
    ok('no legacy Beads machinery');
    return;
  }
  if (report.beadsDirPresent) warn('legacy .beads workspace present — legacy migration required');
  if (report.beadsHookRegistrations > 0) warn(`${report.beadsHookRegistrations} legacy Beads hook registration(s) — legacy migration required`);
  if (report.substrateRemnants.length > 0) warn(`stale Beads plugin/marketplace remnant(s): ${report.substrateRemnants.join(', ')} — legacy migration required`);
  fix('legacy .beads workspace blocks migration: automated Substrate migration ships with the A9 pipeline. Do NOT delete `.beads`. Upgrade xt, then re-run `xt update --apply`');
}

export function createDoctorCommand(): Command {
  const doctor = new Command('doctor')
    .description('Canonical diagnosis for xtrm-managed project and runtime surfaces')
    .option('--cwd <path>', 'Operate on this directory (default: process.cwd())')
    .option('--json', 'Output machine-readable JSON', false)
    .option('--check-drift', 'Exit non-zero on any drift, missing, extra, or duplicate')
    .action(async (opts: { cwd?: string; json?: boolean; checkDrift?: boolean }) => {
      const cwd = await resolveDoctorCwd(opts.cwd);
      const registry = await loadRegistry(cwd);
      const drift = await checkDrift(path.join(cwd, '.xtrm', 'registry.json'), path.join(cwd, '.xtrm'));
      const runtimeView = await checkRuntimeSkillsViews(cwd);
      const duplicates = await detectDuplicateCanonicalNames(cwd);
      const sharedBeadsServerState = (await hasBeadsDir(cwd))
        ? (await ensureBeadsSharedServerEnabled(cwd, false)).state
        : 'not-applicable';
      const catB = await buildCatBJson(registry, cwd, drift, runtimeView, duplicates, sharedBeadsServerState);
      const piPackages = await getXtManagedPiPackageDoctorReport();
      const updateStatuses = checkXtrmUpdates();
      const substrate = await buildSubstrateSection(cwd);
      const legacyMigration = await buildLegacyMigrationSection(cwd);
      const legacyMigrationRequired = legacyMigration.status !== 'clean';
      const doctorJson: DoctorJson = {
        catB,
        piPackages,
        updates: {
          packages: updateStatuses.map((s: PackageStatus) => ({
            package: s.pkg,
            installed: s.installed,
            latest: s.latest,
            state: s.state,
            from_cache: s.fromCache,
            cache_age_ms: s.cacheAgeMs,
          })),
          cache_file: defaultCacheFile(),
        },
        substrate,
        legacyMigration,
      };

      if (opts.json) {
        console.log(JSON.stringify(doctorJson, null, 2));
        if (hasCatBIssues(catB) || legacyMigrationRequired || (opts.checkDrift && piPackages.hasIssues)) process.exitCode = 1;
        return;
      }

      console.log(`\n${kleur.bold('xt doctor')}\n`);
      section('Runtime availability');
      const claudeAvailable = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
      const piAvailable = spawnSync('pi', ['--version'], { stdio: 'ignore' }).status === 0;
      const pnpmAvailable = spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status === 0;
      claudeAvailable ? ok('claude CLI available') : warn('claude CLI not found');
      piAvailable ? ok('pi CLI available') : warn('pi CLI not found');
      pnpmAvailable ? ok('pnpm available') : warn('pnpm not found');
      const piAgentDir = process.env.PI_AGENT_DIR ?? path.join(process.env.HOME ?? '', '.pi', 'agent');
      const missingPiConfig = ['models.json', 'auth.json', 'settings.json']
        .filter(name => !fs.existsSync(path.join(piAgentDir, name)));
      if (missingPiConfig.length === 0) ok('Pi config files present');
      else warn(`missing Pi config: ${missingPiConfig.join(', ')}`);

      const fragmentsOk = checkClaudeMdFragments(cwd);
      const piPackagesOk = renderXtManagedPiPackages(piPackages);
      renderSubstrate(substrate);
      renderLegacyMigration(legacyMigration);
      renderCatB(catB);

      section('Updates');
      const summary = updatesSummary(updateStatuses);
      for (const row of formatUpdateRows(updateStatuses)) console.log(`  ${row}`);
      console.log(kleur.dim(`  cache: ${defaultCacheFile()}`));
      if (summary.stale > 0) warn(`${summary.stale} stale package(s) — run: npm i -g <pkg>@latest`);
      else if (summary.unknown > 0) warn(`${summary.unknown} package(s) could not be checked (offline or npm unreachable)`);
      else if (summary.notInstalled > 0) warn(`${summary.notInstalled} package(s) not installed globally`);
      else ok('xtrm-tools, xtmux, specialists all current');

      // Substrate-unavailable warns but does not fail: the fleet is
      // pre-Substrate (no sb binary ships yet) and doctor must stay usable
      // there. Legacy machinery present fails — it is actionable via update.
      const failed = !fragmentsOk || !piPackagesOk || piPackages.hasIssues || hasCatBIssues(catB) || legacyMigrationRequired;
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

  doctor.addCommand(createDoctorSettingsCommand());
  return doctor;
}
