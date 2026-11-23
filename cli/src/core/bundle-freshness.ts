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

export interface FreshnessInput {
    /** The `cli/` directory: bundle at `dist/index.cjs`, sources under `src/`. */
    cliRoot: string;
    bundleRelPath?: string;
    sourceRelDir?: string;
    /** Injectable for tests; defaults to a recursive walk of `sourceRelDir`. */
    listSource?: (sourceDir: string) => SourceFile[];
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
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
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
    if (newestSource.mtime <= builtAt) {
        return {
            state: 'fresh',
            bundle: bundlePath,
            builtAt,
            newestSource,
            lagMs: null,
            detail: `the bundle is newer than the newest source (${newestSource.path})`,
        };
    }

    const lagMs = newestSource.mtime - builtAt;
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

/** One line for `xt --version` / `xt doctor`. */
export function formatBundleFreshness(freshness: BundleFreshness): string {
    if (freshness.state === 'fresh') return `fresh — ${freshness.detail}`;
    if (freshness.state === 'stale') return `STALE — ${freshness.detail}`;
    return `unknown — ${freshness.detail}`;
}
