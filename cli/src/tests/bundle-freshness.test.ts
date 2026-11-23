import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatBundleFreshness, listSourceFiles, readBundleFreshness } from '../core/bundle-freshness.js';

const created: string[] = [];

function scratch(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-bundle-'));
    created.push(dir);
    return dir;
}

/** A cli root with one bundle and one source file, and the two mtimes we choose. */
function cliRoot(opts: { bundleAgeMs?: number; sourceAgeMs?: number; skipBundle?: boolean; skipSource?: boolean }): string {
    const root = scratch();
    const builtAt = Date.now() - 3_600_000;
    if (!opts.skipBundle) {
        fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
        const bundle = path.join(root, 'dist', 'index.cjs');
        fs.writeFileSync(bundle, '// bundle\n');
        fs.utimesSync(bundle, new Date(builtAt - (opts.bundleAgeMs ?? 0)), new Date(builtAt - (opts.bundleAgeMs ?? 0)));
    }
    if (!opts.skipSource) {
        fs.mkdirSync(path.join(root, 'src', 'commands'), { recursive: true });
        const source = path.join(root, 'src', 'commands', 'pi.ts');
        fs.writeFileSync(source, 'export const x = 1;\n');
        const at = builtAt - (opts.sourceAgeMs ?? 3_600_000);
        fs.utimesSync(source, new Date(at), new Date(at));
    }
    return root;
}

