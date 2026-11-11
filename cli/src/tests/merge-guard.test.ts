// CORE-2528: the merge guard. Every case runs against a fake GitHub and an
// injected `sb`, so the fail-closed paths are proven rather than assumed.

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    OFFLINE_ENV_VAR,
    OVERRIDE_ENV_VAR,
    checkStateDir,
    applyOverride,
    findValidDecision,
    journalEntries,
    mergeCheck,
    recordMerge,
    refusalMessage,
    type MergeGuardDeps,
} from '../core/merge-guard.js';
import { DEFAULT_ROLE_MAP } from '../core/identity-roles.js';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const OLD = '0123456789abcdef0123456789abcdef01234567';
const ISSUE = 'CORE-2528';
const BOT = 'xtrm-reviewer[bot]';
/** The guard is flag-gated and OFF by default; every case here turns it on. */
const GUARD_ON = { XTRM_MERGE_GUARD: 'on' };

type Call = { method: string; path: string };

function fakeGitHub(routes: Record<string, { status: number; data: unknown }>) {
    const calls: Call[] = [];
    const fetch = async (url: string, init?: { method?: string }) => {
        const full = url.replace('https://api.github.com', '');
        const call = { method: init?.method ?? 'GET', path: full.split('?')[0] };
        calls.push(call);
        // Routes may be keyed with the query (pagination) or without it.
        const route = routes[`${call.method} ${full}`] ?? routes[`${call.method} ${call.path}`];
        if (!route) return { status: 500, json: async () => ({ message: `no route ${call.method} ${call.path}` }) };
        return { status: route.status, json: async () => route.data };
    };
    return { calls, fetch };
}

function pull(head = HEAD, body = `<!-- xtrm issue=${ISSUE} holder=core-2528-worker run=run1 -->`): { status: number; data: unknown } {
    return { status: 200, data: { head: { sha: head, ref: 'xt/some-branch' }, body } };
}

function review(state: string, options: { head?: string; at?: string; id?: number } = {}) {
    return {
        id: options.id ?? 1,
        state,
        commit_id: options.head ?? HEAD,
        submitted_at: options.at ?? '2026-11-08T10:00:00Z',
        html_url: 'https://github.com/xtrm-dev/core/pull/42#pullrequestreview-1',
        user: { login: BOT },
    };
}

function sbReturning(entries: unknown[]) {
    const calls: string[][] = [];
    const runSb = (_cmd: string, args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: JSON.stringify({ data: entries, ok: true }), stderr: '' };
    };
    return { calls, runSb };
}

type SbCall = { cmd: string; args: string[]; opts: { input?: string; timeout?: number; cwd?: string } };

/** A fake `sb` for the Issue-existence check, one state per case (CORE-2590). */
function sbIssue(state: 'verified' | 'missing' | 'absent' | 'timeout' | 'garbage' | 'failed', ref = ISSUE) {
    const calls: SbCall[] = [];
    const runSb = (cmd: string, args: string[], opts: SbCall['opts']) => {
        calls.push({ cmd, args, opts });
        switch (state) {
            case 'verified':
                // The contract text stands in for the Issue body: it must not leak.
                return { status: 0, stdout: JSON.stringify({ ok: true, data: { humanRef: ref, contract: { problem: 'the Issue body must never reach the decision' } } }), stderr: '' };
            case 'missing':
                return { status: 1, stdout: JSON.stringify({ ok: false, error: `unresolvable ref: ${ref}` }), stderr: '' };
            case 'absent':
                return { status: null, stdout: '', stderr: '' };
            case 'timeout':
                return { status: null, stdout: '', stderr: 'ETIMEDOUT' };
            case 'garbage':
                return { status: 0, stdout: 'substrate-cli/v1	not json', stderr: '' };
            case 'failed':
                return { status: 3, stdout: JSON.stringify({ ok: false, error: 'the substrate store is locked' }), stderr: '' };
            default:
                throw new Error(`unreachable ${state}`);
        }
    };
    return { calls, runSb };
}

