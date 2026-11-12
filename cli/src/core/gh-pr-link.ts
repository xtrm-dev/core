/**
 * CORE-2607: link a PR that `gh pr create` just opened to its Substrate Issue.
 *
 * The `gh` shim captures the create's output, forwards it byte for byte, and then
 * asks this module (through `xt identity pr-link`) to write the link. The whole
 * step is fail-open: every unresolved input warns once and skips, and the create's
 * exit code, stdout and stderr are the real gh's, never this module's.
 *
 * The Issue ref has two sources, in order (CORE-2607 decision 2, amended):
 *
 *   1. the hidden `<!-- xtrm issue=REF holder=… run=… -->` marker in `--body` or
 *      the file `--body-file` names, parsed by the same parser the merge guard
 *      uses, so a pasted or quoted marker does not count;
 *   2. `--title` and the current branch, read through the project prefixes that
 *      `sb project list --json` reports (`CORE-2611`), so a bare word that looks
 *      like a ref but belongs to no project is not a ref.
 *
 * Exactly one distinct ref proceeds. Two different refs, or none, warn and skip:
 * guessing would attach the PR to the wrong Issue, which the T1 artifact records
 * durably.
 *
 * The repository and number come from the URL gh printed, never from `--repo` or
 * the cwd (decision 3): `--repo` may name a different repository than the one the
 * PR landed in. The project comes from `resolveReceiptProject` (`sb-receipt.ts`),
 * so a `core` worktree that opens an `xtrm` PR still attaches with `--project`.
 *
 * Two verbs, each with its own allowlisted flags (sb 0.3 `FLAG_ALLOWLIST`):
 *
 *   T1 the outcome link:  sb provenance attach <ref> pr <owner/repo#n> --project <id>
 *   T2 the commit evidence: sb issue link pr <ref> --repo <owner/repo> --number <n>
 *                          [--commits-range <base>..<head> | --commit <head>] --project <id>
 *
 * `provenance attach` accepts only `--project`, `--receipt` and `--holder`; the
 * range belongs to `issue link pr`, which writes the T2 rows. T1 runs first and
 * T2 only after it: a failed T1 means the link is incomplete, and one warning is
 * the whole report.
 */

import { runReceipt, listProjects, resolveReceiptProject, withReceiptProject, type ReceiptProjectDeps, type SbProject } from './sb-receipt.js';
import { parseIssueMarker, parseIssueMarkers, markerRunVerdict } from './review-posting.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** One hermetic `sb provenance attach` may take at most this long. */
export const ATTACH_TIMEOUT_MS = 5_000;

/**
 * A Substrate Issue ref. Hierarchical refs (`XTRM-184.2.3`) are valid: the
 * merge guard's `isSafeIssueRef` is deliberately stricter because it journals a
 * decision, while an artifact attach accepts any ref `sb` knows.
 */
const ISSUE_REF = /^[A-Z][A-Z0-9]*-\d+(?:\.\d+)*$/;

/** A ref-shaped token anywhere in a text, with its prefix captured. Literal. */
const REF_SHAPED = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9]*)-(?:\d+(?:\.\d+)*)(?![A-Za-z0-9])/gi;

export interface CreatedPr {
    owner: string;
    repo: string;
    number: number;
    /** `owner/repo`, the form `sb provenance attach` stores. */
    slug: string;
    /** `owner/repo#n`, the canonical argument the verb takes. */
    canonical: string;
    url: string;
}

/**
 * The pull request URL in the captured `gh pr create` stdout.
 *
 * The LAST match wins: gh prints the created PR last, after any warnings or the
 * compare URL it suggests for a branch that is not pushed yet. The compare URL
 * (`…/pull/new/<branch>`) does not match, so a failed push cannot be mistaken for
 * a created PR.
 */
export function parseCreatedPrUrl(stdout: string | null | undefined): CreatedPr | null {
    const text = typeof stdout === 'string' ? stdout : '';
    let found: CreatedPr | null = null;
    const pattern = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
    for (const match of text.matchAll(pattern)) {
        const number = Number(match[3]);
        if (!Number.isInteger(number) || number <= 0) continue;
        const slug = `${match[1]}/${match[2]}`;
        found = { owner: match[1], repo: match[2], number, slug, canonical: `${slug}#${number}`, url: match[0] };
    }
    return found;
}

