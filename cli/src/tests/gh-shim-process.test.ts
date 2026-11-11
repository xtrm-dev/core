// CORE-2528 review: the shim is a real program, so these tests RUN it.
// String-matching the source let two defects through: a `#` marker on line 2 of
// a JavaScript file (a SyntaxError on every agent `gh` call) and the positional
// PR number forwarded next to `--pr` (commander: too many arguments).
//
// Every case writes the generated shim to a temp dir, puts stub `gh` and `xt`
// executables first on PATH, runs the shim through `node`, and asserts on what
// the stubs received.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ghShimSource } from '../core/gh-shim.js';
import { PR_ROUTES } from '../core/gh-shim-routes.js';

let root = '';
let bin = '';
let shim = '';
let ghLog = '';
let xtLog = '';
let sbLog = '';

const CREATE_STDOUT = 'https://github.com/xtrm-dev/core/pull/912\n';
const CREATE_STDERR = 'Warning: 1 uncommitted change\n';

function stub(name: string, logPath: string, body: string): string {
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
${body}
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`;
    const file = join(bin, name);
    writeFileSync(file, script);
    chmodSync(file, 0o755);
    return file;
}

function readLog(path: string): string[][] {
    try {
        return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
    } catch {
        return [];
    }
}

/** The shim's identity work, without the role lookup. */
function workCalls(): string[][] {
    return readLog(xtLog).filter((argv) => argv[0] === 'identity' && argv[1] !== 'role');
}

/** What the shim actually merged and recorded, which carries the resolved PR. */
function mergeRecords(): string[][] {
    return workCalls().filter((argv) => argv[1] === 'merge-record');
}

function runShim(args: string[], env: Record<string, string> = {}, cwd?: string): { status: number | null; stdout: string; stderr: string } {
    const inherited = { ...process.env };
    for (const key of ['XTRM_MERGE_GUARD', 'XTRM_MERGE_GUARD_OVERRIDE', 'XTRM_ROLE', 'SUBSTRATE_HOLDER', 'STUB_ROLE', 'STUB_CHECK', 'STUB_SB', 'STUB_GH_EXIT', 'STUB_GH_TWO_URLS']) {
        delete inherited[key];
    }
    const result = spawnSync(process.execPath, [shim, ...args], {
        encoding: 'utf8',
        env: {
            ...inherited,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            SUBSTRATE_HOLDER: 'core-xt-pi-0fln',
            ...env,
        },
        ...(cwd ? { cwd } : {}),
        // A hung child must never block a run again (2026-11-09 incident).
        timeout: 15000,
        killSignal: 'SIGKILL',
    });
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

/** A git call in a scratch repository, with any inherited GIT_* routing removed. */
function git(cwd: string, args: string[]): string {
    const env = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr ?? '')}`);
    return String(result.stdout ?? '').trim();
}

/**
 * A scratch repository the pr-link step can read: one base commit and one head
 * commit, an `origin/main` that points at the base unless the case needs the
 * `--commit` fallback, and a branch name the fallback test can rely on.
 */
function scratchRepo(options: { withOriginMain?: boolean; branch?: string } = {}): { dir: string; head: string; base: string } {
    const dir = join(root, 'repo');
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'worker@example.test']);
    git(dir, ['config', 'user.name', 'worker']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['checkout', '-q', '-b', options.branch ?? 'core-2607-gh-shim']);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-qm', 'first']);
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-qm', 'second']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    if (options.withOriginMain !== false) git(dir, ['update-ref', 'refs/remotes/origin/main', base]);
    return { dir, head, base };
}

function sbCalls(): string[][] {
    return readLog(sbLog);
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xtrm-shim-proc-'));
    bin = join(root, 'bin');
    ghLog = join(root, 'gh.log');
    xtLog = join(root, 'xt.log');
    sbLog = join(root, 'sb.log');
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(bin, { recursive: true });
    // The real gh answers `pr view` for the fallback case; everything else is logged.
    const realGh = stub('gh', ghLog, `
const argv = process.argv.slice(2);
if (argv[0] === 'repo' && argv[1] === 'view') {
  process.stdout.write(JSON.stringify({ nameWithOwner: 'xtrm-dev/core' }));
  process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'view' && argv.join(' ').indexOf('headRefOid') >= 0 && argv[2] !== '--json') {
  const target = argv[2];
  // A branch target resolves to its own PR; a numeric target to itself.
  const number = /^\\d+$/.test(target || '') ? Number(target) : 7;
  process.stdout.write(JSON.stringify({ number, headRefOid: 'b'.repeat(40) }));
  process.exit(0);
}
if (process.argv.slice(2).join(' ') === 'pr view --json number,url,headRefOid') {
  fs.writeFileSync(${JSON.stringify(ghLog)}, JSON.stringify(['pr','view','answer']) + '\\n');
  process.stdout.write(JSON.stringify({ number: 99, url: 'https://github.com/xtrm-dev/specialists/pull/99', headRefOid: 'a'.repeat(40) }));
  process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'create') {
  // CORE-2607: the create the shim must tee, and link, without changing a byte.
  if (process.env.STUB_GH_TWO_URLS === '1') {
    process.stdout.write('Warning: a pull request already exists: https://github.com/xtrm-dev/core/pull/111\\n');
  }
  process.stdout.write('https://github.com/xtrm-dev/core/pull/912\\n');
  process.stderr.write('Warning: 1 uncommitted change\\n');
  process.exit(Number(process.env.STUB_GH_EXIT || '0'));
}
`);
    // The sb stub logs FIRST, then answers, so every call is visible.
    const sbScript = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(sbLog)}, JSON.stringify(argv) + '\\n');
const envelope = (body) => JSON.stringify({ schema: 'substrate-cli/v1', ...body }) + '\\n';
if (argv[0] === 'project' && argv[1] === 'list') {
  if (process.env.STUB_SB === 'project-fail') {
    process.stdout.write(envelope({ command: 'project.list', ok: false, error: 'substrate.remote=ssh:server: no store' }));
    process.exit(1);
  }
  process.stdout.write(envelope({ command: 'project.list', ok: true, data: [
    { id: 'prj_core', prefix: 'CORE', name: 'core' },
    { id: 'prj_xtrm', prefix: 'XTRM', name: 'xtrm' },
  ] }));
  process.exit(0);
}
if (process.env.STUB_SB === 'missing-verb') {
  process.stdout.write(envelope({ command: 'provenance.attach', ok: false, error: 'unknown provenance verb: attach (want dispatch|allocate|bind|trace|commit|receipt|pr|session|activation|bundle)' }));
  process.exit(1);
}
if (process.env.STUB_SB === 'verb-error') {
  process.stdout.write(envelope({ command: 'provenance.attach', ok: false, error: "unexpected argument 'attach' found" }));
  process.exit(1);
}
if (process.env.STUB_SB === 'link-fail' && argv[0] === 'issue') {
  process.stdout.write(envelope({ command: 'issue.link', ok: false, error: 'unknown flag --commits-range for issue.link' }));
  process.exit(1);
}
process.stdout.write(envelope({ command: 'provenance.attach', ok: true, data: {} }));
process.exit(0);
`;
    writeFileSync(join(bin, 'sb'), sbScript);
    chmodSync(join(bin, 'sb'), 0o755);
    stub('xt', xtLog, `
