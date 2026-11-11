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
 *   line 2, the VISIBLE attribution (`Agent <name> · run <id> · Issue <REF>`),
 *   followed by the hidden marker. Attribution is never typed by the model, and
 *   the head/model/verdict are derived from its text, not flags.
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

/** The hidden marker the TOOL adds under the visible attribution (line 3). */
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
 * A name safe for the visible attribution line: control characters become
 * spaces, runs collapse, the result is bounded. The line is written by the tool,
 * but the name it carries comes from the environment, so treat it as untrusted.
 */
export function sanitizeAgentName(value: string | null | undefined, max = 96): string | null {
    const cleaned = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned ? cleaned.slice(0, max) : null;
}

export interface AttributionInput {
    /** The full agent name (`<repo>-xt-<runtime>-<name>`), when the launcher gave one. */
    agentName?: string | null;
    /** `SUBSTRATE_HOLDER`, the fallback name. */
    holder?: string | null;
    runId?: string | null;
    issueRef?: string | null;
    activationId?: string | null;
}

/**
 * Line 2 of every posted review (CORE-2606): the attribution a human can read.
 * `XTRM_AGENT_NAME` wins over `SUBSTRATE_HOLDER`; `XTRM_SESSION_NAME` is never
 * read (it names the tmux session, not the agent). Every absent field degrades
 * by omission, so an incomplete environment never produces "undefined".
 */
export function buildAttribution(input: AttributionInput, env: NodeJS.ProcessEnv = process.env): string {
    const agent = sanitizeAgentName(input.agentName)
        ?? sanitizeAgentName(env.XTRM_AGENT_NAME)
        ?? sanitizeAgentName(input.holder);
    const parts: string[] = [];
    if (agent) parts.push(`Agent ${agent}`);
    const runId = sanitizeAgentName(input.runId, 96);
    if (runId) parts.push(`run ${runId}`);
    const issueRef = sanitizeAgentName(input.issueRef, 96);
    if (issueRef) parts.push(`Issue ${issueRef}`);
    const activationId = sanitizeAgentName(input.activationId, 96);
    if (activationId) parts.push(`activation ${activationId}`);
    return parts.join(' · ');
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

// A marker is an xtrm comment whose content STARTS with `xtrm`, and only a marker
// that carries `issue=` counts (CORE-2590 review findings 1 and 3): a later comment
// such as `<!-- see xtrm-tools run=9 -->` must not displace the real marker, and a
// holder-only comment names no Issue, so it is ignored rather than selected as the
// last one.
const XTRM_MARKER = /<!--[ \t]*xtrm[ \t]+([^>]*?)-->/g;

function markerAttributes(attributes: string): IssueMarker {
    const out: IssueMarker = {};
    for (const part of attributes.trim().split(/\s+/)) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        const key = part.slice(0, index);
        const value = part.slice(index + 1);
        if (key === 'issue') out.issue = value;
        else if (key === 'holder') out.holder = value;
        else if (key === 'run') out.run = value;
    }
    return out;
}

/** A fence opens with up to 3 spaces, then 3+ backticks or 3+ tildes. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A fence closes on the same character, at least as long, with nothing else. */
const FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/;

/**
 * Every valid marker, in body order. A marker inside a fenced code block or on a
 * `>` quote line is pasted text, not a declaration, so it is not a marker: either
 * is a way to make a fake ref look like the real one (CORE-2590).
 *
 * Fences follow CommonMark rather than a toggle (CORE-2590 review finding 2): a
 * fence closes only on the same character with at least the opening length, so a
 * 4-backtick block that contains a 3-backtick line does not leak its content, and
 * a `~~~` line cannot close a ``` block.
 */
export function parseIssueMarkers(text: string): IssueMarker[] {
    const out: IssueMarker[] = [];
    let fence: { char: string; length: number } | null = null;
    // CRLF: a GitHub-web-editor body keeps a `\r` on every line, and a `$`-anchored
    // fence pattern would then never match (review 5853004574, finding A).
    for (const line of (text ?? '').split(/\r?\n/)) {
        if (fence) {
            const close = line.match(FENCE_CLOSE);
            if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
            continue;
        }
        const open = line.match(FENCE_OPEN);
        // A backtick fence's info string may not contain a backtick (CommonMark).
        if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
            fence = { char: open[1][0], length: open[1].length };
            continue;
        }
        if (/^\s*>/.test(line)) continue;
        for (const match of line.matchAll(XTRM_MARKER)) {
            const marker = markerAttributes(match[1]);
            if (marker.issue) out.push(marker);
        }
    }
    return out;
}

