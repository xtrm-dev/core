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

export interface ReviewHeader {
    role: string;
    /** The model that produced the review, exactly as line 1 names it. */
    model: string;
    /** Full SHA; line 1 carries its first 12 characters. */
    head: string;
    holder: string;
    runId: string;
    issueRef?: string | null;
    activationId?: string | null;
}

export function sha12(sha: string): string {
    return sha.trim().slice(0, 12);
}

const LINE1 = /^Review by ([A-Za-z][A-Za-z0-9-]*) \((\S.*)\) at head ([0-9a-f]{7,40})$/;
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
        const match = VERDICT_LINE.exec(line.trim());
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
    const issueRef = input.issueRef ?? marker?.issue ?? issueRefFromBranch(pull.data.head?.ref);
    if (!issueRef) warnings.push('no Substrate Issue ref in the PR body or branch; the review is not journaled');

    const lines = input.body.split('\n');
    const line1 = (lines[0] ?? '').trim();
    const rest = lines.slice(1).join('\n').trim();
    const body = `${line1}\n\n${buildMarker({ holder: input.holder, runId: input.runId, issueRef, activationId: input.activationId })}\n${rest}\n`;

    const dismissed = await dismissStaleChangesRequested({ repo: input.repo, pr: input.pr, head: resolved }, deps, `${deps.slug}[bot]`);

    const created = await githubRequest<ReviewResponse>({
        method: 'POST',
        path: `/repos/${input.repo}/pulls/${input.pr}/reviews`,
        body: { commit_id: resolved, event: verdict, body },
    }, deps);
    if (created.status !== 200 && created.status !== 201) {
        throw new ReviewRefused(`review post refused (HTTP ${created.status})`);
    }
    const url = created.data.html_url ?? `https://github.com/${input.repo}/pull/${input.pr}`;
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

async function dismissStaleChangesRequested(input: { repo: string; pr: number; head: string }, deps: ReviewDeps, botLogin: string): Promise<number[]> {
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
            head: receipt.head,
            actor: 'reviewer app',
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
