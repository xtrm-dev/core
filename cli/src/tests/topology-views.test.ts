import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { TopologyProjectionV1 } from '@xtrm/contracts';
import { VIEW_DESCRIPTIONS, VIEW_NAMES, isViewName, renderView } from '../core/topology-views.js';

/** Every source healthy unless a test says otherwise. */
const sources = (over: Partial<Record<string, { status: string; reason: string | null }>> = {}) =>
    (['xtmux', 'tmux', 'specialists', 'beads', 'git', 'github'] as const).map((name) => ({
        name,
        status: (over[name]?.status ?? 'ok') as 'ok' | 'unavailable' | 'error',
        reason: over[name]?.reason ?? null,
        duration_ms: 10,
    }));

const fixture = (over: Partial<TopologyProjectionV1> = {}): TopologyProjectionV1 => ({
    schema_version: 'xtrm.topology.projection.v1',
    generated_at_ms: 1_000,
    host: { host_id: 'workstation', tmux_server_id: 'default' },
    sources: sources(),
    panes: [
        {
            pane_id: '%10',
            session_id: '$5',
            session_name: 'role-claude-chain-coordinator-abc',
            window_id: '@1',
            current_command: 'claude',
            current_path: '/repo/.xtrm/worktrees/coord',
            agent: {
                state: 'idle',
                role: 'chain-coordinator',
                task: 'role:chain-coordinator',
                bead_id: 'xtrm-abc',
                worktree: '/repo/.xtrm/worktrees/coord',
                branch: 'xt/coord',
                parent_session_id: '$1',
            },
            jobs: [{
                job_id: '900', specialist: 'executor', status: 'running', bead_id: 'xtrm-abc.1',
                epic_id: 'xtrm-abc', chain_id: '900', chain_root_job_id: '900', is_chain_root: true,
                branch: 'sp/executor-900', worktree_path: '/repo/.worktrees/x',
                integration_target_branch: 'xt/coord', owning_pane_id: '%10',
            }],
            bead: { id: 'xtrm-abc', status: 'in_progress', title: 'epic', issue_type: 'epic', priority: 1 },
            worktree: {
                path: '/repo/.xtrm/worktrees/coord', branch: 'xt/coord',
                head_sha: 'def456', detached: false, shared_by_pane_ids: ['%10'],
            },
            pull_request: {
                number: 467, state: 'OPEN', url: 'u', title: 't', head_branch: 'xt/coord',
                base_branch: 'main', is_draft: false, merged_at: null, checks_state: null,
            },
        },
    ],
    orphans: { jobs: [], worktrees: [] },
    ...over,
});

describe('view registry', () => {
    it('every declared view has a description and a renderer', () => {
        for (const name of VIEW_NAMES) {
            expect(VIEW_DESCRIPTIONS[name]).toBeTruthy();
            expect(typeof renderView(name, fixture())).toBe('string');
        }
    });

    it('isViewName rejects an unknown name', () => {
        expect(isViewName('chains')).toBe(true);
        expect(isViewName('nope')).toBe(false);
    });
});

describe('views are pure functions of the snapshot', () => {
    // A renderer that shells out has escaped its contract: it could then show
    // something the projection never reported, and would stop being testable
    // without a live host.
    // Asserted structurally rather than with a spy: ESM namespaces are not
    // configurable so child_process exports cannot be spied on, and "the module
    // never imports a process API" is a stronger guarantee than "it did not call
    // one during this test" anyway.
    it('the views module has no access to a subprocess API at all', async () => {
        const src = await readFile(
            new URL('../core/topology-views.ts', import.meta.url),
            'utf8',
        );
        for (const banned of ['child_process', 'execFile', 'spawn', 'execSync', 'node:fs']) {
            expect(src, `views module must not reference ${banned}`).not.toContain(banned);
        }
    });

    it('rendering twice yields identical output', () => {
        const p = fixture();
        for (const name of VIEW_NAMES) expect(renderView(name, p)).toBe(renderView(name, p));
    });

    it('rendering does not mutate the projection', () => {
        const p = fixture();
        const before = JSON.stringify(p);
        for (const name of VIEW_NAMES) renderView(name, p);
        expect(JSON.stringify(p)).toBe(before);
    });
});