/**
 * The hidden `<!-- xtrm issue=<REF> holder=<holder> run=<id> -->` marker. The
 * LAST valid marker wins: a body may be appended to, and only the final
 * declaration speaks for the PR (CORE-2590).
 */
export function parseIssueMarker(text: string): IssueMarker | null {
    const markers = parseIssueMarkers(text);
    return markers.length ? markers[markers.length - 1] : null;
}

/** The ref format a Substrate Issue uses: an upper-case key, a dash and digits. */
export const ISSUE_REF_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

/** True only for a ref safe to pass to `sb` as an argument (no leading dash). */
export function isSafeIssueRef(ref: string | null | undefined): boolean {
    return ISSUE_REF_PATTERN.test((ref ?? '').trim());
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
    /** Visible attribution name; default: `XTRM_AGENT_NAME`, then the holder. */
    agentName?: string | null;
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
    // No marker, no attribution: there is nothing to compare the reviewer's holder
    // against, and the PR names no Issue (CORE-2528 rev 4 R2).
    if (!marker) {
        throw new ReviewRefused(
            `PR #${input.pr} carries no xtrm marker in its body (<!-- xtrm issue=<REF> holder=<holder> run=<id> -->); refusing to post an unattributable review`,
        );
    }
    // No holder in the marker means the own-PR comparison cannot be made at all:
    // refuse rather than post a review that may be of the reviewer's own PR.
    if (!marker.holder) {
        throw new ReviewRefused(
            `PR #${input.pr} has an xtrm marker without holder=, so an own-PR review cannot be excluded; ask the opener to add holder= to the marker`,
        );
    }
    if (marker.holder === input.holder) {
        throw new ReviewRefused(`refusing own-PR review: PR #${input.pr} was opened by holder ${input.holder}`);
    }
    // The marker is the only Issue source: a branch name such as `fix/UTF-8-parser`
    // matched the ref format and became a fake Issue (CORE-2590).
    const candidate = input.issueRef ?? marker.issue ?? null;
    // A ref from the PR body is attacker-controlled text on its way to `sb`.
    if (candidate && !isSafeIssueRef(candidate)) {
        throw new ReviewRefused(`the Issue ref '${candidate}' is not a Substrate ref (expected e.g. CORE-2528); refusing to journal it`);
    }
    const issueRef = candidate;
    if (!issueRef) warnings.push('no Substrate Issue ref in the PR body; the review is not journaled');

    const lines = input.body.split('\n');
    const line1 = (lines[0] ?? '').trim();
    const rest = lines.slice(1).join('\n').trim();
    // Line 2 is the visible attribution; the hidden marker follows it (format
    // unchanged) so existing readers keep working. An empty attribution degrades
    // to the marker alone rather than to a blank line that looks like a bug.
    // The ref may come from the PR marker rather than the input, so pass the
    // resolved one: the line must name the Issue the receipt will journal.
    const attribution = buildAttribution({ ...input, issueRef });
    const hiddenMarker = buildMarker({ holder: input.holder, runId: input.runId, issueRef, activationId: input.activationId });
    const body = attribution
        ? `${line1}\n${attribution}\n${hiddenMarker}\n\n${rest}\n`
        : `${line1}\n${hiddenMarker}\n\n${rest}\n`;

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
    // Only the bounded result fields are accepted (summary|attempted|outcome|completed|
    // validation|findings|artifactRefs|receiptRefs|provenanceRefs): a live run rejected
    // `verdict`/`head`/`artifact`. The head and the verdict stay legible in the summary
    // and in the github-review ref below, which carries them as structured data.
    const result = JSON.stringify({
        summary: `Review ${receipt.verdict} at head ${sha12(receipt.head)} for ${input.repo}#${input.pr}`,
        outcome: `review ${receipt.verdict}`,
        validation: [`posted by ${input.role}${slug ? ` app ${slug}` : ''} at head ${sha12(receipt.head)}`],
        artifactRefs: [receipt.url],
        findings: [`verdict ${receipt.verdict}`, `head ${receipt.head}`],
    });
    return ['journal', 'append', issueRef, '--kind', 'result', '--result', result, '--refs', refs, '--json'];
}
