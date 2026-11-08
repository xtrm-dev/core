/**
 * Formal review posting, pinned to the reviewed head (CORE-2528).
 *
 * One posting path for every Claude-side reviewer: the `gh` shim reaches this
 * module, and it posts through the REST create-review call with `commit_id` set
 * to the head the reviewer read. `gh pr review` has no commit flag, which is why
 * the pinning cannot be delegated to the CLI.
 *
 * Contract highlights:
 * - PASS = APPROVE, PARTIAL = COMMENT, FAIL = REQUEST_CHANGES.
 * - Refuse when the PR head moved after the reviewer read it.
 * - Refuse a review by the holder who opened the PR (own-PR refusal).
 * - On each new head dismiss the App's own stale CHANGES_REQUESTED, naming the
 *   new head, then post the new review.
 * - Reviews carry a body only: no inline comments are ever sent, so no
 *   unresolved thread can block a merge.
 * - The MODEL writes line 1 (`Review by <role> (<model>) at head <sha12>`) and
 *   exactly one `- Verdict:` line; the tool refuses a body without them and adds
 *   the hidden line-2 marker (agent, run, Issue). Attribution is never typed by
 *   the model, and the head/model/verdict are derived from its text, not flags.
 */

import { githubRequest, type GitHubRequestDeps } from './github-apps.js';

export type ReviewOutcome = 'PASS' | 'PARTIAL' | 'FAIL';
export type ReviewVerdict = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export const OUTCOME_TO_EVENT: Record<ReviewOutcome, ReviewVerdict> = {
    PASS: 'APPROVE',
    PARTIAL: 'COMMENT',
    FAIL: 'REQUEST_CHANGES',
};

/** `gh pr review` flags -> review event. Exactly one flag must be given. */
export function eventForFlags(flags: { approve?: boolean; requestChanges?: boolean; comment?: boolean }): ReviewVerdict | null {
    const chosen = [
        flags.approve ? 'APPROVE' : null,
        flags.requestChanges ? 'REQUEST_CHANGES' : null,
        flags.comment ? 'COMMENT' : null,
    ].filter(Boolean) as ReviewVerdict[];
    return chosen.length === 1 ? chosen[0] : null;
}

export function eventForOutcome(outcome: string | null | undefined): ReviewVerdict | null {
    const key = (outcome ?? '').trim().toUpperCase() as ReviewOutcome;
    return OUTCOME_TO_EVENT[key] ?? null;
}

export function sha12(sha: string): string {
    return sha.trim().slice(0, 12);
}

// The role part allows spaces: the Claude mirror signs as `reviewer subagent`.
const LINE1 = /^Review by ([A-Za-z][A-Za-z0-9 -]*) \((\S.*)\) at head ([0-9a-f]{7,40})$/;
// Column 0 only: the lint (`grep -Ec '^- Verdict:'`) and this parser must agree,
// so an indented line is refused by both instead of passing one and failing the other.
const VERDICT_LINE = /^- Verdict: (PASS|PARTIAL|FAIL)\s*$/;

/** The header the MODEL writes on line 1: role, model and the reviewed head. */
export interface ParsedHeader { role: string; model: string; head12: string }

/**
 * Parse line 1 of a review body. The model writes it, the shim reads it: the
 * head it reviewed and the model it ran on are derived from the text, never
 * from a flag or an environment variable.
 */
export function parseHeaderLine(body: string): ParsedHeader | null {
    const first = (body.split('\n')[0] ?? '').trim();
    const match = LINE1.exec(first);
    if (!match) return null;
    return { role: match[1], model: match[2].trim(), head12: match[3].toLowerCase() };
}

/** Every `- Verdict:` line in the body, in order. Exactly one is required. */
export function bodyVerdicts(body: string): ReviewVerdict[] {
    const out: ReviewVerdict[] = [];
    for (const line of body.split('\n')) {
        const match = VERDICT_LINE.exec(line);
        if (match) out.push(OUTCOME_TO_EVENT[match[1] as ReviewOutcome]);
    }
    return out;
}

