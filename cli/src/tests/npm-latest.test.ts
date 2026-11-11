import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkXtrmUpdates, formatUpdateRows, updatesSummary, XTRM_PACKAGES, type XtrmPackage } from '../utils/npm-latest.js';

// CORE-2612: register every scratch dir so the file removes it, including when a
// test fails before its own cleanup.
const tempDirs: string[] = [];

function tmpCacheFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'npm-latest-'));
  tempDirs.push(dir);
  return path.join(dir, 'npm-latest.json');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixedNow = () => 1_700_000_000_000;

describe('npm-latest', () => {
  let cacheFile: string;
  beforeEach(() => { cacheFile = tmpCacheFile(); });

  it('fresh fetch when cache is missing → writes cache and reports ok/stale', () => {
    const statuses = checkXtrmUpdates({
      cacheFile,
      now: fixedNow,
      installedResolver: (pkg) => ({
        'xtrm-tools': '0.11.2',
        '@jaggerxtrm/xtmux': '0.9.0',
        '@jaggerxtrm/specialists': '0.5.0',
      } as Record<XtrmPackage, string>)[pkg],
      npmView: (pkg) => ({
        'xtrm-tools': '0.11.2',
        '@jaggerxtrm/xtmux': '0.9.1',
        '@jaggerxtrm/specialists': '0.5.0',
      } as Record<string, string>)[pkg] ?? null,
    });
    expect(statuses.find((s) => s.pkg === 'xtrm-tools')?.state).toBe('ok');
    expect(statuses.find((s) => s.pkg === '@jaggerxtrm/xtmux')?.state).toBe('stale');
    expect(statuses.every((s) => !s.fromCache)).toBe(true);
    const persisted = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(persisted['xtrm-tools']).toMatchObject({ latest: '0.11.2', fetchedAt: fixedNow() });
  });

  it('second call within TTL uses cache and does not call npmView', () => {
    for (const pkg of XTRM_PACKAGES) {
      // seed cache
    }
    writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(XTRM_PACKAGES.map((p) => [p, { latest: '9.9.9', fetchedAt: fixedNow() - 1000 }]))));
    let npmViewCalls = 0;
    const statuses = checkXtrmUpdates({
      cacheFile,
      now: fixedNow,
      installedResolver: () => '9.9.9',
      npmView: () => { npmViewCalls += 1; return '9.9.9'; },
    });
    expect(npmViewCalls).toBe(0);
    expect(statuses.every((s) => s.fromCache)).toBe(true);
    expect(statuses.every((s) => s.state === 'ok')).toBe(true);
  });

  it('stale cache (past TTL) triggers a fresh fetch', () => {
    writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(XTRM_PACKAGES.map((p) => [p, { latest: '1.0.0', fetchedAt: fixedNow() - 25 * 60 * 60 * 1000 }]))));
    let npmViewCalls = 0;
    const statuses = checkXtrmUpdates({
      cacheFile,
      now: fixedNow,
      installedResolver: () => '2.0.0',
      npmView: () => { npmViewCalls += 1; return '2.0.0'; },
    });
    expect(npmViewCalls).toBe(XTRM_PACKAGES.length);
    expect(statuses.every((s) => s.state === 'ok')).toBe(true);
  });

  it('--no-cache forces refetch even when cache is fresh', () => {
    writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(XTRM_PACKAGES.map((p) => [p, { latest: '9.9.9', fetchedAt: fixedNow() }]))));
    let npmViewCalls = 0;
    checkXtrmUpdates({
      cacheFile,
      noCache: true,
      now: fixedNow,
      installedResolver: () => '9.9.9',
      npmView: () => { npmViewCalls += 1; return '9.9.9'; },
    });
    expect(npmViewCalls).toBe(XTRM_PACKAGES.length);
  });

  it('no network + no cache → state=unknown, does not throw, does not write cache', () => {
    const statuses = checkXtrmUpdates({
      cacheFile,
      now: fixedNow,
      installedResolver: () => '1.0.0',
      npmView: () => null,
    });
    expect(statuses.every((s) => s.state === 'unknown')).toBe(true);
    expect(statuses.every((s) => s.latest === null)).toBe(true);
    expect(existsSync(cacheFile)).toBe(false);
  });

  it('no network + expired cache → shows cached latest for info but state stays unknown (never asserts unverified freshness)', () => {
    // Regression against a Codex-flagged bug: an expired cache combined with
    // a failed npm lookup used to be reported as [ok] when the installed
    // version happened to match the stale cached value. That claim is a lie —
    // a newer release could have shipped in the meantime.
    writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(XTRM_PACKAGES.map((p) => [p, { latest: '3.0.0', fetchedAt: fixedNow() - 48 * 60 * 60 * 1000 }]))));
    const statuses = checkXtrmUpdates({
      cacheFile,
      now: fixedNow,
      installedResolver: () => '3.0.0',
      npmView: () => null,
    });
    expect(statuses.every((s) => s.latest === '3.0.0')).toBe(true);
    expect(statuses.every((s) => s.fromCache)).toBe(true);
    expect(statuses.every((s) => s.state === 'unknown')).toBe(true);
  });

  it('dangling / unreadable installed version → state=not-installed, does not throw', () => {
    const statuses = checkXtrmUpdates({
      cacheFile,
      now: fixedNow,
      installedResolver: () => null,
      npmView: () => '1.0.0',
    });
    expect(statuses.every((s) => s.state === 'not-installed')).toBe(true);
    expect(statuses.every((s) => s.installed === null)).toBe(true);
  });

  it('corrupt cache file is treated as empty (no throw) and overwritten on next successful fetch', () => {
    writeFileSync(cacheFile, '{not valid json}');
    const statuses = checkXtrmUpdates({
      cacheFile,
      now: fixedNow,
      installedResolver: () => '1.0.0',
      npmView: () => '1.0.0',
    });
    expect(statuses.every((s) => s.state === 'ok')).toBe(true);
    const persisted = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(persisted['xtrm-tools']).toMatchObject({ latest: '1.0.0' });
  });

  it('formatUpdateRows produces one row per package with the compact contract', () => {
    const statuses = checkXtrmUpdates({
      cacheFile,
      now: fixedNow,
      installedResolver: (pkg) => (pkg === 'xtrm-tools' ? '0.11.2' : null),
      npmView: (pkg) => (pkg === 'xtrm-tools' ? '0.11.3' : null),
    });
    const rows = formatUpdateRows(statuses);
    expect(rows).toHaveLength(XTRM_PACKAGES.length);
    expect(rows[0]).toMatch(/xtrm-tools\s+installed=0\.11\.2\s+latest=0\.11\.3\s+\[stale\]/);
    expect(rows.some((r) => r.includes('installed=not-installed'))).toBe(true);
    expect(rows.some((r) => r.includes('latest=unknown'))).toBe(true);
  });

  it('updatesSummary tallies stale/unknown/not-installed', () => {
    const s = updatesSummary([
      { pkg: 'xtrm-tools', installed: '1', latest: '2', state: 'stale', fromCache: false, cacheAgeMs: 0 },
      { pkg: '@jaggerxtrm/xtmux', installed: '1', latest: null, state: 'unknown', fromCache: false, cacheAgeMs: null },
      { pkg: '@jaggerxtrm/specialists', installed: null, latest: '1', state: 'not-installed', fromCache: false, cacheAgeMs: 0 },
    ]);
    expect(s).toEqual({ stale: 1, unknown: 1, notInstalled: 1 });
  });
});
