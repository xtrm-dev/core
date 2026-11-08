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
 * - Line 1 is `Review by <role> (<model>) at head <sha12>`; line 2 is the hidden
 *   marker with agent=, run= and the Issue ref.
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

export interface ReviewHeader {
    role: string;
    model: string;
    /** Full SHA; the header carries its first 12 characters. */
    head: string;
    holder: string;
    runId: string;
    issueRef?: string | null;
    activationId?: string | null;
}

export function sha12(sha: string): string {
    return sha.trim().slice(0, 12);
}

/** Line 1 + hidden marker line, as the review body must carry them. */
export function buildReviewHeader(input: ReviewHeader): string {
    const marker = [
        `agent=${input.holder}`,
        `run=${input.runId}`,
        ...(input.issueRef ? [`issue=${input.issueRef}`] : []),
        ...(input.activationId ? [`activation=${input.activationId}`] : []),
    ].join(' ');
    return `Review by ${input.role} (${input.model}) at head ${sha12(input.head)}\n\n<!-- ${marker} -->\n`;
}

const LINE1 = /^Review by ([A-Za-z][A-Za-z0-9-]*) \((.+)\) at head ([0-9a-f]{7,40})$/;
const MARKER = /<!--(.*?)-->/;

/**
 * The pre-post lint: a review body without the review line and the agent marker
 * is refused before any network call. Returns the reason, or null when it passes.
 */
