import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

const mocked = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mocked.spawnSync,
}));

async function loadWorktreeModule() {
  vi.resetModules();
  return import('../commands/worktree.js');
}


function fakeTokenError(): string {
  return ['HTTP 401 ', 'token', '=fixture-secret'].join('');
}

function mockGhPrList(payload: unknown, status = 0, stderr = '') {
  mocked.spawnSync.mockReturnValue({
    status,
    stdout: typeof payload === 'string' ? payload : JSON.stringify(payload),
    stderr,
  });
}

describe('xt worktree PR status classification', () => {
  beforeEach(() => {
    mocked.spawnSync.mockReset();
  });

  it('returns no-pr when gh finds no pull request', async () => {
    mockGhPrList([]);
    const { getPrStatus } = await loadWorktreeModule();

    expect(getPrStatus('refs/heads/xt/no-pr', '/repo')).toMatchObject({
      component: 'xt.pr_status',
      branch: 'xt/no-pr',
      state: null,
      merge_state: null,
      classification: 'no-pr',
      outcome: 'no_pr',
    });
  });

  it('classifies an open CLEAN pull request as clean', async () => {
    mockGhPrList([{
      state: 'OPEN',
      url: 'https://github.com/acme/repo/pull/12',
      number: 12,
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
      headRefOid: 'head-sha',
      baseRefOid: 'base-sha',
    }]);
    const { getPrStatus } = await loadWorktreeModule();

    expect(getPrStatus('xt/clean', '/repo')).toMatchObject({
      branch: 'xt/clean',
      state: 'OPEN',
      merge_state: 'CLEAN',
      classification: 'clean',
      outcome: 'ok',
      pr_url: 'https://github.com/acme/repo/pull/12',
      pr_number: 12,
      head_sha: 'head-sha',
      base_sha: 'base-sha',
    });
  });

  it('classifies BEHIND as needs-rebase', async () => {
    mockGhPrList([{ state: 'OPEN', mergeStateStatus: 'BEHIND' }]);
    const { getPrStatus } = await loadWorktreeModule();

    expect(getPrStatus('xt/behind', '/repo').classification).toBe('needs-rebase');
  });

  it('classifies DIRTY as conflicted', async () => {
    mockGhPrList([{ state: 'OPEN', mergeStateStatus: 'DIRTY' }]);
    const { getPrStatus } = await loadWorktreeModule();

    expect(getPrStatus('xt/dirty', '/repo').classification).toBe('conflicted');
  });

  it('classifies BLOCKED as blocked', async () => {
    mockGhPrList([{ state: 'OPEN', mergeStateStatus: 'BLOCKED' }]);
    const { getPrStatus } = await loadWorktreeModule();

    expect(getPrStatus('xt/blocked', '/repo').classification).toBe('blocked');
  });

  it('classifies closed and merged PRs as closed', async () => {
    const { getPrStatus } = await loadWorktreeModule();

    mockGhPrList([{ state: 'CLOSED', mergeStateStatus: 'UNKNOWN' }]);
    expect(getPrStatus('xt/closed', '/repo').classification).toBe('closed');

    mockGhPrList([{ state: 'MERGED', mergeStateStatus: 'CLEAN' }]);
    expect(getPrStatus('xt/merged', '/repo')).toMatchObject({
      state: 'MERGED',
      classification: 'closed',
    });
  });


  it('resolves base_ref/base_sha from baseRefName when baseRefOid is unavailable', async () => {
    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'gh') {
        return {
          status: 0,
          stdout: JSON.stringify([{ state: 'OPEN', mergeStateStatus: 'CLEAN', baseRefName: 'main' }]),
          stderr: '',
        };
      }
      if (command === 'git' && args.join(' ') === 'rev-parse origin/main') {
        return { status: 0, stdout: 'base-sha-from-git\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    });
    const { getPrStatus } = await loadWorktreeModule();

    expect(getPrStatus('xt/base-ref', '/repo')).toMatchObject({
      classification: 'clean',
      base_ref: 'main',
      base_sha: 'base-sha-from-git',
    });
  });

  it('returns unknown with redacted gh error on gh failure', async () => {
    mockGhPrList('', 1, fakeTokenError());
    const { getPrStatus } = await loadWorktreeModule();

    expect(getPrStatus('xt/fail', '/repo')).toMatchObject({
      classification: 'unknown',
      outcome: 'error',
      error: 'HTTP 401 token=[redacted]',
    });
  });

  it('falls back to mergeable when mergeStateStatus is unavailable', async () => {
    mockGhPrList([{ state: 'OPEN', mergeable: 'CONFLICTING' }]);
    const { getPrStatus } = await loadWorktreeModule();

    expect(getPrStatus('xt/fallback', '/repo')).toMatchObject({
      merge_state: null,
      classification: 'conflicted',
    });
  });
});

describe('xt worktree audit-prs command', () => {
  beforeEach(() => {
    mocked.spawnSync.mockReset();
  });

  function installAuditSpawnMock(repoRoot = '/repo') {
    mocked.spawnSync.mockImplementation((command: string, args: string[], options: { cwd?: string } = {}) => {
      const joined = args.join(' ');

      if (command === 'git' && joined === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: `${repoRoot}/.git\n`, stderr: '' };
      }

      if (command === 'git' && joined === 'worktree list --porcelain') {
        return {
          status: 0,
          stdout: [
            `worktree ${repoRoot}`,
            'HEAD root-head',
            'branch refs/heads/main',
            '',
            `worktree ${repoRoot}/.xtrm/worktrees/repo-xt-clean`,
            'HEAD clean-head',
            'branch refs/heads/xt/clean',
            '',
            `worktree ${repoRoot}/.xtrm/worktrees/repo-xt-behind`,
            'HEAD behind-head',
            'branch refs/heads/xt/behind',
            '',
            `worktree ${repoRoot}/.xtrm/worktrees/repo-xt-dirty`,
            'HEAD dirty-head',
            'branch refs/heads/xt/dirty',
            '',
            `worktree ${repoRoot}/.xtrm/worktrees/repo-xt-blocked`,
            'HEAD blocked-head',
            'branch refs/heads/xt/blocked',
          ].join('\n'),
          stderr: '',
        };
      }

      if (command === 'git' && args[0] === 'log') {
        return { status: 0, stdout: '2026-06-28 12:00:00 +0000\x1fcommit subject\n', stderr: '' };
      }

      if (command === 'git' && joined === 'rev-parse origin/main') {
        return { status: 0, stdout: 'base-sha\n', stderr: '' };
      }

      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        const head = args[args.indexOf('--head') + 1];
        const byHead: Record<string, unknown[]> = {
          'xt/clean': [{ state: 'OPEN', url: 'https://example.test/pr/1', number: 1, mergeStateStatus: 'CLEAN', headRefOid: 'clean-head', baseRefName: 'main' }],
          'xt/behind': [{ state: 'OPEN', url: 'https://example.test/pr/2', number: 2, mergeStateStatus: 'BEHIND', headRefOid: 'behind-head', baseRefName: 'main' }],
          'xt/dirty': [{ state: 'OPEN', url: 'https://example.test/pr/3', number: 3, mergeStateStatus: 'DIRTY', headRefOid: 'dirty-head', baseRefName: 'main' }],
          'xt/blocked': [{ state: 'OPEN', url: 'https://example.test/pr/4', number: 4, mergeStateStatus: 'BLOCKED', headRefOid: 'blocked-head', baseRefName: 'main' }],
        };
        return { status: 0, stdout: JSON.stringify(byHead[head] ?? []), stderr: '' };
      }

      return { status: 1, stdout: '', stderr: `unexpected command ${command} ${joined} cwd=${options.cwd ?? ''}` };
    });
  }

  async function runAuditCli(args: string[]): Promise<string[]> {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      logs.push(values.map(String).join(' '));
    });

    try {
      const { createWorktreeCommand } = await loadWorktreeModule();
      const command = createWorktreeCommand();
      await command.parseAsync(['node', 'xt-worktree-test', 'audit-prs', ...args]);
      return logs;
    } finally {
      spy.mockRestore();
    }
  }

  it('prints human audit output for mixed PR states without modifying branches', async () => {
    installAuditSpawnMock();

    const logs = await runAuditCli([]);
    const output = logs.join('\n');

    expect(output).toContain('xt worktree PR audit');
    expect(output).toContain('operator attention: 3');
    expect(output).toContain('xt/behind needs-rebase');
    expect(output).toContain('xt/dirty conflicted');
    expect(output).toContain('xt/blocked blocked');
    expect(output).toContain('push --force-with-lease');
    expect(mocked.spawnSync.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('rebase'))).toBe(false);
    expect(mocked.spawnSync.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('push'))).toBe(false);
  });

  it('prints JSON audit findings with required telemetry fields', async () => {
    installAuditSpawnMock();

    const logs = await runAuditCli(['--json']);
    const parsed = JSON.parse(logs[0]);

    expect(parsed).toMatchObject({
      component: 'xt.pr_audit',
      repo: '/repo',
      summary: {
        clean: 1,
        'needs-rebase': 1,
        conflicted: 1,
        blocked: 1,
      },
    });
    expect(parsed.findings).toHaveLength(4);
    expect(parsed.findings.find((finding: { branch: string }) => finding.branch === 'xt/behind')).toMatchObject({
      component: 'xt.pr_audit.finding',
      repo: '/repo',
      branch: 'xt/behind',
      pr_url: 'https://example.test/pr/2',
      pr_number: 2,
      classification: 'needs-rebase',
      suggested_action: 'rebase branch onto the PR base, then push with --force-with-lease',
      suggestion_command: 'git -C /repo checkout xt/behind && git -C /repo rebase origin/main && git -C /repo push --force-with-lease',
    });
    expect(typeof parsed.findings[0].checked_at_ms).toBe('number');
  });
});

