// CORE-2528: the pinned, attributed review post. The head, the model and the
// verdict are derived from the model's body (the shim reads what the reviewer
// wrote), and the tool adds the hidden marker. A fake GitHub proves every
// refusal without the Apps.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanAgentName } from '../core/dispatcher-identity.js';
import {
    bodyVerdicts,
    buildAttribution,
    buildMarker,
    eventForFlags,
    eventForOutcome,
    lintModelBody,
    parseHeaderLine,
    parseIssueMarker,
    parseIssueMarkers,
    postReview,
    reviewJournalArgs,
    sha12,
    ReviewRefused,
    type PostedReview,
    type PostReviewInput,
} from '../core/review-posting.js';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER = '0123456789abcdef0123456789abcdef01234567';
const ISSUE = 'CORE-2528';

// CORE-2606: the visible attribution reads the launch environment, so the file
// owns it instead of whatever shell started the test run.
const SAVED_AGENT_NAME = process.env.XTRM_AGENT_NAME;
const SAVED_SESSION_NAME = process.env.XTRM_SESSION_NAME;
afterAll(() => {
    if (SAVED_AGENT_NAME === undefined) delete process.env.XTRM_AGENT_NAME;
    else process.env.XTRM_AGENT_NAME = SAVED_AGENT_NAME;
    if (SAVED_SESSION_NAME === undefined) delete process.env.XTRM_SESSION_NAME;
    else process.env.XTRM_SESSION_NAME = SAVED_SESSION_NAME;
});
beforeEach(() => {
    delete process.env.XTRM_AGENT_NAME;
    delete process.env.XTRM_SESSION_NAME;
});

type Call = { method: string; path: string; body?: unknown };

function fakeGitHub(routes: Record<string, { status: number; data: unknown } | ((call: Call) => { status: number; data: unknown })>) {
    const calls: Call[] = [];
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
        const full = url.replace('https://api.github.com', '');
        const call: Call = { method: init?.method ?? 'GET', path: full.split('?')[0], body: init?.body ? JSON.parse(init.body) : undefined };
        calls.push(call);
        const route = routes[`${call.method} ${full}`] ?? routes[`${call.method} ${full.split('?')[0]}`];
        if (!route) return { status: 404, json: async () => ({ message: `no route ${call.method} ${full}` }) };
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

    it('parses the PR marker and ignores fenced, quoted and earlier markers', () => {
        expect(parseIssueMarker(pullBody('CORE-2528'))).toMatchObject({ issue: 'CORE-2528', holder: 'core-2528-worker', run: 'abc123' });
        expect(parseIssueMarker('nothing here')).toBeNull();
        // A fenced block and a > quote are pasted text, not a declaration.
        expect(parseIssueMarkers(`\`\`\`\n<!-- xtrm issue=CORE-1 holder=w run=r -->\n\`\`\`\n`)).toEqual([]);
        expect(parseIssueMarkers('> <!-- xtrm issue=CORE-1 holder=w run=r -->')).toEqual([]);
        // The LAST valid marker wins; the list keeps body order.
        expect(parseIssueMarkers('<!-- xtrm issue=CORE-1 holder=a run=1 -->\n<!-- xtrm issue=CORE-2 holder=b run=2 -->'))
            .toEqual([{ issue: 'CORE-1', holder: 'a', run: '1' }, { issue: 'CORE-2', holder: 'b', run: '2' }]);
        expect(parseIssueMarker('<!-- xtrm issue=CORE-1 holder=a run=1 -->\n<!-- xtrm issue=CORE-2 holder=b run=2 -->'))
            .toMatchObject({ issue: 'CORE-2', holder: 'b' });
    });

    it('tracks CommonMark fences by character and length (CORE-2590 review 2)', () => {
        // A 4-backtick block that contains a 3-backtick line keeps its content.
        expect(parseIssueMarkers('````\n```\n<!-- xtrm issue=FAKE-1 holder=w run=r -->\n```\n````\n')).toEqual([]);
        // The real marker after the proper close still counts.
        expect(parseIssueMarkers('````\n```\n<!-- xtrm issue=FAKE-1 holder=w run=r -->\n```\n````\n<!-- xtrm issue=CORE-9 holder=w run=r -->\n'))
            .toEqual([{ issue: 'CORE-9', holder: 'w', run: 'r' }]);
        // A tilde line does not close a backtick fence.
        expect(parseIssueMarkers('```\n~~~\n<!-- xtrm issue=FAKE-2 holder=w run=r -->\n```\n')).toEqual([]);
        // A shorter close does not close a longer fence.
        expect(parseIssueMarkers('`````\n````\n<!-- xtrm issue=FAKE-3 holder=w run=r -->\n`````\n')).toEqual([]);
    });

    it('treats a CRLF body like an LF body, fences included (CORE-2590 review 5853004574 A)', () => {
        // A GitHub-web-editor body keeps a `\r` on every line; a `$`-anchored fence
        // pattern does not match then, so the split must tolerate CRLF.
        const crlf = (lines: string[]) => lines.join('\r\n');
        expect(parseIssueMarkers(crlf(['```', '<!-- xtrm issue=FAKE-1 holder=w run=r -->', '```', '']))).toEqual([]);
        expect(parseIssueMarkers(crlf(['```', '<!-- xtrm issue=FAKE-1 holder=w run=r -->', '```', '<!-- xtrm issue=CORE-9 holder=w run=r -->', ''])))
            .toEqual([{ issue: 'CORE-9', holder: 'w', run: 'r' }]);
        expect(parseIssueMarker(crlf(['<!-- xtrm issue=CORE-9 holder=w run=r -->', '']))).toMatchObject({ issue: 'CORE-9' });
    });

    it('ignores an xtrm-looking comment that does not start with xtrm, and one without issue= (CORE-2590 review 3)', () => {
        // `xtrm\b` used to match inside `xtrm-tools`, so a later comment could
        // displace the real marker and the guard denied with the wrong reason.
        expect(parseIssueMarkers('<!-- xtrm issue=CORE-1 holder=a run=1 -->\n<!-- see xtrm-tools run=9 -->'))
            .toEqual([{ issue: 'CORE-1', holder: 'a', run: '1' }]);
        expect(parseIssueMarker('<!-- xtrm issue=CORE-1 holder=a run=1 -->\n<!-- see xtrm-tools run=9 -->'))
            .toMatchObject({ issue: 'CORE-1' });
        // A holder-only comment names no Issue, so it is not a marker at all.
        expect(parseIssueMarkers('<!-- xtrm issue=CORE-1 holder=a run=1 -->\n<!-- xtrm holder=b run=2 -->'))
            .toEqual([{ issue: 'CORE-1', holder: 'a', run: '1' }]);
        expect(parseIssueMarkers('<!-- xtrm holder=b run=2 -->')).toEqual([]);
    });
});

