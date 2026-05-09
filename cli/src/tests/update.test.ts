import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { checkDriftMock, runInstallMock, assureXtManagedPiPackagesMock } = vi.hoisted(() => ({
  checkDriftMock: vi.fn(),
  runInstallMock: vi.fn(),
  assureXtManagedPiPackagesMock: vi.fn(),
}));

vi.mock('../core/drift.js', () => ({
  checkDrift: checkDriftMock,
}));

vi.mock('../core/pi-runtime.js', () => ({
  assureXtManagedPiPackages: assureXtManagedPiPackagesMock,
}));

vi.mock('../commands/install.js', () => ({
  runInstall: runInstallMock,
  isStrictRegistryMode: (opts: { strictRegistry?: boolean }) => opts.strictRegistry ?? process.env.XTRM_STRICT_REGISTRY === '1',
}));

import { createUpdateCommand } from '../commands/update.js';

let tmpDir = '';
let previousCwd = '';

beforeEach(() => {
  previousCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-update-test-'));
  process.chdir(tmpDir);
  checkDriftMock.mockReset();
  runInstallMock.mockReset();
  assureXtManagedPiPackagesMock.mockReset();
  assureXtManagedPiPackagesMock.mockResolvedValue({
    statuses: [],
    missing: [],
    outdated: [],
    installed: [],
    refreshed: [],
    failed: [],
  });
});

afterEach(() => {
  process.chdir(previousCwd);
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

function writeRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  fs.ensureDirSync(path.join(repo, '.xtrm'));
  fs.writeJsonSync(path.join(repo, '.xtrm', 'registry.json'), { version: '1', assets: {} }, { spaces: 2 });
  return repo;
}

describe('xtrm update', () => {
  it('dry-run prints repo status and package freshness without writes', async () => {
    writeRepo(tmpDir, 'repo-a');
    checkDriftMock.mockResolvedValue({ missing: ['a'], upToDate: [], drifted: ['b'] });
    assureXtManagedPiPackagesMock.mockResolvedValue({
      statuses: [{ pkg: { id: 'npm:pi-gitnexus', displayName: 'pi-gitnexus', required: true }, npmPackageName: 'pi-gitnexus', installedVersion: '1.0.0', expectedVersion: '1.1.0', state: 'outdated' }],
      missing: [],
      outdated: [{ pkg: { id: 'npm:pi-gitnexus', displayName: 'pi-gitnexus', required: true }, npmPackageName: 'pi-gitnexus', installedVersion: '1.0.0', expectedVersion: '1.1.0', state: 'outdated' }],
      installed: [],
      refreshed: [],
      failed: [],
    });

    const result = await runUpdateCli(['--repo', path.join(tmpDir, 'repo-a')]);

    expect(runInstallMock).not.toHaveBeenCalled();
    expect(assureXtManagedPiPackagesMock).toHaveBeenCalledWith(false);
    expect(result.logs.join('\n')).toContain('refreshed');
    expect(result.logs.join('\n')).toContain('outdated');
  });

  it('apply refreshes drifted repo and refreshes only stale global pi packages', async () => {
    const repo = writeRepo(tmpDir, 'repo-a');
    checkDriftMock.mockResolvedValue({ missing: ['a'], upToDate: [], drifted: ['b'] });
    runInstallMock.mockResolvedValue(undefined);
    assureXtManagedPiPackagesMock.mockResolvedValue({
      statuses: [
        { pkg: { id: 'npm:pi-gitnexus', displayName: 'pi-gitnexus', required: true }, npmPackageName: 'pi-gitnexus', installedVersion: null, expectedVersion: '1.0.0', state: 'missing' },
        { pkg: { id: 'npm:pi-serena-tools', displayName: 'pi-serena-tools', required: true }, npmPackageName: 'pi-serena-tools', installedVersion: '1.0.0', expectedVersion: '1.1.0', state: 'outdated' },
        { pkg: { id: 'npm:@aliou/pi-processes', displayName: 'pi-processes', required: true }, npmPackageName: 'pi-processes', installedVersion: '1.0.0', expectedVersion: '1.0.0', state: 'current' },
      ],
      missing: [{ pkg: { id: 'npm:pi-gitnexus', displayName: 'pi-gitnexus', required: true }, npmPackageName: 'pi-gitnexus', installedVersion: null, expectedVersion: '1.0.0', state: 'missing' }],
      outdated: [{ pkg: { id: 'npm:pi-serena-tools', displayName: 'pi-serena-tools', required: true }, npmPackageName: 'pi-serena-tools', installedVersion: '1.0.0', expectedVersion: '1.1.0', state: 'outdated' }],
      installed: ['npm:pi-gitnexus'],
      refreshed: ['npm:pi-serena-tools'],
      failed: [],
    });

    const first = await runUpdateCli(['--apply', '--repo', repo]);

    expect(runInstallMock).toHaveBeenCalledTimes(1);
    expect(assureXtManagedPiPackagesMock).toHaveBeenCalledWith(true);
    expect(first.logs.join('\n')).toContain('refreshed');
    expect(first.logs.join('\n')).toContain('missing');
    expect(first.logs.join('\n')).toContain('outdated');
  });

  it('root walk updates every managed repo and continues after failures', async () => {
    const root = path.join(tmpDir, 'root');
    const repoA = writeRepo(root, 'a');
    const repoB = writeRepo(root, 'b');
    const repoC = writeRepo(root, 'c');

    checkDriftMock
      .mockResolvedValueOnce({ missing: ['x'], upToDate: [], drifted: [] })
      .mockRejectedValueOnce(new Error('broken repo'))
      .mockResolvedValueOnce({ missing: [], upToDate: ['x'], drifted: [] });
    runInstallMock.mockResolvedValue(undefined);
    assureXtManagedPiPackagesMock.mockResolvedValue({
      statuses: [], missing: [], outdated: [], installed: [], refreshed: [], failed: [],
    });

    const result = await runUpdateCli(['--apply', '--root', root]);

    expect(runInstallMock).toHaveBeenCalledTimes(1);
    expect(result.logs.join('\n')).toContain(repoA);
    expect(result.logs.join('\n')).toContain(repoB);
    expect(result.logs.join('\n')).toContain(repoC);
    expect(result.logs.join('\n')).toContain('failed');
  });

  it('json output is valid JSON', async () => {
    const repo = writeRepo(tmpDir, 'repo-a');
    checkDriftMock.mockResolvedValue({ missing: [], upToDate: ['a'], drifted: [] });
    assureXtManagedPiPackagesMock.mockResolvedValue({
      statuses: [], missing: [], outdated: [], installed: [], refreshed: [], failed: [],
    });

    const result = await runUpdateCli(['--json', '--repo', repo]);

    expect(result.json).toEqual({ repos: [{ repo, status: 'already-current' }], packages: { statuses: [], missing: [], outdated: [], installed: [], refreshed: [], failed: [] } });
  });

  it('apply exits non-zero in strict registry env when registry source missing', async () => {
    const repo = writeRepo(tmpDir, 'repo-a');
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

  it('help mentions package freshness and refresh behavior', async () => {
    const command = createUpdateCommand();
    const help = await command.helpInformation();
    expect(help).toContain('global xt Pi packages');
    expect(help).toContain('missing or outdated packages');
  });
});
