// Runtime compatibility preflight (audit P1-06).
//
// docs/runtime-compatibility.json declares the Specialists / xtmux / node
// window Core is built against. scripts/check-runtime-compatibility.mjs
// validates that file at build time; Suite A asserts packed artifacts against
// it. Neither of those helps an operator whose *installed* trio has drifted —
// they find out when a launched coordinator misbehaves, with a worktree and a
// branch already on disk.
//
// This module closes that: `xt claude` / `xt pi` reject an incompatible
// combination BEFORE creating the interactive worktree. It is deliberately NOT
// consulted at CLI startup — `xt update`, `xt doctor` and friends must keep
// working precisely so an operator can repair a drifted install.
//
// Absence is never an incompatibility. A sibling that is not installed, a
// binary that resolves to no package.json, or a missing contract file all mean
// "nothing to check" — only a version that is present AND outside the declared
// range is a rejection. Set XTRM_SKIP_RUNTIME_COMPAT=1 to override.

import { existsSync, readFileSync, realpathSync } from 'fs';
import path from 'path';

declare const __dirname: string;

export interface RuntimeRequirements {
    specialists: string;
    xtmux: string;
    node: string;
}

export interface RuntimeVersions {
    requires: RuntimeRequirements;
    specialists: string | null;
    xtmux: string | null;
    node: string;
}

export type CompatResult = { ok: true } | { ok: false; error: string };

/** Binary name → the npm package whose version it reports. */
const SIBLINGS: ReadonlyArray<{ bin: string; pkg: string; key: 'specialists' | 'xtmux' }> = [
    { bin: 'specialists', pkg: '@jaggerxtrm/specialists', key: 'specialists' },
    { bin: 'xtmux', pkg: '@jaggerxtrm/xtmux', key: 'xtmux' },
];

const parse = (v: string): number[] => v.replace(/^[v^~]/, '').split('.').map((n) => parseInt(n, 10) || 0);
const cmp = (a: number[], b: number[]): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// ponytail: understands the space-separated comparator form the contract
// actually uses (">=3.21.0 <5", ">=24.0.0"). If it ever grows caret/OR ranges,
// swap this for the `semver` package. Same comparator as Suite A's.
export function satisfies(version: string, range: string): boolean {
    const v = parse(version);
    return range.trim().split(/\s+/).every((clause) => {
        const m = clause.match(/^(>=|<=|>|<|=)?(.+)$/);
        if (!m) return false;
        const c = cmp(v, parse(m[2]));
        switch (m[1]) {
            case '>=': return c >= 0;
            case '<=': return c <= 0;
            case '>': return c > 0;
            case '<': return c < 0;
            default: return c === 0;
        }
    });
}

/**
 * Read `core.requires` out of the shipped contract.
 *
 * Resolved relative to this module so it works from both layouts: the packed
 * install (`<pkg>/cli/dist/index.cjs`) and the source tree (`cli/src/core/`).
 * Returns null when the file is absent or malformed — an unreadable contract
 * must not block a launch.
 */
export function loadRuntimeRequirements(): RuntimeRequirements | null {
    const roots = [
        path.resolve(__dirname, '../..'),
        path.resolve(__dirname, '../../..'),
        path.resolve(__dirname, '../../../..'),
    ];
    for (const root of roots) {
        const file = path.join(root, 'docs', 'runtime-compatibility.json');
        if (!existsSync(file)) continue;
        try {
            const requires = JSON.parse(readFileSync(file, 'utf8'))?.core?.requires;
            if (requires?.specialists && requires?.xtmux && requires?.node) return requires;
        } catch {
            // Malformed contract: treat as absent rather than failing the launch.
        }
        return null;
    }
    return null;
}

/**
 * Version of the npm package backing `bin`, by walking up from the resolved
 * binary to its nearest package.json. No subprocess: `xtmux` has no --version
 * flag at all, and spawning two CLIs on every launch to learn what a
 * package.json already states is pure latency.
 */
export function resolveInstalledVersion(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
    for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `bin` is one of two module-local literals and `dir` is a PATH entry; anyone who controls this process's PATH already has code execution.
        const candidate = path.join(dir, bin);
        if (!existsSync(candidate)) continue;
        let cursor: string;
        try {
            cursor = path.dirname(realpathSync(candidate));
        } catch {
            return null;
        }
        // Bounded walk: <pkg>/bin/x, <pkg>/dist/cli.js and <pkg>/src/a/b/c.ts
        // are all within reach; anything deeper is not a package layout.
        for (let i = 0; i < 6; i++) {
            // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `cursor` is a realpath-resolved ancestor of an on-PATH binary and the leaf is a constant.
            const pkgJson = path.join(cursor, 'package.json');
            if (existsSync(pkgJson)) {
                try {
                    const version = JSON.parse(readFileSync(pkgJson, 'utf8'))?.version;
                    return typeof version === 'string' ? version : null;
                } catch {
                    return null;
                }
            }
            const parent = path.dirname(cursor);
            if (parent === cursor) break;
            cursor = parent;
        }
        return null;
    }
    return null;
}

/** Pure decision: which installed version, if any, is outside its declared range. */
export function checkRuntimeCompatibility(input: RuntimeVersions): CompatResult {
    const { requires } = input;
    const violations: string[] = [];

    for (const { pkg, key } of SIBLINGS) {
        const installed = input[key];
        if (!installed) continue; // not installed / not resolvable — nothing to check
        if (!satisfies(installed, requires[key])) {
            violations.push(`${pkg} ${installed} does not satisfy Core's requirement "${requires[key]}"`);
        }
    }
    if (!satisfies(input.node, requires.node)) {
        violations.push(`node ${input.node} does not satisfy Core's requirement "${requires.node}"`);
    }

    if (violations.length === 0) return { ok: true };
    return {
        ok: false,
        error: `Incompatible runtime combination:\n${violations.map((v) => `    • ${v}`).join('\n')}`,
    };
}

/**
 * The launcher-facing entry point: returns an error string when the installed
 * trio is incompatible, null when it is fine or unknowable.
 */
export function runtimeCompatibilityError(env: NodeJS.ProcessEnv = process.env): string | null {
    if (env.XTRM_SKIP_RUNTIME_COMPAT === '1') return null;
    const requires = loadRuntimeRequirements();
    if (!requires) return null;

    const result = checkRuntimeCompatibility({
        requires,
        specialists: resolveInstalledVersion('specialists', env),
        xtmux: resolveInstalledVersion('xtmux', env),
        node: process.version,
    });
    return result.ok ? null : result.error;
}
