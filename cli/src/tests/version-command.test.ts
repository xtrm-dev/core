import { describe, it, expect, vi } from 'vitest';
import { collectVersionInfo, createVersionCommand } from '../commands/version.js';

vi.mock('../utils/npm-latest.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/npm-latest.js')>();
    return {
        ...actual,
        checkXtrmUpdates: () => ([
            { pkg: 'xtrm-tools', installed: '0.11.2', latest: '0.11.2', state: 'ok', fromCache: false, cacheAgeMs: 0 },
            { pkg: '@jaggerxtrm/xtmux', installed: '0.9.0', latest: '0.9.1', state: 'stale', fromCache: false, cacheAgeMs: 0 },
            { pkg: '@jaggerxtrm/specialists', installed: null, latest: null, state: 'unknown', fromCache: false, cacheAgeMs: null },
        ]),
        defaultCacheFile: () => '/tmp/mock-npm-latest.json',
    };
});

describe('xt version', () => {
    it('collectVersionInfo returns the required fields with correct shape', () => {
        const info = collectVersionInfo();
        expect(info.package).toBe('xtrm-tools');
        expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(info.source === 'npm' || info.source === 'local').toBe(true);
        expect(info.runtime.node).toMatch(/^\d+\.\d+\.\d+/);
        expect(info.commit === null || typeof info.commit === 'string').toBe(true);
        expect(info.dirty === null || typeof info.dirty === 'boolean').toBe(true);
        expect(info.built_at === null || typeof info.built_at === 'string').toBe(true);
    });

    it('creates a commander Command with --json option', () => {
        const cmd = createVersionCommand();
        expect(cmd.name()).toBe('version');
        const opts = cmd.options.map((o) => o.long);
        expect(opts).toContain('--json');
    });

    it('--json emits a valid single-line JSON envelope', async () => {
        // Capture process.stdout.write directly (commander's action is sync here).
        const chunks: string[] = [];
        const originalWrite = process.stdout.write.bind(process.stdout);
        // @ts-ignore
        process.stdout.write = (chunk: string) => {
            chunks.push(chunk);
            return true;
        };
        try {
            const cmd = createVersionCommand();
            await cmd.parseAsync(['node', 'version', '--json']);
        } finally {
            process.stdout.write = originalWrite;
        }
        const output = chunks.join('');
        expect(output.trim().split('\n').length).toBe(1);
        const parsed = JSON.parse(output);
        expect(parsed.package).toBe('xtrm-tools');
        expect(parsed.runtime.node).toBeTypeOf('string');
    });

    it('human default emits multi-line block with package + node runtime', async () => {
        const chunks: string[] = [];
        const originalWrite = process.stdout.write.bind(process.stdout);
        // @ts-ignore
        process.stdout.write = (chunk: string) => {
            chunks.push(chunk);
            return true;
        };
        try {
            const cmd = createVersionCommand();
            await cmd.parseAsync(['node', 'version']);
        } finally {
            process.stdout.write = originalWrite;
        }
        const output = chunks.join('');
        expect(output).toMatch(/xtrm-tools/);
        expect(output).toMatch(/node\s/);
        expect(output.split('\n').length).toBeGreaterThan(1);
        // The bundle line is the whole point of CORE-2754: a reader must be told whether the
        // binary is the code beside it. Asserting the JSON field alone left the human path
        // free to drop it, because the type still checks.
        expect(output).toMatch(/\bbundle:\s+(fresh|STALE|unknown) — /);
    });

    it('--check-updates prints 3 rows and mentions the cache file (mocked npm; no network)', async () => {
        const chunks: string[] = [];
        const originalWrite = process.stdout.write.bind(process.stdout);
        // @ts-ignore
        process.stdout.write = (chunk: string) => { chunks.push(chunk); return true; };
        try {
            const cmd = createVersionCommand();
            await cmd.parseAsync(['node', 'version', '--check-updates']);
        } finally {
            process.stdout.write = originalWrite;
        }
        const output = chunks.join('');
        for (const pkg of ['xtrm-tools', '@jaggerxtrm/xtmux', '@jaggerxtrm/specialists']) {
            expect(output).toContain(pkg);
        }
        expect(output).toContain('installed=0.11.2');
        expect(output).toContain('[stale]');
        expect(output).toContain('[unknown]');
        expect(output).toMatch(/cache:/);
    });

    it('--check-updates --json emits a structured envelope with a package for each xtrm dep', async () => {
        const chunks: string[] = [];
        const originalWrite = process.stdout.write.bind(process.stdout);
        // @ts-ignore
        process.stdout.write = (chunk: string) => { chunks.push(chunk); return true; };
        try {
            const cmd = createVersionCommand();
            await cmd.parseAsync(['node', 'version', '--check-updates', '--json']);
        } finally {
            process.stdout.write = originalWrite;
        }
        const parsed = JSON.parse(chunks.join(''));
        expect(Array.isArray(parsed.updates)).toBe(true);
        expect(parsed.updates.map((u: { package: string }) => u.package).sort()).toEqual(
            ['@jaggerxtrm/specialists', '@jaggerxtrm/xtmux', 'xtrm-tools'],
        );
        for (const row of parsed.updates) {
            expect(['ok', 'stale', 'unknown', 'not-installed']).toContain(row.state);
        }
        expect(typeof parsed.cache_file).toBe('string');
    });
});
