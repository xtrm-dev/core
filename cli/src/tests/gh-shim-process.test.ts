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
    const result = spawnSync(process.execPath, [shim, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            SUBSTRATE_HOLDER: 'core-xt-pi-0fln',
            ...env,
        },
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
if (process.argv.slice(2).join(' ') === 'pr view --json number,url,headRefOid') {
  fs.writeFileSync(${JSON.stringify(ghLog)}, JSON.stringify(['pr','view','answer']) + '\\n');
  process.stdout.write(JSON.stringify({ number: 524, url: 'https://github.com/xtrm-dev/specialists/pull/524', headRefOid: 'a'.repeat(40) }));
  process.exit(0);
}
`);
    stub('xt', xtLog, `
if (process.argv.slice(2).join(' ') === 'identity role --json') {
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
        const check = spawnSync(process.execPath, ['--check', shim], { encoding: 'utf8' });
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
        expect(argv[argv.indexOf('--pr') + 1]).toBe('524');
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
        expect(result.stderr).toMatch(/may not merge/);
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

describe('operator passthrough', () => {
    it('reaches the real gh unchanged when no agent identity is set', () => {
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
        delete env.SUBSTRATE_HOLDER;
        delete env.XTRM_ROLE;
        const result = spawnSync(process.execPath, [shim, 'pr', 'list'], { encoding: 'utf8', env });
        expect(result.status).toBe(0);
        expect(workCalls()).toHaveLength(0);
        expect(readLog(ghLog)[0]).toEqual(['pr', 'list']);
    });
});