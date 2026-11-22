import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { applyReap, branchLineMatches, isMergedIntoMain, planReap, readProcessTableOrRefuse, selectCleanTargets, type WorktreeInfo } from '../commands/worktree.js';
import { readProcessCwds } from '../core/worktree-reap.js';

const created: string[] = [];

function git(args: string[], cwd: string): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout ?? '').trim();
}

/**
 * A real repo with a remote-tracking base, because the predicate reads git refs:
 * `resolveDefaultBranchRef` only looks at `origin/*`, so a mocked repo would test
 * nothing but the mock.
 */
function makeRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-clean-'));
    created.push(root);

    git(['init', '--quiet', '--initial-branch=main'], root);
    git(['config', 'user.email', 'test@example.invalid'], root);
    git(['config', 'user.name', 'test'], root);

    fs.writeFileSync(path.join(root, 'source.ts'), 'export const value = 1;\n', 'utf8');
    git(['add', '-A'], root);
    git(['commit', '--quiet', '-m', 'initial'], root);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], root);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], root);

    return root;
}

function commit(repo: string, file: string, body: string): string {
    fs.writeFileSync(path.join(repo, file), body, 'utf8');
    git(['add', '-A'], repo);
    git(['commit', '--quiet', '-m', `add ${file}`], repo);
    return git(['rev-parse', 'HEAD'], repo);
}

function tree(over: Partial<WorktreeInfo> & { path: string }): WorktreeInfo {
    return { branch: '', head: '', prunable: false, ...over };
}

afterEach(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe('isMergedIntoMain', () => {
    it('never calls an empty branch name merged, and asks the commit instead', () => {
        const repo = makeRepo();
        const mainSha = git(['rev-parse', 'HEAD'], repo);
        git(['checkout', '--quiet', '-b', 'side'], repo);
        const sideSha = commit(repo, 'side.ts', 'export const side = 1;\n');
        git(['checkout', '--quiet', 'main'], repo);

        // The old predicate answered `true` here for every detached worktree:
        // `git branch --merged --list ''` prints nothing and `''.includes('')` is true.
        expect(isMergedIntoMain('', repo)).toBe(false);
        expect(isMergedIntoMain('', repo, '')).toBe(false);
        expect(isMergedIntoMain('', repo, sideSha)).toBe(false);
        expect(isMergedIntoMain('', repo, mainSha)).toBe(true);
    });

    it('pins the merge answer to the branch asked, through the real git listing', () => {
        const repo = makeRepo();
        git(['checkout', '--quiet', '-b', 'xt/1qkh'], repo);
        commit(repo, 'a.ts', 'export const a = 1;\n');
        git(['checkout', '--quiet', 'main'], repo);
        git(['merge', '--quiet', '--no-ff', '-m', 'merge 1qkh', 'xt/1qkh'], repo);
        git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], repo);

        git(['checkout', '--quiet', '-b', 'xt/1q'], repo);
        commit(repo, 'b.ts', 'export const b = 1;\n');
        git(['checkout', '--quiet', 'main'], repo);

        // Behaviour pin, not a mutation proof: `git branch --list xt/1q` is exact, so
        // this assertion passes under the old `.includes` too. The discriminating case
        // for a name compared as a substring is `branchLineMatches` below, and the
        // discriminating case for the empty name is the test above.
        expect(isMergedIntoMain('refs/heads/xt/1qkh', repo)).toBe(true);
        expect(isMergedIntoMain('refs/heads/xt/1q', repo)).toBe(false);
    });
});

describe('branchLineMatches', () => {
    it('answers about the branch asked, not about any line that contains its name', () => {
        const listing = '  xt/1qkh\n';
        expect(branchLineMatches(listing, 'xt/1q')).toBe(false);
        expect(listing.includes('xt/1q')).toBe(true); // the shape the seam exists to refuse
        expect(branchLineMatches(listing, 'xt/1qkh')).toBe(true);
        expect(branchLineMatches('* xt/live\n', 'xt/live')).toBe(true);
        expect(branchLineMatches('', 'xt/anything')).toBe(false);
    });
});

