import { describe, it, expect } from 'vitest';
import { validate } from '@xtrm/contracts';
import {
    ISSUE_REF_PATTERN,
    READ_ONLY_COMMANDS,
    collectEnrichment,
    collectProjection,
    joinProjection,
    parsePanes,
    parseSubstrateIssue,
    readPanes,
    readSubstrateIssues,
    parsePullRequests,
    parseWorktrees,
    type CommandRunner,
    type RunOutcome,
} from '../core/topology-projection.js';

const SEP = '\t';
const SCHEMA = 'xtrm.topology.projection.v1';

const paneLine = (fields: Partial<Record<string, string>>) =>
    [
        fields.pane_id ?? '%1',
        fields.session_id ?? '$1',
        fields.session_name ?? 'sess',
        fields.window_id ?? '@1',
        fields.current_command ?? 'zsh',
        fields.current_path ?? '/repo',
        fields.state ?? '',
        fields.role ?? '',
        fields.task ?? '',
        fields.bead ?? '',
        fields.worktree ?? '',
        fields.branch ?? '',
        fields.parent_session ?? '',
        fields.parent_pane ?? '',
        fields.instance ?? '',
        fields.window_index ?? '0',
        fields.pane_index ?? '0',
        fields.window_active ?? '1',
        fields.pane_active ?? '1',
        fields.window_name ?? 'zsh',
    ].join(SEP);

const COORD_PANE = paneLine({
    pane_id: '%10', session_id: '$5', session_name: 'role-claude-chain-coordinator-abc',
    current_command: 'claude', current_path: '/repo/.xtrm/worktrees/coord',
    state: 'idle', role: 'chain-coordinator', task: 'role:chain-coordinator',
    bead: 'xtrm-abc', worktree: '/repo/.xtrm/worktrees/coord', branch: 'xt/coord',
    parent_session: '$1',
});
const SHELL_PANE = paneLine({ pane_id: '%2', session_id: '$1', current_path: '/repo' });

const SP_JSON = JSON.stringify({
    flat: [
        {
            id: '900', specialist: 'executor', status: 'running', bead_id: 'xtrm-abc.1',
            epic_id: 'xtrm-abc', chain_id: '900', chain_root_job_id: '900',
            branch: 'sp/executor-900', worktree_path: '/repo/.worktrees/x/executor',
            started_at_ms: 1784211149565,
        },
        {
            id: '901', specialist: 'reviewer', status: 'error', bead_id: 'other-9',
            epic_id: 'other', chain_id: '901', chain_root_job_id: '900',
            branch: 'sp/reviewer-901', worktree_path: '/elsewhere/reviewer',
            started_at_ms: 1784211149999,
        },
    ],
});
const SB_JSON = JSON.stringify({
    schema: 'substrate-cli/v1', command: 'issue.show', ok: true,
    data: { humanRef: 'xtrm-abc', locator: 'XTRM-621.8', title: 'epic', kind: 'epic', lifecycleState: 'open', revision: 1 },
});
const SB_UNRESOLVED: RunOutcome = {
    kind: 'failed', reason: 'exit 1',
    stdout: JSON.stringify({ schema: 'substrate-cli/v1', command: 'issue.show', ok: false, error: 'unresolvable ref: xtrm-abc' }),
};
const GIT_PORCELAIN = [
    'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
    'worktree /repo/.xtrm/worktrees/coord', 'HEAD def456', 'branch refs/heads/xt/coord', '',
    'worktree /repo/.xtrm/worktrees/abandoned', 'HEAD 999999', 'detached', '',
].join('\n');
const GH_JSON = JSON.stringify([
    { number: 467, state: 'OPEN', url: 'u', title: 't', headRefName: 'xt/coord', baseRefName: 'main', isDraft: false, mergedAt: null },
]);

const OK = (stdout: string): RunOutcome => ({ kind: 'ok', stdout });

/** Records every argv issued so a test can prove the command set is read-only. */
function recordingRunner(
    responses: Partial<Record<string, RunOutcome>>,
): { runner: CommandRunner; calls: Array<{ bin: string; args: string[] }> } {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner: CommandRunner = async (bin, args) => {
        calls.push({ bin, args: [...args] });
        return responses[bin] ?? { kind: 'missing' };
    };
    return { runner, calls };
}