export interface CreateBody {
    /** The body text gh would send; empty when the flag is absent or unreadable. */
    text: string;
    /** Which flag supplied it, for the warning text. */
    source: 'body' | 'body-file' | 'none';
    file?: string;
}

/** The last value of `--flag value`, `--flag=value` or a short alias in an argv. */
function lastFlagValue(argv: string[], long: string, short?: string): string | null {
    let value: string | null = null;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg) continue;
        if (arg === long || (short && arg === short)) {
            // The next token is a VALUE, never a flag: `--body -x` means "-x".
            if (index + 1 < argv.length) value = argv[index + 1];
            index += 1;
            continue;
        }
        if (arg.startsWith(`${long}=`)) {
            value = arg.slice(long.length + 1);
        }
    }
    return typeof value === 'string' ? value : null;
}

/**
 * The body gh would send, from the literal `--body` value or the file named by
 * `--body-file`. A file that cannot be read is no marker (the title and branch
 * fallback runs), never an error: the shim must not turn a failed read into a
 * failed `gh pr create`.
 */
export function readCreateBody(
    argv: string[],
    readFile: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): CreateBody {
    const body = lastFlagValue(argv, '--body', '-b');
    const file = lastFlagValue(argv, '--body-file', '-F');
    // gh takes the last body flag it sees; keep that order rather than a fixed
    // precedence, so `--body-file f --body text` reads the text.
    const bodyAt = lastIndexOfFlag(argv, '--body', '-b');
    const fileAt = lastIndexOfFlag(argv, '--body-file', '-F');
    if (file !== null && fileAt > bodyAt) {
        if (file === '-') return { text: '', source: 'body-file', file };
        try {
            return { text: readFile(file), source: 'body-file', file };
        } catch {
            return { text: '', source: 'body-file', file };
        }
    }
    if (body !== null) return { text: body, source: 'body' };
    return { text: '', source: 'none' };
}

/**
 * The refusal for a create whose effective marker carries a tmux session id in
 * `run=`, or null. Read-only: the gh shim refuses before the pull request
 * exists, and the link step stays a warning (CORE-2619).
 *
 * The effective marker is the one the merge guard and the link both use — the
 * LAST marker carrying `issue=` outside a code fence — so a pasted or quoted
 * marker cannot decide this check.
 */
export function markerRunRefusal(
    argv: string[],
    readFile: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): string | null {
    const body = readCreateBody(argv, readFile);
    if (!body.text) return null;
    return markerRunVerdict(parseIssueMarker(body.text)?.run);
}

function lastIndexOfFlag(argv: string[], long: string, short?: string): number {
    let at = -1;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg) continue;
        if (arg === long || (short && arg === short) || arg.startsWith(`${long}=`)) at = index;
    }
    return at;
}

/** The `--title` value gh would send, or an empty string. */
export function readCreateTitle(argv: string[]): string {
    return lastFlagValue(argv, '--title', '-t') ?? '';
}

/**
 * Every ref-shaped token in a text whose prefix is one of the project prefixes.
 * Case-insensitive (a branch is usually `core-2607-…`), and the boundaries reject
 * a longer word: `CORE-2607` inside `XXCORE-2607` is not a ref.
 *
 * One literal pattern, filtered by the prefix set, rather than a pattern built
 * per prefix: a project prefix from `sb` never becomes regex syntax (a
 * non-literal RegExp is also the ReDoS shape semgrep refuses), and the scan
 * stays a single pass.
 */
export function issueRefsInText(text: string | null | undefined, projectPrefixes: string[]): string[] {
    const source = typeof text === 'string' ? text : '';
    const prefixes = new Set<string>();
    for (const raw of projectPrefixes) {
        const prefix = (raw ?? '').trim().toUpperCase();
        if (prefix) prefixes.add(prefix);
    }
    if (prefixes.size === 0) return [];
    const out: string[] = [];
    for (const match of source.matchAll(REF_SHAPED)) {
        const ref = match[0].toUpperCase();
        if (!prefixes.has(match[1].toUpperCase())) continue;
        if (!out.includes(ref)) out.push(ref);
    }
    return out;
}

