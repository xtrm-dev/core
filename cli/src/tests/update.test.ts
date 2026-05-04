import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { checkDriftMock, runInstallMock } = vi.hoisted(() => ({
  checkDriftMock: vi.fn(),
  runInstallMock: vi.fn(),
}));

vi.mock('../core/drift.js', () => ({
  checkDrift: checkDriftMock,
}));

vi.mock('../commands/install.js', () => ({
  runInstall: runInstallMock,
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
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.removeSync(tmpDir);
  vi.restoreAllMocks();
});

async function runUpdateCli(args: string[]): Promise<{ logs: string[]; json?: unknown }> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  });

  try {
    const command = createUpdateCommand();
    await command.parseAsync(['node', 'xtrm-update-test', ...args]);
    const jsonText = logs.join('\n');
    return { logs, json: jsonText.includes('{') ? JSON.parse(jsonText) : undefined };
  } finally {
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
  it('dry-run prints repo status without writes', async () => {
    writeRepo(tmpDir, 'repo-a');
    checkDriftMock.mockResolvedValue({ missing: ['a'], upToDate: [], drifted: ['b'] });

    const result = await runUpdateCli(['--repo', path.join(tmpDir, 'repo-a')]);

    expect(runInstallMock).not.toHaveBeenCalled();
    expect(result.logs.join('\n')).toContain('refreshed');
  });

  it('apply refreshes drifted repo and skips already-current repo', async () => {
    const repo = writeRepo(tmpDir, 'repo-a');
    checkDriftMock
      .mockResolvedValueOnce({ missing: ['a'], upToDate: [], drifted: ['b'] })
      .mockResolvedValueOnce({ missing: [], upToDate: ['a'], drifted: [] });
    runInstallMock.mockResolvedValue(undefined);

    const first = await runUpdateCli(['--apply', '--repo', repo]);
    const second = await runUpdateCli(['--apply', '--repo', repo]);

    expect(runInstallMock).toHaveBeenCalledTimes(1);
    expect(first.logs.join('\n')).toContain('refreshed');
    expect(second.logs.join('\n')).toContain('already-current');
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

    const result = await runUpdateCli(['--json', '--repo', repo]);

    expect(result.json).toEqual({ repos: [{ repo, status: 'already-current' }] });
  });
});
