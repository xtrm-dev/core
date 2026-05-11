import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mocked.spawnSync,
}));

describe('end beads symlink guard', () => {
  beforeEach(() => {
    mocked.spawnSync.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockGitRawDiff(stdout: string, ok = true): void {
    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--raw') {
        return { status: ok ? 0 : 1, stdout: `${stdout}\n`, stderr: ok ? '' : 'diff failed' };
      }

      return { status: 0, stdout: '', stderr: '' };
    });
  }

  it('allows clean diff with no .beads paths', async () => {
    mockGitRawDiff(':100644 100644 abcdef1 abcdef2 M\tcli/src/index.ts');
    const { findBeadsSymlinkIntroductions } = await import('../commands/end.js');

    expect(findBeadsSymlinkIntroductions('/repo', 'origin/main')).toEqual([]);
  });

  it('allows normal .beads file changes without symlink mode', async () => {
    mockGitRawDiff(':100644 100644 abcdef1 abcdef2 M\t.beads/issues.jsonl');
    const { findBeadsSymlinkIntroductions } = await import('../commands/end.js');

    expect(findBeadsSymlinkIntroductions('/repo', 'origin/main')).toEqual([]);
  });

  it('blocks .beads symlink introductions', async () => {
    mockGitRawDiff(':000000 120000 0000000 abcdef2 A\t.beads/test-symlink');
    const { findBeadsSymlinkIntroductions } = await import('../commands/end.js');

    expect(findBeadsSymlinkIntroductions('/repo', 'origin/main')).toEqual(['.beads/test-symlink']);
  });
});