export interface IssueRefChoice {
    ref: string | null;
    source: 'marker' | 'title' | 'branch' | 'title and branch' | null;
    /** Why the choice is null, as one clause the caller turns into a warning. */
    reason: string | null;
}

/**
 * Pick the one Issue ref the PR belongs to, or say why there is none.
 *
 * A marker that exists but is unusable (two different refs, or a value that is not
 * a ref) skips without falling back to the title: a wrong marker must not be
 * silently replaced by a heuristic.
 */
export function chooseIssueRef(input: {
    bodyText?: string | null;
    title?: string | null;
    branch?: string | null;
    projects: SbProject[];
}): IssueRefChoice {
    const markers: string[] = [];
    for (const marker of parseIssueMarkers(input.bodyText ?? '')) {
        const ref = (marker.issue ?? '').trim().toUpperCase();
        if (ref && !markers.includes(ref)) markers.push(ref);
    }
    if (markers.length > 1) {
        return { ref: null, source: null, reason: `the PR body names more than one Issue (${markers.join(', ')}); keep exactly one xtrm marker` };
    }
    if (markers.length === 1) {
        const ref = markers[0];
        if (!ISSUE_REF.test(ref)) {
            return { ref: null, source: null, reason: `the PR body's xtrm marker names '${ref}', which is not a Substrate Issue ref` };
        }
        return { ref, source: 'marker', reason: null };
    }
    const prefixes = input.projects.map((project) => project.prefix);
    const fromTitle = issueRefsInText(input.title, prefixes);
    const fromBranch = issueRefsInText(input.branch, prefixes);
    const all: string[] = [];
    for (const ref of [...fromTitle, ...fromBranch]) {
        if (!all.includes(ref)) all.push(ref);
    }
    if (all.length === 1) {
        const source = fromTitle.length && fromBranch.length ? 'title and branch' : fromTitle.length ? 'title' : 'branch';
        return { ref: all[0], source, reason: null };
    }
    if (all.length === 0) {
        return {
            ref: null,
            source: null,
            reason: 'the PR has no xtrm Issue marker in its body, and neither --title nor the current branch names a known project ref',
        };
    }
    return {
        ref: null,
        source: null,
        reason: `--title and the current branch name different Issues (${all.join(', ')}); keep one xtrm marker in the PR body`,
    };
}

export interface RunResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

export type RunGit = (args: string[], cwd: string) => RunResult;

export function defaultRunGit(): RunGit {
    return (args, cwd) => {
        const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd, timeout: ATTACH_TIMEOUT_MS });
        return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    };
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The head, and the base it forked from, for the `--commits-range` argument.
 *
 * The base order is the one the coordinator ruled: `origin/HEAD` (the remote's
 * default), then `origin/main`, then the branch's upstream. A merge-base of HEAD
 * against a ref that does not exist fails, so each candidate is tried in turn. No
 * base at all is not an error: the caller falls back to `--commit <HEAD>`, which
 * still records T1.
 */
export function resolveLinkRange(runGit: RunGit, cwd: string): { head: string; base: string | null } | null {
    const headResult = runGit(['rev-parse', 'HEAD'], cwd);
    const head = headResult.status === 0 ? headResult.stdout.trim() : '';
    if (!FULL_SHA.test(head)) return null;
    for (const upstream of ['origin/HEAD', 'origin/main', '@{upstream}']) {
        const merged = runGit(['merge-base', 'HEAD', upstream], cwd);
        const base = merged.status === 0 ? (merged.stdout.trim().split('\n')[0] ?? '').trim() : '';
        if (FULL_SHA.test(base)) return { head, base };
    }
    return { head, base: null };
}