const healthyResponses = {
    xtmux: OK(JSON.stringify({ host: { host_id: 'workstation', tmux_server_id: 'default' } })),
    tmux: OK(`${COORD_PANE}\n${SHELL_PANE}\n`),
    sp: OK(SP_JSON),
    sb: OK(SB_JSON),
    git: OK(GIT_PORCELAIN),
    gh: OK(GH_JSON),
};

const collect = (responses: Partial<Record<string, RunOutcome>>, extra = {}) => {
    const { runner, calls } = recordingRunner(responses);
    return collectProjection({ runner, now: () => 1_000, cwd: '/repo', ...extra }).then((p) => ({ p, calls }));
};

describe('parsers', () => {
    it('marks a pane with no @agent_* lineage as not-an-agent rather than an empty agent', () => {
        const [pane] = parsePanes(SHELL_PANE);
        expect(pane.agent).toBeNull();
        expect(pane.pane_id).toBe('%2');
    });

    it('reads full lineage off a coordinator pane', () => {
        const [pane] = parsePanes(COORD_PANE);
        expect(pane.agent).toMatchObject({
            role: 'chain-coordinator',
            task: 'role:chain-coordinator',
            bead_id: 'xtrm-abc',
            branch: 'xt/coord',
            parent_session_id: '$1',
        });
    });

    it('parses porcelain worktrees including a detached one', () => {
        const trees = parseWorktrees(GIT_PORCELAIN);
        expect(trees.map((t) => t.branch)).toEqual(['main', 'xt/coord', null]);
        expect(trees[2].detached).toBe(true);
        expect(trees[1].head_sha).toBe('def456');
    });

    it('keeps the newest PR per branch so a recycled branch does not report a stale one', () => {
        const prs = parsePullRequests(JSON.stringify([
            { number: 10, state: 'CLOSED', headRefName: 'b' },
            { number: 42, state: 'OPEN', headRefName: 'b' },
        ]));
        expect(prs.get('b')?.number).toBe(42);
    });

    it('reads window and pane layout fields, and keeps a tab inside a window name', () => {
        const [pane] = parsePanes(paneLine({ window_index: '3', pane_index: '1', window_active: '0', pane_active: '1', window_name: `a${SEP}b` }));
        expect(pane).toMatchObject({ window_index: 3, pane_index: 1, window_active: false, pane_active: true, window_name: `a${SEP}b` });
    });

    it('maps a Substrate issue envelope onto the bead fields', () => {
        expect(parseSubstrateIssue('XTRM-629', SB_JSON)).toEqual({
            id: 'XTRM-629', status: 'open', title: 'epic', issue_type: 'epic', priority: null, parent_id: 'XTRM-621',
        });
    });

    it('treats an unresolvable ref as no issue, and any other envelope failure as an error', () => {
        expect(parseSubstrateIssue('xtrm-abc', SB_UNRESOLVED.kind === 'failed' ? SB_UNRESOLVED.stdout! : '')).toBeNull();
        expect(() => parseSubstrateIssue('X-1', JSON.stringify({ ok: false, error: 'database is locked' }))).toThrow(/locked/);
    });

    it('accepts issue refs and rejects anything that could reach sb as a flag', () => {
        for (const ref of ['XTRM-629', 'CORE-10.2', 'xtrm-d1fod.3']) expect(ISSUE_REF_PATTERN.test(ref)).toBe(true);
        for (const ref of ['--db', '-x', 'XTRM 1', 'a;b', '', 'XTRM-']) expect(ISSUE_REF_PATTERN.test(ref)).toBe(false);
    });
});

