/**
 * The one definition of "this build can be reproduced on a runner", used by the prebuild and
 * postbuild hooks and by `src/tests/build-guard.test.ts`.
 *
 * CORE-2766: the old guard read a path prefix (`cwd.includes('/.xtrm/worktrees/')`), so it let
 * through a worktree outside that directory and any checkout whose dependencies resolve outside
 * the project root. Both produce a bundle with absolute module paths, which is what the CI
 * "Verify dist is up to date" step rejects. The property, not the path, is the requirement: the
 * dependencies must resolve INSIDE the checkout being built, and the artefact must not carry the
 * paths of the machine that built it.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';

export const PREFIX = 'ERROR: refusing to build';

/** realpath of an existing path, or null when it does not exist. */
export function realpathOrNull(p) {
    try {
        return realpathSync(p);
    } catch {
        return null;
    }
}

/** `child` is `parent` or below it. Symlink-free: both sides must already be realpaths. */
export function isInside(parent, child) {
    return child === parent || child.startsWith(parent + sep);
}

/**
 * The root a build actually resolves dependencies from: walk up from the package directory until
 * a `node_modules` exists. A worktree with none of its own resolves into the main checkout this
 * way, which is exactly the shape the old path-prefix guard missed when the worktree was not
 * under `.xtrm/worktrees/`.
 */
export function resolveNodeModules(pkgDir) {
    let dir = pkgDir;
    for (;;) {
        const candidate = join(dir, 'node_modules');
        const real = realpathOrNull(candidate);
        if (real && statSync(candidate).isDirectory()) return { path: candidate, real };
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/** The checkout a package belongs to, as a realpath: `<checkout>/cli` → `<checkout>`. */
export function checkoutRoot(pkgDir) {
    return realpathSync(dirname(pkgDir));
}

/**
 * Prebuild refusal, or null when the build may proceed. One sentence, both paths named, so the
 * reader can act without reading this file (CORE-2766 SCOPE: "pasteable as a remedy").
 */
export function prebuildRefusal(pkgDir) {
    const checkout = checkoutRoot(pkgDir);
    const resolved = resolveNodeModules(pkgDir);
    if (!resolved) {
        return `${PREFIX} — this checkout has no node_modules at all.\nThe dependencies must resolve inside ${checkout}.`;
    }
    if (isInside(checkout, resolved.real)) return null;
    return `${PREFIX} — dependencies resolve outside this checkout.\n  node_modules: ${resolved.real}\n  checkout:     ${checkout}\nA bundle built here embeds those absolute paths and fails the CI dist check.\nFix: install dependencies inside ${checkout} (npm ci at the root and in cli/), or build from the main checkout.`;
}

/**
 * Postbuild refusal, or null. The artefact assertion: a reproducible bundle names dependencies
 * relatively, so any absolute path of this machine in `dist/index.cjs` is a build that cannot be
 * reproduced. Counted, because the count is what distinguishes one stray string from the 932 that
 * shipped in core#974.
 */
export function postbuildRefusal(pkgDir, opts = {}) {
    const checkout = opts.checkout ?? checkoutRoot(pkgDir);
    const home = opts.home ?? homedir();
    const bundle = join(pkgDir, 'dist', 'index.cjs');
    let source;
    try {
        source = readFileSync(bundle, 'utf8');
    } catch {
        return `${PREFIX} — ${bundle} does not exist, so the bundle cannot be checked.`;
    }
    const counts = {
        home: count(source, home),
        checkout: count(source, checkout),
        absoluteHome: count(source, '/home/'),
    };
    if (counts.home === 0 && counts.checkout === 0 && counts.absoluteHome === 0) return null;
    return `${PREFIX} — the bundle carries absolute paths, so it is not reproducible.\n  ${bundle}\n  $HOME occurrences:       ${counts.home}\n  checkout occurrences:    ${counts.checkout}\n  "/home/" occurrences:    ${counts.absoluteHome}\nBuild with dependencies resolved inside ${checkout}; a symlinked node_modules produces these.`;
}

function count(haystack, needle) {
    if (!needle) return 0;
    let n = 0;
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n += 1;
    return n;
}

async function main() {
    const mode = process.argv[2];
    const pkgDir = process.cwd();
    if (mode === 'prebuild') {
        const refusal = prebuildRefusal(pkgDir);
        if (refusal) {
            console.error(refusal);
            process.exit(1);
        }
        return;
    }
    if (mode === 'postbuild') {
        const { writeFileSync } = await import('node:fs');
        const file = join(pkgDir, 'dist', 'index.cjs');
        const lines = readFileSync(file, 'utf8').split('\n');
        writeFileSync(file, lines.map((l) => l.replace(/[ \t]+$/, '')).join('\n'));
        const refusal = postbuildRefusal(pkgDir);
        if (refusal) {
            console.error(refusal);
            process.exit(1);
        }
        return;
    }
    console.error(`${PREFIX} — usage: node scripts/build-guard.mjs prebuild|postbuild`);
    process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('build-guard.mjs')) {
    await main();
}
