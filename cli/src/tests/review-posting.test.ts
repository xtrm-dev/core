// CORE-2528: the pinned, attributed review post. The head, the model and the
// verdict are derived from the model's body (the shim reads what the reviewer
// wrote), and the tool adds the hidden marker. A fake GitHub proves every
// refusal without the Apps.

import { describe, expect, it } from 'vitest';

import {
    bodyVerdicts,
    buildMarker,
    eventForFlags,
    eventForOutcome,
    issueRefFromBranch,
    lintModelBody,
    parseHeaderLine,
    parseIssueMarker,
    postReview,
    reviewJournalArgs,
    sha12,
    ReviewRefused,
    type PostReviewInput,
} from '../core/review-posting.js';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER = '0123456789abcdef0123456789abcdef01234567';
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

/** The body the MODEL writes: line 1 header, findings, one verdict line. */
function modelBody(overrides: { model?: string; head?: string; verdict?: string; extraVerdict?: boolean } = {}): string {
    const head = overrides.head ?? sha12(HEAD);
    return [
        `Review by reviewer (${overrides.model ?? 'sonnet'}) at head ${head}`,
        '',
        '## PR Review Verdict',
        `- Verdict: ${overrides.verdict ?? 'PARTIAL'}`,
        '',
        '## Findings',
        '- HIGH cli/src/x.ts:1 the guard ignores the merge queue',
        ...(overrides.extraVerdict ? ['- Verdict: PASS'] : []),
        '',
    ].join('\n');
}

function input(overrides: Partial<PostReviewInput> = {}): PostReviewInput {
    return {
        repo: 'xtrm-dev/core',
        pr: 42,
        body: modelBody(),
        holder: 'core-worker-a',
        runId: 'run123',
        ...overrides,
    };
}

