/**
 * Local-checkout phase of the machine bootstrap (CORE-2810).
 *
 * The operator's machines run XTRM from local git checkouts (`npm link` to
 * `~/dev/<repo>`), not from the npm registry. This phase clones or
 * fast-forwards the four checkouts, runs each repository's install entry point
 * (dependency install + `npm link`, and xtmux's own installer, which also
 * places the tmux kill guard), and reports which binary resolves to which
 * checkout, commit and version.
 *
 * It is opt-in: a machine turns it on with `~/.xtrm/config/checkouts.json`
 * (see `loadCheckoutConfig`) or with `xt install --from-checkouts`. `xt update`
 * applies it once configured; `xt doctor` always reports the drift read-only.
 *
 * Safety rules, enforced here:
 *   - uncommitted work is never discarded (no reset, no clean, no force-pull);
 *   - a dirty, diverged, ahead, detached or non-default-branch checkout stops
 *     the update for that repository and is reported;
 *   - `check` writes nothing except the network `fetch`;
 *   - an installer refusal is surfaced with its own diagnostic, never forced;
 *   - git configuration is read, never written.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMainProjectRoot } from '../utils/repo-root.js';

export interface CheckoutRepo {
    name: string;
    dir: string;
    remote: string;
    /** Package directories that are globally linked (npm link). */
    links: string[];
    /** Repository-local installer that installs more than package links. */
    installer?: string;
    /** Bins the installer places itself rather than through npm link. */
    extraBins?: Array<{ bin: string; target: string; via?: 'local' }>;
}

export interface CheckoutConfig {
    /** Directory that holds the sibling checkouts. */
    root: string;
    /** Optional per-repository overrides, merged by name. */
    repos?: Partial<Record<string, Partial<Omit<CheckoutRepo, 'name'>>>>;
    /** Set false to keep the configuration but skip the phase. */
    enabled?: boolean;
}

export interface CheckoutState {
    name: string;
    dir: string;
    remote: string;
    exists: boolean;
    isRepo: boolean;
    branch: string | null;
    defaultBranch: string | null;
    commit: string | null;
    version: string | null;
    ahead: number;
    behind: number;
    dirty: { tracked: number; untracked: number; files: string[] };
    hooksPath?: string;
    beadsHooks?: boolean;
    status: string;
    detail: string;
}

export interface CheckoutBin {
    bin: string;
    repo: string;
    package: string | null;
    version: string | null;
    expected: string;
    via: 'npm' | 'local';
    candidates?: string[];
    resolved?: string | null;
    state?: 'ok' | 'missing' | 'mismatch';
    pathFirst?: string | null;
}

export interface CheckoutFinding {
    repo: string;
    kind: string;
    detail: string;
    diagnostic?: string;
}

export interface CheckoutReport {
    command: 'xt-checkouts/1';
    check: boolean;
    root: string;
    home: string | null;
    npm: string;
    repos: CheckoutState[];
    bins: CheckoutBin[];
    drift: CheckoutFinding[];
    problems: string[];
    ok: boolean;
}

export interface CheckoutPhaseOptions {
    /** Run the phase even when no configuration exists (defaults apply). */
    fromCheckouts?: boolean;
    /** Report only; write nothing. */
    check?: boolean;
    /** Install against this home instead of the real one (rehearsal, tests). */
    home?: string | null;
    /** Verbose line sink; the phase is silent when omitted. */
    log?: (line: string) => void;
    /** Environment overrides for tests (repo table, npm, prefix). */
    env?: NodeJS.ProcessEnv;
}

interface CommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error: string | null;
}

const CHECKOUT_REPO_TABLE: Array<Omit<CheckoutRepo, 'dir'>> = [
    {
        name: 'core',
        remote: 'git@github.com:xtrm-dev/core.git',
        links: ['.', 'packages/pi-extensions'],
    },
    {
        name: 'xtrm',
        remote: 'git@github.com:xtrm-dev/xtrm',
        links: ['packages/substrate', 'packages/xtprompt', 'packages/xts'],
    },
    {
        name: 'xtmux',
        remote: 'git@github.com:Jaggerxtrm/xtmux.git',
        links: ['.'],
        installer: 'install.sh',
        // The kill-server guard is a PATH shadow named `tmux`, not a package bin.
        extraBins: [{ bin: 'tmux', target: 'bin/tmux-guard', via: 'local' }],
    },
    {
        name: 'specialists',
        remote: 'git@github.com:xtrm-dev/specialists.git',
        links: ['.'],
    },
];

