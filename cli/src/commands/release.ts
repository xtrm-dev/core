import { Command } from 'commander';
import kleur from 'kleur';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildReportBundle, listXtReports } from '../core/xt-reports.js';

const RELEASE_SCOPE_PATTERNS = [
  /^CHANGELOG\.md$/,
  /^cli\/package\.json$/,
  /^cli\/dist(?:\/|$)/,
  /^dist(?:\/|$)/,
];

function run(cmd: string, args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function getLatestTag(cwd: string): string {
  const tagged = run('git', ['describe', '--tags', '--abbrev=0'], cwd);
  if (tagged.status === 0 && tagged.stdout.trim()) return tagged.stdout.trim();
  return 'HEAD~1';
}

export function getPackageVersion(cwd: string): string {
  return JSON.parse(readFileSync(path.join(cwd, 'cli', 'package.json'), 'utf8')).version as string;
}

export function getReleaseTag(cwd: string): string {
  return `v${getPackageVersion(cwd)}`;
}

export function buildReleaseTemplate(options: { from: string; to: string; bundle: string; versionMode: string }): string {
  return [
    `version_mode=${options.versionMode}`,
    `range=${options.from}..${options.to}`,
    '',
    'xt_reports:',
    options.bundle,
  ].join('\n');
}

export function getReleaseScopeViolations(cwd: string): string[] {
  const changedPaths = collectChangedPaths(cwd);
  return changedPaths.filter((file) => !RELEASE_SCOPE_PATTERNS.some((pattern) => pattern.test(file)));
}

export function assertReleaseScopeClean(cwd: string): void {
  const disallowed = getReleaseScopeViolations(cwd);
  if (disallowed.length > 0) {
    console.error(kleur.red(`\n  ✗ Release scope violation. Allowed only CHANGELOG.md, cli/package.json, cli/dist/**, dist/**.\n  Offending paths:\n  ${disallowed.map((file) => `- ${file}`).join('\n  ')}\n`));
    process.exit(1);
  }
}

function collectChangedPaths(cwd: string): string[] {
  const outputs = [
    run('git', ['diff', '--name-only'], cwd).stdout,
    run('git', ['diff', '--name-only', '--cached'], cwd).stdout,
    run('git', ['status', '--porcelain'], cwd).stdout.replace(/^.. /gm, ''),
  ];
  return [...new Set(outputs.flatMap((output) => output.split('\n').map((line) => line.trim()).filter(Boolean)))].sort();
}

function invokeChangelogKeeper(cwd: string, template: string): void {
  const result = run('sp', ['script', 'changelog-keeper', '--read-only', '--template', template], cwd);
  if (result.stdout.trim()) process.stdout.write(result.stdout);
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status);
}

export function createReleaseCommand(): Command {
  return new Command('release')
    .description('Release flow for CHANGELOG.md, package.json, and dist/')
    .addCommand(createReleasePrepareCommand())
    .addCommand(createReleasePublishCommand());
}

function createReleasePrepareCommand(): Command {
  return new Command('prepare')
    .option('--major', 'Bump major version', false)
    .option('--minor', 'Bump minor version', false)
    .option('--patch', 'Bump patch version', false)
    .option('--from <ref>', 'Start ref for report range')
    .option('--to <ref>', 'End ref for report range')
    .action((opts: { major: boolean; minor: boolean; patch: boolean; from?: string; to?: string }) => {
      const cwd = process.cwd();
      assertReleaseScopeClean(cwd);
      const from = opts.from ?? getLatestTag(cwd);
      const to = opts.to ?? 'HEAD';
      const versionMode = opts.major ? 'major' : opts.minor ? 'minor' : 'patch';
      const reports = listXtReports({ since: from, to, rootDir: cwd });
      const bundle = buildReportBundle(reports);
      if (bundle.reports.length === 0) {
        console.error(kleur.red('\n  ✗ No xt reports in range.\n'));
        process.exit(1);
      }

      const template = buildReleaseTemplate({ from, to, bundle: bundle.output, versionMode });
      invokeChangelogKeeper(cwd, template);
    });
}

function createReleasePublishCommand(): Command {
  return new Command('publish')
    .option('--gh-release', 'Create GitHub release after tag push', false)
    .action((opts: { ghRelease: boolean }) => {
      const cwd = process.cwd();
      assertReleaseScopeClean(cwd);
      const tag = getReleaseTag(cwd);

      const tagResult = run('git', ['tag', '-a', tag, '-m', `release: ${tag}`], cwd);
      if (tagResult.status !== 0) {
        process.stderr.write(tagResult.stderr || tagResult.stdout);
        process.exit(tagResult.status);
      }

      const pushResult = run('git', ['push', '--follow-tags'], cwd);
      if (pushResult.stdout.trim()) process.stdout.write(pushResult.stdout);
      if (pushResult.stderr.trim()) process.stderr.write(pushResult.stderr);
      if (pushResult.status !== 0) process.exit(pushResult.status);

      if (opts.ghRelease) {
        const ghResult = run('gh', ['release', 'create', tag, '--generate-notes'], cwd);
        if (ghResult.stdout.trim()) process.stdout.write(ghResult.stdout);
        if (ghResult.stderr.trim()) process.stderr.write(ghResult.stderr);
        if (ghResult.status !== 0) process.exit(ghResult.status);
      }
    });
}
