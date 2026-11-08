// CORE-2528: the merge guard. Every case runs against a fake GitHub and an
// injected `sb`, so the fail-closed paths are proven rather than assumed.

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    OVERRIDE_ENV_VAR,
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

function deps(github: ReturnType<typeof fakeGitHub>, extra: Partial<MergeGuardDeps> = {}): MergeGuardDeps {
    return {
        token: 'ghs_token',
        apiBase: 'https://api.github.com',
        fetch: github.fetch,
        roleMap: DEFAULT_ROLE_MAP,
        env: { SUBSTRATE_HOLDER: 'core-2528-worker', ...GUARD_ON },
        now: () => Date.parse('2026-11-08T12:00:00Z'),
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

    it('allows an approval at the current head', async () => {
        const github = fakeGitHub({
            'GET /repos/xtrm-dev/core/pulls/42': pull(),
            'GET /repos/xtrm-dev/core/pulls/42/reviews': { status: 200, data: [review('APPROVED')] },
        });
        const decision = await mergeCheck({ repo: 'xtrm-dev/core', pr: 42 }, deps(github));
        expect(decision.allow).toBe(true);
        expect(decision.reason).toMatch(/approved the current head/);
        expect(decision.issueRef).toBe(ISSUE);
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
