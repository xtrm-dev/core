import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');
const CLI_ENTRY = path.join(__dirname, '../src/index.ts');

const CLI_BIN = path.join(__dirname, '../dist/index.cjs');

function runClean(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('node', [CLI_BIN, 'clean', ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    timeout: 30000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

// ── canonical wiring validation ─────────────────────────────────────────────

describe('xtrm clean — canonical wiring validation', () => {
  it('reports stale event: serena-workflow-reminder.py wired to PreToolUse is removed', () => {
    const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'xtrm-clean-test-'));
    const hooksDir = path.join(tmpHome, '.claude', 'hooks');
    mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    mkdirSync(hooksDir, { recursive: true });

    // Stub hook file so cleanHooks doesn't also flag it as orphaned
    writeFileSync(path.join(hooksDir, 'serena-workflow-reminder.py'), '# stub');

    writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `python3 "${path.join(hooksDir, 'serena-workflow-reminder.py')}"` }] },
        ],
        // Stale: serena-workflow-reminder.py is NOT in PreToolUse in config/hooks.json
        PreToolUse: [
          {
            matcher: 'Read|Edit|mcp__serena__rename_symbol',
            hooks: [{ type: 'command', command: `python3 "${path.join(hooksDir, 'serena-workflow-reminder.py')}"` }],
          },
        ],
      },
    }, null, 2));

    try {
      const r = runClean(['--dry-run', '--hooks-only'], { HOME: tmpHome });
      expect(r.stdout, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toMatch(
        /orphaned hook/i,
      );
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('keeps canonical matcher: gitnexus-hook.cjs with Read|Grep|Glob prefix', () => {
    const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'xtrm-clean-test-'));
    const hooksDir = path.join(tmpHome, '.claude', 'hooks');
    mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    mkdirSync(path.join(hooksDir, 'gitnexus'), { recursive: true });
    writeFileSync(path.join(hooksDir, 'gitnexus', 'gitnexus-hook.cjs'), '// stub');

    writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            // Canonical: current hooks.json includes Read|Grep|Glob prefix
            matcher: 'Read|Grep|Glob|Bash|mcp__serena__find_symbol|mcp__serena__get_symbols_overview',
            hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'gitnexus/gitnexus-hook.cjs')}"`, timeout: 10000 }],
          },
        ],
      },
    }, null, 2));

    try {
      const r = runClean(['--dry-run', '--hooks-only'], { HOME: tmpHome });
      expect(r.stdout).toContain('No orphaned hook entries found');
      expect(r.stdout).not.toMatch(/gitnexus-hook\.cjs.*stale wiring/i);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it.skip('keeps branch-state.mjs as canonical (outdated - no UserPromptSubmit in hooks.json)', () => {
    const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'xtrm-clean-test-'));
    const hooksDir = path.join(tmpHome, '.claude', 'hooks');
    mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(path.join(hooksDir, 'branch-state.mjs'), '// stub');

    writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'branch-state.mjs')}"`, timeout: 3000 }] },
        ],
      },
    }, null, 2));

    try {
      const r = runClean(['--dry-run', '--hooks-only'], { HOME: tmpHome });
      expect(r.stdout).toContain('No orphaned hook entries found');
      expect(r.stdout).not.toContain('branch-state.mjs');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it.skip('keeps canonical entries that match config/hooks.json exactly (outdated)', () => {
    const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'xtrm-clean-test-'));
    const hooksDir = path.join(tmpHome, '.claude', 'hooks');
    mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(path.join(hooksDir, 'main-guard.mjs'), '// stub');

    writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit|mcp__serena__rename_symbol|mcp__serena__replace_symbol_body|mcp__serena__insert_after_symbol|mcp__serena__insert_before_symbol',
            hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'beads-edit-gate.mjs')}"`, timeout: 5000 }],
          },
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'beads-edit-gate.mjs')}"`, timeout: 5000 }],
          },
        ],
      },
    }, null, 2));

    try {
      const r = runClean(['--dry-run', '--hooks-only'], { HOME: tmpHome });
      expect(r.stdout).toContain('No orphaned hook entries found');
      expect(r.stdout).not.toContain('beads-edit-gate.mjs');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('falls back to script-only check and removes non-canonical scripts regardless', () => {
    const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'xtrm-clean-test-'));
    const hooksDir = path.join(tmpHome, '.claude', 'hooks');
    mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    mkdirSync(hooksDir, { recursive: true });

    writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `node "${path.join(hooksDir, 'some-old-hook.mjs')}"` }],
          },
        ],
      },
    }, null, 2));

    try {
      const r = runClean(['--dry-run', '--hooks-only'], { HOME: tmpHome });
      expect(r.stdout).toContain('some-old-hook.mjs');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
