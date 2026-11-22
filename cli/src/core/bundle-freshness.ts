import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * A worktree carries the committed bundle and no build, so `node cli/dist/index.cjs`
 * there runs the code as it stood at the base commit. Nothing says which of the two
 * is running: the source refusal an author reads is not the refusal the binary
 * performs. CORE-2754 measured the cost — a stale bundle with no `PI_MODEL` fallback
 * posted a review nobody asked for.
 *
 * This answers the question directly: how old is the bundle, beside which source file.
 * It is a report, not a gate — nothing here refuses a run.
 */
export type BundleState = 'fresh' | 'stale' | 'unknown';

export interface SourceFile {
    path: string;
    mtime: number;
}

export interface BundleFreshness {
    state: BundleState;
    /** Absolute path of the bundle, when one exists. */
    bundle: string | null;
    builtAt: number | null;
    /** The newest source file, which is what the bundle is judged against. */
    newestSource: SourceFile | null;
    /** Milliseconds the bundle lags behind `newestSource`; null unless stale. */
    lagMs: number | null;
    /** One operator-facing sentence, whatever the state. */
    detail: string;
}

/**
 * When the bundle and the newest source came from the same commit, the mtime
 * order carries no information: a checkout writes `dist/` before it finishes
 * `src/`, so the bundle is routinely a few hundred milliseconds "older" and a
 * rebuild at that commit changes nothing. CORE-2774 measured 124 ms, reported
 * as `1s`, on a tree where the rebuild was byte-identical.
 */
export interface CommitStamp {
    sha: string;
    at: number;
}

/** Last commit touching one path, or null when this tree has no history for it. */
export type CommitLookup = (relPath: string) => CommitStamp | null;

/**
 * Below this, an mtime difference orders two writes inside one checkout rather
 * than two edits, so it cannot support a conclusion. It is used ONLY to decline
 * a claim (state `unknown`), never to manufacture one, and only when git cannot
 * answer — with history available the commit comparison decides.
 */
const CHECKOUT_WRITE_WINDOW_MS = 5_000;

export interface FreshnessInput {
    /** The `cli/` directory: bundle at `dist/index.cjs`, sources under `src/`. */
    cliRoot: string;
    bundleRelPath?: string;
    sourceRelDir?: string;
    /** Injectable for tests; defaults to a recursive walk of `sourceRelDir`. */
    listSource?: (sourceDir: string) => SourceFile[];
    /** Injectable for tests; defaults to `git log -1` inside `cliRoot`. */
    lastCommit?: CommitLookup;
}

const SKIP_DIRS = new Set(['tests', '__tests__', 'test', 'node_modules', '.git', 'dist', 'coverage']);
const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/;

/** Recursive walk of the CLI sources; tests are excluded because they ship in no bundle. */
export function listSourceFiles(root: string, rel = ''): SourceFile[] {
    const dir = rel ? join(root, rel) : root;
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }
    const out: SourceFile[] = [];
    for (const name of entries) {
        const relPath = rel ? join(rel, name) : name;
        const abs = join(root, relPath);
        let stats;
        try {
            stats = statSync(abs);
        } catch {
            continue;
        }
        if (stats.isDirectory()) {
            if (SKIP_DIRS.has(name)) continue;
            out.push(...listSourceFiles(root, relPath));
            continue;
        }
        if (!SOURCE_EXT.test(name)) continue;
        if (name.endsWith('.test.ts') || name.endsWith('.test.tsx') || name.endsWith('.spec.ts')) continue;
        out.push({ path: relPath, mtime: stats.mtimeMs });
    }
    return out;
}

function newest(files: SourceFile[]): SourceFile | null {
    let best: SourceFile | null = null;
    for (const file of files) if (best === null || file.mtime > best.mtime) best = file;
    return best;
}

