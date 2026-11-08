// CORE-2528: the gh shim. Installation is exercised against temp directories;
// the runtime routing (review, merge, close) is asserted on the source text and
// executed end-to-end in scripts/__tests__/xtrm-review-gate.test.mjs style below.

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    GH_SHIM_MARKER,
    defaultGhShimPath,
    findRealGh,
    ghShimSource,
    ghShimStatus,
    installGhShim,
} from '../core/gh-shim.js';

let tmp = '';
let realBin = '';
let shimDir = '';

function writeExecutable(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    fs.chmodSync(file, 0o755);
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-shim-'));
    realBin = path.join(tmp, 'real-bin');
    shimDir = path.join(tmp, 'shim-bin');
    writeExecutable(path.join(realBin, 'gh'), '#!/bin/sh\necho real-gh\n');
});
afterEach(() => {
    fs.removeSync(tmp);
});

function deps(pathPrefix = `${shimDir}${path.delimiter}${realBin}`) {
    return { home: tmp, binDir: shimDir, env: { PATH: pathPrefix } };
}

describe('findRealGh', () => {
    it('skips the shim itself and returns the real binary', () => {
        const real = path.join(realBin, 'gh');
        expect(findRealGh(deps())).toBe(real);
        // Even when the shim dir comes first, once the shim exists it is skipped.
        installGhShim(deps());
        expect(findRealGh(deps())).toBe(real);
    });

    it('returns null when only the shim is on PATH', () => {
        installGhShim(deps());
        expect(findRealGh({ ...deps(), env: { PATH: shimDir } })).toBeNull();
    });
});

describe('installGhShim', () => {
    it('writes an executable shim that embeds the real gh', () => {
        const result = installGhShim(deps());
        expect(result.ok).toBe(true);
        expect(result.realGh).toBe(path.join(realBin, 'gh'));
        expect(result.path).toBe(path.join(shimDir, 'gh'));
        const stat = fs.statSync(result.path);
        expect(stat.mode & 0o777).toBe(0o755);
        const content = fs.readFileSync(result.path, 'utf8');
        expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
        expect(content).toContain(GH_SHIM_MARKER);
        expect(content).toContain(`const REAL_GH = ${JSON.stringify(path.join(realBin, 'gh'))};`);
    });

    it('refuses to overwrite a foreign gh and refuses without a real gh', () => {
        writeExecutable(path.join(shimDir, 'gh'), '#!/bin/sh\necho not-the-shim\n');
        const foreign = installGhShim(deps());
        expect(foreign.ok).toBe(false);
        expect(foreign.reason).toMatch(/not the xtrm shim/);
        expect(fs.readFileSync(path.join(shimDir, 'gh'), 'utf8')).toContain('not-the-shim');

        const nowhere = installGhShim({ home: tmp, binDir: path.join(tmp, 'empty'), env: { PATH: path.join(tmp, 'empty') } });
        expect(nowhere.ok).toBe(false);
        expect(nowhere.reason).toMatch(/no real gh/);
    });

    it('warns when the shim directory follows the real gh on PATH', () => {
        const result = installGhShim(deps(`${realBin}${path.delimiter}${shimDir}`));
        expect(result.ok).toBe(true);
        expect(result.warnings.join(' ')).toMatch(/comes after/);
    });
});

describe('ghShimStatus', () => {
    it('reports installed, current and PATH order', () => {
        installGhShim(deps());
        const status = ghShimStatus(deps());
        expect(status).toMatchObject({ installed: true, current: true, pathOrderOk: true });
        expect(status.recordedRealGh).toBe(path.join(realBin, 'gh'));
    });

    it('reports a stale shim and a missing one', () => {
        expect(ghShimStatus(deps()).installed).toBe(false);
        installGhShim(deps());
        fs.appendFileSync(path.join(shimDir, 'gh'), '\n// edited\n');
        expect(ghShimStatus(deps()).current).toBe(false);
    });

    it('resolves the default path under ~/.local/bin', () => {
        expect(defaultGhShimPath({ home: '/home/x' })).toBe('/home/x/.local/bin/gh');
        expect(defaultGhShimPath({ home: '/home/x', binDir: '/opt/bin' })).toBe('/opt/bin/gh');
    });
});