function headRoutes(extra: Record<string, { status: number; data: unknown }> = {}) {
    return {
        'GET /repos/xtrm-dev/core/pulls/42': { status: 200, data: { head: { sha: HEAD, ref: 'xt/some-branch' }, body: pullBody(ISSUE) } },
        'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: OTHER }, { sha: HEAD }] },
        'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [] },
        ...extra,
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

describe('reading the model body', () => {
    it('parses line 1: role, model verbatim, and the reviewed head', () => {
        expect(parseHeaderLine(modelBody())).toEqual({ role: 'reviewer', model: 'sonnet', head12: sha12(HEAD) });
        expect(parseHeaderLine(modelBody({ model: 'Claude Sonnet 5.5' }))?.model).toBe('Claude Sonnet 5.5');
        expect(parseHeaderLine('Review by reviewer at head abcdef123456')).toBeNull();
        expect(parseHeaderLine('Findings only')).toBeNull();
    });

    it('reads exactly one verdict line and maps it to the event', () => {
        expect(bodyVerdicts(modelBody())).toEqual(['COMMENT']);
        expect(bodyVerdicts(modelBody({ verdict: 'PASS' }))).toEqual(['APPROVE']);
        expect(bodyVerdicts(modelBody({ verdict: 'FAIL' }))).toEqual(['REQUEST_CHANGES']);
        expect(bodyVerdicts(modelBody({ extraVerdict: true }))).toEqual(['COMMENT', 'APPROVE']);
        expect(bodyVerdicts('no verdict here')).toEqual([]);
        // Parity with the pr-reviewer lint: an indented verdict line is not a verdict.
        expect(bodyVerdicts('  - Verdict: PASS')).toEqual([]);
        expect(lintModelBody(modelBody().replace('- Verdict: PARTIAL', '  - Verdict: PARTIAL'))).toMatch(/exactly one "- Verdict:/);
    });

    it('refuses a body without line 1, without a verdict, with two verdicts, or with a self-written marker', () => {
        expect(lintModelBody('Findings only')).toMatch(/line 1/);
        expect(lintModelBody(`Review by reviewer (sonnet) at head ${sha12(HEAD)}\n\n## Findings\n`)).toMatch(/exactly one "- Verdict:/);
        expect(lintModelBody(modelBody({ extraVerdict: true }))).toMatch(/found 2/);
        expect(lintModelBody(`${modelBody()}\n<!-- agent=me run=x -->\n`)).toMatch(/must not carry a hidden marker/);
        expect(lintModelBody(modelBody())).toBeNull();
    });

    it('builds the hidden marker the tool adds', () => {
        expect(buildMarker({ holder: 'core-worker-a', runId: 'run123', issueRef: ISSUE }))
            .toBe(`<!-- agent=core-worker-a run=run123 issue=${ISSUE} -->`);
        expect(buildMarker({ holder: 'h', runId: 'r', activationId: 'act:1' }))
            .toBe('<!-- agent=h run=r activation=act:1 -->');
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
    it('resolves the header head, pins commit_id to it, keeps line 1 and adds the marker', async () => {
        const github = fakeGitHub(headRoutes({
            'GET /repos/xtrm-dev/core/pulls/42/reviews': {
                status: 200,
                data: [
                    { id: 7, state: 'CHANGES_REQUESTED', user: { login: 'xtrm-reviewer[bot]' }, commit_id: 'f'.repeat(40) },
                    { id: 8, state: 'APPROVED', user: { login: 'xtrm-reviewer[bot]' } },
                    { id: 9, state: 'CHANGES_REQUESTED', user: { login: 'a-human' } },
                ],
            },
            'PUT /repos/xtrm-dev/core/pulls/42/reviews/7/dismissals': { status: 200, data: {} },
            'POST /repos/xtrm-dev/core/pulls/42/reviews': {
                status: 201,
                data: { id: 55, state: 'COMMENTED', commit_id: HEAD, html_url: 'https://github.com/xtrm-dev/core/pull/42#pullrequestreview-55' },
            },
        }));
        const receipt = await postReview(input(), github.deps);
        expect(receipt).toMatchObject({
            id: 55,
            verdict: 'COMMENT',
            state: 'COMMENTED',
            head: HEAD,
            issueRef: ISSUE,
            dismissed: [7],
            warnings: [],
        });
        const posted = github.calls.find((call) => call.method === 'POST');
        expect(posted?.body).toMatchObject({ commit_id: HEAD, event: 'COMMENT' });
        const body = String((posted?.body as { body?: string })?.body ?? '');
        const lines = body.split('\n');
        expect(lines[0]).toBe(`Review by reviewer (sonnet) at head ${sha12(HEAD)}`);
        expect(lines[1]).toBe('');
        expect(lines[2]).toContain('agent=core-worker-a');
        expect(lines[2]).toContain('run=run123');
        expect(lines[2]).toContain(`issue=${ISSUE}`);
        expect(body).toContain('## Findings');
        // The model body had no marker; the tool owns line 2.
        expect(modelBody()).not.toContain('<!--');
        expect(github.calls.some((call) => call.path.endsWith('/reviews/9/dismissals'))).toBe(false);

        const journal = reviewJournalArgs(receipt, input(), ISSUE);
        expect(journal.slice(0, 3)).toEqual(['journal', 'append', ISSUE]);
        expect(journal).toContain('--kind');
        expect(journal).toContain('result');
        expect(journal.join(' ')).toContain('github-review');
        expect(journal.join(' ')).toContain('pullrequestreview-55');
    });

    it('refuses a flag or env value that disagrees with the body', async () => {
        const github = fakeGitHub(headRoutes());
        await expect(postReview(input({ expectedVerdict: 'APPROVE' }), github.deps))
            .rejects.toThrow(/the flag requests APPROVE, the body's verdict line says COMMENT/);
        await expect(postReview(input({ expectedModel: 'opus' }), github.deps))
            .rejects.toThrow(/line 1 says sonnet/);
        await expect(postReview(input({ expectedHead: 'f'.repeat(40) }), github.deps))
            .rejects.toThrow(/does not match line 1/);
        expect(github.calls.some((call) => call.method === 'POST')).toBe(false);
    });

    it('refuses a body that fails the lint before any network call', async () => {
        const github = fakeGitHub(headRoutes());
        await expect(postReview(input({ body: 'Findings only' }), github.deps)).rejects.toThrow(/line 1/);
        await expect(postReview(input({ body: modelBody({ extraVerdict: true }) }), github.deps)).rejects.toThrow(/found 2/);
        expect(github.calls).toHaveLength(0);
    });

    it('refuses a review whose head is no longer the PR head', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': { status: 200, data: { head: { sha: OTHER }, body: pullBody(ISSUE) } },
            'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: OTHER }, { sha: HEAD }] },
        });
        await expect(postReview(input(), github.deps)).rejects.toThrow(/head moved: reviewed .*, current/);
        expect(github.calls.some((call) => call.method === 'POST')).toBe(false);
    });

    it('refuses a head that is not among the PR commits', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': { status: 200, data: { head: { sha: OTHER }, body: pullBody(ISSUE) } },
            'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: OTHER }] },
        });
        await expect(postReview(input(), github.deps)).rejects.toThrow(/not among the commits/);
    });

    it('refuses to review the PR the same agent opened', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': {
                status: 200,
                data: { head: { sha: HEAD }, body: `<!-- xtrm issue=${ISSUE} holder=core-worker-a run=run123 -->` },
            },
            'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: HEAD }] },
        });
        await expect(postReview(input(), github.deps)).rejects.toThrow(/own-PR/);
    });

    it('falls back to the branch for the Issue ref and warns when there is none', async () => {
        const withBranch = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': { status: 200, data: { head: { sha: HEAD, ref: 'xt/worker-CORE-2528-x' }, body: 'no marker' } },
            'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: HEAD }] },
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [] },
            'POST /repos/xtrm-dev/core/pulls/42/reviews': { status: 201, data: { id: 1, html_url: 'u' } },
        });
        expect((await postReview(input(), withBranch.deps)).issueRef).toBe('CORE-2528');

        const orphan = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': { status: 200, data: { head: { sha: HEAD, ref: 'main' }, body: 'no marker' } },
            'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: HEAD }] },
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [] },
            'POST /repos/xtrm-dev/core/pulls/42/reviews': { status: 201, data: { id: 1, html_url: 'u' } },
        });
        const receipt = await postReview(input(), orphan.deps);
        expect(receipt.issueRef).toBeNull();
        expect(receipt.warnings.join(' ')).toMatch(/not journaled/);
    });

    it('refuses rather than posting when GitHub refuses the review', async () => {
        const github = fakeGitHub(headRoutes({
            'POST /repos/xtrm-dev/core/pulls/42/reviews': { status: 422, data: { message: 'Unprocessable' } },
        }));
        await expect(postReview(input(), github.deps)).rejects.toThrow(/HTTP 422/);
    });
});
