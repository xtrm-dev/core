/**
 * Parsing of a `gh` argument list, shared by the `gh` shim, the review gate hook
 * and `xt identity` (CORE-2530 review).
 *
 * One parser, one set of flag tables: the shim and the hook reach this module
 * through `xt identity resolve-gh` / `xt identity merge-check --gh-args`, so the
 * PR a hook checks is by construction the PR the shim merges.
 */

export type GhVerb = 'merge' | 'review' | 'edit' | 'close' | 'ready' | 'reopen' | string;

/** Flags whose NEXT argument is a value, per verb (gh's own short flags differ). */
const MERGE_VALUE_FLAGS = ['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '-R', '--repo', '--match-head-commit'];
const REVIEW_VALUE_FLAGS = ['-b', '--body', '-F', '--body-file', '-R', '--repo'];
const EDIT_VALUE_FLAGS = ['-b', '--body', '-t', '--title', '-B', '--base', '-R', '--repo', '--add-label', '--remove-label', '--add-assignee', '--add-reviewer', '--milestone'];

export function valueFlags(verb: GhVerb): string[] {
    if (verb === 'review') return REVIEW_VALUE_FLAGS;
    if (verb === 'edit') return EDIT_VALUE_FLAGS;
    return MERGE_VALUE_FLAGS;
}

export interface GhInvocation {
    verb: GhVerb | null;
    /** Index of the verb in the argv array, -1 when there is none. */
    index: number;
    repo: string;
}

/** Leading `VAR=value` assignments of a simple command (`X=1 gh pr merge 5`). */
export function splitAssignments(argv: string[]): { assignments: Record<string, string>; rest: string[] } {
    const assignments: Record<string, string> = {};
    let index = 0;
    while (index < argv.length) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[index]);
        if (!match) break;
        assignments[match[1]] = match[2];
        index += 1;
    }
    return { assignments, rest: argv.slice(index) };
}

function skipGlobalFlag(args: string[], index: number, repo: { value: string }): number {
    const arg = args[index];
    if (arg === '-R' || arg === '--repo') {
        if (args[index + 1] !== undefined) repo.value = args[index + 1];
        return 2;
    }
    if (arg.indexOf('--repo=') === 0) { repo.value = arg.slice('--repo='.length); return 1; }
    if (arg.indexOf('-R=') === 0) { repo.value = arg.slice('-R='.length); return 1; }
    if (arg.indexOf('-R') === 0 && arg.length > 2) { repo.value = arg.slice(2); return 1; }
    return 0;
}

/**
 * Find the `pr` verb, skipping root-level global flags before `pr` and more of
 * them after it: `gh -R o/r pr merge 5` and `gh pr --repo=o/r merge 5`.
 */
export function findVerb(args: string[]): GhInvocation {
    const repo = { value: '' };
    let index = 0;
    let sawPr = false;
    while (index < args.length) {
        const skip = skipGlobalFlag(args, index, repo);
        if (skip) { index += skip; continue; }
        const arg = args[index];
        if (arg === 'pr') { sawPr = true; index += 1; break; }
        if (arg.charAt(0) === '-') { index += 1; continue; }
        return { verb: null, index: -1, repo: repo.value };
    }
    if (!sawPr) return { verb: null, index: -1, repo: repo.value };
    while (index < args.length) {
        const skip = skipGlobalFlag(args, index, repo);
        if (skip) { index += skip; continue; }
        const arg = args[index];
        if (arg.charAt(0) === '-') { index += 1; continue; }
        return { verb: arg, index, repo: repo.value };
    }
    return { verb: null, index: -1, repo: repo.value };
}

/**
 * Split a gh verb's arguments into its repository, its positional target and the
 * remaining arguments. The target is the first bare word: a number, a URL or a
 * branch name. The repository may be `--repo o/r`, `--repo=o/r`, `-R o/r` or `-Ro/r`.
 */
export function parseGhArgs(args: string[], verb: GhVerb): { repo: string; target: string; forwarded: string[] } {
    const values = valueFlags(verb);
    const repo = { value: '' };
    const kept: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const skip = skipGlobalFlag(args, index, repo);
        if (skip) { index += skip - 1; continue; }
        kept.push(args[index]);
    }
    let target = '';
    const forwarded: string[] = [];
    for (let index = 0; index < kept.length; index += 1) {
        const arg = kept[index];
        if (arg === '--') { forwarded.push(...kept.slice(index + 1)); break; }
        if (arg.charAt(0) === '-') {
            forwarded.push(arg);
            if (values.includes(arg) && index + 1 < kept.length) {
                forwarded.push(kept[index + 1]);
                index += 1;
            }
            continue;
        }
        if (!target) target = arg;
        else forwarded.push(arg);
    }
    return { repo: repo.value, target, forwarded };
}

/** gh's review short flags, translated to the long options `xt identity review-post` defines. */
export function translateReviewFlags(args: string[]): string[] {
    const map: Record<string, string> = { '-a': '--approve', '-c': '--comment', '-r': '--request-changes', '-b': '--body', '-F': '--body-file' };
    const takesValue = ['-b', '-F', '--body', '--body-file'];
    const out: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (takesValue.includes(arg)) {
            // The next token is a VALUE, never a flag (--body -c means body "-c").
            out.push(map[arg] ?? arg);
            if (index + 1 < args.length) { out.push(args[index + 1]); index += 1; }
            continue;
        }
        if (arg.indexOf('--body=') === 0 || arg.indexOf('--body-file=') === 0) { out.push(arg); continue; }
        out.push(map[arg] ?? arg);
    }
    return out;
}

export function targetPr(target: string): number {
    if (!target) return 0;
    const url = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(target);
    if (url) return Number(url[1]);
    return /^\d+$/.test(target) ? Number(target) : 0;
}

export function repoFromUrl(target: string): { repo: string; pr: number } | null {
    const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(target ?? '');
    return match ? { repo: `${match[1]}/${match[2]}`, pr: Number(match[3]) } : null;
}

export interface ResolvedInvocation {
    verb: GhVerb | null;
    repo: string;
    pr: number;
    target: string;
    forwarded: string[];
    assignments: Record<string, string>;
}

/**
 * Static resolution of a gh argv. A branch target needs a repository (the caller
 * supplies it or the branch is looked up there); a missing target falls back to
 * the caller's cwd PR, exactly like gh itself.
 */
export function parseInvocation(argv: string[], options: { fallbackVerb?: GhVerb } = {}): ResolvedInvocation {
    const { assignments, rest } = splitAssignments(argv);
    const found = findVerb(rest);
    const verb = found.verb ?? options.fallbackVerb ?? null;
    if (!found.verb) {
        return { verb, repo: found.repo, pr: 0, target: '', forwarded: rest.slice(1), assignments };
    }
    const parsed = parseGhArgs(rest.slice(found.index + 1), found.verb);
    const fromUrl = repoFromUrl(parsed.target);
    const repo = parsed.repo || found.repo || fromUrl?.repo || '';
    const pr = fromUrl ? fromUrl.pr : targetPr(parsed.target);
    const forwarded = found.verb === 'review' ? translateReviewFlags(parsed.forwarded) : parsed.forwarded;
    return { verb, repo, pr, target: parsed.target, forwarded, assignments };
}
