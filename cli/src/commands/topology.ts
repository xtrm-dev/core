/**
 * `xt topology` — the aggregated topology projection (audit ~/dev/11.md P2-05)
 * and its operator views (P2-06).
 *
 * Read-only. Every invocation recomputes the snapshot from live sources; there
 * is no cache to go stale and no state to write back. `--json` emits the raw
 * xtrm.topology.projection.v1 snapshot; views are pure renderers over it.
 */

import { Command } from 'commander';
import kleur from 'kleur';
import { collectProjection } from '../core/topology-projection.js';
import { VIEW_DESCRIPTIONS, VIEW_NAMES, isViewName, renderView } from '../core/topology-views.js';

export function createTopologyCommand(): Command {
    const cmd = new Command('topology');

    const viewHelp = VIEW_NAMES.map((v) => `  ${v.padEnd(12)} ${VIEW_DESCRIPTIONS[v]}`).join('\n');

    cmd
        .description('Read-only aggregated projection joining panes, roles, specialist jobs, issues, worktrees, branches and PRs')
        .option('--json', 'Print the machine-readable xtrm.topology.projection.v1 snapshot', false)
        .option('--view <name>', 'View to render (see Views below)', 'summary')
        .option('--no-github', 'Skip the GitHub query (slowest, rate-limited); PR evidence is omitted')
        .addHelpText('after', `\nViews:\n${viewHelp}\n
The live/diagnostic surfaces — journal feed, reply obligations, monitors, pane
preview and git diff — are owned by xtmux and git. \`--view routes\` prints the
exact command for each, with real pane ids and worktree paths filled in.

Pane capture is deliberately absent: the projection contract cannot carry
terminal content, so it can never reach the durable event journal.`)
        .action(async (options: { json?: boolean; view: string; github?: boolean }) => {
            // Reject a bad --view before doing any work: failing after six
            // subprocess reads would be slow and would look like a query error.
            const view = isViewName(options.view) ? options.view : null;
            if (!view) {
                console.error(kleur.red(`Unknown view: ${options.view}`));
                console.error(`Available: ${VIEW_NAMES.join(', ')}`);
                process.exitCode = 1;
                return;
            }

            const projection = await collectProjection({
                includeGithub: options.github !== false,
            });

            // --json is the machine contract from P2-05 and stays untouched by
            // the view layer: views are additive rendering, never a reshaping.
            if (options.json) {
                console.log(JSON.stringify(projection, null, 2));
                return;
            }

            console.log(renderView(view, projection));
        });

    return cmd;
}
