import { Command } from 'commander';
import kleur from 'kleur';
import path from 'node:path';
import fs from 'fs-extra';
import { checkDrift } from '../core/drift.js';
import { findManagedRepos } from '../core/repo-discovery.js';
import { runInstall } from './install.js';

type UpdateStatus = 'refreshed' | 'already-current' | 'failed';

interface RepoUpdateResult {
    repo: string;
    status: UpdateStatus;
    reason?: string;
}

async function resolveTargetRepos(opts: { root?: string; repo?: string }): Promise<string[]> {
    if (opts.repo) return [path.resolve(opts.repo)];
    if (opts.root) return findManagedRepos(path.resolve(opts.root));
    return [process.cwd()];
}

async function updateRepo(repoRoot: string, apply: boolean): Promise<RepoUpdateResult> {
    const registryPath = path.join(repoRoot, '.xtrm', 'registry.json');
    const userXtrmDir = path.join(repoRoot, '.xtrm');

    try {
        if (!(await fs.pathExists(registryPath))) {
            return { repo: repoRoot, status: 'failed', reason: 'missing .xtrm/registry.json' };
        }

        const drift = await checkDrift(registryPath, userXtrmDir);
        const hasChanges = drift.missing.length > 0 || drift.drifted.length > 0;

        if (!apply) {
            return {
                repo: repoRoot,
                status: hasChanges ? 'refreshed' : 'already-current',
                reason: hasChanges ? `missing=${drift.missing.length}, drifted=${drift.drifted.length}` : undefined,
            };
        }

        if (!hasChanges) {
            return { repo: repoRoot, status: 'already-current' };
        }

        await runInstall({
            force: true,
            yes: true,
            dryRun: false,
            projectRoot: repoRoot,
            skipMachineBootstrap: true,
            skipClaudeRuntimeSync: true,
        });

        return { repo: repoRoot, status: 'refreshed', reason: `missing=${drift.missing.length}, drifted=${drift.drifted.length}` };
    } catch (error) {
        return { repo: repoRoot, status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
}

function printTable(rows: RepoUpdateResult[]): void {
    const widths = rows.reduce((acc, row) => ({
        repo: Math.max(acc.repo, row.repo.length),
        status: Math.max(acc.status, row.status.length),
    }), { repo: 4, status: 6 });

    console.log(kleur.bold(`  ${'repo'.padEnd(widths.repo)}  ${'status'.padEnd(widths.status)}  reason`));
    for (const row of rows) {
        console.log(`${row.repo.padEnd(widths.repo)}  ${row.status.padEnd(widths.status)}  ${row.reason ?? ''}`);
    }
}

export function createUpdateCommand(): Command {
    return new Command('update')
        .description('Refresh xtrm-managed files for one repo or many')
        .option('--apply', 'Write changes with install force mode', false)
        .option('--root <dir>', 'Walk root and update every repo with .xtrm/registry.json')
        .option('--repo <path>', 'Target one repo path instead of cwd')
        .option('--json', 'Print JSON output', false)
        .action(async (opts) => {
            const repos = await resolveTargetRepos(opts);
            const rows: RepoUpdateResult[] = [];
            for (const repo of repos) {
                rows.push(await updateRepo(repo, Boolean(opts.apply)));
            }

            if (opts.json) {
                console.log(JSON.stringify({ repos: rows }, null, 2));
            } else {
                printTable(rows);
            }

            if (rows.some(row => row.status === 'failed')) {
                process.exitCode = 1;
            }
        });
}
