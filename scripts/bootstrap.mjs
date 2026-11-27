#!/usr/bin/env node
/**
 * XTRM local-checkout bootstrap (CORE-2810).
 *
 * One command that installs and updates the four XTRM checkouts an operator
 * runs from source: core (xt), xtrm (sb, xtprompt, xts), xtmux and specialists.
 *
 * For every repo it:
 *   1. clones it when missing, or fetches and fast-forwards the default branch;
 *   2. never discards local work: a dirty checkout, a diverged branch or a
 *      branch other than the default is reported and left untouched;
 *   3. runs the repo's own install entry point (npm/bun install + npm link,
 *      and for xtmux its install.sh, which also installs the tmux guard);
 *   4. prints a report of which binary resolves to which checkout, commit and
 *      version.
 *
 * `--check` runs the same inspection without writing anything: it fetches to
 * compare against the remote and exits non-zero when the machine has drifted.
 *
 * The script uses no dependencies and runs on the Node version core requires
 * (>= 24), so it also works on a fresh machine before `xt` exists.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_REPO = path.resolve(HERE, '..');

/**
 * The four checkouts, in install order. `links` are the package directories
 * that are globally linked (npm link); `installer` is a repo-local install
 * script that installs more than package links.
 */
const DEFAULT_REPOS = [
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

const USAGE = `usage: bootstrap.sh [options]

Install or update the XTRM checkouts (core, xtrm, xtmux, specialists) from
local git checkouts, and report which binary resolves to which checkout.

options:
  --root <dir>     directory that holds the sibling checkouts (default: ~/dev)
  --check          report drift only; change nothing (fetches to compare)
  --json           machine-readable report on stdout
  --no-install     clone/fast-forward only; skip every install step
  --no-links       skip link creation and the xtmux installer (links are then
                   neither created nor verified)
  -h, --help       this text

environment:
  XTRM_BOOTSTRAP_REPOS_JSON   override the repo table (JSON array of
                              {name, dir, remote, links, installer, extraBins});
                              dirs resolve against --root. Used by tests and for
                              non-standard layouts.
  XTRM_BOOTSTRAP_NPM          npm executable to use (default: npm on PATH,
                              then the npm next to the running node)

exit codes: 0 up to date, 1 drift or incomplete update, 2 usage or hard error.`;

// ---------------------------------------------------------------------------
// small helpers

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function exists(file) {
    try {
        fs.lstatSync(file);
        return true;
    } catch {
        return false;
    }
}

function realpathOrNull(file) {
    try {
        return fs.realpathSync(file);
    } catch {
        return null;
    }
}

function isDirectory(file) {
    try {
        return fs.statSync(file).isDirectory();
    } catch {
        return false;
    }
}

function run(cmd, args, options = {}) {
    const result = spawnSync(cmd, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return {
        status: result.status,
        signal: result.signal,
        stdout: (result.stdout ?? '').trim(),
        stderr: (result.stderr ?? '').trim(),
        error: result.error ? String(result.error.message) : null,
    };
}

function git(cwd, args) {
    return run('git', args, { cwd });
}

function tail(text, lines = 12) {
    if (!text) return '';
    const parts = text.split('\n');
    return parts.slice(-lines).join('\n');
}

function shortError(result) {
    const detail = result.error ?? tail(result.stderr || result.stdout, 6);
    return detail ? ` (${detail.split('\n')[0]})` : '';
}

function expandHome(p) {
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
}

function localBinDir() {
    return path.join(os.homedir(), '.local', 'bin');
}

function stateHome() {
    return process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
}

// ---------------------------------------------------------------------------
// command line

function parseArgs(argv) {
    const opts = {
        root: path.join(os.homedir(), 'dev'),
        check: false,
        json: false,
        install: true,
        links: true,
        help: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const value = () => {
            const next = argv[i + 1];
            if (next === undefined) throw new Error(`${arg} needs a value`);
            i += 1;
            return next;
        };
        switch (arg) {
            case '--root': opts.root = path.resolve(expandHome(value())); break;
            case '--check': opts.check = true; break;
            case '--json': opts.json = true; break;
            case '--no-install': opts.install = false; break;
            case '--no-links': opts.links = false; break;
            case '-h':
            case '--help': opts.help = true; break;
            default: throw new Error(`unknown option: ${arg}`);
        }
    }
    return opts;
}

// ---------------------------------------------------------------------------
// repo table

function loadRepos(opts) {
    const override = process.env.XTRM_BOOTSTRAP_REPOS_JSON;
    let table;
    if (override) {
        try {
            table = JSON.parse(override);
        } catch (error) {
            throw new Error(`XTRM_BOOTSTRAP_REPOS_JSON is not valid JSON: ${error.message}`);
        }
        if (!Array.isArray(table) || table.length === 0) {
            throw new Error('XTRM_BOOTSTRAP_REPOS_JSON must be a non-empty JSON array');
        }
    } else {
        table = DEFAULT_REPOS;
    }
    return table.map((entry) => {
        if (!entry || typeof entry.name !== 'string' || typeof entry.remote !== 'string') {
            throw new Error('each repo entry needs a string name and remote');
        }
        let dir;
        if (override) {
            dir = path.resolve(opts.root, entry.dir ?? entry.name);
        } else if (entry.name === 'core') {
            // The core checkout is the one this script runs from; resolve the
            // MAIN worktree so a run from .xtrm/worktrees/<name>/ never treats
            // the worktree as the checkout to fast-forward.
            dir = mainWorktree(SCRIPT_REPO);
        } else {
            dir = path.resolve(opts.root, entry.dir ?? entry.name);
        }
        return {
            name: entry.name,
            remote: entry.remote,
            dir,
            links: Array.isArray(entry.links) && entry.links.length > 0 ? entry.links : ['.'],
            installer: typeof entry.installer === 'string' ? entry.installer : null,
            extraBins: Array.isArray(entry.extraBins) ? entry.extraBins : [],
        };
    });
}

function mainWorktree(dir) {
    const result = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (result.status !== 0) return dir;
    const commonDir = result.stdout.split('\n')[0];
    if (!commonDir) return dir;
    return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : dir;
}

// ---------------------------------------------------------------------------
// git inspection and update

function detectDefaultBranch(dir) {
    const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (head.status === 0 && head.stdout) return head.stdout.replace(/^origin\//, '');

    const lsRemote = git(dir, ['ls-remote', '--symref', 'origin', 'HEAD']);
    if (lsRemote.status === 0) {
        const match = lsRemote.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
        if (match) return match[1];
    }
    for (const candidate of ['main', 'master']) {
        if (git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]).status === 0) {
            return candidate;
        }
    }
    const current = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return current.status === 0 && current.stdout !== 'HEAD' ? current.stdout : null;
}

function inspectRepo(repo) {
    const state = {
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

    if (git(repo.dir, ['rev-parse', '--git-dir']).status !== 0) {
        state.status = 'not-a-git-checkout';
        state.detail = 'directory exists but is not a git checkout';
        return state;
    }
    state.isRepo = true;

    const pkg = readJson(path.join(repo.dir, 'package.json'));
    state.version = typeof pkg?.version === 'string' ? pkg.version : null;

    const fetch = git(repo.dir, ['fetch', '--prune', 'origin']);
    const fetchFailed = fetch.status !== 0;

    const branchResult = git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    state.branch = branchResult.status === 0 ? branchResult.stdout : null;
    state.defaultBranch = detectDefaultBranch(repo.dir);

    const headResult = git(repo.dir, ['rev-parse', '--short=8', 'HEAD']);
    state.commit = headResult.status === 0 ? headResult.stdout : null;

    const porcelain = git(repo.dir, ['status', '--porcelain=v1', '--untracked-files=normal']);
    if (porcelain.status === 0) {
        const lines = porcelain.stdout ? porcelain.stdout.split('\n') : [];
        for (const line of lines) {
            if (line.startsWith('??')) state.dirty.untracked += 1;
            else state.dirty.tracked += 1;
            if (state.dirty.files.length < 20) state.dirty.files.push(line);
        }
    }

    if (fetchFailed) {
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
        const counts = git(repo.dir, [
            'rev-list', '--left-right', '--count', `HEAD...origin/${state.defaultBranch}`,
        ]);
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

/** Statuses that make an apply stop for this repo without changing it. */
const BLOCKING = new Set(['not-a-git-checkout', 'unknown', 'detached', 'wrong-branch', 'dirty', 'diverged', 'ahead']);

function cloneRepo(repo, log) {
    if (!isDirectory(path.dirname(repo.dir))) fs.mkdirSync(path.dirname(repo.dir), { recursive: true });
    log(`clone  ${repo.name} <- ${repo.remote}`);
    const result = run('git', ['clone', '--quiet', repo.remote, repo.dir]);
    if (result.status !== 0) {
        throw new Error(`git clone ${repo.remote} ${repo.dir} failed${shortError(result)}`);
    }
}

function fastForward(repo, state, log) {
    log(`update ${repo.name} ${state.commit} -> origin/${state.defaultBranch} (fast-forward, ${state.behind} commit(s))`);
    const result = git(repo.dir, ['merge', '--ff-only', `origin/${state.defaultBranch}`]);
    if (result.status !== 0) {
        throw new Error(`git merge --ff-only failed${shortError(result)}`);
    }
}

// ---------------------------------------------------------------------------
// package manager, install and links

function resolveNpm() {
    if (process.env.XTRM_BOOTSTRAP_NPM) return process.env.XTRM_BOOTSTRAP_NPM;
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, 'npm');
        if (exists(candidate)) return candidate;
    }
    const sibling = path.join(path.dirname(process.execPath), 'npm');
    return exists(sibling) ? sibling : 'npm';
}

function resolveBun() {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, 'bun');
        if (exists(candidate)) return candidate;
    }
    return null;
}

