import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { applyCleanRemoval, applyReap, branchLineMatches, cleanScanIsEmpty, isMergedWorktree, renderCleanPlan, scanCleanTargets, selectOrphanTargets, isMergedIntoMain, planReap, printCleanPlan, readProcessTableOrRefuse, selectCleanTargets, worktreeListStatus, type CleanScan, type WorktreeInfo } from '../commands/worktree.js';
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

describe('printCleanPlan', () => {
    it('prints every class with its reason, so no classification is dropped silently', () => {
        const logs: string[] = [];
        const original = console.log;
        console.log = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
        try {
            const target = (path: string, branch: string, livePids: number[] = []) => ({ path, branch, livePids });
            printCleanPlan({
                removable: [target('/tmp/w-merged', 'xt/merged')],
                skippedLive: [target('/tmp/w-live', 'xt/live', [4242])],
                unmerged: [target('/tmp/w-unmerged', 'xt/unmerged')],
            });
        } finally {
            console.log = original;
        }

        const text = logs.join('\n');
        expect(text).toContain('1 merged worktree(s):');
        expect(text).toContain('1 merged worktree(s) kept, in use right now:');
        expect(text).toContain('in use: pids 4242');
        // The line a user reads when their tree was skipped. A plan-only assertion
        // stayed green while deleting these two console.log calls changed nothing.
        expect(text).toContain('1 worktree(s) kept, not merged:');
        expect(text).toContain('/tmp/w-unmerged (xt/unmerged) not merged into the default branch');
    });

    it('prints a live orphan under its own heading, never as a kept merged worktree', () => {
        const logs: string[] = [];
        const original = console.log;
        console.log = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
        try {
            const target = (p: string, branch: string, livePids: number[] = []) => ({ path: p, branch, livePids });
            printCleanPlan(
                { removable: [], skippedLive: [], unmerged: [] },
                [target('/tmp/managed/orphan-live', '', [9191])],
            );
        } finally {
            console.log = original;
        }

        const text = logs.join('\n');
        // The orphan is not a merged worktree and has no branch: printing it under
        // that heading told the reader something untrue about what was kept.
        expect(text).toContain('1 orphaned director(y/ies) kept, in use right now:');
        expect(text).toContain('/tmp/managed/orphan-live in use: pids 9191');
        expect(text).not.toContain('merged worktree(s) kept');
        expect(text).not.toContain('detached');
    });
});

describe('renderCleanPlan: the orphan class reaches the printer', () => {
    const scanWith = (fields: Partial<CleanScan>): CleanScan => ({
        plan: { removable: [], skippedLive: [], unmerged: [] },
        orphans: [],
        orphansSkippedLive: [],
        ...fields,
    });

    const capture = (fn: () => void): string => {
        const logs: string[] = [];
        const original = console.log;
        console.log = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
        try { fn(); } finally { console.log = original; }
        return logs.join('\n');
    };

    it('prints the live orphan it was given, through the printer that names the class', () => {
        // The call site passed `scan.orphansSkippedLive` to printCleanPlan; dropping it
        // left every suite green because nothing asserted the rendered line.
        const text = capture(() => renderCleanPlan(
            scanWith({ orphansSkippedLive: [{ path: '/tmp/managed/orphan-live', branch: '', livePids: [9191] }] }),
            { orphans: false },
        ));
        expect(text).toContain('1 orphaned director(y/ies) kept, in use right now:');
        expect(text).toContain('/tmp/managed/orphan-live in use: pids 9191');
    });

    it('prints nothing about orphans when it was given none', () => {
        const text = capture(() => renderCleanPlan(scanWith({}), { orphans: false }));
        expect(text).not.toContain('orphaned director(y/ies) kept');
        expect(text).not.toContain('0 orphaned managed director(y/ies)');
    });
});

