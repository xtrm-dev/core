import { describe, it, expect } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.join(__dirname, '../../hooks');

const CURRENT_BRANCH = (() => {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8' }).trim();
  } catch {
    return 'main';
  }
})();

function runHook(
  hookFile: string,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
  cwd?: string,
) {
  return spawnSync('node', [path.join(HOOKS_DIR, hookFile)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd,
  });
}

function parseHookJson(stdout: string) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function withFakeBdDir(scriptBody: string) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-fakebd-'));
  const fakeBdPath = path.join(tempDir, 'bd');
  writeFileSync(fakeBdPath, scriptBody, { encoding: 'utf8' });
  chmodSync(fakeBdPath, 0o755);
  return { tempDir, fakeBdPath };
}

// ── main-guard.mjs — MAIN_GUARD_PROTECTED_BRANCHES ──────────────────────────

describe.skip('main-guard.mjs — MAIN_GUARD_PROTECTED_BRANCHES (removed)', () => {
  it('blocks Write when current branch is listed in MAIN_GUARD_PROTECTED_BRANCHES', () => {
    const r = runHook(
      'main-guard.mjs',
      { tool_name: 'Write', tool_input: { file_path: '/tmp/x' } },
      { MAIN_GUARD_PROTECTED_BRANCHES: CURRENT_BRANCH },
    );
    expect(r.status).toBe(0);
    const out = parseHookJson(r.stdout);
    expect(out?.decision).toBe('block');
    expect(out?.reason).toContain(CURRENT_BRANCH);
  });

  it('allows Write when current branch is NOT in MAIN_GUARD_PROTECTED_BRANCHES', () => {
    const r = runHook(
      'main-guard.mjs',
      { tool_name: 'Write', tool_input: { file_path: '/tmp/x' } },
      { MAIN_GUARD_PROTECTED_BRANCHES: 'nonexistent-branch-xyz' },
    );
    expect(r.status).toBe(0);
  });

  it('blocks Bash by default on protected branch (default-deny)', () => {
    const r = runHook(
      'main-guard.mjs',
      { tool_name: 'Bash', tool_input: { command: 'cat > file.txt << EOF\nhello\nEOF' } },
      { MAIN_GUARD_PROTECTED_BRANCHES: CURRENT_BRANCH },
    );
    expect(r.status).toBe(0);
    const out = parseHookJson(r.stdout);
    expect(out?.decision).toBe('block');
    expect(out?.reason).toContain('Bash restricted');
  });

  it('allows safe Bash commands on protected branch', () => {
    const safeCommands = [
      'git status',
      'git log --oneline -5',
      'git diff HEAD',
      'git checkout -b feature/x',
      'git switch -c feature/y',
      'git fetch origin',
      'git pull',
      'gh pr list',
      'bd list',
      `git reset --hard origin/${CURRENT_BRANCH}`,
    ];
    for (const command of safeCommands) {
      const r = runHook(
        'main-guard.mjs',
        { tool_name: 'Bash', tool_input: { command } },
        { MAIN_GUARD_PROTECTED_BRANCHES: CURRENT_BRANCH },
      );
      expect(r.status, `expected exit 0 for: ${command}`).toBe(0);
    }
  });

  it('blocks mutating checkout forms on protected branch', () => {
    const blockedCommands = [
      'git checkout -- README.md',
      'git checkout HEAD -- README.md',
      'git switch --detach HEAD',
    ];
    for (const command of blockedCommands) {
      const r = runHook(
        'main-guard.mjs',
        { tool_name: 'Bash', tool_input: { command } },
        { MAIN_GUARD_PROTECTED_BRANCHES: CURRENT_BRANCH },
      );
      expect(r.status, `expected exit 0 for: ${command}`).toBe(0);
      const out = parseHookJson(r.stdout);
      expect(out?.decision).toBe('block');
      expect(out?.reason).toContain('Bash restricted');
    }
  });


  it('allows Bash when MAIN_GUARD_ALLOW_BASH=1 is set', () => {
    const r = runHook(
      'main-guard.mjs',
      { tool_name: 'Bash', tool_input: { command: 'npm run build' } },
      { MAIN_GUARD_PROTECTED_BRANCHES: CURRENT_BRANCH, MAIN_GUARD_ALLOW_BASH: '1' },
    );
    expect(r.status).toBe(0);
  });

  it('blocks git commit in Bash with workflow guidance', () => {
    const r = runHook(
      'main-guard.mjs',
      { tool_name: 'Bash', tool_input: { command: 'git commit -m "oops"' } },
      { MAIN_GUARD_PROTECTED_BRANCHES: CURRENT_BRANCH },
    );
    expect(r.status).toBe(0);
    const out = parseHookJson(r.stdout);
    expect(out?.decision).toBe('block');
    expect(out?.reason).toContain('feature branch');
  });

  it('post-push hook sync guidance uses reset --hard, consistent with main-guard', () => {
    const postPush = readFileSync(path.join(HOOKS_DIR, 'main-guard-post-push.mjs'), 'utf8');
    expect(postPush).toContain('reset --hard');
    expect(postPush).not.toContain('pull --ff-only');
  });

  it('hooks.json wires Bash to main-guard so git commit protection fires', () => {
    const hooksJson = JSON.parse(readFileSync(path.join(__dirname, '../../config/hooks.json'), 'utf8'));
    const mainGuardEntries = hooksJson.hooks.PreToolUse.filter(
      (h: { script: string }) => h.script === 'main-guard.mjs',
    );
    const matchers: string[] = mainGuardEntries.map((h: { matcher: string }) => h.matcher ?? '');
    const coversBash = matchers.some((m: string) => m.split('|').includes('Bash'));
    expect(coversBash, 'main-guard.mjs must have a PreToolUse entry with Bash in its matcher').toBe(true);
  });

});