describe('the visible attribution line (CORE-2606)', () => {
    it('reads Agent <XTRM_AGENT_NAME> · run <id> · Issue <REF> · activation <id>', () => {
        process.env.XTRM_AGENT_NAME = 'core-xt-pi-0fln';
        expect(buildAttribution({ holder: 'holder7', runId: 'r1', issueRef: 'CORE-2606', activationId: 'act:a1' }))
            .toBe('Agent core-xt-pi-0fln · run r1 · Issue CORE-2606 · activation act:a1');
    });

    it('lets XTRM_AGENT_NAME win over the holder, and never reads XTRM_SESSION_NAME', () => {
        process.env.XTRM_AGENT_NAME = 'core-xt-pi-0fln';
        process.env.XTRM_SESSION_NAME = 'xx';
        expect(buildAttribution({ holder: 'holder7', runId: 'r1' })).toBe('Agent core-xt-pi-0fln · run r1');
        delete process.env.XTRM_AGENT_NAME;
        expect(buildAttribution({ holder: 'holder7', runId: 'r1' })).toBe('Agent holder7 · run r1');
        expect(buildAttribution({ holder: 'holder7', runId: 'r1' })).not.toContain('xx');
    });

    it('degrades by omission: no Issue, no activation, and an empty environment stays empty', () => {
        expect(buildAttribution({ holder: 'h', runId: 'r' })).toBe('Agent h · run r');
        expect(buildAttribution({ holder: 'h', runId: 'r', issueRef: 'CORE-1' })).toBe('Agent h · run r · Issue CORE-1');
        expect(buildAttribution({ holder: 'h', runId: 'r', activationId: 'act:a1' })).toBe('Agent h · run r · activation act:a1');
        expect(buildAttribution({ holder: 'h' })).toBe('Agent h');
        expect(buildAttribution({})).toBe('');
    });

    it('sanitises a name that tries to break the line', () => {
        process.env.XTRM_AGENT_NAME = 'evil\nname\twith  spaces';
        const line = buildAttribution({ holder: 'h', runId: 'r' });
        expect(line).toBe('Agent evil name with spaces · run r');
        expect(line.split('\n')).toHaveLength(1);
        expect(cleanAgentName('\u0000\u001b')).toBeNull();
    });

    it('posts the attribution on line 2 and the hidden marker on line 3', async () => {
        process.env.XTRM_AGENT_NAME = 'core-xt-pi-0fln';
        const github = fakeGitHub(headRoutes({
            'POST /repos/xtrm-dev/core/pulls/42/reviews': {
                status: 201,
                data: { id: 55, state: 'COMMENTED', html_url: 'https://github.com/xtrm-dev/core/pull/42#pullrequestreview-55' },
            },
        }));
        await postReview(input({ activationId: 'act:a1' }), github.deps);
        const body = String((github.calls.find((call) => call.method === 'POST')?.body as { body?: string })?.body ?? '');
        const lines = body.split('\n');
        expect(lines[1]).toBe('Agent core-xt-pi-0fln · run run123 · Issue CORE-2528 · activation act:a1');
        // The hidden marker's format is unchanged; only its line moved down one.
        expect(lines[2]).toBe('<!-- agent=core-worker-a run=run123 issue=CORE-2528 activation=act:a1 -->');
        expect(body.split('\n').filter((line) => line.startsWith('Agent '))).toHaveLength(1);
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
        expect(lines[1]).toBe('Agent core-worker-a · run run123 · Issue CORE-2528');
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

    it('does not derive the Issue from the branch, and refuses a PR with no marker at all', async () => {
        // A branch named like a ref is not an Issue source: the marker is the only one.
        const withBranch = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': {
                status: 200,
                data: { head: { sha: HEAD, ref: 'xt/worker-CORE-2528-x' }, body: 'no marker' },
            },
            'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: HEAD }] },
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [] },
        });
        await expect(postReview(input(), withBranch.deps)).rejects.toThrow(/carries no xtrm marker/);
        expect(withBranch.calls.some((call) => call.method === 'POST')).toBe(false);

        // A holder-only comment names no Issue, so it is not a marker either
        // (CORE-2590 review finding 3): refused, not posted unattributed.
        const holderOnly = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': {
                status: 200,
                data: { head: { sha: HEAD, ref: 'xt/worker-CORE-2528-x' }, body: '<!-- xtrm holder=core-2528-worker run=abc123 -->' },
            },
            'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: HEAD }] },
        });
        await expect(postReview(input(), holderOnly.deps)).rejects.toThrow(/carries no xtrm marker/);
        expect(holderOnly.calls.some((call) => call.method === 'POST')).toBe(false);

        // No marker, no attribution: refused, never posted with a warning.
        const orphan = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': { status: 200, data: { head: { sha: HEAD, ref: 'main' }, body: 'no marker' } },
            'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: HEAD }] },
        });
        await expect(postReview(input(), orphan.deps)).rejects.toThrow(/carries no xtrm marker/);
        expect(orphan.calls.some((call) => call.method === 'POST')).toBe(false);
    });

    it('posts the review before dismissing, and warns when a dismissal fails', async () => {
        const github = fakeGitHub(headRoutes({
            'GET /repos/xtrm-dev/core/pulls/42/reviews': {
                status: 200,
                data: [{ id: 7, state: 'CHANGES_REQUESTED', user: { login: 'xtrm-reviewer[bot]' }, commit_id: 'f'.repeat(40) }],
            },
            'PUT /repos/xtrm-dev/core/pulls/42/reviews/7/dismissals': { status: 500, data: {} },
            'POST /repos/xtrm-dev/core/pulls/42/reviews': { status: 201, data: { id: 55, state: 'COMMENTED', html_url: 'u' } },
        }));
        const receipt = await postReview(input(), github.deps);
        const order = github.calls.map((call) => call.method).filter((method) => method !== 'GET');
        expect(order).toEqual(['POST', 'PUT']);
        expect(receipt.dismissed).toEqual([]);
        expect(receipt.warnings.join(' ')).toMatch(/could not dismiss stale review 7/);
    });

    it('finds a stale change request on a later page', async () => {
        const firstPage = Array.from({ length: 100 }, (_, index) => ({
            id: index + 1, state: 'COMMENTED', user: { login: 'xtrm-reviewer[bot]' },
        }));
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': { status: 200, data: { head: { sha: HEAD, ref: 'xt/b' }, body: pullBody(ISSUE) } },
            'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: HEAD }] },
            'GET /repos/xtrm-dev/core/pulls/42/reviews?per_page=100&page=1': { status: 200, data: firstPage },
            'GET /repos/xtrm-dev/core/pulls/42/reviews?per_page=100&page=2': {
                status: 200,
                data: [{ id: 999, state: 'CHANGES_REQUESTED', user: { login: 'xtrm-reviewer[bot]' } }],
            },
            'PUT /repos/xtrm-dev/core/pulls/42/reviews/999/dismissals': { status: 200, data: {} },
            'POST /repos/xtrm-dev/core/pulls/42/reviews': { status: 201, data: { id: 1000, state: 'COMMENTED', html_url: 'u' } },
        });
        const receipt = await postReview(input(), github.deps);
        expect(receipt.dismissed).toEqual([999]);
    });

    it('refuses a body over GitHub\'s 65536-character limit', async () => {
        const github = fakeGitHub(headRoutes());
        const body = modelBody().replace('## Findings', `## Findings\n${'x'.repeat(65600)}`);
        await expect(postReview(input({ body }), github.deps)).rejects.toThrow(/65536/);
        expect(github.calls.some((call) => call.method === 'POST')).toBe(false);
    });

    it('refuses a marker without holder= so an own-PR review cannot be excluded', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': {
                status: 200,
                data: { head: { sha: HEAD, ref: 'xt/b' }, body: '<!-- xtrm issue=CORE-2528 run=abc -->' },
            },
            'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: HEAD }] },
        });
        await expect(postReview(input(), github.deps)).rejects.toThrow(/without holder=/);
        expect(github.calls.some((call) => call.method === 'POST')).toBe(false);
    });

    it('refuses an Issue ref from the PR body that is not a Substrate ref', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': { status: 200, data: { head: { sha: HEAD }, body: '<!-- xtrm issue=--force holder=x run=y -->' } },
            'GET /repos/xtrm-dev/core/pulls/42/commits': { status: 200, data: [{ sha: HEAD }] },
        });
        await expect(postReview(input(), github.deps)).rejects.toThrow(/not a Substrate ref/);
        expect(github.calls.some((call) => call.method === 'POST')).toBe(false);
    });

    it('refuses rather than posting when GitHub refuses the review', async () => {
        const github = fakeGitHub(headRoutes({
            'POST /repos/xtrm-dev/core/pulls/42/reviews': { status: 422, data: { message: 'Unprocessable' } },
        }));
        await expect(postReview(input(), github.deps)).rejects.toThrow(/HTTP 422/);
    });
});

