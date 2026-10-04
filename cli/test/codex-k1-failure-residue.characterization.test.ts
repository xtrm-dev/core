import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * K1 characterization — failure residue and resume shape (xtrm-ozknq.5).
 *
 * Every assertion here pins CURRENT behavior of the single shared launcher
 * (cli/src/utils/worktree-session.ts launchWorktreeSession) and of
 * cli/src/commands/attach.ts, so a later shared-launcher refactor cannot
 * change it silently. Some pinned behavior is arguably wrong; those cases
 * carry an explicit CHARACTERIZATION comment. Nothing here is a fix.
 *
 * Determinism strategy: every CLI invocation runs against a throwaway git
 * repo with a hand-built PATH that contains only `node`, `git` and `sh`.
 * tmux, bd, claude and pi are therefore absent unless a test deliberately
 * installs a fake. No real tmux server, no real agent process, no user config
 * (HOME points into the sandbox).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.join(__dirname, '../dist/index.cjs');
const ATTACH_SRC = path.join(__dirname, '../src/commands/attach.ts');

/**
 * The ONLY machine-readable launch output: one `<session_name>:<pane_id>` line
 * (worktree-session.ts:2271-2273, and the --reuse path at :1707-1709).
 * Pane ids are tmux `%N`.
 */
const CONTRACT_LINE = /^[^\s:]+:%\d+$/m;

function which(bin: string): string | null {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, bin);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch { /* keep looking */ }
    }
    return null;
}