function deps(github: ReturnType<typeof fakeGitHub>, extra: Partial<MergeGuardDeps> = {}): MergeGuardDeps {
    return {
        token: 'ghs_token',
        apiBase: 'https://api.github.com',
        fetch: github.fetch,
        roleMap: DEFAULT_ROLE_MAP,
        env: { SUBSTRATE_HOLDER: 'core-2528-worker', ...GUARD_ON },
        now: () => Date.parse('2026-11-08T12:00:00Z'),
        // Every APPROVED case now asks Substrate whether the marker's ref exists.
        runSb: sbIssue('verified').runSb,
        ...extra,
    };
}

let stateHome = '';
beforeEach(() => {
    stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-merge-state-'));
});
afterEach(() => {
    fs.removeSync(stateHome);
});

describe('mergeCheck', () => {
    it('refuses when no reviewer-App review exists', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [{ id: 2, state: 'APPROVED', user: { login: 'a-human' } }] },
        });
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github));
        expect(decision.allow).toBe(false);
        expect(decision.reason).toMatch(/no review by xtrm-reviewer\[bot\]/);
        expect(decision.message).toContain('xt claude --role pr-reviewer');
        expect(decision.message).toContain(`${OVERRIDE_ENV_VAR}=<reason>`);
    });

    it('refuses a stale approval at an older head', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(HEAD),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('APPROVED', { head: OLD })] },
        });
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github));
        expect(decision.allow).toBe(false);
        expect(decision.reason).toMatch(/not at the current head/);
        expect(decision.reviewHead).toBe(OLD);
    });

    it('refuses changes requested at the current head', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('CHANGES_REQUESTED')] },
        });
        expect((await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github))).allow).toBe(false);
    });

    it('refuses an approval at the head when the PR has no resolvable Issue (test first)', async () => {
        // CORE-2528/CORE-2530: the guard ALWAYS refuses without an Issue, even for
        // an APPROVED review at the current head. A branch named like a ref no
        // longer counts (CORE-2590).
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(HEAD, 'a PR body with no marker'),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('APPROVED')] },
        });
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github));
        expect(decision.allow).toBe(false);
        expect(decision.reason).toMatch(/no [Rr]esolvable|no Substrate Issue/i);
        expect(decision.message).toMatch(/xtrm issue=/);
    });

    it('allows an approval at the current head', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('APPROVED')] },
        });
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github));
        expect(decision.allow).toBe(true);
        expect(decision.reason).toMatch(/approved the current head/);
        expect(decision.issueRef).toBe(ISSUE);
        expect(decision.issueLookup).toBe('verified');
    });

    it('uses the latest review by the bot and ignores a dismissed one', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': {
                status: 200,
                data: [
                    review('CHANGES_REQUESTED', { at: '2026-11-08T09:00:00Z', id: 1 }),
                    review('DISMISSED', { at: '2026-11-08T09:30:00Z', id: 2 }),
                    review('APPROVED', { at: '2026-11-08T11:00:00Z', id: 3 }),
                ],
            },
        });
        expect((await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github))).allow).toBe(true);
    });

    it('refuses a PR whose marker names a non-Substrate ref (no Journal read or write)', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': {
                status: 200,
                data: { head: { sha: HEAD, ref: 'main' }, body: '<!-- xtrm issue=--actor=evil holder=h run=r -->' },
            },
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('COMMENTED')] },
        });
        const sb = sbReturning([]);
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github, { runSb: sb.runSb }));
        expect(decision.allow).toBe(false);
        expect(decision.reason).toMatch(/not a Substrate ref/);
        expect(sb.calls).toHaveLength(0);
    });

    it('refuses a PARTIAL review without a coordinator decision', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('COMMENTED')] },
        });
        const sb = sbReturning([]);
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github, { runSb: sb.runSb }));
        expect(decision.allow).toBe(false);
        expect(decision.reason).toMatch(/no coordinator decision for this head/);
        expect(sb.calls[0]).toEqual(['journal', 'show', ISSUE, '--json']);
    });

    it('allows a PARTIAL review with a later coordinator decision for the same head', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('COMMENTED', { at: '2026-11-08T10:00:00Z' })] },
        });
        const sb = sbReturning([
            { kind: 'decision', createdAt: Date.parse('2026-11-08T11:00:00Z'), participantId: 'core-85', semantic: { head: HEAD, pr: 42 } },
        ]);
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github, { runSb: sb.runSb }));
        expect(decision.allow).toBe(true);
        expect(decision.reason).toMatch(/PARTIAL/);
    });

    it('refuses a decision written by the PR worker or before the review', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('COMMENTED', { at: '2026-11-08T10:00:00Z' })] },
        });
        const byWorker = sbReturning([
            { kind: 'decision', createdAt: Date.parse('2026-11-08T11:00:00Z'), participantId: 'core-2528-worker', semantic: { head: HEAD, pr: 42 } },
        ]);
        expect((await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github, { runSb: byWorker.runSb }))).allow).toBe(false);

        const tooEarly = sbReturning([
            { kind: 'decision', createdAt: Date.parse('2026-11-08T09:00:00Z'), participantId: 'core-85', semantic: { head: HEAD, pr: 42 } },
        ]);
        expect((await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github, { runSb: tooEarly.runSb }))).allow).toBe(false);
    });

    it('is off unless XTRM_MERGE_GUARD is set, and then allows without reading GitHub', async () => {
        const github = fakeGitHub({});
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github, { env: { SUBSTRATE_HOLDER: 'core-2528-worker' } }));
        expect(decision.allow).toBe(true);
        expect(decision.reason).toMatch(/merge guard is off/);
        expect(github.calls).toHaveLength(0);
    });

    it('ignores PENDING reviews, which carry no submitted_at', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': {
                status: 200,
                data: [
                    review('APPROVED', { at: '2026-11-08T09:00:00Z' }),
                    { id: 9, state: 'PENDING', commit_id: HEAD, user: { login: BOT } },
                ],
            },
        });
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github));
        expect(decision.reviewState).toBe('APPROVED');
        expect(decision.allow).toBe(true);
    });

    it('reads every page of reviews, so a later page can carry the decision', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 404, data: {} },
            'GET /repos/xtrm-dev/core/pulls/42/reviews?per_page=100&page=1': {
                status: 200,
                data: Array.from({ length: 100 }, (_, index) => review('COMMENTED', { id: index + 1, at: '2026-11-08T09:00:00Z' })),
            },
            'GET /repos/xtrm-dev/core/pulls/42/reviews?per_page=100&page=2': {
                status: 200,
                data: [review('APPROVED', { id: 500, at: '2026-11-08T11:00:00Z' })],
            },
        });
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github));
        expect(decision.allow).toBe(true);
        expect(decision.reviewState).toBe('APPROVED');
    });

    it('refuses a CHANGES_REQUESTED at the head (removing that branch turns this red)', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('CHANGES_REQUESTED')] },
        });
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github));
        expect(decision.allow).toBe(false);
        expect(decision.reason).toMatch(/requested changes/);
    });

    it('accepts the real REST state COMMENTED for a PARTIAL review with a decision', async () => {
        const sb = sbReturning([{ id: 1, kind: 'decision', createdAt: Date.parse('2026-11-08T11:00:00Z'), participantId: 'core-85', semantic: { head: 'abcdef012345', pr: 42 } }]);
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('COMMENTED')] },
        });
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github, { runSb: sb.runSb }));
        expect(decision.allow).toBe(true);
    });

    it('fails closed when GitHub or the Journal cannot be read', async () => {
        const down = fakeGitHub({ 'GET /repos/xtrm-dev/core/pulls/42': { status: 502, data: {} } });
        const unreachable = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(down));
        expect(unreachable.allow).toBe(false);
        expect(unreachable.unreachable).toBe(true);

        const throwing = deps(down, { fetch: async () => { throw new Error('ECONNRESET'); } });
        const failed = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, throwing);
        expect(failed.allow).toBe(false);
        expect(failed.message).toMatch(/fails closed/);

        const partial = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('COMMENTED')] },
        });
        const sbDown = deps(partial, { runSb: () => ({ status: 3, stdout: '', stderr: 'sb exploded' }) });
        expect((await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, sbDown)).allow).toBe(false);
    });
});

