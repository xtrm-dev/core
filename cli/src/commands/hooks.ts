import { Command } from 'commander';
import kleur from 'kleur';
import {
    installTrailerHook,
    removeTrailerHook,
    resolveHooksDir,
    trailerHookVerdict,
} from '../core/trailer-hooks.js';

export function createHooksCommand(): Command {
    const cmd = new Command('hooks').description('Git hook management (trailer chaining, etc.)');

    cmd.command('install-trailers')
        .description('Chain Substrate prepare-commit-msg into this repo\'s hooks')
        .option('--repo <path>', 'Repository root (default cwd)')
        .option('--remove', 'Remove the chained trailer hook', false)
        .action(async (opts) => {
            const repoRoot = opts.repo ?? process.cwd();
            if (opts.remove) {
                const r = await removeTrailerHook(repoRoot);
                console.log(r.changed ? kleur.green('✓ removed') : kleur.dim(`  ${r.reason}`));
                return;
            }
            const r = await installTrailerHook(repoRoot);
            if (r.reason === 'substrate-hook-unresolved') {
                // Never a silent no-op: without the entry there is nothing to chain.
                console.error(kleur.red('  ✗ substrate prepare-commit-msg not found — nothing installed.'));
                console.error(kleur.dim('    Set XTRM_SUBSTRATE_DIR to a substrate checkout, or install @jaggerxtrm/substrate'));
                console.error(kleur.dim('    with a release that ships hooks/ (the published 0.3.x builds do not).'));
                process.exitCode = 1;
                return;
            }
            console.log(r.changed ? kleur.green('✓ installed') : kleur.dim(`  ${r.reason}`));
            console.log(kleur.dim(`  hooks dir: ${resolveHooksDir(repoRoot)}`));
            console.log(kleur.dim(`  entry:     ${r.entry}`));
        });

    cmd.command('status')
        .description('Show the trailer-hook chain state (installed, missing or inert)')
        .option('--repo <path>', 'Repository root (default cwd)')
        .action(async (opts) => {
            const repoRoot = opts.repo ?? process.cwd();
            const verdict = trailerHookVerdict(repoRoot);
            const line = verdict.status === 'installed' ? kleur.green(`✓ ${verdict.message}`) : kleur.yellow(`⚠ ${verdict.message}`);
            console.log(line);
            console.log(kleur.dim(`  hooks dir: ${resolveHooksDir(repoRoot)}`));
            if (verdict.status !== 'installed') process.exitCode = 1;
        });

    return cmd;
}