describe('the join', () => {
    it('links a coordinator pane to its bead, worktree, branch, job and PR', async () => {
        const { p } = await collect(healthyResponses);
        const coord = p.panes.find((x) => x.pane_id === '%10')!;

        expect(coord.agent?.role).toBe('chain-coordinator');
        expect(coord.bead).toMatchObject({ id: 'xtrm-abc', status: 'open', issue_type: 'epic' });
        expect(coord.worktree?.branch).toBe('xt/coord');
        expect(coord.pull_request?.number).toBe(467);
        expect(coord.jobs.map((j) => j.job_id)).toEqual(['900']);
    });

    it('stamps the coordinator branch onto its jobs as the integration target', async () => {
        const { p } = await collect(healthyResponses);
        const job = p.panes.find((x) => x.pane_id === '%10')!.jobs[0];
        expect(job.integration_target_branch).toBe('xt/coord');
        expect(job.owning_pane_id).toBe('%10');
    });

    it('flags a chain descendant as not a chain root', async () => {
        const { p } = await collect(healthyResponses);
        const descendant = p.orphans.jobs.find((j) => j.job_id === '901')!;
        expect(descendant.is_chain_root).toBe(false);
        expect(p.panes.find((x) => x.pane_id === '%10')!.jobs[0].is_chain_root).toBe(true);
    });

    it('reports a job with no live owning pane as an orphan rather than dropping it', async () => {
        const { p } = await collect(healthyResponses);
        expect(p.orphans.jobs.map((j) => j.job_id)).toEqual(['901']);
        expect(p.orphans.jobs[0].integration_target_branch).toBeNull();
    });

    it('reports a worktree no pane occupies as an orphan', async () => {
        const { p } = await collect(healthyResponses);
        expect(p.orphans.worktrees.map((w) => w.path)).toEqual(['/repo/.xtrm/worktrees/abandoned']);
    });

    it('does not attribute the same job to two panes', async () => {
        const twin = paneLine({
            pane_id: '%11', session_id: '$6', current_path: '/repo/.xtrm/worktrees/coord',
            role: 'chain-coordinator', bead: 'xtrm-abc', worktree: '/repo/.xtrm/worktrees/coord', branch: 'xt/coord',
        });
        const { p } = await collect({ ...healthyResponses, tmux: OK(`${COORD_PANE}\n${twin}\n`) });
        const attributed = p.panes.flatMap((x) => x.jobs.map((j) => j.job_id));
        expect(attributed).toEqual([...new Set(attributed)]);
    });

    // Regression: a plain shell at the repo root used to adopt every running job
    // in the repo, because specialist worktrees are nested under it. Observed on
    // a live host — a `diff` session claimed an unrelated reviewer job.
    it('a pane at the repo root does not adopt jobs merely nested beneath it', async () => {
        const rootShell = paneLine({ pane_id: '%99', session_id: '$9', current_path: '/repo' });
        const { p } = await collect({ ...healthyResponses, tmux: OK(`${rootShell}\n`) });
        expect(p.panes[0].jobs).toEqual([]);
        expect(p.orphans.jobs.map((j) => j.job_id).sort()).toEqual(['900', '901']);
    });

    it('attributes a job to a pane parked inside that job\'s own worktree', async () => {
        const inJob = paneLine({
            pane_id: '%98', session_id: '$8', current_path: '/repo/.worktrees/x/executor',
        });
        const { runner } = recordingRunner({
            ...healthyResponses,
            tmux: OK(`${inJob}\n`),
            git: OK([
                'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
                'worktree /repo/.worktrees/x/executor', 'HEAD e1', 'branch refs/heads/sp/executor-900', '',
            ].join('\n')),
        });
        const p = await collectProjection({ runner, now: () => 1_000, cwd: '/repo' });
        expect(p.panes[0].jobs.map((j) => j.job_id)).toEqual(['900']);
    });

    it('enumerates worktrees for panes in another repository', async () => {
        const otherPane = paneLine({
            pane_id: '%77', session_id: '$7', current_path: '/other/.worktrees/reviewer',
        });
        const otherGit = [
            'worktree /other', 'HEAD 111111', 'branch refs/heads/main', '',
            'worktree /other/.worktrees/reviewer', 'HEAD 222222', 'branch refs/heads/sp/reviewer-901', '',
        ].join('\n');
        const calls: Array<{ bin: string; cwd?: string }> = [];
        const runner: CommandRunner = async (bin, args, opts) => {
            calls.push({ bin, cwd: opts.cwd });
            if (bin === 'git') return OK(opts.cwd?.startsWith('/other') ? otherGit : GIT_PORCELAIN);
            if (bin === 'tmux') return OK(`${COORD_PANE}\n${SHELL_PANE}\n${otherPane}\n`);
            return healthyResponses[bin as keyof typeof healthyResponses] ?? { kind: 'missing' };
        };
        const p = await collectProjection({
            runner,
            now: () => 1_000,
            cwd: '/repo',
            includeGithub: true,
        });

        expect(p.panes.find((pane) => pane.pane_id === '%77')?.worktree).toMatchObject({
            path: '/other/.worktrees/reviewer',
            branch: 'sp/reviewer-901',
        });
        expect(calls.filter((call) => call.bin === 'git').map((call) => call.cwd)).toEqual(['/repo', '/other/.worktrees/reviewer']);
    });

    it('records every pane sharing a worktree, which is the collision signal', async () => {
        const twin = paneLine({ pane_id: '%3', session_id: '$9', current_path: '/repo' });
        const { p } = await collect({ ...healthyResponses, tmux: OK(`${SHELL_PANE}\n${twin}\n`) });
        expect(p.panes[0].worktree?.shared_by_pane_ids).toEqual(['%2', '%3']);
    });

    it('falls back to a placeholder issue when Substrate cannot resolve the ref, without failing the source', async () => {
        const { p } = await collect({ ...healthyResponses, sb: SB_UNRESOLVED });
        expect(p.panes.find((x) => x.pane_id === '%10')!.bead).toEqual({ id: 'xtrm-abc', status: 'unknown' });
        expect(p.sources.find((s) => s.name === 'substrate')!.status).toBe('ok');
    });

    it('carries the pane layout and the joined agent session, and null outside the host', async () => {
        const { p } = await collect(healthyResponses);
        expect(p.panes[0]).toMatchObject({ window_index: 0, pane_index: 0, window_name: 'zsh', agent_session: null });

        const { runner } = recordingRunner(healthyResponses);
        const panes = await readPanes({ runner });
        const enrichment = await collectEnrichment(panes.data ?? [], { runner, cwd: '/repo' });
        const sessions = new Map([['%10', { session_id: 'sess-1', provider: 'pi', state: 'working' }]]);
        const joined = joinProjection(panes, enrichment, { agentSessions: sessions });
        expect(joined.panes.find((x) => x.pane_id === '%10')!.agent_session).toEqual({ session_id: 'sess-1', provider: 'pi', state: 'working' });
        expect(joined.panes.find((x) => x.pane_id === '%2')!.agent_session).toBeNull();
        expect(validate(SCHEMA, joined).valid).toBe(true);
    });

    it('joining one enrichment twice gives the same result (the join does not mutate it)', async () => {
        const { runner } = recordingRunner(healthyResponses);
        const panes = await readPanes({ runner });
        const enrichment = await collectEnrichment(panes.data ?? [], { runner, cwd: '/repo' });
        const a = joinProjection(panes, enrichment, { now: () => 1 });
        const b = joinProjection(panes, enrichment, { now: () => 1 });
        expect(b).toEqual(a);
        expect(a.panes.find((x) => x.pane_id === '%2')!.worktree?.shared_by_pane_ids).toEqual(['%2']);
    });
});