function chooseInstall(pkgDir, npm) {
    const bunLock = exists(path.join(pkgDir, 'bun.lock')) || exists(path.join(pkgDir, 'bun.lockb'));
    const npmLock = exists(path.join(pkgDir, 'package-lock.json'));
    const bun = resolveBun();
    if (bunLock && !npmLock && bun) return { cmd: bun, args: ['install', '--frozen-lockfile'], label: 'bun install' };
    if (npmLock) return { cmd: npm, args: ['install', '--no-audit', '--no-fund'], label: 'npm install' };
    return { cmd: npm, args: ['install', '--no-audit', '--no-fund', '--no-package-lock'], label: 'npm install' };
}

function npmGlobalBin(npm) {
    const result = run(npm, ['prefix', '-g']);
    return result.status === 0 && result.stdout ? path.join(result.stdout.split('\n')[0], 'bin') : null;
}

function packageBins(repo) {
    const bins = [];
    for (const rel of repo.links) {
        const pkgDir = path.resolve(repo.dir, rel);
        const pkg = readJson(path.join(pkgDir, 'package.json'));
        if (!pkg) continue;
        const entries = typeof pkg.bin === 'string'
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
    for (const extra of repo.extraBins) {
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

function inspectBins(repos, npm) {
    const npmBin = npmGlobalBin(npm);
    const bins = repos.flatMap((repo) => packageBins(repo));
    const localBin = localBinDir();
    for (const entry of bins) {
        const candidates = entry.via === 'local' ? [localBin] : [npmBin, localBin].filter(Boolean);
        entry.candidates = candidates;
        entry.resolved = null;
        entry.state = 'missing';
        for (const dir of candidates) {
            const candidate = path.join(dir, entry.bin);
            if (!exists(candidate)) continue;
            const resolved = realpathOrNull(candidate) ?? candidate;
            if (!entry.resolved) entry.resolved = resolved;
            if (resolved === (realpathOrNull(entry.expected) ?? entry.expected)) {
                entry.state = 'ok';
                entry.resolved = resolved;
                break;
            }
            entry.state = 'mismatch';
        }
        entry.pathFirst = firstOnPath(entry.bin);
    }
    return bins;
}

function firstOnPath(bin) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, bin);
        if (exists(candidate)) return candidate;
    }
    return null;
}