describe('Issue existence check (CORE-2590)', () => {
    function approved(options: { body?: string; ref?: string } = {}) {
        return fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': {
                status: 200,
                data: {
                    head: { sha: HEAD, ref: options.ref ?? 'xt/some-branch' },
                    body: options.body ?? `<!-- xtrm issue=${ISSUE} holder=core-2528-worker run=run1 -->`,
                },
            },
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('APPROVED')] },
        });
    }

    it('verifies the marker through one hermetic sb call and allows', async () => {
        const sb = sbIssue('verified');
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 },
            deps(approved(), { runSb: sb.runSb, cwd: '/repo/cwd' }));
        expect(decision.allow).toBe(true);
        expect(decision.issueLookup).toBe('verified');
        // One call, declared argv, no stdin, explicit cwd, 5 s budget.
        expect(sb.calls).toHaveLength(1);
        expect(sb.calls[0].cmd).toBe('sb');
        expect(sb.calls[0].args).toEqual(['issue', 'show', ISSUE, '--json']);
        expect(sb.calls[0].opts).toEqual({ input: '', timeout: 5000, cwd: '/repo/cwd' });
        // The Issue body never reaches the decision (or, by extension, a log).
        expect(JSON.stringify(decision)).not.toContain('must never reach the decision');
    });

    it('denies an explicit not-found, names the ref and says to fix the marker', async () => {
        const ref = 'CORE-0';
        const sb = sbIssue('missing', ref);
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 },
            deps(approved({ body: `<!-- xtrm issue=${ref} holder=w run=r -->` }), { runSb: sb.runSb }));
        // Removing the existence check turns this red: it would be allowed.
        expect(decision.allow).toBe(false);
        expect(decision.issueLookup).toBe('missing');
        expect(decision.reason).toContain(ref);
        expect(decision.reason).toMatch(/fix the marker/);
        expect(decision.message).toContain(`sb issue show ${ref} --json`);
        expect(sb.calls).toHaveLength(1);
    });

    it('allows with a warning when sb is absent (ENOENT)', async () => {
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 },
            deps(approved(), { runSb: sbIssue('absent').runSb }));
        expect(decision.allow).toBe(true);
        expect(decision.issueLookup).toBe('unknown');
        expect(decision.message).toMatch(/could not be verified/);
        expect(decision.issueLookupDetail).toMatch(/absent/);
    });

    it('allows with a warning when sb times out', async () => {
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 },
            deps(approved(), { runSb: sbIssue('timeout').runSb }));
        expect(decision.allow).toBe(true);
        expect(decision.issueLookup).toBe('unknown');
    });

    it('allows with a warning when sb exits non-zero for a reason other than not-found', async () => {
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 },
            deps(approved(), { runSb: sbIssue('failed').runSb }));
        expect(decision.allow).toBe(true);
        expect(decision.issueLookup).toBe('unknown');
        expect(decision.issueLookupDetail).toMatch(/without an explicit not-found/);
    });

    it('allows with a warning when sb returns unparseable output', async () => {
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 },
            deps(approved(), { runSb: sbIssue('garbage').runSb }));
        expect(decision.allow).toBe(true);
        expect(decision.issueLookup).toBe('unknown');
        expect(decision.issueLookupDetail).toMatch(/cannot parse/);
    });

    it('allows with a warning and calls no sb when XTRM_MERGE_GUARD_OFFLINE=1', async () => {
        const sb = sbIssue('missing');
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 },
            deps(approved(), { runSb: sb.runSb, env: { SUBSTRATE_HOLDER: 'core-2528-worker', ...GUARD_ON, [OFFLINE_ENV_VAR]: '1' } }));
        // Treating unknown as missing turns this red: offline must not block work.
        expect(decision.allow).toBe(true);
        expect(decision.issueLookup).toBe('unknown');
        expect(decision.message).toMatch(/could not be verified/);
        expect(sb.calls).toHaveLength(0);
    });

    it('does not check existence when the review does not otherwise allow', async () => {
        const sb = sbIssue('verified');
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('CHANGES_REQUESTED')] },
        });
        expect((await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github, { runSb: sb.runSb }))).allow).toBe(false);
        expect(sb.calls).toHaveLength(0);
    });
});