function git(args: string[], cwd: string): void {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

let sandbox: string;
let repoDir: string;
/** PATH with node+git+sh only: no tmux, no bd, no claude, no pi. */
let binNoRuntime: string;
/** binNoRuntime plus recording fake `claude` and `pi` shims. */
let binFakeRuntime: string;

function sandboxEnv(bin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    // Deliberately NOT spread from process.env: an inherited TMUX, PATH or
    // HOME would change which launcher branch runs.
    return {
        PATH: bin,
        HOME: sandbox,
        XTRM_SKIP_RUNTIME_COMPAT: '1',
        ...extra,
    };
}

function run(
    args: string[],
    opts: { cwd?: string; bin?: string; extraEnv?: NodeJS.ProcessEnv } = {},
): { stdout: string; stderr: string; status: number } {
    const r = spawnSync('node', [CLI_BIN, ...args], {
        encoding: 'utf8',
        timeout: 30000,
        cwd: opts.cwd ?? repoDir,
        env: sandboxEnv(opts.bin ?? binNoRuntime, opts.extraEnv),
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function branchExists(slug: string): boolean {
    const r = spawnSync('git', ['branch', '--list', `xt/${slug}`], {
        cwd: repoDir, encoding: 'utf8', stdio: 'pipe',
    });
    return (r.stdout ?? '').trim().length > 0;
}

function worktreeEntries(): string[] {
    const dir = path.join(repoDir, '.xtrm', 'worktrees');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function registeredWorktreePaths(): string[] {
    const r = spawnSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoDir, encoding: 'utf8', stdio: 'pipe',
    });
    return (r.stdout ?? '')
        .split('\n')
        .filter(l => l.startsWith('worktree '))
        .map(l => l.slice('worktree '.length).trim());
}

beforeAll(() => {
    const gitBin = which('git');
    const shBin = which('sh') ?? '/bin/sh';
    if (!gitBin) throw new Error('git not found on PATH — required by this suite');
    if (!fs.existsSync(CLI_BIN)) throw new Error(`built CLI missing at ${CLI_BIN} — run: npm run build`);

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-k1-'));

    binNoRuntime = path.join(sandbox, 'bin-no-runtime');
    binFakeRuntime = path.join(sandbox, 'bin-fake-runtime');
    for (const bin of [binNoRuntime, binFakeRuntime]) {
        fs.mkdirSync(bin, { recursive: true });
        fs.symlinkSync(process.execPath, path.join(bin, 'node'));
        fs.symlinkSync(gitBin, path.join(bin, 'git'));
        fs.symlinkSync(shBin, path.join(bin, 'sh'));
    }

    // Recording shims. They write cwd + argv (one per line) to $XT_K1_LOG and
    // exit with a distinctive status so exit-code propagation is observable.
    const shim = (exitCode: number): string =>
        `#!/bin/sh\nprintf '%s\\n' "$PWD" > "$XT_K1_LOG"\nfor a in "$@"; do printf '%s\\n' "$a" >> "$XT_K1_LOG"; done\nexit ${exitCode}\n`;
    fs.writeFileSync(path.join(binFakeRuntime, 'claude'), shim(7), { mode: 0o755 });
    fs.writeFileSync(path.join(binFakeRuntime, 'pi'), shim(5), { mode: 0o755 });

    repoDir = path.join(sandbox, 'myproject');
    fs.mkdirSync(repoDir);
    git(['init'], repoDir);
    git(['config', 'user.email', 'test@test.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'init'], repoDir);

    // CORE-2340: xt resolves the worktree base from a fetched
    // origin/<default> and fails loudly when the fetch fails, so the sandbox
    // repo needs an origin. A local bare remote keeps this offline; the push
    // names the branch `main` explicitly so the fallback resolves regardless
    // of the runner's init.defaultBranch.
    const originDir = path.join(sandbox, 'origin.git');
    fs.mkdirSync(originDir);
    git(['init', '--bare'], originDir);
    git(['remote', 'add', 'origin', originDir], repoDir);
    git(['push', 'origin', 'HEAD:refs/heads/main'], repoDir);
});

afterAll(() => {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('K1 negative proof — post-worktree-creation failure residue (xtrm-ozknq.5)', () => {

    it('leaves the worktree and the xt/<slug> branch behind when tmux new-session fails', () => {
        const slug = 'residue1';

        // --no-attach forces the tmux new-session path (carriesLaunchState is
        // true, worktree-session.ts:1875-1881). tmux is absent from PATH, so
        // spawnSync returns error/null status and failNewSession fires at
        // worktree-session.ts:2173 — i.e. AFTER the worktree already exists
        // (created at :1745-1760, meta written at :1763).
        const r = run(['claude', slug, '--no-attach']);

        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/tmux new-session failed/);
        // No contract line: the launch produced no addressable session.
        expect(r.stdout).not.toMatch(CONTRACT_LINE);

        const wtPath = path.join(repoDir, '.xtrm', 'worktrees', `myproject-xt-claude-${slug}`);

        // CHARACTERIZATION: post-creation failure leaks the worktree and branch.
        // K3-Core must make this deterministic cleanup; when it does, this test
        // MUST be inverted.
        expect(fs.existsSync(wtPath)).toBe(true);
        expect(fs.existsSync(path.join(wtPath, 'README.md'))).toBe(true);
        expect(branchExists(slug)).toBe(true);
        // The leak is not merely a stray directory: git still owns it.
        expect(registeredWorktreePaths().map(p => fs.realpathSync(p)))
            .toContain(fs.realpathSync(wtPath));

        // CHARACTERIZATION: session metadata survives the failed launch too,
        // and it records only { runtime, launchedAt } (worktree-session.ts:1261-1264).
        // No session or thread id is persisted anywhere — the fact that forces
        // K2 to add thread identity for Codex.
        const metaPath = path.join(wtPath, '.xtrm', 'session-meta.json');
        expect(fs.existsSync(metaPath)).toBe(true);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
        expect(Object.keys(meta).sort()).toEqual(['launchedAt', 'runtime']);
        expect(meta.runtime).toBe('claude');
    });

    it('encodes the runtime in the worktree directory name but NOT in the branch name', () => {
        const slug = 'residue2';
        const r = run(['pi', slug, '--no-attach']);

        expect(r.status).toBe(1);

        // worktree-session.ts:1717-1721: <repo>/.xtrm/worktrees/<base>-xt-<runtime>-<slug>,
        // branch xt/<slug>.
        expect(worktreeEntries()).toContain(`myproject-xt-pi-${slug}`);
        expect(branchExists(slug)).toBe(true);

        // CHARACTERIZATION: two runtimes cannot hold the same slug, because the
        // branch name is runtime-free while the directory name is not. Adding a
        // third runtime (codex) does not widen this namespace.
        const collide = run(['claude', slug, '--no-attach']);
        expect(collide.status).toBe(1);
        expect(collide.stdout + collide.stderr).toMatch(/Failed to create worktree|already (exists|used|checked out)/i);
        // The pi worktree from the first launch is untouched by the collision.
        expect(worktreeEntries()).toContain(`myproject-xt-pi-${slug}`);
    });
});

describe('K1 positive control — pre-worktree rejections are clean (xtrm-ozknq.5)', () => {

    // Counterpart to the residue tests: proves those measure a real
    // distinction rather than "nothing is ever cleaned up". Pre-worktree
    // rejections are clean BY CONSTRUCTION (comment at worktree-session.ts:1522-1524),
    // not by any cleanup code.

    it('rejects --bead with --prompt in role mode without creating anything', () => {
        const before = worktreeEntries();
        const r = run(['claude', 'clean1', '--role', 'reviewer', '--bead', 'xtrm-fake1', '--prompt', 'hello', '--no-attach']);

        // worktree-session.ts:1503
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/--bead and --prompt are mutually exclusive/);
        expect(r.stdout).not.toMatch(CONTRACT_LINE);
        // The launcher never even reached the "Launching <runtime> session" banner.
        expect(r.stdout).not.toMatch(/Launching claude session/);

        expect(worktreeEntries()).toEqual(before);
        expect(worktreeEntries()).not.toContain('myproject-xt-claude-clean1');
        expect(branchExists('clean1')).toBe(false);
    });

    it('rejects a foreign-provider --model on claude without creating anything', () => {
        const before = worktreeEntries();
        const r = run(['claude', 'clean2', '--model', 'openai/gpt-5', '--no-attach']);

        // worktree-session.ts:1518
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/non-Anthropic provider model/);
        expect(r.stdout).not.toMatch(CONTRACT_LINE);

        expect(worktreeEntries()).toEqual(before);
        expect(branchExists('clean2')).toBe(false);
    });

    it('rejects a launch from outside a git repository without creating anything', () => {
        const outside = fs.mkdtempSync(path.join(sandbox, 'not-a-repo-'));
        const r = run(['claude', 'clean3', '--no-attach'], { cwd: outside });

        // worktree-session.ts:1671
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Not inside a git repository/);
        expect(r.stdout).not.toMatch(CONTRACT_LINE);
        expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('CHARACTERIZATION: every rejection collapses to exit code 1 — no failure class is distinguishable', () => {
        // ~20 distinct failure sites all call process.exit(1). A caller can only
        // tell them apart by scraping stderr prose. Codex support (K2) and any
        // machine-driven launcher (K3) need a richer code or a JSON error
        // channel; this test pins the current binary 0/1 surface so the
        // widening is provable.
        const codes = [
            run(['claude', 'clean4', '--role', 'reviewer', '--bead', 'b', '--prompt', 'p', '--no-attach']).status,
            run(['claude', 'clean5', '--model', 'openai/gpt-5', '--no-attach']).status,
            run(['claude', 'residue3', '--no-attach']).status, // post-creation tmux failure
        ];
        expect(codes).toEqual([1, 1, 1]);
    });
});

describe('K1 — xt attach resume shape (xtrm-ozknq.5)', () => {

    // CHARACTERIZATION: resume is POSITIONAL. `xt attach` re-runs the runtime
    // in the worktree directory and lets the runtime pick "the last session in
    // this cwd" itself (attach.ts:73-75, spawn at :89-93). No session id, no
    // thread id, no session-meta field carries one — SessionMeta is exactly
    // { runtime, launchedAt }. Codex CANNOT use this shape: `codex resume`
    // requires an explicit thread UUID. This is the precise reason K2 must add
    // thread identity.

    function seedWorktree(runtime: 'claude' | 'pi', slug: string): string {
        const wtPath = path.join(repoDir, '.xtrm', 'worktrees', `myproject-xt-${runtime}-${slug}`);
        git(['worktree', 'add', '-b', `xt/${slug}`, wtPath], repoDir);
        fs.mkdirSync(path.join(wtPath, '.xtrm'), { recursive: true });
        fs.writeFileSync(
            path.join(wtPath, '.xtrm', 'session-meta.json'),
            JSON.stringify({ runtime, launchedAt: '2026-01-01T00:00:00.000Z' }),
        );
        return wtPath;
    }

    it('resumes claude with exactly ["--continue","--dangerously-skip-permissions"] in the worktree cwd', () => {
        const wtPath = seedWorktree('claude', 'att1');
        const log = path.join(sandbox, 'attach-claude.log');

        const r = run(['attach', 'att1'], {
            bin: binFakeRuntime,
            extraEnv: { XT_K1_LOG: log },
        });

        const recorded = fs.readFileSync(log, 'utf8').trim().split('\n');
        const [cwd, ...argv] = recorded;

        // attach.ts:73-75 — hard-coded, positional, id-less.
        expect(argv).toEqual(['--continue', '--dangerously-skip-permissions']);
        // attach.ts:90 — cwd IS the resume key.
        expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(wtPath));
        // attach.ts:95 — child status is propagated verbatim (shim exits 7).
        expect(r.status).toBe(7);
    });

    it('resumes pi with exactly ["-c"] in the worktree cwd', () => {
        const wtPath = seedWorktree('pi', 'att2');
        const log = path.join(sandbox, 'attach-pi.log');

        const r = run(['attach', 'att2'], {
            bin: binFakeRuntime,
            extraEnv: { XT_K1_LOG: log },
        });

        const recorded = fs.readFileSync(log, 'utf8').trim().split('\n');
        const [cwd, ...argv] = recorded;

        expect(argv).toEqual(['-c']);
        expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(wtPath));
        expect(r.status).toBe(5);
    });

    it('attaches without tmux — the resume path is entirely tmux-free', () => {
        // Behavioral half: the attach above already succeeded on a PATH that
        // contains no tmux at all. Source half: attach.ts never names tmux.
        // CHARACTERIZATION: launch goes through tmux, resume does not. The two
        // halves of a session's lifetime use different transports, so a session
        // resumed by `xt attach` loses its pane metadata (@agent_role,
        // @agent_bead, @agent_state).
        const source = fs.readFileSync(ATTACH_SRC, 'utf8');
        expect(source).not.toMatch(/tmux/i);
    });
});

describe('K1 — runtime binary absent (xtrm-ozknq.5)', () => {

    it('CHARACTERIZATION: a plain launch with no runtime binary exits 0 and prints no contract line', () => {
        // worktree-session.ts:1885-1891 — a plain `xt claude <name>` (no flags
        // carrying launch state) spawns the runtime directly and exits with
        // `launchResult.status ?? 0`. When the binary is missing, spawnSync
        // sets .error and leaves .status null, so the launcher reports SUCCESS
        // for a session that never started. The worktree is left behind as
        // well. This is suspect: an operator script cannot distinguish "agent
        // ran and exited cleanly" from "agent was never installed".
        const slug = 'absent1';
        const r = run(['claude', slug]);

        expect(r.status).toBe(0);
        expect(r.stdout).not.toMatch(CONTRACT_LINE);
        expect(r.stdout + r.stderr).not.toMatch(/TypeError|ReferenceError|Cannot read properties/i);
        // Nothing on either stream reports the missing binary.
        expect(r.stdout + r.stderr).not.toMatch(/ENOENT|not found|not installed/i);

        expect(worktreeEntries()).toContain(`myproject-xt-claude-${slug}`);
        expect(branchExists(slug)).toBe(true);
    });

    it('CHARACTERIZATION: pi behaves identically when the pi binary is absent', () => {
        const slug = 'absent2';
        const r = run(['pi', slug]);

        expect(r.status).toBe(0);
        expect(r.stdout).not.toMatch(CONTRACT_LINE);
        expect(worktreeEntries()).toContain(`myproject-xt-pi-${slug}`);
    });

    it('--no-attach never emits a contract line unless tmux produced a pane', () => {
        // The contract line at worktree-session.ts:2271-2273 is written after
        // the pane id resolves — but BEFORE any check that the runtime process
        // actually started (@agent_state is written as 'idle' by the launcher
        // at :947, ahead of the runtime's own hook). With tmux absent we can
        // only pin the negative half: no pane, no line, exit 1.
        const r = run(['claude', 'absent3', '--no-attach']);
        expect(r.status).toBe(1);
        expect(r.stdout.split('\n').filter(l => CONTRACT_LINE.test(l))).toEqual([]);
    });
});