/** The hidden marker the TOOL adds on line 2 (agent, run, Issue). */
export function buildMarker(input: { holder: string; runId: string; issueRef?: string | null; activationId?: string | null }): string {
    const parts = [
        `agent=${input.holder}`,
        `run=${input.runId}`,
        ...(input.issueRef ? [`issue=${input.issueRef}`] : []),
        ...(input.activationId ? [`activation=${input.activationId}`] : []),
    ];
    return `<!-- ${parts.join(' ')} -->`;
}

/**
 * The pre-post lint over the MODEL's body: line 1 is the header, the body holds
 * exactly one `- Verdict:` line, and no self-written marker is allowed (the
 * tool owns attribution). Returns the reason, or null when it passes.
 */
export function lintModelBody(body: string): string | null {
    const header = parseHeaderLine(body);
    if (!header) return 'review body line 1 must be "Review by <role> (<model>) at head <sha12>"';
    const rest = body.split('\n').slice(1).join('\n');
    if (/<!--/.test(rest)) {
        return 'the review body must not carry a hidden marker: the tool writes it (agent, run, Issue)';
    }
    const verdicts = bodyVerdicts(body);
    if (verdicts.length === 0) return 'the review body needs exactly one "- Verdict: PASS|PARTIAL|FAIL" line, found none';
    if (verdicts.length > 1) return `the review body needs exactly one "- Verdict:" line, found ${verdicts.length}`;
    return null;
}

export interface IssueMarker { issue?: string; holder?: string; run?: string }

/** The hidden `<!-- xtrm issue=<REF> holder=<holder> run=<id> -->` marker. */
export function parseIssueMarker(text: string): IssueMarker | null {
    const match = /<!--[^>]*?xtrm\b([^>]*?)-->/.exec(text ?? '');
    if (!match) return null;
    const out: IssueMarker = {};
    for (const [key, value] of match[1].trim().split(/\s+/).map((part) => {
        const index = part.indexOf('=');
        return index > 0 ? [part.slice(0, index), part.slice(index + 1)] as const : null;
    }).filter((entry): entry is readonly [string, string] => entry !== null)) {
        if (key === 'issue') out.issue = value;
        else if (key === 'holder') out.holder = value;
        else if (key === 'run') out.run = value;
    }
    return out.issue || out.holder || out.run ? out : null;
}

/** Branch names such as `issue/CORE-2309-...` or `xt/MMD-1234` carry the ref. */
export const ISSUE_REF_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

/** True only for a ref safe to pass to `sb` as an argument (no leading dash). */
export function isSafeIssueRef(ref: string | null | undefined): boolean {
    return ISSUE_REF_PATTERN.test((ref ?? '').trim());
}

export function issueRefFromBranch(ref: string | null | undefined): string | null {
    const match = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9}-\d+)(?![0-9])/.exec(ref ?? '');
    return match ? match[1] : null;
}

export interface PostReviewInput {
    repo: string;
    pr: number;
    /**
     * The MODEL's review body: line 1 is `Review by <role> (<model>) at head
     * <sha12>`, the findings follow, and exactly one `- Verdict:` line is
     * present. The tool adds the hidden marker; the model must not.
     */
    body: string;
    holder: string;
    runId: string;
    /** Fallbacks when the PR carries no marker; the header's role wins otherwise. */
    role?: string | null;
    issueRef?: string | null;
    activationId?: string | null;
    /** Optional cross-checks; a disagreement is refused, never resolved silently. */
    expectedHead?: string | null;
    expectedVerdict?: ReviewVerdict | null;
    expectedModel?: string | null;
}

export interface PostedReview {
    id: number;
    url: string;
    verdict: ReviewVerdict;
    /** GitHub's review state (APPROVE posts as APPROVED). */
    state: string;
    /** Full reviewed head SHA. */
    head: string;
    issueRef: string | null;
    dismissed: number[];
    warnings: string[];
}

export class ReviewRefused extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReviewRefused';
    }
}

export interface ReviewDeps extends GitHubRequestDeps {
    /** App slug, for the bot login (`<slug>[bot]`). */
    slug: string;
}

type PullResponse = {
    number?: number;
    body?: string | null;
    state?: string;
    head?: { sha?: string; ref?: string };
};
type CommitResponse = { sha?: string };
type ReviewResponse = {
    id?: number; state?: string; user?: { login?: string }; html_url?: string; commit_id?: string;
};

