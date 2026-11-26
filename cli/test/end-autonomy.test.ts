import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.join(__dirname, '../dist/index.cjs');

function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): { stdout: string; stderr: string; status: number } {
    const r = spawnSync('node', [CLI_BIN, ...args], {
        encoding: 'utf8',
        timeout: 20000,
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

function git(args: string[], cwd: string): string {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout ?? '').trim();
}

describe('xt end dry-run autonomy heuristics', () => {
    it('synthesizes a non-generic title from changed files when no issue metadata is available', () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-end-autonomy-'));
        const remote = path.join(tmpBase, 'remote.git');
        const mainRepo = path.join(tmpBase, 'repo');
        const xtWorktree = path.join(tmpBase, 'repo-xt');

        try {
            git(['init', '--bare', remote], tmpBase);

            fs.mkdirSync(mainRepo);
            git(['init', '-b', 'main'], mainRepo);
            git(['config', 'user.email', 'test@test.com'], mainRepo);
            git(['config', 'user.name', 'Test'], mainRepo);
            git(['remote', 'add', 'origin', remote], mainRepo);

            fs.mkdirSync(path.join(mainRepo, 'cli', 'src', 'commands'), { recursive: true });
            fs.mkdirSync(path.join(mainRepo, 'docs'), { recursive: true });
            fs.writeFileSync(path.join(mainRepo, 'README.md'), '# test');
            fs.writeFileSync(path.join(mainRepo, 'cli', 'src', 'commands', 'docs.ts'), 'export const docs = 1;\n');
            git(['add', '.'], mainRepo);
            git(['commit', '-m', 'init'], mainRepo);
            git(['push', '-u', 'origin', 'main'], mainRepo);

            git(['worktree', 'add', '-b', 'xt/test-autonomy', xtWorktree], mainRepo);
            fs.mkdirSync(path.join(xtWorktree, 'cli', 'src', 'commands'), { recursive: true });
            fs.mkdirSync(path.join(xtWorktree, 'docs'), { recursive: true });
            fs.writeFileSync(path.join(xtWorktree, 'cli', 'src', 'commands', 'docs-cross-check-gh.ts'), 'export const gh = 1;\n');
            fs.writeFileSync(path.join(xtWorktree, 'docs', 'docs-commands.md'), '# docs commands\n');
            git(['add', '.'], xtWorktree);
            git(['commit', '-m', 'Implement docs flow (xtrm-skg2)'], xtWorktree);

            const r = run(['end', '--dry-run'], { cwd: xtWorktree });
            const combined = r.stdout + r.stderr;

            expect(r.status).toBe(0);
            expect(combined).not.toMatch(/Title:\s+session changes/i);
            expect(combined).toMatch(/Title:\s+.+/i);
            expect(combined).toMatch(/xtrm-skg2/i);
        } finally {
            try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });


    it('auto-rebuilds cli/dist during xt end when cli/src changed in session commits', () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-end-rebuild-'));
        const remote = path.join(tmpBase, 'remote.git');
        const mainRepo = path.join(tmpBase, 'repo');
        const xtWorktree = path.join(tmpBase, 'repo-xt');
        const fakeBin = path.join(tmpBase, 'fake-bin');

        try {
            git(['init', '--bare', remote], tmpBase);

            fs.mkdirSync(mainRepo);
            git(['init', '-b', 'main'], mainRepo);
            git(['config', 'user.email', 'test@test.com'], mainRepo);
            git(['config', 'user.name', 'Test'], mainRepo);
            git(['remote', 'add', 'origin', remote], mainRepo);

            fs.mkdirSync(path.join(mainRepo, 'cli', 'src'), { recursive: true });
            fs.mkdirSync(path.join(mainRepo, 'cli', 'dist'), { recursive: true });
            fs.writeFileSync(path.join(mainRepo, 'package.json'), JSON.stringify({
                name: 'test-root',
                private: true,
                workspaces: ['cli'],
            }, null, 2));
            fs.writeFileSync(path.join(mainRepo, 'cli', 'package.json'), JSON.stringify({
                name: 'test-cli',
                private: true,
                scripts: { build: 'node build.js' },
            }, null, 2));
            fs.writeFileSync(path.join(mainRepo, 'cli', 'src', 'index.ts'), 'export const version = 1;\n');
            fs.writeFileSync(path.join(mainRepo, 'cli', 'dist', 'index.cjs'), 'stale build\n');
            git(['add', '.'], mainRepo);
            git(['commit', '-m', 'init'], mainRepo);
            git(['push', '-u', 'origin', 'main'], mainRepo);

            git(['worktree', 'add', '-b', 'xt/test-rebuild', xtWorktree], mainRepo);
            fs.writeFileSync(path.join(xtWorktree, 'cli', 'src', 'index.ts'), 'export const version = 2;\n');
            git(['add', 'cli/src/index.ts'], xtWorktree);
            git(['commit', '-m', 'Update CLI source (xtrm-skg2)'], xtWorktree);

            fs.mkdirSync(fakeBin, { recursive: true });
            fs.writeFileSync(path.join(fakeBin, 'npm'), `#!/bin/sh
mkdir -p "$PWD/cli/dist"
printf "rebuilt from xt end\n" > "$PWD/cli/dist/index.cjs"
printf "fake npm build\n"
`);
            fs.writeFileSync(path.join(fakeBin, 'gh'), '#!/bin/sh\necho https://example.test/pr/123\n');
            fs.chmodSync(path.join(fakeBin, 'npm'), 0o755);
            fs.chmodSync(path.join(fakeBin, 'gh'), 0o755);

            const r = run(['end', '--yes', '--keep'], {
                cwd: xtWorktree,
                env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
            });
            const combined = r.stdout + r.stderr;

            expect(r.status).toBe(0);
            expect(combined).toMatch(/cli\/src changed in this session/i);
            expect(combined).toMatch(/Rebuilt cli\/dist and committed/i);
            expect(fs.readFileSync(path.join(xtWorktree, 'cli', 'dist', 'index.cjs'), 'utf8')).toBe('rebuilt from xt end\n');
            expect(git(['log', '-1', '--pretty=%s'], xtWorktree)).toBe('chore: rebuild dist after source changes');
        } finally {
            try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });

    it('recognizes dotted issue ids from commit messages in dry-run output', () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-end-dotted-'));
        const remote = path.join(tmpBase, 'remote.git');
        const mainRepo = path.join(tmpBase, 'repo');
        const xtWorktree = path.join(tmpBase, 'repo-xt');

        try {
            git(['init', '--bare', remote], tmpBase);

            fs.mkdirSync(mainRepo);
            git(['init', '-b', 'main'], mainRepo);
            git(['config', 'user.email', 'test@test.com'], mainRepo);
            git(['config', 'user.name', 'Test'], mainRepo);
            git(['remote', 'add', 'origin', remote], mainRepo);
            fs.writeFileSync(path.join(mainRepo, 'README.md'), '# test');
            git(['add', '.'], mainRepo);
            git(['commit', '-m', 'init'], mainRepo);
            git(['push', '-u', 'origin', 'main'], mainRepo);

            git(['worktree', 'add', '-b', 'xt/test-dotted', xtWorktree], mainRepo);
            fs.writeFileSync(path.join(xtWorktree, 'README.md'), '# changed\n');
            git(['add', 'README.md'], xtWorktree);
            git(['commit', '-m', 'Add tests (8jr5.8)'], xtWorktree);

            const r = run(['end', '--dry-run'], { cwd: xtWorktree });
            const combined = r.stdout + r.stderr;

            expect(r.status).toBe(0);
            expect(combined).toMatch(/8jr5\.8/);
        } finally {
            try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });
});
