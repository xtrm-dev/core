import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    checkRelease,
    classifyIgnored,
    configSourcesSnippet,
    isScaffoldPath,
    keybindingPaths,
    keybindingProbes,
    launcherLinks,
    renderKeybindingSnippet,
    renderNudge,
    validateClientName,
    validatePaneId,
    sourceLine,
} from '../core/worktree-release.js';
import type { ClassifyContext, ReleaseCheckOptions } from '../core/worktree-release.js';

const created: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

function git(args: string[], cwd: string): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout ?? '').trim();
}

function write(file: string, contents: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, 'utf8');
}

/**
 * A main repo with one linked worktree under `.xtrm/worktrees/`, which is the only place
 * the predicate accepts — a real git repo, because the predicate reads git state.
 */
function makeRepoWithWorktree(): { repoRoot: string; worktree: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-release-'));
    created.push(repoRoot);

    git(['init', '--quiet', '--initial-branch=main'], repoRoot);
    git(['config', 'user.email', 'test@example.invalid'], repoRoot);
    git(['config', 'user.name', 'test'], repoRoot);
    write(path.join(repoRoot, 'source.ts'), 'export const value = 1;\n');
    git(['add', '-A'], repoRoot);
    git(['commit', '--quiet', '-m', 'initial'], repoRoot);

    const worktree = path.join(repoRoot, '.xtrm', 'worktrees', 'xt-test');
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(['worktree', 'add', '--quiet', '-b', 'xt/test', worktree, 'HEAD'], repoRoot);

    // A main checkout's branch has no upstream; the predicate must read that as pushed only
    // for the cases under test, so give every tree an up-to-date upstream by default.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-release-origin-'));
    created.push(bare);
    git(['init', '--quiet', '--bare', '--initial-branch=main', bare], bare);
    git(['remote', 'add', 'origin', bare], repoRoot);
    git(['push', '--quiet', '-u', 'origin', 'main'], repoRoot);
    git(['push', '--quiet', '-u', 'origin', 'xt/test'], worktree);

    return { repoRoot, worktree };
}

/** Put a commit on the branch, then remove its upstream and remote so the PR lookup is reached. */
function detachUpstream(repoRoot: string, worktree: string): void {
    write(path.join(worktree, 'branch-work.ts'), 'export const work = 1;\n');
    git(['add', '-A'], worktree);
    git(['commit', '--quiet', '-m', 'branch work'], worktree);
    git(['push', '--quiet', 'origin', 'xt/test'], worktree);
    git(['push', 'origin', '--delete', 'xt/test'], repoRoot);
    git(['branch', '--unset-upstream'], worktree);
    git(['fetch', '--quiet', '--prune', 'origin'], worktree);
}

function check(worktree: string, repoRoot: string, overrides: Partial<ReleaseCheckOptions> = {}) {
    return checkRelease({
        worktree,
        repoRoot,
        allowedPids: [],
        prLookup: () => ({ pass: true, detail: 'test: merged' }),
        ...overrides,
    });
}

function kinds(result: ReturnType<typeof check>): string[] {
    return result.blockers.map(blocker => blocker.kind);
}