function humanLag(ms: number): string {
    // A sub-second lag is reported in milliseconds: rounding 124 ms up to "1s"
    // is how a checkout artefact read as a real hour-scale staleness claim.
    if (ms < 1_000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
}

export function readBundleFreshness(input: FreshnessInput): BundleFreshness {
    const bundleRelPath = input.bundleRelPath ?? join('dist', 'index.cjs');
    const sourceRelDir = input.sourceRelDir ?? 'src';
    const bundlePath = resolve(input.cliRoot, bundleRelPath);
    const sourceDir = resolve(input.cliRoot, sourceRelDir);
    const list = input.listSource ?? listSourceFiles;

    let builtAt: number | null = null;
    try {
        if (existsSync(bundlePath)) builtAt = statSync(bundlePath).mtimeMs;
    } catch {
        builtAt = null;
    }

    // Paths in the report are relative to the cli root, so `src/commands/pi.ts`
    // reads as the file an operator can open from where they ran the command.
    const files = list(sourceDir).map((file) => ({
        path: input.listSource ? file.path : join(sourceRelDir, file.path),
        mtime: file.mtime,
    }));
    const newestSource = newest(files);

    if (builtAt === null) {
        return {
            state: 'unknown',
            bundle: existsSync(bundlePath) ? bundlePath : null,
            builtAt: null,
            newestSource,
            lagMs: null,
            detail: `no bundle at ${bundlePath} — nothing to compare, so this run is neither fresh nor stale`,
        };
    }
    if (newestSource === null) {
        return {
            state: 'unknown',
            bundle: bundlePath,
            builtAt,
            newestSource: null,
            lagMs: null,
            detail: `no sources under ${sourceDir} — an installed package carries the bundle only, so freshness cannot be judged here`,
        };
    }
    const lagMs = newestSource.mtime - builtAt;
    if (lagMs <= 0) {
        return {
            state: 'fresh',
            bundle: bundlePath,
            builtAt,
            newestSource,
            lagMs: null,
            detail: `the bundle is newer than the newest source (${newestSource.path})`,
        };
    }
    const lookup = input.lastCommit ?? gitLastCommit(input.cliRoot);
    const bundleCommit = lookup(bundleRelPath);
    const sourceCommit = lookup(newestSource.path);

    if (bundleCommit !== null && sourceCommit !== null) {
        if (bundleCommit.sha === sourceCommit.sha) {
            return {
                state: 'fresh',
                bundle: bundlePath,
                builtAt,
                newestSource,
                lagMs: null,
                detail:
                    `the bundle and ${newestSource.path} were both written by commit ${bundleCommit.sha.slice(0, 12)}, ` +
                    `so the ${humanLag(Math.max(0, lagMs))} mtime difference is checkout order and not staleness`,
            };
        }
        if (sourceCommit.at > bundleCommit.at) {
            return {
                state: 'stale',
                bundle: bundlePath,
                builtAt,
                newestSource,
                lagMs,
                detail:
                    `${newestSource.path} changed in ${sourceCommit.sha.slice(0, 12)}, after the commit that wrote the bundle ` +
                    `(${bundleCommit.sha.slice(0, 12)}), so the bundle is not the code beside it — ` +
                    'run `cd cli && npm run build` before trusting a proof that runs `cli/dist/index.cjs`',
            };
        }
        return {
            state: 'fresh',
            bundle: bundlePath,
            builtAt,
            newestSource,
            lagMs: null,
            detail:
                `the bundle was written by ${bundleCommit.sha.slice(0, 12)}, at or after the commit that last changed ` +
                `${newestSource.path} (${sourceCommit.sha.slice(0, 12)})`,
        };
    }

    if (lagMs >= 0 && lagMs < CHECKOUT_WRITE_WINDOW_MS) {
        return {
            state: 'unknown',
            bundle: bundlePath,
            builtAt,
            newestSource,
            lagMs,
            detail:
                `cannot tell: the bundle is ${humanLag(lagMs)} older than ${newestSource.path}, which is the order a ` +
                'checkout writes them in, and this tree has no history to compare — run `cd cli && npm run build` if in doubt',
        };
    }

    return {
        state: 'stale',
        bundle: bundlePath,
        builtAt,
        newestSource,
        lagMs,
        detail:
            `the bundle is ${humanLag(lagMs)} older than ${newestSource.path}, so it is not the code beside it — ` +
            'run `cd cli && npm run build` before trusting a proof that runs `cli/dist/index.cjs`',
    };
}

/** `git log -1` for one path, read from the tree the bundle lives in. */
export function gitLastCommit(cliRoot: string): CommitLookup {
    return (relPath: string) => {
        const result = spawnSync('git', ['-C', cliRoot, 'log', '-1', '--format=%H%x20%ct', '--', relPath], {
            encoding: 'utf8',
        });
        if (result.status !== 0 || typeof result.stdout !== 'string') return null;
        const [sha, seconds] = result.stdout.trim().split(/\s+/);
        if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return null;
        const at = Number(seconds);
        if (!Number.isFinite(at)) return null;
        return { sha, at: at * 1000 };
    };
}

/** One line for `xt --version` / `xt doctor`. */
export function formatBundleFreshness(freshness: BundleFreshness): string {
    if (freshness.state === 'fresh') return `fresh — ${freshness.detail}`;
    if (freshness.state === 'stale') return `STALE — ${freshness.detail}`;
    return `unknown — ${freshness.detail}`;
}