/** Full SHA for a 7-40 hex prefix among the PR's commits, or null. */
async function resolveHead(repo: string, pr: number, prefix: string, deps: ReviewDeps): Promise<string | null> {
    if (prefix.length >= 40) return prefix;
    const listed = await githubRequest<CommitResponse[]>({
        method: 'GET',
        path: `/repos/${repo}/pulls/${pr}/commits?per_page=100`,
    }, deps);
    if (listed.status === 200 && Array.isArray(listed.data)) {
        const hit = listed.data.find((commit) => (commit.sha ?? '').toLowerCase().startsWith(prefix));
        if (hit?.sha) return hit.sha;
    }
    return null;
}

/**
 * Post one formal review. Everything the pinning needs is derived from the
 * model's body: line 1 names the reviewed head and the model, the `- Verdict:`
 * line names the event. A flag or env value that disagrees is refused.
 */
export async function postReview(input: PostReviewInput, deps: ReviewDeps): Promise<PostedReview> {
    const warnings: string[] = [];
    const lint = lintModelBody(input.body);
    if (lint) throw new ReviewRefused(`review body refused by the lint: ${lint}`);
    const header = parseHeaderLine(input.body)!;
    const verdict = bodyVerdicts(input.body)[0];
    if (!verdict) throw new ReviewRefused('review body has no "- Verdict:" line');

    if (input.expectedModel && input.expectedModel !== header.model) {
        throw new ReviewRefused(`--model says ${input.expectedModel}, line 1 says ${header.model}; line 1 is authoritative`);
    }
    if (input.expectedVerdict && input.expectedVerdict !== verdict) {
        throw new ReviewRefused(`the flag requests ${input.expectedVerdict}, the body's verdict line says ${verdict}`);
    }

    const pull = await githubRequest<PullResponse>({ method: 'GET', path: `/repos/${input.repo}/pulls/${input.pr}` }, deps);
    if (pull.status !== 200) {
        throw new ReviewRefused(`cannot read PR #${input.pr} in ${input.repo} (HTTP ${pull.status})`);
    }
    const currentHead = (pull.data.head?.sha ?? '').toLowerCase();
    if (!currentHead) throw new ReviewRefused(`PR #${input.pr} returned no head SHA`);
    if (input.expectedHead && !input.expectedHead.toLowerCase().startsWith(header.head12) && !currentHead.startsWith(input.expectedHead.toLowerCase())) {
        throw new ReviewRefused(`the supplied head ${sha12(input.expectedHead)} does not match line 1 (${header.head12})`);
    }
    const resolved = await resolveHead(input.repo, input.pr, header.head12, deps)
        ?? (currentHead.startsWith(header.head12) ? currentHead : null);
    if (!resolved) {
        throw new ReviewRefused(`reviewed head ${header.head12} is not among the commits of PR #${input.pr}; review the current head`);
    }
    if (resolved !== currentHead) {
        throw new ReviewRefused(
            `PR head moved: reviewed ${sha12(resolved)}, current ${sha12(currentHead)} — review the current head`,
        );
    }

    const marker = parseIssueMarker(pull.data.body ?? '');
    if (marker?.holder && marker.holder === input.holder) {
        throw new ReviewRefused(`refusing own-PR review: PR #${input.pr} was opened by holder ${input.holder}`);
    }
    const candidate = input.issueRef ?? marker?.issue ?? issueRefFromBranch(pull.data.head?.ref) ?? null;
    // A ref from the PR body is attacker-controlled text on its way to `sb`.
    if (candidate && !isSafeIssueRef(candidate)) {
        throw new ReviewRefused(`the Issue ref '${candidate}' is not a Substrate ref (expected e.g. CORE-2528); refusing to journal it`);
    }
    const issueRef = candidate;
    if (!issueRef) warnings.push('no Substrate Issue ref in the PR body or branch; the review is not journaled');

    const lines = input.body.split('\n');
    const line1 = (lines[0] ?? '').trim();
    const rest = lines.slice(1).join('\n').trim();
    const body = `${line1}\n\n${buildMarker({ holder: input.holder, runId: input.runId, issueRef, activationId: input.activationId })}\n${rest}\n`;

    // GitHub rejects a review body over 65536 characters; refuse here with a
    // useful number instead of letting 422 lose the dismissal ordering.
    const MAX_BODY = 65536;
    if (body.length > MAX_BODY) {
        throw new ReviewRefused(`the review body is ${body.length} characters; GitHub's limit is ${MAX_BODY} — shorten it and re-post`);
    }

    // Post FIRST: a failed post must not leave the earlier block dismissed with a
    // message that claims a replacement exists (CORE-2528 rev 4 F5).
    const created = await githubRequest<ReviewResponse>({
        method: 'POST',
        path: `/repos/${input.repo}/pulls/${input.pr}/reviews`,
        body: { commit_id: resolved, event: verdict, body },
    }, deps);
    if (created.status !== 200 && created.status !== 201) {
        throw new ReviewRefused(`review post refused (HTTP ${created.status})`);
    }
    const url = created.data.html_url ?? `https://github.com/${input.repo}/pull/${input.pr}`;
    const dismissed = await dismissStaleChangesRequested(
        { repo: input.repo, pr: input.pr, head: resolved, postedId: created.data.id ?? 0 },
        deps,
        `${deps.slug}[bot]`,
        warnings,
    );
    return {
        id: created.data.id ?? 0,
        url,
        verdict,
        state: created.data.state ?? (verdict === 'APPROVE' ? 'APPROVED' : verdict === 'COMMENT' ? 'COMMENTED' : 'CHANGES_REQUESTED'),
        head: resolved,
        issueRef: issueRef ?? null,
        dismissed,
        warnings,
    };
}

