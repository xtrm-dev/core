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

        it('excludes the packages the operator removed from the managed set', () => {
            for (const pkg of ['npm:@robhowley/pi-structured-return', 'git:github.com/DietrichGebert/ponytail', 'npm:pi-mermaid-viewer']) {
                expect(schema.packages).not.toContain(pkg);
            }
        });

        it('contains all expected canonical packages and excludes retired Serena tooling', () => {
            const expected = [
                'npm:pi-gitnexus',
                'npm:pi-ast-grep',
                'npm:@parcha/agentrun-pi@beta',
                'npm:billion-context',
                'npm:@jaggerxtrm/substrate',
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
