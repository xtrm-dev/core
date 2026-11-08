// CORE-2528: the pinned, attributed, idempotent review post. A fake GitHub
// proves the four refusals, the stale-review dismissal and the header contract.

import { describe, expect, it } from 'vitest';

import {
    buildReviewHeader,
    eventForFlags,
    eventForOutcome,
    issueRefFromBranch,
    lintReviewBody,
    parseIssueMarker,
    postReview,
    reviewJournalArgs,
    sha12,
    ReviewRefused,
    type PostReviewInput,
} from '../core/review-posting.js';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const ISSUE = 'CORE-2528';

type Call = { method: string; path: string; body?: unknown };

function fakeGitHub(routes: Record<string, { status: number; data: unknown } | ((call: Call) => { status: number; data: unknown })>) {
    const calls: Call[] = [];
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
        const path = url.replace('https://api.github.com', '');
        const call: Call = { method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body) : undefined };
        calls.push(call);
        const route = routes[`${call.method} ${path}`] ?? routes[`${call.method} ${path.split('?')[0]}`];
        if (!route) return { status: 404, json: async () => ({ message: `no route ${call.method} ${path}` }) };
        const result = typeof route === 'function' ? route(call) : route;
        return { status: result.status, json: async () => result.data };
    };
    return { calls, deps: { token: 'ghs_token', slug: 'xtrm-reviewer', apiBase: 'https://api.github.com', fetch } };
}

function pullBody(issue: string): string {
    return `Implements the change.\n\n<!-- xtrm issue=${issue} holder=core-2528-worker run=abc123 -->\n`;
}

function input(overrides: Partial<PostReviewInput> = {}): PostReviewInput {
    return {
        repo: 'xtrm-dev/core',
        pr: 42,
        head: HEAD,
        verdict: 'COMMENT',
        findings: 'One finding: the guard ignores the merge queue.',
        role: 'reviewer',
        model: 'sonnet',
        holder: 'core-worker-a',
        runId: 'run123',
        ...overrides,
    };
}

describe('verdict mapping', () => {
    it('maps outcome words and requires exactly one flag', () => {
        expect(eventForOutcome('PASS')).toBe('APPROVE');
        expect(eventForOutcome('partial')).toBe('COMMENT');
        expect(eventForOutcome('FAIL')).toBe('REQUEST_CHANGES');
        expect(eventForOutcome('nope')).toBeNull();
        expect(eventForFlags({ approve: true })).toBe('APPROVE');
        expect(eventForFlags({ requestChanges: true })).toBe('REQUEST_CHANGES');
        expect(eventForFlags({})).toBeNull();
        expect(eventForFlags({ approve: true, comment: true })).toBeNull();
    });
});

describe('header and lint', () => {
    const header = buildReviewHeader({ role: 'reviewer', model: 'sonnet', head: HEAD, holder: 'core-worker-a', runId: 'run123', issueRef: ISSUE });

    it('carries the head on line 1 and the markers on line 2', () => {
        const [first, blank, marker] = header.split('\n');
        expect(first).toBe(`Review by reviewer (sonnet) at head ${sha12(HEAD)}`);
        expect(blank).toBe('');
        expect(marker).toContain('agent=core-worker-a');
        expect(marker).toContain('run=run123');
        expect(marker).toContain(`issue=${ISSUE}`);
    });

    it('accepts a well formed body and refuses a missing marker, wrong holder or moved head', () => {
        const body = `${header}\nFindings.\n`;
        expect(lintReviewBody(body, { holder: 'core-worker-a', head: HEAD, issueRef: ISSUE, runId: 'run123' })).toBeNull();
        expect(lintReviewBody(`Review by reviewer (sonnet) at head ${sha12(HEAD)}\nFindings without a marker\n`, { holder: 'core-worker-a', head: HEAD, issueRef: ISSUE, runId: 'run123' }))
            .toMatch(/marker/);
        expect(lintReviewBody('Findings only', { holder: 'core-worker-a', head: HEAD, issueRef: ISSUE, runId: 'run123' }))
            .toMatch(/line 1/);
        expect(lintReviewBody(body, { holder: 'other', head: HEAD, issueRef: ISSUE, runId: 'run123' }))
            .toMatch(/holder/);
        expect(lintReviewBody(body, { holder: 'core-worker-a', head: 'f'.repeat(40), issueRef: ISSUE, runId: 'run123' }))
            .toMatch(/head/);
    });

    it('parses the PR marker and the branch convention', () => {
        expect(parseIssueMarker(pullBody('CORE-2528'))).toMatchObject({ issue: 'CORE-2528', holder: 'core-2528-worker', run: 'abc123' });
        expect(parseIssueMarker('nothing here')).toBeNull();
        expect(issueRefFromBranch('xt/worker-CORE-2528-github-apps')).toBe('CORE-2528');
        expect(issueRefFromBranch('main')).toBeNull();
        expect(issueRefFromBranch(null)).toBeNull();
    });
});