afterEach(() => {
    for (const child of children.splice(0)) {
        try {
            child.kill('SIGKILL');
        } catch {
            // already gone
        }
    }
    while (created.length > 0) {
        const dir = created.pop();
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('checkRelease — clean tree', () => {
    it('releases a managed worktree with an up-to-date upstream', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        const result = check(worktree, repoRoot);
        expect(result.ok).toBe(true);
        expect(result.blockers).toEqual([]);
        expect(result.facts.branch).toBe('xt/test');
        expect(result.facts.head).toMatch(/^[0-9a-f]{40}$/);
    });

    it('refuses a path outside .xtrm/worktrees as not-managed', () => {
        const { repoRoot } = makeRepoWithWorktree();
        const result = check(repoRoot, repoRoot);
        expect(kinds(result)).toContain('not-managed');
        expect(result.ok).toBe(false);
    });

    it('reports a removed tree as not-registered, not as an error', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        git(['worktree', 'remove', worktree], repoRoot);
        const result = check(worktree, repoRoot);
        expect(kinds(result)).toEqual(['not-registered']);
    });
});

describe('checkRelease — work that must survive', () => {
    it('blocks a modified tracked file and names it', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        write(path.join(worktree, 'source.ts'), 'export const value = 2;\n');

        const result = check(worktree, repoRoot);
        expect(result.ok).toBe(false);
        const dirty = result.blockers.find(blocker => blocker.kind === 'dirty');
        expect(dirty?.paths).toContain('source.ts');
    });

    it('blocks an untracked file that is not scaffolding', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        write(path.join(worktree, 'notes.md'), 'unfinished\n');

        expect(kinds(check(worktree, repoRoot))).toContain('dirty');
    });

    it('blocks a commit that is not on the remote', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        write(path.join(worktree, 'next.ts'), 'export const next = 1;\n');
        git(['add', '-A'], worktree);
        git(['commit', '--quiet', '-m', 'local only'], worktree);

        const result = check(worktree, repoRoot);
        expect(kinds(result)).toContain('unpushed');
    });

    it('blocks ignored data the operator would lose', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        write(path.join(worktree, '.gitignore'), '.env\n*.db\n');
        git(['add', '-A'], worktree);
        git(['commit', '--quiet', '-m', 'ignore'], worktree);
        git(['push', '--quiet'], worktree);
        write(path.join(worktree, '.env'), 'TOKEN=secret\n');

        expect(kinds(check(worktree, repoRoot))).toContain('ignored-work');
    });

    it('blocks a locked worktree', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        git(['worktree', 'lock', '--reason', 'operator', worktree], repoRoot);

        expect(kinds(check(worktree, repoRoot))).toContain('locked');
    });

    it('blocks when HEAD moved after the check', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        const head = git(['rev-parse', 'HEAD'], worktree);
        write(path.join(worktree, 'next.ts'), 'export const next = 1;\n');
        git(['add', '-A'], worktree);
        git(['commit', '--quiet', '-m', 'moved'], worktree);

        expect(kinds(check(worktree, repoRoot, { expectHead: head }))).toContain('expected-head');
    });

    it('blocks when another process still runs inside the tree', async () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        children.push(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: worktree, stdio: 'ignore' }));
        await new Promise(resolve => setTimeout(resolve, 300));

        const result = check(worktree, repoRoot);
        expect(kinds(result)).toContain('held-by-process');
        expect(result.facts.livePids.length).toBeGreaterThan(0);
    });
});

describe('checkRelease — launcher scaffolding', () => {
    it('exempts the launcher .specialists links but not a real directory', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        const target = path.join(repoRoot, '.specialists', 'user');
        fs.mkdirSync(target, { recursive: true });
        fs.mkdirSync(path.join(worktree, '.specialists'), { recursive: true });
        fs.symlinkSync(path.relative(path.join(worktree, '.specialists'), target), path.join(worktree, '.specialists', 'user'));

        const links = launcherLinks(worktree, repoRoot);
        expect(links.has('user')).toBe(true);
        expect(kinds(check(worktree, repoRoot))).not.toContain('dirty');
    });

    it('blocks a .specialists/user that is a real directory (found live in core-961)', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        write(path.join(worktree, '.specialists', 'user', 'custom', 'role.md'), 'mine\n');

        expect(kinds(check(worktree, repoRoot))).toContain('dirty');
    });

    it('blocks a .specialists symlink that points somewhere else', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        fs.mkdirSync(path.join(worktree, '.specialists'), { recursive: true });
        fs.symlinkSync('/tmp/elsewhere', path.join(worktree, '.specialists', 'user'));

        expect(launcherLinks(worktree, repoRoot).has('user')).toBe(false);
        expect(kinds(check(worktree, repoRoot))).toContain('dirty');
    });

    it('exempts AGENTS.md, .claude/ and .beads/ scaffolding', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        write(path.join(worktree, 'AGENTS.md'), '# guide\n');
        write(path.join(worktree, '.claude', 'settings.json'), '{}\n');
        write(path.join(worktree, '.beads', 'issues.jsonl'), '{}\n');

        expect(kinds(check(worktree, repoRoot))).not.toContain('dirty');
    });

    it('exempts runtime state but not arbitrary ignored data', () => {
        const ctx: ClassifyContext = { worktree: '/w', repoRoot: '/r', exemptLinks: new Set() };
        expect(classifyIgnored('.xtrm/session-meta.json', ctx)).toBe('exempt');
        expect(classifyIgnored('node_modules/pkg/index.js', ctx)).toBe('artifact');
        expect(classifyIgnored('data/fixtures.db', ctx)).toBe('work');
        expect(classifyIgnored('.env', ctx)).toBe('work');
        expect(isScaffoldPath('.pi/extensions/x.ts', ctx)).toBe(true);
        expect(isScaffoldPath('src/index.ts', ctx)).toBe(false);
    });
});