async function dismissStaleChangesRequested(
    input: { repo: string; pr: number; head: string; postedId: number },
    deps: ReviewDeps,
    botLogin: string,
    warnings: string[],
): Promise<number[]> {
    const reviews: ReviewResponse[] = [];
    for (let page = 1; page <= 10; page += 1) {
        const listed = await githubRequest<ReviewResponse[]>({
            method: 'GET',
            path: `/repos/${input.repo}/pulls/${input.pr}/reviews?per_page=100&page=${page}`,
        }, deps);
        if (listed.status !== 200 || !Array.isArray(listed.data)) {
            warnings.push(`could not list reviews to dismiss a stale change request (HTTP ${listed.status})`);
            break;
        }
        reviews.push(...listed.data);
        if (listed.data.length < 100) break;
    }
    const dismissed: number[] = [];
    for (const review of reviews) {
        if (review.state !== 'CHANGES_REQUESTED') continue;
        if (review.user?.login !== botLogin) continue;
        if (typeof review.id !== 'number' || review.id === input.postedId) continue;
        const response = await githubRequest({
            method: 'PUT',
            path: `/repos/${input.repo}/pulls/${input.pr}/reviews/${review.id}/dismissals`,
            body: { message: `Superseded by a review at head ${sha12(input.head)}` },
        }, deps);
        if (response.status === 200 || response.status === 204) dismissed.push(review.id);
        else warnings.push(`could not dismiss stale review ${review.id} (HTTP ${response.status})`);
    }
    return dismissed;
}

/** The Journal receipt: a `github-review` ref plus a bounded result payload. */
export function reviewJournalArgs(receipt: PostedReview, input: PostReviewInput, issueRef: string, slug?: string | null): string[] {
    const refs = JSON.stringify([{
        kind: 'github-review',
        key: receipt.url,
        value: {
            repo: input.repo,
            pr: input.pr,
            head: receipt.head,
            actor: slug ? `${slug}[bot]` : input.holder,
        },
    }]);
    const result = JSON.stringify({
        summary: `Review ${receipt.verdict} at head ${sha12(receipt.head)} for ${input.repo}#${input.pr}`,
        verdict: receipt.verdict,
        head: receipt.head,
        artifact: { kind: 'review', head: receipt.head, verdict: receipt.verdict, url: receipt.url },
    });
    return ['journal', 'append', issueRef, '--kind', 'result', '--result', result, '--refs', refs, '--json'];
}
