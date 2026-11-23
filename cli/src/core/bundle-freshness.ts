import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

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
 * Git decides when it can answer, because a checkout writes `dist/` and `src/` in an
 * order that says nothing about edits: CORE-2774 measured a 124 ms "lag" on a tree
 * where a rebuild was byte-identical. The rules, in order:
 *
 *  1. An uncommitted change under the source directory (modified, deleted or
 *     untracked, as `git status` lists it) is a real edit: stale. The commit
 *     comparison below describes committed history and cannot see it.
 *  2. A complete clone compares the last commit that touched the sources, over the
 *     whole directory, with the last commit that touched the bundle, by ancestry
 *     (`git merge-base --is-ancestor`), never by committer timestamp.
 *  3. A shallow clone, a tree with no git, a bundle that is itself modified, or any
 *     git answer that fails falls back to the mtime rule, which can say `stale` or
 *     decline with `unknown` and never says `fresh` on a checkout-order difference.
 */
export interface CommitStamp {
    sha: string;
    at: number;
}

/** The questions the verdict asks git. `null` always means "git could not answer". */
export interface GitView {
    /** `git rev-parse --is-shallow-repository`. */
    isShallow(): boolean | null;
    /** Paths `git status` lists under `pathspec`, relative to the cli root. */
    changedPaths(pathspec: string): string[] | null;
    /** Last commit touching any of the pathspecs, over the whole tree they select. */
    lastCommit(pathspecs: string[]): CommitStamp | null;
    /** `git merge-base --is-ancestor`: true when `ancestor` is reachable from `descendant`. */
    isAncestor(ancestor: string, descendant: string): boolean | null;
}

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
    /** Injectable for tests; defaults to git run inside `cliRoot`. */
    git?: GitView;
}

const SKIP_DIRS = new Set(['tests', '__tests__', 'test', 'node_modules', '.git', 'dist', 'coverage']);
const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|cts)$/;

/** True when a path (any separator depth) is a source file that ships in the bundle. */
function isBundledSource(path: string): boolean {
    const segments = path.split(/[\\/]/);
    const name = segments[segments.length - 1] ?? '';
    if (!SOURCE_EXT.test(name) || TEST_FILE.test(name)) return false;
    return !segments.slice(0, -1).some((dir) => SKIP_DIRS.has(dir));
}

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
        if (!isBundledSource(name)) continue;
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
    const git = input.git ?? realGit(input.cliRoot);
    const rebuild = 'run `cd cli && npm run build` before trusting a proof that runs `cli/dist/index.cjs`';

    // Rule 1: an uncommitted edit is a real edit, whatever the commits say.
    const edited = (git.changedPaths(sourceRelDir) ?? []).filter(isBundledSource);
    if (edited.length > 0) {
        const first = edited[0] as string;
        const mtime = fileMtime(resolve(input.cliRoot, first));
        return {
            state: 'stale',
            bundle: bundlePath,
            builtAt,
            newestSource: { path: first, mtime: mtime ?? builtAt },
            lagMs: mtime === null ? 0 : Math.max(0, mtime - builtAt),
            detail:
                `${first} has an uncommitted change${edited.length > 1 ? ` (and ${edited.length - 1} more)` : ''}, ` +
                `so the bundle is not the code beside it — ${rebuild}`,
        };
    }

    // Rule 2: a complete history decides by ancestry over the whole source directory.
    const verdict = commitVerdict(git, bundleRelPath, sourceRelDir, {
        bundlePath,
        builtAt,
        newestSource,
        rebuild,
    });
    if (verdict !== null) return verdict;

    // Rule 3: the conservative mtime rule.
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
    if (lagMs < CHECKOUT_WRITE_WINDOW_MS) {
        return {
            state: 'unknown',
            bundle: bundlePath,
            builtAt,
            newestSource,
            lagMs,
            detail:
                `cannot tell: the bundle is ${humanLag(lagMs)} older than ${newestSource.path}, which is the order a ` +
                'checkout writes them in, and git cannot answer here (no history, or a shallow clone) — ' +
                'run `cd cli && npm run build` if in doubt',
        };
    }
    return {
        state: 'stale',
        bundle: bundlePath,
        builtAt,
        newestSource,
        lagMs,
        detail:
            `the bundle is ${humanLag(lagMs)} older than ${newestSource.path}, so it is not the code beside it — ${rebuild}`,
    };
}

function fileMtime(abs: string): number | null {
    try {
        return statSync(abs).mtimeMs;
    } catch {
        return null;
    }
}

/** Pathspecs selecting what ships in the bundle: sources, minus tests and build output. */
export function bundledSourcePathspecs(sourceRelDir: string): string[] {
    const dir = sourceRelDir.split(sep).join('/');
    return [
        ...['ts', 'tsx', 'mts', 'cts'].map((ext) => `:(glob)${dir}/**/*.${ext}`),
        ...[...SKIP_DIRS].map((skip) => `:(exclude,glob)${dir}/**/${skip}/**`),
        ...['ts', 'tsx', 'mts', 'cts'].flatMap((ext) => [
            `:(exclude,glob)${dir}/**/*.test.${ext}`,
            `:(exclude,glob)${dir}/**/*.spec.${ext}`,
        ]),
    ];
}

