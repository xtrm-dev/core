/**
 * Operator views over the aggregated topology projection — audit ~/dev/11.md P2-06.
 *
 * Every view is a pure function `(TopologyProjectionV1) => string[]`. That is what
 * keeps them unit-testable without a live host, and — more importantly — what
 * stops a view from quietly acquiring its own data source: a renderer with no
 * subprocess access cannot drift away from the projection it claims to display.
 *
 * TWO RULES THE AUDIT MAKES NON-NEGOTIABLE, ENFORCED HERE:
 *
 * 1. Completion is never inferred from terminal output. The only completion
 *    signals these views may read are `bead.status`, `pull_request.merged_at` /
 *    `state`, and `job.status`. `agent.state` is a runtime lifecycle signal
 *    (idle/working) and is deliberately NOT treated as done-ness anywhere.
 *
 * 2. Pane capture is diagnostic only. No view renders pane content — the
 *    projection cannot even carry it. The `routes` view instead prints the exact
 *    `xtmux pane capture` command, so capture output never transits this process
 *    and can never reach a durable journal.
 *
 * Views that are live streams or diagnostics (journal feed, obligations, monitors,
 * pane preview, git diff) are ROUTED to their owning command rather than
 * reimplemented — xtmux and git already own, bound and clamp those surfaces.
 */

import kleur from 'kleur';
import type {
    TopologyJob,
    TopologyPane,
    TopologyProjectionV1,
    TopologyPullRequest,
} from '@xtrm/contracts';

export const VIEW_NAMES = [
    'summary',
    'topology',
    'chains',
    'lineage',
    'worktrees',
    'collisions',
    'integration',
    'beads',
    'prs',
    'routes',
] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

export const VIEW_DESCRIPTIONS: Record<ViewName, string> = {
    summary: 'source ledger + counts (default)',
    topology: 'runtime topology — every pane, its session, command and role',
    chains: 'coordinator chains — coordinator panes and the jobs they own',
    lineage: 'specialist lineage — chain roots and their descendants',
    worktrees: 'worktree and branch graph, including unattached worktrees',
    collisions: 'worktrees shared by more than one live pane',
    integration: 'integration status — job branch, target branch and PR state',
    beads: 'issue state per pane (Substrate)',
    prs: 'pull-request evidence per branch',
    routes: 'exact commands for the live/diagnostic surfaces xtmux and git own',
};

const dim = (s: string) => kleur.dim(s);
const NONE = dim('  (none)');

/**
 * A degraded source must never render as an empty result. Without this an absent
 * `sp` and "no jobs running" produce the same blank table, and the operator reads
 * a broken query as a quiet fleet.
 */
function degradationNotice(p: TopologyProjectionV1, sources: string[]): string[] {
    const down = p.sources.filter((s) => sources.includes(s.name) && s.status !== 'ok');
    if (down.length === 0) return [];
    return [
        '',
        kleur.yellow(`! ${down.length} source(s) did not report — this view is incomplete:`),
        ...down.map((s) => kleur.yellow(`    ${s.name}: ${s.status}${s.reason ? ` — ${s.reason}` : ''}`)),
    ];
}

const pad = (s: string | null | undefined, n: number) => (s ?? '-').slice(0, n).padEnd(n);

/** Completion is read from bead/PR/job state only — never from agent.state. */
function completionOf(pane: TopologyPane): string {
    if (pane.pull_request?.merged_at) return kleur.green('merged');
    // Substrate closes an issue as `done`; `closed` is the Beads-era status.
    if (pane.bead?.status === 'done' || pane.bead?.status === 'closed') return kleur.green('bead closed');
    if (pane.pull_request) return `pr ${pane.pull_request.state.toLowerCase()}`;
    if (pane.bead) return `bead ${pane.bead.status}`;
    return dim('-');
}

// ── views ───────────────────────────────────────────────────────────────────

