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
import {
    XTRM_DISPATCHER_PARTICIPANT_VAR,
    isDispatcherLabel,
    isLowercaseUuid,
    resolveDispatcherSessionForParticipant,
    type DispatcherIdentityDeps,
} from './dispatcher-identity.js';
import { resolveWorkerSessionId } from './session-identity.js';;
import { parseIssueMarker, parseIssueMarkers, markerRunVerdict } from './review-posting.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** One hermetic `sb provenance attach` may take at most this long. */
export const ATTACH_TIMEOUT_MS = 5_000;

/**
 * CORE-2745: the same step when `sb` is remote, where every call is an ssh round
 * trip (ADR-008) instead of a local open.
 *
 * One link makes at most seven `sb` calls: `project list`, the first attach, the
 * claim read, `provenance dispatch`, `provenance allocate`, the attach retry and
 * `issue link pr`. Measured on the 2026-11-18 host: 850-1906 ms per call (the
 * four lead measurements at load1 about 13 read 1250-1906 ms). Seven calls of
 * {@link REMOTE_SB_CALL_MS} of allowance each is 17.5 s, so 18 s bounds the worst
 * case with margin; the local five seconds cannot cover even three calls.
 */
export const REMOTE_ATTACH_TIMEOUT_MS = 18_000;

/** Per-call allowance the remote budget is sized from: the 1906 ms maximum, plus slack. */
export const REMOTE_SB_CALL_MS = 2_500;

/** The one knob for the whole link budget, in either mode. */
export const LINK_TIMEOUT_ENV_VAR = 'XTRM_PR_LINK_TIMEOUT_MS';

/** Bounds of {@link LINK_TIMEOUT_ENV_VAR}: a typo must not make the link a slow blocker. */
export const LINK_TIMEOUT_MIN_MS = 2_000;
export const LINK_TIMEOUT_MAX_MS = 120_000;

/**
 * Headroom kept inside a budget so this process answers before its caller's own
 * kill: the shim allows the budget plus this tail (CORE-2631 review).
 */
export const LINK_TAIL_MS = 1_000;

/** `sb remote setup` records its mode here; sb honours this override of the path. */
export const SB_REMOTE_CONFIG_ENV_VAR = 'SUBSTRATE_REMOTE_CONFIG';

/** Where sb keeps the remote setting, relative to the home directory. */
export const SB_REMOTE_CONFIG_RELATIVE_PATH = path.join('.xtrm', 'config', 'substrate.json');

export interface SbModeDeps {
    env?: NodeJS.ProcessEnv;
    readFile?: (file: string) => string;
    homeDir?: string;
}

/** The file `sb` reads for its remote setting, honouring sb's own override. */
export function sbRemoteConfigPath(env: NodeJS.ProcessEnv, homeDir = homedir()): string {
    const override = (env[SB_REMOTE_CONFIG_ENV_VAR] ?? '').trim();
    return override || path.join(homeDir, SB_REMOTE_CONFIG_RELATIVE_PATH);
}

/**
 * CORE-2745: sb's own choice between a local store and the remote server, in the
 * order sb applies it. This one function is the single source of truth: the
 * generated `gh` shim embeds its source text verbatim
 * ({@link SB_REMOTE_MODE_SOURCE}), so the two copies cannot drift.
 *
 * Mirrored from the substrate CLI (read 2026-11-18):
 *   - service/client.ts `localOrRemote`: `const explicit = env.SUBSTRATE_DB ??
 *     env.SUBSTRATE_LOCAL_DB; if (explicit !== undefined && explicit !== "")` is a
 *     LOCAL store. Note the `??`: a DEFINED-but-empty SUBSTRATE_DB masks
 *     SUBSTRATE_LOCAL_DB and is not itself a local store, so the file decides.
 *   - remote/config.ts `readRemoteConfig`: `SUBSTRATE_REMOTE` (trimmed, non-empty)
 *     replaces the file's `remote`, and it works with no config file at all, so
 *     the env wins over the file.
 *   - remote/spec.ts `parseRemoteSpec`: only `ssh:<host>` (host not starting with
 *     `-`) is a usable remote. Any other value makes sb refuse the invocation, so
 *     it is one failing call, not a wait: it takes the local budget.
 *
 * `configText` is the config file's content, or null when it could not be read.
 * Self-contained on purpose: no imports, no helpers, no closures over module
 * state, because the shim evaluates this exact text.
 */
