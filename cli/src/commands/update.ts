import { Command } from 'commander';
import kleur from 'kleur';
import path from 'node:path';
import fs from 'fs-extra';
import { checkDrift } from '../core/drift.js';
import { resolvePackageRoot } from '../core/registry-scaffold.js';
import { assureXtManagedPiPackages } from '../core/pi-runtime.js';
import { findManagedRepos } from '../core/repo-discovery.js';
import { isStrictRegistryMode, runInstall } from './install.js';
import { ensureBeadsSharedServerEnabled, hasBeadsDir } from '../core/beads-shared-server.js';

type UpdateStatus = 'refreshed' | 'already-current' | 'failed' | 'skipped';

interface RepoUpdateResult {
    repo: string;
    status: UpdateStatus;
    reason?: string;
}

interface UpdateOpts {
    root?: string;
    repo?: string;
    json?: boolean;
    apply?: boolean;
    strictRegistry?: boolean;
}

async function resolveTargetRepos(opts: Pick<UpdateOpts, 'root' | 'repo'>): Promise<string[]> {
    if (opts.repo) return [path.resolve(opts.repo)];
    if (opts.root) return findManagedRepos(path.resolve(opts.root));
    return [process.cwd()];
}

function getCurrentPackageRegistryPath(): string {
    return path.join(resolvePackageRoot(), '.xtrm', 'registry.json');
}

async function updateRepo(repoRoot: string, opts: UpdateOpts): Promise<RepoUpdateResult> {
    const registryPath = getCurrentPackageRegistryPath();
    const userXtrmDir = path.join(repoRoot, '.xtrm');

    try {
        if (!(await fs.pathExists(registryPath))) {
            return { repo: repoRoot, status: 'failed', reason: `missing package registry at ${registryPath}` };
        }

        const drift = await checkDrift(registryPath, userXtrmDir);
        const hasBeads = await hasBeadsDir(repoRoot);
        const sharedServer = hasBeads
            ? await ensureBeadsSharedServerEnabled(repoRoot, Boolean(opts.apply))
            : { changed: false, state: 'not-applicable' as const };
        const hasChanges = drift.missing.length > 0 || drift.drifted.length > 0 || sharedServer.changed;

        if (!opts.apply) {
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
            strictRegistry: isStrictRegistryMode(opts),
        });

        return { repo: repoRoot, status: 'refreshed', reason: `missing=${drift.missing.length}, drifted=${drift.drifted.length}` };
    } catch (error) {
        return {
            repo: repoRoot,
            status: 'failed',
            reason: formatRegistrySourceMismatchReason(error, isStrictRegistryMode(opts)),
        };
    }
}

function formatRegistrySourceMismatchReason(error: unknown, strictRegistry: boolean): string {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = 'Registry/source mismatch: missing package source files.';
    if (!message.startsWith(prefix)) {
        return message;
    }

    if (strictRegistry || process.env.DEBUG === 'true') {
        return message;
    }

    const paths = message
        .split('\n')
        .slice(1)
        .map(line => line.trim().replace(/^•\s*/, ''))
        .filter(Boolean);
    const visiblePaths = paths.slice(0, 3);
    const remaining = paths.length - visiblePaths.length;
    return `${prefix} ${visiblePaths.join(', ')}${remaining > 0 ? ` (+${remaining} more)` : ''}`;
}

function printPiPackages(packageAssurance: Awaited<ReturnType<typeof assureXtManagedPiPackages>>): void {
    if (packageAssurance.missing.length === 0 && packageAssurance.outdated.length === 0) {
        return;
    }

    console.log(kleur.bold('\n  Pi Packages'));
    console.log(kleur.dim('  ' + '-'.repeat(50)));
    for (const status of packageAssurance.statuses) {
        if (status.state === 'current') continue;
        console.log(`${status.state.padEnd(10)} ${status.pkg.displayName}`);
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
        .description('Refresh xtrm-managed files and assure global xt Pi packages for one repo or many; missing or outdated packages are refreshed on --apply')
        .option('--apply', 'Write changes with install force mode', false)
        .option('--strict-registry', 'Fail on registry/source mismatch or missing registry source files', false)
        .option('--root <dir>', 'Walk root and update every repo with .xtrm/registry.json')
        .option('--repo <path>', 'Target one repo path instead of cwd')
        .option('--json', 'Print JSON output', false)
        .action(async (opts) => {
            const typedOpts = opts as UpdateOpts;
            const repos = await resolveTargetRepos(typedOpts);
            const rows: RepoUpdateResult[] = [];
            for (const repo of repos) {
                rows.push(await updateRepo(repo, typedOpts));
            }

            const packageAssurance = await assureXtManagedPiPackages(Boolean(typedOpts.apply));

            if (opts.json) {
                console.log(JSON.stringify({ repos: rows, packages: packageAssurance }, null, 2));
            } else {
                printTable(rows);
                printPiPackages(packageAssurance);
            }

            if (rows.some(row => row.status === 'failed') || packageAssurance.failed.length > 0) {
                process.exitCode = 1;
            }
        });
}