afterEach(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe('bundle freshness (CORE-2754)', () => {
    it('calls a bundle newer than every source file fresh', () => {
        const root = cliRoot({ bundleAgeMs: 0, sourceAgeMs: 3_600_000 });
        const freshness = readBundleFreshness({ cliRoot: root });
        expect(freshness.state).toBe('fresh');
        expect(freshness.newestSource?.path).toBe(path.join('src', 'commands', 'pi.ts'));
        expect(formatBundleFreshness(freshness)).toContain('fresh');
    });

    it('calls a bundle older than a source file stale, names the file and the rebuild', () => {
        const root = cliRoot({ bundleAgeMs: 7_200_000, sourceAgeMs: 0 });
        const freshness = readBundleFreshness({ cliRoot: root });
        expect(freshness.state).toBe('stale');
        expect(freshness.lagMs).toBeGreaterThan(7_000_000);
        const line = formatBundleFreshness(freshness);
        expect(line).toContain('STALE');
        expect(line).toContain(path.join('src', 'commands', 'pi.ts'));
        expect(line).toContain('cd cli && npm run build');
    });

    it('never calls a bundle stale without a source tree to judge it against', () => {
        const noSource = readBundleFreshness({ cliRoot: cliRoot({ skipSource: true }) });
        expect(noSource.state).toBe('unknown');
        expect(noSource.detail).toContain('installed package');

        const noBundle = readBundleFreshness({ cliRoot: cliRoot({ skipBundle: true }) });
        expect(noBundle.state).toBe('unknown');
        expect(noBundle.bundle).toBeNull();
        expect(formatBundleFreshness(noBundle)).toContain('unknown');
    });

    it('judges by the newest source, not by the first one the walk returns', () => {
        // The newest file is LAST in the list, so "take the first file" cannot pass this.
        // Directory order is the filesystem's to choose, so the order is stated, not hoped for.
        const freshness = readBundleFreshness({
            // A bundle exists and no source tree does; the list below is the only input.
            cliRoot: cliRoot({ skipSource: true, bundleAgeMs: 7_200_000 }),
            listSource: () => [
                { path: 'src/commands/pi.ts', mtime: Date.now() - 6_000_000 },
                { path: 'src/utils/touched.ts', mtime: Date.now() },
            ],
        });
        expect(freshness.state).toBe('stale');
        expect(freshness.newestSource?.path).toBe('src/utils/touched.ts');
    });

    it('judges by the newest source, not by a directory mtime', () => {
        // An old file that was just touched is the newest source; the check must see it.
        const root = cliRoot({ bundleAgeMs: 0, sourceAgeMs: 3_600_000 });
        const touched = path.join(root, 'src', 'commands', 'zz-touched.ts');
        fs.writeFileSync(touched, 'export const y = 2;\n');
        const freshness = readBundleFreshness({ cliRoot: root });
        expect(freshness.state).toBe('stale');
        expect(freshness.newestSource?.path).toBe(path.join('src', 'commands', 'zz-touched.ts'));
    });

    it('excludes tests and non-source files from the judgement', () => {
        const root = cliRoot({ bundleAgeMs: 0, sourceAgeMs: 3_600_000 });
        const later = new Date(Date.now() + 60_000);
        for (const [rel, body] of [
            [path.join('src', 'tests', 'whatever.test.ts'), '// test\n'],
            [path.join('src', 'commands', 'notes.md'), '# doc\n'],
            [path.join('src', 'commands', 'pi.test.ts'), '// colocated test\n'],
        ]) {
            const abs = path.join(root, rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, body);
            fs.utimesSync(abs, later, later);
        }
        const files = listSourceFiles(path.join(root, 'src')).map((f) => f.path);
        expect(files).toEqual([path.join('commands', 'pi.ts')]);
        expect(readBundleFreshness({ cliRoot: root }).state).toBe('fresh');
    });
});

/** Real throwaway repositories: the verdict is about git, so the tests ask git. */
function git(cwd: string, ...args: string[]): string {
    const env = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete env[key];
    const result = spawnSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
        { cwd, encoding: 'utf8', env },
    );
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

/** A repository whose `cli/` holds a bundle and one source file, committed together. */
function repo(): { top: string; cli: string } {
    const top = scratch();
    git(top, 'init', '-q', '-b', 'main');
    const cli = path.join(top, 'cli');
    fs.mkdirSync(path.join(cli, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(cli, 'src', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(cli, 'dist', 'index.cjs'), '// bundle v1\n');
    fs.writeFileSync(path.join(cli, 'src', 'commands', 'pi.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(cli, 'src', 'commands', 'other.ts'), 'export const z = 1;\n');
    git(top, 'add', '-A');
    git(top, 'commit', '-q', '-m', 'bundle and source');
    return { top, cli };
}

describe('bundle freshness: git decides, mtime does not (CORE-2774)', () => {
    it('calls a clean tree fresh when one commit wrote both, whatever the mtimes say', () => {
        const { cli } = repo();
        // Source newer than the bundle by 124 ms: what a checkout produces.
        const bundle = path.join(cli, 'dist', 'index.cjs');
        const at = new Date(Date.now() - 3_600_000);
        fs.utimesSync(bundle, at, at);
        const src = path.join(cli, 'src', 'commands', 'pi.ts');
        const later = new Date(at.getTime() + 124);
        fs.utimesSync(src, later, later);
        const freshness = readBundleFreshness({ cliRoot: cli });
        expect(freshness.state).toBe('fresh');
        expect(freshness.detail).toContain('same commit');
    });

    it('calls a fresh clone fresh, whichever of dist/ and src/ the checkout wrote last', () => {
        const { top } = repo();
        const clone = path.join(scratch(), 'clone');
        git(path.dirname(clone), 'clone', '-q', top, clone);
        const freshness = readBundleFreshness({ cliRoot: path.join(clone, 'cli') });
        expect(freshness.state).toBe('fresh');
    });

    it('calls the two-commit case stale: the source moved, the bundle did not', () => {
        const { top, cli } = repo();
        fs.writeFileSync(path.join(cli, 'src', 'commands', 'pi.ts'), 'export const x = 2;\n');
        git(top, 'commit', '-q', '-am', 'edit source, bundle not rebuilt');
        // The bundle is newer on disk than every source: only git can see it is behind.
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(path.join(cli, 'dist', 'index.cjs'), future, future);
        const freshness = readBundleFreshness({ cliRoot: cli });
        expect(freshness.state).toBe('stale');
        expect(formatBundleFreshness(freshness)).toContain('STALE');
        expect(formatBundleFreshness(freshness)).toContain('cd cli && npm run build');
    });

    it('calls the bundle fresh once a later commit rebuilds it', () => {
        const { top, cli } = repo();
        fs.writeFileSync(path.join(cli, 'src', 'commands', 'pi.ts'), 'export const x = 2;\n');
        git(top, 'commit', '-q', '-am', 'edit source');
        fs.writeFileSync(path.join(cli, 'dist', 'index.cjs'), '// bundle v2\n');
        git(top, 'commit', '-q', '-am', 'rebuild bundle');
        expect(readBundleFreshness({ cliRoot: cli }).state).toBe('fresh');
    });

    it('judges the whole source directory, not the newest-mtime file', () => {
        const { top, cli } = repo();
        fs.writeFileSync(path.join(cli, 'src', 'commands', 'other.ts'), 'export const z = 2;\n');
        git(top, 'commit', '-q', '-am', 'edit other.ts');
        // pi.ts is given the newest mtime, and it was last written by the old commit.
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(path.join(cli, 'src', 'commands', 'pi.ts'), future, future);
        expect(readBundleFreshness({ cliRoot: cli }).state).toBe('stale');
    });

    it('does not count a commit that touched only tests', () => {
        const { top, cli } = repo();
        fs.mkdirSync(path.join(cli, 'src', 'tests'), { recursive: true });
        fs.writeFileSync(path.join(cli, 'src', 'tests', 'pi.test.ts'), '// test\n');
        fs.writeFileSync(path.join(cli, 'src', 'commands', 'pi.test.ts'), '// colocated\n');
        git(top, 'add', '-A');
        git(top, 'commit', '-q', '-m', 'tests only');
        expect(readBundleFreshness({ cliRoot: cli }).state).toBe('fresh');
    });

    it('calls an uncommitted edit to a source file stale, even with a bundle newer than every source', () => {
        const { cli } = repo();
        const src = path.join(cli, 'src', 'commands', 'pi.ts');
        fs.writeFileSync(src, 'export const x = 99;\n');
        const old = new Date(Date.now() - 7_200_000);
        fs.utimesSync(src, old, old);
        const freshness = readBundleFreshness({ cliRoot: cli });
        expect(freshness.state).toBe('stale');
        expect(freshness.detail).toContain(path.join('src', 'commands', 'pi.ts'));
        expect(freshness.detail).toContain('uncommitted');
    });

    it('calls a new untracked source file, a deleted one and a staged edit stale', () => {
        for (const mutate of [
            (cli: string, top: string) => {
                void top;
                fs.writeFileSync(path.join(cli, 'src', 'commands', 'brand-new.ts'), 'export const n = 1;\n');
            },
            (cli: string, top: string) => {
                void top;
                fs.rmSync(path.join(cli, 'src', 'commands', 'other.ts'));
            },
            (cli: string, top: string) => {
                fs.writeFileSync(path.join(cli, 'src', 'commands', 'pi.ts'), 'export const x = 3;\n');
                git(top, 'add', '-A');
            },
        ]) {
            const { top, cli } = repo();
            mutate(cli, top);
            expect(readBundleFreshness({ cliRoot: cli }).state).toBe('stale');
        }
    });

    it('ignores an uncommitted change to a test file, which ships in no bundle', () => {
        const { top, cli } = repo();
        fs.mkdirSync(path.join(cli, 'src', 'tests'), { recursive: true });
        fs.writeFileSync(path.join(cli, 'src', 'tests', 'pi.test.ts'), '// test\n');
        void top;
        expect(readBundleFreshness({ cliRoot: cli }).state).toBe('fresh');
    });

    it('reports one touched source file as STALE in the formatted line', () => {
        const { cli } = repo();
        fs.appendFileSync(path.join(cli, 'src', 'commands', 'pi.ts'), '// touched\n');
        expect(formatBundleFreshness(readBundleFreshness({ cliRoot: cli }))).toMatch(/^STALE — /);
    });

    it('falls back to the mtime rule in a shallow clone, and never says fresh on a checkout lag', () => {
        const { top, cli } = repo();
        fs.writeFileSync(path.join(cli, 'src', 'commands', 'pi.ts'), 'export const x = 2;\n');
        git(top, 'commit', '-q', '-am', 'second commit so a depth-1 clone is shallow');
        const clone = path.join(scratch(), 'shallow');
        git(path.dirname(clone), 'clone', '-q', '--depth', '1', `file://${top}`, clone);
        const cloneCli = path.join(clone, 'cli');
        expect(git(clone, 'rev-parse', '--is-shallow-repository')).toBe('true');
        // Source 124 ms newer than the bundle, as a checkout writes them: no conclusion.
        const at = new Date(Date.now() - 3_600_000);
        fs.utimesSync(path.join(cloneCli, 'dist', 'index.cjs'), at, at);
        const later = new Date(at.getTime() + 124);
        for (const file of ['pi.ts', 'other.ts']) fs.utimesSync(path.join(cloneCli, 'src', 'commands', file), later, later);
        expect(readBundleFreshness({ cliRoot: cloneCli }).state).toBe('unknown');
        // The same clone with a real, large lag is stale by the mtime rule.
        const bundleAt = new Date(Date.now() - 7_200_000);
        fs.utimesSync(path.join(cloneCli, 'dist', 'index.cjs'), bundleAt, bundleAt);
        expect(readBundleFreshness({ cliRoot: cloneCli }).state).toBe('stale');
    });

    it('still reports an uncommitted edit stale in a shallow clone', () => {
        const { top, cli } = repo();
        fs.writeFileSync(path.join(cli, 'src', 'commands', 'pi.ts'), 'export const x = 2;\n');
        git(top, 'commit', '-q', '-am', 'second commit');
        const clone = path.join(scratch(), 'shallow');
        git(path.dirname(clone), 'clone', '-q', '--depth', '1', `file://${top}`, clone);
        fs.appendFileSync(path.join(clone, 'cli', 'src', 'commands', 'pi.ts'), '// edit\n');
        expect(readBundleFreshness({ cliRoot: path.join(clone, 'cli') }).state).toBe('stale');
    });

    it('uses the mtime rule when the bundle is rebuilt and not yet committed', () => {
        const { cli } = repo();
        const bundle = path.join(cli, 'dist', 'index.cjs');
        fs.writeFileSync(bundle, '// bundle v2, uncommitted\n');
        const old = new Date(Date.now() - 7_200_000);
        for (const file of ['pi.ts', 'other.ts']) fs.utimesSync(path.join(cli, 'src', 'commands', file), old, old);
        expect(readBundleFreshness({ cliRoot: cli }).state).toBe('fresh');
    });

    it('declines to conclude outside git when the lag is a checkout window', () => {
        const root = cliRoot({ bundleAgeMs: 124, sourceAgeMs: 0 });
        const freshness = readBundleFreshness({ cliRoot: root });
        expect(freshness.state).toBe('unknown');
        expect(formatBundleFreshness(freshness)).toContain('cannot tell');
        expect(formatBundleFreshness(freshness)).toContain('124ms');
    });

    it('still reports real staleness outside git when the lag is not a write window', () => {
        const root = cliRoot({ bundleAgeMs: 7_200_000, sourceAgeMs: 0 });
        const freshness = readBundleFreshness({ cliRoot: root });
        expect(freshness.state).toBe('stale');
        expect(freshness.lagMs).toBeGreaterThan(7_000_000);
    });
});
