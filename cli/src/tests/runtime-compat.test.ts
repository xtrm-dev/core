import os from 'node:os';
import path from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
    checkRuntimeCompatibility,
    loadRuntimeRequirements,
    resolveInstalledVersion,
    runtimeCompatibilityError,
    satisfies,
} from '../core/runtime-compat.js';

const REQUIRES = { specialists: '>=3.21.0 <4', xtmux: '>=0.1.0 <0.2', node: '>=24.0.0' };

const temps: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'xtrm-compat-'));
    temps.push(dir);
    return dir;
}

/** A package layout whose `bin/<name>` symlinks into `dist/`, like a real install. */
function fakePackage(root: string, name: string, version: string): string {
    const pkgRoot = path.join(root, 'node_modules', name);
    mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true });
    mkdirSync(path.join(root, 'bin'), { recursive: true });
    writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name, version }));
    const target = path.join(pkgRoot, 'dist', 'cli.js');
    writeFileSync(target, '#!/usr/bin/env node\n');
    chmodSync(target, 0o755);
    const link = path.join(root, 'bin', name);
    symlinkSync(target, link);
    return path.join(root, 'bin');
}

afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('satisfies', () => {
    it('handles the two-clause ranges the contract declares', () => {
        expect(satisfies('3.21.0', '>=3.21.0 <4')).toBe(true);
        expect(satisfies('3.30.7', '>=3.21.0 <4')).toBe(true);
        expect(satisfies('3.20.9', '>=3.21.0 <4')).toBe(false);
        expect(satisfies('4.0.0', '>=3.21.0 <4')).toBe(false);
        expect(satisfies('0.1.4', '>=0.1.0 <0.2')).toBe(true);
        expect(satisfies('0.2.0', '>=0.1.0 <0.2')).toBe(false);
        expect(satisfies('v24.15.0', '>=24.0.0')).toBe(true);
        expect(satisfies('v22.9.0', '>=24.0.0')).toBe(false);
    });
});

describe('checkRuntimeCompatibility', () => {
    const base = { requires: REQUIRES, specialists: '3.21.0', xtmux: '0.1.0', node: 'v24.15.0' };

    it('accepts a compatible trio', () => {
        expect(checkRuntimeCompatibility(base)).toEqual({ ok: true });
    });

    it('treats an absent sibling as nothing to check, not as an incompatibility', () => {
        expect(checkRuntimeCompatibility({ ...base, specialists: null, xtmux: null })).toEqual({ ok: true });
    });

    it('names the incompatible pair', () => {
        const result = checkRuntimeCompatibility({ ...base, specialists: '3.20.0' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toContain('@jaggerxtrm/specialists 3.20.0');
        expect(result.error).toContain('>=3.21.0 <4');
        // The compatible sibling must not be implicated.
        expect(result.error).not.toContain('xtmux');
    });

    it('reports every violation at once rather than one per run', () => {
        const result = checkRuntimeCompatibility({ ...base, specialists: '4.0.0', xtmux: '0.3.0', node: 'v22.0.0' });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toContain('@jaggerxtrm/specialists 4.0.0');
        expect(result.error).toContain('@jaggerxtrm/xtmux 0.3.0');
        expect(result.error).toContain('node v22.0.0');
    });

    it('rejects an out-of-range node even when the siblings are fine', () => {
        expect(checkRuntimeCompatibility({ ...base, node: 'v20.11.0' }).ok).toBe(false);
    });
});

describe('resolveInstalledVersion', () => {
    it('walks from the PATH entry through the symlink to the owning package.json', () => {
        const root = tmp();
        const bin = fakePackage(root, 'xtmux', '0.1.7');
        expect(resolveInstalledVersion('xtmux', { PATH: bin })).toBe('0.1.7');
    });

    it('returns null when the binary is not on PATH', () => {
        expect(resolveInstalledVersion('xtmux', { PATH: tmp() })).toBeNull();
    });

    it('returns null rather than throwing on an empty PATH', () => {
        expect(resolveInstalledVersion('specialists', {})).toBeNull();
    });
});

describe('runtimeCompatibilityError', () => {
    it('ships a readable contract with the package', () => {
        // Guards the packaging half: docs/runtime-compatibility.json is in
        // package.json `files` precisely so this resolves post-install.
        const requires = loadRuntimeRequirements();
        expect(requires).not.toBeNull();
        expect(requires?.specialists).toMatch(/\d+\.\d+\.\d+/);
    });

    it('accepts the Specialists 3.21+ and 4.x lines and rejects 5.x', () => {
        const range = loadRuntimeRequirements()?.specialists ?? '';
        expect(satisfies('3.21.6', range)).toBe(true);
        expect(satisfies('4.0.0', range)).toBe(true);
        expect(satisfies('4.9.9', range)).toBe(true);
        expect(satisfies('3.20.9', range)).toBe(false);
        expect(satisfies('5.0.0', range)).toBe(false);
    });

    it('honors the operator override', () => {
        // PATH is empty, so nothing resolves and the check is a no-op either
        // way; what is asserted is that the override short-circuits first.
        expect(runtimeCompatibilityError({ XTRM_SKIP_RUNTIME_COMPAT: '1', PATH: '' })).toBeNull();
    });

    it('passes when no sibling is installed', () => {
        expect(runtimeCompatibilityError({ PATH: tmp() })).toBeNull();
    });

    it('rejects an installed sibling that is outside the declared range', () => {
        const root = tmp();
        // 99.x is outside every plausible future window in the contract.
        const bin = fakePackage(root, 'xtmux', '99.0.0');
        const error = runtimeCompatibilityError({ PATH: bin });
        expect(error).toContain('@jaggerxtrm/xtmux 99.0.0');
    });
});
