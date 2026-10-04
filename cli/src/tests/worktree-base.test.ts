import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchWorktreeBase, resolveDefaultBranchRef } from '../utils/worktree-base.js';

// Real git repos (CORE-2340): the bug is about real git state — where a new
// branch starts when the main checkout sits on an unrelated branch — so a
// mocked spawnSync surface would prove nothing. Origins are local paths;
// `git fetch origin` uses the local transport, keeping the tests offline.

const created: string[] = [];

function git(cwd: string, args: string[]): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout ?? '').trim();
}

function makeOrigin(): string {
    const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-base-origin-'));
    created.push(origin);
    git(origin, ['init', '--quiet', '--initial-branch=main']);
    git(origin, ['config', 'user.email', 'test@example.invalid']);
    git(origin, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(origin, 'f.txt'), 'main\n');
    git(origin, ['add', '-A']);
    git(origin, ['commit', '--quiet', '-m', 'main commit']);

    git(origin, ['checkout', '--quiet', '-b', 'stable']);
    fs.writeFileSync(path.join(origin, 'f.txt'), 'stable\n');
    git(origin, ['add', '-A']);
    git(origin, ['commit', '--quiet', '-m', 'stable commit']);

    git(origin, ['checkout', '--quiet', '-b', 'develop', 'main']);
    fs.writeFileSync(path.join(origin, 'f.txt'), 'develop\n');
    git(origin, ['add', '-A']);
    git(origin, ['commit', '--quiet', '-m', 'develop commit']);
    git(origin, ['checkout', '--quiet', 'main']); // origin HEAD on its default branch
    return origin;
}

/** Clone the origin and leave the main checkout on develop with a local-only commit. */
function cloneOnUnrelatedBranch(origin: string): string {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-base-clone-'));
    created.push(clone);
    spawnSync('git', ['clone', '--quiet', origin, clone], { encoding: 'utf8', stdio: 'pipe' });
    git(clone, ['checkout', '--quiet', 'develop']);
    fs.writeFileSync(path.join(clone, 'f.txt'), 'local\n');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '--quiet', '-m', 'local-only commit']);
    return clone;
}

/** The exact `git worktree add` shape both launchers now run (CORE-2340). */
function addWorktreeBranchAt(repoRoot: string, branch: string, wtPath: string, baseRef: string): void {
    git(repoRoot, ['worktree', 'add', '--quiet', '-b', branch, wtPath, baseRef]);
}

afterEach(() => {
    for (const root of created.reverse()) {
        // Worktrees under a repo root need pruning before the temp dir is removable.
        spawnSync('git', ['-C', root, 'worktree', 'prune'], { stdio: 'ignore' });
        fs.rmSync(root, { recursive: true, force: true });
    }
    created.length = 0;
});

describe('fetchWorktreeBase (CORE-2340)', () => {
    it('resolves the default branch dynamically while the checkout is on an unrelated branch', () => {
        const origin = makeOrigin();
        const clone = cloneOnUnrelatedBranch(origin);

        const base = fetchWorktreeBase(clone);
        expect(base.ok).toBe(true);
        if (!base.ok) return;
        expect(base.ref).toBe('origin/main');
    });

    it('starts a new worktree branch at origin/<default>, not the local HEAD', () => {
        const origin = makeOrigin();
        const clone = cloneOnUnrelatedBranch(origin);
        const mainCommit = git(clone, ['rev-parse', 'origin/main']);
        const headCommit = git(clone, ['rev-parse', 'HEAD']);
        expect(mainCommit).not.toBe(headCommit); // checkout really is off-default

        const base = fetchWorktreeBase(clone);
        expect(base.ok).toBe(true);
        if (!base.ok) return;

        const wt = path.join(clone, 'wt-main');
        addWorktreeBranchAt(clone, 'xt/from-default', wt, base.ref);

        expect(git(wt, ['rev-parse', 'HEAD'])).toBe(mainCommit);
    });

    it('honors an explicit --base override (origin/stable)', () => {
        const origin = makeOrigin();
        const clone = cloneOnUnrelatedBranch(origin);

        const base = fetchWorktreeBase(clone, 'origin/stable');
        expect(base.ok).toBe(true);
        if (!base.ok) return;
        expect(base.ref).toBe('origin/stable');

        const wt = path.join(clone, 'wt-stable');
        addWorktreeBranchAt(clone, 'xt/from-stable', wt, base.ref);

        expect(git(wt, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/stable']));
    });

    it('fails loudly when the fetch fails (no origin), never falling back to local HEAD', () => {
        const origin = makeOrigin();
        const clone = cloneOnUnrelatedBranch(origin);
        git(clone, ['remote', 'remove', 'origin']);

        const base = fetchWorktreeBase(clone);
        expect(base.ok).toBe(false);
        if (base.ok) return;
        expect(base.error).toMatch(/fetch/);
    });

    it('fails loudly for an unknown --base ref', () => {
        const origin = makeOrigin();
        const clone = cloneOnUnrelatedBranch(origin);

        const base = fetchWorktreeBase(clone, 'origin/nope');
        expect(base.ok).toBe(false);
        if (base.ok) return;
        expect(base.error).toMatch(/origin\/nope/);
    });

    it('resolves origin/master repos without a hardcoded origin/main', () => {
        const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-base-master-'));
        created.push(origin);
        git(origin, ['init', '--quiet', '--initial-branch=master']);
        git(origin, ['config', 'user.email', 'test@example.invalid']);
        git(origin, ['config', 'user.name', 'test']);
        fs.writeFileSync(path.join(origin, 'f.txt'), 'master\n');
        git(origin, ['add', '-A']);
        git(origin, ['commit', '--quiet', '-m', 'master commit']);

        const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-base-master-clone-'));
        created.push(clone);
        spawnSync('git', ['clone', '--quiet', origin, clone], { encoding: 'utf8', stdio: 'pipe' });

        expect(resolveDefaultBranchRef(clone)).toBe('origin/master');
        const base = fetchWorktreeBase(clone);
        expect(base.ok).toBe(true);
        if (!base.ok) return;
        expect(base.ref).toBe('origin/master');
    });
});
