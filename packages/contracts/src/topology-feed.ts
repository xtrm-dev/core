// Topology feed diff helpers (xtrm.agent-host-api.v1 topology_update; XTRM-629).
// The agent host produces updates with diffTopology(); a client applies them with
// applyTopologyUpdate(). Both sides share this code so "apply(prev, diff(prev, next))
// equals next" is one tested property instead of two implementations that can drift.

import type { TopologyPane, TopologyProjectionV1, TopologyUpdateBody } from './types.js';

/** The content part of a topology_update: everything except the feed envelope fields. */
export type TopologyDiff = Pick<TopologyUpdateBody, 'generated_at_ms' | 'panes' | 'order' | 'host' | 'sources' | 'orphans'>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Pane ids in the order a client holds them after applying removes and upserts. */
function appliedOrder(prev: readonly TopologyPane[], remove: ReadonlySet<string>, upsert: readonly TopologyPane[]): string[] {
    const order = prev.map((pane) => pane.pane_id).filter((id) => !remove.has(id));
    const known = new Set(order);
    for (const pane of upsert) if (!known.has(pane.pane_id)) order.push(pane.pane_id);
    return order;
}

/**
 * Panes are keyed by pane_id and sent whole when anything in them changed. `order`
 * is included only when the applied order would differ from `next`; host, sources
 * and orphans only when they changed.
 */
export function diffTopology(prev: TopologyProjectionV1, next: TopologyProjectionV1): TopologyDiff {
    const before = new Map(prev.panes.map((pane) => [pane.pane_id, JSON.stringify(pane)]));
    const nextIds = new Set(next.panes.map((pane) => pane.pane_id));
    const upsert = next.panes.filter((pane) => before.get(pane.pane_id) !== JSON.stringify(pane));
    const remove = prev.panes.map((pane) => pane.pane_id).filter((id) => !nextIds.has(id));
    const diff: TopologyDiff = { generated_at_ms: next.generated_at_ms, panes: { upsert, remove } };
    const order = next.panes.map((pane) => pane.pane_id);
    if (!same(appliedOrder(prev.panes, new Set(remove), upsert), order)) diff.order = order;
    if (!same(prev.host, next.host)) diff.host = next.host;
    if (!same(prev.sources, next.sources)) diff.sources = next.sources;
    if (!same(prev.orphans, next.orphans)) diff.orphans = next.orphans;
    return diff;
}

/**
 * Apply one update to the projection it was computed against. The caller checks
 * `base_revision` first; this function does not know revisions. Returns a new object.
 */
export function applyTopologyUpdate(prev: TopologyProjectionV1, update: TopologyDiff): TopologyProjectionV1 {
    const remove = new Set(update.panes.remove);
    const byId = new Map(prev.panes.filter((pane) => !remove.has(pane.pane_id)).map((pane) => [pane.pane_id, pane]));
    for (const pane of update.panes.upsert) byId.set(pane.pane_id, pane);
    const order = update.order ?? appliedOrder(prev.panes, remove, update.panes.upsert);
    return {
        ...prev,
        generated_at_ms: update.generated_at_ms,
        host: update.host ?? prev.host,
        sources: update.sources ?? prev.sources,
        orphans: update.orphans ?? prev.orphans,
        panes: order.map((id) => byId.get(id)).filter((pane): pane is TopologyPane => pane !== undefined),
    };
}
