import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(__dirname, '..', 'bootstrap.mjs');

const GIT_IDENTITY = ['-c', 'user.name=xtrm bootstrap test', '-c', 'user.email=bootstrap@test.invalid'];

function git(cwd, args) {
    const result = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
    }
    return result.stdout.trim();
}

async function write(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
}

/**
 * Builds an origin (bare) repo plus a seed clone, and returns a bootstrap table
 * entry that points at the bare repo. `files` land in the first commit.
 */
async function makeOrigin(root, name, files = { 'package.json': JSON.stringify({ name, version: '1.0.0' }, null, 2) }) {
    const bare = path.join(root, 'origins', `${name}.git`);
    await fs.mkdir(path.dirname(bare), { recursive: true });
    git(root, ['init', '--bare', '--quiet', bare]);
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    const seed = path.join(root, 'seed', name);
    await fs.mkdir(seed, { recursive: true });
    git(seed, ['init', '--quiet']);
    git(seed, ['checkout', '-q', '-b', 'main']);
    for (const [rel, content] of Object.entries(files)) await write(path.join(seed, rel), content);
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'initial']);
    git(seed, ['remote', 'add', 'origin', bare]);
    git(seed, ['push', '-q', '-u', 'origin', 'main']);
    return { bare, seed, entry: { name, dir: name, remote: bare, links: ['.'] } };
}

async function makeRoot() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-bootstrap-test-'));
}

function run(root, entries, args, env = {}) {
    const result = spawnSync(process.execPath, [script, '--root', root, '--json', ...args], {
        encoding: 'utf8',
        env: { ...process.env, XTRM_BOOTSTRAP_REPOS_JSON: JSON.stringify(entries), ...env },
    });
    let report = null;
    try {
        report = JSON.parse(result.stdout);
    } catch {
        // leave null; callers assert on it to surface a crash with stderr below
    }
    return { status: result.status, report, stdout: result.stdout, stderr: result.stderr };
}

function assertReport(result) {
    assert.ok(result.report, `no JSON report; exit ${result.status}; stderr: ${result.stderr}`);
    return result.report;
}

function repo(report, name) {
    const found = report.repos.find((entry) => entry.name === name);
    assert.ok(found, `repo ${name} missing from report`);
    return found;
}

test('check reports a clean checkout as up to date', async () => {
    const root = await makeRoot();
    const origin = await makeOrigin(root, 'alpha');
    git(root, ['clone', '-q', origin.bare, path.join(root, 'alpha')]);

    const result = run(root, [origin.entry], ['--check', '--no-links']);
    const report = assertReport(result);
    assert.equal(result.status, 0);
    assert.equal(report.ok, true);
    assert.equal(repo(report, 'alpha').status, 'ok');
    assert.equal(repo(report, 'alpha').commit.length, 8);
    assert.equal(repo(report, 'alpha').version, '1.0.0');
});

test('a dirty checkout blocks the update and keeps the local change', async () => {
    const root = await makeRoot();
    const origin = await makeOrigin(root, 'alpha');
    const checkout = path.join(root, 'alpha');
    git(root, ['clone', '-q', origin.bare, checkout]);
    await write(path.join(origin.seed, 'next.txt'), 'next\n');
    git(origin.seed, ['add', '-A']);
    git(origin.seed, ['commit', '-q', '-m', 'next']);
    git(origin.seed, ['push', '-q']);
    await write(path.join(checkout, 'package.json'), '{"name":"alpha","version":"9.9.9"}\n');
    const headBefore = git(checkout, ['rev-parse', 'HEAD']);

    const check = run(root, [origin.entry], ['--check', '--no-links']);
    assert.equal(check.status, 1);
    assert.ok(assertReport(check).drift.some((item) => item.kind === 'dirty'));

    const apply = run(root, [origin.entry], ['--no-links', '--no-install']);
    assert.equal(apply.status, 1);
    assert.equal(git(checkout, ['rev-parse', 'HEAD']), headBefore);
    assert.match(await fs.readFile(path.join(checkout, 'package.json'), 'utf8'), /9\.9\.9/);
});