describe('marker selection (CORE-2590)', () => {
    function withBody(body: string, ref = 'xt/some-branch') {
        return fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': { status: 200, data: { head: { sha: HEAD, ref }, body } },
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('APPROVED')] },
        });
    }

    it('ignores a marker inside a fenced code block', async () => {
        const sb = sbIssue('verified');
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(withBody(
            `Example marker:\n\n\`\`\`\n<!-- xtrm issue=${ISSUE} holder=w run=r -->\n\`\`\`\n`,
        ), { runSb: sb.runSb }));
        expect(decision.allow).toBe(false);
        expect(decision.reason).toMatch(/no Substrate Issue/);
        expect(sb.calls).toHaveLength(0);
    });

    it('ignores a marker on a > quote line', async () => {
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(withBody(
            `> <!-- xtrm issue=${ISSUE} holder=w run=r -->\n`,
        )));
        expect(decision.allow).toBe(false);
        expect(decision.reason).toMatch(/no Substrate Issue/);
    });

    it('refuses two markers naming different Issues as ambiguous', async () => {
        const sb = sbIssue('verified');
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(withBody(
            `<!-- xtrm issue=ZZZ-999999 holder=w run=r -->\n<!-- xtrm issue=${ISSUE} holder=w run=r -->\n`,
        ), { runSb: sb.runSb }));
        expect(decision.allow).toBe(false);
        expect(decision.reason).toMatch(/different Issues/);
        expect(decision.reason).toContain('ZZZ-999999');
        expect(decision.reason).toContain(ISSUE);
        expect(sb.calls).toHaveLength(0);
    });

    it('ignores a holder-only comment appended after the real marker (CORE-2590 review 3)', async () => {
        const sb = sbIssue('verified');
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(withBody(
            `<!-- xtrm issue=${ISSUE} holder=w run=r -->\n<!-- xtrm holder=other run=2 -->\n`,
        ), { runSb: sb.runSb }));
        expect(decision.allow).toBe(true);
        expect(decision.issueRef).toBe(ISSUE);
        expect(decision.issueLookup).toBe('verified');
        expect(sb.calls).toHaveLength(1);
    });

    it('ignores an xtrm-looking comment that does not start with xtrm (CORE-2590 review 3)', async () => {
        const sb = sbIssue('verified');
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(withBody(
            `<!-- xtrm issue=${ISSUE} holder=w run=r -->\n<!-- see xtrm-tools run=9 -->\n`,
        ), { runSb: sb.runSb }));
        expect(decision.allow).toBe(true);
        expect(decision.issueRef).toBe(ISSUE);
        expect(decision.issueLookup).toBe('verified');
        expect(decision.reason).not.toMatch(/no Substrate Issue/);
    });

    it('ignores a marker inside a 4-backtick fence that contains a 3-backtick line (CORE-2590 review 2)', async () => {
        const sb = sbIssue('verified');
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(withBody(
            '````\n```\n<!-- xtrm issue=ZZZ-999999 holder=w run=r -->\n```\n````\n'
            + `<!-- xtrm issue=${ISSUE} holder=w run=r -->\n`,
        ), { runSb: sb.runSb }));
        expect(decision.allow).toBe(true);
        expect(decision.issueRef).toBe(ISSUE);
        expect(decision.reason).not.toMatch(/different Issues/);
        expect(sb.calls).toHaveLength(1);
    });

    it('does not derive an Issue from a branch named like a ref', async () => {
        for (const ref of ['fix/UTF-8-parser', 'fix/CORE-2590-parser']) {
            const sb = sbIssue('verified');
            const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 },
                deps(withBody('no marker', ref), { runSb: sb.runSb }));
            expect(decision.allow, ref).toBe(false);
            expect(decision.reason, ref).toMatch(/no Substrate Issue/);
            expect(sb.calls, ref).toHaveLength(0);
        }
    });
});

