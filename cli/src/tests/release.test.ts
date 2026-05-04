import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { buildReleaseTemplate, getPackageVersion, getReleaseTag, getReleaseScopeViolations } from '../commands/release.js';
import { buildReportBundle, getCommitDate, listXtReports } from '../core/xt-reports.js';

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xt-release-'));
  git(['init'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test User'], dir);
  mkdirSync(path.join(dir, 'cli'), { recursive: true });
  writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n');
  writeFileSync(path.join(dir, 'cli', 'package.json'), '{"version":"1.2.3"}');
  mkdirSync(path.join(dir, '.xtrm', 'reports'), { recursive: true });
  writeFileSync(path.join(dir, '.xtrm', 'reports', '2026-01-01-a.md'), 'report one');
  writeFileSync(path.join(dir, '.xtrm', 'reports', '2026-01-02-b.md'), 'report two');
  writeFileSync(path.join(dir, '.xtrm', 'reports', '2025-12-31-old.md'), 'old');
  git(['add', '.'], dir);
  git(['commit', '-m', 'base'], dir, { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
  git(['tag', '-a', 'v1.0.0', '-m', 'release v1.0.0'], dir);
  return dir;
}

describe('release helper', () => {
  it('reads commit date from annotated tag commit', () => {
    const cwd = initRepo();
    const date = getCommitDate('v1.0.0', cwd);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('builds non-empty report bundle inside annotated-tag range', () => {
    const cwd = initRepo();
    git(['commit', '--allow-empty', '-m', 'later'], cwd, { GIT_AUTHOR_DATE: '2026-01-03T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-03T00:00:00Z' });
    const reports = listXtReports({ since: 'v1.0.0', to: 'HEAD', rootDir: cwd });
    expect(reports).toHaveLength(2);
    const bundle = buildReportBundle(reports);
    expect(bundle.output).toContain('2026-01-02-b.md');
    expect(bundle.output).toContain('2026-01-01-a.md');
    expect(bundle.output).not.toContain('2025-12-31-old.md');
    expect(bundle.output.length).toBeGreaterThan(0);
  });

  it('keeps prepare template shape', () => {
    const template = buildReleaseTemplate({ from: 'v1.0.0', to: 'HEAD', bundle: 'bundle-body', versionMode: 'patch' });
    expect(template).toContain('version_mode=patch');
    expect(template).toContain('range=v1.0.0..HEAD');
    expect(template).toContain('xt_reports:');
    expect(template).toContain('bundle-body');
  });

  it('derives publish tag from cli/package.json version', () => {
    const cwd = initRepo();
    expect(getPackageVersion(cwd)).toBe('1.2.3');
    expect(getReleaseTag(cwd)).toBe('v1.2.3');
  });

  it('rejects release scope when unstaged outside allowlist', () => {
    const cwd = initRepo();
    writeFileSync(path.join(cwd, 'notes.md'), 'dirty');
    expect(getReleaseScopeViolations(cwd)).toEqual(['notes.md']);
  });

  it('rejects release scope when staged outside allowlist', () => {
    const cwd = initRepo();
    writeFileSync(path.join(cwd, 'notes.md'), 'dirty');
    git(['add', 'notes.md'], cwd);
    expect(getReleaseScopeViolations(cwd)).toEqual(['notes.md']);
  });
});
