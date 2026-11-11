/**
 * The client-side merge guard (CORE-2530, parent CORE-2524).
 *
 * The organisation is on the Free plan, so nothing on GitHub refuses a merge and
 * `pr-review-gate` never requires a review to exist. This guard is the check:
 * read-only, repo-agnostic, called by the `gh pr merge` shim (and optionally by a
 * repository's own promotion command). It allows a merge only when the reviewer
 * App's LATEST review is APPROVED and pinned to the PR's current head, or is a
 * COMMENT (PARTIAL) with a valid coordinator decision entry for that head.
 *
 * Refusals are fail-closed: no review, a review at an older head, an active
 * CHANGES_REQUESTED, an unresolvable Issue (one whose marker names a ref that is
 * malformed, ambiguous, or does not exist in Substrate), or GitHub/the App being
 * unreachable. The single escape hatch is `XTRM_MERGE_GUARD_OVERRIDE=<reason>`,
 * honoured only for the coordinator role and the operator identity; each use
 * writes a log line and a Journal decision entry.
 *
 * The Issue existence check is the one place the guard asks Substrate a question.
 * It is read-only, at most one `sb` call per merge-check, and it degrades to a
 * warning when `sb` cannot answer (`XTRM_MERGE_GUARD_OFFLINE=1` forces that state):
 * an outage must not block an approved merge (CORE-2590).
 */

import { accessSync, appendFileSync, constants as fsConstants, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { githubRequest, repoOwner, type FetchLike } from './github-apps.js';
import { explainAgentRole, type AgentRole, type RoleMap, DEFAULT_ROLE_MAP } from './identity-roles.js';
import { isSafeIssueRef, parseIssueMarkers, sha12, type ReviewVerdict } from './review-posting.js';
import { describeSbFailure, parseProjectList, pickReceiptProject, resolveSbBinary, withReceiptProject } from './sb-receipt.js';

export const OVERRIDE_ENV_VAR = 'XTRM_MERGE_GUARD_OVERRIDE';

/** `XTRM_MERGE_GUARD_OFFLINE=1` forces the Issue-existence check to `unknown`. */
export const OFFLINE_ENV_VAR = 'XTRM_MERGE_GUARD_OFFLINE';

/** One hermetic `sb issue show` may take at most this long. */
export const ISSUE_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * The guard is FLAG-GATED and OFF by default (CORE-2528 rev 4 R3): the operator's
 * own merge path stays the fallback until the Apps are proven, so installing the
 * shim cannot refuse every agent merge on a machine with no App configured.
 * `XTRM_MERGE_GUARD=on|1|true|yes` turns it on.
 */
export const MERGE_GUARD_ENV_VAR = 'XTRM_MERGE_GUARD';
export function mergeGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = (env[MERGE_GUARD_ENV_VAR] ?? '').trim().toLowerCase();
    return value === 'on' || value === '1' || value === 'true' || value === 'yes';
}

export interface RunResult { status: number | null; stdout: string; stderr: string }
export interface RunOptions { input?: string; timeout?: number; cwd?: string }
export type RunFn = (cmd: string, args: string[], opts: RunOptions) => RunResult;

/**
 * The Issue-existence check has three outcomes. Only an explicit not-found
 * denies; `unknown` allows with a warning because an outage must not block work.
 */
export type IssueLookupState = 'verified' | 'missing' | 'unknown';
export interface IssueLookup { state: IssueLookupState; detail?: string }

export interface MergeGuardDeps {
    /** Installation token for READS (the reviewer App: pull requests read/write, contents read). */
    token: string;
    fetch?: FetchLike;
    apiBase?: string;
    /** `sb` runner, injected for tests. */
    runSb?: RunFn;
    /** The `sb` path a failure should name; resolved from PATH when omitted. */
    sbBinary?: string;
    env?: NodeJS.ProcessEnv;
    roleMap?: RoleMap | null;
    /** Reviewer App slug; its bot login is `<slug>[bot]`. */
    reviewerSlug?: string;
    now?: () => number;
    stateHome?: string;
    /** Directory for the `sb` existence check, explicit so it never depends on a default. */
    cwd?: string;
}