describe('findValidDecision', () => {
    it('matches on semantic.head and semantic.pr only', () => {
        const entries = [
            { kind: 'decision', createdAt: 2000, participantId: 'core-85', semantic: { summary: 'head abc, pr 42', head: HEAD, pr: 42 } },
            { kind: 'decision', createdAt: 2000, participantId: 'core-85', semantic: { head: OLD, pr: 42 } },
            { kind: 'decision', createdAt: 2000, participantId: 'core-85', semantic: { head: HEAD, pr: 41 } },
            { kind: 'note', createdAt: 2000, participantId: 'core-85', semantic: { head: HEAD, pr: 42 } },
        ];
        expect(findValidDecision(entries, { head: HEAD, pr: 42, reviewAt: 1000 })).toBe(entries[0]);
        expect(findValidDecision([entries[1], entries[2], entries[3]], { head: HEAD, pr: 42, reviewAt: 1000 })).toBeNull();
    });
});

describe('applyOverride role gating (delta review #3, M9)', () => {
    function refusal(): Parameters<typeof applyOverride>[0] {
        return {
            allow: false, reason: 'no review', repo: 'xtrm-dev/core', pr: 42,
            head: HEAD, issueRef: null, message: 'merge refused for xtrm-dev/core#42: no review',
        };
    }

    it('refuses an unknown hand-set role even with the override variable', async () => {
        for (const role of ['bogus', 'executor']) {
            const decision = await applyOverride(refusal(), deps(fakeGitHub({}), {
                env: { SUBSTRATE_HOLDER: 'h', XTRM_ROLE: role, XTRM_MERGE_GUARD_OVERRIDE: 'because', ...GUARD_ON },
                stateHome,
            }));
            expect(decision.allow, role).toBe(false);
            expect(decision.reason, role).toMatch(/override refused/);
            expect(decision.reason, role).toMatch(/not a role or a mapped specialist/);
        }
    });

    it('allows the coordinator and records the true role in the log', async () => {
        const decision = await applyOverride(refusal(), deps(fakeGitHub({}), {
            env: { SUBSTRATE_HOLDER: 'h', XTRM_ROLE: 'coordinator', XTRM_MERGE_GUARD_OVERRIDE: 'because', ...GUARD_ON },
            stateHome,
        }));
        expect(decision.allow).toBe(true);
        const log = fs.readFileSync(path.join(stateHome, 'xtrm', 'merge-guard-override.log'), 'utf8');
        expect(log).toContain('"role":"coordinator"');
    });
});

