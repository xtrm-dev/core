import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    inspectCheckoutBins,
    loadCheckoutConfig,
    redactRemote,
    redactText,
    resolveCheckoutRepos,
    runCheckoutPhase,
    type CheckoutConfig,
} from '../core/checkout-bootstrap.js';
import { checkoutInitMode } from '../commands/init.js';

/**
 * CORE-2810: the checkout phase must never discard local work, must be
 * idempotent, and must report every state it refuses to change. Each test owns
 * a temporary home (config, npm prefix, ~/.local/bin, installer state) and a
 * temporary set of checkouts wired to a local bare origin.
 */

const scratch: string[] = [];

function tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    scratch.push(dir);
    return dir;
}

function git(cwd: string, ...args: string[]): string {
    // A CI runner has no global git identity; commit identity is per invocation
    // so the fixture never depends on the machine's git configuration.
    const identity = ['-c', 'user.name=xtrm-checkout-test', '-c', 'user.email=checkout-test@example.invalid'];
    const result = spawnSync('git', [...identity, ...args], { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

interface Fixture {
    home: string;
    dir: string;
    origin: string;
    seed: string;
}

/** A checkout of `pkg` at `dir`, fast-forwardable from a local bare origin. */
function fixture(name: string, pkg: Record<string, unknown> = { name, version: '1.0.0' }): Fixture {
    const base = tmp(`xt-checkouts-${name}-`);
    const origin = path.join(base, 'origin.git');
    const seed = path.join(base, 'seed');
    const home = path.join(base, 'home');
    const dir = path.join(base, name);
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(seed, { recursive: true });
    git(base, 'init', '--bare', '--initial-branch=main', origin);
    git(seed, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(seed, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'initial');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-u', 'origin', 'main');
    return { home, dir, origin, seed };
}

function clone(fixture: Fixture, name: string): string {
    git(path.dirname(fixture.dir), 'clone', '--quiet', fixture.origin, fixture.dir);
    return fixture.dir;
}

/** Writes a checkouts.json that points all four built-in repos at temp dirs. */
function writeConfig(home: string, repos: Record<string, unknown>, extra: Partial<CheckoutConfig> = {}): void {
    const file = path.join(home, '.xtrm', 'config', 'checkouts.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ root: path.join(home, 'dev'), repos, ...extra }, null, 2));
}

function phase(home: string, overrides: Partial<Parameters<typeof runCheckoutPhase>[0]> = {}) {
    return runCheckoutPhase({ home, check: false, ...overrides });
}

/**
 * A fake npm: `prefix` reports its own temp prefix, `install` optionally
 * rewrites package-lock.json, and `link` creates the bin symlinks the real
 * `npm link` would create. Nothing here touches the machine's global prefix.
 */
function fakeNpm(dir: string, behaviour: 'rewrite-lock' | 'ok' = 'ok'): string {
    const file = path.join(dir, 'fake-npm');
    fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const prefix = path.join(process.env.FAKE_NPM_DIR, 'prefix');
const cmd = process.argv[2];
if (cmd === 'prefix') { console.log(prefix); process.exit(0); }
if (cmd === 'install') {
  if (process.env.FAKE_NPM_REWRITE_LOCK === '1') fs.writeFileSync('package-lock.json', '{"lockfileVersion":3,"changed":true}\\n');
  process.exit(0);
}
if (cmd === 'link') {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin || {});
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  for (const [name, target] of Object.entries(bins)) {
    fs.symlinkSync(path.resolve(String(target)), path.join(prefix, 'bin', name));
  }
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
    return file;
}

function fakeEnv(dir: string, behaviour: 'rewrite-lock' | 'ok' = 'ok'): NodeJS.ProcessEnv {
    return {
        // The fake npm is a `#!/usr/bin/env node` script: it needs PATH.
        PATH: process.env.PATH ?? '',
        XTRM_BOOTSTRAP_NPM: fakeNpm(dir, behaviour),
        FAKE_NPM_DIR: dir,
        ...(behaviour === 'rewrite-lock' ? { FAKE_NPM_REWRITE_LOCK: '1' } : {}),
    };
}

/**
 * Overrides for the repos a test does not exercise: they point at an empty
 * local bare repository so a missing checkout clones from disk, never from
 * GitHub, and `links: []` keeps the install step out of the picture.
 */
function idleRepos(home: string, names: string[]): Record<string, unknown> {
    const repos: Record<string, unknown> = {};
    for (const name of names) {
        const base = path.join(home, 'idle', name);
        fs.mkdirSync(base, { recursive: true });
        const origin = path.join(base, 'origin.git');
        if (!fs.existsSync(origin)) git(base, 'init', '--bare', '--initial-branch=main', origin);
        repos[name] = { dir: path.join(base, name), remote: origin, links: [] };
    }
    return repos;
}

afterEach(() => {
    for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('checkout configuration', () => {
    let home: string;
    beforeEach(() => { home = tmp('xt-checkouts-config-'); });

    it('returns null when the machine has no configuration', () => {
        expect(loadCheckoutConfig(home)).toBeNull();
        expect(runCheckoutPhase({ home, check: true })).toBeNull();
    });

    it('honours enabled:false without forgetting the configuration', () => {
        writeConfig(home, {}, { enabled: false });
        expect(loadCheckoutConfig(home)?.enabled).toBe(false);
        expect(runCheckoutPhase({ home, check: true })).toBeNull();
    });

    it('rejects a configuration without a root', () => {
        const file = path.join(home, '.xtrm', 'config', 'checkouts.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ repos: {} }));
        expect(() => loadCheckoutConfig(home)).toThrow(/needs a string "root"/);
    });

    it('resolves core to the running checkout only when that checkout IS core', () => {
        const root = path.join(home, 'dev');
        const foreign = tmp('xt-checkouts-foreign-');
        const fromForeign = resolveCheckoutRepos({ root }, home, foreign);
        expect(fromForeign.find((repo) => repo.name === 'core')?.dir).toBe(path.join(root, 'core'));
        expect(fromForeign.map((repo) => repo.name)).toEqual(['core', 'xtrm', 'xtmux', 'specialists']);

        // A core checkout (package `xtrm-tools` with its cli/) is the one case
        // where the running project is the checkout: a worktree must not be.
        const coreDir = path.join(home, 'core-checkout');
        fs.mkdirSync(path.join(coreDir, 'cli'), { recursive: true });
        fs.writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({ name: 'xtrm-tools', version: '9.9.9' }));
        const fromCore = resolveCheckoutRepos({ root }, home, coreDir);
        expect(fromCore.find((repo) => repo.name === 'core')?.dir).toBe(coreDir);
    });

    it('never treats a foreign repository as the core checkout', () => {
        const other = fixture('other', { name: 'other-project', version: '1.0.0' });
        clone(other, 'other');
        const root = path.join(home, 'dev');
        const repos = resolveCheckoutRepos({ root }, home, other.dir);
        expect(repos.find((repo) => repo.name === 'core')?.dir).toBe(path.join(root, 'core'));
    });
});

describe('checkout states', () => {
    it('reports a clean checkout as ok and a fast-forwardable one as behind', () => {
        const f = fixture('xtrm');
        clone(f, 'xtrm');
        fs.writeFileSync(path.join(f.seed, 'package.json'), `${JSON.stringify({ name: 'xtrm', version: '1.0.1' })}\n`);
        git(f.seed, 'commit', '-am', 'bump');
        git(f.seed, 'push');
        writeConfig(f.home, { ...idleRepos(f.home, ['core', 'xtmux', 'specialists']), xtrm: { dir: f.dir, remote: f.origin, links: [] } });

        // A report writes nothing and does not fetch: it compares against the
        // remote refs from the last fetch, so the new upstream commit is unseen.
        fs.rmSync(path.join(f.dir, '.git', 'FETCH_HEAD'), { force: true });
        const stale = phase(f.home, { check: true });
        expect(stale?.fetched).toBe(false);
        expect(stale?.repos.find((repo) => repo.name === 'xtrm')?.status).toBe('ok');
        expect(fs.existsSync(path.join(f.dir, '.git', 'FETCH_HEAD'))).toBe(false);

        // --fetch is the explicit opt-in for the network; still no checkout write.
        const check = phase(f.home, { check: true, fetch: true });
        expect(check?.fetched).toBe(true);
        const xtrm = check?.repos.find((repo) => repo.name === 'xtrm');
        expect(xtrm?.status).toBe('behind');
        expect(xtrm?.behind).toBe(1);
        expect(git(f.dir, 'rev-parse', '--short=8', 'HEAD')).not.toBe(git(f.seed, 'rev-parse', '--short=8', 'HEAD'));

        const applied = phase(f.home);
        expect(applied?.repos.find((repo) => repo.name === 'xtrm')?.status).toBe('ok');
        expect(git(f.dir, 'rev-parse', 'HEAD')).toBe(git(f.seed, 'rev-parse', 'HEAD'));
    });

    it('blocks a dirty checkout and preserves the modification', () => {
        const f = fixture('xtrm');
        clone(f, 'xtrm');
        fs.writeFileSync(path.join(f.dir, 'package.json'), '{ "local": true }\n');
        writeConfig(f.home, { ...idleRepos(f.home, ['core', 'xtmux', 'specialists']), xtrm: { dir: f.dir, remote: f.origin, links: [] } });

        const report = phase(f.home);
        expect(report?.repos.find((repo) => repo.name === 'xtrm')?.status).toBe('dirty');
        expect(report?.problems.some((p) => p.includes('xtrm: dirty'))).toBe(true);
        expect(fs.readFileSync(path.join(f.dir, 'package.json'), 'utf8')).toBe('{ "local": true }\n');
    });

    it('clones a missing checkout and leaves untracked files alone', () => {
        const f = fixture('specialists');
        writeConfig(f.home, { ...idleRepos(f.home, ['core', 'xtrm', 'xtmux']), specialists: { dir: f.dir, remote: f.origin, links: [] } });

        const report = phase(f.home);
        expect(report?.repos.find((repo) => repo.name === 'specialists')?.status).toBe('ok');
        expect(fs.existsSync(path.join(f.dir, 'package.json'))).toBe(true);

        fs.writeFileSync(path.join(f.dir, 'scratch.txt'), 'keep me\n');
        const again = phase(f.home);
        const state = again?.repos.find((repo) => repo.name === 'specialists');
        expect(state?.status).toBe('ok');
        expect(state?.dirty.untracked).toBe(1);
        expect(fs.readFileSync(path.join(f.dir, 'scratch.txt'), 'utf8')).toBe('keep me\n');
    });

    it('refuses a diverged checkout instead of rewriting either side', () => {
        const f = fixture('xtmux');
        clone(f, 'xtmux');
        git(f.dir, 'commit', '--allow-empty', '-m', 'local work');
        fs.writeFileSync(path.join(f.seed, 'upstream.txt'), 'upstream\n');
        git(f.seed, 'add', '.');
        git(f.seed, 'commit', '-m', 'upstream work');
        git(f.seed, 'push');
        writeConfig(f.home, { ...idleRepos(f.home, ['core', 'xtrm', 'specialists']), xtmux: { dir: f.dir, remote: f.origin, links: [] } });

        const report = phase(f.home);
        expect(report?.repos.find((repo) => repo.name === 'xtmux')?.status).toBe('diverged');
        expect(report?.problems.some((p) => p.includes('xtmux: diverged'))).toBe(true);
        expect(git(f.dir, 'log', '--format=%s', '-1')).toBe('local work');
    });

    it('clones the four checkouts into the root when run from a foreign directory', () => {
        const home = tmp('xt-checkouts-fresh-');
        const root = path.join(home, 'dev');
        const repos: Record<string, unknown> = {};
        for (const name of ['core', 'xtrm', 'xtmux', 'specialists']) {
            const base = path.join(home, 'origins', name);
            fs.mkdirSync(base, { recursive: true });
            const origin = path.join(base, 'origin.git');
            git(base, 'init', '--bare', '--initial-branch=main', origin);
            const seed = path.join(base, 'seed');
            fs.mkdirSync(seed, { recursive: true });
            git(seed, 'init', '--initial-branch=main');
            fs.writeFileSync(path.join(seed, 'package.json'), `${JSON.stringify({ name, version: '1.0.0' })}\n`);
            git(seed, 'add', '.');
            git(seed, 'commit', '-m', 'initial');
            git(seed, 'remote', 'add', 'origin', origin);
            git(seed, 'push', '-u', 'origin', 'main');
            // Empty installer/extraBins override the built-in xtmux entries:
            // this test exercises cloning, not installation.
            repos[name] = { remote: origin, links: [], installer: '', extraBins: [] };
        }
        writeConfig(home, repos, { root });
        const cwd = tmp('xt-checkouts-foreign-cwd-');

        const report = phase(home, { cwd, env: fakeEnv(home) });
        expect(report?.repos.map((repo) => repo.dir)).toEqual(
            ['core', 'xtrm', 'xtmux', 'specialists'].map((name) => path.join(root, name)),
        );
        for (const name of ['core', 'xtrm', 'xtmux', 'specialists']) {
            expect(fs.existsSync(path.join(root, name, 'package.json'))).toBe(true);
        }
        // Nothing was installed or linked in the directory the run stood in.
        expect(fs.existsSync(path.join(cwd, 'package.json'))).toBe(false);
        expect(report?.problems).toEqual([]);
    });

    it('reports the retired Beads hooks without rewriting git config', () => {
        const f = fixture('xtmux');
        clone(f, 'xtmux');
        git(f.dir, 'config', 'core.hooksPath', '.beads/hooks');
        writeConfig(f.home, { ...idleRepos(f.home, ['core', 'xtrm', 'specialists']), xtmux: { dir: f.dir, remote: f.origin, links: [] } });

        const report = phase(f.home, { check: true });
        expect(report?.drift.some((item) => item.kind === 'beads-hooks' && item.repo === 'xtmux')).toBe(true);
        expect(git(f.dir, 'config', '--get', 'core.hooksPath')).toBe('.beads/hooks');
    });
});

describe('install, link and installer behaviour', () => {
    function configured(f: Fixture, extras: Record<string, unknown> = {}) {
        writeConfig(f.home, {
            ...idleRepos(f.home, ['core', 'xtrm', 'specialists']),
            xtmux: { dir: f.dir, remote: f.origin, links: [] },
            ...extras,
        });
    }

    it('links the package bins into the rehearsal home and reports them ok', () => {
        const f = fixture('xtmux', { name: 'xtmux-fixture', version: '1.0.0', bin: { 'xtmux-fixture': 'index.js' } });
        clone(f, 'xtmux');
        fs.writeFileSync(path.join(f.dir, 'index.js'), '#!/usr/bin/env node\n');
        git(f.dir, 'add', '.');
        git(f.dir, 'commit', '-m', 'bin');
        git(f.dir, 'push');
        configured(f, { xtmux: { dir: f.dir, remote: f.origin, links: ['.'] } });
        const report = phase(f.home, { env: fakeEnv(f.home) });
        const bin = report?.bins.find((entry) => entry.bin === 'xtmux-fixture');
        expect(bin?.state).toBe('ok');
        expect(bin?.commit).toBe(git(f.dir, 'rev-parse', '--short=8', 'HEAD'));
        expect(fs.existsSync(path.join(f.home, 'prefix', 'bin', 'xtmux-fixture'))).toBe(true);
    });

    it('restores a tracked lockfile the install step rewrote', () => {
        const f = fixture('xtmux', { name: 'xtmux-fixture', version: '1.0.0' });
        clone(f, 'xtmux');
        fs.writeFileSync(path.join(f.dir, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
        git(f.dir, 'add', '.');
        git(f.dir, 'commit', '-m', 'lock');
        git(f.dir, 'push');
        configured(f, { xtmux: { dir: f.dir, remote: f.origin, links: ['.'] } });
        const report = phase(f.home, { env: fakeEnv(f.home, 'rewrite-lock') });
        expect(report?.drift.some((item) => item.kind === 'lockfile-rewritten')).toBe(true);
        expect(fs.readFileSync(path.join(f.dir, 'package-lock.json'), 'utf8')).toBe('{ "lockfileVersion": 3 }\n');
    });

    it('surfaces an installer refusal and forces nothing', () => {
        const f = fixture('xtmux', { name: 'xtmux-fixture', version: '1.0.0' });
        clone(f, 'xtmux');
        fs.writeFileSync(path.join(f.dir, 'install.sh'), '#!/usr/bin/env bash\necho "refusing to overwrite a user-customised file" >&2\nexit 1\n');
        git(f.dir, 'add', '.');
        git(f.dir, 'commit', '-m', 'installer');
        git(f.dir, 'push');
        configured(f, { xtmux: { dir: f.dir, remote: f.origin, links: [], installer: 'install.sh' } });

        const report = phase(f.home, { env: fakeEnv(f.home) });
        const refused = report?.drift.find((item) => item.kind === 'installer-refused');
        expect(refused?.repo).toBe('xtmux');
        expect(refused?.diagnostic).toContain('refusing to overwrite');
        expect(report?.problems.some((p) => p.includes('install.sh'))).toBe(false);
    });

    it('skips the installer when the Pi settings load the checkout directly', () => {
        const f = fixture('xtmux', { name: 'xtmux-fixture', version: '1.0.0' });
        clone(f, 'xtmux');
        fs.writeFileSync(path.join(f.dir, 'install.sh'), '#!/usr/bin/env bash\ntouch "$HOME/installer-ran"\n');
        git(f.dir, 'add', '.');
        git(f.dir, 'commit', '-m', 'installer');
        git(f.dir, 'push');
        configured(f, { xtmux: { dir: f.dir, remote: f.origin, links: [], installer: 'install.sh' } });
        const piDir = path.join(f.home, '.pi', 'agent');
        fs.mkdirSync(piDir, { recursive: true });
        fs.writeFileSync(path.join(piDir, 'settings.json'), JSON.stringify({
            packages: [{ source: f.dir, extensions: ['index.ts'] }],
        }));

        const report = phase(f.home, { env: fakeEnv(f.home) });
        expect(report?.drift.some((item) => item.kind === 'pi-entry-conflict')).toBe(true);
        expect(fs.existsSync(path.join(f.home, 'installer-ran'))).toBe(false);
    });

    it('is idempotent: a second apply reports the same state and writes nothing new', () => {
        const f = fixture('xtmux', { name: 'xtmux-fixture', version: '1.0.0', bin: { 'xtmux-fixture': 'index.js' } });
        clone(f, 'xtmux');
        fs.writeFileSync(path.join(f.dir, 'index.js'), '#!/usr/bin/env node\n');
        git(f.dir, 'add', '.');
        git(f.dir, 'commit', '-m', 'bin');
        git(f.dir, 'push');
        configured(f, { xtmux: { dir: f.dir, remote: f.origin, links: ['.'] } });
        const env = fakeEnv(f.home);

        const first = phase(f.home, { env });
        const second = phase(f.home, { env });
        expect(second?.ok).toBe(first?.ok);
        expect(second?.drift.map((item) => `${item.repo}:${item.kind}`)).toEqual(first?.drift.map((item) => `${item.repo}:${item.kind}`));
        expect(git(f.dir, 'status', '--porcelain')).toBe('');
    });
});

describe('broken checkouts', () => {
    it('never reports a git directory without HEAD as a clean checkout', () => {
        // The shape a clone killed mid-transfer leaves behind: a .git with no
        // HEAD, so no branch and no commit, and nothing to fast-forward.
        const base = tmp('xt-checkouts-halfclone-');
        const dir = path.join(base, 'xtmux');
        fs.mkdirSync(dir, { recursive: true });
        git(dir, 'init', '--initial-branch=main');
        fs.rmSync(path.join(dir, '.git', 'HEAD'));

        const home = path.join(base, 'home');
        fs.mkdirSync(home, { recursive: true });
        writeConfig(home, {
            ...idleRepos(home, ['core', 'xtrm', 'specialists']),
            xtmux: { dir, remote: 'https://example.invalid/xtmux.git', links: [] },
        });

        const report = phase(home, { check: true });
        const state = report?.repos.find((repo) => repo.name === 'xtmux');
        expect(state?.status).toBe('not-a-git-checkout');
        expect(state?.detail).toMatch(/cannot resolve|no resolvable HEAD/);
        expect(report?.drift.some((item) => item.repo === 'xtmux' && item.kind === 'not-a-git-checkout')).toBe(true);

        // An apply run must not touch it and must report it as a problem.
        const applied = phase(home);
        expect(applied?.problems.some((problem) => problem.startsWith('xtmux:'))).toBe(true);
        expect(fs.existsSync(path.join(dir, '.git', 'HEAD'))).toBe(false);
    });
});

describe('bin inspection', () => {
    it('reports a missing link and a mismatch separately', () => {
        const home = tmp('xt-checkouts-bins-');
        const repoDir = path.join(home, 'xtmux');
        fs.mkdirSync(repoDir, { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'xtmux-fixture', version: '1.0.0', bin: { 'xtmux-fixture': 'index.js' } }));
        const repo = { name: 'xtmux', dir: repoDir, remote: '', links: ['.'] };
        const env = fakeEnv(home);
        const npm = env.XTRM_BOOTSTRAP_NPM as string;
        const missing = inspectCheckoutBins([repo], npm, { home, env });
        expect(missing[0].state).toBe('missing');

        const binDir = path.join(home, 'prefix', 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.symlinkSync('/bin/true', path.join(binDir, 'xtmux-fixture'));
        const mismatch = inspectCheckoutBins([repo], npm, { home, env });
        expect(mismatch[0].state).toBe('mismatch');
    });
});

describe('report redaction', () => {
    it('strips URL credentials and token-shaped strings, and caps the text', () => {
        expect(redactRemote('https://x-access-token:tok@github.com/o/r.git')).toBe('https://github.com/o/r.git');
        expect(redactRemote('https://user:pass@example.invalid/r.git')).toBe('https://example.invalid/r.git');
        expect(redactRemote('git@github.com:xtrm-dev/core.git')).toBe('git@github.com:xtrm-dev/core.git');

        const noisy = [
            "fatal: unable to access 'http://x-access-token:abc123secret@example.invalid/r.git'",
            'Authorization: Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaa',
            'password=hunter2',
            ...Array.from({ length: 10 }, (_, index) => `line ${index}`),
        ].join('\n');
        const scrubbed = redactText(noisy);
        expect(scrubbed).not.toContain('abc123secret');
        expect(scrubbed).not.toContain('ghp_');
        expect(scrubbed).not.toContain('hunter2');
        expect(scrubbed.split('\n').length).toBeLessThanOrEqual(7);
        expect(redactText('x'.repeat(900)).length).toBeLessThanOrEqual(601);
    });

    it('redacts query parameters, a wrapped Authorization header and a slashy password', () => {
        // A password that contains '/' used to end the URL match early.
        expect(redactRemote('https://user:pa/ss@example.invalid/r.git')).toBe('https://example.invalid/r.git');
        expect(redactRemote('https://tok@example.invalid/r.git')).toBe('https://example.invalid/r.git');

        const query = redactText('clone https://example.invalid/r.git?private_token=abc123&access_token=def456&page=2');
        expect(query).not.toContain('abc123');
        expect(query).not.toContain('def456');
        expect(query).toContain('page=2');

        // A bare pair, a fragment, and a name boundary that keeps `monkey`
        // while `api_key` is still a key.
        const bare = redactText('access_token=abc999 uploaded; #private_token=def888; ?monkey=1&api_key=x7');
        expect(bare).not.toContain('abc999');
        expect(bare).not.toContain('def888');
        expect(bare).not.toContain('x7');
        expect(bare).toContain('monkey=1');
        expect(redactText('?client_secret=zzz&version=1.2.3')).toBe('?client_secret=[redacted]&version=1.2.3');

        const wrapped = redactText(['GET /r.git', 'Authorization: Basic', 'dXNlcjpzM2NyZXQ='].join('\n'));
        expect(wrapped).not.toContain('dXNlcjpzM2NyZXQ=');
        expect(wrapped).toContain('Authorization: Basic');
        expect(wrapped.split('\n')[0]).toBe('GET /r.git');
    });

    it('redacts the live log lines as well as the report', () => {
        const f = fixture('xtmux', { name: 'xtmux-fixture', version: '1.0.0' });
        clone(f, 'xtmux');
        fs.writeFileSync(path.join(f.dir, 'install.sh'), [
            '#!/usr/bin/env bash',
            'echo "fetching https://x-access-token:live-token@example.invalid/xtmux.git" >&2',
            'echo "access_token=ghp_cccccccccccccccccccc" >&2',
            'exit 0',
            '',
        ].join('\n'));
        git(f.dir, 'add', '.');
        git(f.dir, 'commit', '-m', 'installer');
        git(f.dir, 'push');
        writeConfig(f.home, {
            ...idleRepos(f.home, ['core', 'xtrm', 'specialists']),
            xtmux: { dir: f.dir, remote: f.origin, links: [], installer: 'install.sh' },
        });

        const lines: string[] = [];
        phase(f.home, { env: fakeEnv(f.home), log: (line) => lines.push(line) });
        const log = lines.join('\n');
        expect(log).toContain('install xtmux/install.sh');
        expect(log).not.toContain('live-token');
        expect(log).not.toContain('ghp_cccc');
    });

    it('redacts a credentialed remote and a refusal diagnostic in the report', () => {
        const f = fixture('xtmux', { name: 'xtmux-fixture', version: '1.0.0' });
        clone(f, 'xtmux');
        fs.writeFileSync(path.join(f.dir, 'install.sh'), [
            '#!/usr/bin/env bash',
            'echo "refusing to overwrite a user-customised file" >&2',
            'echo "== Info: \'http://x-access-token:leaked-token@example.invalid/xtmux.git\'" >&2',
            'echo "token=ghp_bbbbbbbbbbbbbbbbbbbb" >&2',
            'for i in $(seq 1 20); do echo "trace $i" >&2; done',
            'exit 1',
            '',
        ].join('\n'));
        git(f.dir, 'add', '.');
        git(f.dir, 'commit', '-m', 'installer');
        git(f.dir, 'push');
        writeConfig(f.home, {
            ...idleRepos(f.home, ['core', 'xtrm', 'specialists']),
            xtmux: { dir: f.dir, remote: 'https://user:s3cret@example.invalid/xtmux.git', links: [], installer: 'install.sh' },
        });

        const report = phase(f.home, { env: fakeEnv(f.home) });
        const serialized = JSON.stringify(report);
        expect(report?.repos.find((repo) => repo.name === 'xtmux')?.remote).toBe('https://example.invalid/xtmux.git');
        expect(serialized).not.toContain('s3cret');
        expect(serialized).not.toContain('leaked-token');
        expect(serialized).not.toContain('ghp_bbbb');
        const refused = report?.drift.find((item) => item.kind === 'installer-refused');
        expect(refused?.diagnostic?.split('\n').length).toBeLessThanOrEqual(7);
        expect(refused?.diagnostic).toContain('refusing to overwrite');
    });
});

describe('default branch detection', () => {
    it('uses local refs only when origin/HEAD is gone and the origin is unreachable', () => {
        const f = fixture('xtrm');
        clone(f, 'xtrm');
        // No origin/HEAD, and an origin that cannot be reached: the old
        // `git remote show origin` fallback hung for minutes here.
        git(f.dir, 'remote', 'set-head', 'origin', '--delete');
        fs.writeFileSync(path.join(f.seed, 'package.json'), `${JSON.stringify({ name: 'xtrm', version: '1.0.1' })}\n`);
        git(f.seed, 'commit', '-am', 'bump');
        git(f.seed, 'push');
        writeConfig(f.home, {
            ...idleRepos(f.home, ['core', 'xtmux', 'specialists']),
            xtrm: { dir: f.dir, remote: 'http://127.0.0.1:9/unreachable.git', links: [] },
        });

        const started = Date.now();
        const report = phase(f.home, { check: true, env: fakeEnv(f.home) });
        expect(Date.now() - started).toBeLessThan(10_000);
        const xtrm = report?.repos.find((repo) => repo.name === 'xtrm');
        expect(xtrm?.defaultBranch).toBe('main');
        // No fetch, so the local origin/main ref is the stale one from the
        // clone: a report must say 'ok', not claim drift it never looked for.
        expect(xtrm?.fetched).toBe(false);
        expect(xtrm?.status).toBe('ok');

        // An explicit --fetch against the same unreachable origin still returns
        // fast and reports the failed refresh instead of hanging. The reported
        // `remote` is report metadata; the checkout's own URL is what git uses.
        git(f.dir, 'remote', 'set-url', 'origin', 'http://127.0.0.1:9/unreachable.git');
        const fetchedStarted = Date.now();
        const fetched = phase(f.home, { check: true, fetch: true, env: fakeEnv(f.home) });
        expect(Date.now() - fetchedStarted).toBeLessThan(10_000);
        expect(fetched?.repos.find((repo) => repo.name === 'xtrm')?.status).toBe('unknown');
        expect(fetched?.drift.some((item) => item.kind === 'fetch-failed')).toBe(true);
    });
});

describe('init checkout mode', () => {
    it('previews under --dry-run and applies only on a real run', () => {
        expect(checkoutInitMode({})).toBe('off');
        expect(checkoutInitMode({ dryRun: true })).toBe('off');
        expect(checkoutInitMode({ fromCheckouts: true })).toBe('apply');
        expect(checkoutInitMode({ fromCheckouts: true, dryRun: true })).toBe('check');
    });
});
