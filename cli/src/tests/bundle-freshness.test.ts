import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('bundle freshness: the order git writes, not the order mtime shows (CORE-2774)', () => {
    const shaOf = (n: number) => String(n).repeat(40).slice(0, 40);

    /** Two paths stamped by the same commit, which is what a checkout produces. */
    const sameCommit = () => {
        const stamp = { sha: shaOf(1), at: 1_700_000_000_000 };
        return () => stamp;
    };

    it('calls a 124ms lag fresh when one commit wrote both, and says so rather than rounding', () => {
        const root = cliRoot({ bundleAgeMs: 124, sourceAgeMs: 0 });
        const freshness = readBundleFreshness({ cliRoot: root, lastCommit: sameCommit() });
        expect(freshness.state).toBe('fresh');
        expect(freshness.detail).toContain('checkout order');
        expect(freshness.detail).toContain('124ms');
        expect(freshness.detail).not.toContain('1s');
    });

    it('calls it stale when the source moved in a later commit, and names both commits', () => {
        const root = cliRoot({ bundleAgeMs: 7_200_000, sourceAgeMs: 0 });
        const freshness = readBundleFreshness({
            cliRoot: root,
            lastCommit: (relPath) =>
                relPath === path.join('dist', 'index.cjs')
                    ? { sha: shaOf(2), at: 1_700_000_000_000 }
                    : { sha: shaOf(3), at: 1_700_000_600_000 },
        });
        expect(freshness.state).toBe('stale');
        expect(freshness.detail).toContain('2'.repeat(12));
        expect(freshness.detail).toContain('3'.repeat(12));
        expect(freshness.detail).toContain('cd cli && npm run build');
    });

    it('declines to conclude when there is no history and the lag is a checkout window', () => {
        const root = cliRoot({ bundleAgeMs: 124, sourceAgeMs: 0 });
        const freshness = readBundleFreshness({ cliRoot: root, lastCommit: () => null });
        expect(freshness.state).toBe('unknown');
        expect(freshness.lagMs).toBeGreaterThan(0);
        expect(formatBundleFreshness(freshness)).toContain('cannot tell');
        expect(formatBundleFreshness(freshness)).toContain('124ms');
    });

    it('still reports real staleness without history when the lag is not a write window', () => {
        const root = cliRoot({ bundleAgeMs: 7_200_000, sourceAgeMs: 0 });
        const freshness = readBundleFreshness({ cliRoot: root, lastCommit: () => null });
        expect(freshness.state).toBe('stale');
        expect(freshness.lagMs).toBeGreaterThan(7_000_000);
    });
});