describe('selectCleanTargets', () => {
    it('keeps a merged worktree whose session is still running in it, and names the pids', () => {
        const cwds = new Map<string, number[]>([
            [path.join('/worktrees', 'live'), [4242]],
            [path.join('/worktrees', 'live', 'cli'), [4243]],
            [path.join('/worktrees', 'idle'), []],
        ]);

        const plan = selectCleanTargets(
            [
                tree({ path: path.join('/worktrees', 'live'), branch: 'refs/heads/xt/live', head: 'aaa' }),
                tree({ path: path.join('/worktrees', 'idle'), branch: 'refs/heads/xt/idle', head: 'bbb' }),
            ],
            () => true,
            cwds,
        );

        expect(plan.removable.map(wt => wt.path)).toEqual([path.join('/worktrees', 'idle')]);
        expect(plan.skippedLive).toHaveLength(1);
        expect(plan.skippedLive[0]).toMatchObject({
            path: path.join('/worktrees', 'live'),
            branch: 'xt/live',
            livePids: [4242, 4243],
        });
    });

    it('removes nothing the merge predicate excludes, live or not', () => {
        const plan = selectCleanTargets(
            [tree({ path: '/worktrees/unmerged', branch: 'xt/unmerged' })],
            () => false,
            new Map(),
        );

        expect(plan.removable).toEqual([]);
        expect(plan.skippedLive).toEqual([]);
    });
});

describe('readProcessCwds', () => {
    it('can refuse instead of telling a caller that nothing is running', () => {
        expect(readProcessCwds('/nonexistent-proc-root').size).toBe(0);
        expect(() => readProcessCwds('/nonexistent-proc-root', { strict: true }))
            .toThrow(/cannot enumerate process working directories/);
    });
});

describe('selectCleanTargets', () => {
    it('names the tree it keeps because it is unmerged, so a missing line cannot mean "not examined"', () => {
        const trees: WorktreeInfo[] = [
            { path: '/w/merged', branch: 'refs/heads/xt/merged', head: 'a'.repeat(40) },
            { path: '/w/detached-unmerged', branch: '', head: 'b'.repeat(40) },
        ] as WorktreeInfo[];
        const plan = selectCleanTargets(trees, wt => wt.branch !== '', new Map());
        expect(plan.removable.map(t => t.path)).toEqual(['/w/merged']);
        // The third distinction SUCCESS names: printed with its reason, not silently dropped.
        expect(plan.unmerged).toHaveLength(1);
        expect(plan.unmerged[0].path).toBe('/w/detached-unmerged');
        expect(plan.unmerged[0].branch).toBe('');
    });
});

describe('readProcessTableOrRefuse', () => {
    it('prints the shared refusal and answers null when the process table cannot be read', () => {
        const logs: string[] = [];
        const original = console.log;
        const exitBefore = process.exitCode;
        console.log = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
        try {
            const cwds = readProcessTableOrRefuse('/nonexistent-proc-root');
            expect(cwds).toBeNull();
        } finally {
            console.log = original;
            process.exitCode = exitBefore;
        }
        const text = logs.join('\n');
        expect(text).toContain('cannot enumerate process working directories under /nonexistent-proc-root');
        // The same sentence both destructive commands print, so one reads as neither advisory.
        expect(text).toContain('Nothing was removed: without the process table this command cannot tell a live worktree from an idle one.');
    });
});

describe('applyReap', () => {
    it('refuses at the pre-removal re-read, so an unreadable table cannot be read as "nothing running"', () => {
        // Strict on purpose: an empty map marks every candidate idle and the loop removes
        // worktrees that are in use. This is the same defect, one step later than planning.
        expect(() => applyReap(
            { candidates: [], summary: { reapable: 0, artifacts_only: 0, reclaimable_bytes: 0, held: 0, skipped: 0 } } as never,
            { procRoot: '/nonexistent-proc-root' },
        )).toThrow(/cannot enumerate process working directories under \/nonexistent-proc-root/);
    });
});
