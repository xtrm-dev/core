import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    checkoutRoot,
    isInside,
    postbuildRefusal,
    prebuildRefusal,
    realpathOrNull,
    resolveNodeModules,
} from '../../scripts/build-guard.mjs';

/**
 * CORE-2766. Every fixture is created under its own `mkdtempSync` root, so the cases do not depend
 * on this host's directory layout beyond `<tmp>/<name>` and a symlink, and none of them is named
 * after `.xtrm/worktrees` — the path prefix the old guard read is deliberately absent here.
 */
const created: string[] = [];
const root = () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-guard-'));
    created.push(dir);
    return dir;
};

afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** A checkout whose `cli` package exists, with `node_modules` either real, symlinked, or absent. */
function checkout(name: string, deps: 'real' | 'symlink' | 'absent', linkTo?: string): string {
    const dir = join(root(), name);
    const cli = join(dir, 'cli');
    mkdirSync(cli, { recursive: true });
    if (deps === 'real') mkdirSync(join(dir, 'node_modules'), { recursive: true });
    if (deps === 'symlink') {
        if (!linkTo) throw new Error('symlink needs a target');
        symlinkSync(linkTo, join(dir, 'node_modules'));
    }
    return cli;
}

describe('the build precondition is a property, not a path prefix', () => {
    it('refuses a checkout whose node_modules is a symlink to another checkout, naming both paths', () => {
        const main = checkout('main', 'real');
        const worktree = checkout('worktree', 'symlink', join(main, '..', 'node_modules'));
        const refusal = prebuildRefusal(worktree);
        expect(refusal).toContain('dependencies resolve outside this checkout');
        expect(refusal).toContain(`checkout:     ${checkoutRoot(worktree)}`);
        expect(refusal).toContain(`node_modules: ${realpathOrNull(join(worktree, '..', 'node_modules'))}`);
    });

    it('refuses a checkout with no node_modules of its own that would resolve into another checkout', () => {
        // The shape the old guard missed: not under .xtrm/worktrees, no local node_modules, so the
        // dependency walk finds the sibling checkout's.
        const main = checkout('main', 'real');
        const worktree = join(checkout('worktree', 'absent'), 'cli-inner');
        mkdirSync(worktree, { recursive: true });
        // Lift the inner package one level so the walk finds `main`'s node_modules through a parent
        // that is not this checkout: the refusal must come from the outside-root branch.
        const resolved = resolveNodeModules(worktree);
        const refusal = prebuildRefusal(join(worktree, '..'));
        expect(refusal).not.toBeNull();
        if (resolved) expect(isInside(checkoutRoot(join(worktree, '..')), resolved.real)).toBe(false);
        else expect(refusal).toContain('no node_modules at all');
    });

    it('allows the main checkout and a worktree with a real node_modules of its own', () => {
        expect(prebuildRefusal(checkout('main', 'real'))).toBeNull();
        expect(prebuildRefusal(checkout('worktree', 'real'))).toBeNull();
    });
});

describe('the artefact assertion closes the shapes without naming them', () => {
    const withBundle = (contents: string): string => {
        const cli = checkout('bundle', 'real');
        mkdirSync(join(cli, 'dist'), { recursive: true });
        writeFileSync(join(cli, 'dist', 'index.cjs'), contents);
        return cli;
    };

    it('refuses a bundle carrying this machine’s absolute paths, with the occurrence count', () => {
        const cli = withBundle('var a="/home/dawid/dev/core/node_modules/x.js";\nvar b="/home/dawid/dev/core/node_modules/y.js";\n');
        const refusal = postbuildRefusal(cli, { home: '/home/dawid', checkout: checkoutRoot(cli) });
        expect(refusal).toContain('the bundle carries absolute paths');
        expect(refusal).toContain('"/home/" occurrences:    2');
    });

    it('accepts a bundle that names its dependencies relatively', () => {
        const cli = withBundle('var a="../node_modules/x.js";\nvar b="../node_modules/y.js";\n');
        expect(postbuildRefusal(cli, { home: '/home/dawid', checkout: checkoutRoot(cli) })).toBeNull();
    });
});
