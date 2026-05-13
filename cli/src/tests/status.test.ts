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
vi.mock('../core/context.js', () => ({ getCandidatePaths: getCandidatePathsMock }));
vi.mock('../utils/repo-root.js', () => ({ findRepoRoot: findRepoRootMock }));

import { createStatusCommand } from '../commands/status.js';

let tmpDir = '';
let previousCwd = '';
let previousIsTTY: boolean | undefined;

beforeEach(() => {
  previousCwd = process.cwd();
  previousIsTTY = process.stdin.isTTY;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-status-test-'));
  process.chdir(tmpDir);
  fs.ensureDirSync(path.join(tmpDir, '.xtrm'));
  fs.ensureDirSync(path.join(tmpDir, 'env-a'));
  getCandidatePathsMock.mockReturnValue([{ path: path.join(tmpDir, 'env-a') }]);
  findRepoRootMock.mockResolvedValue(tmpDir);
  calculateDiffMock.mockResolvedValue({
    packageA: { missing: ['a'], outdated: [], drifted: [] },
  });
  promptsMock.mockReset();
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.removeSync(tmpDir);
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
});
