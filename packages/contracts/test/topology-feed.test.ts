import { describe, expect, it } from 'vitest';
import { applyTopologyUpdate, diffTopology, validate, type TopologyPane, type TopologyProjectionV1 } from '../src/index.js';

const pane = (id: string, extra: Partial<TopologyPane> = {}): TopologyPane => ({
    pane_id: id,
    session_id: '$1',
    session_name: 'main',
    window_id: '@1',
    window_index: 0,
    window_name: 'zsh',
    window_active: true,
    pane_index: 0,
    pane_active: true,
    agent_session: null,
    current_command: 'zsh',
    current_path: '/home/op',
    agent: null,
    jobs: [],
    bead: null,
    worktree: null,
    pull_request: null,
    ...extra,
});

const projection = (panes: TopologyPane[], at = 1): TopologyProjectionV1 => ({
    schema_version: 'xtrm.topology.projection.v1',
    generated_at_ms: at,
    host: { host_id: 'h', tmux_server_id: null },
    sources: (['xtmux', 'tmux', 'specialists', 'substrate', 'git', 'github'] as const).map((name) => ({
        name, status: 'ok' as const, reason: null, duration_ms: 1,
    })),
    panes,
    orphans: { jobs: [], worktrees: [] },
});

const envelope = (diff: ReturnType<typeof diffTopology>) => ({
    schema: 'xtrm.agent-host-api.v1',
    kind: 'topology_update',
    topology: 1,
    seq: 1,
    base_revision: '0000000000000000',
    revision: '1111111111111111',
    ...diff,
});

describe('topology feed diff', () => {
    const cases: Array<[string, TopologyProjectionV1, TopologyProjectionV1]> = [
        ['no change', projection([pane('%1')]), projection([pane('%1')], 2)],
        ['pane added', projection([pane('%1')]), projection([pane('%1'), pane('%2')], 2)],
        ['pane removed', projection([pane('%1'), pane('%2')]), projection([pane('%2')], 2)],
        ['window renamed', projection([pane('%1')]), projection([pane('%1', { window_name: 'build' })], 2)],
        ['reordered', projection([pane('%1'), pane('%2')]), projection([pane('%2'), pane('%1')], 2)],
        ['added in the middle', projection([pane('%1'), pane('%3')]), projection([pane('%1'), pane('%2'), pane('%3')], 2)],
        ['all replaced', projection([pane('%1')]), projection([pane('%7'), pane('%8')], 2)],
    ];

    it.each(cases)('%s: apply(prev, diff(prev, next)) equals next and validates', (_name, prev, next) => {
        const diff = diffTopology(prev, next);
        expect(applyTopologyUpdate(prev, diff)).toEqual(next);
        const result = validate('xtrm.agent-host-api.v1', envelope(diff));
        expect(result.errors).toEqual([]);
    });

    it('sends only changed panes and omits unchanged top-level fields', () => {
        const prev = projection([pane('%1'), pane('%2')]);
        const next = projection([pane('%1'), pane('%2', { agent: null, current_command: 'vim' })], 2);
        const diff = diffTopology(prev, next);
        expect(diff.panes.upsert.map((p) => p.pane_id)).toEqual(['%2']);
        expect(diff.panes.remove).toEqual([]);
        expect(diff).not.toHaveProperty('order');
        expect(diff).not.toHaveProperty('sources');
        expect(diff).not.toHaveProperty('orphans');
    });

    it('carries changed sources whole', () => {
        const prev = projection([pane('%1')]);
        const next = projection([pane('%1')], 2);
        next.sources[3] = { name: 'substrate', status: 'unavailable', reason: 'sb not found on PATH', duration_ms: 0 };
        expect(diffTopology(prev, next).sources).toEqual(next.sources);
    });
});