export interface MergeDecision {
    allow: boolean;
    /** One line: why the merge is allowed or refused. */
    reason: string;
    repo: string;
    pr: number;
    head?: string;
    issueRef?: string | null;
    reviewState?: ReviewVerdict | string;
    reviewUrl?: string;
    reviewHead?: string;
    /** Set when the override was honoured. */
    override?: { reason: string; logged: boolean; journaled: boolean; error?: string };
    /** True when GitHub or the App could not be read (fail closed). */
    unreachable?: boolean;
    /** Whether the marker's Issue was verified, missing, or could not be checked. */
    issueLookup?: IssueLookupState;
    /** Short classification when `issueLookup` is `unknown`; never the Issue body. */
    issueLookupDetail?: string;
    /** The full text shown to the agent (refusal names the way forward). */
    message: string;
}

type PullResponse = { body?: string | null; head?: { sha?: string; ref?: string } };
type ReviewResponse = {
    id?: number;
    state?: string;
    body?: string | null;
    commit_id?: string;
    submitted_at?: string;
    html_url?: string;
    user?: { login?: string };
};
type JournalEntry = {
    kind?: string;
    createdAt?: number;
    participantId?: string | null;
    semantic?: Record<string, unknown> | null;
};

const ROUTING_HINT = [
    '  - the reviewer subagent in PR mode (Claude-backed; required for HIGH or critical scrutiny)',
    '  - xt claude --role pr-reviewer (Claude-backed)',
    '  - the pr-reviewer specialist for a job verdict (lower tiers)',
].join('\n');

/** The universal refusal text. No repository name, and the routing follows SCRUTINY tier. */
export function refusalMessage(input: {
    repo: string;
    pr: number;
    head?: string;
    reason: string;
    /** Replaces the "get a review" block when that is not the way forward. */
    guidance?: string[];
}): string {
    const head = input.head ? sha12(input.head) : '(unknown head)';
    const guidance = input.guidance ?? [
        `a review by xtrm-reviewer[bot] is required at head ${head}`,
        'ways to get one:',
        ROUTING_HINT,
    ];
    return [
        `merge refused for ${input.repo}#${input.pr}: ${input.reason}`,
        ...guidance,
        `override (coordinator and operator only): ${OVERRIDE_ENV_VAR}=<reason>`,
    ].join('\n');
}

/** How to fix an Issue marker: the marker is the only Issue source. */
export function markerGuidance(ref?: string | null): string[] {
    const example = `<!-- xtrm issue=${ref ?? 'CORE-2528'} holder=<holder> run=<id> -->`;
    return [
        `put ONE marker in the PR body that names an existing Substrate Issue, for example ${example}`,
        `a marker inside a fenced code block or a > quote is ignored; check the ref with: sb issue show ${ref ?? '<REF>'} --json`,
    ];
}

