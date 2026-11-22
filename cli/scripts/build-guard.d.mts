/**
 * Types for the build guard (CORE-2766). The guard itself stays a plain ESM `.mjs` because the
 * `prebuild`/`postbuild` hooks run it with `node` before and after tsup, without a transpile step.
 */
export declare const PREFIX: string;
export declare function realpathOrNull(p: string): string | null;
export declare function isInside(parent: string, child: string): boolean;
export declare function resolveNodeModules(pkgDir: string): { path: string; real: string } | null;
export declare function checkoutRoot(pkgDir: string): string;
export declare function prebuildRefusal(pkgDir: string): string | null;
export declare function postbuildRefusal(
    pkgDir: string,
    opts?: { checkout?: string; home?: string },
): string | null;