describe('postReview', () => {
    it('pins commit_id to the reviewed head, journals the Issue and dismisses the stale request', async () => {
        const github = fakeGitHub({
            [`GET /repos/xtrm-dev/core/pulls/42`]: { status: 200, data: { head: { sha: HEAD, ref: 'xt/some-branch' }, body: pullBody(ISSUE) } },
            [`GET /repos/xtrm-dev/core/pulls/42/reviews`]: {
                status: 200,
                data: [
                    { id: 7, state: 'CHANGES_REQUESTED', user: { login: 'xtrm-reviewer[bot]' }, commit_id: 'f'.repeat(40) },
                    { id: 8, state: 'APPROVED', user: { login: 'xtrm-reviewer[bot]' } },
                    { id: 9, state: 'CHANGES_REQUESTED', user: { login: 'a-human' } },
                ],
            },
            [`PUT /repos/xtrm-dev/core/pulls/42/reviews/7/dismissals`]: { status: 200, data: {} },
            [`POST /repos/xtrm-dev/core/pulls/42/reviews`]: {
                status: 201,
                data: { id: 55, state: 'APPROVED', html_url: 'https://github.com/xtrm-dev/core/pull/42#pullrequestreview-55' },
            },
        });
        const receipt = await postReview(input({ verdict: 'APPROVE' }), github.deps);
        expect(receipt).toMatchObject({
            id: 55,
            verdict: 'APPROVE',
            head: HEAD,
            issueRef: ISSUE,
            dismissed: [7],
            warnings: [],
        });
        const posted = github.calls.find((call) => call.method === 'POST');
        expect(posted?.body).toMatchObject({ commit_id: HEAD, event: 'APPROVE' });
        expect(JSON.stringify(posted?.body)).toContain(`head ${sha12(HEAD)}`);
        expect(github.calls.some((call) => call.path.endsWith('/reviews/9/dismissals'))).toBe(false);

        const journal = reviewJournalArgs(receipt, input({ verdict: 'APPROVE' }), ISSUE);
        expect(journal.slice(0, 3)).toEqual(['journal', 'append', ISSUE]);
        expect(journal).toContain('--kind');
        expect(journal).toContain('result');
        expect(journal.join(' ')).toContain('github-review');
        expect(journal.join(' ')).toContain('pullrequestreview-55');
    });

    it('refuses a review whose head is no longer the PR head', async () => {
        const github = fakeGitHub({
            [`GET /repos/xtrm-dev/core/pulls/42`]: { status: 200, data: { head: { sha: 'f'.repeat(40) }, body: pullBody(ISSUE) } },
        });
        await expect(postReview(input(), github.deps)).rejects.toBeInstanceOf(ReviewRefused);
        expect(github.calls.some((call) => call.method === 'POST')).toBe(false);
    });

    it('refuses to review the PR the same agent opened', async () => {
        const github = fakeGitHub({
            [`GET /repos/xtrm-dev/core/pulls/42`]: {
                status: 200,
                data: { head: { sha: HEAD }, body: `<!-- xtrm issue=${ISSUE} holder=core-worker-a run=run123 -->` },
            },
        });
        await expect(postReview(input(), github.deps)).rejects.toThrow(/own-PR/);
    });

    it('falls back to the branch for the Issue ref and warns when there is none', async () => {
        const withBranch = fakeGitHub({
            [`GET /repos/xtrm-dev/core/pulls/42`]: { status: 200, data: { head: { sha: HEAD, ref: 'xt/worker-CORE-2528-x' }, body: 'no marker' } },
            [`GET /repos/xtrm-dev/core/pulls/42/reviews`]: { status: 200, data: [] },
            [`POST /repos/xtrm-dev/core/pulls/42/reviews`]: { status: 201, data: { id: 1, html_url: 'u' } },
        });
        expect((await postReview(input(), withBranch.deps)).issueRef).toBe('CORE-2528');

        const orphan = fakeGitHub({
            [`GET /repos/xtrm-dev/core/pulls/42`]: { status: 200, data: { head: { sha: HEAD, ref: 'main' }, body: 'no marker' } },
            [`GET /repos/xtrm-dev/core/pulls/42/reviews`]: { status: 200, data: [] },
            [`POST /repos/xtrm-dev/core/pulls/42/reviews`]: { status: 201, data: { id: 1, html_url: 'u' } },
        });
        const receipt = await postReview(input(), orphan.deps);
        expect(receipt.issueRef).toBeNull();
        expect(receipt.warnings.join(' ')).toMatch(/not journaled/);
    });

    it('refuses rather than posting when GitHub refuses the review', async () => {
        const github = fakeGitHub({
            [`GET /repos/xtrm-dev/core/pulls/42`]: { status: 200, data: { head: { sha: HEAD }, body: pullBody(ISSUE) } },
            [`GET /repos/xtrm-dev/core/pulls/42/reviews`]: { status: 200, data: [] },
            [`POST /repos/xtrm-dev/core/pulls/42/reviews`]: { status: 422, data: { message: 'Unprocessable' } },
        });
        await expect(postReview(input(), github.deps)).rejects.toThrow(/HTTP 422/);
    });
});
