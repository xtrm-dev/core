// CORE-2530 review: the gh argv parser and the resolver are one implementation,
// shared by the shim and the hook. These tests pin the target rules: an explicit
// number, URL or branch wins; only a command with no target falls back to the cwd
// PR; a flag value is never the target.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

    it('refuses a branch without a repository instead of guessing the cwd PR', () => {
        const resolved = resolve(['pr', 'merge', 'feat-x']);
        expect(resolved.error).toMatch(/without --repo/);
        expect(resolved.pr).toBe(0);
    });
});
