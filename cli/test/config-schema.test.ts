import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

describe('config schema integrity', () => {
    describe('cli/package.json bin field (in5e)', () => {
        const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));

        it('has xtrm bin entry pointing to dist/index.cjs', () => {
            expect(pkg.bin?.xtrm).toBe('dist/index.cjs');
        });

        it('has xt bin entry pointing to dist/index.cjs', () => {
            expect(pkg.bin?.xt).toBe('dist/index.cjs');
        });

        it('both bin entries point to the same file', () => {
            expect(pkg.bin?.xt).toBe(pkg.bin?.xtrm);
        });
    });

    describe('config/pi/install-schema.json packages (m54d, x87v)', () => {
        const schema = JSON.parse(readFileSync(resolve(ROOT, 'config', 'pi', 'install-schema.json'), 'utf8'));

        it('contains npm:@robhowley/pi-structured-return', () => {
            expect(schema.packages).toContain('npm:@robhowley/pi-structured-return');
        });

        it('contains all expected canonical packages and excludes retired Serena tooling', () => {
            const expected = [
                'npm:pi-gitnexus',
                'npm:@robhowley/pi-structured-return',
                'npm:pi-background-tasks@latest',
            ];
            for (const pkg of expected) {
                expect(schema.packages).toContain(pkg);
            }
            expect(schema.packages).not.toContain('npm:pi-serena-tools');
        });

        it('packages is an array with no duplicates', () => {
            const unique = new Set(schema.packages);
            expect(unique.size).toBe(schema.packages.length);
        });
    });
});