describe('xt worktree branch-gc command', () => {
  beforeEach(() => {
    mocked.spawnSync.mockReset();
  });

  function installBranchGcSpawnMock(repoRoot = '/repo') {
    mocked.spawnSync.mockImplementation((command: string, args: string[], options: { cwd?: string } = {}) => {
      const joined = args.join(' ');

      if (command === 'git' && joined === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: `${repoRoot}/.git\n`, stderr: '' };
      }

      if (command === 'git' && joined === 'for-each-ref --format=%(refname:short) refs/heads') {
        return {
          status: 0,
          stdout: ['main', 'xt/merged', 'xt/closed', 'xt/open', 'xt/unknown', 'xt/no-pr', 'sp/job-1'].join('\n'),
          stderr: '',
        };
      }

      if (command === 'git' && joined === 'worktree list --porcelain') {
        return { status: 0, stdout: [`worktree ${repoRoot}`, 'HEAD root-head', 'branch refs/heads/main'].join('\n'), stderr: '' };
      }

      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        const head = args[args.indexOf('--head') + 1];
        if (head === 'xt/unknown') {
          return { status: 1, stdout: '', stderr: fakeTokenError() };
        }
        const byHead: Record<string, unknown[]> = {
          'xt/merged': [{ state: 'MERGED', url: 'https://example.test/pr/10', number: 10, mergeStateStatus: 'CLEAN' }],
          'xt/closed': [{ state: 'CLOSED', url: 'https://example.test/pr/11', number: 11, mergeStateStatus: 'UNKNOWN' }],
          'xt/open': [{ state: 'OPEN', url: 'https://example.test/pr/12', number: 12, mergeStateStatus: 'BEHIND' }],
          'xt/no-pr': [],
        };
        return { status: 0, stdout: JSON.stringify(byHead[head] ?? []), stderr: '' };
      }

      if (command === 'git' && args[0] === 'branch' && args[1] === '-D') {
        return { status: 0, stdout: `Deleted branch ${args[2]}\n`, stderr: '' };
      }

      return { status: 1, stdout: '', stderr: `unexpected command ${command} ${joined} cwd=${options.cwd ?? ''}` };
    });
  }

  async function runBranchGcCli(args: string[]): Promise<string[]> {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      logs.push(values.map(String).join(' '));
    });

    try {
      const { createWorktreeCommand } = await loadWorktreeModule();
      const command = createWorktreeCommand();
      await command.parseAsync(['node', 'xt-worktree-test', 'branch-gc', ...args]);
      return logs;
    } finally {
      spy.mockRestore();
    }
  }

  it('dry-runs merged/closed branch deletion and skips active/unknown/no-pr branches', async () => {
    installBranchGcSpawnMock();

    const logs = await runBranchGcCli(['--json']);
    const parsed = JSON.parse(logs[0]);

    expect(parsed).toMatchObject({
      component: 'xt.branch_gc',
      repo: '/repo',
      mode: 'dry_run',
      prefixes: ['xt/'],
      summary: { delete: 2, skip: 3, deleted: 0, failed: 0 },
    });
    expect(parsed.findings.find((finding: { branch: string }) => finding.branch === 'xt/merged')).toMatchObject({
      action: 'delete',
      pr_state: 'MERGED',
      reason: 'PR is merged',
      outcome: 'dry_run',
      command: 'git -C /repo branch -D xt/merged',
    });
    expect(parsed.findings.find((finding: { branch: string }) => finding.branch === 'xt/closed')).toMatchObject({
      action: 'delete',
      pr_state: 'CLOSED',
      reason: 'PR is closed',
      outcome: 'dry_run',
    });
    expect(parsed.findings.find((finding: { branch: string }) => finding.branch === 'xt/open')).toMatchObject({
      action: 'skip',
      classification: 'needs-rebase',
      reason: 'PR is active (needs-rebase)',
      outcome: 'skipped',
    });
    expect(parsed.findings.find((finding: { branch: string }) => finding.branch === 'xt/unknown')).toMatchObject({
      action: 'skip',
      classification: 'unknown',
      outcome: 'skipped',
      error: 'HTTP 401 token=[redacted]',
    });
    expect(parsed.findings.some((finding: { branch: string }) => finding.branch === 'sp/job-1')).toBe(false);
    expect(mocked.spawnSync.mock.calls.some(([, args]) => Array.isArray(args) && args.join(' ') === 'branch -D xt/merged')).toBe(false);
  });

  it('prints human dry-run output with exact delete commands', async () => {
    installBranchGcSpawnMock();

    const logs = await runBranchGcCli([]);
    const output = logs.join('\n');

    expect(output).toContain('xt worktree branch GC');
    expect(output).toContain('mode: dry_run');
    expect(output).toContain('delete candidates: 2');
    expect(output).toContain('git -C /repo branch -D xt/merged');
    expect(output).toContain('Dry run — no branches deleted');
  });

  it('apply mode requires explicit --apply --yes and deletes only safe candidates', async () => {
    installBranchGcSpawnMock();

    const logs = await runBranchGcCli(['--apply', '--yes', '--json']);
    const parsed = JSON.parse(logs[0]);

    expect(parsed).toMatchObject({
      mode: 'apply',
      summary: { delete: 2, skip: 3, deleted: 2, failed: 0 },
    });
    expect(parsed.findings.find((finding: { branch: string }) => finding.branch === 'xt/merged')).toMatchObject({
      action: 'delete',
      outcome: 'deleted',
    });
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'xt/merged'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'xt/closed'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(mocked.spawnSync.mock.calls.some(([, args]) => Array.isArray(args) && args.join(' ') === 'branch -D xt/open')).toBe(false);
  });
});