export function sbRemoteModeFrom(env: Record<string, string | undefined>, configText: string | null): boolean {
    const explicit = env.SUBSTRATE_DB ?? env.SUBSTRATE_LOCAL_DB;
    if (explicit !== undefined && explicit !== '') return false;
    const fromEnv = (env.SUBSTRATE_REMOTE ?? '').trim();
    let remoteValue: unknown = fromEnv !== '' ? fromEnv : null;
    if (remoteValue === null && configText !== null) {
        try {
            const parsed: unknown = JSON.parse(configText);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const fileRemote = (parsed as { remote?: unknown }).remote;
                if (fileRemote !== undefined) remoteValue = fileRemote;
            }
        } catch {
            return false;
        }
    }
    if (typeof remoteValue !== 'string') return false;
    return /^ssh:(?!-)[^\s:]+$/.test(remoteValue.trim());
}

/** The text the generated shim embeds, so it runs this function and not a copy. */
export const SB_REMOTE_MODE_SOURCE = `(${sbRemoteModeFrom.toString()})`;

/**
 * Whether sb's own config says every call is forwarded over ssh. Tolerant by
 * design: an unreadable or unparsable file reads as local, because sb refuses such
 * an invocation before it opens anything.
 */
export function parseSbRemoteMode(text: string | null | undefined): boolean {
    return sbRemoteModeFrom({}, text ?? null);
}

/**
 * Whether this session's `sb` runs in remote (ssh) mode, read from sb's own env and
 * config and never from a probe call: a probe would cost exactly the latency the
 * budget is there to pay for.
 */
export function sbRemoteMode(deps: SbModeDeps = {}): boolean {
    const env = deps.env ?? process.env;
    const read = deps.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
    let text: string | null = null;
    try {
        text = read(sbRemoteConfigPath(env, deps.homeDir));
    } catch {
        text = null;
    }
    return sbRemoteModeFrom(env, text);
}

/**
 * The budget for the whole post-create link: the explicit override (clamped), else
 * the mode's default. An invalid override falls back to the default silently: this
 * step is fail-open, so a bad value must not become a warning of its own.
 */
export function resolveLinkBudgetMs(deps: SbModeDeps = {}): number {
    const env = deps.env ?? process.env;
    const raw = Number((env[LINK_TIMEOUT_ENV_VAR] ?? '').trim());
    if (Number.isFinite(raw) && raw > 0) {
        return Math.min(Math.max(Math.round(raw), LINK_TIMEOUT_MIN_MS), LINK_TIMEOUT_MAX_MS);
    }
    return sbRemoteMode(deps) ? REMOTE_ATTACH_TIMEOUT_MS : ATTACH_TIMEOUT_MS;
}

/**
 * A Substrate Issue ref. Hierarchical refs (`XTRM-184.2.3`) are valid: the
 * merge guard's `isSafeIssueRef` is deliberately stricter because it journals a
 * decision, while an artifact attach accepts any ref `sb` knows.
 */
const ISSUE_REF = /^[A-Z][A-Z0-9]*-\d+(?:\.\d+)*$/;

/** A ref-shaped token anywhere in a text, with its prefix captured. Literal. */
const REF_SHAPED = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9]*)-(?:\d+(?:\.\d+)*)(?![A-Za-z0-9])/gi;

/**
 * The outer kill one `xt identity pr-link` run gets: the same budget the link
 * keeps for itself, plus the tail it needs to answer inside that kill (CORE-2745).
 */
