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
 * CHANGES_REQUESTED, an unresolvable Issue, or GitHub/the App being unreachable.
 * The single escape hatch is `XTRM_MERGE_GUARD_OVERRIDE=<reason>`, honoured only
 * for the coordinator role and the operator identity; each use writes a log line
 * and a Journal decision entry.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { githubRequest, repoOwner, type FetchLike } from './github-apps.js';
import { processAgentRole, type AgentRole, type RoleMap, DEFAULT_ROLE_MAP } from './identity-roles.js';
import { issueRefFromBranch, parseIssueMarker, sha12, type ReviewVerdict } from './review-posting.js';

export const OVERRIDE_ENV_VAR = 'XTRM_MERGE_GUARD_OVERRIDE';

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
export type RunFn = (cmd: string, args: string[], opts: { input?: string }) => RunResult;

export interface MergeGuardDeps {
    /** Installation token for READS (the reviewer App: pull requests read/write, contents read). */
    token: string;
    fetch?: FetchLike;
    apiBase?: string;
    /** `sb` runner, injected for tests. */
    runSb?: RunFn;
    env?: NodeJS.ProcessEnv;
    roleMap?: RoleMap | null;
    /** Reviewer App slug; its bot login is `<slug>[bot]`. */
    reviewerSlug?: string;
    now?: () => number;
    stateHome?: string;
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
export function refusalMessage(input: { repo: string; pr: number; head?: string; reason: string }): string {
    const head = input.head ? sha12(input.head) : '(unknown head)';
    return [
        `merge refused for ${input.repo}#${input.pr}: ${input.reason}`,
        `a review by xtrm-reviewer[bot] is required at head ${head}`,
        'ways to get one:',
        ROUTING_HINT,
        `override (coordinator and operator only): ${OVERRIDE_ENV_VAR}=<reason>`,
    ].join('\n');
}

function defaultRunSb(): RunFn {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    return (cmd, args, opts) => {
        const result = spawnSync(cmd, args, { encoding: 'utf8', input: opts.input ?? undefined, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const stateHome = deps.stateHome
        ?? (deps.env?.XDG_STATE_HOME ?? '').trim()
        ?? path.join(os.homedir(), '.local', 'state');
    return path.join(stateHome || path.join(os.homedir(), '.local', 'state'), 'xtrm', 'merge-guard-override.log');
}

function appendOverrideLog(deps: MergeGuardDeps, line: Record<string, unknown>): boolean {
    try {
        const file = overrideLogPath(deps);
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...line })}\n`, { mode: 0o600 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Evaluate one merge. Never throws: a transport failure becomes a refusal so a
 * network problem cannot turn into a merge.
 */
export async function mergeCheck(input: { repo: string; pr: number }, deps: MergeGuardDeps): Promise<MergeDecision> {
    const env = deps.env ?? process.env;
    const role: AgentRole | null = processAgentRole(env, deps.roleMap === undefined ? DEFAULT_ROLE_MAP : deps.roleMap);
    const reviewerSlug = deps.reviewerSlug ?? 'xtrm-reviewer';
    const botLogin = `${reviewerSlug}[bot]`;
    const base = { repo: input.repo, pr: input.pr } as const;

    const deny = (reason: string, extra: Partial<MergeDecision> = {}): MergeDecision => ({
        allow: false,
        reason,
        ...base,
        ...extra,
        message: refusalMessage({ ...base, head: extra.head, reason }),
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
    const marker = parseIssueMarker(pull.body ?? '');
    const issueRef = marker?.issue ?? issueRefFromBranch(pull.head?.ref) ?? null;

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
        return allow('xtrm-reviewer[bot] approved the current head', { head, issueRef, ...reviewInfo });
    }
    if (latest.state !== 'COMMENTED' && latest.state !== 'COMMENT') {
        return deny(`the reviewer App's latest review state ${latest.state} does not allow a merge`, { head, issueRef, ...reviewInfo });
    }

    // PARTIAL: a coordinator decision entry at this head, after the review.
    if (!issueRef) {
        return deny('the PR names no Substrate Issue, so a PARTIAL review cannot be accepted', { head, issueRef, ...reviewInfo });
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
    const role = processAgentRole(env, deps.roleMap === undefined ? DEFAULT_ROLE_MAP : deps.roleMap);
    const reason = (env[OVERRIDE_ENV_VAR] ?? '').trim();
    if (!reason) return refusal;
    if (role !== null && role !== 'coordinator') {
        return { ...refusal, reason: `${refusal.reason} (override refused: role ${role} may not override the merge guard)` };
    }
    const logged = appendOverrideLog(deps, {
        holder: (env.SUBSTRATE_HOLDER ?? '').trim() || 'operator',
        role: role ?? 'operator',
        repo: refusal.repo,
        pr: refusal.pr,
        head: refusal.head ?? '',
        reason,
    });
    let journaled = false;
    let error: string | undefined;
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
        if (!journaled) error = result.stderr.trim() || `sb exited ${result.status}`;
    } else {
        error = 'no resolvable Issue, so the override was not journaled';
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
        reason: `override honoured (${role ?? 'operator'}): ${reason}`,
        override: { reason, logged, journaled, error },
        message: `merge allowed for ${refusal.repo}#${refusal.pr} by ${OVERRIDE_ENV_VAR}: ${reason}`,
    };
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
    const result = run('sb', ['journal', 'append', input.issueRef, '--kind', 'result',
        '--result', JSON.stringify({ summary: `merged ${input.repo}#${input.pr} at ${sha12(input.head)}`, head: input.head, pr: input.pr }),
        '--refs', refs, '--json'], {});
    if (result.status === 0) return { ok: true };
    return { ok: false, error: result.stderr.trim() || `sb exited ${result.status}` };
}

export { repoOwner };
