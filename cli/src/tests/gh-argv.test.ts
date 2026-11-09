// CORE-2530 review: the gh argv parser and the resolver are one implementation,
// shared by the shim and the hook. These tests pin the target rules: an explicit
// number, URL or branch wins; only a command with no target falls back to the cwd
// PR; a flag value is never the target.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseInvocation } from '../core/gh-argv.js';
import { resolveGhTarget } from '../commands/identity.js';

let root = '';
let ghPath = '';

/** A stub gh: `pr view` answers cwd PR 99, branch feat-x -> 7, numbers as given. */
function writeStubGh(): string {
    const script = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === 'repo' && argv[1] === 'view') { process.stdout.write(JSON.stringify({ nameWithOwner: 'o/r' })); process.exit(0); }
if (argv[0] === 'pr' && argv[1] === 'view') {
  const target = argv[2];
  if (target === '--json') {
    process.stdout.write(JSON.stringify({ number: 99, url: 'https://github.com/o/r/pull/99', headRefOid: 'a'.repeat(40) }));
    process.exit(0);
  }
  const number = /^\\d+$/.test(target || '') ? Number(target) : 7;
  process.stdout.write(JSON.stringify({ number, headRefOid: 'b'.repeat(40) }));
  process.exit(0);
}
process.exit(1);
`;
    const file = path.join(root, 'gh');
    writeFileSync(file, script);
    chmodSync(file, 0o755);
    return file;
}

function resolve(argv: string[]) {
    return resolveGhTarget(JSON.stringify(argv), root);
}

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'xtrm-argv-'));
    ghPath = writeStubGh();
    process.env.XTRM_REAL_GH = ghPath;
});

afterEach(() => {
    delete process.env.XTRM_REAL_GH;
    rmSync(root, { recursive: true, force: true });
});

describe('parseInvocation', () => {
    it('skips global flags before and after pr, and never takes a flag value as the target', () => {
        expect(parseInvocation(['-R', 'o/r', 'pr', 'merge', '5'])).toMatchObject({ verb: 'merge', repo: 'o/r', pr: 5 });
        expect(parseInvocation(['pr', '--repo=o/r', 'merge', '5'])).toMatchObject({ verb: 'merge', repo: 'o/r', pr: 5 });
        expect(parseInvocation(['pr', 'merge', '--repo', 'o/r', '-b', '42', '5'])).toMatchObject({ repo: 'o/r', pr: 5 });
        expect(parseInvocation(['pr', 'merge', '-t', 'subject', '123'])).toMatchObject({ pr: 123 });
        expect(parseInvocation(['pr', 'merge', 'https://github.com/o/r/pull/77'])).toMatchObject({ repo: 'o/r', pr: 77 });
        expect(parseInvocation(['pr', 'review', '5', '-a', '-b', 'ok'])).toMatchObject({ pr: 5, forwarded: ['--approve', '--body', 'ok'] });
    });
});

describe('parseInvocation (repo flags)', () => {
    it('takes the LAST repo flag, as gh does (M40: all four orders)', () => {
        // attached and separate, before and after the verb
        expect(parseInvocation(['pr', '-R', 'first/repo', 'merge', '5', '-R', 'last/repo'])).toMatchObject({ repo: 'last/repo', pr: 5 });
        expect(parseInvocation(['pr', '--repo=first/repo', 'merge', '5', '--repo=last/repo'])).toMatchObject({ repo: 'last/repo', pr: 5 });
        expect(parseInvocation(['-R', 'first/repo', 'pr', '-R', 'last/repo', 'merge', '5'])).toMatchObject({ repo: 'last/repo', pr: 5 });
        expect(parseInvocation(['pr', 'merge', '-R', 'first/repo', '-R', 'last/repo', '5'])).toMatchObject({ repo: 'last/repo', pr: 5 });
    });
});

describe('resolveGhTarget (target rules)', () => {
    it('resolves an explicit number in the cwd repository, not the cwd PR', () => {
        const resolved = resolve(['pr', 'merge', '5']);
        expect(resolved.repo).toBe('o/r');
        expect(resolved.pr).toBe(5);
    });

    it('resolves a branch in the named repository, never the cwd PR', () => {
        const resolved = resolve(['pr', 'merge', 'feat-x', '--repo', 'o/r']);
        expect(resolved.repo).toBe('o/r');
        expect(resolved.pr).toBe(7);
    });

    it('never takes a flag value as the target', () => {
        const resolved = resolve(['pr', 'merge', '--repo', 'o/r', '-b', '42', '5']);
        expect(resolved.pr).toBe(5);
    });

    it('falls back to the cwd PR only when no target is given', () => {
        const resolved = resolve(['pr', 'merge', '--squash']);
        expect(resolved.repo).toBe('o/r');
        expect(resolved.pr).toBe(99);
    });

    it('resolves a URL to its own repository and number', () => {
        const resolved = resolve(['pr', 'merge', 'https://github.com/o/r/pull/77']);
        expect(resolved.repo).toBe('o/r');
        expect(resolved.pr).toBe(77);
    });

    it('refuses an unexpanded variable or substitution as a target (report G)', () => {
        for (const target of ['$PR', '$(pr-number)']) {
            const resolved = resolve(['pr', 'merge', target]);
            expect(resolved.error).toMatch(/statically/);
            expect(resolved.error).toMatch(/explicit PR number/);
        }
    });

    it('refuses a branch without a repository instead of guessing the cwd PR', () => {
        const resolved = resolve(['pr', 'merge', 'feat-x']);
        expect(resolved.error).toMatch(/without --repo/);
        expect(resolved.pr).toBe(0);
    });
});

describe('xt identity merge-check --gh-args (report E)', () => {
    it('resolves the target from the JSON argv, with no --repo/--pr given', () => {
        const dist = path.resolve(__dirname, '..', '..', 'dist', 'index.cjs');
        const env: NodeJS.ProcessEnv = { ...process.env, XTRM_REAL_GH: ghPath, HOME: root };
        delete env.SUBSTRATE_HOLDER;
        delete env.XTRM_MERGE_GUARD;
        const result = spawnSync(process.execPath, [dist, 'identity', 'merge-check', '--gh-args', JSON.stringify(['pr', 'merge', '5']), '--cwd', root, '--json'], { encoding: 'utf8', env, timeout: 20000, killSignal: 'SIGKILL' });
        expect(result.status).toBe(0);
        const decision = JSON.parse(result.stdout);
        expect(decision.repo).toBe('o/r');
        expect(decision.pr).toBe(5);
        expect(decision.message).toMatch(/merge guard is off/);
    });

    it('fails when --gh-args is ignored (the option is not decorative)', () => {
        const dist = path.resolve(__dirname, '..', '..', 'dist', 'index.cjs');
        const env: NodeJS.ProcessEnv = { ...process.env, XTRM_REAL_GH: ghPath, HOME: root };
        delete env.SUBSTRATE_HOLDER;
        delete env.XTRM_MERGE_GUARD;
        // Same command without --gh-args: nothing resolves, so the CLI must refuse.
        const result = spawnSync(process.execPath, [dist, 'identity', 'merge-check', '--cwd', root], { encoding: 'utf8', env, timeout: 20000, killSignal: 'SIGKILL' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/pass --repo and --pr/);
    });
});

describe('the three verb finders agree (report H)', () => {
    const spellings = [
        'gh pr merge 5',
        'gh -R o/r pr merge 5',
        'gh pr -R o/r merge 5',
        "gh 'pr' merge 5",
        '/usr/bin/gh pr merge 5',
        'command gh pr merge 5',
        'env X=1 gh pr merge 5',
        'sudo gh pr merge 5',
        'gh pr merge --repo o/r -b 42 5',
    ];

    for (const spelling of spellings) {
        it(`CLI and hook agree on: ${spelling}`, () => {
            // CLI finder.
            const argv = spelling
                .replace(/^(?:\/usr\/bin\/|command |env X=1 |sudo )/, '')
                .replace(/'/g, '')
                .replace(/^gh /, '')
                .split(/\s+/);
            const cli = parseInvocation(argv);
            expect(cli.verb).toBe('merge');

            // Hook finder, as a real process with a stub xt that records its argv.
            const hook = path.resolve(__dirname, '..', '..', '..', 'hooks', 'xtrm-review-gate.mjs');
            const log = path.join(root, 'hook.log');
            const dir = path.join(root, 'hook-bin');
            mkdirSync(dir, { recursive: true });
            const xt = path.join(dir, 'xt');
            writeFileSync(xt, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2)[process.argv.slice(2).indexOf('--gh-args') + 1] + '\\n');\nprocess.stdout.write(JSON.stringify({ allow: true, repo: 'o/r', pr: 5, head: '' }));\n`);
            chmodSync(xt, 0o755);
            const result = spawnSync(process.execPath, [hook, 'pre'], {
                input: JSON.stringify({ tool_name: 'Bash', cwd: root, tool_input: { command: spelling } }),
                encoding: 'utf8',
                env: { PATH: `${dir}:${path.dirname(process.execPath)}`, HOME: root, XTRM_MERGE_GUARD: 'on' },
                timeout: 20000,
                killSignal: 'SIGKILL',
            });
            expect(result.status, result.stderr).toBe(0);
            const forwarded = JSON.parse(require('node:fs').readFileSync(log, 'utf8').trim().split('\n').pop()!);
            const hookParsed = parseInvocation(forwarded);
            expect(hookParsed.verb).toBe(cli.verb);
            expect(hookParsed.pr).toBe(cli.pr);
            expect(hookParsed.repo).toBe(cli.repo);
        });
    }
});