export function resolveLinkCeilingMs(deps: SbModeDeps = {}): number {
    return resolveLinkBudgetMs(deps) + LINK_TAIL_MS;
}

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
/**
 * Whether git itself calls this checkout shallow (CORE-2638).
 *
 * A shallow clone has HEAD but not the fork point: `merge-base` can still name a
 * commit, and `git log <base>..<head>` then fails with a bare
 * `fatal: Invalid revision range`, which reads as a defect in the link rather than
 * in the checkout. Ask git instead of guessing from the path, and treat a git that
 * cannot answer as "not shallow" so an old client keeps today's behaviour.
 */
export function isShallowRepository(runGit: RunGit, cwd: string): boolean {
    const result = runGit(['rev-parse', '--is-shallow-repository'], cwd);
    return result.status === 0 && result.stdout.trim() === 'true';
}

export interface LinkRange {
    head: string;
    base: string | null;
    /** Whether git calls this checkout shallow; the caller reuses it to word the warning. */
    shallow: boolean;
}

export function resolveLinkRange(runGit: RunGit, cwd: string): LinkRange | null {
    const headResult = runGit(['rev-parse', 'HEAD'], cwd);
    const head = headResult.status === 0 ? headResult.stdout.trim() : '';
    if (!FULL_SHA.test(head)) return null;
    // Deliberate skip, not a failure: in a shallow clone the range cannot be walked,
    // so the caller records `--commit <head>` instead and the evidence still lands.
    if (isShallowRepository(runGit, cwd)) return { head, base: null, shallow: true };
    for (const upstream of ['origin/HEAD', 'origin/main', '@{upstream}']) {
        const merged = runGit(['merge-base', 'HEAD', upstream], cwd);
        const base = merged.status === 0 ? (merged.stdout.trim().split('\n')[0] ?? '').trim() : '';
        if (FULL_SHA.test(base)) return { head, base, shallow: false };
    }
    return { head, base: null, shallow: false };
}