function defaultRunSb(): RunFn {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    return (cmd, args, opts) => {
        const result = spawnSync(cmd, args, {
            encoding: 'utf8',
            input: opts.input ?? undefined,
            cwd: opts.cwd,
            timeout: opts.timeout,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    };
}

function parseSbJson(stdout: string): unknown {
    const text = stdout.trim();
    if (!text) return null;
    // `sb --json` emits one envelope; tolerate a warning line before it.
    const start = text.indexOf('{');
    if (start < 0) return null;
    try {
        return JSON.parse(text.slice(start));
    } catch {
        return null;
    }
}

export function journalEntries(stdout: string): JournalEntry[] {
    const envelope = parseSbJson(stdout) as { data?: unknown } | null;
    const data = envelope?.data;
    return Array.isArray(data) ? data as JournalEntry[] : [];
}

function offlineRequested(env: NodeJS.ProcessEnv): boolean {
    const value = (env[OFFLINE_ENV_VAR] ?? '').trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

/**
 * One hermetic `sb issue show <REF> --json`: 5 s timeout, explicit cwd, no stdin,
 * and nothing but a classification leaves this function, so the Issue body and any
 * token in its text never reach a log or the decision.
 */
export function lookupIssue(ref: string, deps: MergeGuardDeps): IssueLookup {
    const env = deps.env ?? process.env;
    if (offlineRequested(env)) return { state: 'unknown', detail: `${OFFLINE_ENV_VAR} is set` };
    const run = deps.runSb ?? defaultRunSb();
    let result: RunResult;
    try {
        result = run('sb', ['issue', 'show', ref, '--json'], {
            input: '',
            timeout: ISSUE_LOOKUP_TIMEOUT_MS,
            cwd: deps.cwd ?? process.cwd(),
        });
    } catch (error) {
        return { state: 'unknown', detail: `sb could not run (${(error as Error).message})` };
    }
    // spawnSync reports a missing binary (ENOENT) and a killed timeout as a null
    // status: both mean Substrate could not answer, not that the Issue is absent.
    if (result.status === null) return { state: 'unknown', detail: 'sb is absent or did not answer in 5 s' };
    const envelope = parseSbJson(result.stdout) as
        { ok?: unknown; data?: { humanRef?: unknown }; error?: unknown } | null;
    if (!envelope || typeof envelope !== 'object') {
        return { state: 'unknown', detail: 'sb returned output the guard cannot parse' };
    }
    if (result.status === 0) {
        const returned = typeof envelope.data?.humanRef === 'string' ? envelope.data.humanRef.trim() : '';
        if (envelope.ok === true && returned === ref) return { state: 'verified' };
        return { state: 'unknown', detail: `sb exited 0 without returning ${ref}` };
    }
    const error = typeof envelope.error === 'string' ? envelope.error : '';
    if (envelope.ok === false && error.includes(ref)
        && /unresolvable ref|not[ -]?found|no such issue|unknown (issue|ref)/i.test(error)) {
        return { state: 'missing' };
    }
    return { state: 'unknown', detail: `sb exited ${result.status} without an explicit not-found` };
}

/** A Journal `--kind decision` entry accepting this head and PR, by someone other than the PR's worker. */
export function findValidDecision(
    entries: JournalEntry[],
    input: { head: string; pr: number; reviewAt: number; prWorker?: string | null },
): JournalEntry | null {
    const head12 = sha12(input.head);
    for (const entry of entries) {
        if (entry.kind !== 'decision') continue;
        const semantic = entry.semantic ?? null;
        if (!semantic || typeof semantic !== 'object') continue;
        // The guard matches on semantic.head and semantic.pr only, never on free text.
        if (typeof semantic.head !== 'string' || sha12(semantic.head) !== head12) continue;
        if (typeof semantic.pr !== 'number' || semantic.pr !== input.pr) continue;
        if (typeof entry.createdAt !== 'number' || entry.createdAt <= input.reviewAt) continue;
        if (input.prWorker && entry.participantId === input.prWorker) continue;
        return entry;
    }
    return null;
}

function overrideLogPath(deps: MergeGuardDeps): string {
    const env = deps.env ?? process.env;
    const stateHome = deps.stateHome
        ?? (env.XDG_STATE_HOME ?? '').trim()
        ?? path.join(os.homedir(), '.local', 'state');
    return path.join(stateHome || path.join(os.homedir(), '.local', 'state'), 'xtrm', 'merge-guard-override.log');
}

/**
 * Reject a state directory that cannot work BEFORE any recursive mkdir: a
 * pathological path (a file as an ancestor, a non-directory, a read-only tree)
 * must fail in microseconds, not spin in the kernel.
 */
export function checkStateDir(dir: string): string | null {
    if (!path.isAbsolute(dir)) return `the state directory '${dir}' is not an absolute path`;
    let probe = dir;
    for (let depth = 0; depth < 40; depth += 1) {
        try {
            const stat = statSync(probe);
            if (!stat.isDirectory()) return `'${probe}' exists and is not a directory`;
            try {
                accessSync(probe, fsConstants.W_OK);
            } catch {
                return `'${probe}' is not writable`;
            }
            return null;
        } catch {
            const parent = path.dirname(probe);
            if (parent === probe) return `'${dir}' has no existing ancestor directory`;
            probe = parent;
        }
    }
    return `'${dir}' is nested too deeply to check`;
}

function appendOverrideLog(deps: MergeGuardDeps, line: Record<string, unknown>): { ok: boolean; error?: string } {
    try {
        const file = overrideLogPath(deps);
        // The reason is surfaced, not swallowed: the operator must know that the
        // STATE DIRECTORY is what made the audit trail fail (CORE-2528 delta L3).
        const problem = checkStateDir(path.dirname(file));
        if (problem) return { ok: false, error: `state directory '${path.dirname(file)}': ${problem}` };
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...line })}\n`, { mode: 0o600 });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: (error as Error).message };
    }
}

/**
 * Evaluate one merge. Never throws: a transport failure becomes a refusal so a
 * network problem cannot turn into a merge.
 */
export async function mergeCheck(input: { repo: string; pr: number }, deps: MergeGuardDeps): Promise<MergeDecision> {
    const env = deps.env ?? process.env;
    const reviewerSlug = deps.reviewerSlug ?? 'xtrm-reviewer';
    const botLogin = `${reviewerSlug}[bot]`;
    const base = { repo: input.repo, pr: input.pr } as const;

    const deny = (reason: string, extra: Partial<MergeDecision> = {}, guidance?: string[]): MergeDecision => ({
        allow: false,
        reason,
        ...base,
        ...extra,
        message: refusalMessage({ ...base, head: extra.head, reason, guidance }),
    });

    const allow = (reason: string, extra: Partial<MergeDecision> = {}): MergeDecision => ({
        allow: true,
        reason,
        ...base,
        ...extra,
        message: `merge allowed for ${input.repo}#${input.pr}: ${reason}`,
    });

    if (!mergeGuardEnabled(deps.env ?? process.env)) {
        return allow(`merge guard is off (${MERGE_GUARD_ENV_VAR} is not set); the merge is not checked`);
    }

    // ── Reads. Any failure is a refusal (fail closed). ──────────────────────
    let pull: PullResponse;
    let reviews: ReviewResponse[];
    try {
        const pulled = await githubRequest<PullResponse>({ method: 'GET', path: `/repos/${input.repo}/pulls/${input.pr}` }, deps);
        if (pulled.status !== 200) {
            return deny(`cannot read PR #${input.pr} (HTTP ${pulled.status}); GitHub or the App is unavailable`, { unreachable: true });
        }
        pull = pulled.data;
        const listed = await listReviews(input.repo, input.pr, deps);
        if (!listed) {
            return deny(`cannot list reviews for PR #${input.pr}; GitHub or the App is unavailable`, { unreachable: true });
        }
        reviews = listed;
    } catch (error) {
        return deny(`cannot reach GitHub (${(error as Error).message}); the guard fails closed`, { unreachable: true });
    }

    const head = pull.head?.sha ?? '';
    if (!head) return deny('the PR returned no head SHA');
    const markers = parseIssueMarkers(pull.body ?? '');
    const namedRefs = [...new Set(markers
        .map((entry) => entry.issue)
        .filter((value): value is string => typeof value === 'string' && value !== ''))];
    // Two markers with different refs are not a tie to break: the body contradicts
    // itself, and picking either one would let a fake first marker win (CORE-2590).
    if (namedRefs.length > 1) {
        return deny(
            `the PR body carries ${namedRefs.length} xtrm markers naming different Issues (${namedRefs.join(', ')}); leave exactly one`,
            { head },
            markerGuidance(),
        );
    }
    const marker = markers.length ? markers[markers.length - 1] : null;
    // The marker is the only Issue source: a branch name such as `fix/UTF-8-parser`
    // matched the ref format and became a fake Issue (CORE-2590).
    const rawRef = marker?.issue ?? null;
    // A ref from the PR body is attacker-controlled text on its way to `sb`.
    const issueRef = rawRef && isSafeIssueRef(rawRef) ? rawRef : null;
    if (rawRef && !issueRef) {
        return deny(`the PR names '${rawRef}', which is not a Substrate ref; refusing to read or write a Journal entry for it`, { head: pull.head?.sha }, markerGuidance());
    }

    // ── The latest reviewer review (DISMISSED reviews no longer count). ──────
    const mine = reviews
        // PENDING reviews were never submitted: they carry no state anyone can act on.
        .filter((review) => review.user?.login === botLogin
            && review.state
            && review.state !== 'DISMISSED'
            && (review.submitted_at ?? '') !== '')
        .sort((a, b) => Date.parse(a.submitted_at ?? '') - Date.parse(b.submitted_at ?? ''));
    const latest = mine[mine.length - 1];
    const reviewInfo = latest
        ? { reviewState: latest.state, reviewUrl: latest.html_url, reviewHead: latest.commit_id }
        : {};

    if (!latest) return deny('no review by xtrm-reviewer[bot] exists', { head, issueRef, ...reviewInfo });
    if (latest.commit_id !== head) {
        return deny(
            `the latest review by xtrm-reviewer[bot] is at ${sha12(latest.commit_id ?? '') || '(no commit)'}, not at the current head ${sha12(head)}`,
            { head, issueRef, ...reviewInfo },
        );
    }
    if (latest.state === 'CHANGES_REQUESTED') {
        return deny('the reviewer App requested changes at the current head', { head, issueRef, ...reviewInfo });
    }
    if (latest.state === 'APPROVED') {
        // The contract is unconditional (CORE-2528/CORE-2530): no resolvable Issue
        // means no record of the merge, so an approval alone cannot pass the guard.
        if (!issueRef) {
            return deny(
                'the PR names no Substrate Issue in a marker, so the guard refuses even an approval at the current head. Add the line-2 marker <!-- xtrm issue=<REF> holder=<holder> run=<id> --> to the PR body, or contact the operator',
                { head, issueRef, ...reviewInfo },
                markerGuidance(),
            );
        }
        // The review would otherwise allow: verify the marker's ref exists. One
        // call at most, and an outage degrades to a warning (CORE-2590).
        const lookup = lookupIssue(issueRef, deps);
        if (lookup.state === 'missing') {
            return deny(
                `the marker names ${issueRef}, and Substrate has no such Issue; fix the marker before merging`,
                { head, issueRef, issueLookup: 'missing', ...reviewInfo },
                markerGuidance(issueRef),
            );
        }
        if (lookup.state === 'unknown') {
            return allow(
                `xtrm-reviewer[bot] approved the current head; ${issueRef} could not be verified (${lookup.detail}), so the merge is allowed`,
                { head, issueRef, issueLookup: 'unknown', issueLookupDetail: lookup.detail, ...reviewInfo },
            );
        }
        return allow('xtrm-reviewer[bot] approved the current head', {
            head, issueRef, issueLookup: 'verified', ...reviewInfo,
        });
    }
    if (latest.state !== 'COMMENTED' && latest.state !== 'COMMENT') {
        return deny(`the reviewer App's latest review state ${latest.state} does not allow a merge`, { head, issueRef, ...reviewInfo });
    }

    // PARTIAL: a coordinator decision entry at this head, after the review.
    if (!issueRef) {
        return deny('the PR names no Substrate Issue in a marker, so a PARTIAL review cannot be accepted',
            { head, issueRef, ...reviewInfo }, markerGuidance());
    }
    const run = deps.runSb ?? defaultRunSb();
    let entries: JournalEntry[] = [];
    try {
        const listed = run('sb', ['journal', 'show', issueRef, '--json'], {});
        entries = journalEntries(listed.stdout);
    } catch {
        return deny(`cannot read the Journal of ${issueRef}; the guard fails closed`, { head, issueRef, ...reviewInfo });
    }
    const reviewAt = Date.parse(latest.submitted_at ?? '') || 0;
    const decision = findValidDecision(entries, { head, pr: input.pr, reviewAt, prWorker: marker?.holder ?? null });
    if (!decision) {
        return deny(
            `the review at head ${sha12(head)} is a COMMENT (PARTIAL) and ${issueRef} has no coordinator decision for this head`,
            { head, issueRef, ...reviewInfo },
        );
    }
    return allow(`xtrm-reviewer[bot] reviewed head ${sha12(head)} as PARTIAL and ${issueRef} accepts the findings`, {
        head, issueRef, ...reviewInfo,
    });
}