const BLOCKING = new Set(['not-a-git-checkout', 'unknown', 'detached', 'wrong-branch', 'dirty', 'diverged', 'ahead']);
const LOCKFILES = ['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml'];
const REFUSAL = /\brefus(e|ed|es|ing|al)\b|not overwrit|already exists and differs|declin/i;

/** `~/.xtrm/config/checkouts.json`, honouring `XTRM_HOME`-style overrides in tests. */
export function checkoutConfigPath(home: string = os.homedir()): string {
    return path.join(home, '.xtrm', 'config', 'checkouts.json');
}

/**
 * Reads the machine's checkout configuration. Absence means "this machine does
 * not install from local checkouts": the phase stays off and `xt doctor` does
 * not report on it.
 */
export function loadCheckoutConfig(home: string = os.homedir()): CheckoutConfig | null {
    const file = checkoutConfigPath(home);
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error(`${file} must hold a JSON object`);
    const config = parsed as CheckoutConfig;
    if (typeof config.root !== 'string' || config.root.length === 0) {
        throw new Error(`${file} needs a string "root"`);
    }
    return config;
}

function expandHome(value: string, home: string): string {
    if (value === '~') return home;
    if (value.startsWith('~/')) return path.join(home, value.slice(2));
    return value;
}

/**
 * Resolves the repository table: the built-in four, overridden by the machine
 * configuration. `core` resolves to the main worktree of the running CLI so a
 * run from `.xtrm/worktrees/<name>/` never treats the worktree as the checkout.
 */
export function resolveCheckoutRepos(config: CheckoutConfig | null, home: string = os.homedir()): CheckoutRepo[] {
    const root = path.resolve(expandHome(config?.root ?? '~/dev', home));
    return CHECKOUT_REPO_TABLE.map((base) => {
        const override = config?.repos?.[base.name] ?? {};
        const merged: CheckoutRepo = { ...base, ...override, name: base.name, dir: '' };
        if (typeof override.dir === 'string' && override.dir.length > 0) {
            merged.dir = path.resolve(expandHome(override.dir, home));
        } else if (base.name === 'core') {
            merged.dir = resolveMainProjectRoot(process.cwd());
        } else {
            merged.dir = path.join(root, base.name);
        }
        return merged;
    });
}