export interface GhPrLinkDeps extends ReceiptProjectDeps {
    cwd?: string;
    readFile?: (file: string) => string;
    runGit?: RunGit;
    /**
     * Runs every `sb` call this module makes — the attach, the claim read, the
     * recovery dispatch/allocate and the retry. Tests inject a fake so no real
     * store is touched and can route on the argv.
     */
    runAttach?: (args: string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => { ok: boolean; error?: string; stdout?: string };
    /**
     * CORE-2728: the live-session probe behind the dispatcher session id; tests
     * inject a temp registry instead of touching the host's.
     */
    dispatcherDeps?: DispatcherIdentityDeps;
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

interface ClaimProjection {
    holder?: string | null;
    activationId?: string | null;
    releasedAt?: string | null;
}

/**
 * The claim from `sb issue show <ref> --json`, accepting both the real envelope
 * (`{…, data: {claim}}`) and a flat `{claim}`. Returns null when the answer is not
 * readable, so the caller can tell "no claim" from "could not read the claim".
 */
function parseClaimPayload(stdout: string): ClaimProjection | null {
    // Tolerant of a non-JSON preamble: a strict parse would read a live-held
    // Issue as unclaimed.
    const start = stdout.indexOf('{');
    if (start < 0) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout.slice(start));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const envelope = parsed as { claim?: ClaimProjection | null; data?: { claim?: ClaimProjection | null } | null };
    const claim = envelope.data && typeof envelope.data === 'object' ? envelope.data.claim : envelope.claim;
    if (claim === null) return {};
    if (!claim || typeof claim !== 'object') return null;
    return claim;
}

function linkOrWarn(stdout: string | null | undefined, argv: string[], deps: GhPrLinkDeps): GhPrLinkResult {
    const env = deps.env ?? process.env;
    const cwd = deps.cwd ?? process.cwd();
    const pr = parseCreatedPrUrl(stdout);
    if (!pr) {
        return { attached: false, warning: 'gh pr create printed no pull request URL, so the new PR is not linked to a Substrate Issue' };
    }
    // CORE-2745: one deadline for the WHOLE step, started before the first sb call
    // (the project list is a round trip too), so the budget bounds the sum and not
    // one receipt. It is sized by sb's mode: remote forwards every call over ssh.
    const budgetMs = resolveLinkBudgetMs({ env, readFile: deps.readFile });
    const deadline = Date.now() + budgetMs;
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
    const budget = (): number => Math.max(250, deadline - Date.now());
    // CORE-2631 review: recovery adds up to four calls (show, dispatch,
    // allocate, retry). With only the per-call floor those floors can outlive the
    // deadline and run into the shim's own kill (the budget plus LINK_TAIL_MS),
    // which SIGKILLs this process mid-sequence. Reserve the tail so the shim
    // always gets control back, and give up honestly when nothing is left.
    const recoveryBudget = (): number => {
        const left = deadline - LINK_TAIL_MS - Date.now();
        return left > 0 ? left : 0;
    };

    const attachArgv = withReceiptProject(['provenance', 'attach', ref, 'pr', pr.canonical], project);
    /** One shell line that finishes the link from where this run stopped. */
    const finishWith = (...steps: string[][]): string => steps.map((step) => ['sb', ...step].join(' ')).join(', then ');
    // Everything a timeout's finish command names is built BEFORE the first
    // recovery call, so an exhausted budget always reports an exact command.
    const ownHolder = (env.SUBSTRATE_HOLDER ?? '').trim();
    const showArgv = ['issue', 'show', ref, '--json'];
    const allocateArgv = withReceiptProject(['provenance', 'allocate', ref], project);
    const dispatchArgvOf = (holder: string | null, activation: string | null): string[] => {
        // Dispatch: create the execution binding. --participant is required when
        // the issue is live-held (anti-steal); omit it when unclaimed or unknown.
        const args = ['provenance', 'dispatch', ref];
        if (holder && ownHolder && ownHolder === holder) {
            args.push('--participant', ownHolder);
            // sb compares holder AND activation, so a claim carrying an
            // activation rejects a participant without one.
            if (activation) args.push('--activation', activation);
        }
        // CORE-2639: bind to the worker's own runtime session, not the tmux session
        // id sb would otherwise record — every window in one tmux session shares
        // that value, so it cannot attribute the binding. Absent from the
        // environment means no flag, and sb keeps its own fallback.
        const workerSession = resolveWorkerSessionId(env);
        if (workerSession) args.push('--session', workerSession);
        // CORE-2728: who dispatched THIS worker, from the participant xt exported at
        // launch, and the dispatcher's own session when a live session of that
        // participant carries a Claude session id. Absent stays absent: no flag.
        const dispatcherParticipant = (env[XTRM_DISPATCHER_PARTICIPANT_VAR] ?? '').trim();
        if (dispatcherParticipant && isDispatcherLabel(dispatcherParticipant)) {
            args.push('--dispatcher-participant', dispatcherParticipant);
            const dispatcherSession = resolveDispatcherSessionForParticipant(dispatcherParticipant, deps.dispatcherDeps ?? {});
            if (dispatcherSession && isLowercaseUuid(dispatcherSession)) {
                args.push('--dispatcher-session', dispatcherSession);
            }
        }
        // --workspace is only meaningful when cwd is known; the shim always sets
        // it, but tests may omit it.
        if (deps.cwd) args.push('--workspace', cwd);
        return withReceiptProject(args, project);
    };
    /**
     * CORE-2745: ONE stderr line that names the step which ran out of time and the
     * exact command that finishes the link, so nobody has to reconstruct the
     * recovery by hand.
     */
    const outOfTime = (step: string, finish: string[][], note?: string): GhPrLinkResult => ({
        attached: false,
        ref,
        canonical: pr.canonical,
        argv: attachArgv,
        warning: oneLine(`created ${pr.canonical}, but the Substrate link to ${ref} ran out of time at ${step}; finish with: ${finishWith(...finish)}${note ? ` (${note})` : ''}`),
    });
    /**
     * CORE-2745 review F1: a claim-read timeout cannot be finished by
     * `provenance dispatch` alone. sb refuses a dispatch on a live-held Issue that
     * names no participant, and the claim read is exactly the step that finds the
     * holder — so the line carries the read, a dispatch with the participant we
     * already know (the shell holder) and the activation the read answers with,
     * then the rest of the recovery.
     */
    const claimReadFinish = (): { steps: string[][]; note: string } => {
        const dispatch: string[] = ['provenance', 'dispatch', ref];
        if (ownHolder) {
            dispatch.push('--participant', ownHolder, '--activation', `'<activationId from the show>'`);
        }
        const steps = [showArgv, withReceiptProject(dispatch, project), allocateArgv, attachArgv];
        return {
            steps,
            note: ownHolder
                ? `--participant ${ownHolder} only when the show answer names it as the claim holder, and --activation is that answer's activationId`
                : 'add --participant <the claim holder from the show> and --activation <its activationId> to the dispatch',
        };
    };
    /** sb's own wording for a call this process killed at its budget. */
    const timedOut = (error?: string): boolean => /no answer in \d+ ms|ETIMEDOUT/i.test(error ?? '');
    const t1 = run(attachArgv, env, budget());
    if (!t1.ok) {
        // CORE-2631: `attach` resolves a WorkReceipt, which only exists after
        // `dispatch` (creates the binding) and `allocate` (creates the receipt).
        // A fresh issue has neither, so attach fails with `no_receipt`. Recover
        // once: dispatch -> allocate -> attach. A receipt that already exists makes
        // the first attach succeed, so this path is a no-op on repeat runs.
        const err = t1.error ?? '';
        // A call that hit the budget is not a link defect: name the step and the
        // command that finishes the job (CORE-2745).
        if (timedOut(err)) return outOfTime('the first sb provenance attach', [attachArgv]);
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
        // claim state, not from env.SUBSTRATE_HOLDER alone (every agent process has
        // that variable, even for an unclaimed Issue). One read via the runner.
        // The VALUE stays the session's own holder: echoing the observed holder
        // would pass sb's anti-steal check by construction and attribute this
        // session's work to whoever holds the claim. When the two differ, the flag
        // is omitted and sb refuses with its own message — one honest warning.
        //
        // sb wraps every answer as {schema, command, ok, data}, and the claim lives
        // at data.claim. Reading the top level (an earlier version did) silently
        // found nothing, so every Issue looked unclaimed and a genuinely held one
        // lost its --participant. Both shapes are accepted because the unit tests
        // and older callers build the flat one.
        //
        // CORE-2745: in remote mode a round trip is an ssh call, so the read runs
        // only when it can change the argv: no shell holder means no --participant
        // either way (a), and a failed attach that already answered with the claim
        // is reused instead (b).
        //
        // Measured against the shipped sb (0.4.0, 2026-11-18): its `no_receipt`
        // refusal carries no claim, so (b) does not fire there today. The saving
        // that actually lands on a normal host is (a), the empty-holder skip, and
        // (b) is kept as an opportunistic one for an sb that answers with the
        // claim. Neither is load-bearing for the budget: the remote budget is
        // sized for all seven calls, so a link that pays every one still fits.
        let claimHolder: string | null = null;
        let claimActivation: string | null = null;
        let claimReadFailed = false;
        const claimFromAttach = ownHolder ? parseClaimPayload(t1.stdout ?? '') : null;
        if (claimFromAttach) {
            if (claimFromAttach.holder && !claimFromAttach.releasedAt) {
                claimHolder = claimFromAttach.holder;
                claimActivation = claimFromAttach.activationId ?? null;
            }
        } else if (ownHolder) {
            // CORE-2745 review F1: name the read AND the dispatch that works on a
            // live-held Issue, not a dispatch sb would refuse.
            const claimFinish = claimReadFinish();
            if (recoveryBudget() <= 0) {
                return outOfTime('the claim read (sb issue show)', claimFinish.steps, claimFinish.note);
            }
            const showResult = run(showArgv, env, recoveryBudget());
            if (!showResult.ok) {
                // A read that hit the budget ends the recovery; any other failure
                // continues without a participant, as before.
                if (timedOut(showResult.error)) {
                    return outOfTime('the claim read (sb issue show)', claimFinish.steps, claimFinish.note);
                }
                claimReadFailed = true;
            } else {
                const parsed = parseClaimPayload(showResult.stdout ?? '');
                if (!parsed) {
                    claimReadFailed = true;
                } else if (parsed.holder && !parsed.releasedAt) {
                    claimHolder = parsed.holder;
                    claimActivation = parsed.activationId ?? null;
                }
            }
        }

        const dispatchArgv = dispatchArgvOf(claimHolder, claimActivation);
        if (recoveryBudget() <= 0) return outOfTime('sb provenance dispatch', [dispatchArgv, allocateArgv, attachArgv]);
        const td = run(dispatchArgv, env, recoveryBudget());
        if (!td.ok) {
            if (timedOut(td.error)) return outOfTime('sb provenance dispatch', [dispatchArgv, allocateArgv, attachArgv]);
            const why = claimReadFailed ? ' (the claim could not be read, so no participant was sent)' : '';
            return {
                attached: false,
                ref,
                canonical: pr.canonical,
                argv: attachArgv,
                warning: `created ${pr.canonical}, but the Substrate link to ${ref} failed${why}: ${oneLine(td.error ?? 'sb gave no reason')}`,
            };
        }
        // Allocate: create the receipt from the binding.
        if (recoveryBudget() <= 0) return outOfTime('sb provenance allocate', [allocateArgv, attachArgv]);
        const ta = run(allocateArgv, env, recoveryBudget());
        if (!ta.ok) {
            if (timedOut(ta.error)) return outOfTime('sb provenance allocate', [allocateArgv, attachArgv]);
            return {
                attached: false,
                ref,
                canonical: pr.canonical,
                argv: attachArgv,
                warning: `created ${pr.canonical}, but the Substrate link to ${ref} failed: ${oneLine(ta.error ?? 'sb gave no reason')}`,
            };
        }
        // Retry attach once.
        if (recoveryBudget() <= 0) return outOfTime('the sb provenance attach retry', [attachArgv]);
        const t1b = run(attachArgv, env, recoveryBudget());
        if (!t1b.ok) {
            if (timedOut(t1b.error)) return outOfTime('the sb provenance attach retry', [attachArgv]);
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
        // In a shallow clone a RANGE failure is the checkout's shape, not the link's,
        // and the raw `fatal: Invalid revision range` names neither cause nor remedy.
        // Any other failure keeps its own diagnostic with the shallow note appended:
        // rewriting `unknown flag --commit` into a shallow-clone remedy would hide the
        // real reason behind advice that cannot fix it.
        const reason = oneLine(t2.error ?? 'sb gave no reason');
        const rangeShaped = /Invalid revision range|unknown revision|bad revision/i.test(reason);
        const warning = timedOut(t2.error)
            // CORE-2745: the commit evidence is the last step of the link, so a
            // budget that ends here still leaves the operator one exact command.
            ? oneLine(`linked ${pr.canonical} to ${ref}, but its commit evidence ran out of time at sb issue link pr; finish with: ${finishWith(commitsArgv)}`)
            : !range.shallow
                ? `linked ${pr.canonical} to ${ref}, but its commit evidence failed: ${reason}`
                : rangeShaped
                    ? `linked ${pr.canonical} to ${ref}, but its commit evidence is unavailable in a shallow clone (${cwd}); run git fetch --unshallow to link the range`
                    : `linked ${pr.canonical} to ${ref}, but its commit evidence failed: ${reason} (this checkout is a shallow clone; git fetch --unshallow if the range is what is missing)`;
        return {
            attached: true,
            ref,
            canonical: pr.canonical,
            argv: attachArgv,
            commitsArgv,
            warning,
        };
    }
    return { attached: true, ref, canonical: pr.canonical, argv: attachArgv, commitsArgv };
}