/**
 * Every review on the PR, following `Link: rel="next"`. A review list that stops
 * at the first page can hide the latest review of a long PR, and the guard would
 * then decide on a stale one.
 */
async function listReviews(repo: string, pr: number, deps: MergeGuardDeps): Promise<ReviewResponse[] | null> {
    const out: ReviewResponse[] = [];
    let page = 1;
    for (; page <= 10; page += 1) {
        const listed = await githubRequest<ReviewResponse[]>({
            method: 'GET',
            path: `/repos/${repo}/pulls/${pr}/reviews?per_page=100&page=${page}`,
        }, deps);
        if (listed.status !== 200 || !Array.isArray(listed.data)) return null;
        out.push(...listed.data);
        if (listed.data.length < 100) break;
    }
    return out;
}

/**
 * The override path: honoured only for the coordinator role and the operator
 * identity. Returns the decision to use (the caller printed the refusal first).
 * Every honoured use writes a log line and, when the Issue is resolvable, a
 * Journal decision entry.
 */
export async function applyOverride(
    refusal: MergeDecision,
    deps: MergeGuardDeps,
): Promise<MergeDecision> {
    const env = deps.env ?? process.env;
    const map = deps.roleMap === undefined ? DEFAULT_ROLE_MAP : deps.roleMap;
    // `role === null` conflated the operator with an unknown/unmapped role: the
    // operator may override, a hand-set unknown role may not (CORE-2528 delta M3).
    const { role, source } = explainAgentRole(env, map);
    const reason = (env[OVERRIDE_ENV_VAR] ?? '').trim();
    if (!reason) return refusal;
    const mayOverride = source === 'operator' || role === 'coordinator';
    if (!mayOverride) {
        const who = source === 'unknown'
            ? `an unresolved role (${(env.XTRM_ROLE ?? '').trim() || 'no role'} is not a role or a mapped specialist)`
            : `role ${role}`;
        return { ...refusal, reason: `${refusal.reason} (override refused: ${who} may not override the merge guard)` };
    }
    // An override needs a head to record: the log line and the Journal receipt both
    // name it, and an unpinned merge would leave an audit entry nobody can tie to a
    // commit. There is no case where the merge pins the head by itself.
    if (!refusal.head) {
        const why = 'the reviewed head could not be resolved, so the override is refused';
        return {
            ...refusal,
            reason: `${refusal.reason} (override refused: ${why})`,
            message: `merge refused for ${refusal.repo}#${refusal.pr}: ${why}`,
        };
    }
    const actorRole = source === 'operator' ? 'operator' : String(role);
    const log = appendOverrideLog(deps, {
        holder: (env.SUBSTRATE_HOLDER ?? '').trim() || 'operator',
        role: actorRole,
        repo: refusal.repo,
        pr: refusal.pr,
        head: refusal.head ?? '',
        reason,
    });
    const logged = log.ok;
    let journaled = false;
    let error: string | undefined = log.error;
    if (refusal.issueRef) {
        const run = deps.runSb ?? defaultRunSb();
        const semantic = JSON.stringify({
            summary: `merge guard override: ${reason}`,
            head: refusal.head ? sha12(refusal.head) : '',
            pr: refusal.pr,
            override: true,
        });
        const result = run('sb', ['journal', 'append', refusal.issueRef, '--kind', 'decision', '--semantic', semantic, '--json'], {});
        journaled = result.status === 0;
        if (!journaled) {
            const journalError = result.stderr.trim() || `sb exited ${result.status}`;
            error = error ? `${error}; ${journalError}` : journalError;
        }
    } else {
        const notJournaled = 'no resolvable Issue, so the override was not journaled';
        error = error ? `${error}; ${notJournaled}` : notJournaled;
    }
    if (!logged && !journaled) {
        // An override nobody can audit is worse than a refusal: the operator has
        // no record of who bypassed the guard, and the caller would read "allowed".
        return {
            ...refusal,
            reason: `${refusal.reason} (override refused: the audit trail failed — log and Journal both failed${error ? `: ${error}` : ''})`,
            message: `merge refused for ${refusal.repo}#${refusal.pr}: ${OVERRIDE_ENV_VAR} was set, but the audit trail failed${error ? ` (${error})` : ''}`,
        };
    }
    return {
        ...refusal,
        allow: true,
        reason: `override honoured (${actorRole}): ${reason}`,
        override: { reason, logged, journaled, error },
        message: `merge allowed for ${refusal.repo}#${refusal.pr} by ${OVERRIDE_ENV_VAR}: ${reason}`,
    };
}