function viewSummary(p: TopologyProjectionV1): string[] {
    const agents = p.panes.filter((x) => x.agent).length;
    const jobs = p.panes.reduce((n, x) => n + x.jobs.length, 0);
    const collisions = collidingWorktrees(p).length;
    const out = [kleur.bold('sources')];
    for (const s of p.sources) {
        const mark = s.status === 'ok' ? kleur.green('ok')
            : s.status === 'unavailable' ? kleur.yellow('unavailable')
                : kleur.red('error');
        out.push(`  ${pad(s.name, 12)} ${mark}${s.reason ? dim(` — ${s.reason}`) : ''} ${dim(`(${s.duration_ms}ms)`)}`);
    }
    out.push('', kleur.bold('projection'));
    out.push(`  panes            ${p.panes.length} (${agents} agent)`);
    out.push(`  specialist jobs  ${jobs} attached, ${p.orphans.jobs.length} orphaned`);
    out.push(`  worktrees        ${p.orphans.worktrees.length} unattached`);
    if (collisions > 0) out.push(kleur.yellow(`  collisions       ${collisions} worktree(s) shared by >1 pane`));
    out.push(...degradationNotice(p, ['xtmux', 'tmux', 'specialists', 'substrate', 'beads', 'git', 'github']));
    out.push('', dim('Views: xt topology --view <name>   (xt topology --help lists them)'));
    return out;
}

function viewTopology(p: TopologyProjectionV1): string[] {
    const out = [kleur.bold(`${pad('PANE', 8)} ${pad('SESSION', 30)} ${pad('CMD', 10)} ${pad('ROLE', 18)} PATH`)];
    if (p.panes.length === 0) out.push(NONE);
    for (const x of p.panes) {
        out.push(`${pad(x.pane_id, 8)} ${pad(x.session_name, 30)} ${pad(x.current_command, 10)} ${pad(x.agent?.role, 18)} ${dim(x.current_path)}`);
    }
    return [...out, ...degradationNotice(p, ['tmux', 'xtmux'])];
}

function viewChains(p: TopologyProjectionV1): string[] {
    const coordinators = p.panes.filter((x) => x.agent?.role || x.jobs.length > 0);
    const out: string[] = [];
    if (coordinators.length === 0) out.push(NONE);
    for (const x of coordinators) {
        out.push(`${kleur.bold(x.pane_id)} ${x.session_name} ${dim(`role=${x.agent?.role ?? '-'} bead=${x.agent?.bead_id ?? '-'} branch=${x.agent?.branch ?? '-'}`)}`);
        out.push(`  ${dim('status:')} ${completionOf(x)}`);
        if (x.jobs.length === 0) out.push(dim('  no specialist jobs'));
        for (const j of x.jobs) out.push(`  - ${pad(j.job_id, 8)} ${pad(j.specialist, 16)} ${pad(j.status, 10)} ${dim(`${j.branch ?? '-'} -> ${j.integration_target_branch ?? '-'}`)}`);
    }
    return [...out, ...degradationNotice(p, ['tmux', 'specialists'])];
}

function viewLineage(p: TopologyProjectionV1): string[] {
    const all = [...p.panes.flatMap((x) => x.jobs), ...p.orphans.jobs];
    const out: string[] = [];
    if (all.length === 0) out.push(NONE);
    const roots = all.filter((j) => j.is_chain_root);
    const childrenOf = (root: TopologyJob) =>
        all.filter((j) => !j.is_chain_root && j.chain_root_job_id === root.job_id);
    for (const root of roots) {
        const owner = root.owning_pane_id ?? kleur.yellow('orphan');
        out.push(`${kleur.bold(root.job_id)} ${pad(root.specialist, 16)} ${pad(root.status, 10)} ${dim(`bead=${root.bead_id ?? '-'} epic=${root.epic_id ?? '-'} owner=${owner}`)}`);
        for (const c of childrenOf(root)) {
            out.push(`  └─ ${pad(c.job_id, 8)} ${pad(c.specialist, 16)} ${pad(c.status, 10)} ${dim(c.branch ?? '-')}`);
        }
    }
    // A descendant whose root is gone would otherwise be invisible in this view.
    const orphanedDescendants = all.filter(
        (j) => !j.is_chain_root && !roots.some((r) => r.job_id === j.chain_root_job_id),
    );
    if (orphanedDescendants.length > 0) {
        out.push('', kleur.yellow('descendants whose chain root is not present:'));
        for (const j of orphanedDescendants) out.push(`  ${pad(j.job_id, 8)} ${pad(j.specialist, 16)} ${dim(`root=${j.chain_root_job_id ?? '-'}`)}`);
    }
    return [...out, ...degradationNotice(p, ['specialists'])];
}