test('a clean checkout is fast-forwarded to the default branch', async () => {
    const root = await makeRoot();
    const origin = await makeOrigin(root, 'alpha');
    const checkout = path.join(root, 'alpha');
    git(root, ['clone', '-q', origin.bare, checkout]);
    await write(path.join(origin.seed, 'next.txt'), 'next\n');
    git(origin.seed, ['add', '-A']);
    git(origin.seed, ['commit', '-q', '-m', 'next']);
    git(origin.seed, ['push', '-q']);
    const remoteHead = git(origin.seed, ['rev-parse', 'HEAD']);

    const check = run(root, [origin.entry], ['--check', '--no-links']);
    assert.equal(check.status, 1);
    assert.equal(repo(assertReport(check), 'alpha').behind, 1);

    const apply = run(root, [origin.entry], ['--no-links', '--no-install']);
    assert.equal(apply.status, 0);
    assert.equal(git(checkout, ['rev-parse', 'HEAD']), remoteHead);

    const recheck = run(root, [origin.entry], ['--check', '--no-links']);
    assert.equal(recheck.status, 0);
    assert.equal(assertReport(recheck).ok, true);
});

test('a missing checkout is reported by --check and cloned by an apply', async () => {
    const root = await makeRoot();
    const origin = await makeOrigin(root, 'alpha');

    const check = run(root, [origin.entry], ['--check', '--no-links']);
    assert.equal(check.status, 1);
    assert.equal(repo(assertReport(check), 'alpha').status, 'missing');

    const apply = run(root, [origin.entry], ['--no-links', '--no-install']);
    assert.equal(apply.status, 0);
    assert.equal(git(path.join(root, 'alpha'), ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');

    const recheck = run(root, [origin.entry], ['--check', '--no-links']);
    assert.equal(recheck.status, 0);
});

test('a diverged checkout is refused and not rewritten', async () => {
    const root = await makeRoot();
    const origin = await makeOrigin(root, 'alpha');
    const checkout = path.join(root, 'alpha');
    git(root, ['clone', '-q', origin.bare, checkout]);
    await write(path.join(checkout, 'local.txt'), 'local\n');
    git(checkout, ['add', '-A']);
    git(checkout, ['commit', '-q', '-m', 'local work']);
    const localHead = git(checkout, ['rev-parse', 'HEAD']);
    await write(path.join(origin.seed, 'remote.txt'), 'remote\n');
    git(origin.seed, ['add', '-A']);
    git(origin.seed, ['commit', '-q', '-m', 'remote work']);
    git(origin.seed, ['push', '-q']);

    const apply = run(root, [origin.entry], ['--no-links', '--no-install']);
    assert.equal(apply.status, 1);
    assert.equal(git(checkout, ['rev-parse', 'HEAD']), localHead);
    assert.ok(assertReport(apply).drift.some((item) => item.kind === 'diverged'));
});

test('untracked files are reported but do not block the update', async () => {
    const root = await makeRoot();
    const origin = await makeOrigin(root, 'alpha');
    const checkout = path.join(root, 'alpha');
    git(root, ['clone', '-q', origin.bare, checkout]);
    await write(path.join(checkout, 'scratch.txt'), 'scratch\n');

    const check = run(root, [origin.entry], ['--check', '--no-links']);
    assert.equal(check.status, 0);
    const state = repo(assertReport(check), 'alpha');
    assert.equal(state.status, 'ok');
    assert.equal(state.dirty.untracked, 1);
});

test('a checkout on another branch is reported, not switched', async () => {
    const root = await makeRoot();
    const origin = await makeOrigin(root, 'alpha');
    const checkout = path.join(root, 'alpha');
    git(root, ['clone', '-q', origin.bare, checkout]);
    git(checkout, ['checkout', '-q', '-b', 'feature']);

    const check = run(root, [origin.entry], ['--check', '--no-links']);
    assert.equal(check.status, 1);
    assert.equal(repo(assertReport(check), 'alpha').status, 'wrong-branch');
    assert.equal(git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature');
});

test('install links the package bins and the report names the checkout', async () => {
    const root = await makeRoot();
    const prefix = path.join(root, 'npm-prefix');
    const origin = await makeOrigin(root, 'alpha', {
        'package.json': JSON.stringify({
            name: '@xtrm-test/boot-fixture',
            version: '1.2.3',
            bin: { 'boot-fixture': 'bin/fixture.mjs' },
        }, null, 2),
        'bin/fixture.mjs': '#!/usr/bin/env node\nconsole.log("fixture")\n',
    });
    git(origin.seed, ['update-index', '--chmod=+x', 'bin/fixture.mjs']);
    git(origin.seed, ['commit', '-q', '-m', 'exec bit']);
    git(origin.seed, ['push', '-q']);

    const env = { npm_config_prefix: prefix };
    const apply = run(root, [origin.entry], [], env);
    assert.equal(apply.status, 0, apply.stdout + apply.stderr);
    const linked = await fs.realpath(path.join(prefix, 'bin', 'boot-fixture'));
    assert.equal(linked, path.join(root, 'alpha', 'bin', 'fixture.mjs'));

    const report = assertReport(apply);
    const entry = report.bins.find((bin) => bin.bin === 'boot-fixture');
    assert.ok(entry, 'bin entry missing from report');
    assert.equal(entry.state, 'ok');
    assert.equal(entry.version, '1.2.3');
    assert.equal(entry.repo, 'alpha');

    const recheck = run(root, [origin.entry], ['--check'], env);
    assert.equal(recheck.status, 0, recheck.stdout);
});

test('a Pi settings entry that loads the checkout directly is reported as a conflict', async () => {
    const root = await makeRoot();
    const home = path.join(root, 'home');
    const origin = await makeOrigin(root, 'xtmux', {
        'package.json': JSON.stringify({ name: '@xtrm-test/xtmux-fixture', version: '0.2.5' }, null, 2),
        'install.sh': '#!/usr/bin/env bash\ntouch "$(dirname "$0")/installer-ran"\n',
    });
    const checkout = path.join(root, 'xtmux');
    git(root, ['clone', '-q', origin.bare, checkout]);
    await write(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({
        packages: [{ source: checkout, extensions: ['extensions/pi-agent-state.ts'] }],
    }, null, 2));

    const entry = { ...origin.entry, installer: 'install.sh' };
    const env = {
        HOME: home,
        XDG_STATE_HOME: path.join(home, '.local', 'state'),
        npm_config_prefix: path.join(home, 'npm-prefix'),
    };
    const check = run(root, [entry], ['--check'], env);
    assert.equal(check.status, 1);
    assert.ok(assertReport(check).drift.some((item) => item.kind === 'pi-entry-conflict'));

    const apply = run(root, [entry], [], env);
    assert.equal(apply.status, 1);
    assert.ok(assertReport(apply).problems.some((problem) => problem.includes('pi-entry-conflict') || problem.includes('loads xtmux from the checkout')));
    await assert.rejects(fs.access(path.join(checkout, 'installer-ran')), 'installer must not run while the Pi entry conflicts');
});

test('--home scopes installer writes and link targets to the given home', async () => {
    const root = await makeRoot();
    const home = path.join(root, 'rehearsal-home');
    const origin = await makeOrigin(root, 'xtmux', {
        'package.json': JSON.stringify({ name: '@xtrm-test/xtmux-home', version: '0.1.0' }, null, 2),
        'install.sh': '#!/usr/bin/env bash\nmkdir -p "$HOME/.local/state/xtmux"\n'
            + 'printf \'{"version":"0.1.0"}\' > "$HOME/.local/state/xtmux/installer.json"\n',
    });
    git(root, ['clone', '-q', origin.bare, path.join(root, 'xtmux')]);
    const entry = { ...origin.entry, installer: 'install.sh' };

    const apply = run(root, [entry], ['--home', home], { npm_config_prefix: path.join(root, 'prefix') });
    const report = assertReport(apply);
    assert.equal(report.home, home);
    assert.equal(apply.status, 0, apply.stdout + apply.stderr);
    await fs.access(path.join(home, '.local', 'state', 'xtmux', 'installer.json'));
    assert.ok(report.drift.every((item) => item.kind !== 'installer-missing'), 'installer state must resolve inside --home');
});

test('a lockfile rewritten by the install step is restored and reported', async () => {
    const root = await makeRoot();
    const prefix = path.join(root, 'npm-prefix');
    const fakeNpm = path.join(root, 'fake-npm.cjs');
    await write(fakeNpm, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [cmd] = process.argv.slice(2);
if (cmd === 'prefix') {
    process.stdout.write(path.join(process.env.FAKE_PREFIX, 'bin'));
    process.exit(0);
}
if (cmd === 'install') {
    const lock = path.join(process.cwd(), 'package-lock.json');
    if (fs.existsSync(lock)) {
        const data = JSON.parse(fs.readFileSync(lock, 'utf8'));
        data.version = '9.9.9';
        fs.writeFileSync(lock, JSON.stringify(data, null, 2));
    }
    process.exit(0);
}
process.exit(0);
`);
    await fs.chmod(fakeNpm, 0o755);
    const origin = await makeOrigin(root, 'alpha', {
        'package.json': JSON.stringify({ name: '@xtrm-test/boot-lock', version: '1.0.0' }, null, 2),
        'package-lock.json': JSON.stringify({ name: '@xtrm-test/boot-lock', version: '1.0.0', lockfileVersion: 3 }, null, 2),
    });
    const checkout = path.join(root, 'alpha');
    git(root, ['clone', '-q', origin.bare, checkout]);

    const env = { XTRM_BOOTSTRAP_NPM: fakeNpm, FAKE_PREFIX: prefix, npm_config_prefix: prefix };
    const apply = run(root, [origin.entry], [], env);
    const report = assertReport(apply);
    assert.ok(report.drift.some((item) => item.kind === 'lockfile-rewritten'), apply.stdout);
    assert.equal(git(checkout, ['status', '--porcelain']), '', 'the checkout must stay clean after an install step');
    assert.equal(JSON.parse(await fs.readFile(path.join(checkout, 'package-lock.json'), 'utf8')).version, '1.0.0');
});

test('retired Beads hook wiring is reported and left unchanged', async () => {
    const root = await makeRoot();
    const origin = await makeOrigin(root, 'xtmux');
    const checkout = path.join(root, 'xtmux');
    git(root, ['clone', '-q', origin.bare, checkout]);
    git(checkout, ['config', 'core.hooksPath', '.beads/hooks']);

    const result = run(root, [origin.entry], ['--check', '--no-links']);
    const report = assertReport(result);
    assert.equal(result.status, 1);
    const finding = report.drift.find((item) => item.kind === 'beads-hooks');
    assert.ok(finding, 'beads-hooks finding missing');
    assert.match(finding.detail, /\.beads\/hooks/);
    assert.equal(git(checkout, ['config', '--get', 'core.hooksPath']), '.beads/hooks', 'git config must not be rewritten');
});

test('an installer refusal is surfaced with its diagnostic and never forced', async () => {
    const root = await makeRoot();
    const home = path.join(root, 'home');
    const origin = await makeOrigin(root, 'xtmux', {
        'package.json': JSON.stringify({ name: '@xtrm-test/xtmux-refuse', version: '0.2.5' }, null, 2),
        'install.sh': '#!/usr/bin/env bash\n'
            + 'echo "xtmux install: refusing to overwrite $HOME/.tmux/scripts/git-pane-status.sh" >&2\n'
            + 'echo "  it is not a symlink the installer owns; remove or move it yourself" >&2\n'
            + 'exit 1\n',
    });
    const checkout = path.join(root, 'xtmux');
    git(root, ['clone', '-q', origin.bare, checkout]);
    const entry = { ...origin.entry, installer: 'install.sh' };

    const result = run(root, [entry], ['--home', home], { npm_config_prefix: path.join(root, 'prefix') });
    const report = assertReport(result);
    assert.equal(result.status, 1);
    const finding = report.drift.find((item) => item.kind === 'installer-refused');
    assert.ok(finding, 'installer-refused finding missing');
    assert.match(finding.diagnostic, /refusing to overwrite/);
    assert.equal(report.problems.length, 0, 'a refusal is a finding, not an unhandled failure');
});