/**
 * CORE-2611: the merge receipt's project, resolved from the Issue ref through
 * one read-only `sb project list --json`. Same rule as the review receipt: an
 * unresolved project leaves the argv untouched rather than guessing.
 */
function receiptProject(
    input: { repo: string; issueRef: string },
    run: RunFn,
): string | null {
    try {
        const listed = run('sb', ['project', 'list', '--json'], { timeout: ISSUE_LOOKUP_TIMEOUT_MS });
        if (listed.status !== 0) return null;
        return pickReceiptProject(parseProjectList(listed.stdout), input);
    } catch {
        return null;
    }
}

/** After a successful merge: append the `github-merge` ref to the Issue's Journal. */
export function recordMerge(
    input: { repo: string; pr: number; head: string; issueRef: string },
    deps: MergeGuardDeps,
): { ok: boolean; error?: string } {
    const env = deps.env ?? process.env;
    const run = deps.runSb ?? defaultRunSb();
    const refs = JSON.stringify([{
        kind: 'github-merge',
        key: `https://github.com/${input.repo}/pull/${input.pr}`,
        value: { repo: input.repo, pr: input.pr, head: input.head, actor: `${env.SUBSTRATE_HOLDER ?? ''}`.trim() || 'operator' },
    }]);
    // Bounded result fields only (a live run rejected `head`/`pr`): the SHA and the PR
    // stay in the summary and in the github-merge ref, which carry them as data.
    const args = ['journal', 'append', input.issueRef, '--kind', 'result',
        '--result', JSON.stringify({
            summary: `merged ${input.repo}#${input.pr} at ${sha12(input.head)}`,
            outcome: 'merged',
            findings: [`head ${input.head}`],
            artifactRefs: [`https://github.com/${input.repo}/pull/${input.pr}`],
        }),
        '--refs', refs, '--json'];
    const result = run('sb', withReceiptProject(args, receiptProject(input, run)), {});
    if (result.status === 0) return { ok: true };
    // CORE-2606: the same diagnostics the review receipt uses. `sb --json` puts its
    // refusal on STDOUT, so a stderr-only message reads "sb exited 1" with no reason.
    return {
        ok: false,
        error: describeSbFailure({
            binary: deps.sbBinary ?? resolveSbBinary(env),
            status: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
        }),
    };
}