function readJson(file: string): any {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function isDirectory(dir: string): boolean {
    try {
        return fs.lstatSync(dir).isDirectory();
    } catch {
        return false;
    }
}

function realpathOrNull(file: string): string | null {
    try {
        return fs.realpathSync(file);
    } catch {
        return null;
    }
}

function runCommand(
    cmd: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): CommandResult {
    const result = spawnSync(cmd, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return {
        status: result.status,
        stdout: (result.stdout ?? '').trim(),
        stderr: (result.stderr ?? '').trim(),
        error: result.error ? String(result.error.message) : null,
    };
}

function tail(text: string, lines = 12): string {
    if (!text) return '';
    return text.split('\n').slice(-lines).join('\n');
}

function shortError(result: CommandResult): string {
    const detail = result.error ?? tail(result.stderr || result.stdout, 6);
    return detail ? ` (${detail.split('\n')[0]})` : '';
}

interface Context {
    home: string;
    env: NodeJS.ProcessEnv;
}

function git(cwd: string, args: string[], ctx: Context): CommandResult {
    // Git reads machine identity and global config from the real HOME even when
    // the install itself is rehearsed against another home.
    return runCommand('git', args, { cwd, env: { ...ctx.env, HOME: os.homedir() } });
}

function resolveNpm(ctx: Context): string {
    if (ctx.env.XTRM_BOOTSTRAP_NPM) return ctx.env.XTRM_BOOTSTRAP_NPM;
    for (const dir of (ctx.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, 'npm');
        if (fs.existsSync(candidate)) return candidate;
    }
    const sibling = path.join(path.dirname(process.execPath), 'npm');
    return fs.existsSync(sibling) ? sibling : 'npm';
}

function resolveBun(ctx: Context): string | null {
    for (const dir of (ctx.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, 'bun');
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function childEnv(ctx: Context): NodeJS.ProcessEnv {
    if (!ctx.env.XTRM_BOOTSTRAP_HOME_OVERRIDE) return ctx.env;
    const env: NodeJS.ProcessEnv = { ...ctx.env, HOME: ctx.home };
    if (!env.XDG_STATE_HOME) env.XDG_STATE_HOME = path.join(ctx.home, '.local', 'state');
    if (!env.npm_config_prefix) env.npm_config_prefix = path.join(ctx.home, '.npm-global');
    return env;
}

function localBinDir(ctx: Context): string {
    return path.join(ctx.home, '.local', 'bin');
}

function stateHome(ctx: Context): string {
    if (ctx.env.XTRM_BOOTSTRAP_HOME_OVERRIDE) return path.join(ctx.home, '.local', 'state');
    return ctx.env.XDG_STATE_HOME || path.join(ctx.home, '.local', 'state');
}

function detectDefaultBranch(dir: string, ctx: Context): string | null {
    const symbolic = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], ctx);
    if (symbolic.status === 0 && symbolic.stdout) return symbolic.stdout.replace(/^origin\//, '');
    const remote = git(dir, ['remote', 'show', 'origin'], ctx);
    if (remote.status === 0) {
        const match = /HEAD branch:\s*(\S+)/.exec(remote.stdout);
        if (match) return match[1];
    }
    return null;
}

export function inspectCheckoutRepo(repo: CheckoutRepo, ctx: Context): CheckoutState {
    const state: CheckoutState = {
        name: repo.name,
        dir: repo.dir,
        remote: repo.remote,
        exists: isDirectory(repo.dir),
        isRepo: false,
        branch: null,
        defaultBranch: null,
        commit: null,
        version: null,
        ahead: 0,
        behind: 0,
        dirty: { tracked: 0, untracked: 0, files: [] },
        status: 'missing',
        detail: '',
    };
    if (!state.exists) return state;
    if (git(repo.dir, ['rev-parse', '--git-dir'], ctx).status !== 0) {
        state.status = 'not-a-git-checkout';
        state.detail = 'directory exists but is not a git checkout';
        return state;
    }
    state.isRepo = true;

    // A checkout wired to the retired Beads hooks fails inside post-merge on
    // every pull. Report it; never rewrite the machine's git config.
    const hooksPath = git(repo.dir, ['config', '--get', 'core.hooksPath'], ctx);
    if (hooksPath.status === 0 && hooksPath.stdout) {
        state.hooksPath = hooksPath.stdout;
        state.beadsHooks = /(^|\/)\.beads(\/|$)/.test(hooksPath.stdout);
    }

    const pkg = readJson(path.join(repo.dir, 'package.json'));
    state.version = typeof pkg?.version === 'string' ? pkg.version : null;

    const fetch = git(repo.dir, ['fetch', '--prune', 'origin'], ctx);
    const branchResult = git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx);
    state.branch = branchResult.status === 0 ? branchResult.stdout : null;
    state.defaultBranch = detectDefaultBranch(repo.dir, ctx);
    const headResult = git(repo.dir, ['rev-parse', '--short=8', 'HEAD'], ctx);
    state.commit = headResult.status === 0 ? headResult.stdout : null;

    const porcelain = git(repo.dir, ['status', '--porcelain=v1', '--untracked-files=normal'], ctx);
    if (porcelain.status === 0) {
        for (const line of porcelain.stdout ? porcelain.stdout.split('\n') : []) {
            if (line.startsWith('??')) state.dirty.untracked += 1;
            else state.dirty.tracked += 1;
            if (state.dirty.files.length < 20) state.dirty.files.push(line);
        }
    }

    if (fetch.status !== 0) {
        state.status = 'unknown';
        state.detail = `git fetch failed${shortError(fetch)}`;
        return state;
    }
    if (state.branch === 'HEAD') {
        state.status = 'detached';
        state.detail = 'HEAD is detached; expected the default branch';
        return state;
    }
    if (state.defaultBranch && state.branch !== state.defaultBranch) {
        state.status = 'wrong-branch';
        state.detail = `on ${state.branch}, expected ${state.defaultBranch}`;
        return state;
    }
    if (state.dirty.tracked > 0) {
        state.status = 'dirty';
        state.detail = `${state.dirty.tracked} tracked file(s) modified or staged`;
        return state;
    }
    if (state.defaultBranch) {
        const counts = git(repo.dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${state.defaultBranch}`], ctx);
        if (counts.status === 0) {
            const [ahead, behind] = counts.stdout.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
            state.ahead = ahead;
            state.behind = behind;
        }
    }
    if (state.ahead > 0 && state.behind > 0) {
        state.status = 'diverged';
        state.detail = `ahead ${state.ahead}, behind ${state.behind}; refusing to rewrite either side`;
    } else if (state.ahead > 0) {
        state.status = 'ahead';
        state.detail = `${state.ahead} local commit(s) ahead of origin/${state.defaultBranch}`;
    } else if (state.behind > 0) {
        state.status = 'behind';
        state.detail = `${state.behind} commit(s) behind origin/${state.defaultBranch}`;
    } else {
        state.status = 'ok';
    }
    return state;
}

function cloneRepo(repo: CheckoutRepo, ctx: Context, log?: (line: string) => void): void {
    fs.mkdirSync(path.dirname(repo.dir), { recursive: true });
    log?.(`clone   ${repo.name} ← ${repo.remote}`);
    const clone = git(path.dirname(repo.dir), ['clone', '--quiet', repo.remote, repo.dir], ctx);
    if (clone.status !== 0) throw new Error(`git clone failed${shortError(clone)}`);
}

function fastForward(repo: CheckoutRepo, state: CheckoutState, ctx: Context, log?: (line: string) => void): void {
    log?.(`pull    ${repo.name} → origin/${state.defaultBranch} (fast-forward, ${state.behind} commit(s))`);
    const merge = git(repo.dir, ['merge', '--ff-only', `origin/${state.defaultBranch}`], ctx);
    if (merge.status !== 0) throw new Error(`git merge --ff-only failed${shortError(merge)}`);
}

function chooseInstall(pkgDir: string, npm: string, ctx: Context): { cmd: string; args: string[]; label: string } {
    const bunLock = fs.existsSync(path.join(pkgDir, 'bun.lock')) || fs.existsSync(path.join(pkgDir, 'bun.lockb'));
    const npmLock = fs.existsSync(path.join(pkgDir, 'package-lock.json'));
    const bun = resolveBun(ctx);
    if (bunLock && !npmLock && bun) return { cmd: bun, args: ['install', '--frozen-lockfile'], label: 'bun install' };
    if (npmLock) return { cmd: npm, args: ['install', '--no-audit', '--no-fund'], label: 'npm install' };
    return { cmd: npm, args: ['install', '--no-audit', '--no-fund', '--no-package-lock'], label: 'npm install' };
}

function npmGlobalBin(npm: string, ctx: Context): string | null {
    const result = runCommand(npm, ['prefix', '-g'], { env: childEnv(ctx) });
    return result.status === 0 && result.stdout ? path.join(result.stdout.split('\n')[0], 'bin') : null;
}

function packageBins(repo: CheckoutRepo): CheckoutBin[] {
    const bins: CheckoutBin[] = [];
    for (const rel of repo.links) {
        const pkgDir = path.resolve(repo.dir, rel);
        const pkg = readJson(path.join(pkgDir, 'package.json'));
        if (!pkg) continue;
        const entries: Array<[string, string]> = typeof pkg.bin === 'string'
            ? [[String(pkg.name ?? path.basename(pkgDir)).replace(/^@[^/]+\//, ''), pkg.bin]]
            : Object.entries(pkg.bin ?? {});
        for (const [bin, target] of entries) {
            bins.push({
                bin,
                repo: repo.name,
                package: pkg.name ?? null,
                version: pkg.version ?? null,
                expected: path.resolve(pkgDir, String(target)),
                via: 'npm',
            });
        }
    }
    for (const extra of repo.extraBins ?? []) {
        bins.push({
            bin: extra.bin,
            repo: repo.name,
            package: null,
            version: null,
            expected: path.resolve(repo.dir, extra.target),
            via: extra.via === 'local' ? 'local' : 'npm',
        });
    }
    return bins;
}

function firstOnPath(bin: string, ctx: Context): string | null {
    for (const dir of (ctx.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, bin);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

export function inspectCheckoutBins(repos: CheckoutRepo[], npm: string, ctx: Context): CheckoutBin[] {
    const npmBin = npmGlobalBin(npm, ctx);
    const localBin = localBinDir(ctx);
    const bins = repos.flatMap((repo) => packageBins(repo));
    for (const entry of bins) {
        entry.candidates = entry.via === 'local' ? [localBin] : [npmBin, localBin].filter((v): v is string => Boolean(v));
        entry.resolved = null;
        entry.state = 'missing';
        for (const dir of entry.candidates) {
            const candidate = path.join(dir, entry.bin);
            if (!fs.existsSync(candidate)) continue;
            const resolved = realpathOrNull(candidate) ?? candidate;
            if (!entry.resolved) entry.resolved = resolved;
            if (resolved === (realpathOrNull(entry.expected) ?? entry.expected)) {
                entry.state = 'ok';
                entry.resolved = resolved;
                break;
            }
            entry.state = 'mismatch';
        }
        entry.pathFirst = firstOnPath(entry.bin, ctx);
    }
    return bins;
}

/**
 * The xtmux installer registers a grouped Pi package copy at
 * `~/.pi/agent/packages/xtmux`. When the Pi settings instead load the xtmux
 * checkout directly (the object form `{source: <repo>, extensions: [...]}`),
 * running the installer would add a second, duplicate entry. Report the
 * conflict instead of writing it.
 */
function piEntryConflict(repo: CheckoutRepo, ctx: Context): CheckoutFinding | null {
    const settingsPath = path.join(ctx.home, '.pi', 'agent', 'settings.json');
    const settings = readJson(settingsPath);
    const entries = Array.isArray(settings?.packages) ? settings.packages : [];
    const repoRoot = realpathOrNull(repo.dir) ?? repo.dir;
    const conflicting = entries.filter((entry: any) => {
        if (!entry || typeof entry !== 'object' || typeof entry.source !== 'string') return false;
        const source = realpathOrNull(entry.source) ?? path.resolve(entry.source);
        return source === repoRoot;
    });
    if (conflicting.length === 0) return null;
    return {
        repo: repo.name,
        kind: 'pi-entry-conflict',
        detail: `${settingsPath} loads ${repo.name} from the checkout directly (${conflicting.length} entry); `
            + 'the installer would add a second grouped entry — resolve the duplicate in xtmux before re-running it',
    };
}

function checkInstaller(repo: CheckoutRepo, ctx: Context): CheckoutFinding[] {
    const conflict = piEntryConflict(repo, ctx);
    if (conflict) return [conflict];
    const file = path.join(stateHome(ctx), 'xtmux', 'installer.json');
    const state = readJson(file);
    if (!state) return [{ repo: repo.name, kind: 'installer-missing', detail: `no installer state at ${file}` }];
    const findings: CheckoutFinding[] = [];
    const expectedRoot = realpathOrNull(repo.dir) ?? repo.dir;
    if (state.packageRoot && (realpathOrNull(state.packageRoot) ?? state.packageRoot) !== expectedRoot) {
        findings.push({
            repo: repo.name,
            kind: 'installer-root',
            detail: `installer state points at ${state.packageRoot}, checkout is ${repo.dir}`,
        });
    }
    const pkg = readJson(path.join(repo.dir, 'package.json'));
    if (pkg?.version && state.version !== pkg.version) {
        findings.push({
            repo: repo.name,
            kind: 'installer-version',
            detail: `installer state is version ${state.version}, package is ${pkg.version}; re-run the installer`,
        });
    }
    for (const key of ['piPackage', 'claudeHooks'] as const) {
        if (state[key] && !isDirectory(state[key])) {
            findings.push({ repo: repo.name, kind: 'installer-payload', detail: `${key} missing at ${state[key]}` });
        }
    }
    return findings;
}

function cleanTrackedLockfiles(pkgDir: string, ctx: Context): string[] {
    const names: string[] = [];
    for (const name of LOCKFILES) {
        if (!fs.existsSync(path.join(pkgDir, name))) continue;
        if (git(pkgDir, ['ls-files', '--error-unmatch', '--', name], ctx).status !== 0) continue;
        if (git(pkgDir, ['status', '--porcelain=v1', '--', name], ctx).stdout !== '') continue;
        names.push(name);
    }
    return names;
}

/**
 * A package manager may rewrite a tracked lockfile when the committed lockfile
 * is out of sync. Restore it so an update never leaves the checkout it just
 * fast-forwarded dirty, and report the upstream defect.
 */
function restoreLockfiles(pkgDir: string, names: string[], repoName: string, ctx: Context, drift: CheckoutFinding[]): void {
    for (const name of names) {
        if (git(pkgDir, ['status', '--porcelain=v1', '--', name], ctx).stdout === '') continue;
        const restore = git(pkgDir, ['checkout', '--', name], ctx);
        drift.push({
            repo: repoName,
            kind: 'lockfile-rewritten',
            detail: restore.status === 0
                ? `${name} was rewritten by the install step and restored; the committed lockfile is out of sync with package.json, fix it in that repo`
                : `${name} was rewritten by the install step and could not be restored${shortError(restore)}`,
        });
    }
}

function driftFor(state: CheckoutState): CheckoutFinding | null {
    switch (state.status) {
        case 'missing': return { repo: state.name, kind: 'missing', detail: `no checkout at ${state.dir}` };
        case 'not-a-git-checkout': return { repo: state.name, kind: 'not-a-git-checkout', detail: state.detail };
        case 'unknown': return { repo: state.name, kind: 'fetch-failed', detail: state.detail };
        case 'detached': return { repo: state.name, kind: 'detached', detail: state.detail };
        case 'wrong-branch': return { repo: state.name, kind: 'wrong-branch', detail: state.detail };
        case 'dirty': return { repo: state.name, kind: 'dirty', detail: state.detail };
        case 'diverged': return { repo: state.name, kind: 'diverged', detail: state.detail };
        case 'ahead': return { repo: state.name, kind: 'ahead', detail: state.detail };
        case 'behind': return { repo: state.name, kind: 'behind', detail: state.detail };
        default: return null;
    }
}

function beadsHooksFinding(state: CheckoutState): CheckoutFinding | null {
    if (!state.beadsHooks) return null;
    return {
        repo: state.name,
        kind: 'beads-hooks',
        detail: `core.hooksPath=${state.hooksPath} runs the retired Beads hooks; every pull fails inside post-merge. `
            + 'Fix in that checkout: git config --unset core.hooksPath (reported only, not changed)',
    };
}

/** Inspects every checkout without changing anything except the network fetch. */
export function inspectCheckouts(repos: CheckoutRepo[], ctx: Context): CheckoutState[] {
    return repos.map((repo) => inspectCheckoutRepo(repo, ctx));
}

/**
 * Runs the checkout phase. Returns `null` when the machine is not configured
 * and the caller did not ask for it explicitly.
 */
export function runCheckoutPhase(options: CheckoutPhaseOptions = {}): CheckoutReport | null {
    const home = options.home ?? os.homedir();
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    const ctx: Context = { home, env: options.home ? { ...env, XTRM_BOOTSTRAP_HOME_OVERRIDE: '1' } : env };
    const config = loadCheckoutConfig(home);
    if (!options.fromCheckouts && (!config || config.enabled === false)) return null;

    const repos = resolveCheckoutRepos(config, home);
    const npm = resolveNpm(ctx);
    const log = options.log;
    const check = options.check === true;
    const drift: CheckoutFinding[] = [];
    const problems: string[] = [];

    const states: CheckoutState[] = [];
    for (const repo of repos) {
        let state = inspectCheckoutRepo(repo, ctx);
        if (state.status === 'missing' && !check) {
            try {
                cloneRepo(repo, ctx, log);
                state = inspectCheckoutRepo(repo, ctx);
            } catch (error) {
                problems.push(`${repo.name}: ${(error as Error).message}`);
                state = { ...state, status: 'error', detail: (error as Error).message };
            }
        }
        if (state.status === 'behind' && !check) {
            try {
                fastForward(repo, state, ctx, log);
                state = inspectCheckoutRepo(repo, ctx);
            } catch (error) {
                problems.push(`${repo.name}: ${(error as Error).message}`);
                state = { ...state, status: 'error', detail: (error as Error).message };
            }
        }
        if (!check && BLOCKING.has(state.status) && state.status !== 'missing') {
            problems.push(`${repo.name}: ${state.status} — ${state.detail}`);
        }
        states.push(state);
    }

    const installable = states.filter((s) => !BLOCKING.has(s.status) && s.status !== 'error' && s.status !== 'missing');
    if (!check) {
        for (const state of installable) {
            const repo = repos.find((r) => r.name === state.name);
            if (!repo) continue;
            for (const rel of repo.links) {
                const pkgDir = path.resolve(repo.dir, rel);
                if (!isDirectory(pkgDir)) {
                    problems.push(`${repo.name}: package directory ${rel} is missing`);
                    continue;
                }
                const manager = chooseInstall(pkgDir, npm, ctx);
                const lockfiles = cleanTrackedLockfiles(pkgDir, ctx);
                log?.(`install ${repo.name}/${rel === '.' ? '' : rel} (${manager.label})`);
                const install = runCommand(manager.cmd, manager.args, { cwd: pkgDir, env: childEnv(ctx) });
                restoreLockfiles(pkgDir, lockfiles, repo.name, ctx, drift);
                if (install.status !== 0) {
                    problems.push(`${repo.name}/${rel}: ${manager.label} failed${shortError(install)}`);
                    log?.(`        ${tail(install.stderr || install.stdout, 6)}`);
                    continue;
                }
                log?.(`link    ${repo.name}/${rel === '.' ? '' : rel}`);
                const link = runCommand(npm, ['link'], { cwd: pkgDir, env: childEnv(ctx) });
                if (link.status !== 0) {
                    problems.push(`${repo.name}/${rel}: npm link failed${shortError(link)}`);
                    log?.(`        ${tail(link.stderr || link.stdout, 6)}`);
                }
            }
            if (repo.installer) {
                const conflict = piEntryConflict(repo, ctx);
                if (conflict) {
                    drift.push(conflict);
                    log?.(`skip    ${repo.name}/${repo.installer} (Pi entry conflict; see findings)`);
                    continue;
                }
                log?.(`install ${repo.name}/${repo.installer}`);
                const installer = runCommand('bash', [path.resolve(repo.dir, repo.installer)], {
                    cwd: repo.dir,
                    env: childEnv(ctx),
                });
                if (installer.status !== 0) {
                    const diagnostic = installer.stderr || installer.stdout;
                    if (REFUSAL.test(diagnostic)) {
                        // The installer owns the file and declines to overwrite
                        // one it did not write. Surface it, never force or remove.
                        drift.push({
                            repo: repo.name,
                            kind: 'installer-refused',
                            detail: `${repo.installer} refused to overwrite a file it does not own; nothing was forced`,
                            diagnostic: tail(diagnostic, 12),
                        });
                        log?.('        installer refused; diagnostic follows in the report');
                    } else {
                        problems.push(`${repo.name}: ${repo.installer} failed${shortError(installer)}`);
                        log?.(`        ${tail(diagnostic, 8)}`);
                    }
                }
            }
        }
    }

    const bins = inspectCheckoutBins(repos, npm, ctx);
    for (const state of states) {
        const finding = driftFor(state);
        if (finding) drift.push(finding);
        const beads = beadsHooksFinding(state);
        if (beads) drift.push(beads);
    }
    for (const entry of bins) {
        if (entry.state === 'missing') {
            drift.push({
                repo: entry.repo,
                kind: 'link-missing',
                detail: `${entry.bin} is not linked from ${entry.via === 'local' ? '~/.local/bin' : 'the global npm bin'}`,
            });
        } else if (entry.state === 'mismatch') {
            drift.push({
                repo: entry.repo,
                kind: 'link-mismatch',
                detail: `${entry.bin} resolves to ${entry.resolved}, expected ${entry.expected}`,
            });
        }
    }
    for (const repo of repos) {
        if (repo.installer) drift.push(...checkInstaller(repo, ctx));
    }

    return {
        command: 'xt-checkouts/1',
        check,
        root: path.dirname(repos[0]?.dir ?? path.join(home, 'dev')),
        home: options.home ?? null,
        npm,
        repos: states,
        bins,
        drift,
        problems,
        ok: drift.length === 0 && problems.length === 0,
    };
}

export interface CheckoutRenderOptions {
    /** Show every bin, not only the ones in a bad state. */
    allBins?: boolean;
    tildeHome?: string;
}

export function renderCheckoutReport(report: CheckoutReport, options: CheckoutRenderOptions = {}): string[] {
    const home = options.tildeHome ?? os.homedir();
    const tilde = (p: string): string => (p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);
    const lines: string[] = [];
    lines.push(report.check ? 'checkouts (read-only)' : 'checkouts');
    lines.push(`  ${'repo'.padEnd(12)} ${'branch'.padEnd(7)} ${'commit'.padEnd(8)} state`);
    for (const state of report.repos) {
        const suffix = state.status === 'ok' && state.dirty.untracked > 0 ? ` (untracked ${state.dirty.untracked})` : '';
        lines.push(`  ${state.name.padEnd(12)} ${(state.branch ?? '-').padEnd(7)} ${(state.commit ?? '-').padEnd(8)} ${state.status}${suffix}`);
    }
    const bins = options.allBins === false
        ? report.bins.filter((entry) => entry.state !== 'ok' || !entry.pathFirst)
        : report.bins;
    if (bins.length > 0) {
        lines.push('');
        lines.push(`  ${'binary'.padEnd(20)} ${'resolves to'.padEnd(58)} state`);
        for (const entry of bins) {
            const shadow = entry.pathFirst && entry.resolved && (realpathOrNull(entry.pathFirst) ?? entry.pathFirst) !== entry.resolved
                ? `  PATH first: ${tilde(entry.pathFirst)}`
                : '';
            lines.push(`  ${entry.bin.padEnd(20)} ${tilde(entry.resolved ?? '-').padEnd(58)} ${entry.state ?? '-'}${shadow}`);
        }
    }
    if (report.drift.length > 0) {
        lines.push('');
        lines.push(`drift (${report.drift.length})`);
        for (const item of report.drift) {
            lines.push(`  - ${item.repo}: ${item.detail}`);
            if (item.diagnostic) {
                for (const line of item.diagnostic.split('\n')) lines.push(`      ${line}`);
            }
        }
    }
    if (report.problems.length > 0) {
        lines.push('');
        lines.push(`problems (${report.problems.length})`);
        for (const problem of report.problems) lines.push(`  - ${problem}`);
    }
    lines.push('');
    if (report.ok) lines.push(report.check ? 'no drift' : 'up to date');
    else if (report.check) lines.push(`drift found: ${report.drift.length} finding(s), ${report.problems.length} problem(s); run xt install --from-checkouts to update`);
    else lines.push(`incomplete: ${report.problems.length} problem(s); resolve the checkouts above and re-run`);
    return lines;
}

export { CHECKOUT_REPO_TABLE };