describe('refusalMessage', () => {
    it('names the ways forward and no repository other than the one being merged', () => {
        const text = refusalMessage({ repo: 'xtrm-dev/core', pr: 42, head: HEAD, reason: 'stale' });
        expect(text).toContain('merge refused for xtrm-dev/core#42');
        expect(text).toContain('reviewer subagent in PR mode');
        expect(text).toContain('HIGH or critical scrutiny');
        expect(text.toLowerCase()).not.toContain('mercury');
    });
});

describe('applyOverride', () => {
    const refusal = {
        allow: false, reason: 'no review', repo: 'xtrm-dev/core', pr: 42, head: HEAD, issueRef: ISSUE,
        message: 'refused',
    };

    it('changes nothing without the variable or for a worker', async () => {
        const github = fakeGitHub({});
        expect((await applyOverride(refusal, deps(github))).allow).toBe(false);
        const worker = deps(github, { env: { SUBSTRATE_HOLDER: 'w', [OVERRIDE_ENV_VAR]: 'shipping' } });
        const refused = await applyOverride(refusal, worker);
        expect(refused.allow).toBe(false);
        expect(refused.reason).toMatch(/may not override/);
    });

    it('allows for the coordinator, logs the line and journals the decision', async () => {
        const github = fakeGitHub({});
        const sb = sbReturning([]);
        const coordinator = deps(github, {
            env: { SUBSTRATE_HOLDER: 'core-85', XTRM_ROLE: 'coordinator', [OVERRIDE_ENV_VAR]: 'sonnet unavailable' },
            runSb: sb.runSb,
            stateHome,
        });
        const allowed = await applyOverride(refusal, coordinator);
        expect(allowed.allow).toBe(true);
        expect(allowed.override).toMatchObject({ journaled: true, logged: true });
        expect(sb.calls[0][0]).toBe('journal');
        expect(sb.calls[0].join(' ')).toContain('semantic');
        const log = fs.readFileSync(path.join(stateHome, 'xtrm', 'merge-guard-override.log'), 'utf8');
        expect(log).toContain('sonnet unavailable');
    });

    it('allows for the operator (no holder, no role)', async () => {
        const github = fakeGitHub({});
        const sb = sbReturning([]);
        const allowed = await applyOverride(refusal, deps(github, {
            env: { [OVERRIDE_ENV_VAR]: 'manual check done' },
            runSb: sb.runSb,
            stateHome,
        }));
        expect(allowed.allow).toBe(true);
        expect(allowed.reason).toMatch(/operator/);
    });
});