function viewWorktrees(p: TopologyProjectionV1): string[] {
    const out = [kleur.bold(`${pad('BRANCH', 34)} ${pad('PANES', 8)} PATH`)];
    const seen = new Set<string>();
    for (const x of p.panes) {
        const w = x.worktree;
        if (!w || seen.has(w.path)) continue;
        seen.add(w.path);
        out.push(`${pad(w.branch ?? (w.detached ? '(detached)' : '-'), 34)} ${pad(String(w.shared_by_pane_ids?.length ?? 0), 8)} ${dim(w.path)}`);
    }
    if (p.orphans.worktrees.length > 0) {
        out.push('', kleur.yellow(`unattached worktrees (${p.orphans.worktrees.length}) — no live pane:`));
        for (const w of p.orphans.worktrees) {
            out.push(`  ${pad(w.branch ?? (w.detached ? '(detached)' : '-'), 34)} ${dim(w.path)}`);
        }
    }
    if (seen.size === 0 && p.orphans.worktrees.length === 0) out.push(NONE);
    return [...out, ...degradationNotice(p, ['git', 'tmux'])];
}

function collidingWorktrees(p: TopologyProjectionV1) {
    const byPath = new Map<string, string[]>();
    for (const x of p.panes) {
        if (x.worktree && (x.worktree.shared_by_pane_ids?.length ?? 0) > 1) {
            byPath.set(x.worktree.path, x.worktree.shared_by_pane_ids ?? []);
        }
    }
    return [...byPath.entries()];
}

function viewCollisions(p: TopologyProjectionV1): string[] {
    const rows = collidingWorktrees(p);
    if (rows.length === 0) return ['No worktree is shared by more than one live pane.', ...degradationNotice(p, ['git', 'tmux'])];
    const out = [kleur.yellow(`${rows.length} shared worktree(s) — concurrent git state races are possible:`)];
    for (const [path, panes] of rows) out.push(`  ${path}\n    panes: ${panes.join(' ')}`);
    out.push('', dim('Mitigation: give each session its own worktree via `xt claude` / `xt pi`.'));
    return [...out, ...degradationNotice(p, ['git', 'tmux'])];
}

function viewIntegration(p: TopologyProjectionV1): string[] {
    const out = [kleur.bold(`${pad('JOB', 8)} ${pad('SPECIALIST', 16)} ${pad('SOURCE BRANCH', 28)} ${pad('TARGET', 24)} ${pad('PR', 14)} STATUS`)];
    const jobs = [...p.panes.flatMap((x) => x.jobs), ...p.orphans.jobs];
    if (jobs.length === 0) out.push(NONE);
    for (const j of jobs) {
        const pr = (j as TopologyJob & { pull_request?: TopologyPullRequest | null }).pull_request;
        const prState = pr ? `#${pr.number} ${pr.state.toLowerCase()}` : '-';
        out.push(`${pad(j.job_id, 8)} ${pad(j.specialist, 16)} ${pad(j.branch, 28)} ${pad(j.integration_target_branch, 24)} ${pad(prState, 14)} ${j.status}`);
    }
    const withPr = p.panes.filter((x) => x.pull_request);
    if (withPr.length > 0) {
        out.push('', kleur.bold('pane branches with a pull request:'));
        for (const x of withPr) {
            const pr = x.pull_request!;
            out.push(`  #${String(pr.number).padEnd(5)} ${pad(pr.head_branch, 34)} -> ${pad(pr.base_branch, 12)} ${completionOf(x)}`);
        }
    }
    return [...out, ...degradationNotice(p, ['specialists', 'github'])];
}