describe('checkRelease — pushed state', () => {
    it('accepts a squash-merged branch whose remote was deleted', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        const head = git(['rev-parse', 'HEAD'], worktree);

        // Simulate the squash merge: a different commit on main, remote branch deleted.
        const origin = git(['remote', 'get-url', 'origin'], repoRoot);
        write(path.join(repoRoot, 'merged.txt'), 'merged\n');
        git(['add', '-A'], repoRoot);
        git(['commit', '--quiet', '-m', 'squash merge'], repoRoot);
        git(['push', '--quiet', 'origin', 'main'], repoRoot);
        git(['push', '--quiet', origin, '--delete', 'xt/test'], repoRoot);
        git(['fetch', '--quiet', '--prune', 'origin'], worktree);

        const result = check(worktree, repoRoot, {
            prLookup: (_worktree, _branch, lookedUpHead) => lookedUpHead === head
                ? { pass: true, detail: 'merged as PR #123 with this head' }
                : { pass: false, detail: 'no matching pull request' },
        });
        expect(result.blockers.filter(blocker => blocker.kind === 'unpushed')).toEqual([]);
    });

    it('blocks an open pull request that carries this head', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        detachUpstream(repoRoot, worktree);
        const result = check(worktree, repoRoot, {
            prLookup: () => ({ pass: false, detail: 'pull request for this head is OPEN, not MERGED' }),
        });
        expect(kinds(result)).toContain('unpushed');
    });

    it('blocks when the pull-request lookup is unavailable', () => {
        const { repoRoot, worktree } = makeRepoWithWorktree();
        detachUpstream(repoRoot, worktree);
        const result = check(worktree, repoRoot, {
            prLookup: () => ({ pass: false, detail: 'no upstream and gh could not confirm a pull request' }),
        });
        expect(kinds(result)).toContain('unpushed');
    });
});

describe('boundary validation', () => {
    it('accepts a pane id and a client name the binding produces', () => {
        expect(validatePaneId('%12')).toBeNull();
        expect(validateClientName('/dev/pts/14')).toBeNull();
        expect(validateClientName('dev-1.2_3')).toBeNull();
    });

    it('refuses anything that could reach the shell', () => {
        expect(validatePaneId('%1; rm -rf /')).not.toBeNull();
        expect(validatePaneId('1')).not.toBeNull();
        expect(validatePaneId('')).not.toBeNull();
        expect(validateClientName('/dev/pts/1; reboot')).not.toBeNull();
        expect(validateClientName('$(id)')).not.toBeNull();
    });
});

describe('nudge text', () => {
    it('names every path and never suggests deleting or cleaning', () => {
        const text = renderNudge({
            branch: 'xt/test',
            blockers: [{ kind: 'dirty', detail: '2 changed path(s) hold work', paths: ['a.ts', '.specialists/user/custom/role.md'] }],
        });

        expect(text).toContain('xt/test');
        expect(text).toContain('a.ts');
        expect(text).toContain('.specialists/user/custom/role.md');
        expect(text).toContain('Commit and push this work');
        expect(text).toContain('Do not delete, clean or force anything');
        expect(text).not.toMatch(/(?:^|\s)(?:rm -rf|git clean|git reset --hard|git push --force)/);
    });

    it('says why a tree with nothing to commit is still blocked', () => {
        const text = renderNudge({
            branch: 'xt/test',
            blockers: [{ kind: 'unpushed', detail: '2 commit(s) ahead of upstream', paths: [] }],
        });
        expect(text).toContain('2 commit(s) ahead of upstream');
        expect(text).toContain('report why');
    });
});

describe('keybinding install surface', () => {
    it('renders one binding with the observed client format', () => {
        const snippet = renderKeybindingSnippet();
        const bindLines = snippet.split('\n').filter(line => line.startsWith('bind X'));
        expect(bindLines).toHaveLength(1);
        expect(bindLines[0]).toContain('xt worktree release --pane #{pane_id} --client #{client_name}');
        expect(snippet).toContain('client_name');
    });

    it('detects a source line and ignores commented ones', () => {
        const paths = keybindingPaths('/home/test');
        const line = sourceLine(paths);

        expect(line).toContain(paths.snippetPath);
        expect(configSourcesSnippet(`${line}\n`, paths)).toBe(true);
        expect(configSourcesSnippet(`#${line}\n`, paths)).toBe(false);
        expect(configSourcesSnippet('set -g mouse on\n', paths)).toBe(false);
    });

    it('reports each probe independently', () => {
        const probes = keybindingProbes({
            snippetExists: true,
            snippetHasBinding: true,
            tmuxConfExists: true,
            tmuxConfSources: false,
            binding: 'unknown key: X',
            xtOnPath: false,
        });
        const failed = probes.filter(probe => !probe.ok).map(probe => probe.label);
        expect(failed).toContain('tmux.conf sources snippet');
        expect(failed).toContain('prefix X bound');
        expect(failed).toContain('xt on tmux PATH');
        expect(failed).not.toContain('release snippet');
    });
});