describe('per-source degradation', () => {
    it('records an absent binary as unavailable, not error', async () => {
        const { p } = await collect({ ...healthyResponses, sp: { kind: 'missing' } });
        const entry = p.sources.find((s) => s.name === 'specialists')!;
        expect(entry.status).toBe('unavailable');
        expect(entry.reason).toMatch(/not found on PATH/);
    });

    it('records a present-but-failing binary as error', async () => {
        const { p } = await collect({ ...healthyResponses, sp: { kind: 'failed', reason: 'db locked' } });
        expect(p.sources.find((s) => s.name === 'specialists')).toMatchObject({ status: 'error', reason: 'db locked' });
    });

    it('records a timeout as error and still returns a snapshot', async () => {
        const { p } = await collect({ ...healthyResponses, gh: { kind: 'timeout' } });
        expect(p.sources.find((s) => s.name === 'github')).toMatchObject({ status: 'error' });
        expect(p.panes.length).toBe(2);
    });

    it('treats malformed JSON as error, since the binary answered', async () => {
        const { p } = await collect({ ...healthyResponses, sb: OK('not json at all') });
        expect(p.sources.find((s) => s.name === 'substrate')!.status).toBe('error');
        expect(p.panes.find((x) => x.pane_id === '%10')!.bead).toEqual({ id: 'xtrm-abc', status: 'unknown' });
    });

    it('records an absent sb as unavailable', async () => {
        const { p } = await collect({ ...healthyResponses, sb: { kind: 'missing' } });
        expect(p.sources.find((s) => s.name === 'substrate')).toMatchObject({ status: 'unavailable' });
    });

    it('bounds Substrate lookups to MAX_ISSUE_REFS distinct, valid refs', async () => {
        const calls: string[][] = [];
        const runner: CommandRunner = async (_bin, args) => { calls.push([...args]); return OK(SB_JSON); };
        const refs = [...Array.from({ length: 100 }, (_, i) => `XTRM-${i}`), 'XTRM-1', '--db'];
        const read = await readSubstrateIssues(refs, { runner, now: () => 0 });
        expect(calls.length).toBe(64);
        expect(calls.every((argv) => argv.slice(0, 3).join(' ') === '--json issue show')).toBe(true);
        expect(read.entry.status).toBe('ok');
    });

    it('survives every single source failing at once', async () => {
        const { p } = await collect({});
        // No pane names an issue, so Substrate has nothing to look up.
        expect(p.sources.filter((s) => s.name !== 'substrate').every((s) => s.status === 'unavailable')).toBe(true);
        expect(p.panes).toEqual([]);
        expect(validate(SCHEMA, p).valid).toBe(true);
    });

    it('--no-github records github as skipped without querying it', async () => {
        const { p, calls } = await collect(healthyResponses, { includeGithub: false });
        expect(calls.some((c) => c.bin === 'gh')).toBe(false);
        expect(p.sources.find((s) => s.name === 'github')).toMatchObject({
            status: 'unavailable', reason: 'skipped by --no-github',
        });
    });

    it('always emits one ledger entry per source, so degraded never looks empty', async () => {
        const { p } = await collect({ ...healthyResponses, sp: { kind: 'missing' } });
        expect(p.sources.map((s) => s.name).sort()).toEqual(
            ['git', 'github', 'specialists', 'substrate', 'tmux', 'xtmux'],
        );
    });
});