describe('completion is never inferred from terminal output', () => {
    // The audit's hardest P2-06 rule. A pane whose runtime state says "idle" (or
    // whose session is literally named "done") with an OPEN bead and an unmerged
    // PR must never render as complete.
    const misleading = () => {
        const p = fixture();
        p.panes[0].session_name = 'work-is-done-finished-complete';
        p.panes[0].agent!.state = 'idle';
        p.panes[0].agent!.task = 'session:done';
        p.panes[0].bead = { id: 'xtrm-abc', status: 'open', title: 'done done done', issue_type: 'task', priority: 1 };
        p.panes[0].pull_request = {
            number: 467, state: 'OPEN', url: 'u', title: 'done', head_branch: 'xt/coord',
            base_branch: 'main', is_draft: false, merged_at: null, checks_state: null,
        };
        return p;
    };

    it('does not report merged/closed when the bead is open and the PR unmerged', () => {
        const out = renderView('chains', misleading());
        // The session name, task and bead title all say "done"; the only
        // authoritative signals say otherwise, so the status must reflect those.
        expect(out).toContain('pr open');
        expect(out).not.toContain('merged');
        expect(out).not.toContain('closed');
    });

    it('reports merged only when merged_at is set', () => {
        const p = fixture();
        p.panes[0].pull_request!.merged_at = '2026-07-21T17:04:11Z';
        expect(renderView('chains', p)).toContain('merged');
    });

    it('reports bead closed only from bead.status', () => {
        const p = fixture();
        p.panes[0].bead!.status = 'closed';
        expect(renderView('chains', p)).toContain('bead closed');
    });

    it('reports a Substrate issue in state done as closed', () => {
        const p = fixture();
        p.panes[0].bead!.status = 'done';
        expect(renderView('chains', p)).toContain('bead closed');
    });

    it('agent.state alone never produces a completion claim', () => {
        const p = fixture();
        p.panes[0].bead = null;
        p.panes[0].pull_request = null;
        p.panes[0].agent!.state = 'idle';
        const out = renderView('chains', p);
        expect(out).not.toContain('merged');
        expect(out).not.toContain('closed');
    });
});

describe('pane capture never appears', () => {
    it('no view emits captured terminal content', () => {
        const p = fixture();
        // Force-inject content the contract cannot legally carry; if any view
        // blindly serialised the snapshot it would surface here.
        (p.panes[0] as unknown as Record<string, unknown>).content = 'SECRET-TERMINAL-TEXT';
        for (const name of VIEW_NAMES) {
            expect(renderView(name, p)).not.toContain('SECRET-TERMINAL-TEXT');
        }
    });

    it('the routes view points at xtmux pane capture instead of rendering it', () => {
        const out = renderView('routes', fixture());
        expect(out).toContain('xtmux pane capture --pane %10');
        expect(out).toContain('never journalled');
    });
});

describe('degraded sources are visually distinct from empty results', () => {
    it('an unavailable specialists source is announced in the chains view', () => {
        const p = fixture({ sources: sources({ specialists: { status: 'unavailable', reason: 'sp not found on PATH' } }) });
        p.panes[0].jobs = [];
        const out = renderView('chains', p);
        expect(out).toContain('did not report');
        expect(out).toContain('sp not found on PATH');
    });

    it('a genuinely empty result says nothing about sources', () => {
        const p = fixture();
        p.panes[0].jobs = [];
        expect(renderView('chains', p)).not.toContain('did not report');
    });

    it('an errored github source is announced in the prs view', () => {
        const p = fixture({ sources: sources({ github: { status: 'error', reason: 'gh timed out' } }) });
        expect(renderView('prs', p)).toContain('gh timed out');
    });

    it('only sources a view actually depends on are announced', () => {
        const p = fixture({ sources: sources({ github: { status: 'error', reason: 'gh timed out' } }) });
        // lineage reads specialists, not github.
        expect(renderView('lineage', p)).not.toContain('gh timed out');
    });
});

