/**
 * K1 CHARACTERIZATION SUITE — xtrm-ozknq.5 (KAN-127 K1).
 *
 * These tests pin the CURRENT observable contract of the single shared
 * launcher `launchWorktreeSession()` (cli/src/utils/worktree-session.ts:1448)
 * so a later shared-launcher refactor (adding a third runtime, e.g. codex)
 * cannot silently change it. They assert what the code does TODAY, including
 * behavior that is arguably wrong. Nothing here is a specification of what the
 * launcher SHOULD do.
 *
 * Where a pinned behavior is suspect, the assertion carries a
 * `// CHARACTERIZATION: current behavior, see xtrm-ozknq.5 — <why>` comment.
 * Defects are NOT fixed in K1.
 *
 * EXIT-CODE VOCABULARY (see `exit code vocabulary` describe block below):
 * the launcher's exit surface is binary — 0 or 1 — across ~20 semantically
 * distinct failure classes. The table-driven test in this file exists to
 * DOCUMENT that a caller cannot tell those failures apart. K2 replaces the
 * binary exit with distinct reason codes; when K2 lands, that test is EXPECTED
 * to change (the table becomes reason-code assertions, not `exit:1` for every
 * row). Do not "fix" it by relaxing the assertions.
 */
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  spawn: vi.fn(),
  ensureAgentsSkillsSymlink: vi.fn(async () => undefined),
  runPiLaunchPreflight: vi.fn(async () => undefined),
  runtimeCompatibilityError: vi.fn((): string | null => null),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mocked.spawnSync,
  spawn: mocked.spawn,
}));

vi.mock('../core/skills-scaffold.js', () => ({
  ensureAgentsSkillsSymlink: mocked.ensureAgentsSkillsSymlink,
}));

vi.mock('../core/pi-runtime.js', () => ({
  runPiLaunchPreflight: mocked.runPiLaunchPreflight,
}));

vi.mock('../core/runtime-compat.js', () => ({
  runtimeCompatibilityError: mocked.runtimeCompatibilityError,
}));

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type SpawnHandler = (
  command: string,
  args: string[],
  options?: { input?: string },
) => SpawnResult | undefined;

type StdioCapture = {
  /** Raw `process.stdout.write` chunks — the machine-readable channel. */
  stdout: string[];
  /** Raw `process.stderr.write` chunks. */
  stderr: string[];
  /** `console.log` lines. In production these land on fd 1 too. */
  log: string[];
  /** `console.error` lines. In production these land on fd 2 too. */
  error: string[];
};