export function lintReviewBody(
    body: string,
    expected: { holder: string; head: string; issueRef?: string | null; runId?: string | null },
): string | null {
    const lines = body.split('\n');
    const first = (lines[0] ?? '').trim();
    const line1 = LINE1.exec(first);
    if (!line1) {
        return 'review body line 1 must be "Review by <role> (<model>) at head <sha12>"';
    }
    const headerHead = line1[3];
    if (!expected.head.toLowerCase().startsWith(headerHead.toLowerCase())) {
        return `review body names head ${headerHead}, which is not the reviewed head ${sha12(expected.head)}`;
    }
    const markerLine = lines.find((line) => MARKER.test(line));
    const marker = markerLine ? (MARKER.exec(markerLine)?.[1] ?? '') : '';
    if (!marker) return 'review body needs the hidden marker on line 2 (<!-- agent=<holder> run=<id> -->)';
    if (!/(^|\s)agent=\S+/.test(marker)) return 'review marker is missing agent=<holder>';
    if (!/(^|\s)run=\S+/.test(marker)) return 'review marker is missing run=<id>';
    const holder = /(^|\s)agent=(\S+)/.exec(marker)?.[2];
    if (expected.holder && holder !== expected.holder) {
        return `review marker names agent ${holder ?? '(none)'}, not the posting holder ${expected.holder}`;
    }
    if (expected.runId && !new RegExp(`(^|\\s)run=${expected.runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(marker)) {
        return `review marker does not carry this run id (${expected.runId})`;
    }
    if (expected.issueRef && !new RegExp(`(^|\\s)issue=${expected.issueRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(marker)) {
        return `review marker does not carry the Issue ref ${expected.issueRef}`;
    }
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
export function issueRefFromBranch(ref: string | null | undefined): string | null {
    const match = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,9}-\d+)(?![0-9])/.exec(ref ?? '');
    return match ? match[1] : null;
}

export interface PostReviewInput {
    repo: string;
    pr: number;
    /** The head the reviewer read; the review is pinned to it. */
    head: string;
    verdict: ReviewVerdict;
    /** The reviewer's findings, without the header. */
    findings: string;
    role: string;
    model: string;
    holder: string;
    runId: string;
    issueRef?: string | null;
    activationId?: string | null;
}

export interface PostedReview {
    id: number;
    url: string;
    verdict: ReviewVerdict;
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
type ReviewResponse = { id?: number; state?: string; user?: { login?: string }; html_url?: string; commit_id?: string };

/** Post one formal review. Refuses (throws ReviewRefused) rather than posting an unpinned or self review. */
export async function postReview(input: PostReviewInput, deps: ReviewDeps): Promise<PostedReview> {
    const warnings: string[] = [];
    const pull = await githubRequest<PullResponse>({ method: 'GET', path: `/repos/${input.repo}/pulls/${input.pr}` }, deps);
    if (pull.status !== 200) {
        throw new ReviewRefused(`cannot read PR #${input.pr} in ${input.repo} (HTTP ${pull.status})`);
    }
    const headSha = pull.data.head?.sha ?? '';
    if (!headSha) throw new ReviewRefused(`PR #${input.pr} returned no head SHA`);
    if (headSha !== input.head) {
        throw new ReviewRefused(
            `PR head moved: reviewed ${sha12(input.head)}, current ${sha12(headSha)} — review the current head`,
        );
    }
    const marker = parseIssueMarker(pull.data.body ?? '');
    if (marker?.holder && marker.holder === input.holder) {
        throw new ReviewRefused(`refusing own-PR review: PR #${input.pr} was opened by holder ${input.holder}`);
    }
    const issueRef = input.issueRef ?? marker?.issue ?? issueRefFromBranch(pull.data.head?.ref);
    if (!issueRef) warnings.push('no Substrate Issue ref in the PR body or branch; the review is not journaled');

    const body = `${buildReviewHeader({ ...input, issueRef })}\n${input.findings.trim()}\n`;
    const lint = lintReviewBody(body, { holder: input.holder, head: input.head, issueRef, runId: input.runId });
    if (lint) throw new ReviewRefused(`review body refused by the pre-post lint: ${lint}`);

    const dismissed = await dismissStaleChangesRequested(input, deps, `${deps.slug}[bot]`);

    const created = await githubRequest<{ id?: number; html_url?: string }>({
        method: 'POST',
        path: `/repos/${input.repo}/pulls/${input.pr}/reviews`,
        body: { commit_id: input.head, event: input.verdict, body },
    }, deps);
    if (created.status !== 200 && created.status !== 201) {
        throw new ReviewRefused(`review post refused (HTTP ${created.status})`);
    }
    const url = created.data.html_url ?? `https://github.com/${input.repo}/pull/${input.pr}`;
    return {
        id: created.data.id ?? 0,
        url,
        verdict: input.verdict,
        head: input.head,
        issueRef,
        dismissed,
        warnings,
    };
}

async function dismissStaleChangesRequested(input: PostReviewInput, deps: ReviewDeps, botLogin: string): Promise<number[]> {
    const listed = await githubRequest<ReviewResponse[]>({
        method: 'GET',
        path: `/repos/${input.repo}/pulls/${input.pr}/reviews?per_page=100`,
    }, deps);
    if (listed.status !== 200 || !Array.isArray(listed.data)) return [];
    const dismissed: number[] = [];
    for (const review of listed.data) {
        if (review.state !== 'CHANGES_REQUESTED') continue;
        if (review.user?.login !== botLogin) continue;
        if (typeof review.id !== 'number') continue;
        const response = await githubRequest({
            method: 'PUT',
            path: `/repos/${input.repo}/pulls/${input.pr}/reviews/${review.id}/dismissals`,
            body: { message: `Superseded by a review at head ${sha12(input.head)}` },
        }, deps);
        if (response.status === 200 || response.status === 204) dismissed.push(review.id);
    }
    return dismissed;
}

/** The Journal receipt: a `github-review` ref plus a bounded result payload. */
export function reviewJournalArgs(receipt: PostedReview, input: PostReviewInput, issueRef: string): string[] {
    const refs = JSON.stringify([{
        kind: 'github-review',
        key: receipt.url,
        value: {
            repo: input.repo,
            pr: input.pr,
            head: input.head,
            actor: `${input.role} app`,
        },
    }]);
    const result = JSON.stringify({
        summary: `Review ${input.verdict} at head ${sha12(input.head)} for ${input.repo}#${input.pr}`,
        verdict: input.verdict,
        head: input.head,
        artifact: { kind: 'review', head: input.head, verdict: input.verdict, url: receipt.url },
    });
    return ['journal', 'append', issueRef, '--kind', 'result', '--result', result, '--refs', refs, '--json'];
}