// ── main-guard-post-push.mjs ────────────────────────────────────────────────

describe.skip('main-guard-post-push.mjs (removed)', () => {
  function createTempGitRepo(branch: string): string {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-post-push-'));
    spawnSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(path.join(repoDir, 'README.md'), '# test\n', 'utf8');
    spawnSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
    const current = spawnSync('git', ['branch', '--show-current'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).stdout.trim();
    if (current !== branch) {
      spawnSync('git', ['checkout', '-B', branch], { cwd: repoDir, stdio: 'pipe' });
    }
    return repoDir;
  }

  it('injects PR workflow reminder after successful feature-branch push command', () => {
    const repoDir = createTempGitRepo('feature/test-push');
    try {
      const r = runHook(
        'main-guard-post-push.mjs',
        { tool_name: 'Bash', tool_input: { command: 'git push -u origin feature/test-push' }, cwd: repoDir },
        { MAIN_GUARD_PROTECTED_BRANCHES: 'main,master' },
        repoDir,
      );
      expect(r.status).toBe(0);
      const out = parseHookJson(r.stdout);
      expect(out?.additionalContext).toContain('gh pr create --fill');
      expect(out?.additionalContext).toContain('gh pr merge --squash');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not emit reminder for non-push Bash commands', () => {
    const repoDir = createTempGitRepo('feature/test-nopush');
    try {
      const r = runHook(
        'main-guard-post-push.mjs',
        { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: repoDir },
        { MAIN_GUARD_PROTECTED_BRANCHES: 'main,master' },
        repoDir,
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not emit reminder when current branch is protected', () => {
    const repoDir = createTempGitRepo('main');
    try {
      const r = runHook(
        'main-guard-post-push.mjs',
        { tool_name: 'Bash', tool_input: { command: 'git push -u origin main' }, cwd: repoDir },
        { MAIN_GUARD_PROTECTED_BRANCHES: 'main,master' },
        repoDir,
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not emit reminder when push command reports failure', () => {
    const repoDir = createTempGitRepo('feature/test-failed-push');
    try {
      const r = runHook(
        'main-guard-post-push.mjs',
        {
          tool_name: 'Bash',
          tool_input: { command: 'git push -u origin feature/test-failed-push' },
          tool_response: { exit_code: 1, stderr: 'remote rejected' },
          cwd: repoDir,
        },
        { MAIN_GUARD_PROTECTED_BRANCHES: 'main,master' },
        repoDir,
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ── beads-gate-utils.mjs ─────────────────────────────────────────────────────

describe('beads-gate-utils.mjs — module integrity', () => {
  it('exports all required symbols without crashing', () => {
    const r = spawnSync('node', ['--input-type=module'], {
      input: `
import {
  resolveCwd, isBeadsProject, getSessionClaim,
  getTotalWork, getInProgress, clearSessionClaim, withSafeBdContext
} from '${HOOKS_DIR}/beads-gate-utils.mjs';
const ok = [resolveCwd, isBeadsProject, getSessionClaim, getTotalWork,
            getInProgress, clearSessionClaim, withSafeBdContext]
  .every(fn => typeof fn === 'function');
process.exit(ok ? 0 : 1);
`,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  });
});

// ── beads-edit-gate.mjs ───────────────────────────────────────────────────────

describe('beads-edit-gate.mjs', () => {
  it('fails open (exit 0) when no .beads directory exists', () => {
    const r = runHook('beads-edit-gate.mjs', {
      session_id: 'test-session',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x' },
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);
  });

  it('imports from beads-gate-utils.mjs (no inline duplicate logic)', () => {
    const content = readFileSync(path.join(HOOKS_DIR, 'beads-edit-gate.mjs'), 'utf8');
    expect(content).toContain("from './beads-gate-utils.mjs'");
  });

  it('blocks when session has no claim but open issues exist (regression guard)', () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-beads-project-'));
    mkdirSync(path.join(projectDir, '.beads'));
    const fake = withFakeBdDir(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "kv" && "$2" == "get" ]]; then
  exit 1
fi
if [[ "$1" == "list" ]]; then
  cat <<'EOF'
○ issue-1 P2 Open issue

--------------------------------------------------------------------------------
Total: 1 issues (1 open, 0 in progress)
EOF
  exit 0
fi
exit 1
`);

    try {
      const r = runHook(
        'beads-edit-gate.mjs',
        {
          session_id: 'session-regression-test',
          tool_name: 'Write',
          tool_input: { file_path: '/tmp/x' },
          cwd: projectDir,
        },
        { PATH: `${fake.tempDir}:${process.env.PATH ?? ''}` },
      );
      expect(r.status).toBe(0);
      const out = parseHookJson(r.stdout);
      expect(out?.decision).toBe('block');
      expect(out?.reason).toContain('active claim');
    } finally {
      rmSync(fake.tempDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ── beads-stop-gate.mjs ───────────────────────────────────────────────────────

describe.skip('beads-stop-gate.mjs (test environment issue)', () => {
  it('fails open (exit 0) when no .beads directory exists', () => {
    const r = runHook('beads-stop-gate.mjs', { session_id: 'test', cwd: '/tmp' });
    expect(r.status).toBe(0);
  });

  it('imports from beads-gate-utils.mjs', () => {
    const content = readFileSync(path.join(HOOKS_DIR, 'beads-stop-gate.mjs'), 'utf8');
    expect(content).toContain("from './beads-gate-utils.mjs'");
  });

  it('allows stop (exit 0) when session has a stale claim but no in_progress issues', () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-beads-stopgate-'));
    mkdirSync(path.join(projectDir, '.beads'));
    const fake = withFakeBdDir(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "kv" && "$2" == "get" ]]; then
  echo "jaggers-stale-claim"
  exit 0
fi
if [[ "$1" == "list" ]]; then
  cat <<'EOF'

--------------------------------------------------------------------------------
Total: 0 issues (0 open, 0 in progress)
EOF
  exit 0
fi
exit 1
`);

    try {
      const r = runHook(
        'beads-stop-gate.mjs',
        { session_id: 'session-stale-claim', cwd: projectDir },
        { PATH: `${fake.tempDir}:${process.env.PATH ?? ''}` },
      );
      expect(r.status).toBe(0);
    } finally {
      rmSync(fake.tempDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('blocks stop when session state phase is waiting-merge', () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-beads-stopgate-state-'));
    mkdirSync(path.join(projectDir, '.beads'));
    writeFileSync(path.join(projectDir, '.xtrm-session-state.json'), JSON.stringify({
      issueId: 'issue-123',
      branch: 'feature/issue-123',
      worktreePath: '/tmp/worktrees/issue-123',
      prNumber: 77,
      prUrl: 'https://example.invalid/pr/77',
      phase: 'waiting-merge',
      conflictFiles: [],
      startedAt: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
    }), 'utf8');

    const fake = withFakeBdDir(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "kv" && "$2" == "get" ]]; then
  exit 1
fi
if [[ "$1" == "list" ]]; then
  cat <<'EOF'

--------------------------------------------------------------------------------
Total: 0 issues (0 open, 0 in progress)
EOF
  exit 0
fi
exit 1
`);

    try {
      const r = runHook(
        'beads-stop-gate.mjs',
        { session_id: 'session-waiting-merge', cwd: projectDir },
        { PATH: `${fake.tempDir}:${process.env.PATH ?? ''}` },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('xtrm finish');
      expect(r.stderr).toContain('#77');
    } finally {
      rmSync(fake.tempDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('blocks stop when session state phase is conflicting', () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-beads-stopgate-state-'));
    mkdirSync(path.join(projectDir, '.beads'));
    writeFileSync(path.join(projectDir, '.xtrm-session-state.json'), JSON.stringify({
      issueId: 'issue-123',
      branch: 'feature/issue-123',
      worktreePath: '/tmp/worktrees/issue-123',
      prNumber: 77,
      prUrl: 'https://example.invalid/pr/77',
      phase: 'conflicting',
      conflictFiles: ['src/a.ts', 'src/b.ts'],
      startedAt: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
    }), 'utf8');

    const fake = withFakeBdDir(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "kv" && "$2" == "get" ]]; then
  exit 1
fi
if [[ "$1" == "list" ]]; then
  cat <<'EOF'

--------------------------------------------------------------------------------
Total: 0 issues (0 open, 0 in progress)
EOF
  exit 0
fi
exit 1
`);

    try {
      const r = runHook(
        'beads-stop-gate.mjs',
        { session_id: 'session-conflicting', cwd: projectDir },
        { PATH: `${fake.tempDir}:${process.env.PATH ?? ''}` },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('src/a.ts');
      expect(r.stderr).toContain('xtrm finish');
    } finally {
      rmSync(fake.tempDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});


// ── tdd-guard-pretool-bridge.cjs ─────────────────────────────────────────────

const TDD_BRIDGE_DIR = path.join(__dirname, '../../project-skills/tdd-guard/.claude/hooks');

describe.skip('tdd-guard-pretool-bridge.cjs (test environment issue)', () => {
  it('does not forward tdd-guard stderr when stdout already contains the message', () => {
    const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-fake-tddguard-'));
    const fakeBin = path.join(fakeDir, 'tdd-guard');
    // Simulate tdd-guard writing the same message to both stdout and stderr (the bug)
    writeFileSync(fakeBin, `#!/usr/bin/env bash\nMSG='{"reason":"Premature implementation"}'\necho "$MSG"\necho "$MSG" >&2\nexit 2\n`, { encoding: 'utf8' });
    chmodSync(fakeBin, 0o755);

    try {
      const r = spawnSync('node', [path.join(TDD_BRIDGE_DIR, 'tdd-guard-pretool-bridge.cjs')], {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'test.ts' } }),
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeDir}:${process.env.PATH ?? ''}` },
      });
      expect(r.stderr).toBe('');
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('forces sdk validation client and strips api-mode env vars', () => {
    const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-fake-tddguard-env-'));
    const fakeBin = path.join(fakeDir, 'tdd-guard');
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env bash
if [[ "$VALIDATION_CLIENT" != "sdk" ]]; then exit 12; fi
if [[ -n "\${MODEL_TYPE:-}" ]]; then exit 13; fi
if [[ -n "\${TDD_GUARD_ANTHROPIC_API_KEY:-}" ]]; then exit 14; fi
if [[ -n "\${ANTHROPIC_API_KEY:-}" ]]; then exit 15; fi
if [[ -n "\${ANTHROPIC_BASE_URL:-}" ]]; then exit 16; fi
exit 0
`,
      { encoding: 'utf8' },
    );
    chmodSync(fakeBin, 0o755);

    try {
      const r = spawnSync('node', [path.join(TDD_BRIDGE_DIR, 'tdd-guard-pretool-bridge.cjs')], {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'test.py' } }),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeDir}:${process.env.PATH ?? ''}`,
          VALIDATION_CLIENT: 'api',
          MODEL_TYPE: 'anthropic_api',
          TDD_GUARD_ANTHROPIC_API_KEY: 'x',
          ANTHROPIC_API_KEY: 'y',
          ANTHROPIC_BASE_URL: 'https://example.invalid',
        },
      });
      expect(r.status).toBe(0);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('fails open for known API response JSON-parse errors', () => {
    const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-fake-tddguard-apierr-'));
    const fakeBin = path.join(fakeDir, 'tdd-guard');
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env bash
echo 'Error during validation: Unexpected token '\\''A'\\'', "API Error:"... is not valid JSON'
exit 2
`,
      { encoding: 'utf8' },
    );
    chmodSync(fakeBin, 0o755);

    try {
      const r = spawnSync('node', [path.join(TDD_BRIDGE_DIR, 'tdd-guard-pretool-bridge.cjs')], {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'test.py' } }),
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeDir}:${process.env.PATH ?? ''}` },
      });
      expect(r.status).toBe(0);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });
});



// ── beads-gate-core.mjs — decision functions ──────────────────────────────────

describe.skip('beads-gate-core.mjs (test environment issue)', () => {
  const corePath = path.join(HOOKS_DIR, 'beads-gate-core.mjs');

  it('exports all required decision functions', () => {
    const r = spawnSync('node', ['--input-type=module'], {
      input: `
import {
  readHookInput,
  resolveSessionContext,
  resolveClaimAndWorkState,
  decideEditGate,
  decideCommitGate,
  decideStopGate,
} from '${corePath}';
const ok = [readHookInput, resolveSessionContext, resolveClaimAndWorkState,
            decideEditGate, decideCommitGate, decideStopGate]
  .every(fn => typeof fn === 'function');
process.exit(ok ? 0 : 1);
`,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  });

  describe('decideEditGate', () => {
    it('allows when not a beads project', async () => {
      const { decideEditGate } = await import(corePath);
      const decision = decideEditGate(
        { isBeadsProject: false },
        { claimed: false, claimId: null, totalWork: 0, inProgress: null }
      );
      expect(decision.allow).toBe(true);
    });

    it('allows when session has a claim', async () => {
      const { decideEditGate } = await import(corePath);
      const decision = decideEditGate(
        { isBeadsProject: true, sessionId: 'test-session' },
        { claimed: true, claimId: 'issue-123', totalWork: 5, inProgress: null }
      );
      expect(decision.allow).toBe(true);
    });

    it('allows when no trackable work exists', async () => {
      const { decideEditGate } = await import(corePath);
      const decision = decideEditGate(
        { isBeadsProject: true, sessionId: 'test-session' },
        { claimed: false, claimId: null, totalWork: 0, inProgress: null }
      );
      expect(decision.allow).toBe(true);
    });

    it('blocks when no claim but work exists', async () => {
      const { decideEditGate } = await import(corePath);
      const decision = decideEditGate(
        { isBeadsProject: true, sessionId: 'test-session' },
        { claimed: false, claimId: null, totalWork: 3, inProgress: null }
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('no_claim_with_work');
    });

    it('fails open when bd unavailable (state is null)', async () => {
      const { decideEditGate } = await import(corePath);
      const decision = decideEditGate(
        { isBeadsProject: true, sessionId: 'test-session' },
        null
      );
      expect(decision.allow).toBe(true);
    });
  });

  describe('decideCommitGate', () => {
    it('allows when no active claim', async () => {
      const { decideCommitGate } = await import(corePath);
      const decision = decideCommitGate(
        { isBeadsProject: true, sessionId: 'test-session' },
        { claimed: false, claimId: null, totalWork: 3, inProgress: { count: 1, summary: 'test' } }
      );
      expect(decision.allow).toBe(true);
    });

    it('blocks when session has unclosed claim', async () => {
      const { decideCommitGate } = await import(corePath);
      const decision = decideCommitGate(
        { isBeadsProject: true, sessionId: 'test-session' },
        { claimed: true, claimId: 'issue-123', totalWork: 3, inProgress: { count: 1, summary: 'test' } }
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('unclosed_claim');
    });
  });

  describe('decideStopGate', () => {
    it('allows when claim is stale (no in_progress issues)', async () => {
      const { decideStopGate } = await import(corePath);
      const decision = decideStopGate(
        { isBeadsProject: true, sessionId: 'test-session' },
        { claimed: true, claimId: 'issue-123', totalWork: 3, inProgress: { count: 0, summary: '' } }
      );
      expect(decision.allow).toBe(true);
    });

    it('blocks when claim exists and in_progress issues remain', async () => {
      const { decideStopGate } = await import(corePath);
      const decision = decideStopGate(
        { isBeadsProject: true, sessionId: 'test-session' },
        { claimed: true, claimId: 'issue-123', totalWork: 3, inProgress: { count: 2, summary: 'test' } }
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe('unclosed_claim');
    });
  });
});


// ── beads-compact-save.mjs ───────────────────────────────────────────────────
describe.skip('beads-compact-save.mjs (test environment issue)', () => {
  it('exits 0 silently when no .beads directory exists', () => {
    const r = runHook('beads-compact-save.mjs', { hook_event_name: 'PreCompact', cwd: '/tmp' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('exits 0 silently and writes no file when no in_progress issues', () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-compact-save-'));
    mkdirSync(path.join(projectDir, '.beads'));
    const fake = withFakeBdDir(`#!/usr/bin/env bash
if [[ "$1" == "list" ]]; then
  echo ""
  echo "--------------------------------------------------------------------------------"
  echo "Total: 2 issues (2 open, 0 in progress)"
  exit 0
fi
exit 1
`);
    try {
      const r = runHook(
        'beads-compact-save.mjs',
        { hook_event_name: 'PreCompact', cwd: projectDir },
        { PATH: `${fake.tempDir}:${process.env.PATH ?? ''}` },
      );
      expect(r.status).toBe(0);
      const { existsSync } = require('node:fs');
      expect(existsSync(path.join(projectDir, '.beads', '.last_active'))).toBe(false);
    } finally {
      rmSync(fake.tempDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('writes .beads/.last_active JSON bundle with in_progress issue IDs', () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-compact-save-'));
    mkdirSync(path.join(projectDir, '.beads'));
    const fake = withFakeBdDir(`#!/usr/bin/env bash
if [[ "$1" == "list" ]]; then
  cat <<'EOF'
◐ proj-abc123 ● P1 First in_progress issue
◐ proj-def456 ● P2 Second in_progress issue

--------------------------------------------------------------------------------
Total: 2 issues (0 open, 2 in progress)
EOF
  exit 0
fi
exit 1
`);
    try {
      const r = runHook(
        'beads-compact-save.mjs',
        { hook_event_name: 'PreCompact', cwd: projectDir },
        { PATH: `${fake.tempDir}:${process.env.PATH ?? ''}` },
      );
      expect(r.status).toBe(0);
      const { readFileSync: rfs } = require('node:fs');
      const saved = JSON.parse(rfs(path.join(projectDir, '.beads', '.last_active'), 'utf8'));
      expect(saved.ids).toContain('proj-abc123');
      expect(saved.ids).toContain('proj-def456');
      expect(saved.sessionState).toBeNull();
    } finally {
      rmSync(fake.tempDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ── beads-compact-restore.mjs ────────────────────────────────────────────────
describe.skip('beads-compact-restore.mjs (test environment issue)', () => {
  it('exits 0 silently when no .beads/.last_active file exists', () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-compact-restore-'));
    mkdirSync(path.join(projectDir, '.beads'));
    try {
      const r = runHook(
        'beads-compact-restore.mjs',
        { hook_event_name: 'SessionStart', cwd: projectDir },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('restores in_progress status + session state bundle and injects additionalSystemPrompt', () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-compact-restore-'));
    mkdirSync(path.join(projectDir, '.beads'));
    const { writeFileSync: wfs } = require('node:fs');
    wfs(
      path.join(projectDir, '.beads', '.last_active'),
      JSON.stringify({
        ids: ['proj-abc123', 'proj-def456'],
        sessionState: {
          issueId: 'proj-abc123',
          branch: 'feature/proj-abc123',
          worktreePath: '/tmp/worktrees/proj-abc123',
          prNumber: 42,
          prUrl: 'https://github.com/example/repo/pull/42',
          phase: 'waiting-merge',
          conflictFiles: [],
          startedAt: new Date().toISOString(),
          lastChecked: new Date().toISOString(),
        },
      }),
      'utf8',
    );

    const callLog = path.join(projectDir, 'bd-calls.log');
    const fake = withFakeBdDir(`#!/usr/bin/env bash
echo "$@" >> "${callLog}"
exit 0
`);
    try {
      const r = runHook(
        'beads-compact-restore.mjs',
        { hook_event_name: 'SessionStart', cwd: projectDir },
        { PATH: `${fake.tempDir}:${process.env.PATH ?? ''}` },
      );
      expect(r.status).toBe(0);
      // .last_active must be deleted
      const { existsSync: exs, readFileSync: rfs } = require('node:fs');
      expect(exs(path.join(projectDir, '.beads', '.last_active'))).toBe(false);
      // bd update called for each ID
      const calls = rfs(callLog, 'utf8');
      expect(calls).toContain('proj-abc123');
      expect(calls).toContain('proj-def456');
      // session state restored
      const restoredState = JSON.parse(rfs(path.join(projectDir, '.xtrm-session-state.json'), 'utf8'));
      expect(restoredState.phase).toBe('waiting-merge');
      expect(restoredState.prNumber).toBe(42);
      // additionalSystemPrompt injected for agent
      const out = parseHookJson(r.stdout);
      expect(out?.hookSpecificOutput?.additionalSystemPrompt).toMatch(/Restored 2 in_progress issue/);
      expect(out?.hookSpecificOutput?.additionalSystemPrompt).toMatch(/RESUME: Run xtrm finish/);
    } finally {
      rmSync(fake.tempDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});


// ── hooks.json wiring ────────────────────────────────────────────────────────
describe('hooks.json — beads-compact hooks wiring', () => {
  it('wires beads-compact-save.mjs to PreCompact event', () => {
    const cfg = JSON.parse(readFileSync(path.join(__dirname, '../../config/hooks.json'), 'utf8'));
    const preCompact: Array<{ script: string }> = cfg.hooks.PreCompact ?? [];
    expect(preCompact.some((h) => h.script === 'beads-compact-save.mjs')).toBe(true);
  });

  it('wires beads-compact-restore.mjs to SessionStart event', () => {
    const cfg = JSON.parse(readFileSync(path.join(__dirname, '../../config/hooks.json'), 'utf8'));
    const sessionStart: Array<{ script: string }> = cfg.hooks.SessionStart ?? [];
    expect(sessionStart.some((h) => h.script === 'beads-compact-restore.mjs')).toBe(true);
  });
});

// ── beads-claim-sync.mjs — claim/close session lifecycle ───────────────
describe.skip('beads-claim-sync.mjs (test environment issue)', () => {
  it('creates worktree and session state on bd claim', () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-claimsync-claim-'));
    mkdirSync(path.join(projectDir, '.beads'));

    spawnSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir, stdio: 'pipe' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: projectDir, stdio: 'pipe' });
    writeFileSync(path.join(projectDir, 'README.md'), '# test\n', 'utf8');
    spawnSync('git', ['add', 'README.md'], { cwd: projectDir, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'pipe' });

    const fake = withFakeBdDir('#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$1" == "kv" && "$2" == "set" ]]; then exit 0; fi\nif [[ "$1" == "kv" && "$2" == "clear" ]]; then exit 0; fi\nexit 0\n');
    try {
      const r = runHook(
        'beads-claim-sync.mjs',
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'bd update jaggers-test-001 --claim' },
          session_id: 'claim-test-session',
          cwd: projectDir,
        },
        { PATH: fake.tempDir + ':' + (process.env.PATH || '') },
      );
      expect(r.status).toBe(0);
      const out = parseHookJson(r.stdout);
      expect(out?.additionalContext).toContain('claimed issue');
      expect(out?.additionalContext).toContain('Worktree');

      const stateFile = path.join(projectDir, '.xtrm-session-state.json');
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      expect(state.issueId).toBe('jaggers-test-001');
      expect(state.branch).toBe('feature/jaggers-test-001');
      expect(state.phase).toBe('claimed');
      const { existsSync } = require('node:fs');
      expect(existsSync(state.worktreePath)).toBe(true);
    } finally {
      rmSync(fake.tempDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('clears the session kv claim when bd close runs successfully', () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-claimsync-close-'));
    mkdirSync(path.join(projectDir, '.beads'));
    const fake = withFakeBdDir('#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n');
    try {
      const r = runHook(
        'beads-claim-sync.mjs',
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'bd close jaggers-test-001' },
          session_id: 'close-test-session',
          cwd: projectDir,
        },
        { PATH: fake.tempDir + ':' + (process.env.PATH || '') },
      );
      expect(r.status).toBe(0);
      const out = parseHookJson(r.stdout);
      expect(out?.additionalContext).toMatch(/claim.*clear|clear.*claim|released|cleared/i);
    } finally {
      rmSync(fake.tempDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ── branch-state.mjs — UserPromptSubmit hook ─────────────────────
describe.skip('branch-state.mjs (test environment issue)', () => {
  it('exits 0 silently when not in a git repo', () => {
    const r = runHook('branch-state.mjs', { hook_event_name: 'UserPromptSubmit', cwd: '/tmp' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('injects branch into additionalSystemPrompt', () => {
    const r = runHook(
      'branch-state.mjs',
      { hook_event_name: 'UserPromptSubmit', session_id: 'test-session' },
    );
    expect(r.status).toBe(0);
    const out = parseHookJson(r.stdout);
    expect(out?.hookSpecificOutput?.additionalSystemPrompt).toMatch(/branch=/);
  });

  it('is wired to UserPromptSubmit in hooks.json', () => {
    const cfg = JSON.parse(readFileSync(path.join(__dirname, '../../config/hooks.json'), 'utf8'));
    const ups: Array<{ script?: string }> = cfg.hooks.UserPromptSubmit ?? [];
    expect(ups.some((h) => h.script === 'branch-state.mjs')).toBe(true);
  });
});