const ANSI = /\[[0-9;]*m/g;

describe('codex K1 launch contract (characterization)', () => {
  let tempRoot = '';
  let previousCwd = '';
  let previousHome: string | undefined;
  let previousTmux: string | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-k1-launch-'));
    previousCwd = process.cwd();
    previousHome = process.env.HOME;
    previousTmux = process.env.TMUX;
    // Sandbox HOME (test/setup.ts guards the real ~/.xtrm tree) and force the
    // outside-tmux shape so `currentPaneMode` is deterministic.
    process.env.HOME = path.join(tempRoot, 'home');
    await fs.ensureDir(process.env.HOME);
    delete process.env.TMUX;

    mocked.spawnSync.mockReset();
    mocked.spawn.mockReset();
    mocked.ensureAgentsSkillsSymlink.mockReset();
    mocked.ensureAgentsSkillsSymlink.mockResolvedValue(undefined);
    mocked.runPiLaunchPreflight.mockReset();
    mocked.runPiLaunchPreflight.mockResolvedValue(undefined);
    mocked.runtimeCompatibilityError.mockReset();
    mocked.runtimeCompatibilityError.mockReturnValue(null);
    vi.resetModules();
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    await fs.remove(tempRoot);
    vi.restoreAllMocks();
  });

  function mockProcessExit(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`) as never;
    });
  }

  /**
   * Capture all four output channels separately. `console.log`/`console.error`
   * are captured (and suppressed) BEFORE `process.stdout.write`, so the
   * stdout/stderr arrays only ever hold direct `process.std*.write` calls —
   * which is exactly the seam the launcher's own contract comment claims.
   */
  function captureStdio(): StdioCapture {
    const capture: StdioCapture = { stdout: [], stderr: [], log: [], error: [] };
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      capture.log.push(parts.join(' ').replace(ANSI, ''));
    });
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      capture.error.push(parts.join(' ').replace(ANSI, ''));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      capture.stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      capture.stderr.push(String(chunk).replace(ANSI, ''));
      return true;
    });
    return capture;
  }

  /** Everything a human could read on fd 2. */
  function stderrText(capture: StdioCapture): string {
    return [...capture.stderr, ...capture.error].join('\n');
  }

  async function makeRepo(name = 'demo'): Promise<string> {
    const repoRoot = path.join(tempRoot, name);
    await fs.ensureDir(path.join(repoRoot, '.beads'));
    process.chdir(repoRoot);
    return repoRoot;
  }

  function worktreePathFor(repoRoot: string, runtime: 'pi' | 'claude', slug: string): string {
    return path.join(
      repoRoot,
      '.xtrm',
      'worktrees',
      `${path.basename(repoRoot)}-xt-${runtime}-${slug}`,
    );
  }

  /**
   * Baseline spawnSync stub for a launch that reaches tmux. `handler` is
   * consulted first so a case can inject exactly one failure.
   */
  function installSpawnSync(cfg: {
    repoRoot: string;
    worktreePath?: string;
    paneId?: string;
    /** Return true when tmux should report the session as already existing. */
    sessionExists?: (sessionName: string) => boolean;
    handler?: SpawnHandler;
    onNewSession?: (args: string[]) => void;
  }): void {
    const ok: SpawnResult = { status: 0, stdout: '', stderr: '' };
    mocked.spawnSync.mockImplementation((command: string, args: string[], options?: { input?: string }) => {
      const injected = cfg.handler?.(command, args, options);
      if (injected) return injected;

      const joined = args.join(' ');
      if (command === 'git' && joined === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${cfg.repoRoot}\n`, stderr: '' };
      }
      if (command === 'git' && joined === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }
      if (command === 'bd' && args[0] === 'worktree' && args[1] === 'create') {
        if (cfg.worktreePath) {
          fs.ensureDirSync(cfg.worktreePath);
          fs.ensureDirSync(path.join(cfg.worktreePath, '.git'));
        }
        return ok;
      }
      if (command === 'tmux' && args[0] === 'has-session') {
        const target = (args[2] ?? '').replace(/^=/, '');
        return cfg.sessionExists?.(target) ? ok : { status: 1, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'new-session') {
        cfg.onNewSession?.(args);
        return ok;
      }
      if (command === 'tmux' && args[0] === 'list-panes') {
        return { status: 0, stdout: `${cfg.paneId ?? '%42'}\n`, stderr: '' };
      }
      return ok;
    });
  }

  async function importLauncher() {
    const mod = await import('../utils/worktree-session.js');
    return mod.launchWorktreeSession;
  }

  // ---------------------------------------------------------------------
  // 1. THE STDOUT CONTRACT
  // ---------------------------------------------------------------------

  it('pins the --no-attach stdout contract to exactly one "<session>:<pane>\\n" write', async () => {
    const repoRoot = await makeRepo();
    const worktreePath = worktreePathFor(repoRoot, 'pi', 'contract');
    installSpawnSync({ repoRoot, worktreePath, paneId: '%42' });

    const capture = captureStdio();
    const exitSpy = mockProcessExit();
    const launchWorktreeSession = await importLauncher();

    await expect(launchWorktreeSession({
      runtime: 'pi',
      name: 'contract',
      prompt: 'echo hi',
      attach: false,
    })).rejects.toThrow('exit:0');

    expect(exitSpy).toHaveBeenCalledWith(0);

    // The ONLY machine-readable seam in the product (worktree-session.ts:2271).
    // Pinned byte-for-byte: one write, one trailing newline, no other newline.
    expect(capture.stdout).toHaveLength(1);
    expect(capture.stdout[0]).toBe('pi-contract:%42\n');
    expect(capture.stdout[0]).toMatch(/^[^:\n]+:%\d+\n$/);
    expect(capture.stdout[0].endsWith('\n')).toBe(true);
    expect(capture.stdout[0].split('\n')).toHaveLength(2);
    expect(capture.stdout[0].slice(0, -1)).not.toContain('\n');

    // CHARACTERIZATION: current behavior, see xtrm-ozknq.5 — the launcher's own
    // comment at worktree-session.ts:2270 says "exactly one line on stdout",
    // but that is only true of `process.stdout.write`. The launch also emits
    // human prose through `console.log` (worktree-session.ts:1724-1727, 1785-1787),
    // which is fd 1 in production. A caller that reads the child's stdout
    // whole gets prose + contract line, not a parseable single line. Pinned as
    // a defect so a shared-launcher refactor cannot silently "fix" or worsen it.
    expect(capture.log.join('\n')).toContain('Launching pi session');
    expect(capture.log.join('\n')).toContain('Worktree ready');
    expect(capture.log.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------
  // 2. THE --reuse SHORT-CIRCUIT
  // ---------------------------------------------------------------------

  it('pins the --reuse short-circuit: same one-line contract, exit 0, no new worktree', async () => {
    const repoRoot = await makeRepo();
    const worktreePath = worktreePathFor(repoRoot, 'pi', 'reused');
    installSpawnSync({
      repoRoot,
      worktreePath,
      paneId: '%7',
      sessionExists: (name) => name === 'pi-reused',
    });

    const capture = captureStdio();
    const exitSpy = mockProcessExit();
    const launchWorktreeSession = await importLauncher();

    await expect(launchWorktreeSession({
      runtime: 'pi',
      name: 'reused',
      reuse: true,
      attach: false,
    })).rejects.toThrow('exit:0');

    expect(exitSpy).toHaveBeenCalledWith(0);

    // Identical contract to the fresh-launch path (worktree-session.ts:1707-1709).
    expect(capture.stdout).toEqual(['pi-reused:%7\n']);
    expect(capture.stdout[0]).toMatch(/^[^:\n]+:%\d+\n$/);

    // No worktree, no branch, no bd/git worktree creation at all.
    expect(await fs.pathExists(worktreePath)).toBe(false);
    expect(await fs.pathExists(path.join(repoRoot, '.xtrm', 'worktrees'))).toBe(false);
    expect(mocked.spawnSync).not.toHaveBeenCalledWith(
      'bd',
      expect.arrayContaining(['worktree', 'create']),
      expect.anything(),
    );
    expect(mocked.spawnSync).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'add']),
      expect.anything(),
    );

    // The early reuse path emits NO prose on any channel — unlike the fresh
    // launch above. Pinned because the two "success" shapes are not
    // interchangeable for a caller that scrapes output.
    expect(capture.log).toEqual([]);
    expect(stderrText(capture)).toBe('');
  });

  // ---------------------------------------------------------------------
  // 3. STREAM ROUTING
  // ---------------------------------------------------------------------

  it('pins stream routing on success: prose goes to console.log (fd 1), not stderr', async () => {
    const repoRoot = await makeRepo();
    const worktreePath = worktreePathFor(repoRoot, 'pi', 'routing');
    installSpawnSync({ repoRoot, worktreePath, paneId: '%9' });

    const capture = captureStdio();
    mockProcessExit();
    const launchWorktreeSession = await importLauncher();

    await expect(launchWorktreeSession({
      runtime: 'pi',
      name: 'routing',
      prompt: 'echo hi',
      attach: false,
    })).rejects.toThrow('exit:0');

    // CHARACTERIZATION: current behavior, see xtrm-ozknq.5 — human prose on a
    // SUCCESSFUL launch is written with console.log, i.e. fd 1, the same
    // descriptor as the machine-readable contract line; stderr stays empty.
    // The clean split would be prose->fd 2, contract->fd 1. Pinned as-is.
    expect(capture.log.join('\n')).toMatch(/Launching pi session/);
    expect(capture.log.join('\n')).toMatch(/worktree: /);
    expect(capture.log.join('\n')).toMatch(/branch: /);
    expect(stderrText(capture)).toBe('');
    expect(capture.stdout).toEqual(['pi-routing:%9\n']);
  });

  it('pins stream routing on rejection (mutually exclusive --bead/--prompt): stdout empty, error on stderr', async () => {
    const repoRoot = await makeRepo();
    installSpawnSync({ repoRoot });

    const capture = captureStdio();
    const exitSpy = mockProcessExit();
    const launchWorktreeSession = await importLauncher();

    await expect(launchWorktreeSession({
      runtime: 'pi',
      role: 'blank',
      bead: 'some-bead',
      prompt: 'literal body',
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Nothing on fd 1 through either channel — a pre-worktree rejection is
    // silent on stdout (worktree-session.ts:1503).
    expect(capture.stdout).toEqual([]);
    expect(capture.log).toEqual([]);
    expect(stderrText(capture)).toContain('--bead and --prompt are mutually exclusive');
  });

  it('pins stream routing on rejection (not a git repository): stdout empty, error on stderr', async () => {
    const repoRoot = await makeRepo();
    installSpawnSync({
      repoRoot,
      handler: (command, args) => (
        command === 'git' && args.join(' ') === 'rev-parse --show-toplevel'
          ? { status: 128, stdout: '', stderr: 'not a git repository' }
          : undefined
      ),
    });

    const capture = captureStdio();
    const exitSpy = mockProcessExit();
    const launchWorktreeSession = await importLauncher();

    await expect(launchWorktreeSession({
      runtime: 'claude',
      name: 'nogit',
      attach: false,
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.log).toEqual([]);
    expect(stderrText(capture)).toContain('Not inside a git repository');
  });

  // ---------------------------------------------------------------------
  // 4. EXIT-CODE VOCABULARY
  // ---------------------------------------------------------------------

  describe('exit code vocabulary', () => {
    /**
     * Every row is a SEMANTICALLY DISTINCT failure. Every row exits 1. That is
     * the whole point: a caller of `xt pi --no-attach` cannot distinguish
     * "your model is wrong" from "tmux is broken" from "the worktree path is
     * dirty". K2 replaces this with distinct reason codes and this table is
     * EXPECTED to change then.
     */
    type FailureCase = {
      name: string;
      /** Source line of the process.exit(1) this row reaches. */
      site: string;
      opts: Record<string, unknown>;
      prepare?: (repoRoot: string) => Promise<void> | void;
      handler?: SpawnHandler;
      sessionExists?: (sessionName: string) => boolean;
      /** Force a non-null runtime compatibility error. */
      compatError?: string;
      /** Distinct fragment of the message that reaches stderr. */
      message: RegExp;
    };

    const cases: FailureCase[] = [
      {
        name: 'runtime compatibility preflight',
        site: 'worktree-session.ts:1468',
        opts: { runtime: 'pi', name: 'compat', attach: false },
        compatError: 'specialists 0.0.1 is outside the supported range',
        message: /outside the supported range/,
      },
      {
        name: 'mutually exclusive --bead and --prompt in role mode',
        site: 'worktree-session.ts:1503',
        opts: { runtime: 'pi', role: 'blank', bead: 'b', prompt: 'p' },
        message: /mutually exclusive/,
      },
      {
        name: 'foreign provider model on the claude runtime',
        site: 'worktree-session.ts:1518',
        opts: { runtime: 'claude', name: 'foreign', model: 'openai-codex/gpt-5.6-luna', attach: false },
        message: /non-Anthropic provider model/,
      },
      {
        name: 'unknown role (sp view fails)',
        site: 'worktree-session.ts:1614',
        opts: { runtime: 'pi', role: 'no-such-role', attach: false },
        handler: (command, args) => (
          command === 'sp' && args[0] === 'view'
            ? { status: 1, stdout: '', stderr: 'specialist not found: no-such-role' }
            : undefined
        ),
        message: /no-such-role/,
      },
      {
        name: 'launcher-owned flag in passthrough',
        site: 'worktree-session.ts:1658',
        opts: { runtime: 'pi', name: 'guard', attach: false, passthrough: ['--session-dir', '/tmp/x'] },
        message: /is set by the launcher and cannot be passed after --/,
      },
      {
        name: 'not inside a git repository',
        site: 'worktree-session.ts:1671',
        opts: { runtime: 'pi', name: 'nogit', attach: false },
        handler: (command, args) => (
          command === 'git' && args.join(' ') === 'rev-parse --show-toplevel'
            ? { status: 128, stdout: '', stderr: 'fatal' }
            : undefined
        ),
        message: /Not inside a git repository/,
      },
      {
        name: 'nested worktree (launched from inside a worktree)',
        site: 'worktree-session.ts:1683',
        opts: { runtime: 'pi', name: 'nested', attach: false },
        handler: (command, args) => (
          command === 'git' && args.join(' ') === 'rev-parse --show-toplevel'
            ? { status: 0, stdout: `${path.join(tempRoot, 'demo', 'nested-checkout')}\n`, stderr: '' }
            : undefined
        ),
        message: /Refusing to create nested worktree/,
      },
      {
        name: 'worktree path already exists',
        site: 'worktree-session.ts:1736',
        opts: { runtime: 'pi', name: 'stale', attach: false },
        prepare: async (repoRoot) => {
          await fs.ensureDir(worktreePathFor(repoRoot, 'pi', 'stale'));
        },
        message: /Worktree path already exists/,
      },
      {
        name: 'git worktree add fallback fails',
        site: 'worktree-session.ts:1759',
        opts: { runtime: 'pi', name: 'addfail', attach: false },
        handler: (command, args) => {
          if (command === 'bd' && args[0] === 'worktree' && args[1] === 'create') {
            return { status: 1, stdout: '', stderr: 'no beads db' };
          }
          if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
            return { status: 1, stdout: '', stderr: 'add failed' };
          }
          return undefined;
        },
        message: /Failed to create worktree at/,
      },
      {
        name: 'no free session name after 10 attempts',
        site: 'worktree-session.ts:2138',
        opts: { runtime: 'pi', name: 'crowded', prompt: 'x', attach: false },
        sessionExists: () => true,
        message: /Could not find a free session name variant/,
      },
      {
        name: 'tmux new-session fails',
        site: 'worktree-session.ts:2173',
        opts: { runtime: 'pi', name: 'newsessfail', prompt: 'x', attach: false },
        handler: (command, args) => (
          command === 'tmux' && args[0] === 'new-session'
            ? { status: 1, stdout: '', stderr: 'tmux is dead' }
            : undefined
        ),
        message: /tmux new-session failed/,
      },
      {
        name: 'pane id unresolvable after session creation',
        site: 'worktree-session.ts:2243',
        opts: { runtime: 'pi', name: 'nopane', prompt: 'x', attach: false },
        handler: (command, args) => (
          command === 'tmux' && args[0] === 'list-panes'
            ? { status: 0, stdout: '\n', stderr: '' }
            : undefined
        ),
        message: /Could not resolve pane id/,
      },
    ];

    // 12 distinct classes here; the launcher has ~20 exit(1) sites in total.
    expect(cases.length).toBeGreaterThanOrEqual(8);

    it.each(cases.map((c) => [c.name, c] as const))(
      'exits 1 (indistinguishably) for: %s',
      async (_name, testCase) => {
        const repoRoot = await makeRepo();
        await testCase.prepare?.(repoRoot);
        if (testCase.compatError) mocked.runtimeCompatibilityError.mockReturnValue(testCase.compatError);
        installSpawnSync({
          repoRoot,
          worktreePath: worktreePathFor(repoRoot, testCase.opts.runtime as 'pi' | 'claude', String(testCase.opts.name ?? 'x')),
          handler: testCase.handler,
          sessionExists: testCase.sessionExists,
        });

        const capture = captureStdio();
        const exitSpy = mockProcessExit();
        const launchWorktreeSession = await importLauncher();

        await expect(
          launchWorktreeSession(testCase.opts as unknown as Parameters<typeof launchWorktreeSession>[0]),
        ).rejects.toThrow('exit:1');

        // The vocabulary: 1. Always 1. Never anything else. (`site` documents
        // which of the ~20 exit(1) call sites this row reaches.)
        expect(testCase.site).toMatch(/^worktree-session\.ts:\d+$/);
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(exitSpy.mock.calls.map((call: unknown[]) => call[0])).toEqual(
          Array(exitSpy.mock.calls.length).fill(1),
        );

        // The ONLY way a caller can tell these apart today is by scraping
        // human prose off stderr. Pinned so K2 has a measurable "before".
        expect(stderrText(capture)).toMatch(testCase.message);

        // No machine-readable output is produced on any failure.
        expect(capture.stdout).toEqual([]);
      },
    );
  });

  // ---------------------------------------------------------------------
  // 5. SESSION-META SCHEMA
  // ---------------------------------------------------------------------

  it.each(['pi', 'claude'] as const)(
    'pins the session-meta schema to exactly {runtime, launchedAt} for %s',
    async (runtime) => {
      const repoRoot = await makeRepo();
      const worktreePath = worktreePathFor(repoRoot, runtime, 'meta');
      installSpawnSync({ repoRoot, worktreePath, paneId: '%3' });

      captureStdio();
      mockProcessExit();
      const launchWorktreeSession = await importLauncher();

      await expect(launchWorktreeSession({
        runtime,
        name: 'meta',
        prompt: 'echo hi',
        attach: false,
      })).rejects.toThrow('exit:0');

      const metaPath = path.join(worktreePath, '.xtrm', 'session-meta.json');
      expect(await fs.pathExists(metaPath)).toBe(true);
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;

      // Exact key set — an ADDED key must fail this test.
      expect(Object.keys(meta).sort()).toEqual(['launchedAt', 'runtime']);
      expect(meta.runtime).toBe(runtime);
      expect(typeof meta.launchedAt).toBe('string');
      // ISO-8601 instant that round-trips through Date.
      expect(new Date(meta.launchedAt as string).toISOString()).toBe(meta.launchedAt);

      // CHARACTERIZATION: current behavior, see xtrm-ozknq.5 — no session id,
      // thread id, or conversation id is persisted anywhere in the worktree.
      // That absence is exactly why `xt attach` resumes POSITIONALLY with
      // hard-coded argv (claude -> --continue, pi -> -c, attach.ts:73-75)
      // instead of resuming a named session. A third runtime cannot be
      // resumed correctly without adding identity here.
      expect(meta).not.toHaveProperty('sessionId');
      expect(meta).not.toHaveProperty('threadId');
      expect(meta).not.toHaveProperty('paneId');
      expect(meta).not.toHaveProperty('sessionName');
    },
  );

  // ---------------------------------------------------------------------
  // 6. WORKTREE AND BRANCH NAMING
  // ---------------------------------------------------------------------

  it.each(['pi', 'claude'] as const)(
    'pins worktree path and branch naming for %s (runtime in the dir name, NOT the branch)',
    async (runtime) => {
      const repoRoot = await makeRepo();
      const slug = 'k1slug';
      const worktreePath = worktreePathFor(repoRoot, runtime, slug);

      let bdArgs: string[] = [];
      let gitArgs: string[] = [];
      installSpawnSync({
        repoRoot,
        worktreePath,
        paneId: '%5',
        handler: (command, args) => {
          // Git-first (CORE-2307): launcher calls `git worktree add` primary;
          // `bd worktree create` is fallback-only (never reached on success).
          if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') gitArgs = [...args];
          if (command === 'bd' && args[0] === 'worktree' && args[1] === 'create') bdArgs = [...args];
          return undefined;
        },
      });

      captureStdio();
      mockProcessExit();
      const launchWorktreeSession = await importLauncher();

      await expect(launchWorktreeSession({
        runtime,
        name: slug,
        prompt: 'echo hi',
        attach: false,
      })).rejects.toThrow('exit:0');

      const expectedWorktree = path.join(
        repoRoot, '.xtrm', 'worktrees', `${path.basename(repoRoot)}-xt-${runtime}-${slug}`,
      );
      const expectedBranch = `xt/${slug}`;

      expect(gitArgs.slice(0, 2)).toEqual(['worktree', 'add']);
      expect(bdArgs).toEqual([]);
      expect(await fs.pathExists(expectedWorktree)).toBe(true);

      // CHARACTERIZATION: current behavior, see xtrm-ozknq.5 — the runtime is
      // encoded in the WORKTREE directory name but deliberately absent from
      // the BRANCH name (worktree-session.ts:1717-1721). Two runtimes launched
      // with the same --name therefore get distinct worktrees but COLLIDE on
      // one branch `xt/<slug>`; the second launch reuses the existing branch
      // via `git worktree add <path> <branch>` or fails. Adding a
      // third runtime widens that collision surface. Asserted explicitly
      // because it is the asymmetry a shared-launcher refactor is most likely
      // to "tidy up" silently.
      // Asserted against the values the LAUNCHER actually passed to
      // `git worktree add`, never against the locally built expectations
      // above — a self-comparison would pass for any implementation.
      // Git-first shape (CORE-2307): ['worktree','add','-b',<branch>,<path>]
      // on new branch, ['worktree','add',<path>,<branch>] on reuse.
      const observedWorktree = gitArgs.includes('-b') ? gitArgs[3] : gitArgs[2];
      const observedBranch = gitArgs.includes('-b') ? gitArgs[2] : gitArgs[3];
      expect(observedBranch).toBe(`xt/${slug}`);
      expect(observedBranch).not.toContain(runtime);
      expect(observedBranch).not.toContain('pi');
      expect(observedBranch).not.toContain('claude');
      expect(path.basename(observedWorktree)).toContain(`-xt-${runtime}-`);
    },
  );

  // ---------------------------------------------------------------------
  // 7. SESSION-NAME COLLISION
  // ---------------------------------------------------------------------

  it('pins collision handling: a taken session name gets a random suffix', async () => {
    const repoRoot = await makeRepo();
    const worktreePath = worktreePathFor(repoRoot, 'pi', 'collide');

    let newSessionArgs: string[] = [];
    installSpawnSync({
      repoRoot,
      worktreePath,
      paneId: '%11',
      // Only the un-suffixed name is taken; the first candidate is free.
      sessionExists: (name) => name === 'pi-collide',
      onNewSession: (args) => { newSessionArgs = [...args]; },
    });

    const capture = captureStdio();
    const exitSpy = mockProcessExit();
    const launchWorktreeSession = await importLauncher();

    await expect(launchWorktreeSession({
      runtime: 'pi',
      name: 'collide',
      prompt: 'echo hi',
      attach: false,
    })).rejects.toThrow('exit:0');

    expect(exitSpy).toHaveBeenCalledWith(0);
    const sessionName = newSessionArgs[newSessionArgs.indexOf('-s') + 1];
    // randomSlug(4) is base36 from Math.random(), so 1-4 chars of [0-9a-z].
    expect(sessionName).toMatch(/^pi-collide-[0-9a-z]{1,4}$/);
    expect(sessionName).not.toBe('pi-collide');

    // The suffixed name is what the stdout contract reports — a caller that
    // assumed `<runtime>-<name>` would address the wrong session.
    expect(capture.stdout).toEqual([`${sessionName}:%11\n`]);
  });

  it('pins collision handling: exits 1 after 10 failed suffix attempts', async () => {
    const repoRoot = await makeRepo();
    const worktreePath = worktreePathFor(repoRoot, 'pi', 'crowded');

    let hasSessionProbes = 0;
    let newSessionCalls = 0;
    installSpawnSync({
      repoRoot,
      worktreePath,
      sessionExists: () => { hasSessionProbes += 1; return true; },
      onNewSession: () => { newSessionCalls += 1; },
    });

    const capture = captureStdio();
    const exitSpy = mockProcessExit();
    const launchWorktreeSession = await importLauncher();

    await expect(launchWorktreeSession({
      runtime: 'pi',
      name: 'crowded',
      prompt: 'echo hi',
      attach: false,
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // 1 probe for the base name + 10 candidate probes (worktree-session.ts:2119-2145).
    expect(hasSessionProbes).toBe(11);
    expect(newSessionCalls).toBe(0);
    expect(stderrText(capture)).toContain("Could not find a free session name variant for 'pi-crowded'");
    expect(capture.stdout).toEqual([]);

    // CHARACTERIZATION: current behavior, see xtrm-ozknq.5 — the worktree and
    // branch created moments earlier are NOT removed on this failure. Cleanup
    // (worktree-session.ts:2161-2165) only deletes the tmux buffer and kills
    // the tmux session; every post-creation failure leaks a worktree.
    expect(await fs.pathExists(worktreePath)).toBe(true);
  });
});