describe('xt worktree restart-audit command', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-restart-audit-'));
    mocked.spawnSync.mockReset();
    vi.spyOn(Date, 'now').mockReturnValue(1782660000000);
  });

  afterEach(async () => {
    await fs.remove(tempRoot);
    vi.restoreAllMocks();
  });

  function installRestartAuditSpawnMock(repoRoot = path.join(tempRoot, 'repo')) {
    const orphanDir = path.join(repoRoot, '.xtrm', 'worktrees', 'orphan-dir');
    fs.ensureDirSync(orphanDir);

    mocked.spawnSync.mockImplementation((command: string, args: string[], options: { cwd?: string } = {}) => {
      const joined = args.join(' ');

      if (command === 'git' && joined === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: `${repoRoot}/.git\n`, stderr: '' };
      }

      if (command === 'git' && joined === 'worktree list --porcelain') {
        return {
          status: 0,
          stdout: [
            `worktree ${repoRoot}`,
            'HEAD root-head',
            'branch refs/heads/main',
            '',
            `worktree ${path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-rebase')}`,
            'HEAD rebase-head',
            'branch refs/heads/xt/rebase',
            '',
            `worktree ${path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-closed')}`,
            'HEAD closed-head',
            'branch refs/heads/xt/closed',
          ].join('\n'),
          stderr: '',
        };
      }

      if (command === 'git' && joined === 'for-each-ref --format=%(refname:short) refs/heads') {
        return {
          status: 0,
          stdout: ['main', 'xt/rebase', 'xt/conflict', 'xt/closed', 'xt/unknown', 'xt/no-worktree'].join('\n'),
          stderr: '',
        };
      }

      if (command === 'git' && args[0] === 'log') {
        return { status: 0, stdout: '2026-06-28 12:00:00 +0000\x1fcommit subject\n', stderr: '' };
      }

      if (command === 'git' && joined === 'rev-parse origin/main') {
        return { status: 0, stdout: 'base-sha\n', stderr: '' };
      }

      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        const head = args[args.indexOf('--head') + 1];
        if (head === 'xt/unknown') {
          return { status: 1, stdout: '', stderr: fakeTokenError() };
        }
        const byHead: Record<string, unknown[]> = {
          'xt/rebase': [{ state: 'OPEN', url: 'https://example.test/pr/20', number: 20, mergeStateStatus: 'BEHIND', baseRefName: 'main' }],
          'xt/conflict': [{ state: 'OPEN', url: 'https://example.test/pr/21', number: 21, mergeStateStatus: 'DIRTY', baseRefName: 'main' }],
          'xt/closed': [{ state: 'CLOSED', url: 'https://example.test/pr/22', number: 22, mergeStateStatus: 'UNKNOWN' }],
          'xt/no-worktree': [{ state: 'OPEN', url: 'https://example.test/pr/23', number: 23, mergeStateStatus: 'CLEAN', baseRefName: 'main' }],
        };
        return { status: 0, stdout: JSON.stringify(byHead[head] ?? []), stderr: '' };
      }

      return { status: 1, stdout: '', stderr: `unexpected command ${command} ${joined} cwd=${options.cwd ?? ''}` };
    });

    return { repoRoot, orphanDir };
  }

  async function runRestartAuditCli(args: string[]): Promise<string[]> {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      logs.push(values.map(String).join(' '));
    });

    try {
      const { createWorktreeCommand } = await loadWorktreeModule();
      const command = createWorktreeCommand();
      await command.parseAsync(['node', 'xt-worktree-test', 'restart-audit', ...args]);
      return logs;
    } finally {
      spy.mockRestore();
    }
  }

  it('prints idempotent JSON restart findings for orphan dirs, branch drift, PR attention, and closed PR cleanup', async () => {
    const { repoRoot, orphanDir } = installRestartAuditSpawnMock();

    const first = JSON.parse((await runRestartAuditCli(['--json']))[0]);
    const second = JSON.parse((await runRestartAuditCli(['--json']))[0]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      component: 'xt.restart_audit',
      repo: repoRoot,
      checked_at_ms: 1782660000000,
      prefixes: ['xt/'],
      summary: {
        'orphaned-managed-dir': 1,
        'branch-without-worktree': 3,
        'pr-attention': 3,
        'closed-pr-branch': 1,
      },
    });
    expect(first.findings.find((finding: { finding_kind: string }) => finding.finding_kind === 'orphaned-managed-dir')).toMatchObject({
      repo: repoRoot,
      worktree_path: orphanDir,
      branch: null,
      pr_classification: null,
      suggested_action: 'inspect orphaned managed directory, then run orphan cleanup if safe',
    });
    expect(first.findings.find((finding: { finding_kind: string; branch: string | null }) => finding.finding_kind === 'branch-without-worktree' && finding.branch === 'xt/no-worktree')).toMatchObject({
      worktree_path: null,
      branch: 'xt/no-worktree',
      pr_classification: 'clean',
    });
    expect(first.findings.find((finding: { finding_kind: string; branch: string | null }) => finding.finding_kind === 'pr-attention' && finding.branch === 'xt/rebase')).toMatchObject({
      worktree_path: path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-rebase'),
      branch: 'xt/rebase',
      pr_classification: 'needs-rebase',
      suggested_action: 'rebase branch onto the PR base, then push with --force-with-lease',
    });
    expect(first.findings.find((finding: { finding_kind: string; branch: string | null }) => finding.finding_kind === 'pr-attention' && finding.branch === 'xt/conflict')).toMatchObject({
      worktree_path: null,
      branch: 'xt/conflict',
      pr_classification: 'conflicted',
    });
    expect(first.findings.find((finding: { finding_kind: string; branch: string | null }) => finding.finding_kind === 'closed-pr-branch' && finding.branch === 'xt/closed')).toMatchObject({
      worktree_path: path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-closed'),
      branch: 'xt/closed',
      pr_classification: 'closed',
      suggested_action: 'PR is closed; finish/remove the worktree before branch cleanup',
    });
    expect(first.findings.find((finding: { branch: string | null; pr_classification: string | null }) => finding.branch === 'xt/unknown' && finding.pr_classification === 'unknown')).toMatchObject({
      error: 'HTTP 401 token=[redacted]',
    });
    expect(mocked.spawnSync.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('-D'))).toBe(false);
  });

  it('prints human restart audit output without destructive cleanup', async () => {
    installRestartAuditSpawnMock();

    const logs = await runRestartAuditCli([]);
    const output = logs.join('\n');

    expect(output).toContain('xt worktree restart audit');
    expect(output).toContain('orphaned-managed-dir');
    expect(output).toContain('branch-without-worktree');
    expect(output).toContain('pr-attention');
    expect(output).toContain('closed-pr-branch');
    expect(output).toContain('xt worktree branch-gc --prefix xt/ --json');
    expect(mocked.spawnSync.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('-D'))).toBe(false);
  });
});