describe('cleanScanIsEmpty: a kept orphan is not an empty scan', () => {
    const scanWith = (fields: Partial<CleanScan>): CleanScan => ({
        plan: { removable: [], skippedLive: [], unmerged: [] },
        orphans: [],
        orphansSkippedLive: [],
        ...fields,
    });

    it('is empty only when every class is empty', () => {
        expect(cleanScanIsEmpty(scanWith({}))).toBe(true);
        expect(cleanScanIsEmpty(scanWith({ plan: { removable: [{ path: '/tmp/w', branch: 'xt/1', livePids: [] }], skippedLive: [], unmerged: [] } }))).toBe(false);
    });

    it('is NOT empty when the only finding is a live orphan', () => {
        // "No merged worktrees to clean" was printed for a scan whose one finding was
        // a directory kept because a process runs in it — the report contradicted the work.
        expect(cleanScanIsEmpty(scanWith({ orphansSkippedLive: [{ path: '/tmp/managed/orphan-live', branch: '', livePids: [1] }] }))).toBe(false);
        expect(cleanScanIsEmpty(scanWith({ orphans: [{ path: '/tmp/managed/orphan-idle', branch: '', livePids: [] }] }))).toBe(false);
    });
});

describe('scanCleanTargets: orphans are classified as orphans', () => {
    it('keeps a live orphan off the merged-worktree list', () => {
        const scan = scanCleanTargets({
            worktrees: [],
            orphans: ['/tmp/managed/orphan-live', '/tmp/managed/orphan-idle'],
            merged: () => false,
            readTable: () => new Map([['/tmp/managed/orphan-live', [9191]]]),
        });

        expect(scan).not.toBeNull();
        const live = scan?.orphansSkippedLive ?? [];
        expect(live.map(o => o.path)).toEqual(['/tmp/managed/orphan-live']);
        expect(live[0]?.livePids).toEqual([9191]);
        // The worktree list stays empty: one live class cannot masquerade as another.
        expect(scan?.plan.skippedLive).toEqual([]);
        expect((scan?.orphans ?? []).map(o => o.path)).toEqual(['/tmp/managed/orphan-idle']);
    });
});

describe('worktreeListStatus', () => {
    it('answers for a detached tree from its HEAD, the way clean does', () => {
        const repo = makeRepo();
        const mainSha = git(['rev-parse', 'HEAD'], repo);
        git(['checkout', '--quiet', '--detach'], repo);

        // Detached at a merged commit: `clean` calls this removable, so `list` must not
        // call it open. Dropping the HEAD argument here is the regression this pins.
        expect(worktreeListStatus(tree({ path: repo, branch: '', head: mainSha }), repo)).toBe('merged');
        // And the answer stays "open" when the HEAD is anything the predicate cannot
        // read as a commit: no silent merged-by-default for a tree it cannot identify.
        expect(worktreeListStatus(tree({ path: repo, branch: '', head: 'not-a-sha' }), repo)).toBe('open');
    });
});

describe('selectOrphanTargets', () => {
    it('keeps an orphan directory a session is running in, and names its pids', () => {
        const cwds = new Map<string, number[]>([
            [path.join('/tmp', 'managed', 'orphan-live'), [9191]],
            [path.join('/tmp', 'managed', 'orphan-idle'), []],
        ]);
        const plan = selectOrphanTargets(['/tmp/managed/orphan-live', '/tmp/managed/orphan-idle'], cwds);

        expect(plan.skippedLive.map(t => t.path)).toEqual(['/tmp/managed/orphan-live']);
        expect(plan.skippedLive[0]?.livePids).toEqual([9191]);
        expect(plan.removable.map(t => t.path)).toEqual(['/tmp/managed/orphan-idle']);
    });

    it('keeps an orphan whose child process sits in a subdirectory of it', () => {
        const cwds = new Map<string, number[]>([[path.join('/tmp/managed/orphan-live', 'packages', 'x'), [42]]]);
        const plan = selectOrphanTargets(['/tmp/managed/orphan-live'], cwds);
        expect(plan.removable).toEqual([]);
        expect(plan.skippedLive[0]?.livePids).toEqual([42]);
    });
});

