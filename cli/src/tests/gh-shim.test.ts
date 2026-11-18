// CORE-2528: the gh shim. Installation is exercised against temp directories;
// the runtime routing (review, merge, close) is asserted on the source text and
// executed end-to-end in scripts/__tests__/xtrm-review-gate.test.mjs style below.

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    GH_SHIM_FINGERPRINT,
    GH_SHIM_MARKER,
    defaultGhShimPath,
    findRealGh,
    ghShimSource,
    ghShimStatus,
    installGhShim,
} from '../core/gh-shim.js';
import {
    LINK_TAIL_MS,
    LINK_TIMEOUT_ENV_VAR,
    LINK_TIMEOUT_MAX_MS,
    LINK_TIMEOUT_MIN_MS,
    resolveLinkBudgetMs,
    resolveLinkCeilingMs,
} from '../core/gh-pr-link.js';

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

// CORE-2745: the shim owns the outer kill for one link, and the inner path owns
// the budget inside it. The numbers are inlined into the generated shim at install
// time, so these cases EXECUTE the generated shim's own linkTimeoutMs() (never the
// TypeScript twin) and hold it equal to the budget plus the tail.
describe('the link budget the shim embeds (CORE-2745)', () => {
    const REMOTE_CONFIG = JSON.stringify({ remote: 'ssh:dawid@159.195.49.110' });
    const localRead = () => {
        throw new Error('ENOENT: no substrate.json');
    };

    /**
     * Run the generated shim's linkTimeoutMs() with sb's config faked. The slice is
     * the shipped text, from the inlined constants to the next section, so this
     * never re-implements the function it checks.
     */
    function generatedLinkTimeoutMs(env: NodeJS.ProcessEnv, configText?: string): number {
        const source = ghShimSource(null);
        const from = source.indexOf('const LINK_TIMEOUT_ENV_VAR =');
        const to = source.indexOf('// CORE-2619: a marker');
        expect(from).toBeGreaterThan(-1);
        expect(to).toBeGreaterThan(from);
        const body = source.slice(from, to);
        const factory = new Function('process', 'fs', 'os', 'path', `${body}\nreturn linkTimeoutMs;`) as (
            ...args: unknown[]
        ) => () => number;
        const fakeFs = {
            readFileSync: (file: string) => {
                if (configText === undefined) throw new Error(`ENOENT: ${file}`);
                return configText;
            },
        };
        const fakeOs = { homedir: () => '/home/worker' };
        return factory({ env }, fakeFs, fakeOs, path)();
    }

    it('kills the link at the budget the inner path keeps, in both modes', () => {
        expect(generatedLinkTimeoutMs({})).toBe(resolveLinkBudgetMs({ env: {}, readFile: localRead }) + LINK_TAIL_MS);
        expect(generatedLinkTimeoutMs({}, REMOTE_CONFIG)).toBe(resolveLinkBudgetMs({ env: {}, readFile: () => REMOTE_CONFIG }) + LINK_TAIL_MS);
    });

    it('clamps and falls back exactly as the inner budget does', () => {
        const cases: { value: string; remote: boolean }[] = [
            { value: '999999', remote: false },
            { value: '999999', remote: true },
            { value: '1', remote: false },
            { value: '1', remote: true },
            { value: 'NaN', remote: false },
            { value: 'NaN', remote: true },
            { value: '0', remote: false },
            { value: '0', remote: true },
            { value: '', remote: false },
            { value: '', remote: true },
        ];
        for (const { value, remote } of cases) {
            const env = { [LINK_TIMEOUT_ENV_VAR]: value };
            const readFile = remote ? () => REMOTE_CONFIG : localRead;
            expect(generatedLinkTimeoutMs(env, remote ? REMOTE_CONFIG : undefined), `${value || 'empty'}/${remote ? 'remote' : 'local'}`)
                .toBe(resolveLinkBudgetMs({ env, readFile }) + LINK_TAIL_MS);
        }
        // The clamps are the documented ones, not merely equal to the twin.
        expect(generatedLinkTimeoutMs({ [LINK_TIMEOUT_ENV_VAR]: '999999' })).toBe(LINK_TIMEOUT_MAX_MS + LINK_TAIL_MS);
        expect(generatedLinkTimeoutMs({ [LINK_TIMEOUT_ENV_VAR]: '1' })).toBe(LINK_TIMEOUT_MIN_MS + LINK_TAIL_MS);
        expect(generatedLinkTimeoutMs({})).toBe(6000);
        expect(generatedLinkTimeoutMs({}, REMOTE_CONFIG)).toBe(19000);
    });

    // CORE-2745 pr-reviewer round (MEDIUM): the generated check runs the module's
    // own sbRemoteModeFrom source, so sb's precedence rows must land identically in
    // both, including the shapes sb refuses (`{}`, `[]`, `""`, a non-string).
    it('resolves sb\'s mode exactly as the module does, row by row', () => {
        const rows: { name: string; env: NodeJS.ProcessEnv; config?: string }[] = [
            { name: 'no setting', env: {} },
            { name: 'remote ssh spec', env: {}, config: REMOTE_CONFIG },
            { name: 'remote empty object', env: {}, config: JSON.stringify({ remote: {} }) },
            { name: 'remote empty array', env: {}, config: JSON.stringify({ remote: [] }) },
            { name: 'remote empty string', env: {}, config: JSON.stringify({ remote: '' }) },
            { name: 'remote number', env: {}, config: JSON.stringify({ remote: 5 }) },
            { name: 'remote object', env: {}, config: JSON.stringify({ remote: { host: 'h' } }) },
            { name: 'remote not a spec', env: {}, config: JSON.stringify({ remote: 'dawid@host' }) },
            { name: 'env alone', env: { SUBSTRATE_REMOTE: 'ssh:host' } },
            { name: 'env over an unusable file', env: { SUBSTRATE_REMOTE: 'ssh:host' }, config: JSON.stringify({ remote: {} }) },
            { name: 'SUBSTRATE_LOCAL_DB beats a remote file', env: { SUBSTRATE_LOCAL_DB: '/tmp/state.db' }, config: REMOTE_CONFIG },
            { name: 'SUBSTRATE_DB beats the env', env: { SUBSTRATE_DB: '/tmp/state.db', SUBSTRATE_REMOTE: 'ssh:host' } },
            {
                // sb's `??` quirk: a DEFINED-but-empty SUBSTRATE_DB masks the local
                // path AND is not itself a local store, so the file still decides.
                name: 'empty SUBSTRATE_DB masks SUBSTRATE_LOCAL_DB',
                env: { SUBSTRATE_DB: '', SUBSTRATE_LOCAL_DB: '/tmp/state.db' },
                config: REMOTE_CONFIG,
            },
        ];
        for (const row of rows) {
            const readFile = row.config === undefined ? localRead : () => row.config as string;
            expect(generatedLinkTimeoutMs(row.env, row.config), row.name)
                .toBe(resolveLinkBudgetMs({ env: row.env, readFile }) + LINK_TAIL_MS);
        }
        // And the two shapes the reviewer named read as LOCAL on both sides.
        expect(generatedLinkTimeoutMs({}, JSON.stringify({ remote: {} }))).toBe(6000);
        expect(generatedLinkTimeoutMs({}, JSON.stringify({ remote: [] }))).toBe(6000);
        expect(generatedLinkTimeoutMs({}, JSON.stringify({ remote: '' }))).toBe(6000);
        expect(generatedLinkTimeoutMs({}, JSON.stringify({ remote: 5 }))).toBe(6000);
        expect(generatedLinkTimeoutMs({ SUBSTRATE_REMOTE: 'ssh:host' })).toBe(19000);
        expect(generatedLinkTimeoutMs({ SUBSTRATE_LOCAL_DB: '/tmp/state.db' }, REMOTE_CONFIG)).toBe(6000);
    });

    it('the local kill stays the six seconds the shim has always allowed', () => {
        expect(resolveLinkCeilingMs({ env: {}, readFile: localRead })).toBe(6000);
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

    // CORE-2745 review F3: a shim installed by an earlier release must still be
    // recognised as a shim (so it is skipped when looking for the real gh), but it
    // is NOT current, so doctor reports it and `xt identity setup` rewrites it.
    // Before the bump a v1 shim kept its fixed 6000 ms link kill against an
    // 18000 ms inner budget, which is the failure this PR fixes.
    it('reports a v1 shim as installed but not current, and reinstalls it', () => {
        expect(installGhShim(deps()).ok).toBe(true);
        const file = path.join(shimDir, 'gh');
        const current = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, current.replace(GH_SHIM_FINGERPRINT, 'xtrm-gh-agent-shim v1'));

        expect(ghShimStatus(deps()).installed).toBe(true);
        expect(ghShimStatus(deps()).current).toBe(false);
        // Never mistaken for the real gh: the detection marker is version-free.
        expect(findRealGh(deps())).toBe(path.join(realBin, 'gh'));

        expect(installGhShim(deps()).ok).toBe(true);
        expect(ghShimStatus(deps()).current).toBe(true);
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

