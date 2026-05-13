import { Command } from 'commander';
import kleur from 'kleur';
// @ts-ignore
import prompts from 'prompts';
import { getCandidatePaths } from '../core/context.js';
import { calculateDiff } from '../core/diff.js';
import { executeSync } from '../core/sync-executor.js';
import { findRepoRoot } from '../utils/repo-root.js';
import { getManifestPath } from '../core/manifest.js';
import fs from 'fs-extra';
import path from 'path';
// @ts-ignore
import Conf from 'conf';

function formatTargetLabel(target: string): string {
    const normalized = target.replace(/\\/g, '/').toLowerCase();
    if (normalized.endsWith('/.xtrm') || normalized.includes('/.xtrm/')) return '.xtrm';
    if (normalized.endsWith('/.claude') || normalized.includes('/.claude/')) return '~/.claude';
    return path.basename(target);
}

function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    return `${days} day${days > 1 ? 's' : ''} ago`;
}

export function createStatusCommand(): Command {
    return new Command('status')
        .description('Show status and optionally sync target environments')
        .option('--json', 'Output machine-readable JSON', false)
        .option('--check', 'Non-interactive summary; never prompt', false)
        .action(async (opts) => {
            const { json, check } = opts;

            const repoRoot = await findRepoRoot();

            // Auto-detect all existing environments (no prompt needed for read-only view)
            const candidates = getCandidatePaths();
            const targets: string[] = [];
            for (const c of candidates) {
                if (await fs.pathExists(c.path)) targets.push(c.path);
            }
            if (targets.length === 0) {
                console.log(kleur.yellow('\n  No xtrm environments found (.xtrm target missing)\n'));
                return;
            }

            interface TargetStatus {
                path: string;
                name: string;
                lastSync: string | null;
                changes: Record<string, { missing: string[]; outdated: string[]; drifted: string[] }>;
                totalChanges: number;
            }

            const results: TargetStatus[] = [];

            for (const target of targets) {
                const manifestPath = getManifestPath(target);
                let lastSync: string | null = null;
                try {
                    if (await fs.pathExists(manifestPath)) {
                        const manifest = await fs.readJson(manifestPath);
                        if (manifest.lastSync) lastSync = manifest.lastSync;
                    }
                } catch { /* ignore */ }

                const changeSet = await calculateDiff(repoRoot, target);
                const totalChanges = Object.values(changeSet).reduce(
                    (sum: number, c: any) => sum + c.missing.length + c.outdated.length + c.drifted.length, 0,
                ) as number;

                results.push({ path: target, name: formatTargetLabel(target), lastSync, changes: changeSet as any, totalChanges });
            }

            // ── JSON output ──────────────────────────────────────────────────
            if (json) {
                console.log(JSON.stringify({ targets: results }, null, 2));
                return;
            }

            // ── Table output ─────────────────────────────────────────────────
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const Table = require('cli-table3');

            const table = new Table({
                head: [
                    kleur.bold('Target'),
                    kleur.bold(kleur.green('+ New')),
                    kleur.bold(kleur.yellow('↑ Update')),
                    kleur.bold(kleur.red('! Drift')),
                    kleur.bold('Last Sync'),
                ],
                style: { head: [], border: [] },
            });

            for (const r of results) {
                const missing  = Object.values(r.changes).reduce((s: number, c: any) => s + c.missing.length,  0) as number;
                const outdated = Object.values(r.changes).reduce((s: number, c: any) => s + c.outdated.length, 0) as number;
                const drifted  = Object.values(r.changes).reduce((s: number, c: any) => s + c.drifted.length,  0) as number;

                const lastSyncStr = r.lastSync
                    ? kleur.gray(formatRelativeTime(new Date(r.lastSync).getTime()))
                    : kleur.gray('never');

                table.push([
                    r.totalChanges > 0 ? kleur.bold(r.name) : r.name,
                    missing  > 0 ? kleur.green(String(missing))  : kleur.gray('—'),
                    outdated > 0 ? kleur.yellow(String(outdated)) : kleur.gray('—'),
                    drifted  > 0 ? kleur.red(String(drifted))    : kleur.gray('—'),
                    lastSyncStr,
                ]);
            }

            console.log('\n' + table.toString());

            const totalPending = results.reduce((s, r) => s + r.totalChanges, 0);

            if (totalPending === 0) {
                console.log(kleur.green('\n  ✓ All environments up-to-date\n'));
                return;
            }

            const pending = results.filter(r => r.totalChanges > 0);
            console.log(kleur.yellow(`\n  ⚠  ${totalPending} pending change${totalPending !== 1 ? 's' : ''} across ${pending.length} environment${pending.length !== 1 ? 's' : ''}\n`));

            if (check || !process.stdin.isTTY) {
                console.log(kleur.gray("  Skipped. Run 'xt sync' to apply.\n"));
                return;
            }

            // ── Inline sync offer ────────────────────────────────────────────
            const { selected } = await prompts({
                type: 'multiselect',
                name: 'selected',
                message: 'Select environments to sync:',
                choices: pending.map(r => ({
                    title: `${r.name}  ${kleur.gray(`(${r.totalChanges} change${r.totalChanges !== 1 ? 's' : ''})`)}`,
                    value: r.path,
                    selected: true,
                })),
                hint: '- Space to toggle. Enter to confirm. Esc to skip.',
                instructions: false,
            });

            if (!selected || selected.length === 0) {
                console.log(kleur.gray('  Skipped. Run xtrm sync anytime to apply.\n'));
                return;
            }

            const toSync = pending.filter(r => selected.includes(r.path));

            // Reuse the already-computed changeSets — no second diff needed
            const store = new Conf({ projectName: 'xtrm-manager' });
            const syncMode = (store.get('syncMode') as string) || 'copy';

            let totalSynced = 0;
            for (const r of toSync) {
                console.log(kleur.bold(`\n  → ${r.name}`));
                const count = await executeSync(repoRoot, r.path, r.changes as any, syncMode as any, 'sync', false);
                totalSynced += count;
                console.log(kleur.green(`  ✓ ${count} item${count !== 1 ? 's' : ''} synced`));
            }

            console.log(kleur.bold().green(`\n✓ Done — ${totalSynced} item${totalSynced !== 1 ? 's' : ''} synced\n`));
        });
}