describe('scanCleanTargets', () => {
    it('refuses the whole scan when the process table cannot be read, and never asks the merge predicate', () => {
        let asked = 0;
        const scan = scanCleanTargets({
            worktrees: [{ path: '/tmp/wt', branch: 'refs/heads/xt/1', head: 'abc1234', prunable: false }],
            orphans: ['/tmp/managed/orphan'],
            merged: () => {
                asked += 1;
                return true;
            },
            readTable: () => null,
        });

        expect(scan).toBeNull();
        expect(asked).toBe(0);
    });

    it('keeps a live orphan visible, in the class that names it an orphan', () => {
        const scan = scanCleanTargets({
            worktrees: [],
            orphans: ['/tmp/managed/orphan-live'],
            merged: () => true,
            readTable: () => new Map([[path.join('/tmp/managed/orphan-live'), [77]]]),
        });

        // Kept, not removed silently: that part was right. It first landed in
        // `plan.skippedLive`, which the printer heads "merged worktree(s) kept" —
        // a true removal decision described with an untrue noun.
        expect(scan?.orphans).toEqual([]);
        expect(scan?.orphansSkippedLive.map(t => t.path)).toEqual(['/tmp/managed/orphan-live']);
        expect(scan?.plan.skippedLive).toEqual([]);
    });
});

describe('applyCleanRemoval', () => {
    const target = (p: string) => ({ path: p, branch: 'xt/1', livePids: [] as number[] });

    it('removes an idle target', () => {
        const removed: string[] = [];
        const result = applyCleanRemoval('/repo', [target('/tmp/a')], {
            readCwds: () => new Map(),
            remove: (p) => {
                removed.push(p);
                return { ok: true, message: `removed ${p}` };
            },
        });

        expect(removed).toEqual(['/tmp/a']);
        expect(result.removed).toEqual(['/tmp/a']);
    });

    it('keeps a target that became live after the scan, so a scan-time answer cannot authorise a delete', () => {
        const removed: string[] = [];
        const result = applyCleanRemoval('/repo', [target('/tmp/a')], {
            readCwds: () => new Map([['/tmp/a', [31]]]),
            remove: (p) => {
                removed.push(p);
                return { ok: true, message: p };
            },
        });

        expect(removed).toEqual([]);
        expect(result.becameLive).toEqual(['/tmp/a']);
    });

    it('refuses rather than assumes when the re-read cannot enumerate processes', () => {
        const removed: string[] = [];
        const result = applyCleanRemoval('/repo', [target('/tmp/a')], {
            readCwds: () => {
                throw new Error('cannot enumerate process working directories under /proc: EACCES');
            },
            remove: (p) => {
                removed.push(p);
                return { ok: true, message: p };
            },
        });

        expect(removed).toEqual([]);
        expect(result.unreadable).toEqual(['/tmp/a']);
    });
});

describe('isMergedIntoMain: a git failure is not an answer', () => {
    it('keeps the tree when the merged-branch listing fails, rather than calling it merged', () => {
        const repo = makeRepo();
        // The listing NAMES the branch and still failed, so the status is the only
        // thing standing between this tree and its removal. A stub with no stdout
        // answers false with or without the guard, and the guard would be unobservable.
        const merged = isMergedIntoMain('xt/1', repo, undefined, () => ({ status: 128, stdout: '  xt/1\n' }));
        expect(merged).toBe(false);
    });

    it('keeps a detached tree when the ancestry probe fails', () => {
        const repo = makeRepo();
        const merged = isMergedIntoMain('', repo, 'abcdef1234567', () => ({ status: 129 }));
        expect(merged).toBe(false);
    });

    it('answers merged when the listing names the branch it was asked about', () => {
        const repo = makeRepo();
        const merged = isMergedIntoMain('xt/1', repo, undefined, () => ({ status: 0, stdout: '  xt/1\n' }));
        expect(merged).toBe(true);
    });
});

describe('isMergedWorktree: a branchless tree asks no PR', () => {
    it('never asks about a PR for a detached tree, even when the HEAD is not merged', () => {
        const asked: string[] = [];
        const merged = isMergedWorktree({ path: '/tmp/wt', branch: '', head: 'deadbeef', prunable: false }, '/repo', (branch) => {
            asked.push(branch);
            return { state: 'MERGED' };
        });
        expect(merged).toBe(false);
        expect(asked).toEqual([]);
    });

    it('asks the PR state when there is a branch and the merge predicate said no', () => {
        const repo = makeRepo();
        const merged = isMergedWorktree({ path: '/tmp/wt', branch: 'xt/unmerged', head: '', prunable: false }, repo, (branch) => {
            expect(branch).toBe('xt/unmerged');
            return { state: 'MERGED' };
        });
        expect(merged).toBe(true);
    });
});