function viewBeads(p: TopologyProjectionV1): string[] {
    const out = [kleur.bold(`${pad('PANE', 8)} ${pad('BEAD', 18)} ${pad('STATUS', 14)} TITLE`)];
    const rows = p.panes.filter((x) => x.bead);
    if (rows.length === 0) out.push(NONE);
    for (const x of rows) {
        const b = x.bead!;
        // The annotation is appended AFTER padding, not padded with the status:
        // pad() truncates, and a truncated "unknown (other repo)" would read as
        // a lookup failure — the exact misreading the annotation exists to stop.
        const note = b.status === 'unknown' ? dim(' (other repo)') : '';
        const status = b.status === 'unknown' ? kleur.yellow(pad(b.status, 14)) : pad(b.status, 14);
        out.push(`${pad(x.pane_id, 8)} ${pad(b.id, 18)} ${status}${note} ${dim(b.title ?? '')}`);
    }
    return [...out, ...degradationNotice(p, ['substrate', 'beads', 'tmux'])];
}

function viewPrs(p: TopologyProjectionV1): string[] {
    const out = [kleur.bold(`${pad('PR', 7)} ${pad('STATE', 10)} ${pad('HEAD', 34)} ${pad('BASE', 12)} MERGED`)];
    const rows = p.panes.filter((x) => x.pull_request);
    if (rows.length === 0) out.push(NONE);
    for (const x of rows) {
        const pr = x.pull_request!;
        out.push(`${pad('#' + pr.number, 7)} ${pad(pr.state, 10)} ${pad(pr.head_branch, 34)} ${pad(pr.base_branch, 12)} ${pr.merged_at ?? dim('-')}`);
    }
    return [...out, ...degradationNotice(p, ['github'])];
}

/**
 * The surfaces this viewer deliberately does NOT reimplement. xtmux and git
 * already own, bound and clamp them; duplicating them here would fork the
 * behavior and — in pane capture's case — pull terminal content into a process
 * that must never hold it. Printing the exact command with real ids filled in is
 * the useful thing a projection can add.
 */
function viewRoutes(p: TopologyProjectionV1): string[] {
    const selectedPane = p.panes.find((x) => x.agent) ?? p.panes[0];
    const selectedPaneId = selectedPane?.pane_id ?? '<%pane-id>';
    const worktree = selectedPane?.worktree?.path ?? '<worktree>';

    const bead = p.panes.find((x) => x.bead)?.bead?.id;
    return [
        'These live/diagnostic surfaces are owned by xtmux and git. This viewer routes',
        'to them rather than reimplementing them:',
        '',
        `  ${kleur.bold('live journal feed')}`,
        `    xtmux log follow --after-id <n>${bead ? `        # or: xtmux log query --bead ${bead}` : ''}`,
        `  ${kleur.bold('reply obligations')}`,
        `    xtmux obligations list --pane ${selectedPaneId} --json`,
        `  ${kleur.bold('monitors and wakes')}`,
        '    xtmux monitor-list --json',
        `  ${kleur.bold('pane preview')}   ${dim('(diagnostic only — never journalled or persisted)')}`,
        `    xtmux pane capture --pane ${selectedPaneId} --lines 40`,
        `  ${kleur.bold('git diff')}`,
        `    git -C ${worktree} diff`,
        '',
        dim('Pane capture is intentionally absent from the projection: the contract cannot'),
        dim('carry terminal content, so it can never reach the durable event journal.'),
    ];
}

const RENDERERS: Record<ViewName, (p: TopologyProjectionV1) => string[]> = {
    summary: viewSummary,
    topology: viewTopology,
    chains: viewChains,
    lineage: viewLineage,
    worktrees: viewWorktrees,
    collisions: viewCollisions,
    integration: viewIntegration,
    beads: viewBeads,
    prs: viewPrs,
    routes: viewRoutes,
};

export function isViewName(v: string): v is ViewName {
    return (VIEW_NAMES as readonly string[]).includes(v);
}

/** Render one view. Pure: no I/O, no subprocess, no clock. */
export function renderView(name: ViewName, projection: TopologyProjectionV1): string {
    return RENDERERS[name](projection).join('\n');
}