function installerState() {
    const file = path.join(stateHome(), 'xtmux', 'installer.json');
    const state = readJson(file);
    return state ? { file, state } : { file, state: null };
}

/**
 * The xtmux installer registers a grouped Pi package copy at
 * ~/.pi/agent/packages/xtmux. When the Pi settings instead load the xtmux
 * checkout directly (the object form `{source: <repo>, extensions: [...]}`),
 * running the installer would add a second, duplicate entry. Report that
 * conflict instead of writing it.
 */
function piEntryConflict(repo) {
    const settingsPath = path.join(os.homedir(), '.pi', 'agent', 'settings.json');
    const settings = readJson(settingsPath);
    const entries = Array.isArray(settings?.packages) ? settings.packages : [];
    const repoRoot = realpathOrNull(repo.dir) ?? repo.dir;
    const conflicting = entries.filter((entry) => {
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

function checkInstaller(repo) {
    const { file, state } = installerState();
    const pkg = readJson(path.join(repo.dir, 'package.json'));
    const findings = [];
    const conflict = piEntryConflict(repo);
    if (conflict) return [conflict];
    if (!state) {
        findings.push({ repo: repo.name, kind: 'installer-missing', detail: `no installer state at ${file}` });
        return findings;
    }
    const expectedRoot = realpathOrNull(repo.dir) ?? repo.dir;
    if (state.packageRoot && (realpathOrNull(state.packageRoot) ?? state.packageRoot) !== expectedRoot) {
        findings.push({
            repo: repo.name,
            kind: 'installer-root',
            detail: `installer state points at ${state.packageRoot}, checkout is ${repo.dir}`,
        });
    }
    if (pkg?.version && state.version !== pkg.version) {
        findings.push({
            repo: repo.name,
            kind: 'installer-version',
            detail: `installer state is version ${state.version}, package is ${pkg.version}; re-run the installer`,
        });
    }
    for (const key of ['piPackage', 'claudeHooks']) {
        if (state[key] && !isDirectory(state[key])) {
            findings.push({ repo: repo.name, kind: 'installer-payload', detail: `${key} missing at ${state[key]}` });
        }
    }
    return findings;
}

// ---------------------------------------------------------------------------
// reporting

function driftFor(state) {
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

function formatRepos(states) {
    const rows = states.map((s) => [
        s.name,
        s.branch ?? '-',
        s.commit ?? '-',
        s.status + (s.status === 'ok' && s.dirty.untracked > 0 ? ` (untracked ${s.dirty.untracked})` : ''),
    ]);
    return table(['repo', 'branch', 'commit', 'state'], rows);
}

function formatBins(bins, showAll) {
    const rows = bins
        .filter((entry) => showAll || entry.state !== 'ok' || entry.pathFirst === null)
        .map((entry) => [
            entry.bin,
            entry.resolved ? tilde(entry.resolved) : '-',
            entry.state,
            entry.pathFirst && entry.resolved && realpathOrNull(entry.pathFirst) !== entry.resolved
                ? `PATH first: ${tilde(entry.pathFirst)}`
                : '',
        ]);
    return rows.length > 0 ? table(['binary', 'resolves to', 'state', 'note'], rows) : '';
}

function tilde(p) {
    const home = os.homedir();
    return p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
}

function table(headers, rows) {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
    const line = (cells) => cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();
    return [line(headers), ...rows.map(line)].map((l) => `  ${l}`).join('\n');
}

// ---------------------------------------------------------------------------
// main

function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`bootstrap: ${error.message}\n\n${USAGE}`);
        return 2;
    }
    if (opts.help) {
        console.log(USAGE);
        return 0;
    }

    let repos;
    try {
        repos = loadRepos(opts);
    } catch (error) {
        console.error(`bootstrap: ${error.message}`);
        return 2;
    }

    const npm = resolveNpm();
    const out = opts.json ? () => {} : (line) => console.log(line);
    const problems = [];

    if (!opts.json) {
        out(`XTRM local checkouts — ${opts.check ? 'check (read-only)' : 'bootstrap'}`);
        out(`  root: ${tilde(opts.root)}`);
        out(`  npm:  ${npm}`);
    }

    // 1. clone / fast-forward
    const states = [];
    for (const repo of repos) {
        let state = inspectRepo(repo);
        if (state.status === 'missing' && !opts.check) {
            try {
                cloneRepo(repo, out);
                state = inspectRepo(repo);
            } catch (error) {
                problems.push(`${repo.name}: ${error.message}`);
                state = { ...state, status: 'error', detail: error.message };
                states.push(state);
                continue;
            }
        }
        if (state.status === 'behind' && !opts.check) {
            try {
                fastForward(repo, state, out);
                state = inspectRepo(repo);
            } catch (error) {
                problems.push(`${repo.name}: ${error.message}`);
                state = { ...state, status: 'error', detail: error.message };
            }
        }
        if (!opts.check && BLOCKING.has(state.status) && state.status !== 'missing') {
            problems.push(`${repo.name}: ${state.status} — ${state.detail}`);
        }
        states.push(state);
    }

    // 2. install steps (apply only)
    const installable = states.filter((s) => !BLOCKING.has(s.status) && s.status !== 'error');
    if (!opts.check && opts.install) {
        if (!opts.json) out('');
        for (const state of installable) {
            const repo = repos.find((r) => r.name === state.name);
            if (!repo) continue;
            for (const rel of repo.links) {
                const pkgDir = path.resolve(repo.dir, rel);
                if (!isDirectory(pkgDir)) {
                    problems.push(`${repo.name}: package directory ${rel} is missing`);
                    continue;
                }
                const manager = chooseInstall(pkgDir, npm);
                out(`install ${repo.name}/${rel === '.' ? '' : rel} (${manager.label})`);
                const install = run(manager.cmd, manager.args, { cwd: pkgDir });
                if (install.status !== 0) {
                    problems.push(`${repo.name}/${rel}: ${manager.label} failed${shortError(install)}`);
                    out(`        ${tail(install.stderr || install.stdout, 6)}`);
                    continue;
                }
                if (!opts.links) continue;
                out(`link    ${repo.name}/${rel === '.' ? '' : rel}`);
                const link = run(npm, ['link'], { cwd: pkgDir });
                if (link.status !== 0) {
                    problems.push(`${repo.name}/${rel}: npm link failed${shortError(link)}`);
                    out(`        ${tail(link.stderr || link.stdout, 6)}`);
                }
            }
            if (repo.installer && opts.links) {
                const conflict = piEntryConflict(repo);
                if (conflict) {
                    problems.push(`${repo.name}: ${conflict.detail}`);
                    out(`skip    ${repo.name}/${repo.installer} (Pi entry conflict; see problems)`);
                    continue;
                }
                out(`install ${repo.name}/${repo.installer}`);
                const installer = run('bash', [path.resolve(repo.dir, repo.installer)], { cwd: repo.dir });
                if (installer.status !== 0) {
                    problems.push(`${repo.name}: ${repo.installer} failed${shortError(installer)}`);
                    out(`        ${tail(installer.stderr || installer.stdout, 8)}`);
                }
            }
        }
    }

    // 3. report
    const bins = inspectBins(repos, npm);
    const drift = [];
    for (const state of states) {
        const finding = driftFor(state);
        if (finding) drift.push(finding);
    }
    if (opts.links) {
        for (const entry of bins) {
            if (entry.state === 'missing') {
                drift.push({ repo: entry.repo, kind: 'link-missing', detail: `${entry.bin} is not linked from ${entry.via === 'local' ? '~/.local/bin' : 'the global npm bin'}` });
            } else if (entry.state === 'mismatch') {
                drift.push({ repo: entry.repo, kind: 'link-mismatch', detail: `${entry.bin} resolves to ${tilde(entry.resolved)}, expected ${tilde(entry.expected)}` });
            }
        }
        for (const repo of repos) {
            if (repo.installer) drift.push(...checkInstaller(repo));
        }
    }

    const report = {
        command: 'xtrm-bootstrap/1',
        check: opts.check,
        root: opts.root,
        npm,
        repos: states,
        bins,
        drift,
        problems,
        ok: drift.length === 0 && problems.length === 0,
    };

    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        out('');
        out('checkouts');
        out(formatRepos(states));
        const binsText = formatBins(bins, true);
        if (binsText) {
            out('');
            out('links');
            out(binsText);
        }
        const notable = bins.filter((entry) => entry.pathFirst && entry.resolved
            && realpathOrNull(entry.pathFirst) !== entry.resolved);
        if (notable.length > 0) {
            out('');
            out('warning: PATH resolves these binaries elsewhere; check PATH order');
            for (const entry of notable) out(`  ${entry.bin}: ${tilde(entry.pathFirst)}`);
        }
        if (drift.length > 0) {
            out('');
            out(`drift (${drift.length})`);
            for (const item of drift) out(`  - ${item.repo}: ${item.detail}`);
        }
        if (problems.length > 0) {
            out('');
            out(`problems (${problems.length})`);
            for (const problem of problems) out(`  - ${problem}`);
        }
        out('');
        if (report.ok) {
            out(opts.check ? 'no drift' : 'up to date');
        } else if (opts.check) {
            out(`drift found: ${drift.length} finding(s), ${problems.length} problem(s); run bootstrap.sh to update`);
        } else {
            out(`incomplete: ${problems.length} problem(s); resolve the checkouts above and re-run`);
        }
    }

    return report.ok ? 0 : 1;
}

process.exitCode = main();
