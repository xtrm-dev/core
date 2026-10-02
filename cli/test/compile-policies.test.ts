import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/compile-policies.mjs');
const HOOKS_OUTPUT = path.join(REPO_ROOT, '.xtrm', 'config', 'hooks.json');
const POLICIES_DIR = path.join(REPO_ROOT, 'policies');

function runCompiler(args: string[]) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
}

// ── Golden file ───────────────────────────────────────────────────────────────

describe('compile-policies — golden file', () => {
  it('--dry-run output matches .xtrm/config/hooks.json on disk', () => {
    const result = runCompiler(['--dry-run']);
    expect(result.status).toBe(0);
    const onDisk = readFileSync(HOOKS_OUTPUT, 'utf8');
    expect(result.stdout).toBe(onDisk);
  });
});

// ── --check flag ──────────────────────────────────────────────────────────────

describe('compile-policies — --check flag', () => {
  it('exits 0 when hooks.json is up to date', () => {
    const result = runCompiler(['--check']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('up to date');
  });

  it('exits 1 and reports error when hooks.json is stale', () => {
    const original = readFileSync(HOOKS_OUTPUT, 'utf8');
    try {
      writeFileSync(HOOKS_OUTPUT, JSON.stringify({ hooks: { _stale: true } }, null, 2) + '\n');
      const result = runCompiler(['--check']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('out of sync');
    } finally {
      writeFileSync(HOOKS_OUTPUT, original);
    }
  });
});

// ── --dry-run flag ────────────────────────────────────────────────────────────

describe('compile-policies — --dry-run flag', () => {
  it('prints valid JSON with hooks key to stdout', () => {
    const result = runCompiler(['--dry-run']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('hooks');
  });

  it('does not modify hooks.json', () => {
    const before = readFileSync(HOOKS_OUTPUT, 'utf8');
    runCompiler(['--dry-run']);
    const after = readFileSync(HOOKS_OUTPUT, 'utf8');
    expect(after).toBe(before);
  });
});

// ── Write mode ────────────────────────────────────────────────────────────────

describe('compile-policies — write mode', () => {
  it('writes hooks.json and prints summary', () => {
    const original = readFileSync(HOOKS_OUTPUT, 'utf8');
    try {
      const result = runCompiler([]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Generated .xtrm/config/hooks.json');
      const written = readFileSync(HOOKS_OUTPUT, 'utf8');
      const parsed = JSON.parse(written);
      expect(parsed).toHaveProperty('hooks');
    } finally {
      writeFileSync(HOOKS_OUTPUT, original);
    }
  });
});

// ── Output structure ──────────────────────────────────────────────────────────

describe('compile-policies — output structure', () => {
  it('no null or empty string matchers in output', () => {
    const result = runCompiler(['--dry-run']);
    const parsed = JSON.parse(result.stdout);
    for (const groups of Object.values(parsed.hooks) as object[][]) {
      for (const group of groups) {
        const g = group as { matcher?: string };
        if ('matcher' in g) {
          expect(g.matcher).toBeTruthy();
        }
      }
    }
  });

  it('timeout field absent from entries that do not declare it', () => {
    const result = runCompiler(['--dry-run']);
    const parsed = JSON.parse(result.stdout);
    for (const groups of Object.values(parsed.hooks) as object[][]) {
      for (const group of groups) {
        const g = group as { hooks: { timeout?: unknown }[] };
        for (const entry of g.hooks ?? []) {
          if (!Object.prototype.hasOwnProperty.call(entry, 'timeout')) {
            expect(entry.timeout).toBeUndefined();
          }
        }
      }
    }
  });

  it('timeout field present when declared in policy', () => {
    const files = readdirSync(POLICIES_DIR).filter(f => f.endsWith('.json') && f !== 'schema.json');
    const hasTimeout = files.some(f => {
      const p = JSON.parse(readFileSync(path.join(POLICIES_DIR, f), 'utf8'));
      return (p.claude?.hooks ?? []).some((h: { timeout?: number }) => h.timeout != null);
    });
    if (!hasTimeout) return;

    const result = runCompiler(['--dry-run']);
    const parsed = JSON.parse(result.stdout);
    const allEntries = Object.values(parsed.hooks as object)
      .flatMap(groups => groups as object[])
      .flatMap(g => (g as { hooks: object[] }).hooks ?? []);
    expect(allEntries.some(e => 'timeout' in e)).toBe(true);
  });

  it('$WRITE_TOOLS macro is expanded — no raw macro in output', () => {
    const result = runCompiler(['--dry-run']);
    const parsed = JSON.parse(result.stdout);
    const allMatchers = Object.values(parsed.hooks as object)
      .flatMap(groups => groups as object[])
      .map(g => (g as { matcher?: string }).matcher)
      .filter(Boolean);

    for (const matcher of allMatchers) {
      expect(matcher).not.toContain('$WRITE_TOOLS');
    }
    expect(allMatchers.some(m => m?.includes('Edit'))).toBe(true);
  });

  it('runtime:pi policies are excluded from hooks output', () => {
    const files = readdirSync(POLICIES_DIR).filter(f => f.endsWith('.json') && f !== 'schema.json');
    const piOnlyCommands: string[] = [];
    for (const f of files) {
      const p = JSON.parse(readFileSync(path.join(POLICIES_DIR, f), 'utf8'));
      if (p.runtime === 'pi') {
        for (const hook of p.claude?.hooks ?? []) {
          piOnlyCommands.push(hook.command);
        }
      }
    }
    if (piOnlyCommands.length === 0) return;

    const result = runCompiler(['--dry-run']);
    for (const cmd of piOnlyCommands) {
      expect(result.stdout).not.toContain(cmd);
    }
  });

  // CORE-2339: the per-hook SessionStart entries (quality-check-env,
  // xtrm-session-logger, worktree-reap-sweep) were merged into one
  // `dispatch.mjs session` command, so "several policies contribute separate
  // commands to one event" is no longer the shape this suite pins. The event is
  // still single-source: exactly one entry, carrying every SessionStart check.
  it('SessionStart is a single dispatcher entry carrying every SessionStart check', () => {
    const result = runCompiler(['--dry-run']);
    const parsed = JSON.parse(result.stdout);
    const sessionStart = parsed.hooks['SessionStart'];
    expect(Array.isArray(sessionStart)).toBe(true);
    expect(sessionStart).toHaveLength(1);
    const allHooks = sessionStart.flatMap((g: { hooks: object[] }) => g.hooks ?? []);
    expect(allHooks).toHaveLength(1);
    expect(allHooks[0].command).toContain('dispatch.mjs session');
  });

  it('every hook event is served by at most one command per group (CORE-2339)', () => {
    const result = runCompiler(['--dry-run']);
    const parsed = JSON.parse(result.stdout);
    for (const [event, groups] of Object.entries<Record<string, { hooks: unknown[] }>>(parsed.hooks)) {
      for (const group of groups) {
        // One process per group is the whole point of the dispatcher; a second
        // command in the same group would silently restore the fan-out.
        expect(group.hooks.length, `${event} has ${group.hooks.length} commands`).toBe(1);
      }
    }
  });
});

// xtrm-wiy5n.4.38 — a hook is wired in live settings but no longer ships.
// The compiled config (.xtrm/config/hooks.json) is copied into ~/.xtrm/config
// by the global hooks bootstrap and then propagated into ~/.claude/settings.json
// by the runtime sync. Once a hook file is deleted from the payload but a
// policy still references it, the wired entry points at a file that will not
// ship on the next release. That is a payload/wiring mismatch and must fail at
// build time.
//
// Codex P2 (isolation): these tests must NOT write into the real `policies/`
// tree because Vitest runs test files in parallel and `cli/src/tests/policy-
// parity.test.ts` enumerates that same directory + runs the compiler. Instead,
// each mismatch case spawns the compiler with XTRM_POLICIES_DIR /
// XTRM_HOOKS_PAYLOAD_DIR / XTRM_HOOKS_OUTPUT_FILE pointing at a fresh temp
// tree, so cross-file execution can never observe the fixture.
describe('compile-policies — payload/wiring parity gate (xtrm-wiy5n.4.38)', () => {
  let sandboxRoot = '';
  let sandboxPolicies = '';
  let sandboxHooks = '';
  let sandboxOutput = '';

  function makeSandbox(): void {
    sandboxRoot = mkdtempSync(path.join(tmpdir(), 'xtrm-w438-'));
    sandboxPolicies = path.join(sandboxRoot, 'policies');
    sandboxHooks = path.join(sandboxRoot, 'hooks');
    sandboxOutput = path.join(sandboxRoot, 'hooks.json');
    mkdirSync(sandboxPolicies, { recursive: true });
    mkdirSync(sandboxHooks, { recursive: true });
    // Seed a minimal on-disk output so `--check` has something to compare to.
    writeFileSync(sandboxOutput, '{}\n');
  }

  function sandboxEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      XTRM_POLICIES_DIR: sandboxPolicies,
      XTRM_HOOKS_PAYLOAD_DIR: sandboxHooks,
      XTRM_HOOKS_OUTPUT_FILE: sandboxOutput,
    };
  }

  function runIsolated(args: string[]) {
    return spawnSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: sandboxEnv(),
    });
  }

  function writePolicy(name: string, hookCommand: string): void {
    writeFileSync(path.join(sandboxPolicies, name), JSON.stringify({
      id: name.replace(/\.json$/, ''),
      description: 'w438 fixture — sandboxed policies dir, never touches the real tree.',
      version: '1',
      runtime: 'both',
      order: 50,
      claude: { hooks: [{ event: 'SessionStart', command: hookCommand }] },
    }, null, 2) + '\n');
  }

  afterEach(() => {
    if (sandboxRoot && existsSync(sandboxRoot)) rmSync(sandboxRoot, { recursive: true, force: true });
    sandboxRoot = '';
  });

  it('exits non-zero and names the missing payload file when a policy hook references one that does not ship', () => {
    makeSandbox();
    writePolicy('a-mismatch.json', 'node ${CLAUDE_PLUGIN_ROOT}/hooks/does-not-ship-w438.mjs');

    const result = runIsolated(['--dry-run']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does-not-ship-w438.mjs');
    expect(result.stderr).toMatch(/payload|missing|not.*ship|referenced/i);
  });

  it('exits non-zero on the default write path too — a bad compile must never touch the output file', () => {
    makeSandbox();
    const originalOutput = readFileSync(sandboxOutput, 'utf8');
    writePolicy('b-mismatch.json', 'node ${CLAUDE_PLUGIN_ROOT}/hooks/does-not-ship-w438.mjs');

    const result = runIsolated([]);

    expect(result.status).not.toBe(0);
    expect(readFileSync(sandboxOutput, 'utf8')).toBe(originalOutput);
  });

  it('rejects a command that targets a directory instead of a regular file (Codex P2)', () => {
    // Adversarial: a typo drops the filename and the token resolves to an
    // existing directory. `existsSync` returns true and would let the gate
    // pass; the fix rejects any non-file entry.
    makeSandbox();
    mkdirSync(path.join(sandboxHooks, 'gitnexus'), { recursive: true });
    writePolicy('c-dir-target.json', 'node ${CLAUDE_PLUGIN_ROOT}/hooks/gitnexus');

    const result = runIsolated(['--dry-run']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('gitnexus');
    expect(result.stderr).toMatch(/not a regular file|directory/i);
  });

  it('passes when every referenced hook is a regular file that ships', () => {
    makeSandbox();
    writeFileSync(path.join(sandboxHooks, 'real.mjs'), '// real hook body');
    writePolicy('d-ok.json', 'node ${CLAUDE_PLUGIN_ROOT}/hooks/real.mjs');

    const result = runIsolated(['--dry-run']);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toContain('real.mjs');
  });

  it('every hook command in the REAL policies/ tree resolves to a file that ships in .xtrm/hooks/', () => {
    // Standing regression against the real repo layout. If a future PR deletes
    // a payload file and forgets to update policies, THIS is the assertion
    // that stops it. Uses the un-overridden compiler (no XTRM_*_DIR env),
    // reading the real policies dir and validating against .xtrm/hooks/.
    const result = runCompiler(['--dry-run']);
    expect(result.status).toBe(0);
  });
});