export interface GhPrLinkDeps extends ReceiptProjectDeps {
    cwd?: string;
    readFile?: (file: string) => string;
    runGit?: RunGit;
    /** The receipt runner; tests inject a fake so no real store is touched. */
    runAttach?: (args: string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => { ok: boolean; error?: string; stdout?: string };
    /** The dispatch runner; defaults to the same runner as attach. */
    runDispatch?: (args: string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => { ok: boolean; error?: string; stdout?: string };
    /** The allocate runner; defaults to the same runner as attach. */
    runAllocate?: (args: string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => { ok: boolean; error?: string; stdout?: string };
}

export interface GhPrLinkResult {
    /** T1 landed: the PR is attached to the Issue with a `created_from` row. */
    attached: boolean;
    ref?: string;
    canonical?: string;
    /** The exact `sb provenance attach` argv (T1), for the golden test. */
    argv?: string[];
    /** The exact `sb issue link pr` argv (T2); absent when it could not run. */
    commitsArgv?: string[];
    /** One line, appended after the create's own output; absent on a full success. */
    warning?: string;
}

/** One line: a warning that spans lines is unreadable after the create's output. */
function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function defaultAttach(args: string[], env: NodeJS.ProcessEnv, timeoutMs = ATTACH_TIMEOUT_MS): { ok: boolean; error?: string; stdout?: string } {
    return runReceipt(args, env, { timeoutMs });
}

/**
 * Write the Issue-to-PR link for a create that just succeeded. Never throws: every
 * failure, including an unexpected one, becomes a single warning so the caller can
 * keep the create's own exit code.
 */
export function linkCreatedPr(stdout: string | null | undefined, argv: string[], deps: GhPrLinkDeps = {}): GhPrLinkResult {
    try {
        return linkOrWarn(stdout, argv, deps);
    } catch (error) {
        return { attached: false, warning: `the new pull request was not linked to its Substrate Issue: ${oneLine((error as Error).message)}` };
    }
}

function linkOrWarn(stdout: string | null | undefined, argv: string[], deps: GhPrLinkDeps): GhPrLinkResult {
    const env = deps.env ?? process.env;
    const cwd = deps.cwd ?? process.cwd();
    const pr = parseCreatedPrUrl(stdout);
    if (!pr) {
        return { attached: false, warning: 'gh pr create printed no pull request URL, so the new PR is not linked to a Substrate Issue' };
    }
    const body = readCreateBody(argv, deps.readFile);
    const git = deps.runGit ?? defaultRunGit();
    const branchResult = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const branch = branchResult.status === 0 ? branchResult.stdout.trim() : '';
    const projects = deps.projects ?? listProjects(deps);
    const choice = chooseIssueRef({
        bodyText: body.text,
        title: readCreateTitle(argv),
        // A detached head reports the literal "HEAD", which names no branch.
        branch: branch === 'HEAD' ? '' : branch,
        projects,
    });
    if (!choice.ref) {
        return { attached: false, canonical: pr.canonical, warning: `${choice.reason}, so ${pr.canonical} is not linked to a Substrate Issue` };
    }
    const ref = choice.ref;
    const project = resolveReceiptProject({ issueRef: ref, repo: pr.slug }, { ...deps, projects });
    if (!project) {
        return { attached: false, ref, canonical: pr.canonical, warning: `cannot resolve the Substrate project for ${ref}, so ${pr.canonical} is not linked` };
    }
    const run = deps.runAttach ?? defaultAttach;
    const runDispatch = deps.runDispatch ?? run;
    const runAllocate = deps.runAllocate ?? run;
    // One deadline for the pair: the whole post-create step, not each receipt,
    // is what must stay inside the budget.
    const deadline = Date.now() + ATTACH_TIMEOUT_MS;
    const budget = (): number => Math.max(250, deadline - Date.now());

    const attachArgv = withReceiptProject(['provenance', 'attach', ref, 'pr', pr.canonical], project);
    const t1 = run(attachArgv, env, budget());
    if (!t1.ok) {
        // CORE-2631: `attach` resolves a WorkReceipt, which only exists after
        // `dispatch` (creates the binding) and `allocate` (creates the receipt).
        // A fresh issue has neither, so attach fails with `no_receipt`. Recover
        // once: dispatch -> allocate -> attach. A receipt that already exists makes
        // the first attach succeed, so this path is a no-op on repeat runs.
        const err = t1.error ?? '';
        if (!/no_receipt/i.test(err)) {
            return {
                attached: false,
                ref,
                canonical: pr.canonical,
                argv: attachArgv,
                warning: `created ${pr.canonical}, but the Substrate link to ${ref} failed: ${oneLine(err || 'sb gave no reason')}`,
            };
        }
        // CORE-2631 review (pr-reviewer): decide --participant from the Issue's
        // claim state, not from env.SUBSTRATE_HOLDER (which every agent process
        // has, even for unclaimed Issues). One read via the existing runner.
        let holder: string | null = null;
        const showArgv = ['issue', 'show', ref, '--json'];
        const showResult = run(showArgv, env, budget());
        if (showResult.ok && showResult.stdout) {
            try {
                const parsed = JSON.parse(showResult.stdout) as { claim?: { holder?: string | null; releasedAt?: string | null } | null };
                const claim = parsed?.claim;
                if (claim && claim.holder && !claim.releasedAt) {
                    holder = claim.holder;
                }
            } catch {
                // Unparseable show output: treat as unclaimed (omit --participant).
            }
        }
        // Dispatch: create the execution binding. --participant is required when
        // the issue is live-held (anti-steal); omit it when unclaimed.
        const dispatchArgs = ['provenance', 'dispatch', ref];
        if (holder) dispatchArgs.push('--participant', holder);
        // --workspace is only meaningful when cwd is known; the shim always sets
        // it, but tests may omit it.
        if (deps.cwd) dispatchArgs.push('--workspace', cwd);
        const dispatchArgv = withReceiptProject(dispatchArgs, project);
        const td = runDispatch(dispatchArgv, env, budget());
        if (!td.ok) {
            return {
                attached: false,
                ref,
                canonical: pr.canonical,
                argv: attachArgv,
                warning: `created ${pr.canonical}, but the Substrate link to ${ref} failed: ${oneLine(td.error ?? 'sb gave no reason')}`,
            };
        }
        // Allocate: create the receipt from the binding.
        const allocateArgv = withReceiptProject(['provenance', 'allocate', ref], project);
        const ta = runAllocate(allocateArgv, env, budget());
        if (!ta.ok) {
            return {
                attached: false,
                ref,
                canonical: pr.canonical,
                argv: attachArgv,
                warning: `created ${pr.canonical}, but the Substrate link to ${ref} failed: ${oneLine(ta.error ?? 'sb gave no reason')}`,
            };
        }
        // Retry attach once.
        const t1b = run(attachArgv, env, budget());
        if (!t1b.ok) {
            return {
                attached: false,
                ref,
                canonical: pr.canonical,
                argv: attachArgv,
                warning: `created ${pr.canonical}, but the Substrate link to ${ref} failed: ${oneLine(t1b.error ?? 'sb gave no reason')}`,
            };
        }
    }

    const range = resolveLinkRange(git, cwd);
    if (!range) {
        return {
            attached: true,
            ref,
            canonical: pr.canonical,
            argv: attachArgv,
            warning: `linked ${pr.canonical} to ${ref}, but HEAD cannot be read in ${cwd}, so its commits are not linked`,
        };
    }
    const commitsArgv = withReceiptProject([
        'issue', 'link', 'pr', ref,
        '--repo', pr.slug,
        '--number', String(pr.number),
        ...(range.base ? ['--commits-range', `${range.base}..${range.head}`] : ['--commit', range.head]),
    ], project);
    const t2 = run(commitsArgv, env, budget());
    if (!t2.ok) {
        return {
            attached: true,
            ref,
            canonical: pr.canonical,
            argv: attachArgv,
            commitsArgv,
            warning: `linked ${pr.canonical} to ${ref}, but its commit evidence failed: ${oneLine(t2.error ?? 'sb gave no reason')}`,
        };
    }
    return { attached: true, ref, canonical: pr.canonical, argv: attachArgv, commitsArgv };
}
