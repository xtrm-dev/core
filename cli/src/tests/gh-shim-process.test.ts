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
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ghShimSource } from '../core/gh-shim.js';

let root = '';
let bin = '';
let shim = '';
let ghLog = '';
let xtLog = '';

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

/** The shim asks xt for its resolved role first; that call is not the work. */
function workCalls(): string[][] {
    return readLog(xtLog).filter((argv) => argv[0] === 'identity' && argv[1] !== 'role');
}

function runShim(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
    const inherited = { ...process.env };
    for (const key of ['XTRM_MERGE_GUARD', 'XTRM_MERGE_GUARD_OVERRIDE', 'XTRM_ROLE', 'SUBSTRATE_HOLDER', 'STUB_ROLE', 'STUB_CHECK']) {
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
        // A hung child must never block a run again (2026-11-09 incident).
        timeout: 15000,
        killSignal: 'SIGKILL',
    });
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xtrm-shim-proc-'));
    bin = join(root, 'bin');
    ghLog = join(root, 'gh.log');
    xtLog = join(root, 'xt.log');
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
`);
    stub('xt', xtLog, `
const argv = process.argv.slice(2);
if (argv[0] === 'identity' && argv[1] === 'merge-check' && process.env.STUB_CHECK === 'refuse') {
  process.stderr.write('merge refused: no review at the current head\\n');
  process.exit(1);
}
if (process.argv.slice(2).join(' ') === 'identity role --json') {
  // Log FIRST: otherwise a role lookup is invisible to the laziness test.
  fs.appendFileSync(${JSON.stringify(xtLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
  if (process.env.STUB_ROLE === 'fail') process.exit(1);
  process.stdout.write(JSON.stringify({ role: process.env.STUB_ROLE || null, source: 'specialist', holder: 'h' }));
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

        const calls = workCalls();
        expect(calls).toHaveLength(1);
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

    it('checks, merges and records the PR named in the argument, not the cwd PR', () => {
        const result = runShim(['pr', 'merge', '123', '--repo', 'xtrm-dev/core', '--squash'], { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
        expect(result.status).toBe(0);
        const check = workCalls().find((argv) => argv[1] === 'merge-check');
        const record = workCalls().find((argv) => argv[1] === 'merge-record');
        expect(check?.[check.indexOf('--pr') + 1]).toBe('123');
        expect(record?.[record.indexOf('--pr') + 1]).toBe('123');
        const merges = readLog(ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'merge');
        expect(merges[0]?.slice(0, 2)).toEqual(['pr', 'merge']);
        expect(merges[0]).toContain('123');
    });

    it('resolves a bare number through the current repository', () => {
        const result = runShim(['pr', 'merge', '123', '--squash'], { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
        expect(result.status).toBe(0);
        const check = workCalls().find((argv) => argv[1] === 'merge-check');
        expect(check?.[check.indexOf('--repo') + 1]).toBe('xtrm-dev/core');
        expect(check?.[check.indexOf('--pr') + 1]).toBe('123');
    });

    it('parses a PR URL and a -Ro/r form', () => {
        const url = runShim(['pr', 'merge', 'https://github.com/xtrm-dev/core/pull/77', '--squash'], { STUB_ROLE: 'worker', XTRM_MERGE_GUARD: 'on' });
        expect(url.status).toBe(0);
        expect(workCalls().find((argv) => argv[1] === 'merge-check')).toContain('77');

        const attached = runShim(['pr', 'review', '5', '-Rxtrm-dev/core', '--comment', '--body-file', join(root, 'f.md')], { STUB_ROLE: 'reviewer' });
        expect(attached.status).toBe(0);
        const posted = workCalls().find((argv) => argv[1] === 'review-post');
        expect(posted?.[posted.indexOf('--repo') + 1]).toBe('xtrm-dev/core');
        expect(posted?.[posted.indexOf('--pr') + 1]).toBe('5');
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
        const check = workCalls().find((argv) => argv[1] === 'merge-check');
        const record = workCalls().find((argv) => argv[1] === 'merge-record');
        expect(check?.[check.indexOf('--pr') + 1]).toBe('7');
        expect(check?.[check.indexOf('--repo') + 1]).toBe('o/r');
        expect(record?.[record.indexOf('--pr') + 1]).toBe('7');
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
            const check = workCalls().find((argv) => argv[1] === 'merge-check');
            expect(check?.[check.indexOf('--pr') + 1], flag).toBe('123');
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
            expect(called.length, args.join(' ')).toBeGreaterThanOrEqual(2); // check + record
            const check = called.find((argv) => argv[1] === 'merge-check');
            expect(check?.[check.indexOf('--repo') + 1], args.join(' ')).toBe('o/r');
            expect(check?.[check.indexOf('--pr') + 1], args.join(' ')).toBe('5');
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
            const check = workCalls().filter((argv) => argv[1] === 'merge-check').pop();
            expect(check?.[check.indexOf('--repo') + 1], args.join(' ')).toBe('o/r');
            expect(check?.[check.indexOf('--pr') + 1], args.join(' ')).toBe('5');
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
            const check = workCalls().filter((argv) => argv[1] === 'merge-check').pop();
            expect(check?.[check.indexOf('--pr') + 1], args.join(' ')).toBe('123');
        }
    });
});