describe('read-only guarantee', () => {
    // The projection must never mutate a source system. Asserting the exact argv
    // of every issued command is what makes that checkable rather than asserted.
    it('issues only the commands declared in READ_ONLY_COMMANDS', async () => {
        const { calls } = await collect(healthyResponses);
        const allowed = Object.values(READ_ONLY_COMMANDS).map((c) => `${c.bin} ${c.args.join(' ')}`);
        for (const call of calls) {
            if (call.bin === READ_ONLY_COMMANDS.substrate.bin) {
                // The one parameterised read: the declared argv plus one validated ref.
                expect(call.args.slice(0, -1)).toEqual([...READ_ONLY_COMMANDS.substrate.args]);
                expect(call.args.at(-1)).toMatch(ISSUE_REF_PATTERN);
                continue;
            }
            expect(allowed).toContain(`${call.bin} ${call.args.join(' ')}`);
        }
        expect(calls.length).toBe(6);
    });

    it('every declared command is a known read-only verb', () => {
        const readOnlyVerbs: Record<string, string> = {
            xtmux: 'topology', tmux: 'list-panes', sp: 'ps', git: 'worktree', gh: 'pr',
        };
        for (const cmd of Object.values(READ_ONLY_COMMANDS)) {
            if (cmd.bin === 'sb') continue;
            expect(cmd.args[0]).toBe(readOnlyVerbs[cmd.bin]);
        }
        // sb issue has mutating verbs (claim/close/edit); pin the read.
        expect(READ_ONLY_COMMANDS.substrate.args).toEqual(['--json', 'issue', 'show']);
        // git worktree has mutating subcommands (add/remove/prune); pin the read.
        expect(READ_ONLY_COMMANDS.git.args).toEqual(['worktree', 'list', '--porcelain']);
        // gh pr likewise (create/merge/close); pin the read.
        expect(READ_ONLY_COMMANDS.github.args.slice(0, 2)).toEqual(['pr', 'list']);
    });

    it('declares a bounded timeout for every source', () => {
        for (const cmd of Object.values(READ_ONLY_COMMANDS)) {
            expect(cmd.timeoutMs).toBeGreaterThan(0);
            expect(cmd.timeoutMs).toBeLessThanOrEqual(15_000);
        }
    });

    it('two consecutive collections issue identical argv (no accumulated state)', async () => {
        const a = await collect(healthyResponses);
        const b = await collect(healthyResponses);
        expect(a.calls).toEqual(b.calls);
        expect(a.p).toEqual(b.p);
    });
});

describe('contract conformance', () => {
    it('a healthy snapshot validates against xtrm.topology.projection.v1', async () => {
        const { p } = await collect(healthyResponses);
        const result = validate(SCHEMA, p);
        expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
        expect(result.valid).toBe(true);
    });

    it('a degraded snapshot validates too', async () => {
        const { p } = await collect({ tmux: OK(`${SHELL_PANE}\n`) });
        expect(validate(SCHEMA, p).valid).toBe(true);
    });

    it('carries no pane-capture field anywhere', async () => {
        const { p } = await collect(healthyResponses);
        const blob = JSON.stringify(p);
        for (const banned of ['"content"', '"capture"', '"preview"', '"terminal_text"']) {
            expect(blob).not.toContain(banned);
        }
    });
});