describe('individual views', () => {
    it('topology lists every pane with its role', () => {
        const out = renderView('topology', fixture());
        expect(out).toContain('%10');
        expect(out).toContain('chain-coordinator');
    });

    it('chains shows a coordinator and the jobs it owns with the integration target', () => {
        const out = renderView('chains', fixture());
        expect(out).toContain('900');
        expect(out).toContain('sp/executor-900 -> xt/coord');
    });

    it('lineage nests a descendant under its chain root', () => {
        const p = fixture();
        p.orphans.jobs = [{
            job_id: '901', specialist: 'reviewer', status: 'done', bead_id: 'b', epic_id: 'e',
            chain_id: '900', chain_root_job_id: '900', is_chain_root: false,
            branch: 'sp/reviewer-901', worktree_path: '/w', integration_target_branch: null, owning_pane_id: null,
        }];
        const out = renderView('lineage', p);
        expect(out).toMatch(/└─\s+901/);
    });

    it('lineage surfaces a descendant whose chain root is missing', () => {
        const p = fixture();
        p.panes[0].jobs = [];
        p.orphans.jobs = [{
            job_id: '901', specialist: 'reviewer', status: 'error', bead_id: 'b', epic_id: 'e',
            chain_id: '900', chain_root_job_id: '900', is_chain_root: false,
            branch: 'sp/r', worktree_path: '/w', integration_target_branch: null, owning_pane_id: null,
        }];
        expect(renderView('lineage', p)).toContain('chain root is not present');
    });

    it('collisions reports none when no worktree is shared', () => {
        expect(renderView('collisions', fixture())).toContain('No worktree is shared');
    });

    it('collisions names the sharing panes and the mitigation', () => {
        const p = fixture();
        p.panes[0].worktree!.shared_by_pane_ids = ['%10', '%11'];
        const out = renderView('collisions', p);
        expect(out).toContain('%10 %11');
        expect(out).toContain('xt claude');
    });

    it('worktrees lists unattached worktrees separately', () => {
        const p = fixture();
        p.orphans.worktrees = [{ path: '/repo/.xtrm/worktrees/abandoned', branch: null, head_sha: 'a', detached: true, shared_by_pane_ids: [] }];
        const out = renderView('worktrees', p);
        expect(out).toContain('unattached worktrees (1)');
        expect(out).toContain('(detached)');
    });

    it('beads marks an unresolvable cross-repo bead as unknown rather than failed', () => {
        const p = fixture();
        p.panes[0].bead = { id: 'other-1', status: 'unknown' };
        const out = renderView('beads', p);
        expect(out).toContain('unknown');
        expect(out).toContain('other repo');
    });

    it('summary flags collisions and degraded sources together', () => {
        const p = fixture({ sources: sources({ specialists: { status: 'error', reason: 'db locked' } }) });
        p.panes[0].worktree!.shared_by_pane_ids = ['%10', '%11'];
        const out = renderView('summary', p);
        expect(out).toContain('collisions');
        expect(out).toContain('db locked');
    });

    it('every view renders on a fully empty projection without throwing', () => {
        const empty: TopologyProjectionV1 = {
            schema_version: 'xtrm.topology.projection.v1',
            generated_at_ms: 1,
            host: { host_id: 'h', tmux_server_id: null },
            sources: sources(),
            panes: [],
            orphans: { jobs: [], worktrees: [] },
        };
        for (const name of VIEW_NAMES) expect(() => renderView(name, empty)).not.toThrow();
    });
});