describe('recordMerge', () => {
    it('appends a github-merge ref and fails loudly when sb fails', () => {
        const ok = recordMerge({ repo: 'xtrm-dev/core', pr: 42, head: HEAD, issueRef: ISSUE }, {
            token: '', env: { SUBSTRATE_HOLDER: 'core-2528-worker' },
            runSb: (_cmd, args) => ({ status: args.includes('--refs') ? 0 : 1, stdout: '', stderr: '' }),
        });
        expect(ok.ok).toBe(true);
        const failed = recordMerge({ repo: 'xtrm-dev/core', pr: 42, head: HEAD, issueRef: ISSUE }, {
            token: '', runSb: () => ({ status: 2, stdout: '', stderr: 'issue closed' }),
        });
        expect(failed).toEqual({ ok: false, error: 'issue closed' });
    });
});

describe('checkStateDir (a pathological state dir fails fast)', () => {
    it('rejects a file as an ancestor, a relative path and a read-only directory', () => {
        const file = path.join(stateHome, 'not-a-dir');
        fs.writeFileSync(file, 'x');
        expect(checkStateDir(path.join(file, 'state'))).toMatch(/not a directory/);
        expect(checkStateDir('relative/state')).toMatch(/absolute/);
        const ro = path.join(stateHome, 'ro');
        fs.mkdirSync(ro, { recursive: true, mode: 0o500 });
        fs.chmodSync(ro, 0o500);
        try {
            // Root ignores modes; only assert the message when the mode is honoured.
            const verdict = checkStateDir(path.join(ro, 'state'));
            if (process.getuid?.() !== 0) expect(verdict).toMatch(/not writable/);
        } finally {
            fs.chmodSync(ro, 0o700);
        }
    }, 5000);

    it('accepts a normal absolute path under an existing directory', () => {
        expect(checkStateDir(path.join(stateHome, 'xtrm', 'state'))).toBeNull();
    });
});