interface VerdictContext {
    bundlePath: string;
    builtAt: number;
    newestSource: SourceFile;
    rebuild: string;
}

/** The ancestry verdict, or null when git cannot give one and the mtime rule must decide. */
function commitVerdict(
    git: GitView,
    bundleRelPath: string,
    sourceRelDir: string,
    ctx: VerdictContext,
): BundleFreshness | null {
    if (git.isShallow() !== false) return null;
    // A bundle rebuilt and not yet committed has a last commit that describes an older file.
    const bundleChanges = git.changedPaths(bundleRelPath);
    if (bundleChanges === null || bundleChanges.length > 0) return null;

    const bundleCommit = git.lastCommit([bundleRelPath]);
    const sourceCommit = git.lastCommit(bundledSourcePathspecs(sourceRelDir));
    if (bundleCommit === null || sourceCommit === null) return null;

    const base = { bundle: ctx.bundlePath, builtAt: ctx.builtAt, newestSource: ctx.newestSource };
    if (bundleCommit.sha === sourceCommit.sha) {
        return {
            state: 'fresh',
            ...base,
            lagMs: null,
            detail:
                `the bundle and ${sourceRelDir} were last written by the same commit ${bundleCommit.sha.slice(0, 12)}, ` +
                'so an mtime difference is checkout order and not staleness',
        };
    }
    const sourceBeforeBundle = git.isAncestor(sourceCommit.sha, bundleCommit.sha);
    if (sourceBeforeBundle === null) return null;
    if (sourceBeforeBundle) {
        return {
            state: 'fresh',
            ...base,
            lagMs: null,
            detail:
                `the bundle was written by ${bundleCommit.sha.slice(0, 12)}, which contains the commit that last changed ` +
                `${sourceRelDir} (${sourceCommit.sha.slice(0, 12)})`,
        };
    }
    return {
        state: 'stale',
        ...base,
        lagMs: Math.max(0, sourceCommit.at - bundleCommit.at),
        detail:
            `${sourceRelDir} changed in ${sourceCommit.sha.slice(0, 12)}, which the commit that wrote the bundle ` +
            `(${bundleCommit.sha.slice(0, 12)}) does not contain, so the bundle is not the code beside it — ${ctx.rebuild}`,
    };
}

function runGit(cliRoot: string, args: string[]): { status: number | null; stdout: string } {
    // A hook or an outer `git` call exports GIT_DIR and friends; they would aim `-C` at the wrong repository.
    const env = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete env[key];
    const result = spawnSync('git', ['-C', cliRoot, ...args], { encoding: 'utf8', env });
    return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
}

/** Git, read from the tree the bundle lives in. */
export function realGit(cliRoot: string): GitView {
    return {
        isShallow() {
            const r = runGit(cliRoot, ['rev-parse', '--is-shallow-repository']);
            if (r.status !== 0) return null;
            const answer = r.stdout.trim();
            return answer === 'true' ? true : answer === 'false' ? false : null;
        },
        changedPaths(pathspec) {
            const prefix = runGit(cliRoot, ['rev-parse', '--show-prefix']);
            if (prefix.status !== 0) return null;
            const r = runGit(cliRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--', pathspec]);
            if (r.status !== 0) return null;
            const root = prefix.stdout.trim();
            const entries = r.stdout.split('\0').filter((entry) => entry.length > 0);
            const out: string[] = [];
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i] as string;
                const path = entry.slice(3);
                out.push(root && path.startsWith(root) ? path.slice(root.length) : path);
                // A rename or copy carries its origin as the next entry, with no status prefix.
                if (/^[RC]/.test(entry) || /^.[RC]/.test(entry)) {
                    const origin = entries[++i];
                    if (origin !== undefined) out.push(root && origin.startsWith(root) ? origin.slice(root.length) : origin);
                }
            }
            return out;
        },
        lastCommit(pathspecs) {
            const r = runGit(cliRoot, ['log', '-1', '--format=%H%x20%ct', '--', ...pathspecs]);
            if (r.status !== 0) return null;
            const [sha, seconds] = r.stdout.trim().split(/\s+/);
            if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return null;
            const at = Number(seconds);
            return Number.isFinite(at) ? { sha, at: at * 1000 } : null;
        },
        isAncestor(ancestor, descendant) {
            const r = runGit(cliRoot, ['merge-base', '--is-ancestor', ancestor, descendant]);
            if (r.status === 0) return true;
            return r.status === 1 ? false : null;
        },
    };
}

/** One line for `xt --version` / `xt doctor`. */
export function formatBundleFreshness(freshness: BundleFreshness): string {
    if (freshness.state === 'fresh') return `fresh — ${freshness.detail}`;
    if (freshness.state === 'stale') return `STALE — ${freshness.detail}`;
    return `unknown — ${freshness.detail}`;
}