const { spawnSync } = require('node:child_process');
const DIST = ${JSON.stringify(path.join(process.cwd(), 'dist', 'index.cjs'))};
const REAL_GH = ${JSON.stringify(join(bin, 'gh'))};
const argv = process.argv.slice(2);
function runDist(extra) {
  const result = spawnSync(process.execPath, [DIST, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, XTRM_REAL_GH: REAL_GH },
  });
  return result;
}
if (argv[0] === 'identity' && argv[1] === 'role') {
  fs.appendFileSync(${JSON.stringify(xtLog)}, JSON.stringify(argv) + '\\n');
  if (process.env.STUB_ROLE === 'fail') process.exit(1);
  process.stdout.write(JSON.stringify({ role: process.env.STUB_ROLE || null, source: 'specialist', holder: 'h' }));
  process.exit(0);
}
if (argv[0] === 'identity' && argv[1] === 'resolve-gh') {
  // The REAL resolver runs, with the stub gh pretending to be GitHub.
  const result = runDist(['identity', 'resolve-gh', ...argv.slice(2)]);
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status === null ? 1 : result.status);
}
if (argv[0] === 'identity' && argv[1] === 'pr-link') {
  // CORE-2607: the REAL link resolution runs; the stubbed sb records the argv.
  const result = runDist(['identity', 'pr-link', ...argv.slice(2)]);
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status === null ? 1 : result.status);
}
if (argv[0] === 'identity' && argv[1] === 'marker-check') {
  // CORE-2619: the REAL marker check runs, so the refusal text and the $N rule
  // are the shipped ones; the shim test asserts what happens to the create.
  // CORE-2622: absent and hung xt are the fail-open cases.
  if (process.env.STUB_XT_MARKER === 'absent') process.exit(127);
  if (process.env.STUB_XT_MARKER === 'hang') {
    // Longer than the shim's MARKER_CHECK_TIMEOUT_MS, so the shim kills it.
    setTimeout(() => process.exit(0), 8000);
    return;
  }
  const result = runDist(['identity', 'marker-check', ...argv.slice(2)]);
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status === null ? 1 : result.status);
}
if (argv[0] === 'identity' && argv[1] === 'merge-check' && argv.indexOf('--gh-args') > 0) {
  // Real resolution, stubbed decision: the guard's verdict is what the shim tests.
  const resolved = runDist(['identity', 'resolve-gh', '--argv', argv[argv.indexOf('--gh-args') + 1], '--cwd', argv[argv.indexOf('--cwd') + 1] || process.cwd()]);
  let target = { repo: '', pr: 0, head: '' };
  try { target = JSON.parse(resolved.stdout || '{}'); } catch (error) { target = { repo: '', pr: 0, head: '' }; }
  if (process.env.STUB_CHECK === 'refuse') {
    process.stdout.write(JSON.stringify({ allow: false, repo: target.repo, pr: target.pr, head: target.head, message: 'merge refused: no review at the current head' }));
    process.exit(1);
  }
  // CORE-2590 review finding 1: an unverified Issue allows, and the shim must say so.
  if (process.env.STUB_CHECK === 'unknown') {
    process.stdout.write(JSON.stringify({
      allow: true, repo: target.repo, pr: target.pr, head: target.head, message: 'merge allowed',
      issueRef: 'CORE-2590', issueLookup: 'unknown', issueLookupDetail: 'sb is absent or did not answer in 5 s',
    }));
    process.exit(0);
  }
  // An override decision carries no head; the shim must resolve and pin it (A).
  const head = process.env.STUB_NO_HEAD ? '' : target.head;
  process.stdout.write(JSON.stringify({ allow: true, repo: target.repo, pr: target.pr, head, message: 'merge allowed' }));
  process.exit(0);
}
`);
    shim = join(root, 'gh');
    writeFileSync(shim, ghShimSource(realGh));
    chmodSync(shim, 0o755);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('the generated shim is a valid program', () => {
    it('parses as JavaScript (the marker must be a comment, not a hashbang line)', () => {
        const check = spawnSync(process.execPath, ['--check', shim], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
        expect(check.stderr).toBe('');
        expect(check.status).toBe(0);
    });
});

describe('gh pr review through the real shim process', () => {
    it('forwards the PR exactly once, with --repo and the body flag, and no duplicate positional', () => {
        const body = join(root, 'findings.md');
        writeFileSync(body, 'body');
        const result = runShim(['pr', 'review', '524', '--repo', 'xtrm-dev/specialists', '--comment', '--body-file', body]);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);

        const calls = workCalls().filter((argv) => argv[1] === 'review-post');
        expect(calls.map((argv) => argv.slice(0, 2).join(' '))).toHaveLength(1);
        const argv = calls[0];
        expect(argv.slice(0, 2)).toEqual(['identity', 'review-post']);
        const prFlags = argv.filter((arg) => arg === '--pr');
        expect(prFlags).toHaveLength(1);
        expect(argv[argv.indexOf('--pr') + 1]).toBe('524');
        // The bare number must not ride along as a second argument.
        expect(argv.filter((arg) => arg === '524')).toHaveLength(1);
        expect(argv.filter((arg) => arg === '--repo')).toHaveLength(1);
        expect(argv).toContain('--body-file');
        expect(argv).toContain('--comment');
        // No real gh call: the review goes through xt only.
        expect(readLog(ghLog)).toHaveLength(0);
    });

    it('falls back to gh pr view for the repo and number when the arguments omit them', () => {
        const result = runShim(['pr', 'review', '--comment', '--body-file', join(root, 'f.md')]);
        expect(result.status).toBe(0);
        const argv = workCalls()[0];
        expect(argv[argv.indexOf('--repo') + 1]).toBe('xtrm-dev/specialists');
        expect(argv[argv.indexOf('--pr') + 1]).toBe('99');
    });

    it('refuses to merge as the reviewer role before calling the real gh', () => {
        const result = runShim(['pr', 'merge', '524', '--repo', 'xtrm-dev/specialists', '--squash'], { XTRM_ROLE: 'reviewer', STUB_ROLE: 'reviewer' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/reviewer role may not merge/);
        expect(workCalls()).toHaveLength(0);
        expect(readLog(ghLog)).toHaveLength(0);
    });
});

describe('the resolved role, not the raw string', () => {
    it('refuses a merge for XTRM_ROLE=pr-reviewer when the map resolves it to reviewer', () => {
        const result = runShim(['pr', 'merge', '524', '--repo', 'xtrm-dev/specialists', '--squash'], { XTRM_ROLE: 'pr-reviewer', STUB_ROLE: 'reviewer' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/reviewer role may not merge/);
        expect(workCalls()).toHaveLength(0);
    });

    it('refuses gh api calls to a merge endpoint for the reviewer role', () => {
        const result = runShim(['api', '-X', 'PUT', 'repos/xtrm-dev/core/pulls/1/merge'], { XTRM_ROLE: 'seconder', STUB_ROLE: 'reviewer' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/may only GET through gh api/);
        expect(readLog(ghLog)).toHaveLength(0);
    });

    it('leaves the merge to the guard when the guard flag is off', () => {
        const result = runShim(['pr', 'merge', '524', '--repo', 'xtrm-dev/specialists', '--squash'], { STUB_ROLE: 'worker' });
        expect(result.status).toBe(0);
        expect(result.stderr).toMatch(/merge guard is off/);
        const merges = readLog(ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'merge');
        expect(merges[0]).toEqual(['pr', 'merge', '524', '--repo', 'xtrm-dev/specialists', '--squash']);
        expect(readLog(xtLog).filter((argv) => argv[1] === 'merge-check')).toHaveLength(0);
    });
});

describe('the guard flag ON path', () => {
    it('refuses before calling the real gh when merge-check refuses', () => {
        // The stub xt returns exit 0 unless STUB_CHECK=refuse.
        const result = runShim(['pr', 'merge', '123', '--repo', 'xtrm-dev/core', '--squash'], { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on', STUB_CHECK: 'refuse' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/merge refused/);
        expect(readLog(ghLog).filter((argv) => argv[1] === 'merge')).toHaveLength(0);
    });

    it('warns on stderr when the Issue was not verified, and still merges (CORE-2590 review 1)', () => {
        const result = runShim(['pr', 'merge', '123', '--repo', 'xtrm-dev/core', '--squash'], { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on', STUB_CHECK: 'unknown' });
        expect(result.status).toBe(0);
        expect(result.stderr).toMatch(/the Issue was not verified for CORE-2590/);
        expect(result.stderr).toMatch(/sb is absent or did not answer in 5 s/);
        expect(readLog(ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'merge')).toHaveLength(1);
    });

    it('checks, merges and records the PR named in the argument, not the cwd PR', () => {
        const result = runShim(['pr', 'merge', '123', '--repo', 'xtrm-dev/core', '--squash'], { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
        expect(result.status).toBe(0);
        const record = mergeRecords().pop();
        expect(record?.[record.indexOf('--pr') + 1]).toBe('123');
        const merges = readLog(ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'merge');
        expect(merges[0]?.slice(0, 2)).toEqual(['pr', 'merge']);
        expect(merges[0]).toContain('123');
    });

    it('resolves a bare number through the current repository', () => {
        const result = runShim(['pr', 'merge', '123', '--squash'], { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
        expect(result.status).toBe(0);
        const record = mergeRecords().pop();
        expect(record?.[record.indexOf('--repo') + 1]).toBe('xtrm-dev/core');
        expect(record?.[record.indexOf('--pr') + 1]).toBe('123');
    });

    it('parses a PR URL and a -Ro/r form', () => {
        const url = runShim(['pr', 'merge', 'https://github.com/xtrm-dev/core/pull/77', '--squash'], { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
        expect(url.status).toBe(0);
        expect(mergeRecords().pop()?.[mergeRecords()[0].indexOf('--pr') + 1]).toBe('77');

        const attached = runShim(['pr', 'review', '5', '-Rxtrm-dev/core', '--comment', '--body-file', join(root, 'f.md')], { STUB_ROLE: 'reviewer' });
        expect(attached.status).toBe(0);
        const posted = workCalls().find((argv) => argv[1] === 'review-post');
        expect(posted?.[posted.indexOf('--repo') + 1]).toBe('xtrm-dev/core');
        expect(posted?.[posted.indexOf('--pr') + 1]).toBe('5');
    });

    it('pins the head the override path lost, and records it (review A)', () => {
        const result = runShim(['pr', 'merge', '123', '--repo', 'xtrm-dev/core', '--squash'], { STUB_ROLE: 'coordinator', XTRM_MERGE_GUARD: 'on', STUB_NO_HEAD: '1' });
        expect(result.status).toBe(0);
        const merges = readLog(ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'merge');
        expect(merges[0]).toContain('--match-head-commit');
        expect(merges[0][merges[0].indexOf('--match-head-commit') + 1]).toBe('b'.repeat(40));
        const record = mergeRecords().pop();
        expect(record?.[record.indexOf('--head') + 1]).toBe('b'.repeat(40));
    });

    it('does not append a second --match-head-commit when one is already given', () => {
        runShim(['pr', 'merge', '123', '--repo', 'xtrm-dev/core', '--match-head-commit=' + 'c'.repeat(40)], { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
        const merges = readLog(ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'merge');
        expect(merges[0]).toEqual(['pr', 'merge', '123', '--repo', 'xtrm-dev/core', '--match-head-commit=' + 'c'.repeat(40)]);
    });

    it('refuses ready and reopen for the reviewer role', () => {
        for (const verb of ['ready', 'reopen']) {
            const result = runShim(['pr', verb, '123', '--repo', 'xtrm-dev/core'], { STUB_ROLE: 'reviewer' });
            expect(result.status).not.toBe(0);
            expect(result.stderr).toMatch(/may not change PR state/);
        }
    });
});

describe('branch and short-flag targets (CORE-2528 delta review #1, #2)', () => {
    it('resolves a branch target to its own PR, not the cwd PR', () => {
        const merged = runShim(['pr', 'merge', 'feat-x', '--repo', 'o/r'], { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
        expect(merged.status).toBe(0);
        const record = mergeRecords().pop();
        expect(record?.[record.indexOf('--pr') + 1]).toBe('7');
        expect(record?.[record.indexOf('--repo') + 1]).toBe('o/r');
        const merges = readLog(ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'merge');
        expect(merges[0]?.slice(0, 3)).toEqual(['pr', 'merge', 'feat-x']);
    });

    it('resolves a branch target for a review and forwards no stray positional', () => {
        const result = runShim(['pr', 'review', 'feat-x', '--repo', 'o/r', '--comment'], { STUB_ROLE: 'reviewer' });
        expect(result.status).toBe(0);
        const posted = workCalls().find((argv) => argv[1] === 'review-post');
        expect(posted?.[posted.indexOf('--pr') + 1]).toBe('7');
        expect(posted).not.toContain('feat-x');
    });

    it('does not swallow the number after a merge strategy short flag', () => {
        for (const flag of ['-s', '-m', '-r']) {
            const result = runShim(['pr', 'merge', flag, '123', '--repo', 'o/r'], { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
            expect(result.status, flag).toBe(0);
            const record = mergeRecords().pop();
            expect(record?.[record.indexOf('--pr') + 1], flag).toBe('123');
        }
    });

    it('does not swallow the number after a review short flag', () => {
        for (const flag of ['-a', '-c', '-r']) {
            const result = runShim(['pr', 'review', flag, '5', '--repo', 'o/r', '-b', 'hi'], { STUB_ROLE: 'reviewer' });
            expect(result.status, flag).toBe(0);
            const posted = workCalls().find((argv) => argv[1] === 'review-post');
            expect(posted?.[posted.indexOf('--pr') + 1], flag).toBe('5');
            // gh's short review flags reach xt as its long options.
            expect(posted, flag).toContain('--body');
            expect(posted, flag).not.toContain('-a');
        }
    });

    it('fails closed when the role lookup fails and a role is set', () => {
        const result = runShim(['pr', 'merge', '5', '--repo', 'o/r'], { XTRM_ROLE: 'pr-reviewer', STUB_ROLE: 'fail' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/reviewer role may not merge/);
    });

    it('refuses graphql mutations and issues writes for the reviewer role', () => {
        // No -f/-X here: the graphql rule alone must refuse it.
        const graphql = runShim(['api', 'graphql?query=mutation%20%7B%20x%20%7D'], { STUB_ROLE: 'reviewer' });
        expect(graphql.status).not.toBe(0);
        expect(graphql.stderr).toMatch(/graphql/);
        const graphqlFields = runShim(['api', 'graphql', '-f', 'query=mutation { x }'], { STUB_ROLE: 'reviewer' });
        expect(graphqlFields.status).not.toBe(0);
        const issues = runShim(['api', 'repos/o/r/issues/5', '-X', 'PATCH', '-f', 'state=closed'], { STUB_ROLE: 'reviewer' });
        expect(issues.status).not.toBe(0);
    });
});

describe('global flags before the verb (batch 4, item 1)', () => {
    function mergeCalls() {
        return workCalls().filter((argv) => argv[1] === 'merge-check' || argv[1] === 'merge-record' || argv[1] === 'review-post');
    }

    it('routes gh pr -R o/r merge 5 and gh pr --repo=o/r merge 5 to the guard', () => {
        for (const args of [['pr', '-R', 'o/r', 'merge', '5'], ['pr', '--repo=o/r', 'merge', '5']]) {
            const before = mergeCalls().length;
            const result = runShim(args, { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
            expect(result.status, args.join(' ')).toBe(0);
            const called = mergeCalls().slice(before);
            expect(called.length, args.join(' ')).toBeGreaterThanOrEqual(1); // the guard was consulted
            const record = mergeRecords().pop();
            expect(record?.[record.indexOf('--repo') + 1], args.join(' ')).toBe('o/r');
            expect(record?.[record.indexOf('--pr') + 1], args.join(' ')).toBe('5');
        }
    });

    it('routes gh pr -R o/r review 5 -a to review-post', () => {
        const before = mergeCalls().length;
        const result = runShim(['pr', '-R', 'o/r', 'review', '5', '-a', '-b', 'ok'], { STUB_ROLE: 'reviewer' });
        expect(result.status).toBe(0);
        const posted = mergeCalls().slice(before).find((argv) => argv[1] === 'review-post');
        expect(posted?.[posted.indexOf('--repo') + 1]).toBe('o/r');
        expect(posted?.[posted.indexOf('--pr') + 1]).toBe('5');
        expect(posted).toContain('--approve');
    });

    it('refuses gh pr -R o/r merge for the reviewer role', () => {
        const result = runShim(['pr', '-R', 'o/r', 'merge', '5'], { STUB_ROLE: 'reviewer' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/reviewer role may not merge/);
    });
});

describe("the reviewer's gh api is an allowlist (batch 4, item 2)", () => {
    const refused = ['-fevent=APPROVE', '-Fevent=APPROVE', '--field=x', '--raw-field=x', '--input=x', '-X=POST', '-X=DELETE', '-XPOST', '--method=POST'];
    for (const flag of refused) {
        it(`refuses ${flag}`, () => {
            const result = runShim(['api', 'repos/o/r/pulls/5/reviews', flag], { STUB_ROLE: 'reviewer' });
            expect(result.status, flag).not.toBe(0);
            expect(result.stderr, flag).toMatch(/may only GET through gh api/);
        });
    }

    it('allows the read-only flags and one endpoint', () => {
        for (const args of [
            ['repos/o/r/pulls/5'],
            ['repos/o/r/pulls/5', '--paginate'],
            ['repos/o/r/pulls/5', '--slurp', '-i'],
            ['repos/o/r/pulls/5', '-q', '.title'],
            ['repos/o/r/pulls/5', '--jq=.title'],
            ['repos/o/r/pulls/5', '-H', 'Accept: application/vnd.github+json'],
            ['repos/o/r/pulls/5', '--header=Accept: x'],
            ['repos/o/r/pulls/5', '--cache', '60'],
            ['repos/o/r/pulls/5', '--silent'],
        ]) {
            const result = runShim(['api', ...args], { STUB_ROLE: 'reviewer' });
            expect(result.status, args.join(' ')).toBe(0);
        }
    });

    it('refuses the issues endpoint and graphql even with no field flags', () => {
        const issues = runShim(['api', 'repos/o/r/issues/5'], { STUB_ROLE: 'reviewer' });
        expect(issues.status).not.toBe(0);
        expect(issues.stderr).toMatch(/issues endpoint/);
        const graphql = runShim(['api', 'graphql?query=x'], { STUB_ROLE: 'reviewer' });
        expect(graphql.status).not.toBe(0);
        expect(graphql.stderr).toMatch(/graphql/);
    });
});

describe('flag values are never rewritten (batch 4, item 3)', () => {
    it('keeps -c as the body value after -b', () => {
        const result = runShim(['pr', 'review', '5', '--repo', 'o/r', '-b', '-c'], { STUB_ROLE: 'reviewer' });
        expect(result.status).toBe(0);
        const posted = workCalls().find((argv) => argv[1] === 'review-post') ?? [];
        const bodyAt = posted.indexOf('--body');
        expect(posted[bodyAt + 1]).toBe('-c');
        expect(posted).not.toContain('--comment');
    });
});

describe('the role lookup is lazy (batch 4, item 4)', () => {
    it('does not ask for a role on pr view or issue list', () => {
        for (const args of [['pr', 'view'], ['issue', 'list']]) {
            const before = readLog(xtLog).length;
            runShim(args, { STUB_ROLE: 'worker' });
            const asked = readLog(xtLog).slice(before).filter((argv) => argv[1] === 'role');
            expect(asked, args.join(' ')).toHaveLength(0);
        }
    });
});

describe('root-level flags before pr (batch 5, item 1)', () => {
    it('routes gh -R o/r pr merge 5 and gh --repo=o/r pr merge 5 to the guard', () => {
        for (const args of [['-R', 'o/r', 'pr', 'merge', '5'], ['--repo=o/r', 'pr', 'merge', '5']]) {
            const result = runShim(args, { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
            expect(result.status, args.join(' ')).toBe(0);
            const record = mergeRecords().pop();
            expect(record?.[record.indexOf('--repo') + 1], args.join(' ')).toBe('o/r');
            expect(record?.[record.indexOf('--pr') + 1], args.join(' ')).toBe('5');
        }
    });

    it('refuses gh -R o/r pr close and gh --repo o/r pr close for the reviewer role', () => {
        for (const args of [['-R', 'o/r', 'pr', 'close', '5'], ['--repo', 'o/r', 'pr', 'close', '5'], ['--repo=o/r', 'pr', 'close', '5']]) {
            const result = runShim(args, { STUB_ROLE: 'reviewer' });
            expect(result.status, args.join(' ')).not.toBe(0);
            expect(result.stderr, args.join(' ')).toMatch(/may not change PR state/);
        }
    });

    it('refuses gh -R o/r pr merge for the reviewer role', () => {
        const result = runShim(['-R', 'o/r', 'pr', 'merge', '5'], { STUB_ROLE: 'reviewer' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/reviewer role may not merge/);
    });
});

describe('long-form review values are protected (batch 5, item 3)', () => {
    it('keeps -c and -a as body values after the long forms', () => {
        for (const args of [
            ['pr', 'review', '5', '--repo', 'o/r', '--body', '-c'],
            ['pr', 'review', '5', '--repo', 'o/r', '--body-file', '-a'],
            ['pr', 'review', '5', '--repo', 'o/r', '--body=-c'],
            ['pr', 'review', '5', '--repo', 'o/r', '--body-file=-a'],
        ]) {
            const result = runShim(args, { STUB_ROLE: 'reviewer' });
            expect(result.status, args.join(' ')).toBe(0);
            const posted = workCalls().filter((argv) => argv[1] === 'review-post').pop() ?? [];
            const glued = args.some((arg) => arg.indexOf('--body=') === 0 || arg.indexOf('--body-file=') === 0);
            if (glued) {
                // The = form stays one token, and its value is untouched.
                expect(posted.some((arg) => arg === '--body=-c' || arg === '--body-file=-a'), args.join(' ')).toBe(true);
            } else {
                const flag = args.some((arg) => arg.indexOf('--body-file') === 0) ? '--body-file' : '--body';
                const at = posted.indexOf(flag);
                expect(posted[at + 1], args.join(' ')).toMatch(/^-c$|^-a$/);
            }
            expect(posted, args.join(' ')).not.toContain('--comment');
            expect(posted, args.join(' ')).not.toContain('--approve');
        }
    });
});

describe('the api header allowlist and endpoint rules (batch 5, item 4)', () => {
    it('refuses a method override header in every spelling', () => {
        for (const args of [
            ['api', 'repos/o/r/pulls/5', '-H', 'X-HTTP-Method-Override: DELETE'],
            ['api', 'repos/o/r/pulls/5', '--header', 'x-http-method-override: DELETE'],
            ['api', 'repos/o/r/pulls/5', '--header=X-HTTP-Method-Override: DELETE'],
        ]) {
            const result = runShim(args, { STUB_ROLE: 'reviewer' });
            expect(result.status, args.join(' ')).not.toBe(0);
            expect(result.stderr, args.join(' ')).toMatch(/Accept or X-GitHub-Api-Version/);
        }
    });

    it('refuses Accept-Language, which shares the accept prefix (review H, M35)', () => {
        const result = runShim(['api', 'repos/o/r/pulls/5', '-H', 'Accept-Language:x'], { STUB_ROLE: 'reviewer' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/only send Accept or X-GitHub-Api-Version/);
    });

    it('allows the two representation headers', () => {
        for (const args of [
            ['api', 'repos/o/r/pulls/5', '-H', 'Accept: application/vnd.github+json'],
            ['api', 'repos/o/r/pulls/5', '-H', 'X-GitHub-Api-Version: 2022-11-28'],
        ]) {
            expect(runShim(args, { STUB_ROLE: 'reviewer' }).status, args.join(' ')).toBe(0);
        }
    });

    it('refuses a merge endpoint and a second endpoint', () => {
        const merge = runShim(['api', 'repos/o/r/pulls/5/merge'], { STUB_ROLE: 'reviewer' });
        expect(merge.status).not.toBe(0);
        expect(merge.stderr).toMatch(/may not merge/);
        const two = runShim(['api', 'repos/o/r/pulls/5', 'repos/o/r/pulls/6'], { STUB_ROLE: 'reviewer' });
        expect(two.status).not.toBe(0);
        expect(two.stderr).toMatch(/one endpoint/);
    });
});

describe('operator passthrough', () => {
    it('reaches the real gh unchanged when no agent identity is set', () => {
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
        delete env.SUBSTRATE_HOLDER;
        delete env.XTRM_ROLE;
        const result = spawnSync(process.execPath, [shim, 'pr', 'list'], { encoding: 'utf8', env, timeout: 15000, killSignal: 'SIGKILL' });
        expect(result.status).toBe(0);
        expect(workCalls()).toHaveLength(0);
        expect(readLog(ghLog)[0]).toEqual(['pr', 'list']);
    });
});

describe('merge value flags keep the next argument (batch 4, item 5)', () => {
    it('does not take -t / -A / --match-head-commit values as the PR', () => {
        // The value flag comes FIRST, so a missing entry would make its value the
        // target (a branch-looking word resolves to PR 7 in the stub).
        for (const args of [
            ['pr', 'merge', '-t', 'subject', '123', '--repo', 'o/r'],
            ['pr', 'merge', '-A', 'a@example.com', '123', '--repo', 'o/r'],
            ['pr', 'merge', '--match-head-commit', 'c'.repeat(40), '123', '--repo', 'o/r'],
        ]) {
            const result = runShim(args, { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
            expect(result.status, args.join(' ')).toBe(0);
            const record = mergeRecords().pop();
            expect(record?.[record.indexOf('--pr') + 1], args.join(' ')).toBe('123');
        }
    });
});
// CORE-2607: the link a create writes. The create's own bytes and status are the
// real gh's; the link is one best-effort step that is allowed one warning line.
describe('the Issue-to-PR link after gh pr create (CORE-2607)', () => {
    const MARKER_BODY = '<!-- xtrm issue=CORE-2607 holder=shim-attach run=run1 -->';

    /** The warning lines the shim wrote after the create's own stderr. */
    function warnings(stderr: string): string[] {
        expect(stderr.startsWith(CREATE_STDERR)).toBe(true);
        return stderr.slice(CREATE_STDERR.length).split('\n').filter(Boolean);
    }

    function attachCalls(): string[][] {
        return sbCalls().filter((argv) => argv[0] === 'provenance' || argv[0] === 'issue');
    }

    function t1(): string[] {
        return [
            'provenance', 'attach', 'CORE-2607', 'pr', 'xtrm-dev/core#912', '--project', 'prj_core',
        ];
    }

    function t2(rangeFlag: string[]): string[] {
        return [
            'issue', 'link', 'pr', 'CORE-2607',
            '--repo', 'xtrm-dev/core',
            '--number', '912',
            ...rangeFlag,
            '--project', 'prj_core',
        ];
    }

    it('tees the create output byte for byte and attaches with the exact argv', () => {
        const repo = scratchRepo();
        const result = runShim(
            ['pr', 'create', '--title', 'wire the shim', '--body', MARKER_BODY, '--base', 'main'],
            { HOME: root },
            repo.dir,
        );
        expect(result.status).toBe(0);
        // Byte-identical: the real gh's stdout and stderr, no prefix and no suffix.
        expect(result.stdout).toBe(CREATE_STDOUT);
        expect(result.stderr).toBe(CREATE_STDERR);
        expect(sbCalls()).toEqual([
            ['project', 'list', '--json'],
            t1(),
            t2(['--commits-range', `${repo.base}..${repo.head}`]),
        ]);
    });

    it('takes the repository and number from the URL, never from --repo', () => {
        const repo = scratchRepo();
        const result = runShim(['pr', 'create', '--repo', 'other/repo', '--body', MARKER_BODY], { HOME: root }, repo.dir);
        expect(result.status).toBe(0);
        const attach = attachCalls()[0];
        expect(attach[4]).toBe('xtrm-dev/core#912');
        expect(attach).not.toContain('other/repo');
    });

    it('takes the last URL gh printed', () => {
        const repo = scratchRepo();
        runShim(['pr', 'create', '--body', MARKER_BODY], { HOME: root, STUB_GH_TWO_URLS: '1' }, repo.dir);
        expect(attachCalls()[0]?.[4]).toBe('xtrm-dev/core#912');
    });

    it('warns once and returns the create status when the verb is missing', () => {
        const repo = scratchRepo();
        const result = runShim(['pr', 'create', '--body', MARKER_BODY], { HOME: root, STUB_SB: 'missing-verb' }, repo.dir);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(CREATE_STDOUT);
        const said = warnings(result.stderr);
        expect(said).toHaveLength(1);
        expect(said[0]).toContain('gh (xtrm):');
        expect(said[0]).toMatch(/unknown provenance verb: attach/);
    });

    it('warns once and returns the create status when the verb rejects the arguments', () => {
        const repo = scratchRepo();
        const result = runShim(['pr', 'create', '--body', MARKER_BODY], { HOME: root, STUB_SB: 'verb-error' }, repo.dir);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(CREATE_STDOUT);
        const said = warnings(result.stderr);
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/unexpected argument 'attach'/);
    });

    it('keeps the link and warns once when only the commit evidence fails', () => {
        const repo = scratchRepo();
        const result = runShim(['pr', 'create', '--body', MARKER_BODY], { HOME: root, STUB_SB: 'link-fail' }, repo.dir);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(CREATE_STDOUT);
        expect(attachCalls()).toEqual([t1(), t2(['--commits-range', `${repo.base}..${repo.head}`])]);
        const said = warnings(result.stderr);
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/commit evidence failed: .*unknown flag --commits-range/);
    });

    it('warns once and skips when no Issue ref resolves', () => {
        const repo = scratchRepo({ branch: 'feature/x' });
        const result = runShim(['pr', 'create', '--title', 'wire the shim', '--body', 'no marker here'], { HOME: root }, repo.dir);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(CREATE_STDOUT);
        expect(attachCalls()).toHaveLength(0);
        const said = warnings(result.stderr);
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/not linked to a Substrate Issue/);
    });

    it('warns once and skips when two markers name different Issues', () => {
        const repo = scratchRepo();
        const body = `${MARKER_BODY}\n<!-- xtrm issue=CORE-2608 holder=shim-attach run=run1 -->`;
        const result = runShim(['pr', 'create', '--body', body], { HOME: root }, repo.dir);
        expect(attachCalls()).toHaveLength(0);
        expect(warnings(result.stderr)[0]).toMatch(/more than one Issue/);
    });

    it('warns once and skips when the project cannot be resolved', () => {
        const repo = scratchRepo();
        const result = runShim(['pr', 'create', '--body', MARKER_BODY], { HOME: root, STUB_SB: 'project-fail' }, repo.dir);
        expect(result.status).toBe(0);
        expect(attachCalls()).toHaveLength(0);
        const said = warnings(result.stderr);
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/cannot resolve the Substrate project for CORE-2607/);
    });

    it('does not link anything when the create itself failed', () => {
        const repo = scratchRepo();
        const result = runShim(['pr', 'create', '--body', MARKER_BODY], { HOME: root, STUB_GH_EXIT: '3' }, repo.dir);
        expect(result.status).toBe(3);
        expect(result.stdout).toBe(CREATE_STDOUT);
        expect(result.stderr).toBe(CREATE_STDERR);
        expect(sbCalls()).toHaveLength(0);
        expect(readLog(xtLog).filter((argv) => argv[1] === 'pr-link')).toHaveLength(0);
    });

    it('leaves an operator process completely alone', () => {
        const repo = scratchRepo();
        const result = runShim(['pr', 'create', '--body', MARKER_BODY], { HOME: root, SUBSTRATE_HOLDER: '' }, repo.dir);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(CREATE_STDOUT);
        expect(result.stderr).toBe(CREATE_STDERR);
        expect(sbCalls()).toHaveLength(0);
        expect(readLog(xtLog).filter((argv) => argv[1] === 'pr-link')).toHaveLength(0);
    });

    it('does not link another pr verb or a --help', () => {
        const repo = scratchRepo();
        const view = runShim(['pr', 'view', '5'], { HOME: root }, repo.dir);
        expect(view.status).toBe(0);
        expect(readLog(xtLog).filter((argv) => argv[1] === 'pr-link')).toHaveLength(0);
        expect(sbCalls()).toHaveLength(0);
        const help = runShim(['pr', 'create', '--help'], { HOME: root }, repo.dir);
        expect(help.status).toBe(0);
        expect(readLog(xtLog).filter((argv) => argv[1] === 'pr-link')).toHaveLength(0);
        expect(sbCalls()).toHaveLength(0);
    });

    it('falls back to the branch name when neither the body nor the title names a ref', () => {
        const repo = scratchRepo({ branch: 'core-2607-gh-shim' });
        const result = runShim(['pr', 'create', '--title', 'wire the shim', '--body', 'no marker'], { HOME: root }, repo.dir);
        expect(result.status).toBe(0);
        expect(attachCalls()).toEqual([t1(), t2(['--commits-range', `${repo.base}..${repo.head}`])]);
    });

    it('falls back to --commit HEAD when no base resolves', () => {
        const repo = scratchRepo({ withOriginMain: false });
        const result = runShim(['pr', 'create', '--body', MARKER_BODY], { HOME: root }, repo.dir);
        expect(result.status).toBe(0);
        expect(attachCalls()).toEqual([t1(), t2(['--commit', repo.head])]);
    });
});

// CORE-2619: the marker's run= is the worker's own runtime session id. A tmux
// session id ($N) is shared by every window in that session, so it attributes
// nothing — and the create must not happen at all, because a PR that exists with
// a wrong marker has to be edited by hand afterwards.
//
// No scratch repository here: the refusal happens before gh runs, so nothing in
// these cases touches git. An absolute --body-file keeps the case independent of
// the process cwd.
describe('a tmux session id in the marker run= is refused before the create (CORE-2619)', () => {
    const TMUX_RUN = '<!-- xtrm issue=CORE-2619 holder=pi152-core run=$1 -->';

    it('refuses the create and never runs the real gh', () => {
        const result = runShim(['pr', 'create', '--title', 'docs', '--body', TMUX_RUN], { HOME: root });
        expect(result.status).toBe(1);
        // Nothing was teed: the real gh never ran, so no PR exists.
        expect(result.stdout).toBe('');
        expect(result.stderr).not.toContain(CREATE_STDERR);
        expect(result.stderr).toContain('refusing to create the pull request');
        expect(result.stderr).toContain('run=$1 is a tmux session id (XTRM_SESSION_ID)');
        expect(result.stderr).toContain('PI_SESSION_ID');
        // No link ran either: the shim stopped before the post-create step.
        expect(sbCalls()).toHaveLength(0);
        expect(readLog(xtLog).filter((argv) => argv[1] === 'pr-link')).toHaveLength(0);
    });

    it('refuses through --body-file as well', () => {
        const bodyFile = join(root, 'body.md');
        writeFileSync(bodyFile, `${TMUX_RUN}\n`);
        const result = runShim(['pr', 'create', '--body-file', bodyFile], { HOME: root });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('PI_SESSION_ID');
        expect(sbCalls()).toHaveLength(0);
    });

    it('creates normally when run= is the runtime session id', () => {
        const body = '<!-- xtrm issue=CORE-2619 holder=pi152-core run=01a1cb5f-5915-7026-b5ba-d3041434385c -->';
        const result = runShim(['pr', 'create', '--title', 'docs', '--body', body], { HOME: root });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(CREATE_STDOUT);
    });

    it('does not refuse a marker inside a code fence, which the guard ignores too', () => {
        const fenced = ['```md', TMUX_RUN, '```'].join('\n');
        const body = `${fenced}\n<!-- xtrm issue=CORE-2619 holder=pi152-core run=run-9c1f -->`;
        const result = runShim(['pr', 'create', '--title', 'docs', '--body', body], { HOME: root });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(CREATE_STDOUT);
    });

    it('refuses a quoted tmux id, which a shell leaves unexpanded (CORE-2622)', () => {
        const quoted = '<!-- xtrm issue=CORE-2622 holder=pi152-core run="$1" -->';
        const result = runShim(['pr', 'create', '--title', 'docs', '--body', quoted], { HOME: root });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('run="$1" is a tmux session id');
    });

    it('refuses the same marker set through gh pr edit (CORE-2622)', () => {
        const result = runShim(['pr', 'edit', '5', '--body', TMUX_RUN], { HOME: root });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('refusing to edit the pull request');
        expect(result.stderr).toContain('PI_SESSION_ID');
        // The real gh never ran, so nothing was edited.
        expect(readLog(ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'edit')).toHaveLength(0);
    });

    // Review 6pgu (#921): the edit route exits through pass(), so it must run the
    // reviewer gate itself. Without it a reviewer could edit a PR title or body.
    it('refuses the reviewer role an edit by title, before the real gh', () => {
        const result = runShim(['pr', 'edit', '123', '--repo', 'xtrm-dev/core', '--title', 'renamed'], { HOME: root, STUB_ROLE: 'reviewer' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('the reviewer role may not change PR state (gh pr edit)');
        expect(result.stdout).toBe('');
        expect(readLog(ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'edit')).toHaveLength(0);
    });

    it('refuses the reviewer role an edit by body, before the real gh', () => {
        const result = runShim(['pr', 'edit', '123', '--repo', 'xtrm-dev/core', '--body', 'new body'], { HOME: root, STUB_ROLE: 'reviewer' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('the reviewer role may not change PR state (gh pr edit)');
        expect(readLog(ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'edit')).toHaveLength(0);
    });

    it('lets a gh pr edit that sets no body through untouched', () => {
        const result = runShim(['pr', 'edit', '5', '--title', 'renamed'], { HOME: root });
        // The real gh ran with the caller's status and no refusal on stderr.
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('refusing to');
    });

    it('proceeds when xt is absent (fail-open, not fail-closed)', () => {
        const result = runShim(['pr', 'create', '--title', 'docs', '--body', TMUX_RUN], { HOME: root, STUB_XT_MARKER: 'absent' });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(CREATE_STDOUT);
        expect(result.stderr).not.toContain('refusing to create');
    });

    it('proceeds when xt hangs past the marker budget (fail-open)', () => {
        // The budget is 4 s in production and the stub sleeps 8 s, which would
        // hold a CI runner for the whole budget; the clamp knob makes the same
        // branch reachable in ~300 ms without weakening what is asserted.
        const result = runShim(['pr', 'create', '--title', 'docs', '--body', TMUX_RUN], {
            HOME: root,
            STUB_XT_MARKER: 'hang',
            XTRM_MARKER_CHECK_TIMEOUT_MS: '300',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(CREATE_STDOUT);
        expect(result.stderr).not.toContain('refusing to create');
    }, 20_000);
});

// CORE-2626: one choke point for a restricted role replaces the per-verb
// denylist. The security read (rev-890, review 5865051160) found four ways past
// the old gates: `gh issue close|reopen|edit <PR#>` (gh resolves the number to a
// pull request), `gh pr lock|unlock|update-branch`, an unknown XTRM_ROLE that
// resolved to unrestricted, and `gh pr new` plus aliases/extensions. Each case
// below runs the generated shim with a reviewer role and asserts the real gh was
// never called.
describe('a restricted role reaches only the read allowlist (CORE-2626)', () => {
    const REVIEWER = { HOME: '', STUB_ROLE: 'reviewer', XTRM_ROLE: 'reviewer' };

    /** Every refused route must die before the real gh and name the route. */
    function expectRefused(args: string[], expected: string): void {
        const result = runShim(args, { ...REVIEWER, HOME: root });
        expect(result.status, `gh ${args.join(' ')} should be refused`).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(expected);
        expect(readLog(ghLog), `gh ${args.join(' ')} reached the real gh`).toHaveLength(0);
    }

    it('refuses gh issue close|reopen|edit, which gh resolves to the pull request', () => {
        for (const verb of ['close', 'reopen']) {
            expectRefused(['issue', verb, '5'], `may only read through this shim (refused: gh issue ${verb})`);
        }
        expectRefused(['issue', 'edit', '5', '--title', 'x'], 'may only read through this shim (refused: gh issue edit)');
    });

    it('refuses gh pr lock, unlock and update-branch', () => {
        for (const verb of ['lock', 'unlock', 'update-branch']) {
            expectRefused(['pr', verb, '5'], `may only read through this shim (refused: gh pr ${verb})`);
        }
    });

    it('refuses the PR-state routes it already named, through the same choke point', () => {
        expectRefused(['pr', 'merge', '5'], 'the reviewer role may not merge');
        expectRefused(['pr', 'close', '5'], 'the reviewer role may not change PR state (gh pr close)');
        expectRefused(['pr', 'ready', '5'], 'the reviewer role may not change PR state (gh pr ready)');
    });

    it('refuses an unknown first token, which is what an alias or an extension looks like', () => {
        // An unknown token is shown alone: there is no subcommand to name.
        expectRefused(['co', '5'], 'may only read through this shim (refused: gh co)');
        expectRefused(['alias', 'set', 'm', 'pr merge'], 'may only read through this shim (refused: gh alias)');
    });

    it('refuses a route spelled with a flag between pr and the verb', () => {
        expectRefused(['pr', '-R', 'xtrm-dev/core', 'lock', '5'], 'may only read through this shim (refused: gh pr lock)');
    });

    it('treats an unknown XTRM_ROLE as restricted instead of unrestricted', () => {
        // A typo: the role map answers null, and before CORE-2626 that read as
        // "not restricted" while the credential path already failed closed.
        const result = runShim(['pr', 'close', '5'], { HOME: root, XTRM_ROLE: 'pr-revewer', STUB_ROLE: '' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('the reviewer role may not change PR state (gh pr close)');
        expect(readLog(ghLog)).toHaveLength(0);
    });

    it('routes gh pr new through the create path, so the run= refusal still applies', () => {
        const tmux = '<!-- xtrm issue=CORE-2626 holder=pi152-core run=$1 -->';
        const refused = runShim(['pr', 'new', '--title', 'docs', '--body', tmux], { ...REVIEWER, HOME: root });
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain('refusing to create the pull request');
        expect(readLog(ghLog)).toHaveLength(0);

        const allowed = runShim(['pr', 'new', '--title', 'docs', '--body', 'plain body'], { ...REVIEWER, HOME: root });
        expect(allowed.status).toBe(0);
        // gh's own alias runs the real gh, so the shim forwards `new` unchanged;
        // that it went through the create path is what the refusal above proves.
        expect(readLog(ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'new')).toHaveLength(1);
    });

    it('lets the read allowlist through without a refusal', () => {
        for (const args of [
            ['pr', 'view', '5'],
            ['pr', 'diff', '5'],
            ['pr', 'checks', '5'],
            ['pr', 'list'],
            ['issue', 'view', '5'],
            ['issue', 'list'],
            ['auth', 'status'],
            ['run', 'list'],
            ['search', 'issues', 'shim'],
            ['status'],
        ]) {
            const before = readLog(ghLog).length;
            const result = runShim(args, { ...REVIEWER, HOME: root });
            expect(result.status, `gh ${args.join(' ')} should pass`).toBe(0);
            expect(result.stderr, `gh ${args.join(' ')}`).not.toContain('may only read');
            expect(readLog(ghLog).length - before, `gh ${args.join(' ')}`).toBe(1);
        }
    });

    it('keeps gh api on its own GET-only verdict, even behind a global flag', () => {
        const patch = runShim(['-R', 'xtrm-dev/core', 'api', '-X', 'PATCH', '/repos/o/r/pulls/5'], { ...REVIEWER, HOME: root });
        expect(patch.status).toBe(1);
        expect(patch.stderr).toContain('may only GET through gh api');
        expect(readLog(ghLog)).toHaveLength(0);
    });

    it('leaves an operator and an unroled worker unrestricted', () => {
        const operator = runShim(['issue', 'close', '5'], { HOME: root, SUBSTRATE_HOLDER: '' });
        expect([0, 1]).toContain(operator.status); // the stub exits 0; no role, so the shim passes
        expect(readLog(ghLog)).toHaveLength(1);

        const worker = runShim(['pr', 'lock', '5'], { HOME: root, XTRM_ROLE: '', STUB_ROLE: '' });
        expect(worker.status).toBe(0);
        expect(readLog(ghLog)).toHaveLength(2);
    });

    it('matches the route table for every gh pr verb', () => {
        for (const [verb, cls] of Object.entries(PR_ROUTES)) {
            const result = runShim(['pr', verb, '5'], { ...REVIEWER, HOME: root });
            const refused = result.stderr.includes('the reviewer role');
            expect(refused, `gh pr ${verb} is class ${cls} but refused=${refused}`).toBe(cls === 'write');
        }
    });
});