// CORE-2606 (b): the receipt payload as the REAL `sb` receives it. The unit
// tests prove the shape; this proves the CLI accepts it. The live run that
// printed "Journal receipt failed: sb exited 1" is why it exists: the unbounded
// `verdict`/`head`/`artifact` fields were refused, and the reason sat on stdout.
describe('the review receipt against the real sb', () => {
    const sbPath = (() => {
        const found = spawnSync('sh', ['-c', 'command -v sb'], { encoding: 'utf8' });
        return (found.stdout ?? '').trim();
    })();
    if (!sbPath) console.warn('[CORE-2606] real-sb receipt tests skipped: sb is not on PATH');

    let root = '';
    let repo = '';
    let env: NodeJS.ProcessEnv = {};
    let ref = '';

    function run(command: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
        const result = spawnSync(command, args, { encoding: 'utf8', cwd: repo, env, timeout: 30000 });
        if (result.error) throw result.error;
        return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    }

    const describeSb = sbPath ? describe : describe.skip;
    describeSb('local store', () => {
        beforeAll(() => {
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-receipt-'));
            repo = path.join(root, 'repo');
            const home = path.join(root, 'home');
            fs.mkdirSync(repo, { recursive: true });
            fs.mkdirSync(home, { recursive: true });
            // Never the real HOME, and never the operator's git config.
            env = {
                ...process.env,
                HOME: home,
                SUBSTRATE_DB: path.join(root, 'substrate.db'),
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_AUTHOR_NAME: 'receipt-test',
                GIT_AUTHOR_EMAIL: 'receipt@example.invalid',
                GIT_COMMITTER_NAME: 'receipt-test',
                GIT_COMMITTER_EMAIL: 'receipt@example.invalid',
            };
            for (const key of ['SUBSTRATE_HOLDER', 'XTRM_AGENT_NAME', 'XTRM_SESSION_ID', 'XTRM_SESSION_NAME']) delete env[key];
            fs.writeFileSync(path.join(repo, 'f'), 'x\n');
            expect(run('git', ['init', '-q', '-b', 'main', '.']).status).toBe(0);
            expect(run('git', ['add', '.']).status).toBe(0);
            expect(run('git', ['commit', '-qm', 'init']).status).toBe(0);
            const init = run(sbPath, ['init']);
            expect(init.status).toBe(0);
            const listed = JSON.parse(run(sbPath, ['project', 'list', '--json']).stdout) as { data?: Array<{ id?: string }> };
            const project = listed.data?.[0]?.id;
            expect(project).toBeTruthy();
            const contract = path.join(root, 'contract.json');
            fs.writeFileSync(contract, JSON.stringify({
                problem: 'receipt probe', success: 'the journal accepts it', scope: ['probe'],
                nonGoals: [], constraints: [], validation: [{ check: 'n/a' }],
                output: [{ artifact: 'none' }], scrutiny: 'LOW',
            }));
            const created = run(sbPath, ['issue', 'create', '--project', String(project), '--title', 'Receipt target',
                '--kind', 'task', '--contract', contract, '--json']);
            expect(created.status).toBe(0);
            const parsed = JSON.parse(created.stdout) as { data?: { locator?: string } };
            ref = parsed.data?.locator ?? '';
            expect(ref).toMatch(/^[A-Z][A-Z0-9]*-\d+$/);
        }, 60000);

        afterAll(() => {
            if (root) fs.rmSync(root, { recursive: true, force: true });
        });

        it('persists the bounded payload the module builds', () => {
            const receipt: PostedReview = {
                id: 55,
                url: 'https://github.com/xtrm-dev/core/pull/42#pullrequestreview-55',
                verdict: 'APPROVE',
                state: 'APPROVED',
                head: HEAD,
                issueRef: ref,
                dismissed: [],
                warnings: [],
            };
            const args = reviewJournalArgs(receipt, input({ role: 'reviewer' }), ref, 'xtrm-reviewer');
            const journal = run(sbPath, args);
            expect(journal.stderr).toBe('');
            expect(journal.status).toBe(0);
            const parsed = JSON.parse(journal.stdout) as { ok?: boolean; data?: { result?: Record<string, unknown> } };
            expect(parsed.ok).toBe(true);
            const result = parsed.data?.result ?? {};
            expect(result).toMatchObject({
                summary: `Review APPROVE at head ${sha12(HEAD)} for xtrm-dev/core#42`,
                outcome: 'review APPROVE',
                artifactRefs: [receipt.url],
            });
            expect(result).not.toHaveProperty('verdict');
            expect(result).not.toHaveProperty('head');
            expect(result).not.toHaveProperty('artifact');

            const latest = JSON.parse(run(sbPath, ['journal', 'latest', ref, '--json']).stdout) as {
                data?: { result?: Record<string, unknown> };
            };
            expect(latest.data?.result?.summary).toContain('Review APPROVE');
        }, 60000);

        it('is refused when the payload regresses to the unbounded fields (the live failure)', () => {
            // The exact shape main shipped: sb refuses it on STDOUT, with empty
            // stderr. If this ever passes, the bounded-field fix has been undone.
            const legacy = ['journal', 'append', ref, '--kind', 'result', '--result', JSON.stringify({
                summary: 'Review APPROVE at head 0123456789ab',
                verdict: 'APPROVE',
                head: HEAD,
                artifact: { kind: 'review', head: HEAD, verdict: 'APPROVE' },
            }), '--json'];
            const refused = run(sbPath, legacy);
            expect(refused.status).toBe(1);
            expect(refused.stderr).toBe('');
            // sb's prose is not ours to pin: require the stable refusal and the
            // field it rejected, so a wording change does not break the test.
            const refusal = JSON.parse(String(refused.stdout)) as { ok?: boolean; error?: string };
            expect(refusal.ok).toBe(false);
            expect(String(refusal.error)).toMatch(/invalid result payload/);
            expect(String(refusal.error)).toMatch(/result\.verdict/);
        }, 60000);
    });
});
