import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const promptsMock = vi.hoisted(() => vi.fn());
const calculateDiffMock = vi.hoisted(() => vi.fn());
const getCandidatePathsMock = vi.hoisted(() => vi.fn());
const findRepoRootMock = vi.hoisted(() => vi.fn());

vi.mock('prompts', () => ({ default: promptsMock }));
vi.mock('../core/diff.js', () => ({ calculateDiff: calculateDiffMock }));
vi.mock('../core/context.js', () => ({
  getCandidatePaths: getCandidatePathsMock,
  // Mirror the real module: the sync branch reads this resolver (CORE-2630).
  resolveConfProjectDir: () => storeDir,
}));
vi.mock('../utils/repo-root.js', () => ({ findRepoRoot: findRepoRootMock }));
const executeSyncMock = vi.hoisted(() => vi.fn());
vi.mock('../core/sync-executor.js', () => ({ executeSync: executeSyncMock }));

import { createStatusCommand } from '../commands/status.js';

let tmpDir = '';
let storeDir = '';
let previousCwd = '';
let previousIsTTY: boolean | undefined;

beforeEach(() => {
  previousCwd = process.cwd();
  previousIsTTY = process.stdin.isTTY;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-status-test-'));
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-status-store-'));
  process.chdir(tmpDir);
  fs.ensureDirSync(path.join(tmpDir, '.xtrm'));
  fs.ensureDirSync(path.join(tmpDir, 'env-a'));
  getCandidatePathsMock.mockReturnValue([{ path: path.join(tmpDir, 'env-a') }]);
  findRepoRootMock.mockResolvedValue(tmpDir);
  calculateDiffMock.mockResolvedValue({
    packageA: { missing: ['a'], outdated: [], drifted: [] },
  });
  executeSyncMock.mockReset();
  executeSyncMock.mockResolvedValue(1);
  promptsMock.mockReset();
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.removeSync(tmpDir);
  fs.removeSync(storeDir);
  Object.defineProperty(process.stdin, 'isTTY', { value: previousIsTTY, configurable: true });
  vi.restoreAllMocks();
});

async function runStatusCli(args: string[]): Promise<string[]> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  });

  try {
    const command = createStatusCommand();
    await command.parseAsync(['node', 'xtrm-status-test', ...args]);
    return logs;
  } finally {
    spy.mockRestore();
  }
}

describe('xt status command', () => {
  it.each([
    ['--check', 'check'],
    ['non-tty', 'non-tty'],
  ])('skips prompt and prints summary in %s mode', async (args, label) => {
    if (label === 'non-tty') {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    }

    const logs = await runStatusCli(label === 'check' ? ['--check'] : []);

    expect(promptsMock).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('pending change');
    expect(logs.join('\n')).toContain("Run 'xt sync' to apply.");
  });

  // CORE-2630 review: the sync branch reads `syncMode` from the shared store.
  // It used to build `new Conf({projectName:'xtrm-manager'})`, which resolved its
  // own path through env-paths and named a store nothing writes, so a user's
  // configured mode was always ignored. Reverting that line leaves this test red.
  it('honours the syncMode written to the shared store, not a private one', async () => {
    fs.outputJsonSync(path.join(storeDir, 'config.json'), { syncMode: 'symlink' });

    promptsMock.mockResolvedValue({ selected: [path.join(tmpDir, 'env-a')] });
    await runStatusCli([]);

    // The mode comes from the shared store. With the old `projectName:
    // 'xtrm-manager'` line this is 'copy', because nothing ever writes that store.
    expect(executeSyncMock).toHaveBeenCalled();
    expect(executeSyncMock.mock.calls[0][3]).toBe('symlink');
  });
});
